# Task Index — P2P File Share

> Source of truth is always [`../../SPEC.md`](../../SPEC.md). These task files
> decompose the spec into self-contained units of work for LLM agents. If a task
> and the SPEC ever disagree, the SPEC wins — fix the task, raise the conflict.

## How to use these tasks

- Pick the lowest-numbered task whose dependencies are all `Done`.
- Each task file is self-contained: it restates the constraints it needs, but you
  MUST still treat SPEC.md `MUST`/`MUST NOT` as binding.
- Do **not** pull work from a later phase into an earlier one (SPEC §10).
- Do **not** invent technologies/transports not in SPEC §2 (SPEC §0 rule 2).
- If something is ambiguous, check SPEC §11 (Open Questions). Do not guess.
- When you finish a task, update its `Status` and note any SPEC changes made.

## Conventions

- Repo root layout follows SPEC §5. (Spec shows a `p2pshare/` wrapper; in this
  repo the project lives at the repository root — `server/`, `web/`, `flake.nix`
  sit next to `SPEC.md`.)
- Backend: Go. Frontend: vanilla TypeScript + esbuild. No frontend framework.
- The Go WebSocket data relay (SPEC §4.3) is NEVER called "TURN" in code or
  identifiers (SPEC §3.1 terminology note).

## Tasks & dependency order

| # | Task | Phase | Depends on | Status |
|---|------|-------|------------|--------|
| 01 | [Project scaffold & dev environment](01-project-scaffold.md) | 1 | — | Done |
| 02 | [Signaling server core](02-signaling-server-core.md) | 1 | 01 | Done |
| 03 | [Server safeguards / hardening](03-server-safeguards.md) | 1 | 02 | Done |
| 04 | [Frontend signaling client](04-frontend-signaling-client.md) | 1 | 01 | Done |
| 05 | [Frontend peer connection (WebRTC)](05-frontend-peer-connection.md) | 1 | 04 | Done |
| 06 | [Frontend file transfer](06-frontend-file-transfer.md) | 1 | 05 | Done |
| 07 | [Frontend UI & wiring](07-frontend-ui.md) | 1 | 04, 05, 06 | Done |
| 08 | [Phase 1 end-to-end verification](08-phase1-e2e-verification.md) | 1 | 02, 03, 07 | Done |
| 09 | [1↔n transfer (one host, many guests)](09-phase2-one-to-many.md) | 2 | 08 | Done |
| 10 | [UX: progress, reconnection, code flow](10-phase2-ux.md) | 2 | 08 | Done |
| 11 | [flake.nix packaging](11-phase3-flake-packaging.md) | 3 | 08 | Done |
| 12 | [Deployment: tunnel + static host](12-phase3-deployment.md) | 3 | 11 | Done |
| 13 | [Resolve relay auth open question](13-phase4-relay-auth-decision.md) | 4 | 08 | Done |
| 14 | [Go data relay (fallback)](14-phase4-data-relay.md) | 4 | 13 | In Progress |
| 15 | [Serverless signaling (Trystero) + Go fallback](15-phase5-serverless-signaling.md) | 5 | 08, 14 | In Progress |

### Dependency graph

```
01 ──┬── 02 ── 03 ──┐
     │              ├── 08 ──┬── 09
     └── 04 ── 05 ──┤        ├── 10
              └ 06 ─┤        ├── 11 ── 12
              07 ───┘        └── 13 ── 14 ── 15
```

## Phase gating (SPEC §10)

- **Phase 1** (tasks 01–08): core transport + essential safeguards. Current scope.
- **Phase 2** (09–10), **Phase 3** (11–12): start only after Phase 1 is Done.
- **Phase 4** (13–14): conditional. Task 14 may proceed only after task 13
  resolves SPEC §11.1 and the SPEC is updated.
- **Phase 5** (15): third-party serverless signaling primary, Go fallback. Builds on
  the relay (14) for NAT. SPEC §3.1/§4.1/§4.2 updated 2026-06-21.
