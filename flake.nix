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
            npmDepsHash = "sha256-7ZeVNttRm/lAOwb75iOfLZWPgHFVk+8eU6ch0W6jRGw=";

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
            exec ${pkgs.nodejs}/bin/npx --yes http-server "${frontend}" "$@"
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
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.go
            pkgs.nodejs
            pkgs.typescript
            pkgs.cloudflared
          ];

          shellHook = ''
            echo "p2pshare dev shell"
            echo "  go      $(go version)"
            echo "  node    $(node --version)"
            echo "  cloudflared $(cloudflared --version 2>&1 | head -1)"
          '';
        };
      }) // {
        nixosModules = rec {
          default = p2pshare;
          p2pshare = import ./nixos-module.nix self;
        };
      };
}
