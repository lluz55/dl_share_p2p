# Task 02 — Signaling server core

- **Phase:** 1
- **Status:** Done
- **Depends on:** 01
- **SPEC references:** §3.1, §4.1, §4.2, §5, §6.5 (room rules), §9

## Objective

Implement the Go WebSocket signaling server: rooms identified by a three-word
code, host/guest roles, and relaying of `offer`/`answer`/`ice`/`join` messages
between peers in the same room. This is the **always-on base** of the system
(SPEC §3.1). No WebRTC happens on the server; it only forwards signaling
messages. No relay of file bytes here (that is Phase 4, task 14).

## In scope

- `server/main.go` — HTTP server bound to `127.0.0.1` (SPEC §6.1), one WS route
  (e.g. `/ws`).
- `server/hub.go` — registry of rooms and peers; concurrency-safe.
- `server/room.go` — 3-word code generation, room lifecycle, TTL, member caps.
- `server/ws.go` — WS upgrade, message decode, schema validation, routing.
- Message protocol shared with the frontend (task 04 must match it).

## Out of scope

- Rate limiting, connection caps, ping/pong, recover, structured logging detail,
  CF-Connecting-IP parsing → **task 03** (these are additive; design hooks for
  them but implement in 03).
- Data relay / authentication (`relay.go`) → Phase 4, task 14.

## Message protocol (authoritative for Phase 1)

JSON messages over the WebSocket. Define exactly these inbound types
(SPEC §6.4: only known types accepted, strict schema, well-formed JSON):

- `join`  — client asks to create or join a room. Fields: `{ "type":"join",
  "room": "<code|empty>" }`. Empty/absent room ⇒ create a new room as **host**
  and return the generated code; a present code ⇒ join as **guest**.
- `offer` — `{ "type":"offer", "to":"<peerId>", "sdp": <opaque> }`
- `answer`— `{ "type":"answer", "to":"<peerId>", "sdp": <opaque> }`
- `ice`   — `{ "type":"ice", "to":"<peerId>", "candidate": <opaque> }`

Server→client events (name them clearly, e.g.):
- `joined` — `{ "type":"joined", "room":"...", "self":"<peerId>", "role":"host|guest", "peers":[...] }`
- `peer-joined` / `peer-left` — notify others of membership changes (host needs
  this to open a connection per guest, SPEC §4.1).
- `error` — `{ "type":"error", "reason":"..." }` then close, where appropriate.

The SDP/ICE payloads are **opaque** to the server: forward them, never inspect,
parse, or log their contents (SPEC §6.6, §9).

> You may refine field names, but keep the set of message *types* limited and
> documented. Whatever you choose MUST be mirrored exactly by task 04. Record the
> final protocol in a short comment block or `server/PROTOCOL.md`.

## Requirements

1. **Bind to `127.0.0.1` only** (SPEC §6.1). Port configurable via flag/env.
2. **Rooms (SPEC §4.1):**
   - Code = three random words joined by `-` (e.g. `tiger-harbor-velvet`).
   - The word list source/size is **open question SPEC §11.3** — do not block on
     the final list; use a placeholder word list of reasonable size and leave a
     `// TODO(SPEC §11.3)` marking that the final list/key-space is unresolved.
     The chosen list MUST be large enough that codes are not trivially guessable.
   - Host creates; guests join by code. Support host + multiple guests in the
     same room (1↔n at the *room* level even if Phase-1 UI only drives 1↔1).
   - Room closes to new joins once the expected participant count is reached
     (SPEC §6.5) — define a default cap (document it).
   - Room TTL: expire after inactivity (SPEC §6.5). Wire a TTL field now; the
     reaper goroutine can live here or be finished in task 03 — pick one and note
     it.
3. **Routing (SPEC §4.2, §6.5, §9):**
   - Every non-`join` message MUST come from a connection already registered in a
     valid room; otherwise reject and drop the connection.
   - Forward `offer`/`answer`/`ice` only to the addressed peer (`to`) within the
     same room. Never broadcast SDP outside the room.
4. **Validation (SPEC §6.4):** unknown type, malformed JSON, or wrong shape ⇒
   reject and drop the connection.
5. **Concurrency:** hub state guarded (mutex or single-goroutine actor). No data
   races (`go test -race` / `go vet` clean).
6. **No persistence** of any message contents (SPEC §9).

## Acceptance criteria

- Server starts, binds `127.0.0.1:<port>`, accepts WS on `/ws`.
- A client can `join` with empty room and receive a generated 3-word code +
  host role; a second client can `join` with that code and both observe each
  other via membership events.
- `offer`/`answer`/`ice` from one peer reach only the addressed peer in the room.
- A message with an unknown type, bad JSON, or referencing a room the connection
  is not in causes that connection to be dropped.
- `go vet ./...` and `go test -race ./...` pass (add at least a hub/room unit
  test: code generation, join/leave, routing isolation between two rooms).

## Notes

- Leave clearly marked seams for task 03 (per-connection middleware: limits,
  deadlines, recover). Don't implement them here, but don't make 03 require a
  rewrite.
- Do not name anything "turn"/"TURN" (SPEC §3.1).
