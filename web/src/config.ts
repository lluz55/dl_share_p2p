// Signaling server URL. Always wss:// in production (SPEC §8).
//
// Override at deploy time — two supported mechanisms:
//   1. Build-time: pass --define:__SIGNALING_URL__='"wss://your-tunnel.trycloudflare.com/ws"'
//      to the esbuild command (see build.ts).
//   2. Runtime:   set window.__SIGNALING_URL__ in index.html before the bundle loads.
//      Example: <script>window.__SIGNALING_URL__ = "wss://your-tunnel.trycloudflare.com/ws"</script>
//
// Never hardcode a production URL here. The localhost fallback is dev-only.
declare const __SIGNALING_URL__: string | undefined;

export const SIGNALING_URL: string =
  (typeof __SIGNALING_URL__ !== "undefined" && __SIGNALING_URL__) ||
  (typeof window !== "undefined" &&
    (window as unknown as { __SIGNALING_URL__?: string }).__SIGNALING_URL__) ||
  "ws://127.0.0.1:18085/ws"; // dev fallback only — override before deploying

// Swappable ICE server list (SPEC §4.2). Extensible without touching Peer code.
export const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};
