/**
 * Knowledge Absorber → Zero-Token Vocabulary
 *
 * A self-directed learning loop. When the agent hits a knowledge gap, it asks a
 * strong cloud model a focused "distillation query", compresses the answer into
 * reusable phrases, and feeds those phrases into a cross-user frequency ledger.
 * Phrases that recur across many users and sessions graduate through a pipeline:
 *
 *   candidate → scheduled → trained → zero-token vocab
 *
 * Once a phrase is "trained" (baked into the model's prefix/weights via the LoRA
 * prefix-weight compiler), it is WEIGHT-RESIDENT: the model already carries it,
 * so the runtime stops spending context tokens to inject it. That is the
 * "zero-token" payoff — the model's working vocabulary grows by compressing more
 * of itself into weight-resident references, not by enlarging the prompt.
 *
 * Provenance safety: absorbed facts are tagged "synthetic" and must never
 * influence auth / spend / security decisions.
 *
 * This reference uses a mock distiller (no network) and an in-memory ledger so
 * it runs standalone; in production swap in a real LLM call and a database.
 *
 * Related: the SQ symbol-table / session-compression guides (the per-session
 * tier this ledger aggregates from) and the LoRA prefix-weight compiler (the
 * "trained" step that makes a phrase weight-resident).
 *
 * Dependencies: none (pure TypeScript).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type LoraStatus = "candidate" | "scheduled" | "trained";

export interface LedgerEntry {
  phrase:          string;
  globalFrequency: number;
  userCount:       number;
  sessionCount:    number;
  totalBytesSaved: number;
  loraStatus:      LoraStatus;
  loraVersion?:    string;
  lastSeenMs:      number;
}

export interface ZeroTokenEntry {
  phrase:       string;
  loraVersion:  string;
  uses:         number;
  bytesSaved:   number;
  promotedMs:   number;
  lastUsedMs:   number;
}

export interface AbsorptionResult {
  gap:              string;
  phrasesExtracted: number;
  digest:           string;
}

/** A distiller turns a gap + context into dense, compressible factual text. */
export type Distiller = (query: string, signal?: AbortSignal) => Promise<string>;

// ── Tunables ───────────────────────────────────────────────────────────────────

const CANDIDATE_GLOBAL_FREQ = 50;   // phrase must recur this often globally
const CANDIDATE_MIN_USERS   = 3;    // ...across at least this many distinct users
const MAX_PHRASES_PER_ABSORB = 50;  // cap per distillation
const DECAY_PER_DAY         = 0.1;  // recency decay rate for zero-token ranking

// ── In-memory stores (swap for DB tables in production) ──────────────────────────

const _ledger    = new Map<string, LedgerEntry>();
const _zeroToken = new Map<string, ZeroTokenEntry>();

// ── 1. Absorption — gap → distillation → phrases → ledger ───────────────────────

export async function absorb(opts: {
  user:           string;
  gapDescription: string;
  context?:       string;
  distiller:      Distiller;
  signal?:        AbortSignal;
}): Promise<AbsorptionResult | null> {
  const { user, gapDescription, context = "", distiller, signal } = opts;

  const query  = buildDistillationQuery(gapDescription, context);
  const digest = (await distiller(query, signal)).trim();
  if (!digest || signal?.aborted) return null;

  const phrases = extractAbsorptionPhrases(digest);
  for (const phrase of phrases) {
    flushPhrase(phrase, user, phrase.length);
  }

  return { gap: gapDescription, phrasesExtracted: phrases.length, digest };
}

/** Build a focused query that elicits dense, reusable, declarative facts. */
function buildDistillationQuery(gap: string, context: string): string {
  const ctx = context.slice(0, 300);
  return [
    `Knowledge gap: ${gap}`,
    ctx ? `\nConversation context: ${ctx}` : "",
    "\n\nProvide a dense factual summary that directly addresses this gap.",
    " Focus on facts that are stable, reusable, and worth memorizing.",
    " Each sentence = one standalone, compressible fact.",
  ].join("");
}

/**
 * Extract candidate phrases from distilled text:
 *   - whole sentences that are compact enough to be a phrase (15..80 chars)
 *   - sliding 3..6-word noun-phrase chunks (15..60 chars)
 * Deduplicated case-insensitively, capped per absorption.
 */
export function extractAbsorptionPhrases(text: string): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string) => {
    const norm = raw.toLowerCase();
    if (!seen.has(norm)) { seen.add(norm); phrases.push(raw); }
  };

  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 15);
  for (const sentence of sentences) {
    if (sentence.length <= 80) add(sentence);

    const words = sentence.split(/\s+/);
    for (let i = 0; i < words.length - 2; i++) {
      for (let len = 3; len <= Math.min(6, words.length - i); len++) {
        const chunk = words.slice(i, i + len).join(" ");
        if (chunk.length >= 15 && chunk.length <= 60) add(chunk);
      }
    }
  }
  return phrases.slice(0, MAX_PHRASES_PER_ABSORB);
}

// ── 2. Ledger flush — aggregate one phrase across users/sessions ─────────────────

function flushPhrase(phrase: string, user: string, bytesSaved: number): void {
  const key = phrase.trim();
  if (!key) return;

  const existing = _ledger.get(key);
  if (!existing) {
    _ledger.set(key, {
      phrase: key, globalFrequency: 1, userCount: 1, sessionCount: 1,
      totalBytesSaved: bytesSaved, loraStatus: "candidate", lastSeenMs: Date.now(),
    });
    _firstUser.set(key, new Set([user]));
    return;
  }
  existing.globalFrequency += 1;
  existing.sessionCount    += 1;
  existing.totalBytesSaved += bytesSaved;
  existing.lastSeenMs       = Date.now();

  const users = _firstUser.get(key) ?? new Set<string>();
  users.add(user);
  _firstUser.set(key, users);
  existing.userCount = users.size;
}

const _firstUser = new Map<string, Set<string>>();

// ── 3. Graduation pipeline: candidate → scheduled → trained ──────────────────────

/** Phrases that have crossed the recurrence thresholds and are still candidates. */
export function queryCandidates(
  minFreq = CANDIDATE_GLOBAL_FREQ,
  minUsers = CANDIDATE_MIN_USERS,
): LedgerEntry[] {
  return [..._ledger.values()].filter(
    e => e.loraStatus === "candidate" && e.globalFrequency >= minFreq && e.userCount >= minUsers,
  );
}

/** Snapshot candidates for the training run and mark them scheduled. */
export function exportCandidates(): LedgerEntry[] {
  const candidates = queryCandidates();
  for (const c of candidates) c.loraStatus = "scheduled";
  return candidates;
}

/**
 * After the training run bakes these phrases into the model prefix/weights,
 * promote them to the zero-token vocab. From now the runtime skips injecting
 * them — the model's weights carry them at zero per-turn token cost.
 */
export function markTrained(phrases: string[], loraVersion: string): void {
  const now = Date.now();
  for (const phrase of phrases) {
    const entry = _ledger.get(phrase);
    if (entry) { entry.loraStatus = "trained"; entry.loraVersion = loraVersion; }

    const existing = _zeroToken.get(phrase);
    if (existing) {
      existing.loraVersion = loraVersion;
    } else {
      _zeroToken.set(phrase, {
        phrase, loraVersion, uses: 0,
        bytesSaved: entry?.totalBytesSaved ?? phrase.length,
        promotedMs: now, lastUsedMs: now,
      });
    }
  }
}

// ── 4. Zero-token retrieval with recency-decayed ranking ─────────────────────────

/**
 * Return active zero-token phrases ranked by recency-decayed value:
 *   score = bytesSaved * e^(-DECAY_PER_DAY * daysSinceLastUse)
 * A phrase unused for ~10 days loses ~63% of its weight; ~30 days → ~95%.
 * This stops stale high-volume phrases from crowding out recently active ones
 * within a bounded injection-skip budget.
 */
export function getZeroTokenPhrases(limit = 512): Set<string> {
  const now = Date.now();
  const ranked = [..._zeroToken.values()]
    .map(e => {
      const days = (now - e.lastUsedMs) / 86_400_000;
      return { phrase: e.phrase, score: e.bytesSaved * Math.exp(-DECAY_PER_DAY * days) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.phrase);
  return new Set(ranked);
}

/** Record that a zero-token phrase was used (we saved its injection cost). */
export function recordZeroTokenHit(phrase: string, bytesSaved: number): void {
  const e = _zeroToken.get(phrase);
  if (!e) return;
  e.uses += 1;
  e.bytesSaved += bytesSaved;
  e.lastUsedMs = Date.now();
}

// ── Test hook ───────────────────────────────────────────────────────────────────

export function _resetStores(): void {
  _ledger.clear(); _zeroToken.clear(); _firstUser.clear();
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  // Mock distiller: returns dense factual text without any network call.
  const mockDistiller: Distiller = async () =>
    "The scheduler uses a priority queue ordered by next-run timestamp. " +
    "Jobs are leased with a visibility timeout to prevent double execution. " +
    "A dead-letter queue captures jobs that exceed the retry budget. " +
    "Backoff is exponential with jitter to avoid thundering-herd retries.";

  (async () => {
    // One absorption.
    const r = await absorb({
      user: "user-A",
      gapDescription: "how does the job scheduler avoid double execution",
      distiller: mockDistiller,
    });
    console.log(`Absorbed "${r?.gap}" → ${r?.phrasesExtracted} phrases`);

    // Simulate the same family of phrases recurring across many users/sessions
    // until they cross the candidate thresholds.
    for (let i = 0; i < 60; i++) {
      await absorb({
        user: `user-${i % 5}`,                       // 5 distinct users
        gapDescription: "scheduler internals",
        distiller: mockDistiller,
      });
    }

    const candidates = queryCandidates();
    console.log(`\nCandidates over threshold: ${candidates.length}`);
    console.log("Example:", candidates.slice(0, 3).map(c => `"${c.phrase}" (freq=${c.globalFrequency}, users=${c.userCount})`));

    // Run the graduation pipeline.
    const scheduled = exportCandidates();
    markTrained(scheduled.map(c => c.phrase), "v2");

    const zero = getZeroTokenPhrases();
    console.log(`\nZero-token vocab size after training: ${zero.size}`);
    console.log("These phrases now cost 0 injection tokens per turn.");

    // Record some usage so recency ranking has signal.
    for (const p of [...zero].slice(0, 3)) recordZeroTokenHit(p, p.length);
    console.log("\nTop zero-token by recency-decayed value:", [...getZeroTokenPhrases(3)]);
    process.exit(0);
  })();
}
