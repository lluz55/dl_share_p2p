# Task 10 — UX: progress, reconnection, code flow

- **Phase:** 2
- **Status:** Done
- **Depends on:** 08 (and integrates well after 09)
- **SPEC references:** §10 (Phase 2), §4.1, §8

## Objective

Improve usability without changing the transport model: real progress bars,
signaling reconnection, and a smoother room-code experience (SPEC §10 Phase 2).

## In scope

- **Progress UX:** proper progress bars (rate, ETA, bytes) on both sender and
  receiver; clear completion and error states.
- **Reconnection:** robust signaling WebSocket reconnection with backoff. Note:
  signaling is always-on and the base of everything (SPEC §3.1) — reconnect the
  WS and re-establish room state gracefully. An in-flight WebRTC DataChannel is
  independent of the signaling socket; define and document the intended behavior
  when signaling drops mid-transfer.
- **Code UX (SPEC §4.1):** easy copy of the three-word code, shareable link
  carrying the code, validation/feedback on join (e.g. unknown/expired code), and
  clear "room full / expired" messaging tied to SPEC §6.5 server responses.

## Requirements

1. Reconnection MUST NOT weaken any SPEC §6 safeguard or bypass origin/room
   checks. It only re-runs the normal join handshake.
2. Code-sharing link MUST keep the signaling URL configurable (SPEC §8) — don't
   bake localhost or a specific tunnel into shared links incorrectly; the code is
   the credential, the endpoint comes from `config.ts`.
3. Keep it framework-free and lightweight (SPEC §1.1).

## Out of scope

- Larger code alphabet / anti-hijack tokens / manual host approval → SPEC §7
  deferred; do not implement.
- Relay → task 14.

## Acceptance criteria

- Dropped signaling connection recovers automatically without a full page reload,
  and the documented mid-transfer behavior holds.
- Progress bars show meaningful rate/ETA and resolve to clear done/error states.
- Copy code and share-link join both work; invalid/expired/full codes give clear
  feedback.
- No regression to 1↔1 or 1↔n; `strict` TS compiles.

## Notes

- Document the chosen behavior for "signaling drops while a DataChannel transfer
  is in progress" — it is a real edge case and stakeholders need the answer.
