import { SIGNALING_URL } from "./config.js";

// Message structures for protocol parity with the server.
export interface JoinMessage {
  type: "join";
  room?: string;
}

export interface OfferMessage {
  type: "offer";
  room?: string;
  to: string;
  sdp: unknown;
}

export interface AnswerMessage {
  type: "answer";
  room?: string;
  to: string;
  sdp: unknown;
}

export interface IceMessage {
  type: "ice";
  room?: string;
  to: string;
  candidate: unknown;
}

export type OutboundMessage = JoinMessage | OfferMessage | AnswerMessage | IceMessage;

export interface JoinedMessage {
  type: "joined";
  room: string;
  self: string;
  role: "host" | "guest";
  peers: string[];
}

export interface PeerJoinedMessage {
  type: "peer-joined";
  id: string;
}

export interface PeerLeftMessage {
  type: "peer-left";
  id: string;
}

export interface ErrorMessage {
  type: "error";
  reason: string;
}

export interface InboundOfferMessage {
  type: "offer";
  from: string;
  sdp: unknown;
}

export interface InboundAnswerMessage {
  type: "answer";
  from: string;
  sdp: unknown;
}

export interface InboundIceMessage {
  type: "ice";
  from: string;
  candidate: unknown;
}

export type InboundMessage =
  | JoinedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | ErrorMessage
  | InboundOfferMessage
  | InboundAnswerMessage
  | InboundIceMessage;

// Handlers for client consumers
export type OpenHandler = () => void;
export type JoinedHandler = (data: JoinedMessage) => void;
export type PeerJoinedHandler = (peerId: string) => void;
export type PeerLeftHandler = (peerId: string) => void;
export type OfferHandler = (from: string, sdp: unknown) => void;
export type AnswerHandler = (from: string, sdp: unknown) => void;
export type IceHandler = (from: string, candidate: unknown) => void;
export type ErrorHandler = (reason: string) => void;
export type CloseHandler = () => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private lastRoom: string | null = null;
  private isExplicitClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;

  public onOpen?: OpenHandler;
  public onJoined?: JoinedHandler;
  public onPeerJoined?: PeerJoinedHandler;
  public onPeerLeft?: PeerLeftHandler;
  public onOffer?: OfferHandler;
  public onAnswer?: AnswerHandler;
  public onIce?: IceHandler;
  public onError?: ErrorHandler;
  public onClose?: CloseHandler;

  constructor(url: string = SIGNALING_URL) {
    this.url = url;
  }

  /**
   * Connect to the WebSocket signaling server.
   */
  public connect(): void {
    this.isExplicitClose = false;
    if (this.ws) {
      this.close();
    }

    try {
      this.ws = new WebSocket(this.url);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Failed to initialize WebSocket";
      if (this.onError) {
        this.onError(errMsg);
      }
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.onOpen) {
        this.onOpen();
      }
      // Auto-rejoin if we were disconnected mid-session
      if (this.lastRoom) {
        console.log(`Auto-rejoining signaling room: ${this.lastRoom}`);
        this.joinRoom(this.lastRoom);
      }
    };

    this.ws.onclose = () => {
      if (this.onClose) {
        this.onClose();
      }
      this.ws = null;
      if (!this.isExplicitClose) {
        this.attemptReconnect();
      }
    };

    this.ws.onerror = () => {
      if (this.onError) {
        this.onError("WebSocket connection error");
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        this.handleMessage(event.data);
      }
    };
  }

  private attemptReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
    this.reconnectAttempts++;
    console.log(`Signaling connection dropped. Attempting reconnect in ${delay}ms... (attempt ${this.reconnectAttempts})`);
    
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Close the WebSocket connection.
   */
  public close(): void {
    this.isExplicitClose = true;
    this.lastRoom = null;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private handleMessage(dataStr: string): void {
    try {
      const msg = JSON.parse(dataStr) as InboundMessage;
      if (!msg || typeof msg.type !== "string") {
        return;
      }

      switch (msg.type) {
        case "joined":
          this.lastRoom = msg.room; // Track last room code
          if (this.onJoined) this.onJoined(msg);
          break;
        case "peer-joined":
          if (this.onPeerJoined) this.onPeerJoined(msg.id);
          break;
        case "peer-left":
          if (this.onPeerLeft) this.onPeerLeft(msg.id);
          break;
        case "offer":
          if (this.onOffer) this.onOffer(msg.from, msg.sdp);
          break;
        case "answer":
          if (this.onAnswer) this.onAnswer(msg.from, msg.sdp);
          break;
        case "ice":
          if (this.onIce) this.onIce(msg.from, msg.candidate);
          break;
        case "error":
          if (this.onError) this.onError(msg.reason);
          break;
        default:
          console.warn("Unknown inbound signaling message type:", (msg as { type: string }).type);
      }
    } catch (err) {
      console.error("Failed to parse inbound signaling message:", err, dataStr);
    }
  }

  private send(msg: OutboundMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.onError) {
        this.onError("Cannot send message: WebSocket is not open");
      }
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Create a new room as host.
   */
  public createRoom(): void {
    this.send({ type: "join" });
  }

  /**
   * Join an existing room as guest.
   */
  public joinRoom(roomCode: string): void {
    this.send({ type: "join", room: roomCode });
  }

  /**
   * Send a WebRTC offer to a target peer.
   */
  public sendOffer(to: string, sdp: unknown): void {
    this.send({ type: "offer", to, sdp });
  }

  /**
   * Send a WebRTC answer to a target peer.
   */
  public sendAnswer(to: string, sdp: unknown): void {
    this.send({ type: "answer", to, sdp });
  }

  /**
   * Send an ICE candidate to a target peer.
   */
  public sendIce(to: string, candidate: unknown): void {
    this.send({ type: "ice", to, candidate });
  }
}
