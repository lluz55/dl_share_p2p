package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ApprovedRelay represents an authorized relay session pending peer connections.
type ApprovedRelay struct {
	Token     string
	RoomCode  string
	HostID    string
	GuestID   string
	CreatedAt time.Time
	HostConn  *websocket.Conn
	GuestConn *websocket.Conn
	Active    bool
	mu        sync.Mutex
}

// RelayManager controls authorization, active session caps, and bridges peer connections.
type RelayManager struct {
	mu           sync.Mutex
	approved     map[string]*ApprovedRelay
	activeCount  int
	maxSessions  int
	tokenTimeout time.Duration
	logger       *slog.Logger
	relayLimiter *IPRateLimiter
}

// NewRelayManager creates a new RelayManager.
func NewRelayManager(logger *slog.Logger) *RelayManager {
	return &RelayManager{
		approved:     make(map[string]*ApprovedRelay),
		maxSessions:  5,                // Max concurrent active relay sessions globally
		tokenTimeout: 30 * time.Second, // Token validity period
		logger:       logger,
		relayLimiter: NewIPRateLimiter(2.0, 10), // Limit relay connection requests to 2 per second, burst 10
	}
}

// Prune cleans up rate limiter state for inactive IPs.
func (rm *RelayManager) Prune() {
	rm.relayLimiter.Prune(1 * time.Hour)
}

// CreateSession generates a secure token and approves a new relay session.
func (rm *RelayManager) CreateSession(roomCode, hostID, guestID string) (string, error) {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	if rm.activeCount >= rm.maxSessions {
		return "", errors.New("global concurrent relay sessions limit reached")
	}

	// Generate secure token
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate random token: %w", err)
	}
	token := hex.EncodeToString(b)

	session := &ApprovedRelay{
		Token:     token,
		RoomCode:  roomCode,
		HostID:    hostID,
		GuestID:   guestID,
		CreatedAt: time.Now(),
	}

	rm.approved[token] = session

	// Expose token expiration cleanup
	go func() {
		time.Sleep(rm.tokenTimeout)
		rm.mu.Lock()
		defer rm.mu.Unlock()
		s, exists := rm.approved[token]
		if exists && !s.Active {
			delete(rm.approved, token)
			rm.logger.Info("relay token expired (unused)", "token", token)
		}
	}()

	rm.logger.Info("relay session approved", "via", "go-server-relay", "token", token, "room", roomCode, "host", hostID, "guest", guestID)
	return token, nil
}

// ConnectPeer associates a peer connection with the approved relay session.
func (rm *RelayManager) ConnectPeer(token, peerID string, conn *websocket.Conn) (*ApprovedRelay, error) {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	session, exists := rm.approved[token]
	if !exists {
		return nil, errors.New("invalid or expired relay token")
	}

	if time.Since(session.CreatedAt) > rm.tokenTimeout {
		delete(rm.approved, token)
		return nil, errors.New("relay token expired")
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	if peerID == session.HostID {
		if session.HostConn != nil {
			return nil, errors.New("host already connected to relay")
		}
		session.HostConn = conn
		rm.logger.Info("relay host connected", "via", "go-server-relay", "token", token)
	} else if peerID == session.GuestID {
		if session.GuestConn != nil {
			return nil, errors.New("guest already connected to relay")
		}
		session.GuestConn = conn
		rm.logger.Info("relay guest connected", "via", "go-server-relay", "token", token)
	} else {
		return nil, errors.New("unauthorized peer ID for this relay token")
	}

	// Trigger bridge once both peers are connected
	if session.HostConn != nil && session.GuestConn != nil && !session.Active {
		session.Active = true
		delete(rm.approved, token) // Remove token so it cannot be reused
		rm.activeCount++

		go rm.runBridge(session)
	}

	return session, nil
}

// runBridge handles streaming and limits enforcement.
func (rm *RelayManager) runBridge(s *ApprovedRelay) {
	rm.logger.Info("starting relay bridge (data via Go server)", "via", "go-server-relay", "room", s.RoomCode, "host", s.HostID, "guest", s.GuestID)

	defer func() {
		s.HostConn.Close()
		s.GuestConn.Close()

		rm.mu.Lock()
		rm.activeCount--
		rm.mu.Unlock()

		rm.logger.Info("relay bridge stopped", "room", s.RoomCode)
	}()

	const (
		maxBytes     int64         = 52428800    // 50 MB max file size limit
		bandwidthLimit             = 1048576     // 1 MB/s max speed limit
		sessionTimeout             = 10 * time.Minute
	)

	// Set overall session write deadline
	s.HostConn.SetReadLimit(maxBytes)
	
	// Enforce session timeout
	timeoutTimer := time.NewTimer(sessionTimeout)
	defer timeoutTimer.Stop()

	errChan := make(chan error, 2)
	bytesTransmitted := int64(0)
	startTime := time.Now()

	// Bridging Host (sender) -> Guest (receiver)
	go func() {
		defer func() {
			errChan <- nil
		}()

		for {
			messageType, payload, err := s.HostConn.ReadMessage()
			if err != nil {
				errChan <- fmt.Errorf("read error: %w", err)
				return
			}

			payloadLen := int64(len(payload))
			bytesTransmitted += payloadLen

			// 1. Max File Size Enforcement
			if bytesTransmitted > maxBytes {
				errChan <- errors.New("max file size limit exceeded (50MB)")
				return
			}

			// 2. Throttling (1 MB/s limit)
			targetDuration := float64(bytesTransmitted) / float64(bandwidthLimit)
			actualDuration := time.Since(startTime).Seconds()
			if actualDuration < targetDuration {
				sleepDuration := time.Duration((targetDuration - actualDuration) * float64(time.Second))
				time.Sleep(sleepDuration)
			}

			// Write to guest
			_ = s.GuestConn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			err = s.GuestConn.WriteMessage(messageType, payload)
			if err != nil {
				errChan <- fmt.Errorf("write error: %w", err)
				return
			}
		}
	}()

	select {
	case err := <-errChan:
		if err != nil {
			rm.logger.Warn("relay transfer failed", "room", s.RoomCode, "err", err)
		} else {
			rm.logger.Info("relay transfer completed successfully", "via", "go-server-relay", "room", s.RoomCode, "bytes", bytesTransmitted)
		}
	case <-timeoutTimer.C:
		rm.logger.Warn("relay transfer timed out", "room", s.RoomCode)
	}
}

// ServeRelay handles HTTP upgrades to the /relay WebSocket route.
func ServeRelay(rm *RelayManager, allowedOrigins []string, w http.ResponseWriter, r *http.Request, logger *slog.Logger) {
	token := r.URL.Query().Get("token")
	peerID := r.URL.Query().Get("peerId")

	if token == "" || peerID == "" {
		http.Error(w, "Missing query parameters", http.StatusBadRequest)
		return
	}

	ip := getClientIP(r)

	// 1. Rate Limit relay connections
	if !rm.relayLimiter.Allow(ip) {
		logger.Warn("relay rate limit exceeded", "ip", ip, "peer", peerID)
		http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
		return
	}

	// 2. Reject unauthorized origins (CSWSH safeguard)
	origin := r.Header.Get("Origin")
	if !checkOrigin(allowedOrigins, origin, logger) {
		logger.Warn("relay origin not allowed", "origin", origin, "ip", ip, "peer", peerID)
		http.Error(w, "Forbidden Origin", http.StatusForbidden)
		return
	}

	// Upgrade
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Error("relay upgrade failed", "err", err, "peer", peerID)
		return
	}

	logger.Info("relay socket opened (data via Go server)", "via", "go-server-relay", "peer", peerID)

	_, err = rm.ConnectPeer(token, peerID, conn)
	if err != nil {
		logger.Warn("relay peer connection rejected", "peer", peerID, "err", err)
		// Send error back and close
		msg := Message{
			Type:   "error",
			Reason: err.Error(),
		}
		data, _ := json.Marshal(msg)
		_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_ = conn.WriteMessage(websocket.TextMessage, data)
		conn.Close()
		return
	}
}
