# Task 11 — flake.nix packaging

- **Phase:** 3
- **Status:** Done
- **Depends on:** 08
- **SPEC references:** §8, §2, §10 (Phase 3)

## Objective

Promote the minimal task-01 `devShell` to the full `flake.nix`: reproducible
build of the Go server and the static frontend bundle, plus the cloudflared
toolchain (SPEC §8).

## In scope

- `packages.server` — static Go binary via `buildGoModule` (SPEC §8).
- `packages.frontend` — static bundle produced by esbuild (SPEC §8).
- Keep/extend `devShell` (Go, Node/esbuild, cloudflared).

## Requirements

1. **`packages.server`:** `buildGoModule` producing a static binary. Pin Go
   version via the flake. `nix build .#server` outputs a runnable binary that
   binds `127.0.0.1` (SPEC §6.1) and serves signaling.
2. **`packages.frontend`:** build `web/` with esbuild into a static output
   suitable for upload to a free static host (SPEC §2, §8). `nix build .#frontend`
   yields the deployable `dist/`. The signaling URL MUST remain configurable at
   build/deploy time (SPEC §8) — expose how to inject the tunnel `wss://` URL
   (e.g. esbuild `define` / env) in the package.
3. **`devShell`:** still provides Go, Node/esbuild, cloudflared.
4. Reproducibility (SPEC §1.1): builds MUST be reproducible via the flake; no
   network fetches outside Nix's model (vendor/hashes pinned).

## Out of scope

- NixOS module — SPEC §8 marks it optional/future; do not build it now unless
  promoted.
- The actual deployment/tunnel run → task 12.
- Cloudflare WAF / edge rules → SPEC §7 deferred.

## Acceptance criteria

- `nix build .#server` and `nix build .#frontend` both succeed and produce the
  expected artifacts.
- The server binary runs and serves Phase-1 signaling bound to localhost.
- The frontend artifact is a static bundle with an injectable signaling URL (no
  hardcoded localhost).
- `nix develop` still works with the full toolchain.

## Notes

- Two origins (SPEC §3): the frontend artifact is deployed to a static host; the
  server runs locally. The flake builds both but they deploy separately (task 12).
