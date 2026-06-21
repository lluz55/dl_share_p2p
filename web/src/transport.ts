// Common transport abstraction (SPEC §3.1, §4.2).
//
// A Transport pairs peers over a room code and moves a file between them. Two
// implementations exist behind this interface:
//   - TrysteroTransport: third-party serverless signaling (Nostr) + direct P2P.
//   - GoTransport: the Go server as fallback signaling + the Go data relay.
// The ConnectionOrchestrator composes them (primary → fallback).

import type { FileMetadata } from "./transfer.js";

export type TransportRole = "host" | "guest";

// Per-peer connection lifecycle, normalized across transports.
export type PeerState = "connecting" | "connected" | "failed" | "closed";

export type { FileMetadata };

// Callbacks a Transport raises to its consumer (the orchestrator).
export interface TransportEvents {
  /** Room is up; role + our own peer id are known. */
  onReady?: (role: TransportRole, selfId: string) => void;
  /** A peer's connection state changed. */
  onPeerState?: (peerId: string, state: PeerState) => void;
  /** Progress while sending a file to a peer (host side). */
  onSendProgress?: (peerId: string, sentBytes: number, totalBytes: number) => void;
  /** Progress while receiving a file (guest side). */
  onReceiveProgress?: (receivedBytes: number, totalBytes: number, meta: FileMetadata) => void;
  /** A received file is complete and reassembled (guest side). */
  onReceiveComplete?: (meta: FileMetadata, blob: Blob) => void;
  /** The active transport path changed (for the status badge), e.g. "Server relay (NAT)". */
  onActivePath?: (label: string) => void;
  /** A transport-level error (signaling/connection). */
  onError?: (reason: string) => void;
}

export interface Transport {
  /** Short label for the active path, shown in the UI (e.g. "Direct P2P (serverless)"). */
  readonly label: string;

  /** Join/create the room with the given code under the given role. */
  start(role: TransportRole, code: string): void;

  /** Send a file to a specific connected peer. Resolves when the transfer completes. */
  sendFile(peerId: string, file: File): Promise<void>;

  /** Tear down the transport and any underlying connections. */
  leave(): void;

  /** Event hooks. */
  readonly events: TransportEvents;
}
