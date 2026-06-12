/**
 * Boundary-Aligned Streaming Pulse Encoder
 *
 * Language models emit tokens one at a time, and the naive thing to do is
 * forward each token to the UI the instant it arrives. That produces visible
 * flicker: words appear mid-formation, markdown/code fragments render half-
 * parsed, and a text-to-speech layer stutters on partial words.
 *
 * This encoder accumulates tokens and only flushes a "pulse" frame on a
 * meaningful boundary, so each frame the client receives is a *complete
 * linguistic or code unit*. Three flush triggers cover the cases:
 *
 *   Hard boundary  — end of a sentence (". " "? " "! " ".\n" "...") → flush now.
 *   Soft boundary  — a clause delimiter ("," ";") once enough tokens have piled
 *                    up → flush so long clauses don't wait for a full stop.
 *   Time cap       — if nothing has flushed within ~120 ms, flush anyway so the
 *                    stream never appears to stall on a long unpunctuated span.
 *   Stream end     — close() flushes whatever remains, tagged "eos".
 *
 * Dependencies: Node.js built-in "events" and timers only.
 */

import { EventEmitter } from "events";

export type BoundaryType = "sentence" | "clause" | "timecap" | "eos";

export type Pulse = {
  seq:        number;
  boundary:   BoundaryType;
  text:       string;
  tokenCount: number;
};

export type PulseEncoderOptions = {
  /** Hard cap: flush once this many tokens accumulate regardless of boundary. */
  maxTokens?:     number;
  /** Time cap in ms: flush a non-empty buffer if no boundary fired in time. */
  maxMs?:         number;
  /** Minimum tokens before a soft (clause) boundary is allowed to flush. */
  clauseMinTokens?: number;
  /** Optional direct callback (in addition to the "pulse" event). */
  onPulse?:       (pulse: Pulse) => void;
};

// Boundary detection runs against the tail of the buffer (cheap, allocation-free).
const HARD_BOUNDARY_RE = /(?:\.\.\.|[.!?](?:\s|$)|\.\n)$/;
const SOFT_BOUNDARY_RE = /[,;]$/;

export class PulseEncoder extends EventEmitter {
  private readonly maxTokens:       number;
  private readonly maxMs:           number;
  private readonly clauseMinTokens: number;
  private readonly onPulse?:        (pulse: Pulse) => void;

  private buffer     = "";
  private tokenCount = 0;
  private seq        = 0;
  private closed     = false;
  private timer:     ReturnType<typeof setTimeout> | null = null;

  constructor(options: PulseEncoderOptions = {}) {
    super();
    this.maxTokens       = options.maxTokens       ?? 60;
    this.maxMs           = options.maxMs           ?? 120;
    this.clauseMinTokens = options.clauseMinTokens ?? 20;
    this.onPulse         = options.onPulse;
  }

  /** Feed one streamed token. May trigger zero or one pulse. */
  push(token: string): void {
    if (this.closed || !token) return;

    this.buffer     += token;
    this.tokenCount += 1;
    this.armTimer();

    const tail = this.buffer.slice(-8);

    if (HARD_BOUNDARY_RE.test(tail)) {
      this.flush("sentence");
      return;
    }
    if (SOFT_BOUNDARY_RE.test(tail) && this.tokenCount >= this.clauseMinTokens) {
      this.flush("clause");
      return;
    }
    if (this.tokenCount >= this.maxTokens) {
      this.flush("timecap"); // token-cap flush is reported as a non-semantic cut
    }
  }

  /** End the stream: flush any remainder tagged "eos", then emit "close". */
  close(): void {
    if (this.closed) return;
    this.clearTimer();
    if (this.buffer.length > 0) this.flush("eos");
    this.closed = true;
    this.emit("close");
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private flush(boundary: BoundaryType): void {
    this.clearTimer();
    if (!this.buffer) return;
    const pulse: Pulse = {
      seq:        this.seq++,
      boundary,
      text:       this.buffer,
      tokenCount: this.tokenCount,
    };
    this.buffer     = "";
    this.tokenCount = 0;
    this.onPulse?.(pulse);
    this.emit("pulse", pulse);
  }

  private armTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (this.buffer.length > 0) this.flush("timecap");
    }, this.maxMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  void (async () => {
    const encoder = new PulseEncoder({ maxMs: 120, clauseMinTokens: 4 });
    encoder.on("pulse", (p: Pulse) => {
      console.log(`pulse #${p.seq} [${p.boundary}] (${p.tokenCount} tok): ${JSON.stringify(p.text)}`);
    });
    encoder.on("close", () => console.log("stream closed"));

    // A token stream resembling LLM output (whitespace included on tokens).
    const tokens = [
      "Open", "ing", " the ", "vault", " now", ". ",          // → sentence flush
      "It ", "holds ", "your ", "notes", ", ",                 // → clause flush (>= 4 tok)
      "keys", ", ", "and ", "settings", ". ",                  // → sentence flush
      "Anything ", "else", "?",                                // partial (no trailing space)
    ];

    for (const tok of tokens) {
      encoder.push(tok);
      await new Promise(r => setTimeout(r, 10)); // simulate inter-token latency
    }

    // Demonstrate the time cap: a long unpunctuated span flushed by the timer.
    encoder.push("a long unpunctuated trailing fragment with no boundary at all");
    await new Promise(r => setTimeout(r, 160)); // exceed maxMs → timecap flush

    encoder.close(); // flushes any remainder as "eos"
  })();
}
