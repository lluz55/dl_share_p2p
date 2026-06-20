# Task 06 — Frontend file transfer

- **Phase:** 1
- **Status:** Done
- **Depends on:** 05
- **SPEC references:** §4.3 (direct P2P), §5

## Objective

Implement `web/src/transfer.ts`: send a file over an open `DataChannel` (from task
05) with chunking and backpressure, and on the receiving side reassemble it and
trigger a browser download. Show progress on both sides.

## In scope

- `web/src/transfer.ts` — sender and receiver logic over a `DataChannel`.
- Chunking with **backpressure** via `bufferedAmount` /
  `bufferedAmountLowThreshold` (SPEC §4.3).
- A small framing protocol for file metadata + chunks + end-of-file.
- Progress reporting callbacks for the UI (task 07).

## Requirements

1. **Framing:** define a minimal protocol over the DataChannel, e.g.:
   - a metadata message (name, size, type, total chunks) before bytes,
   - binary chunk messages,
   - an end/complete marker.
   Keep it simple and documented in-file. Binary chunks SHOULD use
   `ArrayBuffer`/`Uint8Array`.
2. **Backpressure (SPEC §4.3):** monitor `dataChannel.bufferedAmount`; pause
   sending when it exceeds a high-water mark and resume on
   `bufferedAmountLow`/threshold. Pick a chunk size that works reliably across
   browsers (document the value; typical 16–64 KB).
3. **Receiver:** accept metadata, collect chunks in order, reassemble into a
   `Blob`, and trigger download (e.g. object URL + anchor click). Free the object
   URL after.
4. **Progress:** emit progress (bytes sent/received, percent) on both sender and
   receiver for the UI. Show on both sides (SPEC §4.3).
5. **Direct P2P only:** this transfer requires **no authentication** and the
   server does not observe the data (SPEC §4.3). Do not add any auth or
   relay-aware branching here.
6. **Integrity (SHOULD):** include the declared size and verify the reassembled
   length matches; optionally a checksum. Note any deviation.

## Out of scope

- Relay transfer path → task 14 (and its auth is unresolved, SPEC §11.1).
- Multi-guest fan-out orchestration → task 09 (but the transfer API SHOULD take a
  target DataChannel/peer so 09 can reuse it per guest without changes).

## Acceptance criteria

- A file selected on the host transfers to the guest and downloads correctly
  (byte-identical; verify with a hash on a test file).
- Large file (e.g. ≥100 MB) transfers without unbounded memory growth on the
  sender thanks to backpressure (no runaway `bufferedAmount`).
- Progress updates fire on both sides and reach 100% on completion.
- TypeScript compiles under `strict`.

## Notes

- Keep `transfer.ts` decoupled from the DOM; expose progress via callbacks/events
  so task 07 owns the UI.
- Don't assume order guarantees beyond what the DataChannel provides; default
  WebRTC DataChannel is ordered+reliable — rely on that unless you document
  otherwise.
