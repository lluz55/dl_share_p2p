# Task 07 — Frontend UI & wiring

- **Phase:** 1
- **Status:** Done
- **Depends on:** 04, 05, 06
- **SPEC references:** §1.1 (minimal frontend), §4.1, §4.3, §5

## Objective

Implement `web/src/main.ts` and `web/index.html`: the user-facing UI that ties
together signaling (04), peer connection (05), and transfer (06) into a working
1↔1 file-sharing flow. Minimal, no framework (SPEC §1.1, §2).

## In scope

- `web/index.html` — minimal markup/styling.
- `web/src/main.ts` — UI state machine and wiring of the three modules.
- Finalize `web/build.ts` (esbuild) to bundle `main.ts` as the real entry.

## Requirements

1. **Create flow (host):** a "Create room" action calls `createRoom()`, displays
   the generated three-word code clearly, and shows a copyable/shareable form
   (SPEC §4.1 — the code is the access credential).
2. **Join flow (guest):** an input to enter a three-word code + "Join", calling
   `joinRoom(code)`.
3. **Connection state UI:** reflect signaling + WebRTC states (waiting,
   connecting, connected, failed). On `failed` direct P2P, show a clear message
   that direct connection wasn't possible. Do NOT mention or attempt a relay —
   the relay is Phase 4 and unresolved (SPEC §11.1, §4.3).
4. **Transfer UI:** file picker on the sender; progress bar(s) on both sender and
   receiver; download surfaced on the receiver (SPEC §4.3). Basic progress is
   enough here; richer UX (animated bars, retries) is task 10.
5. **Wiring:** subscribe to module callbacks; keep DOM logic in `main.ts` only
   (modules 04–06 stay DOM-free).
6. **Config/build:** `build.ts` bundles `src/main.ts` → `dist/` with sourcemaps in
   dev. The signaling URL comes from `config.ts` (overridable for the tunnel,
   SPEC §8) — surface how to set it for deployment in the README/build.

## Out of scope

- 1↔n multi-guest UI → task 09.
- Reconnection, fancy code UX, copy-to-clipboard polish, QR, etc. → task 10
  (basic copy is fine here).
- Relay anything → task 14.

## Acceptance criteria

- From a built bundle served statically, a user can create a room, share the
  code, have a second browser join, pick a file, and complete a transfer with
  visible progress on both ends.
- The UI clearly shows the room code and connection state.
- No framework added; bundle stays small (SPEC §1.1). `strict` TS compiles.
- Direct-P2P failure is communicated without referencing a relay.

## Notes

- This task completes the Phase-1 happy path; the formal proof of end-to-end
  transfer and safeguards is task 08.
