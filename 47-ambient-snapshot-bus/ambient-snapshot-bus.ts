/**
 * Ambient World-Snapshot Prefetch Bus
 *
 * Keeps a small set of compact, freshness-scored digests of broad real-world
 * categories (weather / news / markets / local) warm in the agent's context so
 * it can answer ambient questions without firing a live tool call on every turn.
 *
 * Two ideas:
 *   1. Query planner — a broad category is decomposed into 2–4 focused
 *      micro-queries that one synthesis pass can answer, instead of one vague
 *      "what's the weather" call.
 *   2. Linear confidence decay — each digest carries a TTL; its confidence
 *      degrades linearly from 1.0 at fetch time to 0.0 at expiry. Stale digests
 *      are dropped; ageing ones are surfaced with a confidence tag so the model
 *      knows to hedge or refresh.
 *
 * The fetcher is pluggable (a `SnapshotFetcher` interface). Production wires it
 * to a cheap LLM synthesis call; the demo uses a deterministic stub so the file
 * runs with no network and no keys.
 *
 * Dependencies: Node.js built-ins only.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type SnapshotKind = "weather" | "news" | "markets" | "local";

export interface SnapshotDigest {
  kind:       SnapshotKind;
  digest:     string;   // ≤ ~150 tokens of synthesized text
  fetchedAt:  number;
  ttlMs:      number;
  /** Confidence reported by the synthesizer at fetch time (0–1). */
  baseConfidence: number;
}

/** A fetcher answers a set of micro-queries with a single digest. */
export interface SnapshotFetcher {
  (kind: SnapshotKind, microQueries: string[], city?: string):
    Promise<{ digest: string; confidence: number } | null>;
}

// ── TTLs per kind ───────────────────────────────────────────────────────────

const TTL_MS: Record<SnapshotKind, number> = {
  weather: 30 * 60 * 1000,  // 30 min
  news:    15 * 60 * 1000,  // 15 min
  markets: 10 * 60 * 1000,  // 10 min
  local:   60 * 60 * 1000,  // 1 hour
};

// ── Query planner ───────────────────────────────────────────────────────────

/**
 * Decompose a broad category into focused micro-queries. A single synthesis
 * pass answers all of them, producing one dense digest.
 */
export function buildMicroQueries(kind: SnapshotKind, city?: string): string[] {
  const loc = city ?? "globally";
  switch (kind) {
    case "weather":
      return [
        `Current conditions ${loc}`,
        `Severe weather alerts ${loc}`,
        `Forecast next 6 hours ${loc}`,
      ];
    case "news":
      return [
        "Top 3 headlines right now",
        "Breaking news in the last hour",
        "Relevant tech or markets news",
      ];
    case "markets":
      return [
        "Major index direction today",
        "Notable market-moving events today",
      ];
    case "local":
      return city
        ? [`What's happening in ${city} today`, `Local events or alerts in ${city}`]
        : [];
    default:
      return [`Current status for ${kind} ${loc}`];
  }
}

// ── Confidence decay ────────────────────────────────────────────────────────

/**
 * Effective confidence at time `now`: the base confidence scaled by remaining
 * TTL fraction. Linear from baseConfidence at fetch time to 0 at expiry.
 */
export function effectiveConfidence(d: SnapshotDigest, now: number): number {
  const age = now - d.fetchedAt;
  if (age <= 0) return d.baseConfidence;
  if (age >= d.ttlMs) return 0;
  const remaining = 1 - age / d.ttlMs;
  return d.baseConfidence * remaining;
}

// ── The bus ─────────────────────────────────────────────────────────────────

export class SnapshotBus {
  private store: Map<string, SnapshotDigest>;
  private fetcher: SnapshotFetcher;
  private minConfidence: number;

  constructor(fetcher: SnapshotFetcher, opts?: { minConfidence?: number }) {
    this.store = new Map();
    this.fetcher = fetcher;
    this.minConfidence = opts?.minConfidence ?? 0.1;
  }

  private key(kind: SnapshotKind, city?: string): string {
    return `${kind}:${city ?? "global"}`;
  }

  /**
   * Refresh one kind: plan micro-queries, call the fetcher, store the digest.
   * Returns null if there is nothing to fetch or the fetcher declined.
   */
  async refresh(kind: SnapshotKind, city?: string): Promise<SnapshotDigest | null> {
    const queries = buildMicroQueries(kind, city);
    if (queries.length === 0) return null;

    const res = await this.fetcher(kind, queries, city);
    if (!res || !res.digest) return null;

    const digest: SnapshotDigest = {
      kind,
      digest:         res.digest,
      fetchedAt:      Date.now(),
      ttlMs:          TTL_MS[kind],
      baseConfidence: Math.min(1, Math.max(0, res.confidence)),
    };
    this.store.set(this.key(kind, city), digest);
    return digest;
  }

  /**
   * All digests whose effective confidence is still above the floor, sorted
   * most-confident first. Expired/low entries are evicted as a side effect.
   */
  getActive(now = Date.now()): Array<SnapshotDigest & { confidence: number }> {
    const out: Array<SnapshotDigest & { confidence: number }> = [];
    for (const [key, d] of this.store) {
      const conf = effectiveConfidence(d, now);
      if (conf < this.minConfidence) {
        this.store.delete(key);
        continue;
      }
      out.push({ ...d, confidence: conf });
    }
    out.sort((a, b) => b.confidence - a.confidence);
    return out;
  }

  /** Kinds that have aged past their TTL and should be re-fetched. */
  getStale(now = Date.now()): Array<{ kind: SnapshotKind; city?: string }> {
    const stale: Array<{ kind: SnapshotKind; city?: string }> = [];
    for (const [key, d] of this.store) {
      if (effectiveConfidence(d, now) < this.minConfidence) {
        const [kind, city] = key.split(":");
        stale.push({ kind: kind as SnapshotKind, city: city === "global" ? undefined : city });
      }
    }
    return stale;
  }

  /**
   * Render active digests as a compact context block. Digests below full
   * confidence are tagged with a percentage so the model hedges appropriately.
   */
  renderBlock(now = Date.now()): string {
    const active = this.getActive(now);
    if (active.length === 0) return "";
    const lines = active.map(s => {
      const tag = s.confidence >= 0.8 ? "" : ` [~${Math.round(s.confidence * 100)}%]`;
      return `${s.kind.toUpperCase()}${tag}: ${s.digest}`;
    });
    return `[World State]\n${lines.join("\n")}`;
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  // Deterministic stub fetcher — no network. Echoes the plan into a digest.
  const stubFetcher: SnapshotFetcher = async (kind, queries, city) => {
    const canned: Record<SnapshotKind, string> = {
      weather: `Clear, 18°C${city ? " in " + city : ""}; no alerts; light rain after 6pm.`,
      news:    "Markets steady; a major chipmaker announced earnings; no breaking incidents.",
      markets: "Indices up ~0.4%; energy leading; quiet macro calendar today.",
      local:   `${city ?? "Area"}: street festival downtown; minor transit delays on the east line.`,
    };
    return { digest: canned[kind], confidence: 0.9 };
  };

  const bus = new SnapshotBus(stubFetcher);

  (async () => {
    await bus.refresh("weather", "Lisbon");
    await bus.refresh("news");
    await bus.refresh("markets");

    console.log("Micro-query plan (weather):", buildMicroQueries("weather", "Lisbon"));

    console.log("\nFresh context block:\n");
    console.log(bus.renderBlock());

    // Simulate the markets digest ageing to 60% of its 10-min TTL.
    const aged = Date.now() + 6 * 60 * 1000;
    console.log("\nAfter 6 minutes (markets TTL is 10m):\n");
    console.log(bus.renderBlock(aged));

    // Simulate everything well past TTL → all evicted, all reported stale.
    const expired = Date.now() + 2 * 60 * 60 * 1000;
    console.log("\nStale kinds after 2h:", bus.getStale(expired));
    console.log("Active after 2h:", bus.getActive(expired).length);
  })();
}
