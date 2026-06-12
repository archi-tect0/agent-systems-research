/**
 * Proof-of-Bandwidth Relay Accounting
 *
 * A relay node forwards traffic between peers. To pay relays for useful work
 * (and resist Sybil inflation), it must credit bytes ONLY for valid payloads
 * that were actually forwarded to at least one other connected peer. Raw
 * ingress — keep-alives, malformed frames, frames addressed to no one — earns
 * nothing. Throughput is reported over a short sliding window so a relay's
 * recent contribution can be measured without keeping an unbounded log.
 *
 * Two pieces:
 *   RelayAccount  — per-session byte accounting with a sliding-window rate.
 *   TicketStore   — short-lived, single-use tickets that upgrade an
 *                   authenticated request to a transport slot WITHOUT putting a
 *                   bearer token in a URL (URLs leak into history/proxy logs).
 *
 * Dependencies: Node.js built-in "crypto" only (for ticket ids).
 */

import crypto from "crypto";

// ── Frame model ───────────────────────────────────────────────────────────────
// A relay sees a stream of frames. Only RELAY-lane frames carrying a valid
// payload are forwarding candidates; everything else is ingress noise.

export type FrameKind = "relay" | "keepalive" | "control";

export type Frame = {
  kind: FrameKind;
  bytes: number;       // wire size of the payload
  valid: boolean;      // passed payload validation (decoded, within limits)
  recipients: number;  // how many OTHER connected peers this frame reaches
};

type Sample = { ts: number; bytes: number };

// ── RelayAccount ──────────────────────────────────────────────────────────────

export class RelayAccount {
  readonly sessionId: string;
  private windowMs: number;
  private accumulated: number;        // credited bytes since last consume()
  private outSamples: Sample[];       // credited (forwarded) bytes, for the rate window
  private now: () => number;

  constructor(sessionId: string, windowMs = 10_000, now: () => number = Date.now) {
    this.sessionId = sessionId;
    this.windowMs = windowMs;
    this.accumulated = 0;
    this.outSamples = [];
    this.now = now;
  }

  /**
   * Account for one ingress frame. Returns the number of bytes credited
   * (0 when the frame earns nothing). A frame is credited iff it is a RELAY
   * frame, its payload is valid, AND it was forwarded to >= 1 other peer.
   */
  account(frame: Frame): number {
    const creditable =
      frame.kind === "relay" &&
      frame.valid === true &&
      frame.recipients >= 1 &&
      frame.bytes > 0;

    if (!creditable) return 0;

    const ts = this.now();
    this.accumulated += frame.bytes;
    this.outSamples.push({ ts, bytes: frame.bytes });
    return frame.bytes;
  }

  /**
   * Drain the confirmed relay-byte counter and reset it to zero. This is the
   * value a settlement/telemetry layer reads to award credit for the interval.
   */
  consume(): number {
    const n = this.accumulated;
    this.accumulated = 0;
    return n;
  }

  /** Credited bytes per second over the sliding window. Prunes old samples. */
  bytesPerSec(): number {
    const cutoff = this.now() - this.windowMs;
    let i = 0;
    while (i < this.outSamples.length && this.outSamples[i].ts < cutoff) i++;
    if (i > 0) this.outSamples.splice(0, i);
    const total = this.outSamples.reduce((acc, s) => acc + s.bytes, 0);
    return total / (this.windowMs / 1000);
  }
}

// ── TicketStore ───────────────────────────────────────────────────────────────
// A ticket is an opaque id minted for an already-authenticated session. The
// client presents the ticket id (not its session bearer) when opening the
// transport slot. The server-side entry holds the real session context, which
// is never transmitted to the client. Tickets are single-use and short-lived.

export type TicketContext = { sessionId: string; subject: string };

type TicketEntry = TicketContext & { expiresAt: number; used: boolean };

export class TicketStore {
  private tickets: Map<string, TicketEntry>;
  private ttlMs: number;
  private now: () => number;

  constructor(ttlMs = 60_000, now: () => number = Date.now) {
    this.tickets = new Map();
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Mint a ticket for an authenticated session. Returns only the opaque id. */
  issue(ctx: TicketContext): string {
    const id = crypto.randomBytes(32).toString("hex");
    this.tickets.set(id, { ...ctx, expiresAt: this.now() + this.ttlMs, used: false });
    return id;
  }

  /**
   * Redeem a ticket. Returns the session context on success, or null if the
   * ticket is unknown, expired, or already used. Always removes the entry so it
   * can never be replayed.
   */
  redeem(id: string): TicketContext | null {
    const t = this.tickets.get(id);
    if (!t) return null;
    this.tickets.delete(id);
    if (t.used || t.expiresAt <= this.now()) return null;
    return { sessionId: t.sessionId, subject: t.subject };
  }

  /** Drop expired/used entries. Call periodically. */
  prune(): void {
    const now = this.now();
    for (const [id, t] of this.tickets) {
      if (t.used || t.expiresAt <= now) this.tickets.delete(id);
    }
  }

  get size(): number {
    return this.tickets.size;
  }
}

// ── Demo ──────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  // A controllable clock so the sliding window is deterministic in the demo.
  let clock = 1_000_000;
  const now = () => clock;

  console.log("== Byte accounting ==");
  const acct = new RelayAccount("session-A", 10_000, now);

  const frames: Frame[] = [
    { kind: "relay", bytes: 1200, valid: true, recipients: 2 },  // credited
    { kind: "keepalive", bytes: 8, valid: true, recipients: 5 }, // not relay -> 0
    { kind: "relay", bytes: 900, valid: false, recipients: 1 },  // malformed -> 0
    { kind: "relay", bytes: 1500, valid: true, recipients: 0 },  // forwarded to nobody -> 0
    { kind: "control", bytes: 40, valid: true, recipients: 1 },  // not relay -> 0
    { kind: "relay", bytes: 2048, valid: true, recipients: 1 },  // credited
  ];

  for (const f of frames) {
    const credited = acct.account(f);
    clock += 500; // 0.5s between frames
    console.log(
      `  ${f.kind.padEnd(9)} bytes=${String(f.bytes).padStart(4)} valid=${f.valid} recip=${f.recipients} -> credited ${credited}`,
    );
  }

  console.log("  confirmed relay bytes (consume):", acct.consume());
  console.log("  bytes/sec over window:", Math.round(acct.bytesPerSec()));
  console.log("  consume again (already drained):", acct.consume());

  console.log("\n== Tickets ==");
  const store = new TicketStore(60_000, now);
  const id = store.issue({ sessionId: "session-A", subject: "peer-7" });
  console.log("  issued ticket:", id.slice(0, 16) + "…", "(store size", store.size + ")");

  const first = store.redeem(id);
  console.log("  first redeem:", first);

  const second = store.redeem(id);
  console.log("  replay redeem (must be null):", second);

  const expiring = store.issue({ sessionId: "session-B", subject: "peer-9" });
  clock += 61_000; // advance past TTL
  console.log("  redeem after expiry (must be null):", store.redeem(expiring));
}
