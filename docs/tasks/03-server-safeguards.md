# Task 03 — Server safeguards / hardening

- **Phase:** 1
- **Status:** Done
- **Depends on:** 02
- **SPEC references:** §6 (all), §9, §1 (public exposure context)

## Objective

Apply the Phase-1 essential safeguards (SPEC §6) to the signaling server. The
server is directly reachable from the internet through Cloudflare Tunnel, so NAT
no longer protects it. **All of §6 MUST be in place before any public exposure.**
This task makes the task-02 server safe to expose.

## In scope — implement every item in SPEC §6

### 6.1 Network / binding
- Confirm/enforce bind to `127.0.0.1` only (no LAN/WAN listener).

### 6.2 Origin
- Strict `CheckOrigin`: allowlist only the frontend domain(s). Reject all other
  origins. The allowlist MUST be configurable (env/flag) since the frontend lives
  on a separate origin (SPEC §3).
- Reject plain-HTTP requests on the WS/signaling routes.

### 6.3 Connections
- Per-IP new-connection rate limit (token bucket). Read the real client IP from
  the `CF-Connecting-IP` header (SPEC §6.3). Fall back safely if absent.
- Cap simultaneous connections per IP and globally.
- Handshake timeout: drop a connection that does not `join` a room within N
  seconds (anti-slowloris).
- Read deadline + ping/pong keepalive: reap dead connections; drop peers that
  miss pong.

### 6.4 Messages
- `SetReadLimit` to a small max message size (SDP/ICE are a few KB max).
- Per-connection message rate limit (anti-flood).
- Strict schema validation already started in task 02 — ensure unknown types /
  malformed JSON ⇒ reject + drop.

### 6.5 Rooms
- Cap total rooms and rooms created per IP.
- Room TTL: expire after X minutes of inactivity (finish the reaper if task 02
  only stubbed it).
- Cap members per room; close room to new joins at expected count.
- Message referencing a room the connection isn't registered in ⇒ drop.

### 6.6 Process hygiene
- Run as unprivileged user (document this; no code should require root).
- `recover` per connection goroutine: one bad connection MUST NOT crash the
  process.
- No sensitive data in logs: never log SDP/ICE contents or file data (SPEC §9).
- Structured logging with fields: client IP, room, event type.

## Out of scope (SPEC §7 — deferred)

- Cloudflare edge WAF rules, host/guest anti-hijack tokens, manual host approval,
  larger code alphabet, relay limits. Do NOT implement these.

## Implementation guidance

- Centralize the tunables (limits, timeouts, allowlist, port) in one config
  struct with sane defaults and env/flag overrides. Document each default.
- Prefer middleware/wrapper composition over editing task-02 core logic, using
  the seams left by task 02.

## Acceptance criteria

- Connection from a disallowed `Origin` is rejected at upgrade.
- A connection that never joins within the handshake timeout is dropped.
- Oversized message (beyond read limit) closes the connection.
- Flooding messages or opening many connections from one IP is throttled.
- Idle room is reaped after its TTL; idle connection failing pong is dropped.
- A panic inside one connection handler does not kill the process (test with a
  fault injection or unit test around the recover wrapper).
- Logs contain IP/room/event but never SDP/ICE/file bytes.
- `go vet` and `go test -race` pass; add tests for rate limiter and origin check.

## Notes

- The IP source is `CF-Connecting-IP` because the only ingress is the Tunnel
  (SPEC §6.3). Do not trust `RemoteAddr` for limiting when behind the tunnel, but
  handle the local/dev case where the header is absent.
