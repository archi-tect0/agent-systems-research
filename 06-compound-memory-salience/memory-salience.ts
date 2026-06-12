/**
 * Compound Memory Salience Scoring + Consolidation
 *
 * Turns raw vector-similarity hits into a compound salience score:
 *
 *   salience = (W_sim*similarity + W_rec*recency*freshBoost
 *               + W_emo*emotional + W_conf*confidence + W_trust*sourceTrust)
 *              * (0.7 + 0.6 * priorityNorm)
 *
 * and provides a two-phase retrieval (corrections bypass the cosine race) plus
 * a soft-archive consolidation pass for housekeeping.
 *
 * Storage-agnostic: the vector search and persistence sit behind the
 * MemoryStore interface so the scoring logic is testable without a database.
 * In production the store is backed by Postgres + pgvector (the `<=>` cosine
 * distance operator); here the --demo block uses an in-memory store.
 *
 * Dependencies: none (pure TypeScript).
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type MemoryClass =
  | "general"
  | "user_fact"
  | "correction"
  | "shared_moment"
  | "project_log"
  | "vault_artifact";

export type MemorySource =
  | "explicit_user_statement"
  | "confirmed_correction"
  | "inferred"
  | "system_derived"
  | "imported";

export interface MemoryRecord {
  id:              string;
  wallet:          string;
  class:           MemoryClass;
  source:          MemorySource;
  content:         string;
  confidence:      number;          // 0–1
  emotionalWeight: number | null;   // 0–1
  priority:        number;          // 0–100 (class weight)
  createdAt:       Date;
  lastTouchedAt:   Date | null;
  archivedAt:      Date | null;
  expiresAfterDays:number | null;
  distance?:       number;          // cosine distance from a vector query (0–2)
}

export interface SalienceInput {
  similarity:      number;
  emotionalWeight: number;
  confidence:      number;
  source:          string;
  lastTouchedAt:   Date | null;
  priority:        number;
}

// ── Weights (tunable) ────────────────────────────────────────────────────────
const W_SIMILARITY   = 0.32;
const W_RECENCY      = 0.26;
const W_EMOTIONAL    = 0.20;
const W_CONFIDENCE   = 0.14;
const W_SOURCE_TRUST = 0.08;

const SOURCE_TRUST_MAP: Record<string, number> = {
  explicit_user_statement: 1.0,
  confirmed_correction:    0.95,
  inferred:                0.75,
  system_derived:          0.65,
  imported:                0.50,
};

const HALF_LIFE_DAYS  = 14;
const DAY_MS          = 86_400_000;
const HOUR_MS         = 60 * 60 * 1000;
const FRESH_WINDOW_HOURS = 2;                 // session-fresh boost tapers over this window
const FRESH_BOOST       = 1.6;                // recency multiplier at age 0
const FRESH_BOOST_FLOOR = 1.3;                // multiplier at the end of the window (before dropping to 1.0)

// Phase-2 candidate pool: over-fetch raw vector hits, score the whole pool, then
// slice to k — so a highly salient but topically distant memory isn't cut by the
// vector index before the compound score is ever computed.
const VECTOR_CANDIDATE_MULTIPLIER = 3;
const VECTOR_CANDIDATE_MIN        = 50;

// ── Recency decay ─────────────────────────────────────────────────────────────
// Exponential decay: full score if touched now, half-score after HALF_LIFE_DAYS.

function recencyScore(lastTouchedAt: Date | null | undefined): number {
  if (!lastTouchedAt) return 0.3;
  const daysSince = (Date.now() - lastTouchedAt.getTime()) / DAY_MS;
  return Math.pow(0.5, daysSince / HALF_LIFE_DAYS);
}

// ── Salience computation ──────────────────────────────────────────────────────

export function computeSalience(m: SalienceInput): number {
  const recency      = recencyScore(m.lastTouchedAt);
  const sourceTrust  = SOURCE_TRUST_MAP[m.source] ?? 0.6;
  const priorityNorm = Math.min(1, m.priority / 100);

  // Session-fresh boost: memories touched recently surface above static seeds so
  // mid-session facts win the recency race. Linearly taper the multiplier from
  // FRESH_BOOST (age 0) down to FRESH_BOOST_FLOOR at the end of the window instead
  // of a hard 1.6→1.0 step, so a memory's score doesn't fall off a cliff the
  // instant it crosses the 2-hour mark mid-conversation.
  let freshBoost = 1.0;
  if (m.lastTouchedAt) {
    const hoursSince = (Date.now() - m.lastTouchedAt.getTime()) / HOUR_MS;
    if (hoursSince <= FRESH_WINDOW_HOURS) {
      freshBoost = FRESH_BOOST - (FRESH_BOOST - FRESH_BOOST_FLOOR) * (hoursSince / FRESH_WINDOW_HOURS);
    }
  }

  const raw =
    W_SIMILARITY   * m.similarity            +
    W_RECENCY      * recency * freshBoost     +
    W_EMOTIONAL    * m.emotionalWeight        +
    W_CONFIDENCE   * m.confidence            +
    W_SOURCE_TRUST * sourceTrust;

  // Class priority modulates the final score by ±30%, centered on a baseline of
  // 1.0 at priority 50: priority 0 → ×0.7, priority 50 → ×1.0, priority 100 → ×1.3.
  return raw * (0.7 + 0.6 * priorityNorm);
}

/**
 * Re-rank a list of vector hits by compound salience.
 * `distance` is pgvector cosine distance (0–2); converted to similarity here.
 */
export function rerankBySalience<T extends MemoryRecord>(hits: T[]): T[] {
  return hits
    .map(h => ({
      h,
      _salience: computeSalience({
        similarity:      h.distance !== undefined ? Math.max(0, 1 - h.distance / 2) : 0.7,
        emotionalWeight: h.emotionalWeight ?? 0.5,
        confidence:      h.confidence,
        source:          h.source,
        lastTouchedAt:   h.lastTouchedAt,
        priority:        h.priority,
      }),
    }))
    .sort((a, b) => b._salience - a._salience)
    .map(x => x.h);
}

// ── Storage interface ─────────────────────────────────────────────────────────

export interface MemoryStore {
  /** Behavioral corrections, ordered by priority then recency. No cosine. */
  selectCorrections(wallet: string, limit: number): Promise<MemoryRecord[]>;
  /** Cosine search over the given classes; rows carry a `distance` field. */
  vectorSearch(opts: {
    wallet: string; query: string; classes: MemoryClass[]; limit: number;
  }): Promise<MemoryRecord[]>;
  /** Bump lastTouchedAt — drives recency. Fire-and-forget. */
  touch(id: string): Promise<void>;
  /** Soft-archive (set archivedAt). Never a hard delete. */
  archive(id: string): Promise<void>;
  /** Adjust a memory's confidence in place. */
  setConfidence(id: string, confidence: number): Promise<void>;
  /** All non-archived memories for a wallet (consolidation input). */
  listActive(wallet: string): Promise<MemoryRecord[]>;
}

// ── Two-phase retrieval ───────────────────────────────────────────────────────

export async function searchMemory(
  store: MemoryStore,
  opts: { wallet: string; query: string; classes?: MemoryClass[]; k?: number },
): Promise<MemoryRecord[]> {
  const k       = Math.max(1, Math.min(opts.k ?? 12, 30));
  const classes = opts.classes ??
    (["correction", "user_fact", "shared_moment", "project_log", "general"] as MemoryClass[]);

  const results: MemoryRecord[] = [];

  // Phase 1 — corrections: always retrieved, no cosine filter.
  if (classes.includes("correction")) {
    results.push(...await store.selectCorrections(opts.wallet, 10));
  }

  // Phase 2 — cosine search for the remaining classes.
  const semanticClasses = classes.filter(c => c !== "correction");
  if (semanticClasses.length > 0 && opts.query) {
    results.push(...await store.vectorSearch({
      wallet: opts.wallet, query: opts.query, classes: semanticClasses,
      limit: Math.max(VECTOR_CANDIDATE_MIN, k * VECTOR_CANDIDATE_MULTIPLIER),
    }));
  }

  // Compound re-rank, de-dup by id, slice to k.
  const seen = new Set<string>();
  const ranked = rerankBySalience(results)
    .filter(m => !m.archivedAt && !seen.has(m.id) && (seen.add(m.id), true))
    .slice(0, k);

  // Touch recalled memories so recency scoring stays accurate.
  for (const m of ranked) void store.touch(m.id);

  return ranked;
}

// ── Consolidation ─────────────────────────────────────────────────────────────

export interface ConsolidationResult {
  archived: number;
  decayed:  number;
  promoted: number;
}

const STALE_DAYS    = 30;
const PROMOTE_DAYS  = 3;

export async function consolidateMemories(
  store: MemoryStore,
  wallet: string,
): Promise<ConsolidationResult> {
  let archived = 0, decayed = 0, promoted = 0;
  const now = Date.now();
  const active = await store.listActive(wallet);

  for (const m of active) {
    // 1. Archive hard-expired memories.
    if (m.expiresAfterDays != null) {
      const expiresAt = m.createdAt.getTime() + m.expiresAfterDays * DAY_MS;
      if (expiresAt <= now) { await store.archive(m.id); archived++; continue; }
    }

    const touchedMs = (m.lastTouchedAt ?? m.createdAt).getTime();
    const ageDays   = (now - touchedMs) / DAY_MS;

    // 2. Decay stale low-confidence general memories.
    if (m.class === "general" && ageDays > STALE_DAYS && m.confidence < 0.5) {
      await store.setConfidence(m.id, m.confidence * 0.8);
      await store.archive(m.id);
      decayed++;
      continue;
    }

    // 3. Promote high-recall memories (touched recently, not yet confident).
    if (ageDays <= PROMOTE_DAYS && m.confidence < 0.95) {
      await store.setConfidence(m.id, Math.min(0.98, m.confidence + 0.05));
      promoted++;
    }
  }

  return { archived, decayed, promoted };
}

// ── In-memory store (for the demo / tests) ────────────────────────────────────

export class InMemoryStore implements MemoryStore {
  private rows: MemoryRecord[] = [];

  seed(rows: MemoryRecord[]): void { this.rows.push(...rows); }

  async selectCorrections(wallet: string, limit: number): Promise<MemoryRecord[]> {
    return this.rows
      .filter(r => r.wallet === wallet && r.class === "correction" && !r.archivedAt)
      .sort((a, b) => b.priority - a.priority ||
        (b.lastTouchedAt?.getTime() ?? 0) - (a.lastTouchedAt?.getTime() ?? 0))
      .slice(0, limit)
      .map(r => ({ ...r, distance: 0 }));
  }

  async vectorSearch(opts: {
    wallet: string; query: string; classes: MemoryClass[]; limit: number;
  }): Promise<MemoryRecord[]> {
    // Deterministic pseudo-cosine: Jaccard distance over word sets.
    const q = new Set(opts.query.toLowerCase().split(/\s+/));
    return this.rows
      .filter(r => r.wallet === opts.wallet && !r.archivedAt && opts.classes.includes(r.class))
      .map(r => {
        const w = new Set(r.content.toLowerCase().split(/\s+/));
        const inter = [...q].filter(x => w.has(x)).length;
        const union = new Set([...q, ...w]).size || 1;
        const sim = inter / union;
        return { ...r, distance: (1 - sim) * 2 };   // map similarity → [0,2]
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, opts.limit);
  }

  async touch(id: string): Promise<void> {
    const r = this.rows.find(x => x.id === id);
    if (r) r.lastTouchedAt = new Date();
  }
  async archive(id: string): Promise<void> {
    const r = this.rows.find(x => x.id === id);
    if (r) r.archivedAt = new Date();
  }
  async setConfidence(id: string, c: number): Promise<void> {
    const r = this.rows.find(x => x.id === id);
    if (r) r.confidence = c;
  }
  async listActive(wallet: string): Promise<MemoryRecord[]> {
    return this.rows.filter(r => r.wallet === wallet && !r.archivedAt);
  }
}

// ── Demo ───────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const now = Date.now();
  const daysAgo = (d: number) => new Date(now - d * DAY_MS);

  const store = new InMemoryStore();
  store.seed([
    { id: "c1", wallet: "w", class: "correction", source: "confirmed_correction",
      content: "do not call the user by their username", confidence: 1.0,
      emotionalWeight: 0.3, priority: 100, createdAt: daysAgo(40),
      lastTouchedAt: daysAgo(40), archivedAt: null, expiresAfterDays: null },
    { id: "f1", wallet: "w", class: "user_fact", source: "explicit_user_statement",
      content: "the user is building a payments dashboard this week", confidence: 0.95,
      emotionalWeight: 0.5, priority: 90, createdAt: daysAgo(0),
      lastTouchedAt: new Date(now - 5 * 60 * 1000), archivedAt: null, expiresAfterDays: null },
    { id: "f2", wallet: "w", class: "user_fact", source: "imported",
      content: "the user once mentioned a payments project long ago", confidence: 0.6,
      emotionalWeight: 0.4, priority: 90, createdAt: daysAgo(220),
      lastTouchedAt: daysAgo(220), archivedAt: null, expiresAfterDays: null },
    { id: "g1", wallet: "w", class: "general", source: "inferred",
      content: "weather small talk about a payments meeting", confidence: 0.3,
      emotionalWeight: 0.2, priority: 50, createdAt: daysAgo(45),
      lastTouchedAt: daysAgo(45), archivedAt: null, expiresAfterDays: null },
  ]);

  (async () => {
    const ranked = await searchMemory(store, {
      wallet: "w", query: "what is the user building", k: 4,
      classes: ["correction", "user_fact", "general"],
    });
    console.log("Ranked recall:");
    for (const m of ranked) console.log(`  [${m.class}] ${m.content}`);

    const result = await consolidateMemories(store, "w");
    console.log("\nConsolidation:", result);
  })();
}
