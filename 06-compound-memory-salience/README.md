# Compound Memory Salience Scoring


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A long-running conversational agent accumulates thousands of memories: stated
facts, behavioral corrections, emotional moments, project notes. When the agent
needs to recall context for the current turn, the naive approach is a vector
similarity search (pgvector / HNSW) that returns the *k* nearest neighbours by
cosine distance.

Pure similarity ranking has three failure modes:

1. **Recency blindness.** A fact the user stated two minutes ago and a fact they
   stated eight months ago score identically if their embeddings are equally
   close to the query. The agent re-asks things it was just told.
2. **Correction starvation.** A behavioral rule like *"don't call me by my
   username"* is short and semantically distant from most queries. It loses the
   cosine race to chatty, topically-similar memories and the agent repeats the
   exact mistake it was corrected for.
3. **No trust gradient.** A fact the user stated explicitly and a fact the system
   merely *inferred* are treated as equally authoritative.

The fix is to stop ranking on similarity alone and instead compute a **compound
salience score** that blends similarity with recency, emotional weight,
confidence, and source trust — then give one memory class (corrections) a hard
priority that bypasses the semantic race entirely.

## Design decisions

**Why a weighted linear blend instead of a learned re-ranker?**
A linear combination of five normalized signals is transparent, debuggable, and
requires no training data or model hosting. Each weight is a single tunable
constant; an operator can read the score breakdown and understand exactly why a
memory surfaced. A learned cross-encoder would rank better in theory but adds a
model dependency and removes the ability to reason about ranking by inspection.

**Why these five signals?**
- *Similarity* (0.32) — the base relevance signal from the vector index.
- *Recency* (0.26) — exponential decay on `lastTouchedAt`; what was relevant
  recently is probably still relevant.
- *Emotional weight* (0.20) — emotionally salient memories shape tone and
  continuity disproportionately to their topical match.
- *Confidence* (0.14) — how sure we are the memory is correct.
- *Source trust* (0.08) — explicit user statements outrank inferences.

The weights sum to 1.0 so the raw score lands in a predictable `[0, ~1.6]` range
(the recency term can be boosted above 1.0 for session-fresh memories, see
below). They are deliberately ordered: similarity dominates, recency is a strong
second, and source trust is a tie-breaker rather than a driver.

**Why a separate priority multiplier on top of the blend?**
Memory *class* carries information the five signals don't. A correction is more
important than a one-off general memory even when every other signal is equal.
Rather than fold class into the linear blend, the score is multiplied by
`0.7 + 0.3 × (priority / 100)`, so class priority modulates the final score by up
to ±30% without ever being able to fully override the semantic signal — except
for corrections, which are retrieved on a separate path (see Algorithm) so they
never depend on cosine distance at all.

**Why a "session-fresh" boost?**
Static seed memories (imported at onboarding) and freshly-written
mid-conversation facts can have identical recency decay curves once a day passes,
but within a live session the just-written fact must win. A `1.6×` multiplier on
the recency term for memories touched in the last two hours guarantees
mid-session facts float above static seeds.

**Why "touch on recall"?**
Recency decay is driven by `lastTouchedAt`, not `createdAt`. Every time a memory
is returned from a search it is touched (its timestamp bumped). Frequently
recalled memories therefore stay "warm" and keep surfacing; memories that are
never recalled cool off and eventually fall below the consolidation threshold.
This makes recall self-reinforcing without a separate access counter.

## Algorithm

```
recencyScore(lastTouchedAt):
  if lastTouchedAt is null: return 0.3        # unknown → mild penalty
  daysSince = (now - lastTouchedAt) / 1 day
  return 0.5 ^ (daysSince / HALF_LIFE_DAYS)   # 14-day half-life

computeSalience(m):
  recency      = recencyScore(m.lastTouchedAt)
  sourceTrust  = SOURCE_TRUST_MAP[m.source] or 0.6
  priorityNorm = min(1, m.priority / 100)
  freshBoost   = 1.6 if touched within last 2h else 1.0

  raw = W_SIM   * m.similarity
      + W_REC   * recency * freshBoost
      + W_EMO   * m.emotionalWeight
      + W_CONF  * m.confidence
      + W_TRUST * sourceTrust

  return raw * (0.7 + 0.3 * priorityNorm)
```

Two-phase retrieval:

```
searchMemory(query, classes, k):
  results = []

  # Phase 1 — corrections: retrieved unconditionally, NO cosine filter.
  #           Behavioral rules apply universally; they must never lose the
  #           cosine race. Ordered by priority then recency.
  if "correction" in classes:
    results += selectCorrections(wallet, limit=10)

  # Phase 2 — cosine search for every other requested class.
  if otherClasses not empty:
    vec  = embed(query)
    hits = vectorSearch(vec, otherClasses, limit=k+8)   # pgvector <=> operator
    results += hits with their cosine distance attached

  # Convert distance → similarity, compute compound salience, sort, slice.
  ranked = sortByDescending(results, computeSalience).slice(0, k)
  for m in ranked: touchMemory(m.id)     # fire-and-forget recency bump
  return ranked
```

Distance-to-similarity conversion: pgvector's cosine distance operator (`<=>`)
returns a value in `[0, 2]`, so `similarity = max(0, 1 - distance / 2)`.

Source-trust table:

```
explicit_user_statement : 1.00
confirmed_correction    : 0.95
inferred                : 0.75
system_derived          : 0.65
imported                : 0.50
(unknown)               : 0.60
```

## Consolidation

Salience scoring decides *what surfaces now*; consolidation decides *what stays
alive*. A periodic job (designed to run nightly, but safe to call on demand)
performs three soft operations — never a hard delete:

1. **Archive expired memories.** Rows with an `expiresAfterDays` window that has
   elapsed are soft-archived (`archivedAt` set).
2. **Decay stale low-value memories.** `general`-class memories not touched in 30
   days *and* with confidence < 0.5 are archived and their confidence multiplied
   by 0.8.
3. **Promote high-recall memories.** Memories touched within the last 3 days with
   confidence < 0.95 get a +0.05 confidence bump (capped at 0.98), reinforcing
   the things the agent keeps reaching for.

Because every operation is a soft archive, consolidation is reversible and
non-destructive — a misclassified memory can always be un-archived.

## Reference implementation

See [`memory-salience.ts`](./memory-salience.ts). It is storage-agnostic: the
vector search and persistence are behind a small `MemoryStore` interface so the
core scoring logic is unit-testable without a database. A `--demo` block wires an
in-memory store with deterministic pseudo-embeddings.

## Usage

```typescript
import {
  computeSalience,
  rerankBySalience,
  searchMemory,
  consolidateMemories,
} from "./memory-salience.js";

// Re-rank raw vector hits before handing them to the agent
const ranked = rerankBySalience(rawHits);

// Or run the full two-phase retrieval against a store
const memories = await searchMemory(store, {
  query: "what is the user working on",
  classes: ["correction", "user_fact", "project_log", "general"],
  k: 8,
});

// Nightly housekeeping
const { archived, decayed, promoted } = await consolidateMemories(store, wallet);
```

## Limitations and extensions

- **Weights are global, not per-user.** A user who values emotional continuity
  over factual precision would benefit from per-user weight tuning. The weights
  are constants here; promoting them to a per-wallet config row is a natural
  extension.
- **Half-life is fixed at 14 days.** Different memory classes plausibly want
  different decay rates (corrections should barely decay; small talk should decay
  fast). The recency function could take the class as a parameter.
- **The freshness boost is a step function.** A continuous boost
  (e.g. multiplier that smoothly decays from 1.6 to 1.0 over two hours) would
  avoid the cliff at exactly two hours, at the cost of a slightly less
  predictable score.
- **Consolidation promotion is heuristic.** "Touched in the last 3 days" is a
  proxy for "frequently recalled". A true access counter would let promotion key
  off recall *count* rather than recall *recency*.
