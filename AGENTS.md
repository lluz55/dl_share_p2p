# AGENTS.md — P2P File Share

> **Audience:** LLM agents implementing this project.
> **Authority order:** SPEC.md > task files > this file. When any conflict exists, the SPEC wins.
> **Last updated:** 2026-06-20

---

## 1. Start here

Before writing any code:

1. Read **SPEC.md** in full. Every `MUST`/`MUST NOT` is a hard constraint.
2. Read **docs/tasks/00-INDEX.md** to see task order and dependency graph.
3. Pick the **lowest-numbered task** whose dependencies are all `Done`.
4. Read that task file fully before touching any code.
5. Mark the task as in progress: update the task file's `Status:` field and the status of the task in the table in [00-INDEX.md](file:///home/lluz/dev/dl_share_me/docs/tasks/00-INDEX.md) to `In Progress`.
6. Check **SPEC §11** (Open Questions). If the thing you need to implement depends on an unresolved question, stop and flag it — do not guess.
7. **Shell commands:** You MUST run all shell commands (tests, build, formatting, linting, etc.) through `nix develop -c <command>` (e.g., `nix develop -c go test ./...` or `nix develop -c npm install`) to ensure the Nix-provided toolchain is active. Do not run commands directly in the host shell.

---

## 2. Repository layout

```
.
├── SPEC.md                    # single source of truth
├── AGENTS.md                  # this file
├── docs/tasks/                # one task file per unit of work
│   ├── 00-INDEX.md            # task table + dependency graph
│   └── NN-<name>.md
├── server/                    # Go backend (created in task 01)
│   ├── main.go
│   ├── hub.go
│   ├── room.go
│   ├── ws.go
│   └── relay.go               # Phase 4 only — do not create before task 14
├── web/                       # TypeScript frontend (created in task 01)
│   ├── src/
│   │   ├── config.ts
│   │   ├── main.ts
│   │   ├── signaling.ts
│   │   ├── peer.ts
│   │   └── transfer.ts
│   ├── index.html
│   └── build.ts               # esbuild script
└── flake.nix
```

> Note: The SPEC shows a `p2pshare/` wrapper directory. This repo has no wrapper —
> `server/`, `web/`, and `flake.nix` live at the repository root beside `SPEC.md`.

---

## 3. Phase scope (what is in scope RIGHT NOW)

**Phase 1 — current scope (tasks 01–08):**
- Go signaling server over WebSocket, room = 3 random words, bound to `127.0.0.1`.
- Full §6 safeguards (rate limits, caps, timeouts, origin check, schema validation).
- Direct P2P 1↔1 via public STUN. Prove end-to-end file transfer.
- No data relay.

**Do not begin Phase 2, 3, or 4 tasks** until all Phase 1 tasks are `Done`. Do not pull deferred items into the current phase without updating the SPEC first.

---

## 4. Hard constraints (always enforced)

These apply regardless of phase or task:

| Constraint | Source |
|---|---|
| Server MUST bind only to `127.0.0.1` | SPEC §6.1 |
| WebSocket origin MUST be allowlisted (frontend domain only) | SPEC §6.2 |
| Signaling has no fallback — it is always on | SPEC §3.1 |
| Direct P2P requires NO authentication — server does not see that data | SPEC §3.1 |
| Data relay MUST NOT relay file bytes before backend-approved auth | SPEC §4.3 |
| Data relay is NOT implemented until SPEC §11.1 is resolved | SPEC §10, Phase 4 |
| Server MUST NOT persist or store file contents ever | SPEC §9 |
| Every WS message must belong to a valid room the connection is registered in | SPEC §9 |
| No secrets, SDP contents, or file data in logs | SPEC §6.6, §9 |
| No third-party TURN server | SPEC §1.2 |
| No frontend framework | SPEC §2 |
| No technologies not listed in SPEC §2 | SPEC §0 |
| `wss://` always in production; plain `ws://` MUST NOT be used | SPEC §8 |
| Signaling URL MUST be configurable, NOT hardcoded to localhost | SPEC §8 |
| Shell commands MUST be run via `nix develop -c <command>` | AGENTS.md |

---

## 5. Terminology (critical)

| Term | Meaning |
|---|---|
| **Host** | Peer that creates a room. |
| **Guest** | Peer that joins a room by code. |
| **Signaling** | WebRTC offer/answer/ICE exchange via Go server. Always on. |
| **Direct P2P** | WebRTC DataChannel via STUN. Server never sees data. No auth. |
| **Data relay** | Go WebSocket relay — fallback when direct P2P fails. Requires backend auth. |
| **Tunnel** | Cloudflare Tunnel. Only public entry point. |

**The data relay is NOT the TURN protocol.** The word `TURN` MUST NOT appear in any
code identifier, variable name, function name, or comment that refers to the Go relay
(SPEC §3.1). Stakeholders use the word informally — correct it in code.

---

## 6. Technology conventions

### Go (backend)
- Minimum Go version: whatever `go.mod` declares. Use standard library + gorilla/websocket or nhooyr.io/websocket (justify the choice and do not add others).
- No data races: run `go test -race ./...` before marking a task Done.
- Each task's acceptance criteria include `go vet ./...` passing.
- Seams for task 03 (rate limiting, deadlines, per-connection recovery) MUST be left clean in task 02. Do not make 03 require a rewrite.
- `server/relay.go` MUST NOT be created until task 14 (Phase 4, after §11.1 is resolved).

### TypeScript (frontend)
- Vanilla TypeScript only. No framework (React, Vue, Svelte, etc.).
- `tsconfig.json` with `"strict": true`.
- Build via esbuild only. No Webpack, Vite, Parcel.
- Minimal runtime dependencies — if a dependency is not in SPEC §2, it requires justification.

### Nix
- `flake.nix` in task 01: `devShell` only (Go, Node/esbuild, cloudflared). No packages yet.
- Full packages (`packages.server`, `packages.frontend`) and cloudflared service are task 11 (Phase 3).
- **Dev Shell usage:** You MUST use `nix develop -c <command>` (e.g., `nix develop -c go test ./...` or `nix develop -c npm install`) for shell commands to guarantee the Nix-provided toolchain is active.

---

## 7. Message protocol (Phase 1 — authoritative)

The Go server and TypeScript client MUST agree on these exact types. Task 02 defines
the server side; task 04 MUST mirror it without deviation.

**Client → Server:**

| Type | Fields | Meaning |
|---|---|---|
| `join` | `type`, `room` (string, may be empty) | Empty = create room as host; non-empty = join as guest |
| `offer` | `type`, `to` (peerId), `sdp` (opaque) | Forward WebRTC offer to peer |
| `answer` | `type`, `to` (peerId), `sdp` (opaque) | Forward WebRTC answer to peer |
| `ice` | `type`, `to` (peerId), `candidate` (opaque) | Forward ICE candidate to peer |

**Server → Client:**

| Type | Fields | Meaning |
|---|---|---|
| `joined` | `type`, `room`, `self` (peerId), `role` ("host"/"guest"), `peers` ([]peerId) | Acknowledgement of join |
| `peer-joined` | `type`, `id` (peerId) | A new peer joined the room |
| `peer-left` | `type`, `id` (peerId) | A peer disconnected |
| `error` | `type`, `reason` | Error; server will close the connection |

Rules:
- SDP/ICE payloads are **opaque** — forward only, never inspect or log.
- Unknown type or malformed JSON → reject and drop the connection (SPEC §6.4).
- A message referencing a room the connection is not in → reject and drop (SPEC §9).
- Record the final agreed protocol in `server/PROTOCOL.md` (or a header comment block in `ws.go`).

---

## 8. Security safeguards checklist (Phase 1, SPEC §6)

Task 03 implements all of these. They MUST all be present before Phase 1 is `Done`.

- [ ] **Bind**: `127.0.0.1` only. (§6.1)
- [ ] **Origin**: strict allowlist of frontend domain(s). Reject all others. (§6.2)
- [ ] **Rate limit**: new connections per IP (token bucket). Read real IP from `CF-Connecting-IP`. (§6.3)
- [ ] **Connection cap**: simultaneous connections per IP and globally. (§6.3)
- [ ] **Handshake timeout**: drop connections that do not join a room within N seconds. (§6.3)
- [ ] **Ping/pong + read deadline**: reap dead connections; drop peers that miss pong. (§6.3)
- [ ] **Max message size**: `SetReadLimit` to a few KB (SDP/ICE are small). (§6.4)
- [ ] **Message rate limit**: per-connection anti-flood. (§6.4)
- [ ] **Schema validation**: only `offer`/`answer`/`ice`/`join`; unknown type drops the connection. (§6.4)
- [ ] **Room cap**: max total rooms globally. (§6.5)
- [ ] **Room per-IP cap**: max rooms created by one IP. (§6.5)
- [ ] **Room TTL**: expire after inactivity. (§6.5)
- [ ] **Members per room cap**: defined limit. (§6.5)
- [ ] **Close room to new joins** once expected participant count reached. (§6.5)
- [ ] **Unprivileged process**: no root. (§6.6)
- [ ] **`recover` per goroutine**: a bad connection MUST NOT crash the process. (§6.6)
- [ ] **Structured logging**: IP, room, event type. Never log SDP or file data. (§6.6)

---

## 9. Open questions — do NOT implement without resolving

| # | Question | Blocks |
|---|---|---|
| §11.1 | Relay authentication mechanism | task 14 (Phase 4) — relay is not implemented until this is resolved |
| §11.2 | Relay limits (bandwidth, file size, concurrent sessions) | task 14 |
| §11.3 | Word list source and size | placeholder acceptable in task 02; leave `// TODO(SPEC §11.3)` |

If you reach code that depends on an unresolved question: **stop, do not guess, flag it.**

---

## 10. When you finish a task

1. Ensure all acceptance criteria in the task file are met.
2. Run `go vet ./...` and `go test -race ./...` (for backend tasks).
3. Update the task file's `Status:` field to `Done` and also update the task's status in the table in [00-INDEX.md](file:///home/lluz/dev/dl_share_me/docs/tasks/00-INDEX.md) to `Done`.
4. If any SPEC decision was made or clarified during implementation, update SPEC.md and note it in the changelog (SPEC §13). Code and spec must never disagree.
5. If you discovered an ambiguity not in §11, add it to §11 before resolving it.

---

## 11. Anti-patterns — never do these

- Do not call the Go data relay "TURN" in any identifier or comment.
- Do not add a frontend framework, bundler other than esbuild, or runtime dependency not in SPEC §2.
- Do not introduce a third-party TURN server or any Cloudflare service beyond the Tunnel.
- Do not hardcode the signaling URL to localhost.
- Do not log SDP contents, ICE candidates, or file data.
- Do not relay file bytes before backend-approved auth is complete (Phase 4+ only).
- Do not create `server/relay.go` before task 14.
- Do not begin a phase's tasks before the prior phase is fully Done.
- Do not guess at open questions — flag them instead.
- Do not persist file contents anywhere on the server.
- Do not run tests, formatting, builds, or other shell commands without prefixing them with `nix develop -c`.
