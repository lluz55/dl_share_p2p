# Task 12 — Deployment: tunnel + static host

- **Phase:** 3
- **Status:** Done
- **Depends on:** 11
- **SPEC references:** §2, §3, §6.1–§6.2, §8, §10 (Phase 3)

## Objective

Document and script the deployment model: frontend on a free static host, Go
server running locally bound to `127.0.0.1`, exposed only via Cloudflare Tunnel
over WSS (SPEC §8). No new app features — deployment wiring and docs.

## In scope

- Cloudflared configuration to expose **only** the Go server's local port over
  WSS (SPEC §8). Nothing else on the machine is exposed.
- Frontend deployment steps to a free static host on its own HTTPS domain
  (Cloudflare Pages / Netlify / GitHub Pages — SPEC §2).
- Wiring the frontend's signaling URL to the tunnel `wss://` hostname
  (configurable, SPEC §8) and the server's Origin allowlist to the frontend's
  domain (SPEC §6.2).

## Requirements

1. **Tunnel (SPEC §8, §3):** cloudflared config that maps the tunnel hostname to
   `http://127.0.0.1:<port>` (Tunnel provides TLS; clients use `wss://`). Tunnel
   carries HTTP/WS only. Cloudflare Tunnel is the ONLY Cloudflare service used and
   the ONLY public entry point (SPEC §2, §3). Do not add other Cloudflare
   services.
2. **WSS enforced (SPEC §8):** because the page is HTTPS, signaling MUST be
   `wss://`; plain `ws://` MUST NOT be used. Verify the deployed frontend uses the
   tunnel `wss://` URL via `config.ts`.
3. **Origin allowlist (SPEC §6.2):** set the server's `CheckOrigin` allowlist to
   the deployed frontend domain. Cross-origin requests from anywhere else are
   rejected.
4. **Server hygiene (SPEC §6.1, §6.6):** server bound to `127.0.0.1`, run as an
   unprivileged user. Provide a documented run command/service (a NixOS module is
   optional/future per SPEC §8 — a plain documented invocation is enough).
5. **Smoke test:** end-to-end transfer using the public frontend domain + tunnel
   WSS, between two real devices, ideally one behind NAT (validates STUN path,
   SPEC §1.1).

## Out of scope

- Cloudflare edge WAF / rate-limit rules → SPEC §7 deferred.
- Relay → task 14.
- NixOS module (optional/future, SPEC §8) unless explicitly promoted.

## Acceptance criteria

- Documented, repeatable deploy: build artifacts (task 11) → static host +
  local server + cloudflared.
- Public frontend over HTTPS connects to the server over `wss://` through the
  tunnel; no `ws://`, no localhost in the deployed config.
- Requests from non-allowlisted origins are rejected (SPEC §6.2).
- Real cross-device transfer succeeds, including a NAT-traversal case via STUN.
- Nothing on the machine except the server port is exposed.

## Notes

- This is the first real public exposure: re-confirm the task-08 §6 checklist
  still holds against the deployed configuration before sharing the URL.
