/**
 * Intent-Gated Personal Knowledge Shards
 *
 * Dedicated, labeled circuits of per-user knowledge (preferences, routines,
 * relationships, open loops, anti-goals) retrieved per-turn by *intent* and
 * gated by *provenance*:
 *
 *   - intentMask (comma-separated kinds or "*") decides which shards load for
 *     the current turn — keeps the injected block small and on-topic.
 *   - On a security-sensitive path, only "observed" provenance shards are
 *     returned, so inferred/synthetic guesses can never touch an auth/wallet/
 *     threat decision. Enforced at the single retrieval choke point.
 *
 * Persistence is behind the ShardStore interface. In production it is backed by
 * Postgres; the --demo block uses an in-memory store.
 *
 * Dependencies: none (pure TypeScript; uses crypto.randomUUID from Node).
 */

import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────────

export type Provenance =
  | "explicit"    // the user stated it outright
  | "confirmed"   // the agent proposed it and the user confirmed
  | "observed"    // directly observed from the user's actions/statements
  | "inferred"    // the agent deduced it (a guess)
  | "system"      // derived by a background process
  | "synthetic";  // generated/extrapolated by the agent

/** Only directly-observed facts may influence security-sensitive decisions. */
const SECURITY_ALLOWED_PROVENANCE: ReadonlySet<Provenance> = new Set<Provenance>(["observed"]);

export interface Shard {
  id:              string;
  wallet:          string;
  shardKind:       string;       // preference | routine | relationship | open_loop | anti_goal …
  label:           string;       // upsert key — the stable identity of the fact
  content:         string;
  intentMask:      string;       // comma-separated intent kinds, or "*"
  provenance:      Provenance;
  confidence:      number;       // 0–1
  emotionalWeight: number;       // 0–1
  active:          boolean;
  useCount:        number;
  lastUsedAt:      Date | null;
}

export interface ShardResult {
  id:              string;
  shardKind:       string;
  label:           string;
  content:         string;
  provenance:      Provenance;
  confidence:      number;
  emotionalWeight: number;
}

// ── Storage interface ─────────────────────────────────────────────────────────

export interface ShardStore {
  /**
   * Active shards for a wallet, ordered (emotionalWeight DESC, confidence DESC),
   * over-fetched to `limit` (caller passes limit*3). Mask/provenance filtering
   * happens in application code.
   */
  selectActive(wallet: string, limit: number): Promise<Shard[]>;
  bumpUsage(id: string): Promise<void>;
  findByLabel(wallet: string, label: string): Promise<Shard | null>;
  update(id: string, patch: Partial<Shard>): Promise<void>;
  insert(shard: Shard): Promise<void>;
}

// ── Retrieval (the single choke point) ────────────────────────────────────────

function matchesIntent(intentMask: string, intentKind: string): boolean {
  if (intentMask === "*") return true;
  const masks = intentMask.split(",").map(m => m.trim().toLowerCase());
  return masks.includes(intentKind.toLowerCase()) || masks.includes("*");
}

export async function getShards(
  store: ShardStore,
  opts: { wallet: string; intentKind: string; securityPath?: boolean; limit?: number },
): Promise<ShardResult[]> {
  const { wallet, intentKind, securityPath = false, limit = 12 } = opts;

  try {
    // Over-fetch 3×; the mask + provenance filters run in code below.
    const rows = await store.selectActive(wallet, limit * 3);

    const matched = rows.filter(r => matchesIntent(r.intentMask, intentKind));

    // Security gate: strip anything not directly observed.
    const filtered = securityPath
      ? matched.filter(r => SECURITY_ALLOWED_PROVENANCE.has(r.provenance))
      : matched;

    const top = filtered.slice(0, limit);

    // Touch usage — fire-and-forget, never on the latency path.
    for (const r of top) void store.bumpUsage(r.id);

    return top.map(r => ({
      id:              r.id,
      shardKind:       r.shardKind,
      label:           r.label,
      content:         r.content,
      provenance:      r.provenance,
      confidence:      r.confidence,
      emotionalWeight: r.emotionalWeight,
    }));
  } catch {
    return [];   // degrade silently — a missing personal block must not break the turn
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────────

/** Compact per-user block grouped by kind (~120 tokens max). */
export function renderShardsBlock(shards: ShardResult[]): string {
  if (shards.length === 0) return "";

  const byKind = new Map<string, ShardResult[]>();
  for (const s of shards) {
    const list = byKind.get(s.shardKind) ?? [];
    list.push(s);
    byKind.set(s.shardKind, list);
  }

  const lines: string[] = ["[Personal Model]"];
  for (const [kind, items] of byKind) {
    const label = kind.replace(/_/g, " ");
    lines.push(`${label}: ${items.map(i => i.content).join("; ")}`);
  }
  return lines.join("\n");
}

// ── Write (upsert by label) ───────────────────────────────────────────────────

export async function upsertShard(
  store: ShardStore,
  opts: {
    wallet:          string;
    shardKind:       string;
    label:           string;
    content:         string;
    intentMask?:     string;
    provenance?:     Provenance;
    confidence?:     number;
    emotionalWeight?:number;
  },
): Promise<void> {
  try {
    const existing = await store.findByLabel(opts.wallet, opts.label);
    if (existing) {
      await store.update(existing.id, {
        content:         opts.content,
        confidence:      opts.confidence ?? 0.8,
        emotionalWeight: opts.emotionalWeight ?? 0.5,
      });
    } else {
      await store.insert({
        id:              randomUUID(),
        wallet:          opts.wallet,
        shardKind:       opts.shardKind,
        label:           opts.label,
        content:         opts.content,
        intentMask:      opts.intentMask ?? "*",
        provenance:      opts.provenance ?? "observed",
        confidence:      opts.confidence ?? 0.8,
        emotionalWeight: opts.emotionalWeight ?? 0.5,
        active:          true,
        useCount:        0,
        lastUsedAt:      null,
      });
    }
  } catch {
    // swallow — a failed write must not break the calling tool
  }
}

// ── In-memory store (for the demo / tests) ────────────────────────────────────

export class InMemoryShardStore implements ShardStore {
  private rows: Shard[] = [];

  async selectActive(wallet: string, limit: number): Promise<Shard[]> {
    return this.rows
      .filter(r => r.wallet === wallet && r.active)
      .sort((a, b) => b.emotionalWeight - a.emotionalWeight || b.confidence - a.confidence)
      .slice(0, limit)
      .map(r => ({ ...r }));
  }
  async bumpUsage(id: string): Promise<void> {
    const r = this.rows.find(x => x.id === id);
    if (r) { r.useCount += 1; r.lastUsedAt = new Date(); }
  }
  async findByLabel(wallet: string, label: string): Promise<Shard | null> {
    return this.rows.find(r => r.wallet === wallet && r.label === label) ?? null;
  }
  async update(id: string, patch: Partial<Shard>): Promise<void> {
    const r = this.rows.find(x => x.id === id);
    if (r) Object.assign(r, patch);
  }
  async insert(shard: Shard): Promise<void> { this.rows.push({ ...shard }); }
}

// ── Demo ───────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  (async () => {
    const store = new InMemoryShardStore();
    const wallet = "w";

    await upsertShard(store, {
      wallet, shardKind: "preference", label: "code_style",
      content: "prefers functional style, no classes",
      intentMask: "code,repo_diagnostic", provenance: "explicit", emotionalWeight: 0.6,
    });
    await upsertShard(store, {
      wallet, shardKind: "preference", label: "tone",
      content: "likes terse, direct answers",
      intentMask: "*", provenance: "observed", emotionalWeight: 0.7,
    });
    await upsertShard(store, {
      wallet, shardKind: "routine", label: "typical_transfer",
      content: "usually approves transfers around 0.1 ETH",
      intentMask: "wallet", provenance: "inferred", emotionalWeight: 0.5,
    });
    await upsertShard(store, {
      wallet, shardKind: "relationship", label: "known_address_alice",
      content: "alice = 0xABCD… (verified by the user)",
      intentMask: "wallet", provenance: "observed", emotionalWeight: 0.8,
    });

    // upsert-by-label: this updates the existing tone shard, not a duplicate.
    await upsertShard(store, {
      wallet, shardKind: "preference", label: "tone",
      content: "likes terse, direct answers (no filler)",
      intentMask: "*", provenance: "observed", emotionalWeight: 0.7,
    });

    console.log("— code turn —");
    console.log(renderShardsBlock(await getShards(store, { wallet, intentKind: "code" })));

    console.log("\n— wallet turn (personalization path) —");
    console.log(renderShardsBlock(await getShards(store, { wallet, intentKind: "wallet" })));

    console.log("\n— wallet turn (SECURITY path: only observed survives) —");
    console.log(renderShardsBlock(await getShards(store, { wallet, intentKind: "wallet", securityPath: true })));
  })();
}
