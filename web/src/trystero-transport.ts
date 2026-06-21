// Primary signaling transport: Trystero over Nostr (SPEC §2, §3.1, §4.2).
//
// Serverless WebRTC matchmaking through public Nostr relays — no intermediary
// of ours. Direct P2P file transfer uses Trystero's native binary action with
// built-in progress. This transport never touches the Go server.

import { joinRoom, selfId } from "trystero/nostr";
import type { JsonValue, MessageAction } from "trystero/nostr";
import { RTC_CONFIGURATION } from "./config.js";
import type { FileMetadata, Transport, TransportEvents, TransportRole } from "./transport.js";

// Namespace shared by all users of this app on the Nostr network. The room code
// (§4.1) is the actual rendezvous key; this only scopes our app's topics.
const APP_ID = "dl-share-me-p2pshare";

// Trystero action namespaces are limited to 12 bytes.
const FILE_ACTION = "file";

interface WireMeta {
  name: string;
  size: number;
  mimeType: string;
}

type TrysteroRoom = ReturnType<typeof joinRoom>;

function toFileMetadata(meta: unknown, fallbackSize: number): FileMetadata {
  const m = (meta ?? {}) as Partial<WireMeta>;
  return {
    name: typeof m.name === "string" ? m.name : "file",
    size: typeof m.size === "number" ? m.size : fallbackSize,
    mimeType: typeof m.mimeType === "string" ? m.mimeType : "application/octet-stream",
  };
}

export class TrysteroTransport implements Transport {
  readonly label = "Direct P2P (serverless)";
  readonly events: TransportEvents = {};

  private room: TrysteroRoom | null = null;
  private fileAction: MessageAction<ArrayBuffer> | null = null;
  private readonly watched = new Set<string>();

  public start(role: TransportRole, code: string): void {
    let room: TrysteroRoom;
    try {
      room = joinRoom(
        { appId: APP_ID, rtcConfig: RTC_CONFIGURATION },
        code,
        { onJoinError: (details) => this.events.onError?.(details.error) }
      );
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err.message : "Failed to join serverless room");
      return;
    }

    this.room = room;

    const action = room.makeAction<ArrayBuffer>(FILE_ACTION);
    this.fileAction = action;

    action.onReceiveProgress = (percent, ctx) => {
      const meta = toFileMetadata(ctx.metadata, 0);
      this.events.onReceiveProgress?.(Math.round(percent * meta.size), meta.size, meta);
    };

    action.onMessage = (data, ctx) => {
      const meta = toFileMetadata(ctx.metadata, data.byteLength);
      const blob = new Blob([data], { type: meta.mimeType });
      this.events.onReceiveComplete?.(meta, blob);
    };

    room.onPeerJoin = (peerId) => {
      this.events.onPeerState?.(peerId, "connected");
      this.watchPeer(peerId);
    };

    room.onPeerLeave = (peerId) => {
      this.watched.delete(peerId);
      this.events.onPeerState?.(peerId, "closed");
    };

    // Room is up; report our own id immediately (Trystero's selfId is stable).
    this.events.onReady?.(role, selfId);
  }

  public async sendFile(peerId: string, file: File): Promise<void> {
    if (!this.fileAction) {
      throw new Error("Trystero transport not started");
    }
    const buffer = await file.arrayBuffer();
    const meta: WireMeta = {
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
    };
    await this.fileAction.send(buffer, {
      target: peerId,
      metadata: meta as unknown as JsonValue,
      onProgress: (percent) => {
        this.events.onSendProgress?.(peerId, Math.round(percent * file.size), file.size);
      },
    });
    this.events.onSendProgress?.(peerId, file.size, file.size);
  }

  public leave(): void {
    this.watched.clear();
    this.fileAction = null;
    const room = this.room;
    this.room = null;
    if (room) {
      void room.leave();
    }
  }

  // Watch a peer's underlying RTCPeerConnection for failure after it connects,
  // so the orchestrator can escalate that pair to the Go relay (SPEC §3.1).
  private watchPeer(peerId: string): void {
    const pc = this.room?.getPeers()[peerId];
    if (!pc || this.watched.has(peerId)) {
      return;
    }
    this.watched.add(peerId);
    pc.addEventListener("connectionstatechange", () => {
      switch (pc.connectionState) {
        case "failed":
        case "disconnected":
          this.events.onPeerState?.(peerId, "failed");
          break;
        case "closed":
          this.events.onPeerState?.(peerId, "closed");
          break;
        default:
          break;
      }
    });
  }
}
