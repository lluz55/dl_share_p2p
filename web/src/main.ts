import { SignalingClient } from "./signaling.js";
import { PeerConnectionManager, ConnectionState } from "./peer.js";
import { sendFile, FileReceiver, triggerDownload } from "./transfer.js";
import QRCode from "qrcode";
import { Html5Qrcode } from "html5-qrcode";

// DOM Elements
const lobbySection = document.getElementById("lobby-section")!;
const roomSection = document.getElementById("room-section")!;
const errorBanner = document.getElementById("error-banner")!;

const createRoomBtn = document.getElementById("create-room-btn") as HTMLButtonElement;
const joinRoomInput = document.getElementById("join-room-input") as HTMLInputElement;
const joinRoomBtn = document.getElementById("join-room-btn") as HTMLButtonElement;

// Force input text to always be lowercase
joinRoomInput.addEventListener("input", () => {
  joinRoomInput.value = joinRoomInput.value.toLowerCase();
});

const roomCodeText = document.getElementById("room-code-text")!;
const copyCodeBtn = document.getElementById("copy-code-btn") as HTMLButtonElement;
const copyLinkBtn = document.getElementById("copy-link-btn") as HTMLButtonElement;
const leaveRoomBtn = document.getElementById("leave-room-btn") as HTMLButtonElement;

const statusBadge = document.getElementById("status-badge")!;
const statusText = document.getElementById("status-text")!;

const senderFlow = document.getElementById("sender-flow")!;
const receiverFlow = document.getElementById("receiver-flow")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const filePickerZone = document.getElementById("file-picker-zone")!;
const fileDetails = document.getElementById("file-details")!;
const sendFileBtn = document.getElementById("send-file-btn") as HTMLButtonElement;

const progressContainer = document.getElementById("progress-container")!;
const progressFilename = document.getElementById("progress-filename")!;
const progressBarFill = document.getElementById("progress-bar-fill")!;
const progressPercent = document.getElementById("progress-percent")!;
const progressBytes = document.getElementById("progress-bytes")!;

const peersSection = document.getElementById("peers-section")!;
const peersList = document.getElementById("peers-list")!;

const showQrBtn = document.getElementById("show-qr-btn") as HTMLButtonElement;
const scanQrBtn = document.getElementById("scan-qr-btn") as HTMLButtonElement;
const qrModal = document.getElementById("qr-modal")!;
const scannerModal = document.getElementById("scanner-modal")!;
const qrImage = document.getElementById("qr-image") as HTMLImageElement;
const qrModalCode = document.getElementById("qr-modal-code")!;
const closeQrBtn = document.getElementById("close-qr-btn") as HTMLButtonElement;
const closeScannerBtn = document.getElementById("close-scanner-btn") as HTMLButtonElement;
const scannerError = document.getElementById("scanner-error")!;

// State variables
let role: "host" | "guest" | null = null;
let currentFile: File | null = null;
let receiver: FileReceiver | null = null;
let guestTransferStartTime: number | null = null;
let html5QrCode: Html5Qrcode | null = null;
let scannerActive = false;

// Track active guests (only used when role === "host")
interface GuestInfo {
  channel: RTCDataChannel;
  state: ConnectionState;
  bytesSent: number;
  totalBytes: number;
  startTime?: number; // timestamp when sending started
  error?: string;
  complete?: boolean;
}
const activeGuests = new Map<string, GuestInfo>();

// Initialize components
const signaling = new SignalingClient();
const peerManager = new PeerConnectionManager(signaling);

// Utility: Show/hide error banner
function showError(msg: string): void {
  errorBanner.textContent = msg;
  errorBanner.style.display = "block";
}

function clearError(): void {
  errorBanner.textContent = "";
  errorBanner.style.display = "none";
}

// Utility: Format bytes into readable format
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Utility: Update connection status badge styling
function updateStatusBadge(state: "waiting" | "connecting" | "connected" | "failed", label: string): void {
  statusBadge.className = `status-badge status-${state}`;
  statusText.textContent = label;
}

// Host connection state helper
function updateHostGlobalStatus(): void {
  if (role !== "host") return;
  const connectedCount = Array.from(activeGuests.values()).filter(g => g.state === "connected").length;
  if (connectedCount > 0) {
    updateStatusBadge("connected", `Connected (${connectedCount} peer${connectedCount > 1 ? "s" : ""})`);
  } else {
    const connectingCount = Array.from(activeGuests.values()).filter(g => g.state === "connecting").length;
    if (connectingCount > 0) {
      updateStatusBadge("connecting", "Peers connecting...");
    } else {
      updateStatusBadge("waiting", "Waiting for peers...");
    }
  }
}

// Render dynamic list of peers (1-to-n)
function renderPeersList(): void {
  if (role !== "host") {
    peersSection.style.display = "none";
    return;
  }

  peersSection.style.display = "block";
  peersList.innerHTML = "";

  if (activeGuests.size === 0) {
    peersList.innerHTML = `<div class="waiting-placeholder">No peers connected yet. Share the code above to allow guests to join.</div>`;
    return;
  }

  activeGuests.forEach((info, peerId) => {
    const item = document.createElement("div");
    item.className = "peer-item";

    const header = document.createElement("div");
    header.className = "peer-header";

    const nameSpan = document.createElement("span");
    nameSpan.className = "peer-id";
    nameSpan.textContent = `Guest (${peerId.substring(0, 6)})`;

    const statusSpan = document.createElement("span");
    statusSpan.className = "peer-status";
    statusSpan.textContent = info.state.toUpperCase();

    if (info.state === "connected") {
      statusSpan.style.color = "var(--success-color)";
    } else if (info.state === "failed") {
      statusSpan.style.color = "var(--error-color)";
    } else if (info.state === "connecting") {
      statusSpan.style.color = "var(--warning-color)";
    }

    header.appendChild(nameSpan);
    header.appendChild(statusSpan);
    item.appendChild(header);

    // Render individual progress bar if active/complete/error
    if (info.totalBytes > 0) {
      const progressWrapper = document.createElement("div");
      progressWrapper.className = "progress-bar-wrapper";
      progressWrapper.style.marginTop = "8px";

      const pct = Math.round((info.bytesSent / info.totalBytes) * 100);

      const fill = document.createElement("div");
      fill.className = "progress-bar-fill";
      fill.style.width = `${pct}%`;

      progressWrapper.appendChild(fill);
      item.appendChild(progressWrapper);

      const stats = document.createElement("div");
      stats.className = "progress-stats";

      let detail = `${formatBytes(info.bytesSent)} / ${formatBytes(info.totalBytes)}`;
      if (info.complete) {
        detail = "Completed";
        stats.style.color = "var(--success-color)";
      } else if (info.error) {
        detail = `Failed: ${info.error}`;
        stats.style.color = "var(--error-color)";
      } else {
        detail += ` (${pct}%)`;
        const elapsed = info.startTime ? (Date.now() - info.startTime) / 1000 : 0;
        const speed = elapsed > 0 ? info.bytesSent / elapsed : 0;
        const remainingBytes = info.totalBytes - info.bytesSent;
        const eta = speed > 0 ? Math.round(remainingBytes / speed) : 0;
        if (speed > 0) {
          detail += ` @ ${formatBytes(speed)}/s | ETA: ${eta}s`;
        }
      }

      const statSpan = document.createElement("span");
      statSpan.textContent = detail;
      stats.appendChild(statSpan);
      item.appendChild(stats);
    }

    peersList.appendChild(item);
  });
}

// Update sender UI based on state
function updateSenderUI(): void {
  const hasConnectedGuests = Array.from(activeGuests.values()).some(g => g.state === "connected");
  if (hasConnectedGuests && currentFile) {
    sendFileBtn.disabled = false;
  } else {
    sendFileBtn.disabled = true;
  }
}

// Helper functions for QR and scanning
function parseRoomCodeFromUrlOrString(input: string): string | null {
  try {
    const url = new URL(input);
    const params = new URLSearchParams(url.search);
    const room = params.get("room");
    if (room) return room.trim().toLowerCase();
  } catch (e) {
    // Not a URL
  }
  
  const clean = input.trim().toLowerCase();
  if (clean.split("-").length === 3) {
    return clean;
  }
  return null;
}

function stopScanner(): Promise<void> {
  if (html5QrCode && scannerActive) {
    scannerActive = false;
    return html5QrCode.stop().then(() => {
      html5QrCode = null;
    }).catch(err => {
      console.error("Failed to stop scanner", err);
      html5QrCode = null;
    });
  }
  return Promise.resolve();
}

// Reset UI state to lobby
function resetToLobby(): void {
  role = null;
  currentFile = null;
  receiver = null;
  activeGuests.clear();
  fileInput.value = "";
  fileDetails.textContent = "Click to browse your files";
  sendFileBtn.disabled = true;

  // Close any active modals and stop scanner
  qrModal.classList.remove("active");
  scannerModal.classList.remove("active");
  stopScanner();

  lobbySection.classList.add("active");
  roomSection.classList.remove("active");
  progressContainer.style.display = "none";
  senderFlow.style.display = "none";
  receiverFlow.style.display = "none";
  peersSection.style.display = "none";
}

// Copy room code event
copyCodeBtn.addEventListener("click", () => {
  const code = roomCodeText.textContent || "";
  if (code && code !== "...") {
    navigator.clipboard.writeText(code)
      .then(() => {
        const originalText = copyCodeBtn.textContent;
        copyCodeBtn.textContent = "Copied!";
        copyCodeBtn.disabled = true;
        setTimeout(() => {
          copyCodeBtn.textContent = originalText;
          copyCodeBtn.disabled = false;
        }, 2000);
      })
      .catch((err) => {
        console.error("Failed to copy code to clipboard", err);
      });
  }
});

// Copy share link event
copyLinkBtn.addEventListener("click", () => {
  const code = roomCodeText.textContent || "";
  if (code && code !== "...") {
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${code}`;
    navigator.clipboard.writeText(shareUrl)
      .then(() => {
        const originalText = copyLinkBtn.textContent;
        copyLinkBtn.textContent = "Link Copied!";
        copyLinkBtn.disabled = true;
        setTimeout(() => {
          copyLinkBtn.textContent = originalText;
          copyLinkBtn.disabled = false;
        }, 2000);
      })
      .catch((err) => {
        console.error("Failed to copy link to clipboard", err);
      });
  }
});

// Create Room Action
createRoomBtn.addEventListener("click", () => {
  clearError();
  signaling.onOpen = () => {
    signaling.createRoom();
  };
  signaling.connect();
});

// Join Room Action
joinRoomBtn.addEventListener("click", () => {
  const code = joinRoomInput.value.trim().toLowerCase();
  if (!code) {
    showError("Please enter a valid room code.");
    return;
  }
  clearError();
  signaling.onOpen = () => {
    signaling.joinRoom(code);
  };
  signaling.connect();
});

// Leave Room Action
leaveRoomBtn.addEventListener("click", () => {
  signaling.close();
  peerManager.closeAll();
  resetToLobby();
});

// File picker interactions


fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files.length > 0) {
    currentFile = fileInput.files[0];
    fileDetails.textContent = `${currentFile.name} (${formatBytes(currentFile.size)})`;
    updateSenderUI();
  }
});

// Send File Action (1-to-n parallel execution)
sendFileBtn.addEventListener("click", () => {
  if (role !== "host" || !currentFile) return;

  const connectedGuests = Array.from(activeGuests.entries()).filter(
    ([_, info]) => info.state === "connected" && info.channel.readyState === "open"
  );

  if (connectedGuests.length === 0) return;

  sendFileBtn.disabled = true;

  const transferPromises = connectedGuests.map(([peerId, info]) => {
    info.bytesSent = 0;
    info.totalBytes = currentFile!.size;
    info.complete = false;
    info.error = undefined;
    renderPeersList();

    return sendFile(info.channel, currentFile!, (sentBytes, totalBytes) => {
      info.bytesSent = sentBytes;
      info.totalBytes = totalBytes;
      if (sentBytes === totalBytes) {
        info.complete = true;
      }
      renderPeersList();
    }).catch((err: Error) => {
      info.error = err.message || "Failed";
      renderPeersList();
      throw err;
    });
  });

  Promise.allSettled(transferPromises).then(() => {
    sendFileBtn.disabled = false;
    updateSenderUI();
  });
});

// Signaling connection callbacks
signaling.onJoined = (data) => {
  peerManager.handleJoined(data.self, data.role);
  role = data.role;
  roomCodeText.textContent = data.room;
  lobbySection.classList.remove("active");
  roomSection.classList.add("active");

  if (role === "host") {
    senderFlow.style.display = "block";
    receiverFlow.style.display = "none";
    peersSection.style.display = "block";
    renderPeersList();
  } else {
    senderFlow.style.display = "none";
    receiverFlow.style.display = "block";
    peersSection.style.display = "none";
  }

  updateStatusBadge("waiting", "Waiting for peers...");
};

signaling.onPeerJoined = (peerId) => {
  peerManager.handlePeerJoined(peerId);
  updateStatusBadge("connecting", "Peer joining, connecting...");
};

signaling.onPeerLeft = (peerId) => {
  peerManager.handlePeerLeft(peerId);
  if (role === "host") {
    activeGuests.delete(peerId);
    renderPeersList();
    updateHostGlobalStatus();
    updateSenderUI();
  }
};

signaling.onError = (reason) => {
  showError(reason);
  if (!roomSection.classList.contains("active")) {
    signaling.close();
    resetToLobby();
  }
};

signaling.onClose = () => {
  peerManager.closeAll();
  resetToLobby();
};

// Peer connection manager callbacks
peerManager.onConnectionStateChange = (peerId, state) => {
  console.log(`Connection state with peer ${peerId} changed to ${state}`);

  if (role === "host") {
    const info = activeGuests.get(peerId);
    if (info) {
      info.state = state;
      if (state === "closed" || state === "disconnected") {
        activeGuests.delete(peerId);
      }
    }
    renderPeersList();
    updateHostGlobalStatus();
    updateSenderUI();
  } else {
    // Guest logic: single remote peer (Host)
    switch (state) {
      case "connecting":
        updateStatusBadge("connecting", "Connecting (Direct P2P)...");
        break;
      case "connected":
        updateStatusBadge("connected", "Connected (Direct P2P)");
        break;
      case "failed":
        updateStatusBadge("failed", "Direct connection failed.");
        showError("Direct connection could not be established. Falling back is not supported in Phase 1.");
        break;
      case "disconnected":
      case "closed":
        updateStatusBadge("waiting", "Waiting for peers...");
        progressContainer.style.display = "none";
        break;
    }
  }
};

peerManager.onDataChannel = (peerId, channel) => {
  console.log(`DataChannel established with peer ${peerId}`);

  if (role === "host") {
    activeGuests.set(peerId, {
      channel,
      state: "connected",
      bytesSent: 0,
      totalBytes: 0,
    });
    renderPeersList();
    updateHostGlobalStatus();
    updateSenderUI();

    channel.onopen = () => {
      const info = activeGuests.get(peerId);
      if (info) {
        info.state = "connected";
      }
      renderPeersList();
      updateHostGlobalStatus();
      updateSenderUI();
    };

    channel.onclose = () => {
      activeGuests.delete(peerId);
      renderPeersList();
      updateHostGlobalStatus();
      updateSenderUI();
    };
  } else {
    // Guest prepares to receive files from Host
    receiver = new FileReceiver(channel);

    receiver.onProgress = (receivedBytes, totalBytes) => {
      progressContainer.style.display = "block";
      progressFilename.textContent = `Receiving file...`;
      
      if (receivedBytes === 0 || !guestTransferStartTime) {
        guestTransferStartTime = Date.now();
      }

      const pct = Math.round((receivedBytes / totalBytes) * 100);
      progressBarFill.style.width = `${pct}%`;
      progressPercent.textContent = `${pct}%`;

      const elapsed = (Date.now() - guestTransferStartTime) / 1000;
      const speed = elapsed > 0 ? receivedBytes / elapsed : 0;
      const remainingBytes = totalBytes - receivedBytes;
      const eta = speed > 0 ? Math.round(remainingBytes / speed) : 0;

      let statsText = `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)}`;
      if (speed > 0) {
        statsText += ` @ ${formatBytes(speed)}/s | ETA: ${eta}s`;
      }
      progressBytes.textContent = statsText;
    };

    receiver.onComplete = (metadata, blob) => {
      progressFilename.textContent = `Completed: ${metadata.name}`;
      progressBarFill.style.width = "100%";
      progressPercent.textContent = "100%";
      guestTransferStartTime = null; // Reset transfer clock
      triggerDownload(blob, metadata.name);
    };

    receiver.onError = (err) => {
      showError(`Transfer error: ${err.message}`);
      guestTransferStartTime = null;
    };
  }
};

// QR Code Show Action
showQrBtn.addEventListener("click", () => {
  const code = roomCodeText.textContent || "";
  if (code && code !== "...") {
    const shareUrl = `${window.location.origin}${window.location.pathname}?room=${code}`;
    QRCode.toDataURL(shareUrl, { width: 400, margin: 2 })
      .then(url => {
        qrImage.src = url;
        qrModalCode.textContent = code;
        qrModal.classList.add("active");
      })
      .catch(err => {
        console.error("Failed to generate QR Code", err);
        showError("Failed to generate QR Code.");
      });
  }
});

// Close QR Modal Action
closeQrBtn.addEventListener("click", () => {
  qrModal.classList.remove("active");
});

// QR Code Scanner Action
scanQrBtn.addEventListener("click", () => {
  clearError();
  scannerError.style.display = "none";
  scannerModal.classList.add("active");

  html5QrCode = new Html5Qrcode("scanner-preview");
  scannerActive = true;
  html5QrCode.start(
    { facingMode: "environment" },
    {
      fps: 10,
      qrbox: { width: 220, height: 220 }
    },
    (decodedText) => {
      const code = parseRoomCodeFromUrlOrString(decodedText);
      if (code) {
        stopScanner().then(() => {
          scannerModal.classList.remove("active");
          joinRoomInput.value = code;
          // Connect to the room automatically
          clearError();
          signaling.onOpen = () => {
            signaling.joinRoom(code);
          };
          signaling.connect();
        });
      }
    },
    () => {
      // Silent error handler (called for every frame scanned without QR code)
    }
  ).catch(err => {
    console.error("Failed to start QR scanner", err);
    scannerError.textContent = "Could not access camera. Please check permissions.";
    scannerError.style.display = "block";
    scannerActive = false;
  });
});

// Close Scanner Action
closeScannerBtn.addEventListener("click", () => {
  stopScanner().then(() => {
    scannerModal.classList.remove("active");
  });
});

// Check if a room code is passed in the URL query parameter on page load
window.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  if (room) {
    const cleanRoom = room.trim().toLowerCase();
    joinRoomInput.value = cleanRoom;
    // Auto-join the room
    clearError();
    signaling.onOpen = () => {
      signaling.joinRoom(cleanRoom);
    };
    signaling.connect();
  }
});
