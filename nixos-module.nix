self: { config, lib, pkgs, ... }:

let
  cfg = config.services.p2pshare;
in
{
  options.services.p2pshare = {
    enable = lib.mkEnableOption "P2P Share Service Bundle";

    port = lib.mkOption {
      type = lib.types.port;
      default = 18085;
      description = "Port the Go backend server binds to.";
    };

    allowedOrigins = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "List of allowed CORS/WebSocket origins.";
    };

    secretsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to a decrypted sops-nix secret file containing environment variables (e.g. ALLOWED_ORIGINS) for the server.";
    };

    tunnel = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Enable Cloudflare Tunnel to expose the signaling server.";
      };

      tokenFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = "Path to the decrypted sops secret file containing the Cloudflare Tunnel token.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    # Define users
    users.users.p2pshare = {
      isSystemUser = true;
      group = "p2pshare";
      description = "P2P Share daemon user";
      home = "/var/lib/p2pshare";
    };
    users.groups.p2pshare = { };

    # Systemd service for backend
    systemd.services.p2pshare-server = {
      description = "P2P Share Go Signaling Server";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];
      environment = {
        ALLOWED_ORIGINS = lib.concatStringsSep "," cfg.allowedOrigins;
      };
      serviceConfig = {
        Type = "simple";
        User = "p2pshare";
        Group = "p2pshare";
        WorkingDirectory = "/var/lib/p2pshare";
        ExecStart = "${self.packages.${pkgs.system}.server}/bin/p2pshare-server -port ${toString cfg.port}";
        Restart = "on-failure";
        RestartSec = "5s";
        # Hardening
        ProtectSystem = "strict";
        ProtectHome = true;
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectKernelTunables = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = "AF_INET AF_INET6 AF_UNIX";
        DeviceAllow = [
          "/dev/null r"
          "/dev/urandom r"
        ];
        StateDirectory = "p2pshare";
      } // (lib.optionalAttrs (cfg.secretsFile != null) {
        EnvironmentFile = cfg.secretsFile;
      });
    };

    # Systemd service for cloudflared tunnel
    systemd.services.p2pshare-tunnel = lib.mkIf cfg.tunnel.enable {
      description = "P2P Share Cloudflare Tunnel";
      after = [ "network.target" "p2pshare-server.service" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "simple";
        ExecStart = "${pkgs.writeShellScript "p2pshare-tunnel-start" ''
          if [ ! -f "${cfg.tunnel.tokenFile}" ]; then
            echo "Error: tokenFile ${cfg.tunnel.tokenFile} does not exist" >&2
            exit 1
          fi
          TOKEN=$(cat "${cfg.tunnel.tokenFile}")
          exec ${pkgs.cloudflared}/bin/cloudflared tunnel run --token "$TOKEN"
        ''}";
        Restart = "on-failure";
        RestartSec = "5s";
        # Hardening
        ProtectSystem = "strict";
        ProtectHome = true;
        NoNewPrivileges = true;
        PrivateTmp = true;
      };
    };
  };
}
