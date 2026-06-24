package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Message is the shared message schema between client and server.
type Message struct {
	Type      string          `json:"type"`
	Room      string          `json:"room,omitempty"`
	Self      string          `json:"self,omitempty"`
	Role      string          `json:"role,omitempty"`
	Peers     []string        `json:"peers,omitempty"`
	ID        string          `json:"id,omitempty"`
	Reason    string          `json:"reason,omitempty"`
	To        string          `json:"to,omitempty"`
	From      string          `json:"from,omitempty"`
	SDP       json.RawMessage `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
	Token     string          `json:"token,omitempty"`
	Auth      string          `json:"auth,omitempty"` // login session token (relay-request only)
	Key       string          `json:"key,omitempty"`  // ephemeral ECDH public key (relay-key / relay-request)
}

// Hub maintains the state of rooms and active peer connections.
type Hub struct {
	mu           sync.RWMutex
	rooms        map[string]*Room
	peers        map[string]*Peer
	ipConns      map[string]int // connections count per IP
	ipRooms      map[string]int // rooms created count per IP
	config       Config
	connLimiter  *IPRateLimiter
	relayManager *RelayManager
	authManager  *AuthManager
	logger       *slog.Logger
	shutdownChan chan struct{}
}

// NewHub creates and starts a new Hub. authManager may be nil in tests that do
// not exercise the relay; when nil, relay auth enforcement is skipped.
func NewHub(logger *slog.Logger, config Config, relayManager *RelayManager, authManager *AuthManager) *Hub {
	h := &Hub{
		rooms:        make(map[string]*Room),
		peers:        make(map[string]*Peer),
		ipConns:      make(map[string]int),
		ipRooms:      make(map[string]int),
		config:       config,
		connLimiter:  NewIPRateLimiter(config.ConnRateLimitRate, config.ConnRateLimitBurst),
		relayManager: relayManager,
		authManager:  authManager,
		logger:       logger,
		shutdownChan: make(chan struct{}),
	}
	return h
}

// StartReaper starts the room expiration background reaper.
func (h *Hub) StartReaper(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Minute)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				h.ReapRooms()
				h.connLimiter.Prune(1 * time.Hour)
				if h.authManager != nil {
					h.authManager.Prune()
				}
				if h.relayManager != nil {
					h.relayManager.Prune()
				}
			case <-ctx.Done():
				return
			case <-h.shutdownChan:
				return
			}
		}
	}()
}

// Close shuts down the hub.
func (h *Hub) Close() {
	close(h.shutdownChan)
}

// RegisterPeer registers a new peer connection, enforcing connection limits.
func (h *Hub) RegisterPeer(peer *Peer) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Enforce global connection limits
	if len(h.peers) >= h.config.MaxGlobalConns {
		return errors.New("global connection cap reached")
	}

	// Enforce per-IP connection limits
	if h.ipConns[peer.IP] >= h.config.MaxIPConns {
		return errors.New("per-IP connection cap reached")
	}

	h.peers[peer.ID] = peer
	h.ipConns[peer.IP]++
	return nil
}

// UnregisterPeer removes a peer from the hub and any room they are in, releasing connection limits.
func (h *Hub) UnregisterPeer(peerID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	peer, exists := h.peers[peerID]
	if !exists {
		return
	}

	delete(h.peers, peerID)
	h.ipConns[peer.IP]--
	if h.ipConns[peer.IP] <= 0 {
		delete(h.ipConns, peer.IP)
	}

	if peer.RoomCode != "" {
		if room, exists := h.rooms[peer.RoomCode]; exists {
			delete(room.Peers, peerID)
			room.LastActive = time.Now()

			h.logger.Info("peer left room", "peer", peerID, "room", room.Code, "role", peer.Role)

			// Notify remaining peers in the room
			msg := Message{
				Type: "peer-left",
				ID:   peerID,
			}
			data, err := json.Marshal(msg)
			if err == nil {
				for _, other := range room.Peers {
					select {
					case other.Send <- data:
					default:
					}
				}
			}

			// Clean up empty room
			if len(room.Peers) == 0 {
				h.deleteRoomInternal(room)
			}
		}
	}
}

// deleteRoomInternal deletes the room and decrements the IP room count.
// Must be called with the hub lock held.
func (h *Hub) deleteRoomInternal(room *Room) {
	delete(h.rooms, room.Code)
	h.ipRooms[room.HostIP]--
	if h.ipRooms[room.HostIP] <= 0 {
		delete(h.ipRooms, room.HostIP)
	}
	h.logger.Info("room deleted", "room", room.Code)
}

// JoinOrCreateRoom handles the logic of a peer trying to join or create a room.
//
// Behaviour by (requestedRoom, asHost):
//   - ("", _)        → create a room with a server-generated code (host).
//   - (code, true)   → create a room with the host-chosen code (host); errors "code-taken"
//     if it already exists. Used when a host falls back from the third-party signaling
//     transport to the Go server keeping the same rendezvous code (SPEC §4.1).
//   - (code, false)  → join an existing room with that code (guest).
func (h *Hub) JoinOrCreateRoom(peer *Peer, requestedRoom string, asHost bool) (*Room, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Ensure peer is registered
	if _, exists := h.peers[peer.ID]; !exists {
		return nil, errors.New("peer not registered")
	}

	// Peer already in a room
	if peer.RoomCode != "" {
		return nil, errors.New("peer already in a room")
	}

	if requestedRoom == "" || asHost {
		// Create room (Host role) — with a generated code or the host-chosen one.
		if len(h.rooms) >= h.config.MaxGlobalRooms {
			return nil, errors.New("global room cap reached")
		}

		if h.ipRooms[peer.IP] >= h.config.MaxIPRooms {
			return nil, errors.New("per-IP room cap reached")
		}

		var code string
		if requestedRoom != "" {
			// Host-chosen code: accept it if free, reject if taken.
			if _, exists := h.rooms[requestedRoom]; exists {
				return nil, errors.New("code-taken")
			}
			code = requestedRoom
		} else {
			var err error
			// Try up to 5 times to generate a unique code
			for i := 0; i < 5; i++ {
				code, err = GenerateRoomCode()
				if err != nil {
					return nil, fmt.Errorf("failed to generate room code: %w", err)
				}
				if _, exists := h.rooms[code]; !exists {
					break
				}
			}
		}

		room := &Room{
			Code:       code,
			Peers:      make(map[string]*Peer),
			HostID:     peer.ID,
			HostIP:     peer.IP,
			CreatedAt:  time.Now(),
			LastActive: time.Now(),
			MaxMembers: 5, // Default member cap per room
		}

		peer.RoomCode = code
		peer.Role = "host"
		room.Peers[peer.ID] = peer

		h.rooms[code] = room
		h.ipRooms[peer.IP]++
		h.logger.Info("room created", "room", code, "host", peer.ID, "ip", peer.IP)
		return room, nil
	}

	// Join room (Guest role)
	room, exists := h.rooms[requestedRoom]
	if !exists {
		return nil, errors.New("room not found")
	}

	if len(room.Peers) >= room.MaxMembers {
		return nil, errors.New("room is full")
	}

	peer.RoomCode = requestedRoom
	peer.Role = "guest"
	room.Peers[peer.ID] = peer
	room.LastActive = time.Now()

	h.logger.Info("peer joined room", "peer", peer.ID, "room", requestedRoom, "role", peer.Role, "ip", peer.IP)

	// Notify other peers in the room
	joinedMsg := Message{
		Type: "peer-joined",
		ID:   peer.ID,
	}
	data, err := json.Marshal(joinedMsg)
	if err == nil {
		for _, other := range room.Peers {
			if other.ID != peer.ID {
				select {
				case other.Send <- data:
				default:
				}
			}
		}
	}

	return room, nil
}

// RouteMessage forwards offer, answer, or ice messages to the correct destination peer in the same room.
func (h *Hub) RouteMessage(senderID string, msg *Message) error {
	h.mu.RLock()
	defer h.mu.RUnlock()

	sender, exists := h.peers[senderID]
	if !exists {
		return errors.New("sender not registered")
	}

	if sender.RoomCode == "" {
		return errors.New("sender not in a room")
	}

	// Enforce that message belongs to the sender's registered room.
	// SPEC §9: "Every WS message MUST belong to a valid room the connection is registered in"
	if msg.Room != "" && msg.Room != sender.RoomCode {
		return errors.New("room mismatch")
	}

	room, exists := h.rooms[sender.RoomCode]
	if !exists {
		return errors.New("room not found")
	}

	// Update activity
	room.LastActive = time.Now()

	// Destination peer validation
	recipient, exists := room.Peers[msg.To]
	if !exists {
		return errors.New("recipient not in the same room")
	}

	// Prepare the forwarded message. Keep payload opaque.
	// We replace/populate "from" so the recipient knows who sent it.
	forwardMsg := Message{
		Type:      msg.Type,
		From:      senderID,
		SDP:       msg.SDP,
		Candidate: msg.Candidate,
		Key:       msg.Key,
	}

	data, err := json.Marshal(forwardMsg)
	if err != nil {
		return fmt.Errorf("failed to serialize message: %w", err)
	}

	select {
	case recipient.Send <- data:
		return nil
	default:
		return errors.New("recipient channel full")
	}
}

// ReapRooms removes rooms that have been inactive for longer than the TTL.
func (h *Hub) ReapRooms() {
	h.mu.Lock()
	defer h.mu.Unlock()

	now := time.Now()
	for code, room := range h.rooms {
		if now.Sub(room.LastActive) > h.config.RoomTTL {
			h.logger.Info("reaping room due to inactivity", "room", code, "inactiveDuration", now.Sub(room.LastActive))
			// Disconnect any lingering peers in the room
			for _, peer := range room.Peers {
				peer.RoomCode = ""
				errMsg := Message{
					Type:   "error",
					Reason: "room expired due to inactivity",
				}
				data, err := json.Marshal(errMsg)
				if err == nil {
					select {
					case peer.Send <- data:
					default:
					}
				}
			}
			h.deleteRoomInternal(room)
		}
	}
}

// HandleRelayRequest processes a relay session request from the Host, generates a token, and broadcasts approval.
func (h *Hub) HandleRelayRequest(senderID string, msg *Message) {
	h.mu.Lock()
	sender, exists := h.peers[senderID]
	if !exists || sender.RoomCode == "" {
		h.mu.Unlock()
		return
	}
	room, exists := h.rooms[sender.RoomCode]
	if !exists || sender.Role != "host" {
		h.mu.Unlock()
		return
	}
	recipient, exists := room.Peers[msg.To]
	if !exists {
		h.mu.Unlock()
		return
	}
	h.mu.Unlock()

	// Relay (data through the Go server) requires a prior login: the host must
	// present a valid session token obtained from /login (SPEC §4.3, relay only).
	if h.authManager != nil && !h.authManager.Validate(msg.Auth) {
		h.logger.Warn("relay request denied: not authenticated",
			"via", "go-server-relay", "host", sender.ID, "room", room.Code)
		errMsg := Message{Type: "error", Reason: "login-required"}
		data, _ := json.Marshal(errMsg)
		select {
		case sender.Send <- data:
		default:
		}
		return
	}

	// If relayManager is not set (e.g. in tests), reject request
	if h.relayManager == nil {
		h.logger.Warn("relay requested but relayManager is not initialized")
		return
	}

	h.logger.Info("relay request authorized",
		"via", "go-server-relay", "room", room.Code, "host", sender.ID, "guest", recipient.ID)

	// Create relay session
	token, err := h.relayManager.CreateSession(room.Code, sender.ID, recipient.ID)
	if err != nil {
		h.logger.Warn("failed to create relay session", "err", err)
		// Send error back to host
		errMsg := Message{
			Type:   "error",
			Reason: err.Error(),
		}
		data, _ := json.Marshal(errMsg)
		select {
		case sender.Send <- data:
		default:
		}
		return
	}

	// Notify both peers of approval with the token.
	// The host's ephemeral ECDH public key (if provided) is forwarded to the
	// guest so it can complete the key exchange without an extra round-trip.
	hostApproved := Message{
		Type:  "relay-approved",
		Room:  room.Code,
		Token: token,
		To:    recipient.ID,
		From:  sender.ID,
	}
	guestApproved := Message{
		Type:  "relay-approved",
		Room:  room.Code,
		Token: token,
		To:    recipient.ID,
		From:  sender.ID,
		Key:   msg.Key, // host's ECDH public key for the guest to derive the shared secret
	}

	hostData, _ := json.Marshal(hostApproved)
	guestData, _ := json.Marshal(guestApproved)

	select {
	case sender.Send <- hostData:
	default:
	}
	select {
	case recipient.Send <- guestData:
	default:
	}
}
