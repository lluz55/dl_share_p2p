# Task 01 — Project scaffold & dev environment

- **Phase:** 1
- **Status:** Done
- **Depends on:** —
- **SPEC references:** §2 (stack), §5 (file layout), §8 (build, partial)

## Objective

Create the empty project skeleton and a minimal development environment so that
later tasks have a place to put code and a reproducible way to build/run it. This
is bootstrap only — no signaling, no WebRTC, no relay logic yet.

## In scope

- Directory layout per SPEC §5, rooted at the repository root (no `p2pshare/`
  wrapper dir; `server/`, `web/`, `flake.nix` sit beside `SPEC.md`).
- Go module init for the server.
- TypeScript + esbuild setup for the frontend, with a build script.
- A **minimal** `flake.nix` `devShell` providing the toolchain.
- A configurable frontend signaling URL (`config.ts`) — NOT hardcoded to
  localhost (SPEC §8).
- `README.md` with build/run instructions for what exists so far.

## Out of scope (do NOT do here)

- `packages.server` / `packages.frontend` / cloudflared service in the flake —
  that is the **full** flake, deferred to task 11 (Phase 3). Only a `devShell`
  here.
- Any signaling, WebRTC, UI, or relay code.

## Steps / requirements

1. Create directories and placeholder files matching SPEC §5:
   ```
   server/   (main.go with a do-nothing or "TODO" stub that compiles)
   web/src/  (config.ts only; other .ts files created by later tasks)
   web/index.html (minimal placeholder)
   web/build.ts   (esbuild build script)
   ```
2. **Go module:** run `go mod init` with a sensible module path (e.g.
   `github.com/<owner>/p2pshare` or a local path). `server/main.go` MUST compile
   and run (it can just log a startup line and exit / serve nothing yet).
3. **Frontend toolchain:** `web/package.json` with `esbuild` and `typescript`
   as devDependencies. `web/tsconfig.json` with `strict: true`. `web/build.ts`
   is an esbuild script that bundles `src/main.ts` → `dist/`. Since `main.ts`
   does not exist yet, the build script MAY target `src/config.ts` as a
   temporary entry, or be written to tolerate a missing entry until task 07;
   document whichever you choose.
4. **`web/src/config.ts`:** export the signaling endpoint as a configurable
   value. It MUST support being set at runtime/build-time (e.g. read from a
   global injected by `index.html`, a build-time env var via esbuild `define`,
   or a `window.__SIGNALING_URL__`). It MUST use `wss://` in production and MUST
   NOT be hardcoded to localhost (SPEC §8). Provide a clear default and a comment
   explaining how to override it for deployment (the Cloudflare Tunnel hostname).
5. **`flake.nix` (minimal):** a `devShell` exposing Go, Node + esbuild, and
   cloudflared (SPEC §8 devShell list). No packages yet. `nix develop` MUST drop
   into a shell where `go`, `node`/`npm`, and `cloudflared` are available.
6. **`README.md`:** how to enter the dev shell, build the frontend, and run the
   server stub.

## Acceptance criteria

- `nix develop` (or documented fallback) provides `go`, `node`, `cloudflared`.
- `cd server && go build ./...` succeeds.
- `cd web && <build command>` produces a bundle without error.
- Repository tree matches SPEC §5 (allowing for files later tasks will add).
- `config.ts` has no hardcoded localhost signaling URL and documents how to
  override the tunnel URL.

## Notes

- Keep dependencies minimal (SPEC §1.1: minimal frontend bloat). Vanilla TS only.
- Do not add a frontend framework, bundler other than esbuild, or any runtime
  dependency not justified by the SPEC.
