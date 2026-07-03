# Guide 96 — Proactive Capacity-Limit Estimation for Context Offload


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A forward-looking model of how much a bounded working-context window can actually hold, so a system can archive/offload before it overflows instead of after.*

---

## Problem

A working-context window (the material an agent keeps "live" for a turn) has a hard size limit, but a raw token counter is a poor proxy for when it's actually about to become a problem. The *effective* capacity of a window depends on more than its raw size — a turn that's doing five chained reasoning steps over the same material is effectively using more of that window's capacity per token than a single flat lookup would. A fixed hard-cut token counter either evicts material too early (wasting capacity that was actually still available) or lets the window blow past what it can coherently represent (silently degrading quality with no warning).

## Design decisions

- **Capacity scales logarithmically with window size relative to a baseline,** not linearly. Doubling the window doesn't double how much useful structure it can hold — diminishing returns kick in because the limiting factor is usable structure, not raw token count.
- **A depth multiplier derived from recent reasoning/tool-call activity, saturating via `log1p`.** More chained steps over the same material increase effective load, but the effect must saturate — a session with 50 tool calls isn't meaningfully "more loaded" than one with 20 in a way that should keep scaling linearly forever.
- **Reuse the per-subsystem entropy accounting from Guide 94 as the load measurement**, rather than re-deriving a separate load metric — current load is exactly the sum of information the system is currently trying to keep coherent across subsystems.
- **A fixed early-warning threshold (85% saturation)** that triggers proactive archiving *before* the hard limit, not at it — the entire point is to act while there's still room to do so gracefully.
- **A separate structural-completeness check**, distinct from saturation: even with headroom available, does the system's fixed set of pinned/invariant anchors (the small set of facts it always keeps verbatim, like a summary or a pinned-fact list) have enough independent degrees of freedom to describe the current load without lossy compression? If not, representation loss is structurally guaranteed regardless of how much headroom remains — that's a different failure mode than running out of room, and needs a different response (grow the anchor set, not just archive more).

## Algorithm

```
effectiveCapacity = κ · log2(windowTokens / baselineTokens) · depthFactor
depthFactor       = 1 + log1p(recentToolCallCount) · depthWeight

load       = Σ projectionCost across subsystems   // from Guide 94
saturation = load / effectiveCapacity
nearBound  = saturation > 0.85                     // proactive-archive trigger

requiredAnchors = ceil(load / ln2)                 // bits -> minimum anchor slots needed
deficit         = max(0, requiredAnchors - currentAnchorCount)
```

## Reference implementation

`index.ts` simulates increasing load across a growing window with varying tool-call depth and anchor-slot counts, and verifies: (1) `nearBound` fires before saturation would otherwise silently exceed 1.0, (2) higher depth factor raises effective capacity (more chained reasoning "buys" more usable room, up to saturation), (3) a low anchor count produces a nonzero deficit even when saturation itself is low — proving the two failure modes are genuinely independent.

```bash
node index.ts
```

## Limitations and extensions

- The logarithmic capacity model and the 0.85 threshold are fixed constants here; Guide 98's outcome-grounded calibration loop is the natural mechanism for letting the threshold self-tune from real overflow/quality incidents instead of staying hand-picked.
- This model treats "load" as a single aggregate number. It doesn't say *which* piece of context to archive first when `nearBound` fires — pair it with a per-item recency/importance score (most systems already have one) to decide eviction order.
- The anchor-deficit check assumes anchors are a fixed, countable resource with a known bits-per-anchor budget. If your system's summarization anchors are unbounded in size, replace the `ln2` divisor with your actual measured bits-per-anchor.
