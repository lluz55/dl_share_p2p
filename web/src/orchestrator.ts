// Connection orchestrator (SPEC §3.1).
//
// Composes the two transports with sequential fallback:
//   - Primary: Trystero (serverless Nostr) for both host and guest.
//   - Fallback: the Go server.
//
// Guest: tries Trystero first; if no peer pairs within a timeout (or Trystero
// errors / the direct P2P link fails on NAT), it falls back to the Go transport,
// which itself attempts direct P2P and then the Go data relay.
//
// Host: runs Trystero and also keeps a Go standby listener open on the same room
// code, so a guest that falls back to Go can still find the host. Direct P2P and
// file data always prefer Trystero whenever it works; the Go server is only used
// when the third-party path does not.

import { generateRoomCode } from "./roomcode.js";
import { TrysteroTransport } from "./trystero-transport.js";
import { GoTransport } from "./go-transport.js";
import type { FileMetadata, PeerState, Transport, TransportRole } from "./transport.js";

// How long a guest waits for the third-party path to pair it with the host
// before falling back to the Go server (SPEC §4.2, default ~8s).
const GUEST_FALLBACK_MS = 8000;

export class ConnectionOrchestrator {
  public onReady?: (role: TransportRole, code: string) => void;
  public onPeerState?: (peerId: string, state: PeerState) => void;
  public onSendProgress?: (peerId: string, sentBytes: number, totalBytes: number) => void;
  public onReceiveProgress?: (receivedBytes: number, totalBytes: number, meta: FileMetadata) => void;
  public onReceiveComplete?: (meta: FileMetadata, blob: Blob) => void;
  public onPathLabel?: (label: string) => void;
  public onError?: (reason: string) => void;

  private role: TransportRole = "guest";
  private code = "";
  private trystero: TrysteroTransport | null = null;
  private go: GoTransport | null = null;
  private guestFallbackTimer: number | null = null;
  // Which transport currently owns each peer id (peer ids never collide across
  // transports — a given guest uses exactly one).
  private readonly peerTransport = new Map<string, Transport>();

  /** Host: generate a code, show it, and start pairing. */
  public createRoom(): string {
    this.role = "host";
    this.code = generateRoomCode();
    this.onReady?.("host", this.code);
    this.onPathLabel?.("Connecting (serverless)…");
    this.startTrystero("host");
    this.startGoStandby();
    return this.code;
  }

  /** Guest: join an existing room by code. */
  public joinRoom(code: string): void {
    this.role = "guest";
    this.code = code.trim().toLowerCase();
    this.onReady?.("guest", this.code);
    this.onPathLabel?.("Connecting (serverless)…");
    this.startTrystero("guest");
    this.guestFallbackTimer = window.setTimeout(() => this.fallbackGuestToGo(), GUEST_FALLBACK_MS);
  }

  public sendFile(peerId: string, file: File): Promise<void> {
    const transport = this.peerTransport.get(peerId);
    if (!transport) {
      return Promise.reject(new Error(`unknown peer ${peerId}`));
    }
    return transport.sendFile(peerId, file);
  }

  public leave(): void {
    this.clearGuestTimer();
    this.trystero?.leave();
    this.go?.leave();
    this.trystero = null;
    this.go = null;
    this.peerTransport.clear();
  }

  private startTrystero(role: TransportRole): void {
    const t = new TrysteroTransport();
    this.trystero = t;
    t.events.onPeerState = (peerId, state) => {
      if (state === "connecting" || state === "connected") {
        this.peerTransport.set(peerId, t);
      }
      if (state === "connected" && role === "guest") {
        this.clearGuestTimer();
      }
      if (state === "failed") {
        if (role === "guest") {
          // Direct P2P over the serverless path failed (NAT) → fall back to Go,
          // which retries direct and then the data relay.
          this.fallbackGuestToGo();
          return;
        }
        // Host: this guest's serverless link failed; it will reappear via the Go
        // standby. Drop it here.
        this.peerTransport.delete(peerId);
        this.onPeerState?.(peerId, "closed");
        return;
      }
      this.onPeerState?.(peerId, state);
    };
    this.wireTransfer(t);
    t.events.onActivePath = (label) => this.onPathLabel?.(label);
    t.events.onError = (reason) => {
      if (role === "guest") {
        this.fallbackGuestToGo();
      } else {
        console.warn("serverless signaling error (host):", reason);
      }
    };
    t.start(role, this.code);
  }

  // Host-side standby Go listener so guests that fall back can find the host.
  private startGoStandby(): void {
    this.startGo("host");
  }

  private startGo(role: TransportRole): void {
    if (this.go) {
      return;
    }
    const g = new GoTransport();
    this.go = g;
    g.events.onPeerState = (peerId, state) => {
      if (state === "connecting" || state === "connected") {
        this.peerTransport.set(peerId, g);
      }
      this.onPeerState?.(peerId, state);
    };
    this.wireTransfer(g);
    g.events.onActivePath = (label) => this.onPathLabel?.(label);
    g.events.onError = (reason) => {
      // For the host, Go is only a standby fallback listener; a server/tunnel
      // outage must not surface as an error while the serverless path works.
      // For a guest that has fallen back, Go is the active last resort — surface it.
      if (role === "host") {
        console.warn("Go standby error (host):", reason);
      } else {
        this.onError?.(reason);
      }
    };
    g.start(role, this.code);
  }

  private wireTransfer(t: Transport): void {
    t.events.onSendProgress = (peerId, sent, total) => this.onSendProgress?.(peerId, sent, total);
    t.events.onReceiveProgress = (received, total, meta) =>
      this.onReceiveProgress?.(received, total, meta);
    t.events.onReceiveComplete = (meta, blob) => this.onReceiveComplete?.(meta, blob);
  }

  private fallbackGuestToGo(): void {
    if (this.go || this.role !== "guest") {
      return; // already fell back, or not a guest
    }
    this.clearGuestTimer();
    this.onPathLabel?.("Server signaling (fallback)…");
    this.trystero?.leave();
    this.trystero = null;
    this.peerTransport.clear();
    this.startGo("guest");
  }

  private clearGuestTimer(): void {
    if (this.guestFallbackTimer !== null) {
      window.clearTimeout(this.guestFallbackTimer);
      this.guestFallbackTimer = null;
    }
  }
}
