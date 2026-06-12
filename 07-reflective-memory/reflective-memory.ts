/**
 * Reflective Memory with Use-Reinforced Sorting
 *
 * A categorized store of behavioral lessons, insights, and self-audit results
 * that are injected into every turn (not retrieved on demand). The key property
 * is use-reinforcement: injecting a reflection into context bumps its updatedAt,
 * so frequently-used reflections float to the top (warm pathways stay warm) and
 * unused ones cool off and are eventually pruned by a decay pass.
 *
 * Persistence is behind the ReflectionStore interface so the logic is testable
 * without a database. In production it is backed by Postgres.
 *
 * Dependencies: none (pure TypeScript; uses crypto.randomUUID from Node).
 */

import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ReflectionCategory =
  | "lesson"
  | "insight"
  | "model_update"
  | "self_audit"
  | "pattern"
  | "correction"
  | "milestone";

export interface ReflectiveEntry {
  id:           string;
  wallet:       string;
  category:     ReflectionCategory;
  content:      string;
  confidence:   number;
  confirmed:    boolean;
  source:       string;
  updatedAt:    Date;
  archivedAt:   Date | null;
  /**
   * Self-referential pointer for contradiction handling. When a new reflection
   * overrides an older, contradictory one, the new row records the old row's id
   * here and the old row is soft-archived in the same step. Null for originals.
   */
  supersedesId: string | null;
}

// Display priority for the per-turn context block: corrections lead, self-audits
// trail. Chosen by behavioral importance, independent of recency.
const CATEGORY_PRIORITY: ReflectionCategory[] = [
  "correction", "lesson", "pattern", "model_update", "milestone", "insight", "self_audit",
];

const DAY_MS                = 86_400_000;
const CONTEXT_CANDIDATES    = 12;   // pull this many warmest entries
const CONTEXT_BLOCK_MAX     = 8;    // display at most this many
const CONTENT_TRUNCATE      = 120;  // chars per entry in the block

// ── Storage interface ─────────────────────────────────────────────────────────

export interface ReflectionStore {
  insert(entry: ReflectiveEntry): Promise<void>;
  /** Non-archived rows for a wallet, ORDER BY updatedAt DESC, optional category. */
  list(wallet: string, category: ReflectionCategory | undefined, limit: number): Promise<ReflectiveEntry[]>;
  /** Bump updatedAt to now for the given ids (use-reinforcement). */
  bump(ids: string[]): Promise<void>;
  /** Soft-archive rows matching the decay predicate; returns count archived. */
  archiveStale(wallet: string, confirmed: boolean, olderThan: Date): Promise<number>;
  archiveOne(wallet: string, id: string): Promise<void>;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function addReflection(
  store: ReflectionStore,
  input: {
    wallet:       string;
    category:     ReflectionCategory;
    content:      string;
    confidence?:  number;
    source?:      string;
    confirmed?:   boolean;
    /** If set, the new entry supersedes this id, which is soft-archived. */
    supersedesId?: string;
  },
): Promise<ReflectiveEntry> {
  const entry: ReflectiveEntry = {
    id:           randomUUID(),
    wallet:       input.wallet,
    category:     input.category,
    content:      input.content,
    confidence:   input.confidence ?? 0.9,
    confirmed:    input.confirmed ?? false,
    source:       input.source ?? "agent_inference",
    updatedAt:    new Date(),
    archivedAt:   null,
    supersedesId: input.supersedesId ?? null,
  };
  await store.insert(entry);
  // Soft-archive the contradicted entry in the same step. Never a hard delete:
  // the superseded row stays queryable via the supersedesId back-pointer.
  if (input.supersedesId) {
    await store.archiveOne(input.wallet, input.supersedesId);
  }
  return entry;
}

export async function listReflections(
  store: ReflectionStore,
  wallet: string,
  category?: ReflectionCategory,
  limit = 20,
): Promise<ReflectiveEntry[]> {
  return store.list(wallet, category, limit);
}

// ── Context injection (called every turn) ─────────────────────────────────────

/**
 * Build the reflective context block and reinforce the injected entries.
 *
 * Two-layer ordering:
 *   1. Candidate set = the CONTEXT_CANDIDATES warmest entries (updatedAt DESC).
 *   2. Display order = those re-sorted by CATEGORY_PRIORITY, top CONTEXT_BLOCK_MAX.
 *
 * Reinforcement (bump) is fire-and-forget — never awaited — so it adds no
 * latency to the LLM turn. We bump the entire candidate set, not just the
 * displayed top-N: a warm, high-priority entry that always wins the category sort
 * would otherwise starve the warm-but-lower-priority entries below it (they were
 * relevant enough to load but never get their timestamp refreshed, so they cool
 * off and get pruned despite being actively considered every turn).
 */
export async function getReflectiveContext(
  store: ReflectionStore,
  wallet: string,
): Promise<string> {
  let entries: ReflectiveEntry[];
  try {
    entries = await listReflections(store, wallet, undefined, CONTEXT_CANDIDATES);
  } catch {
    return "";
  }
  if (entries.length === 0) return "";

  const sorted = [...entries].sort(
    (a, b) => CATEGORY_PRIORITY.indexOf(a.category) - CATEGORY_PRIORITY.indexOf(b.category),
  );
  const top = sorted.slice(0, CONTEXT_BLOCK_MAX);

  // Use-reinforcement: bump the entire candidate set (everything warm enough to
  // be considered this turn), not just the displayed top-N — otherwise entries
  // that consistently lose the category-priority cut would starve and be pruned
  // despite being relevant every turn. Fire-and-forget so it adds no latency.
  if (entries.length > 0) {
    void store.bump(entries.map(e => e.id)).catch(() => {});
  }

  const lines = ["\nREFLECTIVE:"];
  for (const e of top) {
    const cat = e.category.toUpperCase().replace(/_/g, "");
    lines.push(`[${cat}] ${e.content.slice(0, CONTENT_TRUNCATE)}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── Decay (called nightly) ────────────────────────────────────────────────────

/**
 * Archive reflections that have gone cold: unconfirmed entries not touched
 * (updatedAt) in more than thresholdDays. Confirmed entries are never decayed.
 */
export async function decayStaleReflections(
  store: ReflectionStore,
  wallet: string,
  thresholdDays = 45,
): Promise<number> {
  const cutoff = new Date(Date.now() - thresholdDays * DAY_MS);
  return store.archiveStale(wallet, /*confirmed=*/ false, cutoff);
}

export async function archiveReflection(
  store: ReflectionStore,
  wallet: string,
  id: string,
): Promise<void> {
  await store.archiveOne(wallet, id);
}

// ── In-memory store (for the demo / tests) ────────────────────────────────────

export class InMemoryReflectionStore implements ReflectionStore {
  private rows: ReflectiveEntry[] = [];

  async insert(entry: ReflectiveEntry): Promise<void> { this.rows.push({ ...entry }); }

  async list(wallet: string, category: ReflectionCategory | undefined, limit: number): Promise<ReflectiveEntry[]> {
    return this.rows
      .filter(r => r.wallet === wallet && !r.archivedAt && (!category || r.category === category))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
      .map(r => ({ ...r }));
  }

  async bump(ids: string[]): Promise<void> {
    const now = new Date();
    for (const r of this.rows) if (ids.includes(r.id)) r.updatedAt = now;
  }

  async archiveStale(wallet: string, confirmed: boolean, olderThan: Date): Promise<number> {
    let n = 0;
    for (const r of this.rows) {
      if (r.wallet === wallet && !r.archivedAt && r.confirmed === confirmed && r.updatedAt < olderThan) {
        r.archivedAt = new Date();
        n++;
      }
    }
    return n;
  }

  async archiveOne(wallet: string, id: string): Promise<void> {
    const r = this.rows.find(x => x.wallet === wallet && x.id === id);
    if (r) r.archivedAt = new Date();
  }

  /** Test helper: directly set an entry's updatedAt (simulate age). */
  _setUpdatedAt(id: string, date: Date): void {
    const r = this.rows.find(x => x.id === id);
    if (r) r.updatedAt = date;
  }
}

// ── Demo ───────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  (async () => {
    const store = new InMemoryReflectionStore();
    const wallet = "w";

    const lesson = await addReflection(store, {
      wallet, category: "lesson", content: "the user prefers code examples over prose",
    });
    const insight = await addReflection(store, {
      wallet, category: "insight", content: "I tend to over-explain simple questions",
    });
    await addReflection(store, {
      wallet, category: "correction", content: "when the user says stop, make no more tool calls",
      confirmed: true,
    });

    // Make the lesson and insight look old (45+ days) to demo decay later.
    store._setUpdatedAt(lesson.id, new Date(Date.now() - 60 * DAY_MS));
    store._setUpdatedAt(insight.id, new Date(Date.now() - 60 * DAY_MS));

    // First injection: correction leads by category priority; lesson/insight are
    // injected too, which reinforces them (their updatedAt is bumped to now).
    console.log("Context block (turn 1):");
    console.log(await getReflectiveContext(store, wallet));

    // The lesson was reinforced, so it survives decay; the (now also bumped)
    // insight survives too. Add a stale, never-injected guess to be pruned.
    const staleGuess = await addReflection(store, {
      wallet, category: "self_audit", content: "an unused guess nobody ever reads",
    });
    store._setUpdatedAt(staleGuess.id, new Date(Date.now() - 90 * DAY_MS));

    const archived = await decayStaleReflections(store, wallet, 45);
    console.log(`\nDecay pass archived ${archived} cold unconfirmed reflection(s).`);
    console.log("\nContext block (after decay):");
    console.log(await getReflectiveContext(store, wallet));

    // Contradiction handling: a later cycle learns the user now prefers detail,
    // superseding the earlier "prefers code examples" lesson. The new entry
    // back-points at the old one, which is soft-archived in the same step.
    const superseding = await addReflection(store, {
      wallet, category: "lesson",
      content: "the user now prefers detailed prose walkthroughs",
      supersedesId: lesson.id,
    });
    console.log(`\nSuperseded ${lesson.id} -> ${superseding.id} (supersedesId=${superseding.supersedesId}).`);
    const live = await listReflections(store, wallet, "lesson");
    console.log("Live lessons after supersede:", live.map(e => e.content));
  })();
}
