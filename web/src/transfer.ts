export interface FileMetadata {
  name: string;
  size: number;
  mimeType: string;
}

/**
 * Send a file over a WebRTC DataChannel with chunking and backpressure.
 * Decoupled from the DOM.
 */
export async function sendFile(
  channel: RTCDataChannel,
  file: File,
  onProgress?: (sentBytes: number, totalBytes: number) => void
): Promise<void> {
  const chunkSize = 16384; // 16KB chunk size
  const metadata = {
    type: "metadata",
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
  };

  // Send metadata frame as JSON
  channel.send(JSON.stringify(metadata));

  let offset = 0;
  const total = file.size;

  // Set the buffered amount threshold to 64KB
  channel.bufferedAmountLowThreshold = 65536;

  return new Promise<void>((resolve, reject) => {
    const readNextChunk = () => {
      if (offset >= total) {
        // Send EOF frame as JSON
        channel.send(JSON.stringify({ type: "eof" }));
        if (onProgress) {
          onProgress(total, total);
        }
        resolve();
        return;
      }

      // Backpressure: pause if buffered amount exceeds 1MB high-water mark
      if (channel.bufferedAmount > 1048576) {
        channel.onbufferedamountlow = () => {
          channel.onbufferedamountlow = null; // Clear the listener
          readNextChunk();
        };
        return;
      }

      const slice = file.slice(offset, offset + chunkSize);
      const reader = new FileReader();

      reader.onload = (e) => {
        if (e.target?.result instanceof ArrayBuffer) {
          const buffer = e.target.result;
          try {
            channel.send(buffer);
            offset += buffer.byteLength;
            if (onProgress) {
              onProgress(offset, total);
            }
            readNextChunk();
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error("FileReader result is not an ArrayBuffer"));
        }
      };

      reader.onerror = () => {
        reject(reader.error || new Error("FileReader error"));
      };

      reader.readAsArrayBuffer(slice);
    };

    // Begin reading and sending
    readNextChunk();
  });
}

/**
 * FileReceiver manages receiving file metadata and binary chunks over a DataChannel,
 * verifying integrity, and invoking a callback with the reassembled Blob.
 */
export class FileReceiver {
  private metadata: FileMetadata | null = null;
  private chunks: ArrayBuffer[] = [];
  private receivedBytes = 0;

  public onProgress?: (receivedBytes: number, totalBytes: number) => void;
  public onComplete?: (metadata: FileMetadata, blob: Blob) => void;
  public onError?: (err: Error) => void;

  constructor(channel: RTCDataChannel) {
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event) => {
      this.handleMessage(event);
    };
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data) as { type: string; name?: string; size?: number; mimeType?: string };
        if (msg.type === "metadata" && msg.name && msg.size !== undefined) {
          this.metadata = {
            name: msg.name,
            size: msg.size,
            mimeType: msg.mimeType || "application/octet-stream",
          };
          this.chunks = [];
          this.receivedBytes = 0;
          if (this.onProgress) {
            this.onProgress(0, this.metadata.size);
          }
        } else if (msg.type === "eof") {
          this.finalizeTransfer();
        }
      } catch (err) {
        console.error("Failed to parse control message:", err);
        if (this.onError) {
          this.onError(err instanceof Error ? err : new Error("Parse error"));
        }
      }
    } else if (event.data instanceof ArrayBuffer) {
      if (!this.metadata) {
        console.error("Received binary chunk before metadata frame");
        return;
      }
      this.chunks.push(event.data);
      this.receivedBytes += event.data.byteLength;
      if (this.onProgress) {
        this.onProgress(this.receivedBytes, this.metadata.size);
      }
    }
  }

  private finalizeTransfer(): void {
    if (!this.metadata) return;

    // Integrity check (SPEC §4.3 verification)
    if (this.receivedBytes !== this.metadata.size) {
      const err = new Error(
        `File transfer integrity mismatch: expected ${this.metadata.size} bytes, received ${this.receivedBytes} bytes`
      );
      if (this.onError) {
        this.onError(err);
      }
      return;
    }

    const blob = new Blob(this.chunks, { type: this.metadata.mimeType });
    if (this.onComplete) {
      this.onComplete(this.metadata, blob);
    }

    // Reset state
    this.chunks = [];
    this.metadata = null;
  }
}

/**
 * Triggers a download in the browser. Decoupled helper that must be called
 * in a browser context.
 */
export function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 100);
}
