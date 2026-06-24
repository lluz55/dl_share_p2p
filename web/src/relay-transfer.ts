// Go data relay client (SPEC §4.3).
//
// When direct P2P fails, host and guest each open a WebSocket to the Go server's
// /relay endpoint with the relay token. The server bridges bytes one-way
// (host → guest) verbatim.
//
// Every frame is AES-GCM encrypted before transmission. To allow the receiver
// to distinguish control frames (metadata/eof JSON) from binary data chunks
// without relying on fragile JSON-parse heuristics, each plaintext is prefixed
// with a 1-byte type tag before encryption:
//   0x01  control frame (UTF-8 JSON follows)
//   0x02  binary data chunk

import { RELAY_URL } from "./config.js";
import { encryptFrame, decryptFrame } from "./crypto.js";
import type { FileMetadata } from "./transfer.js";

const CHUNK_SIZE = 16384; // 16KB, matches transfer.ts
const HIGH_WATER_MARK = 1048576; // 1MB before backpressure
const FRAME_CONTROL = 0x01;
const FRAME_DATA = 0x02;

export interface ReceiveCallbacks {
  onProgress?: (received: number, total: number, meta: FileMetadata) => void;
  onComplete?: (meta: FileMetadata, blob: Blob) => void;
  onError?: (err: Error) => void;
}

function relayEndpoint(token: string, peerId: string): string {
  const sep = RELAY_URL.includes("?") ? "&" : "?";
  return `${RELAY_URL}${sep}token=${encodeURIComponent(token)}&peerId=${encodeURIComponent(peerId)}`;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function encryptControl(key: CryptoKey, json: string): Promise<ArrayBuffer> {
  const jsonBytes = enc.encode(json);
  const payload = new Uint8Array(1 + jsonBytes.length);
  payload[0] = FRAME_CONTROL;
  payload.set(jsonBytes, 1);
  return encryptFrame(key, payload.buffer);
}

async function encryptData(key: CryptoKey, buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const payload = new Uint8Array(1 + buffer.byteLength);
  payload[0] = FRAME_DATA;
  payload.set(new Uint8Array(buffer), 1);
  return encryptFrame(key, payload.buffer);
}

/**
 * Open a WebSocket to the relay endpoint. Resolves once the socket is open.
 */
export function connectRelay(token: string, selfId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayEndpoint(token, selfId));
    } catch (err) {
      reject(err instanceof Error ? err : new Error("Failed to open relay socket"));
      return;
    }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("Relay connection error"));
  });
}

/**
 * Send a file over an open relay WebSocket. Every frame is AES-GCM encrypted.
 */
export async function sendFileOverRelay(
  ws: WebSocket,
  file: File,
  key: CryptoKey,
  onProgress?: (sentBytes: number, totalBytes: number) => void
): Promise<void> {
  const total = file.size;

  ws.send(
    await encryptControl(
      key,
      JSON.stringify({
        type: "metadata",
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
      })
    )
  );

  let offset = 0;
  while (offset < total) {
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error("Relay connection closed during transfer");
    }
    while (ws.bufferedAmount > HIGH_WATER_MARK) {
      await delay(50);
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("Relay connection closed during transfer");
      }
    }

    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await slice.arrayBuffer();
    ws.send(await encryptData(key, buffer));
    offset += buffer.byteLength;
    if (onProgress) {
      onProgress(offset, total);
    }
  }

  ws.send(await encryptControl(key, JSON.stringify({ type: "eof" })));
  if (onProgress) {
    onProgress(total, total);
  }
}

/**
 * Receive and decrypt a file over an open relay WebSocket.
 */
export function receiveFileOverRelay(
  ws: WebSocket,
  key: CryptoKey,
  callbacks: ReceiveCallbacks
): void {
  let meta: FileMetadata | null = null;
  const chunks: ArrayBuffer[] = [];
  let receivedBytes = 0;

  ws.binaryType = "arraybuffer";
  ws.onmessage = async (event: MessageEvent) => {
    let plain: ArrayBuffer;
    try {
      plain = await decryptFrame(key, event.data as ArrayBuffer);
    } catch {
      callbacks.onError?.(new Error("relay decryption failed"));
      ws.close();
      return;
    }

    const view = new Uint8Array(plain);
    const frameType = view[0];
    const payload = plain.slice(1);

    if (frameType === FRAME_CONTROL) {
      let msg: { type: string; name?: string; size?: number; mimeType?: string };
      try {
        msg = JSON.parse(dec.decode(payload)) as typeof msg;
      } catch {
        callbacks.onError?.(new Error("malformed control frame"));
        ws.close();
        return;
      }
      if (msg.type === "metadata") {
        meta = { name: msg.name!, size: msg.size!, mimeType: msg.mimeType! };
        callbacks.onProgress?.(0, meta.size, meta);
      } else if (msg.type === "eof") {
        if (!meta) {
          callbacks.onError?.(new Error("eof received before metadata"));
          return;
        }
        if (receivedBytes !== meta.size) {
          callbacks.onError?.(
            new Error(`integrity mismatch: expected ${meta.size}, got ${receivedBytes}`)
          );
          return;
        }
        callbacks.onComplete?.(meta, new Blob(chunks, { type: meta.mimeType }));
      }
    } else if (frameType === FRAME_DATA) {
      chunks.push(payload);
      receivedBytes += payload.byteLength;
      if (meta) {
        callbacks.onProgress?.(receivedBytes, meta.size, meta);
      }
    } else {
      callbacks.onError?.(new Error(`unknown frame type: ${frameType}`));
      ws.close();
    }
  };

  ws.onerror = () => callbacks.onError?.(new Error("relay WebSocket error"));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
