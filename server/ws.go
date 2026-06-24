package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		// Origin validation is handled dynamically in serveWs using Config.AllowedOrigins
		return true
	},
}

type connection struct {
	hub        *Hub
	conn       *websocket.Conn
	peer       *Peer
	logger     *slog.Logger
	joinedChan chan struct{}
	limiter    *TokenBucket
}

// getClientIP extracts the client IP from CF-Connecting-IP or RemoteAddr.
func getClientIP(r *http.Request) string {
	if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
		return strings.TrimSpace(ip)
	}
	// Fallback to RemoteAddr (strip port)
	remoteAddr := r.RemoteAddr
	if idx := strings.LastIndex(remoteAddr, ":"); idx != -1 {
		return remoteAddr[:idx]
	}
	return remoteAddr
}

// GeneratePeerID generates a unique 16-byte random hex string.
func GeneratePeerID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}

func matchPattern(pattern, value string) bool {
	if pattern == "*" {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return pattern == value
	}
	parts := strings.Split(pattern, "*")
	if len(parts) != 2 {
		return false
	}
	return strings.HasPrefix(value, parts[0]) && strings.HasSuffix(value, parts[1])
}

func checkOrigin(allowed []string, origin string, logger *slog.Logger) bool {
	if origin == "" {
		return false
	}

	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	hostname := u.Hostname()

	// If no allowed origins configured, allow localhost and 127.0.0.1 for development
	if len(allowed) == 0 {
		return hostname == "localhost" || hostname == "127.0.0.1"
	}

	for _, pattern := range allowed {
		if matchPattern(pattern, origin) || matchPattern(pattern, hostname) {
			return true
		}
	}
	return false
}

func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request, logger *slog.Logger) {
	ip := getClientIP(r)

	// 1. Connection Rate Limiter (IP-based)
	if !hub.connLimiter.Allow(ip) {
		logger.Warn("connection rate limit exceeded", "ip", ip)
		http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
		return
	}

	// 2. Reject plain-HTTP requests on the WS routes (handled by gorilla upgrader check but we double check TLS/Headers)
	origin := r.Header.Get("Origin")
	if !checkOrigin(hub.config.AllowedOrigins, origin, logger) {
		logger.Warn("origin not allowed", "origin", origin, "ip", ip)
		http.Error(w, "Forbidden Origin", http.StatusForbidden)
		return
	}

	// Upgrade request
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Error("websocket upgrade failed", "err", err, "ip", ip)
		return
	}

	peerID := GeneratePeerID()
	peer := &Peer{
		ID:   peerID,
		IP:   ip,
		Send: make(chan []byte, 256),
	}

	c := &connection{
		hub:        hub,
		conn:       conn,
		peer:       peer,
		joinedChan: make(chan struct{}, 1),
		limiter:    NewTokenBucket(hub.config.MsgRateLimitRate, hub.config.MsgRateLimitBurst),
		logger:     logger.With("peer", peerID, "ip", ip),
	}

	// 3. Register peer connection in hub (enforces global and per-IP caps)
	if err := hub.RegisterPeer(peer); err != nil {
		c.logger.Warn("peer registration rejected", "err", err)
		c.sendError(err.Error())
		_ = conn.Close()
		return
	}

	c.logger.Info("connection via Go signaling server", "via", "go-server")

	// 4. Handshake Timeout
	go func() {
		defer func() {
			if r := recover(); r != nil {
				c.logger.Error("panic in handshake timeout goroutine", "err", r)
			}
		}()
		select {
		case <-time.After(hub.config.HandshakeTimeout):
			hub.mu.Lock()
			inRoom := peer.RoomCode != ""
			hub.mu.Unlock()
			if !inRoom {
				c.logger.Warn("handshake timeout: peer failed to join a room in time")
				c.sendError("handshake timeout")
				_ = conn.Close()
			}
		case <-c.joinedChan:
			return
		}
	}()

	// Start loops
	go c.writePump()
	go c.readPump()
}

func (c *connection) sendError(reason string) {
	msg := Message{
		Type:   "error",
		Reason: reason,
	}
	data, err := json.Marshal(msg)
	if err == nil {
		_ = c.conn.SetWriteDeadline(time.Now().Add(c.hub.config.WriteTimeout))
		_ = c.conn.WriteMessage(websocket.TextMessage, data)
	}
}

func isValidMessageType(t string) bool {
	switch t {
	case "join", "offer", "answer", "ice", "relay-request", "relay-key":
		return true
	}
	return false
}

func (c *connection) readPump() {
	defer func() {
		if r := recover(); r != nil {
			c.logger.Error("panic in readPump", "err", r)
		}
		// Unregister from room and hub
		c.hub.UnregisterPeer(c.peer.ID)
		_ = c.conn.Close()
		c.logger.Info("connection closed (readPump exit)")
	}()

	// Max message size safeguard
	c.conn.SetReadLimit(c.hub.config.MaxMessageSize)

	// Configure keepalive timeouts
	_ = c.conn.SetReadDeadline(time.Now().Add(c.hub.config.PongTimeout))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(c.hub.config.PongTimeout))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				c.logger.Warn("read error", "err", err)
			}
			break
		}

		// 5. Message Rate Limiter (per connection)
		if !c.limiter.Allow() {
			c.logger.Warn("message rate limit exceeded, dropping connection")
			c.sendError("message rate limit exceeded")
			break
		}

		var msg Message
		if err := json.Unmarshal(message, &msg); err != nil {
			c.logger.Warn("malformed json from peer", "err", err)
			break
		}

		// Schema validation
		if !isValidMessageType(msg.Type) {
			c.logger.Warn("invalid message type", "type", msg.Type)
			break
		}

		if msg.Type == "join" {
			if c.peer.RoomCode != "" {
				c.logger.Warn("duplicate join attempt rejected")
				break
			}

			// A non-empty room with role "host" means: create the room with the
			// host-chosen code (host fell back from third-party signaling, SPEC §4.1).
			asHost := msg.Role == "host"
			room, err := c.hub.JoinOrCreateRoom(c.peer, msg.Room, asHost)
			if err != nil {
				c.logger.Warn("join/create room failed", "err", err)
				c.sendError(err.Error())
				break
			}

			c.logger = c.logger.With("room", room.Code, "role", c.peer.Role)
			close(c.joinedChan) // Cancel handshake timeout

			// Get current room peers excluding self
			peers := make([]string, 0, len(room.Peers)-1)
			for _, other := range room.Peers {
				if other.ID != c.peer.ID {
					peers = append(peers, other.ID)
				}
			}

			ack := Message{
				Type:  "joined",
				Room:  room.Code,
				Self:  c.peer.ID,
				Role:  c.peer.Role,
				Peers: peers,
			}
			ackData, _ := json.Marshal(ack)
			c.peer.Send <- ackData

		} else {
			// Enforce room registration before any routing
			if c.peer.RoomCode == "" {
				c.logger.Warn("non-join message received before join", "type", msg.Type)
				break
			}

			if msg.Type == "relay-request" {
				c.hub.HandleRelayRequest(c.peer.ID, &msg)
			} else {
				// Route signaling message
				c.logger.Info("routing message", "type", msg.Type, "to", msg.To)
				if err := c.hub.RouteMessage(c.peer.ID, &msg); err != nil {
					c.logger.Warn("routing message failed", "type", msg.Type, "err", err)
					c.sendError(err.Error())
				}
			}
		}
	}
}

func (c *connection) writePump() {
	ticker := time.NewTicker(c.hub.config.PingInterval)
	defer func() {
		if r := recover(); r != nil {
			c.logger.Error("panic in writePump", "err", r)
		}
		ticker.Stop()
		_ = c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.peer.Send:
			if !ok {
				// The hub closed the channel
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			_ = c.conn.SetWriteDeadline(time.Now().Add(c.hub.config.WriteTimeout))
			err := c.conn.WriteMessage(websocket.TextMessage, message)
			if err != nil {
				c.logger.Warn("failed to write message", "err", err)
				return
			}

		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(c.hub.config.WriteTimeout))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.logger.Warn("failed to write ping", "err", err)
				return
			}
		}
	}
}
