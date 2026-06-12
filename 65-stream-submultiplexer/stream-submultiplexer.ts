/**
 * In-Stream Sub-Channel Multiplexer with Flow Control
 *
 * Carries several logical sub-channels (control / data / tool / pulse /
 * prefetch) inside ONE byte stream. A fixed 16-byte binary header tags every
 * frame with its sub-channel, sequence, flags, and payload length. A priority
 * drain with per-channel token buckets guarantees that small, latency-sensitive
 * control frames are flushed promptly and are never starved by large bulk data
 * frames under backpressure.
 *
 * This is the STREAMING-LAYER sublayer: it lives inside a single virtual
 * channel of a higher-level connection multiplexer, subdividing that one
 * channel into prioritized sub-channels. (Connection-level QoS lane muxing is a
 * separate concern.)
 *
 * Pure built-ins: Uint8Array + DataView. No network.
 */

// ── Sub-channels and flags (no enum: 'as const' objects) ────────────────────

export const SUB_CHANNEL = {
  CTRL: 0,
  DATA: 1,
  TOOL: 2,
  PULSE: 3,
  PREFETCH: 4,
} as const;

export type SubChannelId = (typeof SUB_CHANNEL)[keyof typeof SUB_CHANNEL];

export const FRAME_FLAGS = {
  FINAL: 0x01,
  COMPRESSED: 0x02,
  BACKPRESSURE: 0x04,
  ERROR: 0x08,
} as const;

export const FRAME_HEADER_BYTES = 16;

/**
 * Drain priority: lower number = drained first. Control beats everything;
 * bulk data and prefetch are drained last so they cannot starve control.
 */
const DRAIN_PRIORITY: Record<number, number> = {
  [SUB_CHANNEL.CTRL]: 0,
  [SUB_CHANNEL.PULSE]: 1,
  [SUB_CHANNEL.TOOL]: 2,
  [SUB_CHANNEL.DATA]: 3,
  [SUB_CHANNEL.PREFETCH]: 4,
};

// ── Frame codec ─────────────────────────────────────────────────────────────

export function encodeFrame(
  subChannelId: number,
  seq: number,
  flags: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, flags >>> 0, true);
  view.setUint32(4, seq >>> 0, true);
  view.setUint8(8, subChannelId & 0xff);
  view.setUint8(9, 0);
  view.setUint8(10, 0);
  view.setUint8(11, 0);
  view.setUint32(12, payload.byteLength >>> 0, true);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

export interface DecodedFrame {
  subChannelId: number;
  seq: number;
  flags: number;
  payload: Uint8Array;
}

export function decodeFrame(buf: Uint8Array): DecodedFrame {
  if (buf.byteLength < FRAME_HEADER_BYTES) {
    throw new Error("frame too short");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = view.getUint32(0, true);
  const seq = view.getUint32(4, true);
  const subChannelId = view.getUint8(8);
  const r9 = view.getUint8(9);
  const r10 = view.getUint8(10);
  const r11 = view.getUint8(11);
  const payloadBytes = view.getUint32(12, true);
  if (r9 !== 0 || r10 !== 0 || r11 !== 0) {
    throw new Error("reserved bytes must be zero");
  }
  if (buf.byteLength !== FRAME_HEADER_BYTES + payloadBytes) {
    throw new Error(
      `payload length mismatch: header says ${payloadBytes}, got ${buf.byteLength - FRAME_HEADER_BYTES}`,
    );
  }
  const payload = buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + payloadBytes);
  return { subChannelId, seq, flags, payload };
}

// ── Muxer with priority drain + per-channel token buckets ───────────────────

interface ChannelState {
  seq: number;
  tokenBucket: number;
  queue: Array<{ payload: Uint8Array; flags: number }>;
}

export type FrameSink = (frame: Uint8Array, decoded: DecodedFrame) => void;

export interface MuxerOptions {
  /** Per-channel token bucket capacity. */
  bucketCapacity: number;
  /** Tokens added to each channel per refillTokens() call. */
  refillRate: number;
}

const DEFAULT_OPTS: MuxerOptions = { bucketCapacity: 64, refillRate: 8 };

/**
 * SubChannelMuxer subdivides one stream into prioritized sub-channels.
 * enqueue() buffers a frame on a channel; drain() flushes ready frames in
 * priority order while each channel has tokens. This decouples *offering* a
 * frame from *sending* it, which is what lets a tight bucket throttle bulk
 * data without ever blocking control frames.
 */
export class SubChannelMuxer {
  private channels: Map<number, ChannelState>;
  private sink: FrameSink;
  private capacity: number;
  private refillRate: number;

  constructor(sink: FrameSink, opts: Partial<MuxerOptions> = {}) {
    const merged = { ...DEFAULT_OPTS, ...opts };
    this.sink = sink;
    this.capacity = merged.bucketCapacity;
    this.refillRate = merged.refillRate;
    this.channels = new Map();
  }

  openChannel(subChannelId: number): void {
    if (this.channels.has(subChannelId)) return;
    this.channels.set(subChannelId, {
      seq: 0,
      tokenBucket: this.capacity,
      queue: [],
    });
  }

  private require(subChannelId: number): ChannelState {
    const ch = this.channels.get(subChannelId);
    if (!ch) throw new Error(`sub-channel ${subChannelId} is not open`);
    return ch;
  }

  /** Buffer a frame for later drain. Does not send immediately. */
  enqueue(subChannelId: number, payload: Uint8Array, flags = 0): void {
    const ch = this.require(subChannelId);
    ch.queue.push({ payload, flags });
  }

  /** Number of frames still buffered across all channels. */
  pending(): number {
    let n = 0;
    for (const [, ch] of this.channels) n += ch.queue.length;
    return n;
  }

  pendingOn(subChannelId: number): number {
    return this.require(subChannelId).queue.length;
  }

  /**
   * Flush ready frames in priority order. For each channel (lowest
   * DRAIN_PRIORITY first), emit queued frames while the channel has tokens.
   * A channel that runs out of tokens is skipped this round (backpressure);
   * higher-priority channels were already served, so control is never blocked
   * behind a throttled data channel.
   *
   * @returns the number of frames flushed.
   */
  drain(): number {
    const order = [...this.channels.entries()].sort(
      (a, b) => (DRAIN_PRIORITY[a[0]] ?? 99) - (DRAIN_PRIORITY[b[0]] ?? 99),
    );
    let flushed = 0;
    for (const [id, ch] of order) {
      while (ch.queue.length > 0 && ch.tokenBucket > 0) {
        const item = ch.queue.shift()!;
        ch.tokenBucket -= 1;
        const frame = encodeFrame(id, ch.seq++, item.flags, item.payload);
        this.sink(frame, decodeFrame(frame));
        flushed += 1;
      }
    }
    return flushed;
  }

  /** Add tokens to every channel's bucket (call on a timer). */
  refillTokens(): void {
    for (const [, ch] of this.channels) {
      ch.tokenBucket = Math.min(this.capacity, ch.tokenBucket + this.refillRate);
    }
  }

  /** Drain repeatedly, refilling between rounds, until everything is flushed. */
  drainAll(): number {
    let total = 0;
    let guard = 0;
    while (this.pending() > 0) {
      total += this.drain();
      if (this.pending() > 0) this.refillTokens();
      if (++guard > 100_000) throw new Error("drainAll: runaway loop");
    }
    return total;
  }

  /** Emit a FINAL frame and remove the channel. */
  closeChannel(subChannelId: number): void {
    const ch = this.channels.get(subChannelId);
    if (!ch) return;
    const frame = encodeFrame(subChannelId, ch.seq++, FRAME_FLAGS.FINAL, new Uint8Array(0));
    this.sink(frame, decodeFrame(frame));
    this.channels.delete(subChannelId);
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const enc = (s: string) => new TextEncoder().encode(s);

  // Record the order frames hit the wire so we can prove control isn't starved.
  const wire: Array<{ ch: number; seq: number; bytes: number; label: string }> = [];
  const channelName: Record<number, string> = {
    [SUB_CHANNEL.CTRL]: "CTRL",
    [SUB_CHANNEL.DATA]: "DATA",
    [SUB_CHANNEL.TOOL]: "TOOL",
    [SUB_CHANNEL.PULSE]: "PULSE",
    [SUB_CHANNEL.PREFETCH]: "PREFETCH",
  };

  // Tight bucket: only 2 tokens per channel per drain round.
  const mux = new SubChannelMuxer(
    (_frame, decoded) => {
      wire.push({
        ch: decoded.subChannelId,
        seq: decoded.seq,
        bytes: decoded.payload.byteLength,
        label: channelName[decoded.subChannelId] ?? `ch${decoded.subChannelId}`,
      });
    },
    { bucketCapacity: 2, refillRate: 2 },
  );

  mux.openChannel(SUB_CHANNEL.CTRL);
  mux.openChannel(SUB_CHANNEL.DATA);

  // Flood the data channel with big frames.
  const bigPayload = enc("x".repeat(4096));
  for (let i = 0; i < 10; i++) {
    mux.enqueue(SUB_CHANNEL.DATA, bigPayload);
  }
  // A few small control frames, enqueued AFTER the bulk flood.
  mux.enqueue(SUB_CHANNEL.CTRL, enc("PING"));
  mux.enqueue(SUB_CHANNEL.CTRL, enc("FLOW=ok"));
  mux.enqueue(SUB_CHANNEL.CTRL, enc("ACK=42"));

  console.log("=== Pending before drain ===");
  console.log(`  DATA: ${mux.pendingOn(SUB_CHANNEL.DATA)} large frames`);
  console.log(`  CTRL: ${mux.pendingOn(SUB_CHANNEL.CTRL)} small frames`);

  console.log("\n=== Single drain round (tight bucket: 2 tokens/channel) ===");
  const flushedFirst = mux.drain();
  console.log(`flushed ${flushedFirst} frames this round; wire order:`);
  for (const f of wire) console.log(`  ${f.label} seq=${f.seq} (${f.bytes}B)`);

  const ctrlInFirstRound = wire.filter((f) => f.ch === SUB_CHANNEL.CTRL).length;
  console.log(`\nControl frames flushed in the FIRST round: ${ctrlInFirstRound} (not starved behind bulk data)`);

  console.log("\n=== Drain the rest (refill between rounds) ===");
  const rest = mux.drainAll();
  console.log(`flushed ${rest} more frames; total on wire: ${wire.length}`);

  const allCtrl = wire.filter((f) => f.ch === SUB_CHANNEL.CTRL);
  const lastCtrlIndex = wire.lastIndexOf(allCtrl[allCtrl.length - 1]);
  console.log(`All ${allCtrl.length} control frames delivered; last control frame was wire item #${lastCtrlIndex + 1} of ${wire.length}.`);
}
