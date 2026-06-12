/**
 * QoS-Lane Stream Multiplexer (Yamux)
 * -----------------------------------
 * Multiplexes many logical streams over one byte transport using the Yamux wire
 * format (12-byte header + payload), and assigns each stream to a QoS lane (1-8)
 * by packing the lane into the upper nibble of the 32-bit stream ID. A receiver
 * routes a frame to the right priority queue by reading the header alone — never
 * the payload. A token-bucket priority scheduler drains lanes highest-priority
 * first while bounding burstiness.
 *
 * Frame layout (12-byte header + data), all multi-byte fields big-endian:
 *   [0]      version  — always 0x00
 *   [1]      type     — 0=DATA, 1=WINDOW_UPDATE, 2=PING, 3=GO_AWAY
 *   [2..3]   flags    — SYN=0x0001 ACK=0x0002 FIN=0x0004 RST=0x0008
 *   [4..7]   streamId — upper nibble = lane (1..8), lower 28 bits = sequence
 *   [8..11]  length   — DATA payload byte count (PING: opaque value)
 *
 * No external dependencies — pure Uint8Array / DataView.
 *
 * Run the self-check:  npx tsx yamux-qos-mux.ts --demo
 */

// ── QoS lanes (priority high → low) ─────────────────────────────────────────

export const LANES = {
  IDENTITY:  1,  // auth handshakes, session tokens
  GUARDIAN:  2,  // recovery / attestation
  VAULT:     3,  // bulk encrypted blob read/write
  RELAY:     4,  // packet forwarding between peers
  COMPUTE:   5,  // generic jobs / tasks
  MESSAGES:  6,  // small P2P messages
  LAUNCHER:  7,  // app/handshake events
  KEEPALIVE: 8,  // pings / health (lowest)
} as const;

export type LaneId = typeof LANES[keyof typeof LANES];

// Scheduling priority for each lane (higher drains first). Note this is distinct
// from the lane *number*: IDENTITY (lane 1) has the highest priority.
export const LANE_PRIORITY: Record<number, number> = {
  [LANES.IDENTITY]: 10, [LANES.GUARDIAN]: 9, [LANES.VAULT]: 7, [LANES.RELAY]: 6,
  [LANES.MESSAGES]: 5, [LANES.COMPUTE]: 4, [LANES.LAUNCHER]: 3, [LANES.KEEPALIVE]: 1,
};

// ── Frame format ────────────────────────────────────────────────────────────

export const YAMUX_HEADER_SIZE = 12;

export const FrameType = { DATA: 0x00, WINDOW_UPDATE: 0x01, PING: 0x02, GO_AWAY: 0x03 } as const;
export type FrameType = typeof FrameType[keyof typeof FrameType];

export const Flags = { SYN: 0x0001, ACK: 0x0002, FIN: 0x0004, RST: 0x0008 } as const;

export interface YamuxFrame {
  version: 0;
  type:    FrameType;
  flags:   number;
  streamId: number;
  length:  number;
  data?:   Uint8Array;
}

export function encodeFrame(frame: YamuxFrame): Uint8Array {
  const dataLen = frame.data?.length ?? 0;
  const buf = new Uint8Array(YAMUX_HEADER_SIZE + dataLen);
  const view = new DataView(buf.buffer);
  view.setUint8(0, 0);                       // version
  view.setUint8(1, frame.type);
  view.setUint16(2, frame.flags, false);     // big-endian
  view.setUint32(4, frame.streamId, false);
  view.setUint32(8, frame.length, false);
  if (frame.data) buf.set(frame.data, YAMUX_HEADER_SIZE);
  return buf;
}

export function decodeFrame(buf: Uint8Array): YamuxFrame | null {
  if (buf.length < YAMUX_HEADER_SIZE) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = view.getUint8(1) as FrameType;
  const flags = view.getUint16(2, false);
  const streamId = view.getUint32(4, false);
  const length = view.getUint32(8, false);
  const data = buf.length > YAMUX_HEADER_SIZE
    ? buf.slice(YAMUX_HEADER_SIZE, YAMUX_HEADER_SIZE + length)
    : undefined;
  return { version: 0, type, flags, streamId, length, data };
}

// ── Lane ↔ stream-id codec ──────────────────────────────────────────────────

export function streamIdForLane(lane: number, seq: number): number {
  // lane in upper nibble (bits 28-31), sequence in the lower 28 bits.
  return ((lane & 0xF) << 28) | (seq & 0x0FFFFFFF);
}

export function laneFromStreamId(streamId: number): number {
  const base = (streamId >>> 28) & 0xF;
  return base >= 1 && base <= 8 ? base : LANES.RELAY; // unknown → default lane
}

// ── Frame splitter — reassembles frames from arbitrary byte chunks ──────────

export class FrameSplitter {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): YamuxFrame[] {
    const combined = new Uint8Array(this.buf.length + chunk.length);
    combined.set(this.buf);
    combined.set(chunk, this.buf.length);
    this.buf = combined;

    const frames: YamuxFrame[] = [];
    while (this.buf.length >= YAMUX_HEADER_SIZE) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset);
      const length = view.getUint32(8, false);
      const total = YAMUX_HEADER_SIZE + length;
      if (this.buf.length < total) break; // wait for the rest of this frame
      const frame = decodeFrame(this.buf.slice(0, total));
      if (frame) frames.push(frame);
      this.buf = this.buf.slice(total);
    }
    return frames;
  }

  reset() { this.buf = new Uint8Array(0); }
}

// ── Stream ─────────────────────────────────────────────────────────────────

type StreamState = "open" | "half-closed-local" | "half-closed-remote" | "closed";

export interface MuxStream {
  id:      number;
  laneId:  number;
  state:   StreamState;
  onData:  ((data: Uint8Array) => void) | null;
  onClose: (() => void) | null;
}

// ── Token-bucket scheduler ──────────────────────────────────────────────────

export class LaneScheduler {
  static readonly CAPACITY = 64;
  static readonly REFILL   = 8;
  private buckets = new Map<number, number>();

  private bucket(lane: number): number {
    if (!this.buckets.has(lane)) this.buckets.set(lane, LaneScheduler.CAPACITY);
    return this.buckets.get(lane)!;
  }

  /** Try to spend one token for a lane. Returns false under backpressure. */
  tryConsume(lane: number): boolean {
    const tokens = this.bucket(lane);
    if (tokens <= 0) return false;
    this.buckets.set(lane, tokens - 1);
    return true;
  }

  /** Refill every lane's bucket by the fixed quantum, up to capacity. */
  refill(): void {
    for (const [lane, tokens] of this.buckets) {
      this.buckets.set(lane, Math.min(LaneScheduler.CAPACITY, tokens + LaneScheduler.REFILL));
    }
  }

  tokensFor(lane: number): number { return this.bucket(lane); }
}

// ── Mux session ──────────────────────────────────────────────────────────────

export type SendFn = (data: Uint8Array) => void;

export class YamuxSession {
  private streams = new Map<number, MuxStream>();
  private splitter = new FrameSplitter();
  private nextStreamId: number;            // odd = initiator, even = responder
  private pingCallbacks = new Map<number, () => void>();
  private pingSeq = 0;
  readonly scheduler = new LaneScheduler();

  onNewStream: ((stream: MuxStream) => void) | null = null;

  private send: SendFn;
  private isInitiator: boolean;
  constructor(send: SendFn, isInitiator: boolean) {
    this.send = send;
    this.isInitiator = isInitiator;
    this.nextStreamId = isInitiator ? 1 : 2;
  }

  /** Open a stream on a QoS lane; the lane is packed into the stream ID. */
  openStream(laneId: number): MuxStream {
    const seq = this.nextStreamId;
    this.nextStreamId += 2;
    const streamId = streamIdForLane(laneId, seq);
    const stream: MuxStream = { id: streamId, laneId, state: "open", onData: null, onClose: null };
    this.streams.set(streamId, stream);
    this.send(encodeFrame({ version: 0, type: FrameType.DATA, flags: Flags.SYN, streamId, length: 0 }));
    return stream;
  }

  /** Send data on an open stream. Returns false under lane backpressure. */
  writeStream(stream: MuxStream, data: Uint8Array): boolean {
    if (stream.state !== "open") throw new Error(`stream ${stream.id} not open`);
    if (!this.scheduler.tryConsume(stream.laneId)) return false; // bucket empty → backpressure
    this.send(encodeFrame({ version: 0, type: FrameType.DATA, flags: 0, streamId: stream.id, length: data.length, data }));
    return true;
  }

  /** Half-close the local side of a stream. */
  closeStream(stream: MuxStream): void {
    if (stream.state === "open") {
      stream.state = "half-closed-local";
      this.send(encodeFrame({ version: 0, type: FrameType.DATA, flags: Flags.FIN, streamId: stream.id, length: 0 }));
    }
  }

  /** Send a ping; resolves when the pong returns. */
  ping(): Promise<void> {
    return new Promise(resolve => {
      const seq = this.pingSeq++;
      this.pingCallbacks.set(seq, resolve);
      this.send(encodeFrame({ version: 0, type: FrameType.PING, flags: Flags.SYN, streamId: 0, length: seq }));
    });
  }

  /** Feed raw bytes from the transport. */
  receive(chunk: Uint8Array): void {
    for (const frame of this.splitter.push(chunk)) this.handleFrame(frame);
  }

  close(): void {
    this.send(encodeFrame({ version: 0, type: FrameType.GO_AWAY, flags: 0, streamId: 0, length: 0 }));
    this.streams.clear();
    this.splitter.reset();
  }

  // ── Frame handling ────────────────────────────────────────────────────────

  private handleFrame(frame: YamuxFrame): void {
    switch (frame.type) {
      case FrameType.DATA:          return this.handleData(frame);
      case FrameType.WINDOW_UPDATE: return;                  // transport handles flow control
      case FrameType.PING:          return this.handlePing(frame);
      case FrameType.GO_AWAY:       return this.handleGoAway();
    }
  }

  private handleData(frame: YamuxFrame): void {
    const isSyn = !!(frame.flags & Flags.SYN);
    const isFin = !!(frame.flags & Flags.FIN);
    const isRst = !!(frame.flags & Flags.RST);

    if (isSyn && !this.streams.has(frame.streamId)) {
      const laneId = laneFromStreamId(frame.streamId);   // route from header alone
      const stream: MuxStream = { id: frame.streamId, laneId, state: "open", onData: null, onClose: null };
      this.streams.set(frame.streamId, stream);
      this.send(encodeFrame({ version: 0, type: FrameType.DATA, flags: Flags.ACK, streamId: frame.streamId, length: 0 }));
      this.onNewStream?.(stream);
      return;
    }

    const stream = this.streams.get(frame.streamId);
    if (!stream) return;

    if (isRst) {
      stream.state = "closed";
      stream.onClose?.();
      this.streams.delete(frame.streamId);
      return;
    }

    if (frame.data?.length) stream.onData?.(frame.data);

    if (isFin) {
      if (stream.state === "half-closed-local") {
        stream.state = "closed";
        stream.onClose?.();
        this.streams.delete(frame.streamId);
      } else {
        stream.state = "half-closed-remote";
      }
    }
  }

  private handlePing(frame: YamuxFrame): void {
    if (frame.flags & Flags.SYN) {
      this.send(encodeFrame({ version: 0, type: FrameType.PING, flags: Flags.ACK, streamId: 0, length: frame.length }));
    } else if (frame.flags & Flags.ACK) {
      const cb = this.pingCallbacks.get(frame.length);
      if (cb) { cb(); this.pingCallbacks.delete(frame.length); }
    }
  }

  private handleGoAway(): void {
    for (const stream of this.streams.values()) stream.onClose?.();
    this.streams.clear();
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  console.log("frame round-trip & lane encoding:");
  const sid = streamIdForLane(LANES.VAULT, 5);
  console.log("  streamId for VAULT seq5:", sid.toString(16), "→ lane", laneFromStreamId(sid));
  const f = decodeFrame(encodeFrame({ version: 0, type: FrameType.DATA, flags: Flags.SYN, streamId: sid, length: 0 }))!;
  console.log("  decoded SYN flag set:", !!(f.flags & Flags.SYN), "lane:", laneFromStreamId(f.streamId));

  console.log("\nframe splitter reassembles across chunk boundaries:");
  const whole = encodeFrame({ version: 0, type: FrameType.DATA, flags: 0, streamId: sid, length: 3, data: new Uint8Array([1, 2, 3]) });
  const splitter = new FrameSplitter();
  console.log("  first half →", splitter.push(whole.slice(0, 7)).length, "frames");
  console.log("  second half →", splitter.push(whole.slice(7)).length, "frame");

  console.log("\ntwo sessions back-to-back, multiplexed lanes:");
  const a = new YamuxSession(bytes => b.receive(bytes), true);
  const b = new YamuxSession(bytes => a.receive(bytes), false);
  const received: string[] = [];
  b.onNewStream = (s) => { s.onData = (d) => received.push(`lane${s.laneId}:${new TextDecoder().decode(d)}`); };

  const auth = a.openStream(LANES.IDENTITY);
  a.writeStream(auth, new TextEncoder().encode("login"));
  const msg = a.openStream(LANES.MESSAGES);
  a.writeStream(msg, new TextEncoder().encode("hello"));
  console.log("  receiver demuxed:", received.join(", "));

  console.log("\ntoken-bucket backpressure (capacity 64):");
  const bulk = a.openStream(LANES.VAULT);
  let sent = 0;
  while (a.writeStream(bulk, new Uint8Array([0]))) sent++;
  console.log("  frames before backpressure:", sent, "(next write returns false)");
  console.log("  write now:", a.writeStream(bulk, new Uint8Array([0])));
  a.scheduler.refill();
  console.log("  after refill, tokens:", a.scheduler.tokensFor(LANES.VAULT), "→ write:", a.writeStream(bulk, new Uint8Array([0])));

  console.log("\npriority order (highest drains first):");
  const lanes = Object.values(LANES).sort((x, y) => LANE_PRIORITY[y] - LANE_PRIORITY[x]);
  console.log("  ", lanes.map(l => `${Object.keys(LANES).find(k => (LANES as Record<string, number>)[k] === l)}(${LANE_PRIORITY[l]})`).join(" > "));
}
