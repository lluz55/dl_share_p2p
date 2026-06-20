# Task 14 — Go data relay (fallback)

- **Phase:** 4 (conditional)
- **Status:** In Progress
- **Depends on:** 13
- **SPEC references:** §3.1, §4.3, §6, §9, §10 (Phase 4), §11.1, §11.2

## Objective

Implement `server/relay.go`: the Go WebSocket data relay used **only** when direct
P2P cannot be established (SPEC §4.3). It requires backend-approved authentication
(mechanism resolved in task 13) before any file bytes are relayed. This is the
only fallback — there is no third-party TURN (SPEC §3.1, §1.2).

## Precondition (hard gate)

Do not write any code until SPEC §11.1 (relay auth) and §11.2 (relay limits) are
resolved in SPEC.md by task 13. If they are still open, STOP (SPEC §4.3, §0
rule 2).

## In scope

- `server/relay.go` — relay session setup, the backend-approved auth from the
  resolved SPEC §4.3, and byte relaying within a room.
- Frontend fallback: when WebRTC ends in `failed` (task 05), perform the auth and,
  on approval, transfer via the relay (reusing transfer framing from task 06 where
  possible).
- Relay limits from the resolved SPEC §11.2.

## Requirements (subject to task-13 SPEC updates)

1. **Fallback only (SPEC §3.1, §4.3):** relay engages only after direct P2P
   fails. Direct P2P remains the unauthenticated, server-blind preferred path.
2. **Auth before bytes (SPEC §3.1, §4.3):** NO file bytes are relayed until the
   backend has approved the session per the mechanism defined in SPEC §4.3 (post
   task 13). Implement exactly that mechanism — do not invent an alternative.
3. **Scoped to a room (SPEC §9):** the relay only intermediates within a valid
   room the connection is registered in. No generic relay endpoint exists.
4. **No persistence (SPEC §9):** never store file contents; stream through.
5. **Limits (SPEC §11.2, resolved):** enforce bandwidth cap, max file size, and
   max concurrent relay sessions as defined.
6. **Safeguards still apply (SPEC §6):** all §6 limits/timeouts/logging continue
   to hold for relay connections; never log file data (SPEC §6.6, §9).
7. **Naming (SPEC §3.1):** no "turn"/"TURN" in identifiers, files, or logs.

## Out of scope

- Changing the resolved auth mechanism — that belongs to task 13/SPEC.
- Any third-party TURN or new transport (SPEC §1.2, §2).

## Acceptance criteria

- When direct P2P is forced to fail, an authenticated relay session (per SPEC
  §4.3) transfers the file correctly (byte-identical), and only after approval.
- Unauthenticated/denied sessions relay zero file bytes.
- Relay limits (SPEC §11.2) are enforced and tested.
- All SPEC §6 safeguards verified against relay connections; logs contain no file
  data; no "TURN" identifiers anywhere.
- `go vet` / `go test -race` pass; add tests for the auth gate and limit
  enforcement.

## Notes

- This task is conditional (SPEC §10 Phase 4). It exists so the work is ready the
  moment the open question is resolved — not so it can be started early.
