# Task 09 — 1↔n transfer (one host, many guests)

- **Phase:** 2
- **Status:** Done
- **Depends on:** 08
- **SPEC references:** §4.1, §4.3, §10 (Phase 2)

## Objective

Extend the working 1↔1 system to 1↔n: a host shares with multiple guests in the
same room, opening a separate `RTCPeerConnection` per guest (SPEC §4.1). Same room
mechanism, same direct-P2P transport.

## In scope

- Host-side management of multiple peer connections/data channels (one per guest).
- UI for multiple connected guests and per-guest transfer/progress.
- Reuse task 05 (per-peer connection) and task 06 (transfer takes a target
  channel) — these were designed to be per-peer; this task makes the host drive
  many of them.

## Requirements

1. **Per-guest connections (SPEC §4.1):** the host maintains one
   `RTCPeerConnection` + `DataChannel` per guest, keyed by peerId from signaling
   (membership events from task 02). Guests still connect only to the host.
2. **Room capacity:** respect member caps and "close to new joins at expected
   count" from SPEC §6.5 (already enforced server-side; surface it in UI).
3. **Fan-out transfer:** sending a file delivers it to all connected guests
   (sequentially or in parallel — choose and document; mind aggregate
   backpressure). Each guest sees its own progress; host sees per-guest progress.
4. **Guest churn:** a guest leaving/failing MUST NOT break transfers to others
   (independent connections; isolate failures).

## Out of scope

- Reconnection/code UX polish → task 10.
- Relay → task 14.
- Raising server-side caps beyond SPEC §6.5 defaults without a SPEC change.

## Acceptance criteria

- One host + ≥2 guests in a room each receive a file correctly (byte-identical),
  with per-guest progress shown.
- A guest disconnecting mid-session does not interrupt the others.
- No regression to the 1↔1 flow.
- `strict` TS compiles; relevant tests pass.

## Notes

- If task 05/06 were not actually built per-peer, refactor them to be per-peer
  here rather than special-casing the host — keep a single code path.
