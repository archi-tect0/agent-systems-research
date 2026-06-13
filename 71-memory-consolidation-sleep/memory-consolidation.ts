/**
 * Memory Consolidation ("Sleep") — reference implementation.
 *
 * While an agent is awake it accumulates raw episodic memories — every fact,
 * correction, and observation, duplicates and trivia included. Left unmanaged
 * that store grows without bound, fills with near-identical entries, and buries
 * the few durable lessons under noise. This is the Layer-2 maintenance pass an
 * agent runs on ITS OWN memory, the way sleep consolidates a day's experience:
 * forget the trivial, merge the redundant, and promote what recurs into durable
 * knowledge.
 *
 * The three things a consolidation pass has to do:
 *
 *   1. Decay & forget   — score each memory by salience × recency × usage and
 *                         drop the ones that fall below a threshold, UNLESS they
 *                         are pinned. Old, unused, low-salience trivia is exactly
 *                         what should be forgotten.
 *   2. Dedupe & merge   — cluster near-identical memories (token overlap) and
 *                         fuse each cluster into one entry whose salience is
 *                         BOOSTED by the corroboration of its duplicates.
 *   3. Promote          — a memory corroborated across enough distinct sessions
 *                         graduates from episodic ("I saw X once") to a durable
 *                         semantic lesson ("X is true"), pinned and high-salience.
 *
 * This is the deprecation/forgetting counterpart to guide 69: where 69 grows new
 * capabilities, this prunes and distills accumulated memory so the store stays
 * small, honest, and dense with signal.
 *
 * Run it:
 *   node memory-consolidation.ts --demo   # Node 24+ strips TS types natively
 *   npx tsx memory-consolidation.ts --demo
 *
 * Node.js built-ins only. No network, no embeddings — similarity is token-set
 * Jaccard so the whole pass can be read and run in one deterministic pass.
 */

// ─────────────────────────────────────────────────────────────────────────
// A memory item. `kind` distinguishes a one-off episodic memory from a durable
// semantic lesson; `pinned` items survive decay; `sessions` records the distinct
// sessions that corroborated it (drives promotion).
// ─────────────────────────────────────────────────────────────────────────

type MemoryKind = "episodic" | "lesson";

type MemoryItem = {
  id: string;
  text: string;
  kind: MemoryKind;
  salience: number; // 0..1 — how important the item is on its own
  pinned: boolean; // pinned items are never forgotten
  accessCount: number; // times recalled while awake
  sessions: Set<string>; // distinct sessions that produced/corroborated it
  createdAtHours: number; // age anchor, in hours-since-epoch (demo clock)
  lastAccessHours: number;
};

type RawMemory = {
  id: string;
  text: string;
  salience: number;
  session: string;
  atHours: number;
  pinned?: boolean;
  accessCount?: number;
};

type ConsolidationReport = {
  before: number;
  after: number;
  forgotten: string[];
  merged: { kept: string; absorbed: string[] }[];
  promoted: string[];
};

// ─────────────────────────────────────────────────────────────────────────
// Tunables. All deliberately coarse so the behavior is easy to read.
// ─────────────────────────────────────────────────────────────────────────

const HALF_LIFE_HOURS = 72; // recency half-life: 3 days
const FORGET_THRESHOLD = 0.18; // effective score below this → forgotten (if unpinned)
const SIM_THRESHOLD = 0.6; // Jaccard ≥ this → same memory
const PROMOTE_SESSIONS = 3; // corroborated across ≥ this many sessions → durable lesson
const CORROBORATION_BOOST = 0.12; // salience added per absorbed duplicate (capped at 1)

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─────────────────────────────────────────────────────────────────────────
// The store + the consolidation pass.
// ─────────────────────────────────────────────────────────────────────────

class MemoryStore {
  private items = new Map<string, MemoryItem>();
  /** Injectable clock (hours since epoch) so the demo can simulate elapsed time. */
  nowHours: () => number = () => Date.now() / 3_600_000;

  ingest(raw: RawMemory): void {
    this.items.set(raw.id, {
      id: raw.id,
      text: raw.text,
      kind: "episodic",
      salience: raw.salience,
      pinned: Boolean(raw.pinned),
      accessCount: raw.accessCount ?? 0,
      sessions: new Set([raw.session]),
      createdAtHours: raw.atHours,
      lastAccessHours: raw.atHours,
    });
  }

  list(): MemoryItem[] {
    return [...this.items.values()];
  }

  size(): number {
    return this.items.size;
  }

  /** Effective retention score: salience, decayed by age, lifted by usage. */
  effectiveScore(item: MemoryItem, now: number): number {
    const ageHours = Math.max(0, now - item.lastAccessHours);
    const recency = Math.pow(0.5, ageHours / HALF_LIFE_HOURS);
    const usage = Math.min(1, item.accessCount / 5);
    return 0.6 * item.salience * recency + 0.4 * usage;
  }

  /** The "sleep" pass: decay+forget, then dedupe+merge, then promote. */
  consolidate(): ConsolidationReport {
    const now = this.nowHours();
    const before = this.items.size;
    const forgotten: string[] = [];
    const merged: { kept: string; absorbed: string[] }[] = [];
    const promoted: string[] = [];

    // (1) Decay & forget — pinned items are exempt.
    for (const item of [...this.items.values()]) {
      if (item.pinned) continue;
      if (this.effectiveScore(item, now) < FORGET_THRESHOLD) {
        this.items.delete(item.id);
        forgotten.push(item.id);
      }
    }

    // (2) Dedupe & merge — greedy clustering by token-set similarity. Survivors
    //     are processed in descending salience so the strongest text is kept.
    const survivors = [...this.items.values()].sort((a, b) => b.salience - a.salience);
    const consumed = new Set<string>();
    for (const anchor of survivors) {
      if (consumed.has(anchor.id)) continue;
      const anchorTokens = tokenize(anchor.text);
      const absorbed: string[] = [];
      for (const other of survivors) {
        if (other.id === anchor.id || consumed.has(other.id)) continue;
        if (jaccard(anchorTokens, tokenize(other.text)) >= SIM_THRESHOLD) {
          // Fuse `other` into `anchor`.
          anchor.salience = Math.min(1, anchor.salience + CORROBORATION_BOOST);
          anchor.accessCount += other.accessCount;
          anchor.lastAccessHours = Math.max(anchor.lastAccessHours, other.lastAccessHours);
          anchor.pinned = anchor.pinned || other.pinned;
          for (const s of other.sessions) anchor.sessions.add(s);
          this.items.delete(other.id);
          consumed.add(other.id);
          absorbed.push(other.id);
        }
      }
      if (absorbed.length > 0) merged.push({ kept: anchor.id, absorbed });
    }

    // (3) Promote — corroborated across enough distinct sessions → durable lesson.
    for (const item of this.items.values()) {
      if (item.kind === "episodic" && item.sessions.size >= PROMOTE_SESSIONS) {
        item.kind = "lesson";
        item.pinned = true;
        item.salience = Math.max(item.salience, 0.9);
        promoted.push(item.id);
      }
    }

    return { before, after: this.items.size, forgotten, merged, promoted };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Demo
// ─────────────────────────────────────────────────────────────────────────

function banner(t: string) {
  console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
}

function demo() {
  const NOW = 1000; // hours-since-epoch, fixed clock
  const store = new MemoryStore();
  store.nowHours = () => NOW;

  banner("Waking — the store accumulates raw episodic memories (duplicates and trivia)");
  {
    // Three near-identical corroborations of the same durable fact, from 3 sessions.
    store.ingest({ id: "m1", text: "user prefers metric units for weather", salience: 0.7, session: "s1", atHours: NOW - 1 });
    store.ingest({ id: "m2", text: "user prefers metric units for weather forecasts", salience: 0.6, session: "s2", atHours: NOW - 2 });
    store.ingest({ id: "m3", text: "user prefers metric units for the weather", salience: 0.65, session: "s3", atHours: NOW - 3, accessCount: 2 });
    // A pinned high-value durable fact, old but protected.
    store.ingest({ id: "m4", text: "user wallet address ends in 0x91af", salience: 0.95, session: "s1", atHours: NOW - 5000, pinned: true });
    // Stale, low-salience, unused trivia — should be forgotten.
    store.ingest({ id: "m5", text: "user mentioned it was raining last tuesday", salience: 0.2, session: "s2", atHours: NOW - 600 });
    // A fresh, distinct, useful memory — should simply survive.
    store.ingest({ id: "m6", text: "user is preparing a grant application this month", salience: 0.6, session: "s4", atHours: NOW - 10, accessCount: 3 });
    console.log("  ingested 6 raw memories:");
    for (const it of store.list()) console.log(`    • ${it.id} [${it.kind}] sal=${it.salience} "${it.text}"`);
  }

  banner("Sleep — one consolidation pass: forget → merge → promote");
  let report: ConsolidationReport;
  {
    report = store.consolidate();
    console.log(`  size ${report.before} → ${report.after}`);
    console.log(`  forgotten (stale/low-salience): ${JSON.stringify(report.forgotten)}`);
    console.log(`  merged (near-duplicates fused): ${JSON.stringify(report.merged)}`);
    console.log(`  promoted (episodic → durable lesson): ${JSON.stringify(report.promoted)}`);
  }

  banner("After sleep — fewer, denser, with one durable lesson");
  {
    for (const it of store.list()) {
      console.log(`    • ${it.id} [${it.kind}]${it.pinned ? " 📌" : ""} sal=${it.salience.toFixed(2)} sessions=${it.sessions.size} "${it.text}"`);
    }
    console.log("\n  Notes:");
    console.log("  - m1/m2/m3 fused into one item, corroborated across 3 sessions → promoted to a");
    console.log("    durable 'lesson' (pinned, salience lifted).");
    console.log("  - m5 (stale, low-salience, never used) was forgotten.");
    console.log("  - m4 survived despite being ~7 months old, because it is pinned.");
  }

  banner("Second sleep with no new input — stable (consolidation is idempotent-ish)");
  {
    const r2 = store.consolidate();
    console.log(`  size ${r2.before} → ${r2.after}, forgotten=${r2.forgotten.length}, merged=${r2.merged.length}, promoted=${r2.promoted.length}`);
    console.log("  (a consolidated store does not churn on re-runs — no new merges or forgets.)");
  }

  console.log("\nDone. The agent ran a maintenance pass on its OWN memory: it forgot stale trivia,");
  console.log("fused redundant entries while boosting their corroborated salience, and promoted a");
  console.log("repeatedly-confirmed fact into a durable, pinned lesson.\n");
}

if (process.argv.includes("--demo")) {
  demo();
}

export { MemoryStore, tokenize, jaccard };
export type { MemoryItem, MemoryKind, RawMemory, ConsolidationReport };
