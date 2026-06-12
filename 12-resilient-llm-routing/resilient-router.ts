/**
 * Resilient LLM Routing — health-aware multi-provider cascade
 *
 * Two routing strategies over a common LLMBackend interface:
 *
 *   1. PrimaryWithFallback — "named mode" fast-fail. One configured primary
 *      provider with a single fallback. On failure it latches to the fallback
 *      and a background probe restores the primary when it recovers.
 *
 *   2. WaterfallBackend — "auto mode" cascade. An ordered chain of providers;
 *      each request walks the chain until one succeeds. Per-provider health is
 *      isolated so one provider going down never strands traffic on the others.
 *
 * Both share a per-instance HealthGuard:
 *   - rate-limit errors (429 / quota) are SOFT — do not latch, retry next turn
 *   - hard errors latch until a periodic probe confirms recovery
 *   - a hard reset timer prevents an infinite latch from a stale probe
 *
 * When all cloud providers are exhausted the cascade falls back to a small
 * local model. Cloud-sized context (full system prompt + every tool schema +
 * long history) is re-encoded by trimForLocalFallback() so the small model
 * receives a distilled prompt that fits its short context window instead of
 * being silently truncated.
 *
 * Dependencies: none (pure TypeScript). The provider adapters are interfaces;
 * wire real SDKs (OpenAI, Anthropic, Gemini, Groq, etc.) behind them.
 */

// ── Backend contract ───────────────────────────────────────────────────────────

export interface ChatMessage {
  role:        "system" | "user" | "assistant" | "tool";
  content:     string;
  tool_calls?: unknown[];
}

export interface ChatTurnInput {
  messages:     ChatMessage[];
  system?:      string;
  maxTokens?:   number;
  tools?:       unknown[];
  tool_choice?: unknown;
  /** Optional hint the router can use to pick a heavier chain for hard turns. */
  routingHint?: "main" | "heavy";
}

export interface ChatTurnOutput {
  content:  string;
  provider: string;
}

export interface LLMBackend {
  readonly name: string;
  chat(input: ChatTurnInput): Promise<ChatTurnOutput>;
}

// ── Tunables ───────────────────────────────────────────────────────────────────

const PROBE_INTERVAL_MS   = 5  * 60 * 1_000;  // 5 min between recovery probes
const HARD_LATCH_RESET_MS = 30 * 60 * 1_000;  // 30 min max latch before forced reset

// ── HealthGuard — per-instance health state (never a module global) ─────────────

/**
 * Tracks the health of exactly ONE backend. A module-global boolean would let
 * one provider's outage latch every other provider into the fallback path;
 * giving each provider its own guard keeps failures isolated.
 */
export class HealthGuard {
  private _fallback  = false;
  private _latchedAt = 0;
  private _timer:     ReturnType<typeof setInterval> | null = null;

  get isFallback(): boolean { return this._fallback; }

  /** Rate-limit failures are soft — do NOT latch; the next turn retries primary. */
  latch(isRateLimit: boolean): void {
    if (isRateLimit) return;
    this._fallback  = true;
    this._latchedAt = Date.now();
  }

  restore(): void {
    this._fallback  = false;
    this._latchedAt = 0;
  }

  /** Classify an error message as a (soft) rate limit vs a (hard) failure. */
  isRateLimit(msg: string): boolean {
    return msg.includes("429")          || msg.includes("rate_limit") ||
           msg.includes("rate limit")   || msg.includes("quota")      ||
           msg.includes("temporarily rate-limited");
  }

  /** Start the recovery probe loop. The probe only runs while latched. */
  startProbe(probeFn: () => Promise<void>): void {
    if (this._timer) return;
    this._timer = setInterval(async () => {
      if (!this._fallback) return;
      // Forced reset after the cap prevents an infinite latch from a stale probe.
      if (Date.now() - this._latchedAt > HARD_LATCH_RESET_MS) {
        this.restore();
        return;
      }
      try {
        await probeFn();
        this.restore();
      } catch { /* still down — stay latched */ }
    }, PROBE_INTERVAL_MS);
  }

  stopProbe(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

// ── Context re-encoding for the small local fallback ────────────────────────────

const LOCAL_SYS_CHARS = 1_200;  // ~300 tokens — identity header + core rules
const LOCAL_MSG_CHARS =   600;  // ~150 tokens per individual message
const LOCAL_KEEP_MSGS =     6;  // last 3 user+assistant pairs

/**
 * Re-encode a cloud-sized request for a small local model.
 *
 * The input was built for a large cloud context window (full system prompt,
 * every tool schema, tens of thousands of characters of history). Sending it
 * verbatim to a model with a ~4K context window causes a silent truncation
 * that discards the identity header and yields a generic base-model reply.
 *
 * The trimmer instead:
 *   1. keeps only the first system message, capped to the identity header,
 *   2. keeps the last N conversation messages, each hard-truncated,
 *   3. drops tool schemas (small models emit unreliable tool-call JSON).
 */
export function trimForLocalFallback(input: ChatTurnInput): ChatTurnInput {
  const msgs = input.messages;

  const sysMsgs = msgs
    .filter(m => m.role === "system")
    .slice(0, 1)
    .map(m => ({ ...m, content: (m.content ?? "").slice(0, LOCAL_SYS_CHARS) }));

  const convMsgs = msgs
    .filter(m => m.role !== "system")
    .slice(-LOCAL_KEEP_MSGS)
    .map(m => ({ ...m, content: (m.content ?? "").slice(-LOCAL_MSG_CHARS) }));

  return {
    ...input,
    system:   input.system ? input.system.slice(0, LOCAL_SYS_CHARS) : input.system,
    messages: [...sysMsgs, ...convMsgs],
    tools:       [],         // text-only for the small model
    tool_choice: "none",
  };
}

// ── Strategy 1: named mode — one primary, one fallback ──────────────────────────

export class PrimaryWithFallback implements LLMBackend {
  readonly name: string;
  private readonly _guard    = new HealthGuard();
  private readonly _primary:  LLMBackend;
  private readonly _fallback: LLMBackend;

  constructor(primary: LLMBackend, fallback: LLMBackend) {
    this.name      = primary.name;
    this._primary  = primary;
    this._fallback = fallback;
    this._guard.startProbe(() =>
      this._primary.chat({ messages: [{ role: "user", content: "." }], maxTokens: 1 }).then(() => {})
    );
  }

  /** Report which provider is actually serving right now. */
  activeName(): string {
    return this._guard.isFallback ? this._fallback.name : this._primary.name;
  }

  async chat(input: ChatTurnInput): Promise<ChatTurnOutput> {
    if (this._guard.isFallback) return this._fallback.chat(input);
    try {
      return await this._primary.chat(input);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      this._guard.latch(this._guard.isRateLimit(msg));
      return this._fallback.chat(input);
    }
  }
}

// ── Strategy 2: auto mode — ordered cascade with per-provider isolation ──────────

interface WaterfallSlot {
  adapter:      LLMBackend;
  guard:        HealthGuard;
  isConfigured: () => boolean;
}

export class WaterfallBackend implements LLMBackend {
  readonly name = "waterfall";

  private readonly _chain: WaterfallSlot[];
  private readonly _local: LLMBackend;
  private _activeName: string;

  /**
   * @param providers  Ordered cloud providers. Earlier = preferred.
   * @param local      Small local model used when every provider is exhausted.
   */
  constructor(
    providers: Array<{ adapter: LLMBackend; isConfigured?: () => boolean }>,
    local: LLMBackend,
  ) {
    this._local      = local;
    this._activeName = providers[0]?.adapter.name ?? local.name;

    this._chain = providers.map(p => ({
      adapter:      p.adapter,
      guard:        new HealthGuard(),
      isConfigured: p.isConfigured ?? (() => true),
    }));

    for (const slot of this._chain) {
      slot.guard.startProbe(() =>
        slot.adapter.chat({ messages: [{ role: "user", content: "." }], maxTokens: 1 }).then(() => {})
      );
    }
  }

  /** Which provider served the most recent successful turn. */
  get currentName(): string { return this._activeName; }

  async chat(input: ChatTurnInput): Promise<ChatTurnOutput> {
    for (const slot of this._chain) {
      if (!slot.isConfigured() || slot.guard.isFallback) continue;
      try {
        const result = await slot.adapter.chat(input);
        this._activeName = slot.adapter.name;
        return result;
      } catch (err) {
        const msg = (err as Error).message ?? "";
        slot.guard.latch(slot.guard.isRateLimit(msg));
      }
    }
    // All cloud providers exhausted — last line of defense is the local model.
    this._activeName = this._local.name;
    return this._local.chat(trimForLocalFallback(input));
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  // Mock providers: "flaky" always throws a hard error; "rateLimited" throws a
  // 429; "good" succeeds. The local model always succeeds on a trimmed prompt.
  const makeProvider = (name: string, behavior: "ok" | "hard" | "429"): LLMBackend => ({
    name,
    async chat(input) {
      if (behavior === "hard") throw new Error(`${name}: connection refused`);
      if (behavior === "429")  throw new Error(`${name}: 429 rate_limit exceeded`);
      return { content: `reply from ${name} (${input.messages.length} msgs)`, provider: name };
    },
  });

  const local = makeProvider("local-small", "ok");

  const waterfall = new WaterfallBackend(
    [
      { adapter: makeProvider("provider-a", "hard") },
      { adapter: makeProvider("provider-b", "429")  },
      { adapter: makeProvider("provider-c", "ok")   },
    ],
    local,
  );

  const longHistory: ChatMessage[] = [
    { role: "system", content: "IDENTITY HEADER. ".repeat(200) },
    ...Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as ChatMessage["role"],
      content: `message ${i} `.repeat(80),
    })),
  ];

  (async () => {
    const out = await waterfall.chat({ messages: longHistory, tools: [{ schema: "big" }] });
    console.log("Waterfall result:", out);
    console.log("Served by:", waterfall.currentName);

    // Named mode: primary is hard-down → latches to fallback.
    const named = new PrimaryWithFallback(makeProvider("primary", "hard"), local);
    const namedOut = await named.chat({ messages: [{ role: "user", content: "hi" }] });
    console.log("\nNamed-mode result:", namedOut);
    console.log("Active backend:", named.activeName());

    process.exit(0);
  })();
}
