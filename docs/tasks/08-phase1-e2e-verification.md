# Task 08 — Phase 1 end-to-end verification

- **Phase:** 1
- **Status:** Done
- **Depends on:** 02, 03, 07
- **SPEC references:** §6 (all), §9, §10 (Phase 1 exit), §3.1

## Objective

Prove Phase 1 is complete and safe: a working direct-P2P 1↔1 file transfer over
the real transport chain, with every §6 safeguard verified. This is the Phase-1
exit gate (SPEC §10). No new product features — verification, test harness, and
documentation only.

## In scope

- An end-to-end test/verification procedure (automated where feasible, documented
  manual steps where not).
- A safeguards checklist mapped 1:1 to SPEC §6 with evidence for each.
- Developer docs to run the whole thing locally.

## Requirements

1. **E2E transfer proof (SPEC §3.1, §10):**
   - Run the Go server (localhost), serve the frontend bundle, open two
     clients, create+join a room, transfer a known file, verify byte-identical
     receipt (hash match).
   - Capture that the path was **direct P2P** (no relay involved — relay doesn't
     exist yet).
2. **Safeguards verification (SPEC §6):** produce a checklist with a pass/fail and
   how it was tested for each of §6.1–§6.6, e.g.:
   - 6.1 server not reachable except on 127.0.0.1.
   - 6.2 disallowed Origin rejected; plain HTTP rejected.
   - 6.3 per-IP conn rate limit, conn caps, handshake timeout, ping/pong reaping.
   - 6.4 read limit, message flood limit, schema validation.
   - 6.5 room caps, TTL expiry, room-registration enforcement.
   - 6.6 recover-per-connection, no SDP/file data in logs, structured logs.
   Automate the cheap ones (origin, read limit, schema, rate limiter unit tests);
   document manual checks for the rest.
3. **Run docs:** a short "how to run Phase 1 locally" guide (server + frontend +
   two clients). May live in `README.md` or `docs/`.
4. **Phase-1 exit statement:** confirm no Phase 2/3/4 work leaked in (SPEC §10),
   and that no relay/auth code exists (SPEC §11.1 still open).

## Out of scope

- Public exposure via cloudflared (that's task 12, Phase 3) — verification here is
  local. But §6 must already be satisfied so exposure *would* be safe.
- Any new features.

## Acceptance criteria

- A documented, repeatable procedure demonstrates a successful, integrity-checked
  1↔1 direct-P2P transfer.
- Every SPEC §6 item has an explicit pass with evidence in the checklist.
- Automated tests (`go test -race ./...`, plus any frontend tests) pass.
- Confirmed: no relay code, no "turn"/"TURN" identifiers, no out-of-phase work.

## Notes

- If any §6 item cannot be satisfied, STOP and fix in the owning task (02/03)
  before marking Phase 1 done — do not hand-wave a safeguard.
