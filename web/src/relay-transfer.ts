// Go data relay client (SPEC §4.3).
//
// When direct P2P fails, host and guest each open a WebSocket to the Go server's
// /relay endpoint with the relay token. The server bridges bytes one-way
// (host → guest) verbatim, so we reuse the same metadata/chunk/eof framing as the
// direct DataChannel transfer. The receiver side reuses FileReceiver.

import { RELAY_URL } from "./config.js";

const CHUNK_SIZE = 16384; // 16KB, matches transfer.ts
const HIGH_WATER_MARK = 1048576; // 1MB buffered before applying backpressure

function relayEndpoint(token: string, peerId: string): string {
  const sep = RELAY_URL.includes("?") ? "&" : "?";
  return `${RELAY_URL}${sep}token=${encodeURIComponent(token)}&peerId=${encodeURIComponent(peerId)}`;
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
 * Send a file over an open relay WebSocket using the metadata/chunk/eof framing.
 * Backpressure is applied by polling bufferedAmount (WebSocket has no
 * bufferedamountlow event).
 */
export async function sendFileOverRelay(
  ws: WebSocket,
  file: File,
  onProgress?: (sentBytes: number, totalBytes: number) => void
): Promise<void> {
  const total = file.size;
  ws.send(
    JSON.stringify({
      type: "metadata",
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
    })
  );

  let offset = 0;
  while (offset < total) {
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error("Relay connection closed during transfer");
    }
    // Backpressure: wait while the send buffer is above the high-water mark.
    while (ws.bufferedAmount > HIGH_WATER_MARK) {
      await delay(50);
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("Relay connection closed during transfer");
      }
    }

    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await slice.arrayBuffer();
    ws.send(buffer);
    offset += buffer.byteLength;
    if (onProgress) {
      onProgress(offset, total);
    }
  }

  ws.send(JSON.stringify({ type: "eof" }));
  if (onProgress) {
    onProgress(total, total);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
