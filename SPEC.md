# P2P File Share — Project Specification

> **Status:** Living specification. Single source of truth for the project.
> **Audience:** LLM agents implementing this project via spec-driven development.
> **Last updated:** 2026-06-20

---

## 0. How to use this document

This is the authoritative spec. When implementing, an LLM agent MUST:

1. Treat every `MUST` / `MUST NOT` as a hard requirement. Treat `SHOULD` as a strong default, deviation requires a noted reason.
2. Not introduce technologies, services, or transport paths not listed here. If a requirement seems to need one, STOP and flag it as an open question instead of inventing it.
3. Keep this document in sync: when a decision changes, update the relevant section and the changelog. Code and spec must never disagree.
4. Implement only what is in scope for the current phase (see §10). Deferred items are explicitly out of scope until promoted.
5. When something is ambiguous or missing, consult §11 (Open Questions) — do not guess. If it is not even listed there, raise it before writing code.

Keywords MUST, MUST NOT, SHOULD, SHOULD NOT, MAY follow RFC 2119 sense.

---

## 1. Project summary

A web application for sharing files peer-to-peer between devices, including devices behind NAT. Peers find each other and exchange WebRTC signaling primarily through a **third-party serverless matchmaking service** (no intermediary of ours). A self-hosted Go server is used only as a fallback: it provides signaling when the third-party service is unavailable and acts as an authenticated data relay when direct peer-to-peer is impossible. The project is developed by LLM agents under spec-driven development.

### 1.1 Goals

- Share files directly between browsers (P2P), end-to-end encrypted by WebRTC's transport.
- Pair peers without our own server when possible, via a third-party serverless signaling service (Trystero over Nostr — see §2).
- Work across NAT using public STUN; fall back to a server-side relay only when direct P2P is impossible.
- Minimal frontend bloat.
- Reproducible build and deploy via Nix.
- Run the server locally, exposed to the internet through Cloudflare Tunnel.

### 1.2 Non-goals

- No user accounts or login.
- No third-party TURN server.
- No TURN-protocol relay (the only relay is the Go WebSocket data relay defined in §4.3).
- No persistence of files on the server.

> Clarification: the third-party serverless service (§2) is used **only for signaling /
> matchmaking** (exchanging SDP/ICE to pair peers). It is NOT a TURN server and NEVER
> carries file bytes. File data flows either directly peer-to-peer or through the Go data
> relay (§4.3) — never through the third-party service.

---

## 2. Technology stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | Go | Fallback signaling + authenticated data relay. |
| Frontend | TypeScript (vanilla) + esbuild | No framework. Minimal bundle. |
| Primary signaling | Trystero (Nostr strategy) | Serverless WebRTC matchmaking over public Nostr relays. Zero-config, no account. Signaling only — never carries file data. |
| Transport | WebRTC DataChannel | Primary path for file transfer. |
| NAT discovery | Public STUN | e.g. `stun:stun.l.google.com:19302`. No third-party TURN. |
| IaC / build | flake.nix | devShell + packages. |
| Public exposure | Cloudflare Tunnel | The ONLY Cloudflare service used. Tunnels HTTP/WS only. |
| Frontend hosting | Free static host | Cloudflare Pages / Netlify / GitHub Pages. |
| Development | LLM agents | Spec-driven. |

The server MUST NOT depend on any Cloudflare service other than the Tunnel.

---

## 3. Architecture overview

Two origins plus a third-party signaling network. The static frontend is served from a
free static host on its own HTTPS domain. Peers primarily pair through the third-party
serverless signaling service (Trystero/Nostr). The Go server runs on the developer's
machine, bound to localhost, reached only through Cloudflare Tunnel over WSS, and is used
only as a fallback (signaling when the third party is down, plus the data relay).

```
┌────────────────────┐      ┌───────────────────────┐
│  static frontend   │      │  third-party signaling │
│  (Pages/Netlify)   │◀────▶│  Trystero / Nostr      │  primary: pair peers (SDP/ICE)
│  https://app.example│     │  (public relays)       │
└─────────┬──────────┘      └───────────────────────┘
          │                  ┌──────────────────────────┐
          │  WSS  /ws,/relay │  local machine           │
          └─────────────────▶│  Go server  127.0.0.1    │  fallback only:
                cloudflared   │   - signaling (fallback) │   - signaling if 3rd party down
                              │   - data relay (NAT)     │   - relay if direct P2P fails
                              └──────────────────────────┘
```

### 3.1 Transport chain (authoritative)

```
1. Signaling via third-party (Trystero/Nostr) ... PRIMARY. Serverless, no intermediary of ours.
      ├─ peers pair within the handshake window
      │     ├─ direct P2P OK (WebRTC + public STUN) → transfer peer-to-peer.
      │     │                                          NO auth. Nobody but the peers sees data.
      │     └─ direct P2P fails (NAT) → data relay via Go (see step 3)
      └─ third-party unavailable (no peer paired in time / error)
                                       → fall back to signaling via Go (WebSocket /ws)
                                          then attempt direct P2P, else data relay (step 3)

2. Direct P2P (WebRTC + public STUN): preferred path for file transfer either way.

3. Data relay via Go (WebSocket /relay): fallback only.
      ├─ requires prior authentication approved by the backend
      └─ only then is file transfer permitted
```

Rules:
- The primary signaling path is the third-party serverless service. The Go signaling path is a
  fallback used only when the third party fails to pair peers in time or errors.
- Both signaling transports use the **same room code** (§4.1) as the rendezvous key, so a peer
  pair can move from the third-party path to the Go path (for fallback signaling or for the data
  relay) without any out-of-band coordination.
- The third-party service is signaling only and MUST NOT carry file bytes.
- There is NO third-party TURN in the chain. If direct P2P fails, the only data fallback is the Go data relay.
- Direct P2P file transfer MUST NOT require any authentication; no server sees that data.
- The Go data relay MUST NOT transmit any file bytes until backend-approved authentication has completed.

> Terminology note: the user has informally called the Go data relay "TURN".
> It is NOT the TURN protocol. It is a WebSocket data relay implemented in Go
> (§4.3). The word "TURN" MUST NOT appear in code or identifiers for it.

---

## 4. Functional requirements

### 4.1 Peer discovery / rooms

- A room is identified by a code consisting of **three random words** (e.g. `tiger-harbor-velvet`). The code is the access credential to the room.
- The code is **generated on the client** by the host (so it can be shown instantly and used as the rendezvous key for both signaling transports — §3.1). The word list and generation MUST match the server's (`server/room.go`) so a host-chosen code is valid on the Go fallback. When a host falls back to or relays through the Go server, the server MUST accept the host's existing code (creating the room with that code; rejecting with `code-taken` if it already exists).
- The peer that creates the room is the **host**. A peer that joins with the code is a **guest**.
- The system MUST support both **1↔1** (host + one guest) and **1↔n** (host + multiple guests) using the same room mechanism. For 1↔n the host opens a separate `RTCPeerConnection` per guest.
- A room SHOULD close to new joins once the expected number of participants is reached (see §6 safeguards).
- Word list source/size and resulting key space are an open question (§11). The list MUST be large enough that brute-forcing a code is impractical given join rate limits.

### 4.2 Signaling

- Signaling has two transports over the **same room code**:
  - **Primary — third-party serverless (Trystero/Nostr):** peers join a room named by the code and exchange WebRTC SDP/ICE through public Nostr relays. No intermediary of ours.
  - **Fallback — Go server (`/ws`):** the Go server exchanges WebRTC `offer` / `answer` / `ice` messages between host and guest(s) within a room. Used only when the third party fails to pair peers in time or errors (§3.1).
- The client attempts the primary transport first; if no peer pairs within a short window (default ~8s) or the transport errors, it falls back to the Go transport using the same code.
- Signaling requires **no user authentication**; possession of the room code is the only requirement to participate.
- The ICE server configuration MUST be a swappable list (currently public STUN only) so a relay/TURN entry could be added later without code changes elsewhere. The same ICE list MUST be passed to the third-party signaling layer's WebRTC config.

### 4.3 File transfer

**Direct P2P (preferred):**
- When WebRTC establishes a direct connection (via STUN), files transfer peer-to-peer over the DataChannel.
- No authentication. The server does not observe file data.
- Files are chunked with backpressure handling (monitor `bufferedAmount`).
- Receiver reassembles and triggers download. Progress shown on both sides.

**Go data relay (fallback only):**
- Used only when direct P2P cannot be established.
- The relay requires Host-initiated, Backend-approved authentication using short-lived tokens:
  1. The Host requests a relay session via the signaling socket (`relay-request`).
  2. The backend validates the room/membership and checks that the global active relay session cap is not exceeded.
  3. If approved, the backend generates a secure 30-second `RelayToken` and broadcasts a `relay-approved` event containing the token to both Host and Guest.
  4. Host and Guest connect to a dedicated `/relay?token=<token>` endpoint. The server validates the token and bridges the two connections.
- The server stream-relays file bytes directly between the connections; it MUST NOT persist file contents to disk or storage at any time.
- The Go server enforces these strict resource caps:
  - Max concurrent active relay sessions globally: `5`.
  - Max file size for relay transfers: `50 MB`.
  - Throttled transfer bandwidth: max `1 MB/s` per relay connection.
  - Max session timeout: `10 minutes`.
- This is the only fallback; there is no third-party TURN server.

---

## 5. Component / file layout (planned)

```
p2pshare/
├── flake.nix
├── SPEC.md                 # this document — source of truth
├── server/                 # Go
│   ├── main.go
│   ├── hub.go              # rooms, peer registry
│   ├── room.go             # 3-word code, TTL, lifecycle
│   ├── ws.go               # WS upgrade, CheckOrigin, message routing
│   └── relay.go            # data relay + backend-approved authentication
├── web/                    # TypeScript frontend (built, deployed to static host)
│   ├── src/
│   │   ├── main.ts         # UI, connection state
│   │   ├── signaling.ts    # WS client
│   │   ├── peer.ts         # RTCPeerConnection, ICE
│   │   ├── transfer.ts     # chunking, progress, 1↔n
│   │   └── config.ts       # tunnel URL (wss://), configurable, not hardcoded
│   ├── index.html
│   └── build.ts            # esbuild build script
└── README.md
```

---

## 6. Safeguards — Phase 1 (essential, in scope now)

The server is directly reachable from the internet via the Tunnel (NAT no longer
protects it). All of the following are required before any public exposure.

### 6.1 Network / binding
- The Go server MUST bind only to `127.0.0.1`. It MUST NOT be reachable on LAN/WAN except through Cloudflare Tunnel.
- Cloudflare Tunnel is the only public entry point.

### 6.2 Origin
- `CheckOrigin` MUST be strict: accept only the frontend's domain (allowlist). Reject all other origins.
- Plain HTTP requests on signaling/WS routes MUST be rejected.

### 6.3 Connections
- Rate-limit new connections per IP (token bucket). Real client IP read from `CF-Connecting-IP`.
- Cap simultaneous connections per IP and globally.
- Handshake timeout: a connection that does not join a room within N seconds MUST be dropped (anti-slowloris).
- Read deadline + ping/pong: dead connections MUST be reaped; peers that miss pong are dropped.

### 6.4 Messages
- Maximum message size enforced (`SetReadLimit`). SDP/ICE are small; anything beyond a few KB is abuse.
- Rate-limit messages per connection (anti-flood).
- Strict schema validation: only known types (`offer`, `answer`, `ice`, `join`), well-formed JSON. Anything else → reject and drop the connection.

### 6.5 Rooms
- Cap total rooms and rooms created per IP.
- Room TTL: expire after X minutes of inactivity.
- Cap members per room.
- Close room to new joins once the expected participant count is reached.
- A message that does not belong to a valid room the connection is registered in → reject and drop the connection.

### 6.6 Process hygiene
- Run as an unprivileged user (no root).
- `recover` per connection: a bad connection MUST NOT crash the process.
- No sensitive data in logs (never log SDP contents).
- Structured logging with IP, room, event type.

---

## 7. Safeguards — deferred (out of scope until promoted)

- Cloudflare edge WAF / rate-limiting rules.
- Host/guest token in signaling (anti-hijack).
- Manual host approval of each guest.
- Larger code alphabet beyond the 3-word scheme (only if needed).
- Relay-specific limits: bandwidth, max file size, concurrent relay sessions.

---

## 8. Build & deployment (flake.nix)

- `devShell`: Go, Node/esbuild, cloudflared.
- `packages.server`: static Go binary via `buildGoModule`.
- `packages.frontend`: static bundle via esbuild.
- NixOS module: optional, future phase.

Deployment model:
- Frontend is built and published to a free static host (its own HTTPS domain).
- Go server runs locally bound to `127.0.0.1`.
- `cloudflared` exposes only the Go server's port over WSS. Nothing else on the machine is exposed.
- Because the page is HTTPS, the signaling connection MUST be `wss://` (Tunnel provides TLS). Plain `ws://` MUST NOT be used.
- The frontend's signaling URL (tunnel `wss://` address) MUST be configurable, not hardcoded to localhost.

---

## 9. Cross-cutting constraints

- The server MUST NOT persist or store file contents at any time.
- The server MUST NOT have a generic relay endpoint: its only actions are signaling within a room and, post-authentication, the data relay within a room.
- Every WS message MUST belong to a valid room in which the connection is registered; otherwise the connection is dropped.
- No secrets, SDP contents, or file data in logs.

---

## 10. Phasing

**Phase 1 — Core transport + essential safeguards (current scope)**
- Go signaling over WS, room = 3 random words, strict §6 safeguards, localhost bind.
- Direct P2P 1↔1 via public STUN. Prove end-to-end transfer.
- No relay yet (its auth mechanism is unresolved — §11).

**Phase 2**
- 1↔n transfer, progress bars, reconnection, code UX.

**Phase 3**
- Full flake.nix (devShell + packages + cloudflared service). Static frontend build.

**Phase 4 (conditional)**
- Go data relay fallback, once §11.1 (relay auth) is resolved, including relay-specific limits.

**Phase 5 — Serverless signaling + fallback**
- Third-party serverless signaling (Trystero/Nostr) as the primary path; the room code is
  generated client-side and shared across transports.
- Go signaling becomes a fallback (used when the third party fails to pair peers in time).
- Go server accepts a host-chosen room code (§4.1).
- Direct P2P over the third-party path uses the Trystero native binary transfer; the Go path
  keeps the existing chunked DataChannel transfer (§4.3) and the Go data relay for NAT.
- 5a: full 1↔1 (third-party primary, Go signaling fallback, Go relay on NAT). 1↔n direct P2P
  over the third-party path works natively. 5b (later): per-guest relay escalation for 1↔n.

A phase's work MUST NOT begin pulling in deferred items from later phases without promoting them in this document first.

---

## 11. Open questions (resolve before the dependent code is written)

1. **Word list.** (RESOLVED 2026-06-20) Resolved to use 160 Portuguese ASCII-only lowercase words (entropy: 160^3 = 4,096,000 combinations). Join rate limiting is enforced via IP connection caps and per-connection message limits.

---

## 12. Glossary

- **Host** — peer that creates a room and holds the code. The host generates the code client-side.
- **Guest** — peer that joins a room using the code.
- **Signaling** — exchange of WebRTC offer/answer/ICE to pair peers. Primary transport is the
  third-party serverless service; the Go server is the fallback transport.
- **Trystero** — third-party serverless WebRTC matchmaking library (Nostr strategy) used as the
  primary signaling transport. Signaling only; never carries file bytes.
- **Direct P2P** — WebRTC DataChannel connection established via STUN; no server sees data; no auth.
- **Data relay** — Go WebSocket relay used only when direct P2P fails; requires backend-approved auth. Informally (and incorrectly) called "TURN" by stakeholders; it is NOT the TURN protocol.
- **Tunnel** — Cloudflare Tunnel; the only public entry point; tunnels HTTP/WS only.

---

## 13. Changelog

- **2026-06-21** — Phase 5: third-party serverless signaling (Trystero/Nostr) becomes the primary signaling transport; Go signaling demoted to fallback. Room code now generated client-side and shared across transports; Go server accepts a host-chosen code. Updated §1, §2, §3, §3.1, §4.1, §4.2, §10, §12.
- **2026-06-20** — Resolved word list source and size (§11.3) to use 160 Portuguese ASCII-only lowercase words.
- **2026-06-20** — Resolved relay authentication mechanism (§11.1) and limits (§11.2); updated §4.3.
- **2026-06-20** — Initial specification consolidated from planning sessions.
