// Fallback signaling + data relay transport via the Go server (SPEC §3.1, §4.3).
//
// Thin adapter that wraps the existing modules (signaling.ts, peer.ts,
// transfer.ts) behind the Transport interface, and adds the data-relay escalation
// (relay-transfer.ts) for when direct P2P fails because of NAT.

import { SignalingClient } from "./signaling.js";
import { PeerConnectionManager } from "./peer.js";
import { sendFile as sendFileDirect, FileReceiver, FileMetadata } from "./transfer.js";
import { connectRelay, sendFileOverRelay } from "./relay-transfer.js";
import * as auth from "./auth.js";
import type { Transport, TransportEvents, TransportRole } from "./transport.js";

// Server reason returned when a relay is requested without a valid login.
const LOGIN_REQUIRED = "login-required";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progressMeta(total: number): FileMetadata {
  return { name: "file", size: total, mimeType: "application/octet-stream" };
}

export class GoTransport implements Transport {
  readonly label = "Direct P2P (server-signaled)";
  readonly events: TransportEvents = {};

  private readonly signaling = new SignalingClient();
  private readonly peers = new PeerConnectionManager(this.signaling);
  private role: TransportRole = "guest";
  private code = "";
  private selfId: string | null = null;

  private readonly channels = new Map<string, RTCDataChannel>();
  private readonly relayMode = new Set<string>();
  private readonly pendingRelay = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void }>();

  public start(role: TransportRole, code: string): void {
    this.role = role;
    this.code = code;

    this.signaling.onJoined = (data) => {
      this.selfId = data.self;
      this.peers.handleJoined(data.self, data.role);
    };
    this.signaling.onPeerJoined = (peerId) => {
      this.peers.handlePeerJoined(peerId);
      this.events.onPeerState?.(peerId, "connecting");
    };
    this.signaling.onPeerLeft = (peerId) => {
      this.peers.handlePeerLeft(peerId);
      this.channels.delete(peerId);
      this.events.onPeerState?.(peerId, "closed");
    };
    this.signaling.onRelayApproved = (token, from, to) => this.handleRelayApproved(token, from, to);
    this.signaling.onError = (reason) => {
      if (reason === LOGIN_REQUIRED) {
        // The session token was missing/expired when we asked for a relay. Drop
        // it and unblock the pending request so sendFile can re-authenticate.
        auth.clear();
        this.rejectPendingRelays(new Error(LOGIN_REQUIRED));
        return;
      }
      this.events.onError?.(reason);
    };

    this.peers.onConnectionStateChange = (peerId, state) => this.handlePeerState(peerId, state);
    this.peers.onDataChannel = (peerId, channel) => this.handleDataChannel(peerId, channel);

    this.signaling.onOpen = () => {
      if (role === "host") {
        this.signaling.createRoomWithCode(code);
      } else {
        this.signaling.joinRoom(code);
      }
    };
    this.signaling.connect();
  }

  public async sendFile(peerId: string, file: File): Promise<void> {
    const channel = this.channels.get(peerId);
    if (channel && channel.readyState === "open" && !this.relayMode.has(peerId)) {
      await sendFileDirect(channel, file, (sent, total) =>
        this.events.onSendProgress?.(peerId, sent, total)
      );
      return;
    }

    // Direct path unavailable → authenticated Go data relay (SPEC §4.3). Using
    // the server for file data requires a prior login (shared password).
    this.events.onActivePath?.("Server relay (NAT)");
    const token = await this.requestRelayAuthenticated(peerId);
    const ws = await connectRelay(token, this.requireSelfId());
    try {
      // Give the guest a moment to attach to the relay before streaming.
      await delay(300);
      await sendFileOverRelay(ws, file, (sent, total) =>
        this.events.onSendProgress?.(peerId, sent, total)
      );
    } finally {
      ws.close();
    }
  }

  public leave(): void {
    this.signaling.close();
    this.peers.closeAll();
    this.channels.clear();
    this.relayMode.clear();
    for (const pending of this.pendingRelay.values()) {
      pending.reject(new Error("transport closed"));
    }
    this.pendingRelay.clear();
  }

  private handlePeerState(peerId: string, state: string): void {
    switch (state) {
      case "connecting":
        this.events.onPeerState?.(peerId, "connecting");
        break;
      case "connected":
        this.events.onPeerState?.(peerId, "connected");
        this.events.onActivePath?.("Direct P2P (server-signaled)");
        break;
      case "failed": {
        // Escalate to the Go data relay. Host stays sendable; the relay session
        // is established lazily on send. Guest waits for the host to relay.
        this.relayMode.add(peerId);
        this.events.onActivePath?.("Server relay (NAT)");
        this.events.onPeerState?.(peerId, this.role === "host" ? "connected" : "connecting");
        break;
      }
      case "disconnected":
      case "closed":
        this.channels.delete(peerId);
        this.events.onPeerState?.(peerId, "closed");
        break;
      default:
        break;
    }
  }

  private handleDataChannel(peerId: string, channel: RTCDataChannel): void {
    if (this.role === "host") {
      this.channels.set(peerId, channel);
      return;
    }
    // Guest: receive the file the host sends over the direct channel.
    const receiver = new FileReceiver(channel);
    receiver.onProgress = (received, total) =>
      this.events.onReceiveProgress?.(received, total, progressMeta(total));
    receiver.onComplete = (meta, blob) => this.events.onReceiveComplete?.(meta, blob);
    receiver.onError = (err) => this.events.onError?.(err.message);
  }

  private handleRelayApproved(token: string, from: string, to: string): void {
    if (to === this.selfId) {
      // We are the guest (recipient): connect and receive over the relay.
      void this.receiveOverRelay(token);
    } else if (from === this.selfId) {
      // We are the host (sender): unblock the pending sendFile for guest `to`.
      const pending = this.pendingRelay.get(to);
      if (pending) {
        this.pendingRelay.delete(to);
        pending.resolve(token);
      }
    }
  }

  private async receiveOverRelay(token: string): Promise<void> {
    this.events.onActivePath?.("Server relay (NAT)");
    let ws: WebSocket;
    try {
      ws = await connectRelay(token, this.requireSelfId());
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err.message : "relay connect failed");
      return;
    }
    const receiver = new FileReceiver(ws);
    receiver.onProgress = (received, total) =>
      this.events.onReceiveProgress?.(received, total, progressMeta(total));
    receiver.onComplete = (meta, blob) => {
      this.events.onReceiveComplete?.(meta, blob);
      ws.close();
    };
    receiver.onError = (err) => {
      this.events.onError?.(err.message);
      ws.close();
    };
  }

  // Obtain a relay token, ensuring we are logged in first and retrying once if
  // the server reports the session expired between login and the request.
  private async requestRelayAuthenticated(peerId: string): Promise<string> {
    await this.ensureAuth();
    try {
      return await this.requestRelay(peerId);
    } catch (err) {
      if (err instanceof Error && err.message === LOGIN_REQUIRED) {
        auth.clear();
        await this.ensureAuth();
        return await this.requestRelay(peerId);
      }
      throw err;
    }
  }

  // Ensure a valid relay session token exists, prompting the consumer to log in
  // (shared password) if needed. Throws if authentication is unavailable.
  private async ensureAuth(): Promise<void> {
    if (auth.hasValidToken()) {
      return;
    }
    if (this.events.onAuthRequired) {
      await this.events.onAuthRequired();
    }
    if (!auth.hasValidToken()) {
      throw new Error("login required to use the server relay");
    }
  }

  private requestRelay(peerId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.pendingRelay.set(peerId, { resolve, reject });
      this.signaling.sendRelayRequest(peerId, auth.getToken() ?? undefined);
      setTimeout(() => {
        if (this.pendingRelay.has(peerId)) {
          this.pendingRelay.delete(peerId);
          reject(new Error("relay request timed out"));
        }
      }, 10000);
    });
  }

  private rejectPendingRelays(err: Error): void {
    for (const pending of this.pendingRelay.values()) {
      pending.reject(err);
    }
    this.pendingRelay.clear();
  }

  private requireSelfId(): string {
    if (!this.selfId) {
      throw new Error("relay unavailable: not joined to Go signaling");
    }
    return this.selfId;
  }
}
