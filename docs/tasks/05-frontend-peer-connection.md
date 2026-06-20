# Task 05 — Frontend peer connection (WebRTC)

- **Phase:** 1
- **Status:** Done
- **Depends on:** 04
- **SPEC references:** §3.1, §4.2, §4.3 (direct P2P), §5

## Objective

Implement `web/src/peer.ts`: manage a `RTCPeerConnection` and its `DataChannel`,
driven by signaling events from task 04. Establish a **direct P2P** connection
via public STUN. This is the preferred transport (SPEC §4.3); no authentication
and the server never sees the data.

## In scope

- `web/src/peer.ts` — create/configure `RTCPeerConnection`, create/accept
  `DataChannel`, perform offer/answer/ICE exchange via the signaling client.
- **Swappable ICE server list** (SPEC §4.2): the ICE config MUST be a list,
  currently public STUN only (e.g. `stun:stun.l.google.com:19302`), structured so
  a relay/TURN-style entry could be appended later **without changing code
  elsewhere**. Keep it in one place (e.g. `config.ts` or a constant in `peer.ts`).

## Requirements

1. **Roles:** host creates the offer and the `DataChannel`; guest answers and
   receives the channel (`ondatachannel`). Use the signaling `to`/peerId from
   task 04 so this works per-peer (foundation for 1↔n in task 09 — design for one
   `RTCPeerConnection` per remote peer even if Phase-1 UI uses just one).
2. **Signaling glue:** wire `onOffer`/`onAnswer`/`onIce` from task 04 into
   `setRemoteDescription` / `addIceCandidate`, and emit local
   description/candidates back out via `sendOffer`/`sendAnswer`/`sendIce`.
3. **ICE config:** swappable list as above. Document the seam.
4. **Connection state:** expose connection/datachannel state changes (connecting,
   connected, failed, closed) to the UI (task 07).
5. **Direct-only for Phase 1:** if ICE fails (no direct path), surface a clear
   `failed` state. Do NOT attempt any relay fallback — the Go data relay is Phase
   4 (task 14) and its auth is an unresolved open question (SPEC §11.1, §4.3).
6. **DataChannel handoff:** expose the established `DataChannel` (and per-peer
   identity) to the transfer layer (task 06). Do not implement chunking here.

## Out of scope

- File chunking/progress/reassembly → task 06.
- Multiple simultaneous guests UI/orchestration → task 09 (but keep per-peer
  design so 09 is additive).
- Any relay fallback → task 14.

## Acceptance criteria

- Two browsers (or two tabs) in the same room establish a connected
  `RTCPeerConnection` with an open `DataChannel` over STUN.
- ICE server list is defined once and is clearly extensible without touching
  call sites.
- Connection state transitions are observable by the UI layer.
- On unreachable direct path, state ends in `failed` with no relay attempt.
- TypeScript compiles under `strict`.

## Notes

- Handle both `RTCPeerConnection` negotiation roles cleanly; avoid glare by
  keeping a single offerer (host) per pair in Phase 1.
- The DataChannel is the E2E-encrypted transport (SPEC §1.1) — rely on WebRTC's
  built-in DTLS; do not add app-layer crypto.
