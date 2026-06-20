# Decision Record: Relay Authentication and Limits

- **Status**: Approved
- **Date**: 2026-06-20
- **Authors**: Antigravity (AI Agent)

---

## 1. Context & Problem Statement
When direct peer-to-peer (P2P) file transfer fails (e.g. due to symmetric NAT on both ends), the system falls back to a Go WebSocket-based data relay (SPEC §4.3). Since this relay exposes the server's bandwidth and computing resources, it must require authentication approved in advance by the backend before any file bytes are transmitted (SPEC §3.1, §4.3). We need to select an authentication mechanism (§11.1) and define concrete limits for the relay (§11.2).

---

## 2. Decision
We select a **Host-initiated, Backend-approved Token model** for relay authentication, coupled with strict resource caps.

### Authentication Flow (Step-by-Step)
1. **Fallback Trigger**: If direct P2P fails (detected via `RTCPeerConnection` ending in a `failed` state), the Host sends a `relay-request` message to the server via the active signaling WebSocket.
2. **Backend Validation**: The Go server receives the `relay-request` and validates:
   - The sender is the registered Host of a valid room.
   - The target Guest is registered in the same room.
   - The server is below its maximum concurrent active relay sessions cap (e.g., 5 sessions).
3. **Approval & Token Generation**: If validated, the server generates a cryptographically secure, short-lived `RelayToken` (valid for 30 seconds). It sends a `relay-approved` event containing the token to both Host and Guest.
4. **Relay Connection**: Host and Guest both connect to a new dedicated WebSocket route `/relay` using the token as a query parameter (e.g., `wss://<tunnel-hostname>/relay?token=<token>`).
5. **Bridge & Stream**: The server validates the token on `/relay` upgrade. Once both connections are active, the server bridges the two sockets. The Host streams the file chunks, which the server forwards directly to the Guest without persistence.

### Relay Limits
To prevent server exhaustion, the Go server will enforce the following limits:
- **Max Concurrent Relay Sessions**: `5` concurrent sessions globally.
- **Max File Size**: `50 MB` per file transferred via relay (direct P2P remains unlimited).
- **Bandwidth throttling**: Max `1 MB/s` transfer speed per relay connection.
- **Max Session Duration**: `10 minutes` timeout per session.

---

## 3. Rationale & Trade-offs
- **Why this model?** It leverages the existing trust established when joining the room (possessing the 3-word code), avoids adding user accounts/login, and prevents unauthorized clients from connecting directly to `/relay` since the backend must approve the session in advance.
- **Why these limits?** Exposing a server on a developer machine requires tight bounds. A 50MB file size limit and 1MB/s speed limit allow documents/images to be shared via relay while protecting the developer's network and preventing server out-of-memory crashes.
