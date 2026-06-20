import { RTC_CONFIGURATION } from "./config.js";
import { SignalingClient } from "./signaling.js";

export type ConnectionState = "connecting" | "connected" | "failed" | "disconnected" | "closed";

export class PeerConnectionManager {
  private readonly signaling: SignalingClient;
  private readonly connections = new Map<string, RTCPeerConnection>();
  private role: "host" | "guest" | null = null;
  private selfId: string | null = null;

  // Callbacks for consumption by upper layers (UI & file transfer)
  public onConnectionStateChange?: (peerId: string, state: ConnectionState) => void;
  public onDataChannel?: (peerId: string, channel: RTCDataChannel) => void;

  constructor(signaling: SignalingClient) {
    this.signaling = signaling;
    this.setupSignalingListeners();
  }

  /** Called by main.ts when the joined message arrives (role + selfId setup). */
  public handleJoined(selfId: string, role: "host" | "guest"): void {
    this.selfId = selfId;
    this.role = role;
  }

  /** Called by main.ts when a peer joins. Host initiates WebRTC. */
  public handlePeerJoined(peerId: string): void {
    if (this.role === "host") {
      void this.initiateConnection(peerId);
    }
  }

  /** Called by main.ts when a peer leaves. */
  public handlePeerLeft(peerId: string): void {
    this.closeConnection(peerId);
  }

  private setupSignalingListeners(): void {
    this.signaling.onOffer = async (fromId, sdp) => {
      try {
        let pc = this.connections.get(fromId);
        if (!pc) {
          pc = this.createPeerConnection(fromId);
        }
        await pc.setRemoteDescription(new RTCSessionDescription(sdp as RTCSessionDescriptionInit));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signaling.sendAnswer(fromId, answer);
      } catch (err) {
        console.error("Failed to handle offer from peer:", fromId, err);
        this.handleStateChange(fromId, "failed");
      }
    };

    this.signaling.onAnswer = async (fromId, sdp) => {
      try {
        const pc = this.connections.get(fromId);
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp as RTCSessionDescriptionInit));
        }
      } catch (err) {
        console.error("Failed to handle answer from peer:", fromId, err);
        this.handleStateChange(fromId, "failed");
      }
    };

    this.signaling.onIce = async (fromId, candidate) => {
      try {
        const pc = this.connections.get(fromId);
        if (pc) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate as RTCIceCandidateInit));
        }
      } catch (err) {
        console.error("Failed to add ICE candidate from peer:", fromId, err);
      }
    };
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection(RTC_CONFIGURATION);
    this.connections.set(peerId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIce(peerId, event.candidate);
      }
    };

    pc.onconnectionstatechange = () => {
      this.handleStateChange(peerId, pc.connectionState);
    };

    // For Guest: receive data channel initiated by Host
    pc.ondatachannel = (event) => {
      if (this.onDataChannel) {
        this.onDataChannel(peerId, event.channel);
      }
    };

    return pc;
  }

  private async initiateConnection(peerId: string): Promise<void> {
    try {
      const pc = this.createPeerConnection(peerId);

      // Host creates the DataChannel
      const channel = pc.createDataChannel("file-transfer", {
        ordered: true,
      });

      if (this.onDataChannel) {
        this.onDataChannel(peerId, channel);
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signaling.sendOffer(peerId, offer);
    } catch (err) {
      console.error("Failed to initiate connection to peer:", peerId, err);
      this.handleStateChange(peerId, "failed");
    }
  }

  private handleStateChange(peerId: string, state: RTCPeerConnectionState | ConnectionState): void {
    if (this.onConnectionStateChange) {
      let mappedState: ConnectionState;
      switch (state) {
        case "new":
        case "connecting":
          mappedState = "connecting";
          break;
        case "connected":
          mappedState = "connected";
          break;
        case "disconnected":
          mappedState = "disconnected";
          break;
        case "failed":
          mappedState = "failed";
          break;
        case "closed":
          mappedState = "closed";
          break;
        default:
          mappedState = state as ConnectionState;
      }
      this.onConnectionStateChange(peerId, mappedState);
    }
  }

  /**
   * Close a specific peer connection.
   */
  public closeConnection(peerId: string): void {
    const pc = this.connections.get(peerId);
    if (pc) {
      pc.close();
      this.connections.delete(peerId);
      this.handleStateChange(peerId, "closed");
    }
  }

  /**
   * Close all active peer connections.
   */
  public closeAll(): void {
    for (const peerId of this.connections.keys()) {
      this.closeConnection(peerId);
    }
  }
}
