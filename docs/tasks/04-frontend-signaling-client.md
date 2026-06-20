# Task 04 — Frontend signaling client

- **Phase:** 1
- **Status:** Done
- **Depends on:** 01 (and the message protocol defined in 02)
- **SPEC references:** §3, §4.2, §5, §8

## Objective

Implement `web/src/signaling.ts`: a thin WebSocket client that connects to the Go
signaling server, sends/receives the typed messages defined in task 02, and
exposes events to the rest of the frontend (peer, transfer, UI). No WebRTC logic
here — this layer only moves signaling messages.

## In scope

- `web/src/signaling.ts` — connect, send typed messages, dispatch inbound events.
- Use `config.ts` (task 01) for the endpoint; MUST be `wss://` against the tunnel
  in production, configurable, never hardcoded localhost (SPEC §8).

## Requirements

1. **Connection:** open a WS to the configured signaling URL. Surface
   open/close/error states to consumers (callback or small event emitter).
2. **Protocol parity:** send and parse exactly the message types from task 02
   (`join`, `offer`, `answer`, `ice` outbound; `joined`, `peer-joined`,
   `peer-left`, `error`, plus forwarded `offer`/`answer`/`ice` inbound). If task
   02 recorded the protocol in a `PROTOCOL.md`/comment, mirror it precisely. Use
   shared TypeScript types/interfaces for messages.
3. **API surface (suggested):**
   - `createRoom()` → sends `join` with empty room.
   - `joinRoom(code)` → sends `join` with the code.
   - `sendOffer(to, sdp)`, `sendAnswer(to, sdp)`, `sendIce(to, candidate)`.
   - Events: `onJoined`, `onPeerJoined`, `onPeerLeft`, `onOffer`, `onAnswer`,
     `onIce`, `onError`, `onClose`.
4. **No inspection of SDP/ICE** beyond passing it through (mirror server: opaque).
5. **Robust parsing:** ignore/handle unknown inbound types gracefully (log in dev,
   don't crash). Reconnection UX is Phase 2 (task 10) — here, just expose the
   close/error events; a basic auto-reconnect MAY be stubbed but full reconnection
   logic is out of scope.

## Out of scope

- WebRTC peer connection (task 05), file transfer (task 06), UI (task 07).
- Full reconnection/backoff UX → task 10.

## Acceptance criteria

- Against a running task-02/03 server, `createRoom()` yields a `joined` event
  with a 3-word code and host role; `joinRoom(code)` from a second client joins.
- Outbound `offer/answer/ice` are delivered to the addressed peer (verified once
  task 05 exists, or via a manual WS echo test now).
- TypeScript compiles under `strict`. No `any` on the message boundary (typed).
- Endpoint comes from `config.ts`; no localhost literal in this file.

## Notes

- Keep this module free of DOM access — it's transport only, so task 05/07 can
  consume it cleanly.
