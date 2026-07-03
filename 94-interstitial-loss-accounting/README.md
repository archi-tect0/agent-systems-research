# Guide 94 — Interstitial Loss Accounting Across Subsystem Boundaries


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*Most debugging attention goes to what's inside each subsystem. This guide instruments the space between them — the projection step where a subsystem's full internal state gets narrowed down to whatever subset the reasoning layer actually gets to see — and turns that narrowing into a measured, comparable cost per subsystem.*

---

## Problem

A system built from several independently-scoped subsystems (a memory store, a world-model graph, a policy/rules table, a background job tracker, an identity/session layer, a content store) never exposes its full internal state to the reasoning layer on every turn — it always projects down: top-k recalled memories instead of the whole store, active entities instead of the whole graph, the currently-running process instead of the whole job history. When something goes subtly wrong, it's frequently not a bug *inside* any one subsystem — it's information that got thrown away exactly at that projection boundary, and nothing today measures that loss per-boundary or tells you which boundary is currently the worst offender.

## Design decisions

- **Reuse each subsystem's existing weighting (confidence, priority, status) as a stand-in distribution** rather than inventing a new metric per subsystem — most systems already score their records somehow, and that scoring is exactly what determines what gets kept vs. dropped in the projection.
- **Normalized Shannon entropy, computed twice per subsystem** — once over the full underlying set (the "host" view) and once over the subset actually exposed (the "visible" view). The gap between the two is the projection's information cost: a large gap means the exposed subset looks very different in shape from the full set (e.g. one dominant record hides a diverse tail); a near-zero gap means the projection barely changed anything.
- **A raw count ratio (full-set size / visible-set size) as a cheap secondary signal** alongside entropy — useful because it's meaningful even for subsystems whose "just one active thing" projection makes entropy trivially zero (e.g. a session with exactly one active identity binding).
- **Sum across subsystems for a total budget, and separately track which single subsystem has the largest individual gap** — the sum tells you how much loss the whole system is carrying this turn; the single largest-gap subsystem tells you where to look first when something needs fixing.
- **Fail soft, per subsystem.** A subsystem that can't currently be measured (a query error, a schema not yet populated) should report a zero-cost frame rather than aborting the whole budget calculation — a temporarily-broken measurement for one subsystem shouldn't blind you to the other five.

## Algorithm

```
for each subsystem:
  hostWeights    = confidence/priority weights of the full underlying set
  hostEntropy    = normalizedShannonEntropy(hostWeights)
  visibleWeights = confidence/priority weights of the exposed subset (top-k, active-only, etc.)
  visibleEntropy = normalizedShannonEntropy(visibleWeights)
  projectionCost = max(0, hostEntropy - visibleEntropy)
  countRatio     = |hostWeights| / max(1, |visibleWeights|)

totalCost  = Σ projectionCost across subsystems
bottleneck = subsystem with the largest projectionCost
budgetRatio = totalCost / numSubsystems   // ∈ [0,1] given entropy is itself normalized
```

## Reference implementation

`index.ts` simulates six subsystems with deliberately different projection behavior (one that barely narrows its view, one that aggressively narrows a diverse full set down to a single dominant item) and verifies the budget calculation correctly identifies the highest-loss subsystem as the bottleneck, that a subsystem measurement failure doesn't zero out the whole budget, and that `budgetRatio` stays bounded even when every subsystem is at maximum loss.

```bash
node index.ts
```

## Limitations and extensions

- Entropy-over-weights is a proxy for "how much the projection narrowed the distribution's shape," not a literal measure of semantic information lost — two subsystems with identical entropy numbers can lose very different kinds of information depending on what the weights actually represent.
- This guide only accounts for loss at the read/projection boundary. It says nothing about loss introduced by compression on the wire (Guides 03, 91, 92) or by summarization inside a single subsystem before it even reaches this accounting layer — those are separate, complementary loss sources.
- The bottleneck signal is a single-turn snapshot. A subsystem that's consistently the bottleneck across many turns is a much stronger signal than one that spikes once; pair this with a rolling window if you want a "chronic bottleneck" alert rather than a per-turn one.
