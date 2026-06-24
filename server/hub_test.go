package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"
)

func TestCheckOrigin(t *testing.T) {
	// 1. Dev fallback: no allowed origins configured (should allow localhost/127.0.0.1)
	if !checkOrigin(nil, "http://localhost:3000", nil) {
		t.Error("expected localhost to be allowed under dev mode")
	}
	if !checkOrigin(nil, "https://127.0.0.1:18085", nil) {
		t.Error("expected 127.0.0.1 to be allowed under dev mode")
	}
	if checkOrigin(nil, "https://example.com", nil) {
		t.Error("expected external domain to be rejected under dev mode")
	}

	// 2. Production allowlist
	allowed := []string{"https://app.p2pshare.com", "https://*.pages.dev"}
	if !checkOrigin(allowed, "https://app.p2pshare.com", nil) {
		t.Error("expected exact origin to be allowed")
	}
	if !checkOrigin(allowed, "https://some-app.pages.dev", nil) {
		t.Error("expected wildcard match to be allowed")
	}
	if checkOrigin(allowed, "http://localhost:3000", nil) {
		t.Error("expected localhost to be rejected when allowlist is set")
	}
}

func TestTokenBucket(t *testing.T) {
	// Rate: 10 per second, capacity: 5
	tb := NewTokenBucket(10.0, 5)
	for i := 0; i < 5; i++ {
		if !tb.Allow() {
			t.Errorf("expected token %d to be available immediately", i+1)
		}
	}
	if tb.Allow() {
		t.Error("expected 6th token to be blocked (burst limit reached)")
	}

	// Wait 100ms, should refill 1 token (10/sec * 0.1sec = 1 token)
	time.Sleep(110 * time.Millisecond)
	if !tb.Allow() {
		t.Error("expected token to be refilled after waiting")
	}
	if tb.Allow() {
		t.Error("expected second token to be blocked after partial refill")
	}
}

func TestIPRateLimiter(t *testing.T) {
	limiter := NewIPRateLimiter(1.0, 1)
	if !limiter.Allow("1.2.3.4") {
		t.Error("expected first attempt to be allowed")
	}
	if limiter.Allow("1.2.3.4") {
		t.Error("expected second immediate attempt to be rate limited")
	}
	if !limiter.Allow("5.6.7.8") {
		t.Error("expected different IP to be allowed independently")
	}
}

func TestHubJoinLeave(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	config := DefaultConfig()
	hub := NewHub(logger, config, NewRelayManager(logger), nil)

	peerHost := &Peer{ID: "host-1", IP: "127.0.0.1", Send: make(chan []byte, 10)}
	peerGuest := &Peer{ID: "guest-1", IP: "127.0.0.1", Send: make(chan []byte, 10)}

	// Register
	if err := hub.RegisterPeer(peerHost); err != nil {
		t.Fatalf("RegisterPeer failed: %v", err)
	}
	if err := hub.RegisterPeer(peerGuest); err != nil {
		t.Fatalf("RegisterPeer failed: %v", err)
	}

	// Create room
	room, err := hub.JoinOrCreateRoom(peerHost, "", false)
	if err != nil {
		t.Fatalf("JoinOrCreateRoom failed: %v", err)
	}
	if room.Code == "" {
		t.Error("expected generated code, got empty")
	}
	if peerHost.Role != "host" {
		t.Errorf("expected host, got %s", peerHost.Role)
	}

	// Join room
	room2, err := hub.JoinOrCreateRoom(peerGuest, room.Code, false)
	if err != nil {
		t.Fatalf("JoinOrCreateRoom join failed: %v", err)
	}
	if room2.Code != room.Code {
		t.Errorf("expected room %s, got %s", room.Code, room2.Code)
	}
	if peerGuest.Role != "guest" {
		t.Errorf("expected guest, got %s", peerGuest.Role)
	}

	// Check guest received peer-joined
	select {
	case msgBytes := <-peerHost.Send:
		var m Message
		if err := json.Unmarshal(msgBytes, &m); err != nil {
			t.Fatalf("failed to unmarshal message: %v", err)
		}
		if m.Type != "peer-joined" || m.ID != "guest-1" {
			t.Errorf("expected peer-joined for guest-1, got type %s ID %s", m.Type, m.ID)
		}
	default:
		t.Error("host did not receive peer-joined event")
	}

	// Leave
	hub.UnregisterPeer(peerGuest.ID)
	// Host should receive peer-left
	select {
	case msgBytes := <-peerHost.Send:
		var m Message
		if err := json.Unmarshal(msgBytes, &m); err != nil {
			t.Fatalf("failed to unmarshal: %v", err)
		}
		if m.Type != "peer-left" || m.ID != "guest-1" {
			t.Errorf("expected peer-left for guest-1, got type %s ID %s", m.Type, m.ID)
		}
	default:
		t.Error("host did not receive peer-left event")
	}
}

func TestHostChosenRoomCode(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	config := DefaultConfig()
	hub := NewHub(logger, config, NewRelayManager(logger), nil)

	host := &Peer{ID: "host-1", IP: "127.0.0.1", Send: make(chan []byte, 10)}
	guest := &Peer{ID: "guest-1", IP: "127.0.0.2", Send: make(chan []byte, 10)}
	other := &Peer{ID: "host-2", IP: "127.0.0.3", Send: make(chan []byte, 10)}
	_ = hub.RegisterPeer(host)
	_ = hub.RegisterPeer(guest)
	_ = hub.RegisterPeer(other)

	const code = "tigre-rio-veludo"

	// Host creates the room with its own chosen code.
	room, err := hub.JoinOrCreateRoom(host, code, true)
	if err != nil {
		t.Fatalf("host create with chosen code failed: %v", err)
	}
	if room.Code != code {
		t.Errorf("expected room code %q, got %q", code, room.Code)
	}
	if host.Role != "host" {
		t.Errorf("expected host role, got %s", host.Role)
	}

	// Guest joins the same chosen code.
	if _, err := hub.JoinOrCreateRoom(guest, code, false); err != nil {
		t.Fatalf("guest join chosen code failed: %v", err)
	}

	// A second host attempting the same code must be rejected as code-taken.
	if _, err := hub.JoinOrCreateRoom(other, code, true); err == nil || err.Error() != "code-taken" {
		t.Errorf("expected code-taken error, got %v", err)
	}
}

func TestConnectionCaps(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	config := DefaultConfig()
	config.MaxGlobalConns = 2
	config.MaxIPConns = 1

	hub := NewHub(logger, config, NewRelayManager(logger), nil)

	p1 := &Peer{ID: "p1", IP: "1.1.1.1", Send: make(chan []byte, 10)}
	p2 := &Peer{ID: "p2", IP: "1.1.1.1", Send: make(chan []byte, 10)}
	p3 := &Peer{ID: "p3", IP: "2.2.2.2", Send: make(chan []byte, 10)}

	if err := hub.RegisterPeer(p1); err != nil {
		t.Fatalf("p1 registration failed: %v", err)
	}

	// p2 has same IP, should fail IP cap
	if err := hub.RegisterPeer(p2); err == nil {
		t.Error("expected p2 registration to fail due to per-IP limit, but it succeeded")
	}

	// p3 has different IP, should succeed
	if err := hub.RegisterPeer(p3); err != nil {
		t.Fatalf("p3 registration failed: %v", err)
	}

	// p4 should fail global cap (which is 2)
	p4 := &Peer{ID: "p4", IP: "3.3.3.3", Send: make(chan []byte, 10)}
	if err := hub.RegisterPeer(p4); err == nil {
		t.Error("expected p4 to fail global connections cap, but it succeeded")
	}
}

func TestRoutingIsolation(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	config := DefaultConfig()
	hub := NewHub(logger, config, NewRelayManager(logger), nil)

	h1 := &Peer{ID: "h1", IP: "127.0.0.1", Send: make(chan []byte, 10)}
	g1 := &Peer{ID: "g1", IP: "127.0.0.1", Send: make(chan []byte, 10)}
	h2 := &Peer{ID: "h2", IP: "127.0.0.1", Send: make(chan []byte, 10)}
	g2 := &Peer{ID: "g2", IP: "127.0.0.1", Send: make(chan []byte, 10)}

	_ = hub.RegisterPeer(h1)
	_ = hub.RegisterPeer(g1)
	_ = hub.RegisterPeer(h2)
	_ = hub.RegisterPeer(g2)

	r1, _ := hub.JoinOrCreateRoom(h1, "", false)
	_, _ = hub.JoinOrCreateRoom(g1, r1.Code, false)

	r2, _ := hub.JoinOrCreateRoom(h2, "", false)
	_, _ = hub.JoinOrCreateRoom(g2, r2.Code, false)

	// Route within room 1 (h1 -> g1)
	sdpPayload := json.RawMessage(`"opaque-sdp"`)
	msg := &Message{
		Type: "offer",
		Room: r1.Code,
		To:   "g1",
		SDP:  sdpPayload,
	}

	err := hub.RouteMessage("h1", msg)
	if err != nil {
		t.Fatalf("routing within room failed: %v", err)
	}

	select {
	case data := <-g1.Send:
		var routed Message
		_ = json.Unmarshal(data, &routed)
		if routed.Type != "offer" || routed.From != "h1" || string(routed.SDP) != `"opaque-sdp"` {
			t.Errorf("unexpected routed message: %+v", routed)
		}
	default:
		t.Error("g1 did not receive the routed offer")
	}

	// Try routing across room boundaries (h1 -> g2)
	badMsg := &Message{
		Type: "offer",
		Room: r1.Code,
		To:   "g2",
		SDP:  sdpPayload,
	}
	err = hub.RouteMessage("h1", badMsg)
	if err == nil {
		t.Error("expected error when routing across room boundaries, got nil")
	}
}

func TestAuthManagerLoginAndExpiry(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	store, err := NewPasswordStore("")
	if err != nil {
		t.Fatal(err)
	}
	salt := "salt"
	_ = store.Add(PasswordRecord{ID: "p1", Salt: salt, Hash: hashSecret("secret", salt), CreatedAt: time.Now()})
	am := NewAuthManager(logger, store, 50*time.Millisecond)

	if _, _, ok := am.Login("wrong"); ok {
		t.Error("expected wrong password to be rejected")
	}
	tok, _, ok := am.Login("secret")
	if !ok {
		t.Fatal("expected correct password to succeed")
	}
	if !am.Validate(tok) {
		t.Error("expected freshly issued token to validate")
	}

	time.Sleep(60 * time.Millisecond)
	if am.Validate(tok) {
		t.Error("expected token to expire after its TTL")
	}

	// One-time password is consumed on first use; second login must fail.
	store2, _ := NewPasswordStore("")
	_ = store2.Add(PasswordRecord{ID: "otp", Salt: "salt", Hash: hashSecret("otp-secret", "salt"), OneTime: true, CreatedAt: time.Now()})
	am2 := NewAuthManager(logger, store2, time.Hour)
	if _, _, ok := am2.Login("otp-secret"); !ok {
		t.Fatal("expected one-time password login to succeed")
	}
	if _, _, ok := am2.Login("otp-secret"); ok {
		t.Error("expected one-time password to be consumed after first use")
	}
}

func TestRelayRequestRequiresAuth(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	config := DefaultConfig()
	authStore, _ := NewPasswordStore("")
	salt := "salt"
	_ = authStore.Add(PasswordRecord{ID: "p1", Salt: salt, Hash: hashSecret("test-pass", salt), CreatedAt: time.Now()})
	auth := NewAuthManager(logger, authStore, time.Hour)
	hub := NewHub(logger, config, NewRelayManager(logger), auth)

	host := &Peer{ID: "host-1", IP: "127.0.0.1", Send: make(chan []byte, 10)}
	guest := &Peer{ID: "guest-1", IP: "127.0.0.2", Send: make(chan []byte, 10)}
	_ = hub.RegisterPeer(host)
	_ = hub.RegisterPeer(guest)

	room, err := hub.JoinOrCreateRoom(host, "", false)
	if err != nil {
		t.Fatalf("create room failed: %v", err)
	}
	if _, err := hub.JoinOrCreateRoom(guest, room.Code, false); err != nil {
		t.Fatalf("guest join failed: %v", err)
	}
	// Drain the peer-joined notification delivered to the host.
	<-host.Send

	// 1. Without a valid auth token, the relay request is denied.
	hub.HandleRelayRequest(host.ID, &Message{Type: "relay-request", To: guest.ID})
	select {
	case data := <-host.Send:
		var m Message
		_ = json.Unmarshal(data, &m)
		if m.Type != "error" || m.Reason != "login-required" {
			t.Errorf("expected login-required error, got type=%s reason=%s", m.Type, m.Reason)
		}
	default:
		t.Fatal("host did not receive login-required error")
	}

	// 2. With a valid token, both peers receive relay-approved with a token.
	token, _, ok := auth.Login("test-pass")
	if !ok {
		t.Fatal("login with correct password failed")
	}
	hub.HandleRelayRequest(host.ID, &Message{Type: "relay-request", To: guest.ID, Auth: token})

	for _, p := range []*Peer{host, guest} {
		select {
		case data := <-p.Send:
			var m Message
			_ = json.Unmarshal(data, &m)
			if m.Type != "relay-approved" || m.Token == "" {
				t.Errorf("expected relay-approved with token for %s, got type=%s", p.ID, m.Type)
			}
		default:
			t.Errorf("%s did not receive relay-approved", p.ID)
		}
	}
}

func TestGetClientIP(t *testing.T) {
	req1, _ := http.NewRequest("GET", "/ws", nil)
	req1.RemoteAddr = "127.0.0.1:12345"
	if ip := getClientIP(req1); ip != "127.0.0.1" {
		t.Errorf("expected 127.0.0.1, got %s", ip)
	}

	req2, _ := http.NewRequest("GET", "/ws", nil)
	req2.Header.Set("CF-Connecting-IP", " 203.0.113.195 ")
	req2.RemoteAddr = "127.0.0.1:12345"
	if ip := getClientIP(req2); ip != "203.0.113.195" {
		t.Errorf("expected 203.0.113.195, got %s", ip)
	}
}
