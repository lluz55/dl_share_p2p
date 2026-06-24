package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// session is an issued login token together with its expiry.
type session struct {
	expiresAt time.Time
}

// AuthManager issues and validates session tokens backed by a PasswordStore.
// Session tokens gate the data relay: a host must log in with a shared
// password to obtain a token before the Go server will broker a relay session
// (SPEC §4.3, relay only).
type AuthManager struct {
	mu           sync.Mutex
	store        *PasswordStore
	tokenTTL     time.Duration
	sessions     map[string]session
	logger       *slog.Logger
	loginLimiter *IPRateLimiter
}

// NewAuthManager creates an AuthManager that validates passwords against store.
func NewAuthManager(logger *slog.Logger, store *PasswordStore, tokenTTL time.Duration) *AuthManager {
	return &AuthManager{
		store:        store,
		tokenTTL:     tokenTTL,
		sessions:     make(map[string]session),
		logger:       logger,
		loginLimiter: NewIPRateLimiter(2.0, 10), // Limit login attempts to 2 per second, burst of 10
	}
}

// Login exchanges a shared password for a session token.
// One-time passwords are consumed (removed from the store) on success.
func (am *AuthManager) Login(password string) (token string, expiresAt time.Time, ok bool) {
	if !am.store.Consume(password) {
		return "", time.Time{}, false
	}
	am.mu.Lock()
	defer am.mu.Unlock()
	tok, err := generateSecret(16)
	if err != nil {
		am.logger.Error("failed to generate session token", "err", err)
		return "", time.Time{}, false
	}
	expiresAt = time.Now().Add(am.tokenTTL)
	am.sessions[tok] = session{expiresAt: expiresAt}
	return tok, expiresAt, true
}

// Validate reports whether a session token is currently valid.
func (am *AuthManager) Validate(token string) bool {
	if token == "" {
		return false
	}
	am.mu.Lock()
	defer am.mu.Unlock()
	s, exists := am.sessions[token]
	if !exists {
		return false
	}
	if time.Now().After(s.expiresAt) {
		delete(am.sessions, token)
		return false
	}
	return true
}

// Prune removes expired session tokens and expired passwords from the store.
// Intended to be called periodically by the hub reaper.
func (am *AuthManager) Prune() {
	am.mu.Lock()
	now := time.Now()
	for tok, s := range am.sessions {
		if now.After(s.expiresAt) {
			delete(am.sessions, tok)
		}
	}
	am.mu.Unlock()
	am.store.Prune()
	am.loginLimiter.Prune(1 * time.Hour)
}

// ServeLogin handles POST /login: exchange the shared password for a session
// token. It also answers CORS preflight so the browser can call it cross-origin.
func ServeLogin(am *AuthManager, config Config, w http.ResponseWriter, r *http.Request, logger *slog.Logger) {
	writeCORS(w, r, config)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	ip := getClientIP(r)

	// Rate limit login requests to prevent brute force/mutex exhaustion
	if !am.loginLimiter.Allow(ip) {
		logger.Warn("login rate limit exceeded", "ip", ip)
		http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
		return
	}

	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}

	token, expiresAt, ok := am.Login(body.Password)
	if !ok {
		logger.Warn("relay login failed", "via", "go-server", "ip", ip)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	logger.Info("relay login succeeded", "via", "go-server", "ip", ip)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"token":     token,
		"expiresAt": expiresAt.Unix(),
	})
}

// writeCORS sets permissive-but-scoped CORS headers when the request Origin is
// in the configured allowlist (reusing the same policy as the WS routes).
func writeCORS(w http.ResponseWriter, r *http.Request, config Config) {
	origin := r.Header.Get("Origin")
	if origin == "" || !checkOrigin(config.AllowedOrigins, origin, nil) {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}
