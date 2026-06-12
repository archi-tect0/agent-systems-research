/**
 * Speculative Tool Prefetch from Stream Heads
 *
 * A latency-hiding technique for agent runtimes. While the language model is
 * still streaming the *head* of its response, a small/cheap predictor inspects
 * the first N tokens and guesses which tools the model is about to call. Each
 * confident guess is executed in the background immediately. By the time the
 * real tool-dispatch phase fires, the result is already sitting in a cache —
 * turning a serial round-trip into a near-zero-latency cache hit.
 *
 * Mispredictions are harmless: an entry that is never consumed simply expires
 * and its in-flight work is aborted. The foreground path is never blocked or
 * perturbed by prefetch activity (errors are swallowed, emits are no-ops).
 *
 * This file demonstrates the pattern with:
 *   - a pluggable `predictor`  (real systems use a nano model; demo uses a stub)
 *   - a pluggable `toolRunner` (real systems call the tool registry; demo stubs)
 *
 * Dependencies: Node.js built-in "crypto" only.
 */

import crypto from "crypto";

// ── Public types ──────────────────────────────────────────────────────────────

export type ToolPrediction = {
  name:       string;
  args:       Record<string, unknown>;
  confidence: number;
};

/** Predicts likely tool calls from the partial streamed text. */
export type Predictor = (partialText: string) => Promise<ToolPrediction[]>;

/** Executes a tool and resolves with its result. */
export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type PrefetcherOptions = {
  predictor:           Predictor;
  toolRunner:          ToolRunner;
  /** Fire the prediction once this many tokens have been observed. */
  activationTokens?:   number;
  /** Only prefetch predictions at or above this confidence. */
  confidenceThreshold?: number;
  /** Time-to-live for a cached prefetch result, in ms. */
  ttlMs?:              number;
};

type PrefetchEntry = {
  key:       string;
  toolName:  string;
  createdAt: number;
  expiresAt: number;
  result:    unknown;
  done:      boolean;
  consumed:  boolean;
  abort:     AbortController;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Deterministic stringify with sorted keys, so {a,b} and {b,a} hash equally. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj  = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function cacheKey(toolName: string, args: unknown): string {
  const h = crypto.createHash("sha256").update(stableStringify(args)).digest("hex");
  return `${toolName}:${h}`;
}

// ── SpeculativePrefetcher ───────────────────────────────────────────────────────

export class SpeculativePrefetcher {
  private readonly predictor:           Predictor;
  private readonly toolRunner:          ToolRunner;
  private readonly activationTokens:    number;
  private readonly confidenceThreshold: number;
  private readonly ttlMs:               number;

  private tokensSeen     = 0;
  private tokenBuffer:   string[] = [];
  private predicted      = false;
  private cache          = new Map<string, PrefetchEntry>();
  private inflight:      Promise<void>[] = [];

  constructor(options: PrefetcherOptions) {
    this.predictor           = options.predictor;
    this.toolRunner          = options.toolRunner;
    this.activationTokens    = options.activationTokens    ?? 15;
    this.confidenceThreshold = options.confidenceThreshold ?? 0.7;
    this.ttlMs               = options.ttlMs               ?? 8_000;
  }

  /**
   * Feed one streamed token into the watcher. After `activationTokens` tokens
   * have been seen the predictor fires exactly once.
   */
  observeToken(token: string): void {
    if (this.predicted) return;
    this.tokensSeen += 1;
    this.tokenBuffer.push(token);
    if (this.tokensSeen >= this.activationTokens) {
      this.predicted = true;
      this.inflight.push(this.runPrediction(this.tokenBuffer.join("")));
    }
  }

  /**
   * Try to consume a prefetched result for an actual tool call.
   * Returns null on a miss, on expiry, or if the result is not ready yet.
   */
  consume(toolName: string, args: Record<string, unknown>): { result: unknown; hit: boolean } | null {
    const key   = cacheKey(toolName, args);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      entry.abort.abort();
      this.cache.delete(key);
      return null;
    }
    if (!entry.done) return null; // still computing — caller should run it itself
    entry.consumed = true;
    return { result: entry.result, hit: true };
  }

  /** Abort every in-flight prefetch and clear the cache. Call at stream end. */
  cleanup(): void {
    for (const entry of this.cache.values()) entry.abort.abort();
    this.cache.clear();
    this.tokenBuffer = [];
  }

  /** Number of cached entries that were never consumed (mispredictions). */
  discardedCount(): number {
    let n = 0;
    for (const entry of this.cache.values()) if (!entry.consumed) n += 1;
    return n;
  }

  /** Await all in-flight prefetch work — for deterministic testing/demos. */
  async settle(): Promise<void> {
    await Promise.allSettled(this.inflight);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async runPrediction(partialText: string): Promise<void> {
    let predictions: ToolPrediction[];
    try {
      predictions = await this.predictor(partialText);
    } catch {
      return; // prediction failures never affect the foreground path
    }
    for (const pred of predictions) {
      if (!pred || typeof pred.name !== "string") continue;
      if (pred.confidence < this.confidenceThreshold) continue;
      this.inflight.push(this.prefetchOne(pred));
    }
  }

  private async prefetchOne(pred: ToolPrediction): Promise<void> {
    const key = cacheKey(pred.name, pred.args);
    const now = Date.now();
    if (this.cache.has(key)) return;

    const abort = new AbortController();
    const entry: PrefetchEntry = {
      key,
      toolName:  pred.name,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      result:    null,
      done:      false,
      consumed:  false,
      abort,
    };
    this.cache.set(key, entry);

    try {
      const result = await this.toolRunner(pred.name, pred.args);
      if (abort.signal.aborted) return;
      entry.result = result;
      entry.done   = true;
    } catch {
      // Don't cache failed prefetches — let the real dispatch handle them.
      this.cache.delete(key);
    }
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  void (async () => {
    // A stub predictor: if the stream head mentions a vault, predict vault_read.
    const predictor: Predictor = async (partialText) => {
      const t = partialText.toLowerCase();
      if (t.includes("vault")) {
        return [{ name: "vault_read", args: { slug: "notes" }, confidence: 0.9 }];
      }
      if (t.includes("weather")) {
        return [{ name: "web_search", args: { q: "weather" }, confidence: 0.8 }];
      }
      return [];
    };

    // A stub tool runner with an artificial 40ms latency.
    let toolCalls = 0;
    const toolRunner: ToolRunner = async (name, args) => {
      toolCalls += 1;
      await new Promise(r => setTimeout(r, 40));
      return { tool: name, args, value: `result-of-${name}` };
    };

    // ── Scenario A: correct prediction → cache hit ──────────────────────────
    console.log("── Scenario A: correct prefetch ──");
    const a = new SpeculativePrefetcher({ predictor, toolRunner, activationTokens: 3 });
    for (const tok of ["Let ", "me ", "open ", "your ", "vault"]) a.observeToken(tok);
    await a.settle();

    const t0 = Date.now();
    const hit = a.consume("vault_read", { slug: "notes" });
    console.log("consume(vault_read):", hit, `(${Date.now() - t0}ms, no foreground tool wait)`);
    console.log("tool executions so far:", toolCalls);
    a.cleanup();

    // ── Scenario B: misprediction → discarded ───────────────────────────────
    console.log("\n── Scenario B: misprediction ──");
    const b = new SpeculativePrefetcher({ predictor, toolRunner, activationTokens: 3 });
    for (const tok of ["Today's ", "weather ", "looks"]) b.observeToken(tok);
    await b.settle();
    // The model actually wants a *different* tool/args — prefetch is useless.
    const miss = b.consume("vault_read", { slug: "secrets" });
    console.log("consume(vault_read, secrets):", miss, "→ caller runs the real tool");
    console.log("discarded (never consumed) entries:", b.discardedCount());
    b.cleanup();
  })();
}
