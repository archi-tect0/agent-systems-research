# In-Stream Sub-Channel Multiplexer with Flow Control

## Problem

A connection-level multiplexer already lets one socket carry many independent streams, each on its own QoS lane (see guide 11). But *inside* a single one of those streams there is often a second mixing problem. A single virtual channel may need to carry, simultaneously:

- tiny **control** frames (flow signals, acks, pings) that must arrive promptly,
- large **data** frames (bulk payloads, file chunks) that dominate the byte budget,
- **tool** request/response frames,
- periodic **pulse** / heartbeat frames,
- speculative **prefetch** frames that should yield to everything else.

If these all share the one channel's byte budget naively, a burst of large data frames will sit in front of a small control frame, and the control frame — the one with a latency deadline — waits behind megabytes of bulk. This is head-of-line blocking *within* a stream, one layer below the connection multiplexer.

This guide implements a **streaming-layer sub-channel multiplexer**: a fixed binary header tags every frame with a sub-channel id, and a priority drain with per-channel token buckets ensures small control frames are flushed promptly and are never starved by large data frames under backpressure. It is deliberately distinct from the connection-level lane mux of guide 11 — this sublayer subdivides *one* virtual channel into prioritized sub-channels.

## Design decisions

**Why a fixed 16-byte binary header?**
A fixed-size header means the receiver can always read exactly 16 bytes, learn the sub-channel and the payload length, and then read exactly that many more bytes — no delimiter scanning, no ambiguity about where a frame ends. The header packs flags (uint32), sequence (uint32), the sub-channel id (uint8), three reserved zero bytes, and the payload length (uint32), all little-endian. The reserved bytes are validated as zero on decode so a future revision can claim them without silently misparsing old frames.

**Why separate `enqueue` from `drain` instead of sending on the spot?**
The key to never starving control frames is to decide *send order* across channels at flush time, not at offer time. If `enqueue` sent immediately, ten large data frames offered before a control frame would already be on the wire before control had a chance. By buffering offers per channel and choosing what to flush in `drain()`, the muxer can always serve the highest-priority channel first regardless of the order frames were produced.

**Why a priority drain ordered control-first?**
Each sub-channel has a static drain priority (`CTRL < PULSE < TOOL < DATA < PREFETCH`). `drain()` visits channels in that order and flushes each channel's queued frames while it still has tokens. Because control is visited first every round, a queued control frame is emitted ahead of any queued data frame in the same round — even if the data was enqueued earlier. Bulk data drains only after the latency-sensitive channels have been served.

**Why per-channel token buckets on top of the priority order?**
Priority alone could let a busy high-priority channel monopolize the link; token buckets bound how much any single channel may burst per round. Each channel starts with a bucket capacity, spends one token per frame flushed, and is refilled a fixed quantum by `refillTokens()`. When a channel's bucket hits zero it is skipped for the rest of the round (backpressure) — but because higher-priority channels were already served first, that backpressure falls on bulk data, not on control. The bucket also gives graceful degradation: a fast producer is throttled to the refill rate instead of exhausting memory.

**Why is the bucket the *throttle* and the priority the *order*?**
They solve two different problems. Priority answers "who goes first?"; the token bucket answers "how much can they send before they must wait?". Using both means a saturated channel cannot starve others (priority), and no channel — even a high-priority one — can burst without bound (bucket). Either alone is insufficient: pure priority lets the top channel hog; pure round-robin token buckets reintroduce head-of-line blocking because a control frame could still queue behind a data frame with tokens to spare.

**Why does this live below the connection mux rather than replace it?**
The connection-level lane mux (guide 11) decides which *stream* gets the socket; this sublayer decides which *sub-channel* gets a given stream's budget. They compose: a vault transfer stream and an identity stream are scheduled against each other at the connection layer, while inside the identity stream, control frames are scheduled against bulk frames here. Folding them into one layer would couple two concerns that change independently.

## Algorithm

```
encodeFrame(subChannelId, seq, flags, payload):
  header[0..3]  = flags         (uint32 LE)
  header[4..7]  = seq           (uint32 LE)
  header[8]     = subChannelId  (uint8)
  header[9..11] = 0             (reserved, must be zero)
  header[12..15]= payload.length(uint32 LE)
  return header ++ payload

enqueue(subChannelId, payload, flags):
  channel[subChannelId].queue.push({ payload, flags })   // buffered, not sent

drain():                                  // priority order, token-limited
  for (id, ch) in channels sorted by DRAIN_PRIORITY[id] ascending:  // CTRL first
    while ch.queue nonempty and ch.tokenBucket > 0:
      item = ch.queue.shift()
      ch.tokenBucket -= 1
      sink(encodeFrame(id, ch.seq++, item.flags, item.payload))

refillTokens():
  for ch in channels: ch.tokenBucket = min(capacity, ch.tokenBucket + refillRate)

drainAll():                               // flush everything, refilling between rounds
  while pending() > 0: drain(); if pending() > 0: refillTokens()
```

## Reference implementation

See [`stream-submultiplexer.ts`](./stream-submultiplexer.ts) in this directory. No external dependencies — pure built-ins (`Uint8Array` + `DataView`).

## Usage

```typescript
import { SubChannelMuxer, SUB_CHANNEL } from "./stream-submultiplexer.js";

// The sink writes encoded frames into one underlying stream/virtual channel.
const mux = new SubChannelMuxer(
  (frame, decoded) => underlyingStream.write(frame),
  { bucketCapacity: 64, refillRate: 8 },
);

mux.openChannel(SUB_CHANNEL.CTRL);
mux.openChannel(SUB_CHANNEL.DATA);

// Offer bulk data and a control frame in any order:
for (const chunk of bigChunks) mux.enqueue(SUB_CHANNEL.DATA, chunk);
mux.enqueue(SUB_CHANNEL.CTRL, new TextEncoder().encode("FLOW=ok"));

// Drain on a timer; control is flushed ahead of bulk data every round:
setInterval(() => { mux.drain(); mux.refillTokens(); }, 10);

// Or flush everything synchronously:
mux.drainAll();
```

## Limitations and extensions

- **Drain priority is static.** The control-first ordering is fixed in `DRAIN_PRIORITY`. If priorities need to change at runtime (e.g. temporarily prioritize prefetch during idle), make the priority map mutable or accept a comparator.
- **Token bucket is per-channel, not per-frame-size.** A 4 KB data frame and a 4-byte control frame each cost one token. If you need byte-fair accounting, charge tokens proportional to payload length instead of one per frame.
- **No reassembly here.** This layer frames and schedules; it does not split oversized payloads or reassemble them. Pair it with a chunker/boundary layer if your payloads exceed a single frame budget (see guide 57 for boundary-aligned streaming).
- **The sink is assumed reliable and ordered.** The muxer hands encoded frames to the sink in priority order; it does not retransmit or reorder on the receive side. Run it over a transport that already guarantees ordered, reliable delivery (e.g. inside a TCP/TLS stream or a reliable virtual channel).
- **Backpressure is silent at this layer.** A channel that runs dry on tokens is simply skipped until refill. If a producer needs to *know* it is being throttled, expose `pendingOn(channel)` or surface a `BACKPRESSURE` flag back to the caller rather than letting the queue grow unbounded.
- **Single-writer assumption.** `drain()` is not concurrency-safe; call it from one place (a drain loop or timer). For multi-threaded producers, guard `enqueue`/`drain` or shard muxers per worker.
