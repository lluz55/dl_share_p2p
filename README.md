# P2P Share

Browser-to-browser file sharing over WebRTC, with a self-hosted Go signaling server and Cloudflare Tunnel for NAT traversal.

This project implements a secure, zero-knowledge, direct peer-to-peer file transfer application. File contents are sent directly from browser to browser via WebRTC Data Channels and are never stored on or read by the server.

*   **Specification:** See [SPEC.md](file:///home/lluz/dev/dl_share_me/SPEC.md) for full protocol and architectural details.
*   **Developer Guide:** See [AGENTS.md](file:///home/lluz/dev/dl_share_me/AGENTS.md) for instructions, constraints, and development guidelines.
*   **Task Index:** See [docs/tasks/00-INDEX.md](file:///home/lluz/dev/dl_share_me/docs/tasks/00-INDEX.md) for the implementation roadmap.

---

## 🚀 Quick Start (Running with Nix)

If you have Nix installed with flakes enabled, you can run and build the entire stack directly without installing any local dependencies.

### 1. Run the Signaling Server (Go)

Run the server with the default port (`8080`):
```sh
nix run .#server
# or simply:
nix run .
```

To run on a custom port or with custom allowed CORS origins:
```sh
# Using flags:
nix run .#server -- -port 9000 -origins "https://yourfrontend.pages.dev"

# Or using environment variables (Bash/Zsh):
PORT=9000 ALLOWED_ORIGINS=https://yourfrontend.pages.dev nix run .#server

# Or using environment variables (Fish shell):
env PORT=9000 ALLOWED_ORIGINS=https://yourfrontend.pages.dev nix run .#server
```

### 2. Build the Frontend Locally

This compiles the TypeScript files and outputs the bundle inside `web/dist/bundle.js`:
```sh
nix run .#frontend-build
```

*   **Inject a custom signaling URL at build time:**
    ```sh
    SIGNALING_URL=wss://your-tunnel.trycloudflare.com/ws nix run .#frontend-build
    ```
*   **Watch for changes (development mode):**
    ```sh
    nix run .#frontend-build -- --watch
    ```

### 3. Serve the Frontend Locally

Serve the static web assets from the Nix store. It automatically handles launching a local web server (using `http-server`):
```sh
nix run .#frontend-serve -- -p 3000
```

*   **Inject a custom signaling URL dynamically at runtime (no rebuild needed):**
    ```sh
    # Bash/Zsh:
    SIGNALING_URL=ws://127.0.0.1:8080/ws nix run .#frontend-serve -- -p 3000

    # Fish shell:
    env SIGNALING_URL=ws://127.0.0.1:8080/ws nix run .#frontend-serve -- -p 3000
    ```

---

## 🛠️ Manual Development Setup

If you want to manually run, test, or modify the code inside the development shell:

### 1. Enter the Dev Shell
```sh
nix develop
```
*This shell puts `go`, `node`, `cloudflared`, and `tsc` in your active PATH.*

### 2. Run Go Tests
```sh
cd server
go test -v -race ./...
```

### 3. Run Backend (Development)
```sh
cd server
go run . -port 8080
```

### 4. Build Frontend (Development)
```sh
cd web
npm install
npm run build
# Or run with watcher:
npm run watch
```

---

## ☸️ NixOS Deployment & SOPS Secrets

This project includes a production-ready NixOS module configured in [nixos-module.nix](file:///home/lluz/dev/dl_share_me/nixos-module.nix) to deploy the backend and the Cloudflare Tunnel securely with `sops-nix` secrets integration.

### Example NixOS Configuration:
```nix
{ inputs, config, ... }: {
  imports = [
    inputs.p2pshare.nixosModules.default
  ];

  # Decrypt the cloudflared tunnel token using sops-nix
  sops.secrets.cloudflare-tunnel-token = {
    sopsFile = ./secrets/secrets.yaml;
  };

  services.p2pshare = {
    enable = true;
    port = 9000;
    allowedOrigins = [ "https://p2pshare.pages.dev" ];

    tunnel = {
      enable = true;
      tokenFile = config.sops.secrets.cloudflare-tunnel-token.path;
    };
  };
}
```

---

## 📖 How to Test in Practice

1.  Start the Go signaling server on your local machine (`nix run .#server`).
2.  Start serving the web application (`nix run .#frontend-serve -- -p 3000`).
3.  Open `http://localhost:3000` in browser window **A** (Host/Sender).
4.  Click **Create Room**. A unique 3-word room code (e.g. `apple-banana-cherry`) and a shareable join link will be generated.
5.  Open browser window **B** (Guest/Receiver) in private/incognito mode (or on another device), and navigate to the join link (or enter the room code manually).
6.  Once connected, select a file on the **Host** browser and click **Send File**.
7.  Watch the real-time progress bar. Once completed, the **Guest** browser will download the file automatically.

---

## 📡 WebRTC Signaling & Connection Resilience

*   **Direct P2P**: A WebRTC `RTCPeerConnection` is established directly between the browsers over UDP using public STUN servers. The signaling server is only used to orchestrate the initial handshake (Offer, Answer, ICE candidates).
*   **Signaling Drops**: If the signaling WebSocket connection drops during a transfer, **the file transfer continues uninterrupted** because the peer-to-peer data channel is independent of signaling.
*   **Auto-Reconnection**: The client implements automatic background reconnection with exponential backoff and automatically rejoins the active room, preserving connection states without reloading the page.

---

## 📊 Implementation Status

Currently at **Task 14 — Go data relay (fallback)**.
*   ✅ **Phase 1 (Done):** Signaling server core, token-bucket limits, connection caps, and basic WebRTC 1-to-1 transfer.
*   ✅ **Phase 2 (Done):** 1-to-many fan-out transfer, connection stats, auto-reconnection, and query param auto-join.
*   ✅ **Phase 3 (Done):** Nix packaging ([flake.nix](file:///home/lluz/dev/dl_share_me/flake.nix)), deployment documentation, and NixOS service module.
*   ✅ **Phase 4 - Task 13 (Done):** Signaling relay authentication design decisions.
*   ⚠️ **Phase 4 - Task 14 (Blocked):** Fallback Go data relay logic (Blocked until SPEC §11.1/§11.2 are officially updated).
