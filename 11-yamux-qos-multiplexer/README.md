# QoS-Lane Stream Multiplexer (Yamux)

## Problem

A single long-lived connection (a WebSocket, a TCP socket) often has to carry many independent logical conversations at once: an authentication handshake, a bulk blob transfer, a stream of small chat messages, and a periodic keepalive ping. If they all share one byte stream naively, two problems appear:

1. **Head-of-line blocking.** A 10 MB blob transfer monopolizes the pipe, and the tiny, latency-sensitive auth message or keepalive ping queues behind it.
2. **No structure.** The receiver cannot tell where one logical message ends and the next begins, nor which conversation a given chunk belongs to.

*Multiplexing* solves structure: split the connection into independent **streams**, each framed so the receiver can demultiplex them. **Quality of Service (QoS)** solves head-of-line blocking: assign each stream to a priority **lane** so urgent traffic can be scheduled ahead of bulk traffic.

This guide implements both over the Yamux wire format, with a twist that makes routing cheap: **the QoS lane is encoded directly into the stream ID**, so a receiver can route a frame to the right priority queue by reading 4 bytes of the header — without parsing or decrypting the payload.

## Design decisions

**Why Yamux framing?**
Yamux is a small, well-understood multiplexing format: a fixed 12-byte header followed by an optional payload. The header carries everything needed to demultiplex — version, frame type, flags, stream ID, and length — and nothing else. A fixed header means the receiver can always read exactly 12 bytes, learn the payload length, and wait for exactly that many more bytes. No delimiter scanning, no ambiguity.

**The 12-byte header:**
```
[0]      version  — always 0x00
[1]      type     — 0=DATA, 1=WINDOW_UPDATE, 2=PING, 3=GO_AWAY
[2..3]   flags    — uint16 BE: SYN=0x0001 ACK=0x0002 FIN=0x0004 RST=0x0008
[4..7]   streamId — uint32 BE  (upper nibble = QoS lane 1..8)
[8..11]  length   — uint32 BE  (DATA: payload byte count; PING: opaque value)
```
All multi-byte fields are big-endian (network byte order).

**Why pack the lane into the stream ID instead of a separate field?**
The stream ID is a 32-bit number that already has to be in every frame. By reserving the **upper nibble (bits 28–31)** for the lane (1–8) and using the **lower 28 bits** for the per-stream sequence, the lane travels for free — no extra header bytes — and a receiver extracts it with a single shift: `lane = (streamId >>> 28) & 0xF`. Encoding is the inverse: `streamId = ((lane & 0xF) << 28) | (seq & 0x0FFFFFFF)`. This keeps 268 million stream IDs per lane, far more than any connection needs.

**Why odd/even stream IDs?**
Both ends of a connection can open streams concurrently. To avoid ID collisions without a negotiation round-trip, the initiator uses **odd** sequence numbers and the responder uses **even** ones. A stream ID therefore unambiguously identifies both *which* stream and *who opened it*.

**Why a priority scheduler over the lanes?**
Encoding the lane is only half the story; the sender must also *act* on priority. The scheduler drains ready streams highest-lane-priority first (auth/identity before bulk vault transfers before keepalive), so a saturated link still delivers urgent frames promptly. Each lane additionally has a **token bucket** for fairness: a lane can burst up to its capacity, then must wait for periodic refills, which prevents a single high-priority lane from starving everything below it forever.

**Why token-bucket flow control (capacity 64, refill 8)?**
The bucket gives bounded burstiness. A stream may send while it has tokens (one per frame); when the bucket empties, `send` returns `false` (backpressure) instead of queueing unboundedly. A periodic `refillTokens()` adds a fixed quantum (8) up to the cap (64). This is simple, allocation-free, and degrades gracefully: a fast producer is throttled to the refill rate rather than exhausting memory.

**Why a `FrameSplitter` between the socket and the session?**
A byte transport delivers arbitrary chunks — a single read may contain half a frame, three frames, or a frame split across two reads. The splitter buffers bytes, peeks the length field once 12 bytes are available, and emits a complete `YamuxFrame` only when the full `12 + length` bytes have arrived. This cleanly separates "bytes on the wire" from "frames in the protocol."

**Why SYN/ACK/FIN/RST flags?**
They give a minimal stream lifecycle without a heavyweight handshake. `SYN` opens a stream (the receiver auto-`ACK`s and surfaces it), `FIN` half-closes one direction (the stream stays readable until both sides FIN), and `RST` aborts immediately. This supports the common request/response and streaming patterns with four bits.

## Algorithm

```
OPEN(lane):
  seq = nextStreamId; nextStreamId += 2          // odd for initiator, even for responder
  streamId = (lane << 28) | (seq & 0x0FFFFFFF)
  send DATA frame {flags: SYN, streamId, length: 0}
  return stream

WRITE(stream, data):
  if tokenBucket[stream.lane] <= 0: return false  // backpressure
  tokenBucket[stream.lane] -= 1
  send DATA frame {flags: 0, streamId, length: data.len, data}

RECEIVE(chunk):
  for frame in FrameSplitter.push(chunk):
    lane = (frame.streamId >>> 28) & 0xF          // route without reading payload
    dispatch frame by type (DATA/PING/GO_AWAY) and flags (SYN/ACK/FIN/RST)

SCHEDULE():                                        // drain in priority order
  for lane in lanes sorted by priority desc:
    while lane has a ready frame and tokenBucket[lane] > 0:
      emit frame; tokenBucket[lane] -= 1

REFILL(): for each lane: tokenBucket[lane] = min(CAP, tokenBucket[lane] + QUANTUM)
```

## Reference implementation

See [`yamux-qos-mux.ts`](./yamux-qos-mux.ts) in this directory. It implements frame encode/decode, the `FrameSplitter`, the lane↔streamId codec, a `YamuxSession` with the SYN/ACK/FIN/RST lifecycle and ping/pong, and a token-bucket priority scheduler. No external dependencies — pure `Uint8Array`/`DataView`.

## Usage

```typescript
import { YamuxSession, LANES } from "./yamux-qos-mux.js";

// Wire two sessions back-to-back (in real use, send/receive cross a socket).
const a = new YamuxSession(bytes => b.receive(bytes), true);   // initiator (odd IDs)
const b = new YamuxSession(bytes => a.receive(bytes), false);  // responder (even IDs)

b.onNewStream = (stream) => {
  stream.onData = (data) => console.log(`lane ${stream.laneId}:`, new TextDecoder().decode(data));
};

const auth = a.openStream(LANES.IDENTITY);   // high-priority lane
a.writeStream(auth, new TextEncoder().encode("login"));

const bulk = a.openStream(LANES.VAULT);      // bulk lane, scheduled behind auth
a.writeStream(bulk, bigBlob);
```

## Limitations and extensions

- **Eight lanes is a design choice, not a limit.** The upper nibble gives 16 possible lane values; this design uses 1–8 and treats 0/unknown as a default lane. Widen the field if you need more.
- **Token bucket is per-lane, not per-stream.** Two greedy streams in the same lane share one bucket. Add per-stream sub-buckets if intra-lane fairness matters.
- **WINDOW_UPDATE is a no-op here.** When the underlying transport (e.g. a WebSocket) already provides flow control and backpressure, per-stream credit windows are redundant; over a raw socket you would implement them.
- **No encryption in this layer.** Multiplexing and confidentiality are orthogonal. Run the multiplexer over TLS, or layer per-stream encryption on the payload, depending on your trust model.
- **Scheduling is cooperative.** The scheduler assumes the sender calls `schedule()`/`refillTokens()` on a timer. Under extreme load you may want a dedicated drain loop and a bounded per-lane queue with shedding.
