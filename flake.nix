{
  description = "P2P file share — dev shell and build packages";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        packages = rec {
          default = server;

          server = pkgs.buildGoModule {
            pname = "p2pshare-server";
            version = "0.1.0";
            src = ./server;
            vendorHash = "sha256-0Qxw+MUYVgzgWB8vi3HBYtVXSq/btfh4ZfV/m1chNrA=";

            postInstall = ''
              mv $out/bin/p2pshare $out/bin/p2pshare-server
            '';
          };

          frontend = pkgs.buildNpmPackage {
            pname = "p2pshare-frontend";
            version = "0.1.0";
            src = ./web;
            npmDepsHash = "sha256-gpvYADnavsD4WoySZT3MRzRzBIzs9Peo8SRt97OTwq4=";

            # Node version supporting experimental strip types
            nodejs = pkgs.nodejs;

            # Allow injecting signaling URL at build time
            SIGNALING_URL = builtins.getEnv "SIGNALING_URL";

            installPhase = ''
              mkdir -p $out
              cp -r dist $out/
              cp index.html $out/
            '';
          };

          frontend-serve = pkgs.writeShellScriptBin "p2pshare-frontend-serve" ''
            TEMP_DIR=$(mktemp -d)
            trap 'rm -rf "$TEMP_DIR"' EXIT

            cp -r "${frontend}"/* "$TEMP_DIR/"
            chmod -R +w "$TEMP_DIR"

            if [ -n "$SIGNALING_URL" ]; then
              echo "Injecting runtime SIGNALING_URL=$SIGNALING_URL into index.html..."
              ${pkgs.nodejs}/bin/node -e "
                const fs = require('fs');
                const file = process.argv[1];
                const url = process.argv[2];
                let html = fs.readFileSync(file, 'utf8');
                const injection = '<script>window.__SIGNALING_URL__ = \"' + url + '\";</script>';
                html = html.replace('<script src=\"dist/bundle.js\"></script>', injection + '<script src=\"dist/bundle.js\"></script>');
                fs.writeFileSync(file, html, 'utf8');
              " "$TEMP_DIR/index.html" "$SIGNALING_URL"
            fi

            exec ${pkgs.nodejs}/bin/npx --yes http-server "$TEMP_DIR" "$@"
          '';

          frontend-build = pkgs.writeShellScriptBin "p2pshare-frontend-build" ''
            if [ -d "web" ]; then
              cd web
            elif [ ! -f "build.ts" ]; then
              echo "Error: Must be run from the repository root or the web/ directory" >&2
              exit 1
            fi

            if [ ! -d "node_modules" ]; then
              echo "node_modules not found, running npm install..."
              ${pkgs.nodejs}/bin/npm install
            fi

            echo "Building frontend locally..."
            exec ${pkgs.nodejs}/bin/node --experimental-strip-types build.ts "$@"
          '';

          server-run = pkgs.writeShellScriptBin "p2pshare-server-run" ''
            if [ ! -f "secrets/secrets.yaml" ]; then
              echo "Error: secrets/secrets.yaml not found." >&2
              echo "Please create a secrets/secrets.yaml file encrypted with SOPS." >&2
              exit 1
            fi
            echo "Decrypting Allowed Origins using SOPS..."
            ORIGINS=$(${pkgs.sops}/bin/sops --decrypt --extract '["allowed-origins"]' secrets/secrets.yaml)
            if [ -z "$ORIGINS" ]; then
              echo "Error: allowed-origins not found in secrets.yaml" >&2
              exit 1
            fi
            echo "Starting Go Signaling Server..."
            export ALLOWED_ORIGINS="$ORIGINS"
            exec "${server}/bin/p2pshare-server" "$@"
          '';

          tunnel-run = pkgs.writeShellScriptBin "p2pshare-tunnel-run" ''
            if [ ! -f "secrets/secrets.yaml" ]; then
              echo "Error: secrets/secrets.yaml not found." >&2
              echo "Please create a secrets/secrets.yaml file encrypted with SOPS." >&2
              exit 1
            fi
            echo "Decrypting Cloudflare Tunnel Token using SOPS..."
            TOKEN=$(${pkgs.sops}/bin/sops --decrypt --extract '["cloudflare-tunnel-token"]' secrets/secrets.yaml)
            if [ -z "$TOKEN" ]; then
              echo "Error: cloudflare-tunnel-token not found in secrets.yaml" >&2
              exit 1
            fi
            echo "Starting Cloudflare Tunnel persistent instance..."
            exec ${pkgs.cloudflared}/bin/cloudflared tunnel run --token "$TOKEN"
          '';

          dev-run = pkgs.writeShellScriptBin "p2pshare-dev-run" ''
            set -uo pipefail

            SERVER_PID=""
            TUNNEL_PID=""

            _stop() {
              echo ""
              echo "==> Stopping all services..."
              [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
              [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
              wait 2>/dev/null || true
            }
            trap _stop EXIT INT TERM

            echo "==> Starting Go server..."
            ${server-run}/bin/p2pshare-server-run "$@" &
            SERVER_PID=$!

            echo "==> Starting Cloudflare tunnel..."
            ${tunnel-run}/bin/p2pshare-tunnel-run &
            TUNNEL_PID=$!

            echo "==> Running (server PID=$SERVER_PID, tunnel PID=$TUNNEL_PID) — Ctrl+C to stop."

            # Exit as soon as either service dies
            wait -n "$SERVER_PID" "$TUNNEL_PID"
          '';
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.go
            pkgs.nodejs
            pkgs.typescript
            pkgs.cloudflared
            pkgs.sops
          ];

          shellHook = ''
            echo "p2pshare dev shell"
            echo "  go          $(go version)"
            echo "  node        $(node --version)"
            echo "  cloudflared $(cloudflared --version 2>&1 | head -1)"
            echo "  sops        $(sops --version)"
          '';
        };
      }) // {
        nixosModules = rec {
          default = p2pshare;
          p2pshare = import ./nixos-module.nix self;
        };
      };
}
