# P2P Share — Deployment & Exposure Guide

This document details the production deployment model for the P2P File Share application.

The system is split into two separate origins (SPEC §3):
1. **Frontend**: Built as static HTML/JS and deployed to a free static hosting service (Cloudflare Pages, Netlify, GitHub Pages).
2. **Backend**: Built as a Go binary, running locally bound to `127.0.0.1`, and exposed securely using a Cloudflare Tunnel over `wss://` (WebSocket Secure).

---

## 1. Frontend Build & Deploy

### Step 1: Build the Static Bundle with Production URL
When building the frontend package using the Nix flake, inject your public signaling hostname (e.g. `signal.yourdomain.com`) as the `SIGNALING_URL` environment variable:

```bash
# Build the frontend package via Nix
SIGNALING_URL=wss://signal.yourdomain.com/ws nix build .#frontend
```

Alternatively, you can build manually inside the Node/Nix environment:
```bash
SIGNALING_URL=wss://signal.yourdomain.com/ws npm run build --prefix web
```

This compiles `web/src/main.ts` into a static bundle inside `web/dist/` with the production URL injected, complying with the requirement that no production URL or localhost is hardcoded in the source code.

### Step 2: Upload to Static Hosting
Upload the contents of the generated static directory (`result/` if using Nix build, or `web/` directory including `web/dist/bundle.js` and `web/index.html`) to your hosting provider (e.g., Cloudflare Pages, Netlify, or GitHub Pages).

Take note of your deployed frontend URL (e.g., `https://p2pshare.pages.dev`).

---

## 2. Server Deployment & Hardening

### Step 1: Install the Go Binary
Compile the signaling server binary via the Nix flake:
```bash
nix build .#server
```
This produces a static Go binary inside `./result/bin/p2pshare-server`. Copy this binary to `/usr/local/bin/p2pshare-server` on your server host.

### Step 2: Configure System User (Unprivileged Process)
As mandated by SPEC §6.6, the server MUST NOT run as root. Create a dedicated system user and group:

```bash
sudo groupadd -r p2pshare
sudo useradd -r -g p2pshare -s /sbin/nologin -d /var/lib/p2pshare -m p2pshare
```

### Step 3: Set up Systemd Service
Copy the provided systemd service file template `server/p2pshare-server.service` to `/etc/systemd/system/p2pshare-server.service`:

Make sure to edit the `Environment` parameter to match your deployed frontend domain (e.g. `ALLOWED_ORIGINS=https://p2pshare.pages.dev`). This restricts signaling connections exclusively to requests originating from your frontend.

Start and enable the service:
```bash
sudo systemctl daemon-reload
sudo systemctl start p2pshare-server
sudo systemctl enable p2pshare-server
```

---

## 3. Cloudflare Tunnel Configuration

Cloudflare Tunnel acts as the only ingress path. It handles TLS termination and exposes ONLY the local signaling port over WSS.

### Step 1: Create the Tunnel
Install `cloudflared` (provided in the Nix environment) and authenticate:
```bash
cloudflared tunnel login
cloudflared tunnel create p2pshare-tunnel
```

### Step 2: Configure Routing
Route your public signaling subdomain to the tunnel:
```bash
cloudflared tunnel route dns p2pshare-tunnel signal.yourdomain.com
```

### Step 3: Configure and Run Tunnel Ingress
Use the template in `server/tunnel-config.yaml` to specify the ingress rules:
Copy this file to `/etc/cloudflared/config.yml` (or similar) on your server host, replace the tunnel UUID, and run:

```bash
cloudflared tunnel --config /etc/cloudflared/config.yml run
```

This setup forces all connections over WSS (secured by Cloudflare's TLS edge certificates) and strictly forwards them to the server listening on `127.0.0.1:8080`, keeping all other machine ports closed to the WAN.
