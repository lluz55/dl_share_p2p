# P2P Share

Browser-to-browser file sharing over WebRTC, with a self-hosted Go signaling server and Cloudflare Tunnel for NAT traversal.

See [SPEC.md](SPEC.md) for the full specification and [AGENTS.md](AGENTS.md) for the implementation task list.

---

## Quick start

### 1. Enter the dev shell

```sh
nix develop
```

This provides `go`, `node`, `cloudflared`, and `tsc`.

### 2. Build the server

```sh
cd server
go build ./...
```

Run the stub:

```sh
go run .
```

### 3. Install frontend dependencies

```sh
cd web
npm install
```

### 4. Build the frontend

```sh
npm run build       # one-shot
npm run watch       # rebuild on change
```

Output lands in `web/dist/bundle.js`.

### 5. Override the signaling URL (for deployment)

**Option A — build-time:**

```sh
SIGNALING_URL=wss://your-tunnel.trycloudflare.com/ws npm run build
```

**Option B — runtime (no rebuild needed):**

Add before the `<script>` tag in `web/index.html`:

```html
<script>window.__SIGNALING_URL__ = "wss://your-tunnel.trycloudflare.com/ws";</script>
```

The default (`ws://127.0.0.1:8080/ws`) is a dev-only fallback and MUST NOT be used in production.

---

## Project layout

```
server/         Go signaling server
web/
  src/          TypeScript source
  dist/         Compiled output (git-ignored)
  index.html    Frontend entry point
  build.ts      esbuild build script
flake.nix       Nix dev shell
SPEC.md         Single source of truth
AGENTS.md       Task list for LLM agents
docs/tasks/     Per-task work files
```

---

## Signaling Disconnection Mid-Transfer Behavior

A WebRTC `RTCPeerConnection` operates peer-to-peer (directly between browsers over UDP) once established via the signaling handshake. As a result:

1. **Active Transfers Continue**: If the signaling WebSocket connection drops *while* a file transfer is actively in progress over the WebRTC DataChannel, the transfer **continues uninterrupted** to completion.
2. **Auto-Reconnection**: The signaling client automatically reconnects in the background using an exponential backoff.
3. **Graceful Re-establishment**: Upon successful reconnection, the client automatically sends a `join` message with its last active room code to re-establish presence in the signaling room. This ensures that the room membership is preserved without reloading the page or interrupting ongoing peer data channels.

---

## Implementation status

Currently at **Task 10 — Phase 2: UX, Reconnection, and Code Flow**.
Phase 1 (scaffolding, signaling backend, basic safeguards, WebRTC direct connection, and file transfer) and Phase 2 (1-to-many fan-out transfer, progress stats, auto-reconnection, and query param auto-join) are fully implemented and verified.
See [docs/tasks/00-INDEX.md](docs/tasks/00-INDEX.md) for the detailed task list.
