# Memory Consolidation ("Sleep")

*A maintenance pass the agent runs on its own memory — forgetting stale trivia, merging redundant entries, and promoting what recurs into durable, pinned lessons.*

The self-directed capability-acquisition guide ([guide 69](../69-self-directed-capability-acquisition/)) is about *growth* — the agent adds a tool when a gap recurs. This guide is its opposite number: *pruning and distillation*. While an agent is awake it accumulates raw episodic memories — every fact, correction, and aside, duplicates and noise included — and without a consolidation pass that store grows without bound and buries its few durable lessons under churn.

This is the fifth guide in the Layer-2 set (the agent operating on *itself*). It borrows its shape from how sleep consolidates a day's experience: forget the trivial, fuse the redundant, and graduate what keeps recurring from "I saw this once" to "this is true".

## Problem

An append-only memory store has three failure modes, and they compound:

1. **Unbounded growth of noise.** Most of what an agent observes is low-value and time-bound ("it was raining last Tuesday"). Kept forever, it dilutes retrieval and inflates every prompt that reads memory.
2. **Near-duplicate sprawl.** The same fact gets recorded a dozen slightly-different ways across sessions. Treated as distinct memories, they waste space *and* hide the fact that the corroboration across all of them is exactly the signal that the fact is durable.
3. **No episodic→semantic transition.** A one-off observation and a fact confirmed across ten sessions are stored identically. There is no mechanism that lets repeated corroboration *graduate* a memory into a protected, high-priority lesson.

This guide implements the consolidation pass — decay/forget, dedupe/merge, promote — as one deterministic sweep over the store.

## Design decisions

**Retention is salience × recency × usage, and pinned beats all of it.** A memory's `effectiveScore` blends three signals: how important it is on its own (`salience`), how recently it was touched (exponential decay with a 72-hour half-life), and how often it has been recalled (`usage`). Anything below the forget threshold is dropped — *unless* it is `pinned`. Pinning is the escape hatch for facts that are rarely accessed but must never be lost (a wallet address), so age alone can never evict them.

**Similarity is token-set Jaccard, not embeddings.** Deduplication clusters memories whose lowercased word sets overlap by ≥ 0.6 Jaccard. This is deliberately dependency-free and deterministic: the whole pass runs and reproduces identically with no model call. In production you would swap in cosine over the same embeddings the store already keeps; the *merge* logic downstream is identical regardless of how similarity is measured.

**Merging boosts salience — corroboration is evidence.** When a cluster of near-duplicates is fused into one entry, the survivor's salience is *increased* by a small per-duplicate boost (capped at 1), its access counts are summed, and the distinct sessions that produced each duplicate are unioned. The fact that five sessions independently recorded "the same" thing is precisely what makes it more trustworthy, not less — so the data model treats duplicates as accumulating evidence rather than redundancy to silently discard.

**The strongest text survives a merge.** Clusters are processed anchor-first in descending salience, so the highest-salience phrasing becomes the kept entry and the weaker variants are absorbed into it. This keeps the canonical wording stable across consolidation passes instead of letting it drift.

**Promotion needs corroboration across distinct *sessions*, not raw count.** A merged entry graduates from `episodic` to a durable `lesson` (pinned, salience floored at 0.9) only when it has been corroborated across ≥ 3 *distinct sessions*. Counting sessions, not mentions, is what stops a single chatty session from manufacturing a "durable" lesson out of one repeated remark — durability requires the fact to survive across time, not just within one conversation.

**The pass is idempotent on a clean store.** Run twice with no new input, the second pass forgets nothing, merges nothing, and promotes nothing. Consolidation converges instead of churning, so it is safe to schedule it aggressively.

## Algorithm

```
effectiveScore(item, now):
  recency = 0.5 ^ (ageHours(item, now) / HALF_LIFE_HOURS)
  usage   = min(1, accessCount / 5)
  return 0.6 * salience * recency + 0.4 * usage

consolidate():                                  # the "sleep" pass
  # (1) decay & forget — pinned items are exempt
  for item in store:
    if not item.pinned and effectiveScore(item, now) < FORGET_THRESHOLD:
      drop(item)

  # (2) dedupe & merge — greedy clustering, strongest text as anchor
  for anchor in survivors sorted by salience desc:
    for other in survivors (not yet consumed):
      if jaccard(tokens(anchor), tokens(other)) >= SIM_THRESHOLD:
        anchor.salience    = min(1, anchor.salience + CORROBORATION_BOOST)
        anchor.accessCount += other.accessCount
        anchor.sessions    |= other.sessions
        anchor.pinned       = anchor.pinned or other.pinned
        drop(other)

  # (3) promote — corroborated across enough distinct sessions -> durable lesson
  for item in store:
    if item.kind == episodic and item.sessions.size >= PROMOTE_SESSIONS:
      item.kind = lesson ; item.pinned = true ; item.salience = max(salience, 0.9)
```

## Reference implementation

[`memory-consolidation.ts`](./memory-consolidation.ts) — a standalone, dependency-free `MemoryStore` with an injectable `nowHours` clock so the demo can simulate elapsed time. Tokenization and Jaccard are plain functions; `consolidate()` returns a report of what was forgotten, merged, and promoted. Run it:

```bash
# Node 24+ runs it directly (native TS type-strip):
node memory-consolidation.ts --demo

# or with tsx:
npx tsx memory-consolidation.ts --demo
```

The demo ingests six raw memories — three near-identical corroborations of a units preference (across three sessions), a pinned old wallet fact, a stale low-salience aside, and a fresh useful note — then runs the sleep pass:

1. **Decay & forget** — the stale, low-salience, never-recalled aside is dropped; the pinned wallet fact survives despite being months old.
2. **Dedupe & merge** — the three units-preference variants fuse into one entry whose salience is boosted by corroboration and whose session set unions to three.
3. **Promote** — that merged entry, corroborated across three distinct sessions, graduates to a pinned durable `lesson`.
4. **Idempotence** — a second pass with no new input changes nothing, proving the store converges.

## How this maps to the production system

| Consolidation concept | Production mechanism |
|-----------------------|----------------------|
| episodic `MemoryItem`s | rows written to the pgvector agent-memory store during a turn |
| `effectiveScore` decay | a recency/usage score over `created_at` / `last_accessed` / hit-count columns |
| `pinned` exemption | memories flagged durable (identity facts, explicit "remember this") that never expire |
| Jaccard similarity | cosine similarity over the embeddings the memory store already computes |
| merge + salience boost | de-duplicating retrieved memories and weighting them by corroboration at recall time |
| `sessions` union | the distinct-conversation provenance that distinguishes a one-off from a pattern |
| episodic→`lesson` promotion | graduating a recurring fact into the durable knowledge-blob / system-prompt memory tier |
| scheduled `consolidate()` | a background janitor job (the agent scheduler) that compacts memory off the hot path |

## Limitations and extensions

- **Greedy single-pass clustering.** Anchor-first greedy merging can miss a cluster that only coheres transitively (a≈b, b≈c, a≉c). For larger stores, run connected-components over the similarity graph, or re-run `consolidate()` to convergence.
- **Fixed thresholds.** Half-life, forget cutoff, similarity, and promotion count are constants tuned for legibility. In production, set the half-life per memory *kind* (a preference decays slower than a transient task note) and learn the forget cutoff from retrieval-hit feedback.
- **Salience is exogenous.** The store trusts the salience it is given at ingest. Pair it with [guide 68](../68-calibrated-uncertainty-engine/) so the *confidence* of the observation feeds initial salience, and with usage telemetry so frequently-useful memories drift upward over time.
- **Merge keeps one text, discards the rest.** The absorbed phrasings are lost. If nuance matters, keep the variants as alternate surface forms under the canonical entry rather than dropping them.
- **No contradiction handling.** Two memories can corroborate *and* conflict ("prefers metric" vs. a later "prefers imperial"). Extend promotion to detect contradiction and prefer the most recent, the way a correction supersedes the fact it corrects.
