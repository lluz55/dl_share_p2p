# Task 13 — Resolve relay auth open question (decision, not code)

- **Phase:** 4 (gating)
- **Status:** Done
- **Depends on:** 08
- **SPEC references:** §4.3, §11.1, §11.2, §0 (rules 2, 3, 5)

## Objective

Resolve SPEC §11.1 — the **relay authentication mechanism** — and §11.2 (relay
limits), then update SPEC.md accordingly. This is a **decision + spec-update**
task. It produces NO relay code. Task 14 (the relay) MUST NOT begin until this is
resolved and the SPEC is updated (SPEC §4.3, §11.1).

## Why this is its own task

Per SPEC §0 rule 2 and §4.3, the relay cannot be invented or implemented while
its auth model is an open question. The agent MUST NOT guess. This task forces an
explicit decision, recorded in the source of truth, before any implementation.

## In scope

- Analyze the §11.1 options and recommend one:
  - backend auto-approves under defined rules,
  - host approves and backend enforces,
  - guest proves a shared secret,
  - (or a justified combination consistent with SPEC constraints).
- Define §11.2 relay limits: bandwidth cap, max file size, max concurrent relay
  sessions.
- Update SPEC.md: move the resolved items out of §11, write the concrete
  mechanism into §4.3, add a changelog entry (SPEC §13), and adjust §10 Phase 4 /
  §7 deferred items as needed.

## Hard constraints the decision MUST respect

- The relay is a Go WebSocket data relay, NOT TURN; the word "TURN" MUST NOT
  enter code/identifiers (SPEC §3.1).
- The relay MUST NOT transmit any file bytes until backend-approved auth has
  completed (SPEC §3.1, §4.3).
- No third-party TURN, no extra Cloudflare services, no new transport not in SPEC
  §2 (SPEC §1.2, §2). If the chosen mechanism seems to need one, STOP and raise it
  (SPEC §0 rule 2).
- No user accounts/login (SPEC §1.2) — the mechanism must work without them.
- The server MUST NOT persist file contents (SPEC §9).

## Deliverables

- A short decision record (`docs/decisions/relay-auth.md` or inline in this task)
  capturing options, trade-offs, and the chosen mechanism with rationale.
- Updated SPEC.md (§4.3, §10, §11, §13 changelog) reflecting the decision.
- Clear, testable acceptance criteria handed to task 14.

## Acceptance criteria

- SPEC §11.1 and §11.2 are resolved and removed from Open Questions, with the
  concrete mechanism + limits written into the normative sections.
- The decision respects every constraint above (verifiable against the SPEC).
- A changelog entry (SPEC §13) records the change and date.
- Task 14's requirements can be derived unambiguously from the updated SPEC.

## Notes

- If stakeholders cannot decide, this task stays open and task 14 stays blocked.
  That is the correct outcome per SPEC §4.3 — do not unblock by guessing.
