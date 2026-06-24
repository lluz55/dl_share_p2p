// Fallback signaling + data relay transport via the Go server (SPEC §3.1, §4.3).
//
// Thin adapter that wraps the existing modules (signaling.ts, peer.ts,
// transfer.ts) behind the Transport interface, and adds the data-relay escalation
// (relay-transfer.ts) for when direct P2P fails because of NAT.
//
// Relay frames are E2E encrypted using ECDH P-256 + AES-GCM-256 (crypto.ts).
// The server routes public keys but never sees the derived shared secret.

import { SignalingClient } from "./signaling.js";
import { PeerConnectionManager } from "./peer.js";
import { sendFile as sendFileDirect, FileReceiver, FileMetadata } from "./transfer.js";
import { connectRelay, sendFileOverRelay, receiveFileOverRelay } from "./relay-transfer.js";
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
} from "./crypto.js";
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

  // Key exchange state: keyed by the remote peer ID.
  // Host side: stores the private key and a resolver waiting for the guest's public key.
  private readonly pendingRelayKeys = new Map<string, {
    privateKey: CryptoKey;
    resolve: (k: CryptoKey) => void;
    reject: (e: Error) => void;
  }>();

  // Exported public key from the most recent prepareKeyExchange() call,
  // consumed once by the next requestRelay() call.
  private pendingHostPubKey: string | undefined;

  public start(role: TransportRole, code: string): void {
    this.role = role;
    this.code = code;

    this.signaling.onJoined = (data) => {
      this.selfId = data.self;
      this.peers.handleJoined(data.self, data.role);
      for (const peerId of data.peers) {
        if (data.self < peerId) {
          this.peers.handlePeerJoined(peerId);
        }
        this.events.onPeerState?.(peerId, "connecting");
      }
    };
    this.signaling.onPeerJoined = (peerId) => {
      this.peers.handlePeerJoined(peerId);
      this.events.onPeerState?.(peerId, "connecting");
    };
    this.signaling.onPeerLeft = (peerId) => {
      this.peers.handlePeerLeft(peerId);
      this.channels.delete(peerId);
      this.pendingRelayKeys.delete(peerId);
      this.events.onPeerState?.(peerId, "closed");
    };
    this.signaling.onRelayApproved = (token, from, to, key) =>
      this.handleRelayApproved(token, from, to, key);
    this.signaling.onRelayKey = (from, keyB64) => void this.handleRelayKey(from, keyB64);
    this.signaling.onError = (reason) => {
      if (reason === LOGIN_REQUIRED) {
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

    // Set up E2E key exchange before sending the relay-request so we can't
    // miss the guest's relay-key response.
    const { waitForSharedKey } = await this.prepareKeyExchange(peerId);

    const [token, sharedKey] = await Promise.all([
      this.requestRelayAuthenticated(peerId),
      waitForSharedKey,
    ]);

    const ws = await connectRelay(token, this.requireSelfId());
    try {
      // Give the guest a moment to attach to the relay before streaming.
      await delay(300);
      await sendFileOverRelay(ws, file, sharedKey, (sent, total) =>
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
    for (const pending of this.pendingRelayKeys.values()) {
      pending.reject(new Error("transport closed"));
    }
    this.pendingRelayKeys.clear();
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
        this.relayMode.add(peerId);
        this.events.onActivePath?.("Server relay (NAT)");
        this.events.onPeerState?.(peerId, "connected");
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
    this.channels.set(peerId, channel);
    const receiver = new FileReceiver(channel);
    receiver.onProgress = (received, total) =>
      this.events.onReceiveProgress?.(received, total, progressMeta(total));
    receiver.onComplete = (meta, blob) => this.events.onReceiveComplete?.(meta, blob);
    receiver.onError = (err) => this.events.onError?.(err.message);
  }

  // Guest side: called when relay-approved arrives with the host's public key.
  // Generates own key pair, derives shared key, sends back public key,
  // then opens the relay for receiving.
  private handleRelayApproved(token: string, from: string, to: string, hostKeyB64?: string): void {
    if (to === this.selfId) {
      void this.receiveOverRelay(token, from, hostKeyB64);
    } else if (from === this.selfId) {
      // Host: relay session created — unblock the pending sendFile.
      const pending = this.pendingRelay.get(to);
      if (pending) {
        this.pendingRelay.delete(to);
        pending.resolve(token);
      }
    }
  }

  // Host side: guest sent back its ECDH public key — derive shared secret.
  private async handleRelayKey(from: string, guestKeyB64: string): Promise<void> {
    const pending = this.pendingRelayKeys.get(from);
    if (!pending) return;
    try {
      const guestPub = await importPublicKey(guestKeyB64);
      const sharedKey = await deriveSharedKey(pending.privateKey, guestPub);
      pending.resolve(sharedKey);
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error("key derivation failed"));
    } finally {
      this.pendingRelayKeys.delete(from);
    }
  }

  // Guest side: perform ECDH and start receiving over the relay.
  private async receiveOverRelay(token: string, hostPeerId: string, hostKeyB64?: string): Promise<void> {
    this.events.onActivePath?.("Server relay (NAT)");

    let sharedKey: CryptoKey;
    try {
      if (!hostKeyB64) throw new Error("host did not provide an ECDH public key");
      const hostPub = await importPublicKey(hostKeyB64);
      const { privateKey, publicKey } = await generateKeyPair();
      sharedKey = await deriveSharedKey(privateKey, hostPub);
      // Send guest's public key to host so host can also derive the shared key.
      this.signaling.sendRelayKey(hostPeerId, await exportPublicKey(publicKey));
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err.message : "key exchange failed");
      return;
    }

    let ws: WebSocket;
    try {
      ws = await connectRelay(token, this.requireSelfId());
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err.message : "relay connect failed");
      return;
    }

    receiveFileOverRelay(ws, sharedKey, {
      onProgress: (received, total) =>
        this.events.onReceiveProgress?.(received, total, progressMeta(total)),
      onComplete: (meta, blob) => {
        this.events.onReceiveComplete?.(meta, blob);
        ws.close();
      },
      onError: (err) => {
        this.events.onError?.(err.message);
        ws.close();
      },
    });
  }

  // Generate an ephemeral ECDH key pair and return a promise that resolves
  // once the peer sends back its public key and the shared key is derived.
  // Must be called before sendRelayRequest so the relay-key response can't arrive first.
  private async prepareKeyExchange(peerId: string): Promise<{ waitForSharedKey: Promise<CryptoKey> }> {
    const keyPair = await generateKeyPair();
    const waitForSharedKey = new Promise<CryptoKey>((resolve, reject) => {
      this.pendingRelayKeys.set(peerId, { privateKey: keyPair.privateKey, resolve, reject });
      setTimeout(() => {
        if (this.pendingRelayKeys.has(peerId)) {
          this.pendingRelayKeys.delete(peerId);
          reject(new Error("relay key exchange timed out"));
        }
      }, 15000);
    });
    this.pendingHostPubKey = await exportPublicKey(keyPair.publicKey);
    return { waitForSharedKey };
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
    const hostPubKey = this.pendingHostPubKey;
    this.pendingHostPubKey = undefined;
    return new Promise<string>((resolve, reject) => {
      this.pendingRelay.set(peerId, { resolve, reject });
      this.signaling.sendRelayRequest(peerId, auth.getToken() ?? undefined, hostPubKey);
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
