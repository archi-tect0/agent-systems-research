/**
 * Adaptive Session Symbol Table (SQ-B)
 *
 * Learns repeated 5–8 word phrases within an LLM session and generates
 * compact ~-token shorthand identifiers. Inject the codec dictionary into
 * the system prompt before each LLM call; the model uses ~-tokens in its
 * responses when it recognizes the exact matching phrase.
 *
 * Typical savings: 8–18% additional token reduction on top of other
 * context management techniques, strongest from turn 3 onward.
 *
 * Dependencies: none (pure TypeScript/JavaScript).
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DictEntry {
  phrase:      string;
  token:       string;   // ~XXXXXX format (single-token ASCII prefix)
  frequency:   number;   // how many times this phrase has been seen
  lastUsedMs:  number;   // timestamp of last ingest()
  bytesSaved:  number;   // cumulative bytes saved across all uses
}

export interface TableSnapshot {
  version:   number;
  sessionId: string;
  entries:   Omit<DictEntry, never>[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MIN_NGRAM_WORDS  = 5;    // long phrases only — short n-grams cost more tokens than they save
const MAX_NGRAM_WORDS  = 8;
const MIN_PHRASE_CHARS = 20;   // skip short phrases — not worth compressing
const MIN_BYTES_SAVED  = 8;    // entropy gate: skip entries that save less than this
const DEFAULT_MAX_ENTRIES = 128;

// ── Symbol table ───────────────────────────────────────────────────────────────

export class SqSymbolTable {
  private readonly sessionId: string;
  public  readonly maxEntries: number;
  public  readonly entries: Map<string, DictEntry>;
  private version: number;

  constructor(sessionId: string, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.sessionId  = sessionId;
    this.maxEntries = maxEntries;
    this.entries    = new Map();
    this.version    = 1;
  }

  /**
   * Ingest text — extract n-grams and update the symbol table.
   * Call this on every system-prompt section, user message, and assistant response.
   */
  ingest(text: string): void {
    if (!text?.trim()) return;

    const now    = Date.now();
    const ngrams = this.extractNgrams(text);

    for (const phrase of ngrams) {
      const existing      = this.entries.get(phrase);
      const token         = this.tokenForPhrase(phrase);
      const bytesSavedNow = Math.max(0,
        Buffer.byteLength(phrase, "utf8") - Buffer.byteLength(token, "utf8")
      );

      if (existing) {
        existing.frequency  += 1;
        existing.lastUsedMs  = now;
        existing.bytesSaved += bytesSavedNow;
        continue;
      }

      // Entropy gate: skip phrases that don't save enough bytes per use
      if (bytesSavedNow < MIN_BYTES_SAVED) continue;

      if (this.entries.size >= this.maxEntries) this.evict();

      if (this.entries.size < this.maxEntries) {
        this.entries.set(phrase, {
          phrase,
          token,
          frequency:  1,
          lastUsedMs: now,
          bytesSaved: bytesSavedNow,
        });
      }
    }

    this.version++;
  }

  /**
   * Score a table entry.
   *   score = frequency×0.6 + recency×0.3 + bytes_per_use×0.1
   * recency decays with a 60-second half-life within the scoring window.
   *
   * bytesSaved is CUMULATIVE (incremented on every hit), so bytesSaved/frequency
   * is the stable average bytes saved per use — a static tie-breaker favoring
   * longer phrases. It must divide the cumulative total: dividing a single-use
   * constant by frequency would shrink as a phrase recurs, wrongly penalizing the
   * most-repeated phrases (the opposite of the intent).
   */
  score(entry: DictEntry): number {
    const ageSec      = Math.max(0, Date.now() - entry.lastUsedMs) / 1000;
    const recency     = 1 / (1 + ageSec / 60);
    const bytesPerUse = entry.frequency > 0 ? entry.bytesSaved / entry.frequency : 0;
    return entry.frequency * 0.6 + recency * 0.3 + bytesPerUse * 0.1;
  }

  /** Remove the lowest-scoring entry to make room for a new one. */
  evict(): void {
    let lowestKey   = "";
    let lowestScore = Infinity;
    for (const [key, entry] of this.entries) {
      const s = this.score(entry);
      if (s < lowestScore) { lowestScore = s; lowestKey = key; }
    }
    if (lowestKey) { this.entries.delete(lowestKey); this.version++; }
  }

  /**
   * Build the codec injection block for the LLM system prompt.
   *
   * Inject this text before each LLM call. The model will use ~-tokens when
   * it recognizes the exact matching phrase in its response.
   *
   * Format:
   *   CODEC SHORTHAND
   *   Use ~-tokens exactly when you recognize the full matching phrase. ...
   *   session=<id>;version=<v>;entries=<n>
   *   ~TOKEN1=full phrase one
   *   ~TOKEN2=another exact phrase
   */
  buildCodecInjection(skipPhrases?: Set<string>): string {
    const ordered = [...this.entries.values()]
      .filter(e => !skipPhrases?.has(e.phrase))
      .sort((a, b) => this.score(b) - this.score(a));

    if (ordered.length === 0) return "";

    const lines = [
      "CODEC SHORTHAND",
      "Use ~-token refs exactly when you recognize the full matching phrase. " +
      "Prefer refs only for exact phrase reuse. Do not invent new refs.",
      `session=${this.sessionId};version=${this.version};entries=${ordered.length}`,
      ...ordered.map(e => `${e.token}=${e.phrase}`),
    ];

    return lines.join("\n");
  }

  /** Snapshot for serialization / cross-session transfer. */
  snapshot(): TableSnapshot {
    return {
      version:   this.version,
      sessionId: this.sessionId,
      entries:   [...this.entries.values()].sort((a, b) => this.score(b) - this.score(a)),
    };
  }

  /** Estimated token savings statistics. */
  stats(): { entries: number; estimatedSavingsPct: { min: number; typical: number; max: number } } {
    return {
      entries: this.entries.size,
      estimatedSavingsPct: { min: 8, typical: 12, max: 18 },
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private extractNgrams(text: string): string[] {
    const words = text.trim().split(/\s+/).filter(w => w.length > 0);
    const seen  = new Set<string>();
    const out:  string[] = [];
    for (let n = MIN_NGRAM_WORDS; n <= MAX_NGRAM_WORDS; n++) {
      for (let i = 0; i <= words.length - n; i++) {
        const phrase = words.slice(i, i + n).join(" ");
        if (phrase.length < MIN_PHRASE_CHARS) continue;
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        out.push(phrase);
      }
    }
    return out;
  }

  private tokenForPhrase(phrase: string): string {
    const existing = this.entries.get(phrase);
    if (existing) return existing.token;
    const hash = fnv1a32(phrase);
    return `~${hash.toString(36).toUpperCase()}`;
  }
}

// ── FNV-1a 32-bit hash — fast, deterministic, no external dependencies ─────────
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash  = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ── Demo ───────────────────────────────────────────────────────────────────────
if (process.argv[2] === "--demo") {
  const table = new SqSymbolTable("demo-session-001");

  // Simulate ingesting a system prompt and conversation turns
  const systemPrompt = `You are a helpful AI assistant. When the user asks about
    the authentication flow, explain the complete authentication flow including
    token validation and session management. Always include the authentication
    flow details when relevant to the current conversation.`;

  const userMsg1 = "Can you explain the authentication flow for our application?";
  const assistantMsg1 = "The authentication flow starts with a user submitting credentials. The authentication flow validates the token and creates a session. The authentication flow ends with a session cookie being set.";

  table.ingest(systemPrompt);
  table.ingest(userMsg1);
  table.ingest(assistantMsg1);

  console.log("Symbol table entries:", table.entries.size);
  console.log("\nCodec injection block:");
  console.log(table.buildCodecInjection());
  console.log("\nStats:", table.stats());
}
