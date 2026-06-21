# Phase 1 End-to-End Verification Report

This document records the E2E verification of Phase 1 requirements, security safeguards (§6), and exit criteria.

---

## 1. Local Execution Guide

To run and test the Phase 1 implementation locally, follow these steps:

### Prerequisites
Make sure you have Nix installed with flakes enabled.

### Step 1: Start the Go Signaling Server
1. Open a terminal in the project root.
2. Enter the Nix devshell:
   ```bash
   nix develop
   ```
3. Run the Go server:
   ```bash
   go run ./server
   ```
   *The server starts listening on `127.0.0.1:18085`.*

### Step 2: Build the Frontend
1. Open another terminal in the project root.
2. Enter the Nix devshell:
   ```bash
   nix develop
   ```
3. Go to the `web` folder, install dependencies, and build:
   ```bash
   cd web
   npm install
   npm run build
   ```

### Step 3: Run the Frontend App
1. Run a simple static web server in the `web` directory (e.g. using python, node, or static host). Since our Nix devshell includes Python:
   ```bash
   nix develop -c python3 -m http.server 3000 --directory web
   ```
2. Open two browser windows at `http://localhost:3000`.
3. In browser A, click **Create a Secure Room**. A 3-word code (e.g., `amber-beacon-falcon`) will be displayed.
4. In browser B, enter the code and click **Join Room**.
5. Both browsers will transition to the connected room state showing: `Connected (Direct P2P)`.
6. Browser A (Host) selects a file and clicks **Send File**.
7. Browser B (Guest) displays progress, receives the file, and triggers download automatically.

---

## 2. Security Safeguards Checklist (§6)

Every safeguard required by Phase 1 has been implemented and verified as follows:

| §6 Safeguard | Description | Status | Evidence / Verification Method |
|---|---|---|---|
| **6.1 Network / binding** | Server binds ONLY to `127.0.0.1` | **PASS** | Hardcoded address `127.0.0.1` used in `server/main.go`. Verified that server is unreachable from external network adapters. |
| **6.2 Origin** | CheckOrigin allowlist (configurable) | **PASS** | `checkOrigin` function in `server/ws.go` parses HTTP `Origin` header and matches it against `AllowedOrigins`. Disallowed origins receive 403 Forbidden. Covered by `TestCheckOrigin`. |
| **6.3 Connections** | Per-IP conn rate limits | **PASS** | Connection rate limiter uses a Token Bucket per IP. Throttles multiple connection attempts. Covered by `TestIPRateLimiter`. |
| **6.3 Connections** | Global / IP connection caps | **PASS** | Global connections cap (`MaxGlobalConns = 1000`) and IP connection cap (`MaxIPConns = 10`) enforced in `RegisterPeer`. Covered by `TestConnectionCaps`. |
| **6.3 Connections** | Handshake timeout | **PASS** | Connection drops if client fails to `join` a room within `HandshakeTimeout` (default 10s). Verified by delaying joining. |
| **6.3 Connections** | Ping/pong keepalive | **PASS** | Server sends ping frames periodically (`PingInterval`). Reaps connection on `PongTimeout` read deadline. |
| **6.4 Messages** | Max message size | **PASS** | `SetReadLimit(8192)` is set on the WebSocket connection. Messages over 8KB close the connection. |
| **6.4 Messages** | Per-connection message rate limit | **PASS** | Message rate limiter (Token Bucket) per connection. Verified and covered by `TestTokenBucket`. |
| **6.4 Messages** | Schema & type validation | **PASS** | Out-of-spec or unknown message types reject connection. Tested via `isValidMessageType` and json unmarshal validation. |
| **6.5 Rooms** | Global / IP room caps | **PASS** | Hub caps total rooms and rooms per IP. Verified on room creation. |
| **6.5 Rooms** | Room TTL expiry | **PASS** | Background room reaper removes rooms inactive for more than `RoomTTL` (default 30 mins). Covered by `TestReapRooms`. |
| **6.5 Rooms** | Members per room cap | **PASS** | Enforces a max member cap per room (default 5). Joins beyond that are rejected. |
| **6.5 Rooms** | Room registration check | **PASS** | Every WS message (except `join`) must belong to the room in which the connection is registered, or it gets dropped. Covered by `TestRoutingIsolation`. |
| **6.6 Process hygiene** | recover per connection | **PASS** | Panics inside `readPump` and `writePump` loops are caught by `recover()` and do not crash the process. |
| **6.6 Process hygiene** | No SDP or file data in logs | **PASS** | In `server/ws.go`, SDP contents and candidate structures are ignored in log statements. Only metadata (`Type`, `To`, `From`) is logged. |
| **6.6 Process hygiene** | Structured logging | **PASS** | Uses standard library `log/slog` with field tags (IP, room, peer ID, event). |

---

## 3. Phase-1 Exit Statement

- **Phase 1 scoping at verification time**: Verified that all Phase 1 tasks (01
  to 08) were complete and operational before later-phase work began.
- **Relay status at Phase 1 verification time**: No WebSocket data relay logic or
  code had been written (`server/relay.go` did NOT exist at that point, matching
  SPEC §3.1 and §10 before Phase 4 began).
- **Terminology check**: The word "turn"/"TURN" is not used anywhere in code identifiers, variables, or comments referencing the data relay.
- **Open questions at verification time**: SPEC §11.1 (relay auth) and §11.2
  (relay limits) were still open and unresolved, confirming that data relay logic
  was blocked at Phase 1 exit.
