# Task 15 — Serverless signaling (Trystero) with Go fallback

- **Phase:** 5
- **Status:** In Progress
- **Depends on:** 08, 14
- **SPEC references:** §1, §2, §3, §3.1, §4.1, §4.2, §4.3, §6, §9, §10 (Phase 5), §12

## Objective

Make a third-party serverless signaling service (**Trystero**, Nostr strategy) the
**primary** way peers pair and run direct P2P, and demote the Go server to a
**fallback** that provides signaling when the third party fails to pair peers and
the authenticated data relay (task 14) when direct P2P fails behind NAT (SPEC §3.1).
The 3-word room code becomes a client-generated rendezvous key shared by both
signaling transports (SPEC §4.1).

## In scope

- **Dependency:** add `trystero` (import `trystero/nostr`). Bundled by esbuild.
- **Client room code (SPEC §4.1):** `web/src/roomcode.ts` — port the 160-word PT
  list and generation from `server/room.go`; host generates the code in-browser.
- **Server accepts host-chosen code (SPEC §4.1):** `server/hub.go`
  `JoinOrCreateRoom(peer, requestedRoom, asHost)` + `server/ws.go` join handler.
  A `join` with `role:"host"` and a non-empty `room` creates that room (error
  `code-taken` if it exists). Guest join unchanged.
- **Transport layer (frontend):**
  - `web/src/transport.ts` — common `Transport` interface + event types.
  - `web/src/trystero-transport.ts` — Nostr signaling + native binary transfer
    (`room.makeAction` with `onProgress`/`onReceiveProgress`); passes the swappable
    ICE list (SPEC §4.2) via `rtcConfig`. Signaling only; never carries file bytes
    through the third party (SPEC §1.2).
  - `web/src/go-transport.ts` — thin adapter over the existing `signaling.ts` /
    `peer.ts` / `transfer.ts`, plus relay escalation (`relay-transfer.ts`) for NAT.
  - `web/src/relay-transfer.ts` — relay WebSocket client reusing the metadata/
    chunk/eof framing (the Go relay bridges bytes verbatim, host → guest).
  - `web/src/orchestrator.ts` — sequential fallback (SPEC §3.1): Trystero first;
    guest falls back to Go after ~8s or on error/NAT failure; host keeps a Go
    standby listener so fallen-back guests can find it.
- **UI:** `web/src/main.ts` talks only to the orchestrator; the status badge shows
  the active path (serverless / server signaling / relay). The Phase-1 "fallback
  not supported" message is removed.

## Requirements

1. **Serverless primary (SPEC §3.1, §4.2):** with a healthy third party and a
   reachable network, peers pair and transfer **without** the Go server.
2. **Same code across transports (SPEC §4.1):** the host-generated code is used as
   both the Trystero room name and the Go room code; the Go server accepts it.
3. **Sequential fallback (SPEC §3.1, §4.2):** the guest tries Trystero first and
   falls back to Go only when it fails to pair in time / errors / NAT-fails.
4. **Relay only for NAT (SPEC §3.1, §4.3):** when direct P2P fails, fall back to the
   authenticated Go data relay (task 14). No third-party TURN (SPEC §1.2).
5. **Word-list parity (SPEC §4.1):** `roomcode.ts` MUST match `server/room.go`.
6. **Safeguards still apply (SPEC §6, §9):** the Go server keeps all §6 limits; no
   SDP/file data in logs; no generic relay endpoint.
7. **Naming (SPEC §3.1):** no "turn"/"TURN" identifiers for the data relay.

## Scope split

- **5a (this task):** full 1↔1 — Trystero primary, Go signaling fallback, Go relay
  on NAT. 1↔n **direct** P2P over Trystero works natively (per-peer send/progress).
- **5b (later):** per-guest relay escalation for 1↔n (host running both transports
  with mixed direct/relay guests). Not in 5a.

## Known tradeoff

The host keeps a Go standby signaling connection open for the whole session so that
a guest which falls back to Go can still find it (the host cannot detect third-party
failure on its own). No signaling traffic flows over Go in the happy path; host-side
Go errors are suppressed while the serverless path works.

## Acceptance criteria

- Two browsers on the same network pair and transfer a file via Trystero with the
  Go server **stopped** (proves third-party independence).
- With the third party blocked/unavailable, the guest falls back to Go signaling
  (same code) and transfers.
- With direct P2P forced to fail (NAT), the file transfers through the Go data relay
  within the §11.2 caps.
- `server`: `go build ./...`, `go test ./...` pass, including host-chosen-code +
  `code-taken`.
- `web`: `npx tsc --noEmit` clean and `npm run build` produces the bundle.
