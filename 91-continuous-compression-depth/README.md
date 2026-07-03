# Guide 91 — Continuous Compression-Depth Signal


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A dictionary-substitution compressor that only exposes a binary "compress harder / don't" flag forces every downstream consumer to either ignore nuance or re-derive their own smoothing. This guide replaces the binary flag with a continuous depth signal derived from the same measurement, without breaking anything that still reads the boolean. Builds on the entropy-gated compression pattern in Guide 03 and the phrase-substitution work in Guide 85 — read those first if the "why compress dictionary-substitution output at all" framing is unfamiliar.*

---

## Problem

A streaming compressor that substitutes recognized phrases for short codes needs a policy for *how aggressively* to substitute. A simple version tracks a rolling miss-rate (how much of the stream isn't matching known phrases) and flips a mode flag when it crosses a threshold: below the threshold, use the full phrase dictionary ("permissive" mode); above it, restrict matching to only the highest-value phrases ("restricted" mode), which is cheaper to run and avoids wasting match attempts on a dictionary that clearly isn't fitting the current content.

Two problems show up once this is running against real traffic:

1. **Boundary thrashing.** If the input's novelty hovers right around the threshold, ordinary sample-to-sample noise flips the mode back and forth repeatedly. Each flip is logged, and every consumer watching the mode (a cache layer, a routing decision, a metrics dashboard) sees noisy, low-information churn instead of a stable signal.
2. **No graduated signal exists.** Some consumers don't want yes/no — they want *how much* pressure the system is under right now, so they can scale their own behavior proportionally (e.g., a cache eviction policy that wants to shrink gradually, not fall off a cliff at one boundary value).

## Design decisions

- **Keep two thresholds, not one — a hysteresis band.** The mode flips to "restricted" only above the upper threshold, and back to "permissive" only below a strictly lower threshold. This alone kills most boundary thrashing: noise has to cross the entire band width, not one point, to cause a flip. This is the Guide 03-era fix and it's necessary but not sufficient — see the demo for the residual instability it doesn't solve.
- **Add a continuous signal, don't replace the binary one.** The depth signal below is computed alongside the existing mode flag, from the same underlying measurement (an exponential moving average of miss-rate). Old consumers keep reading the boolean unchanged; new consumers read the continuous value. This is purely additive — no existing integration breaks.
- **A sigmoid centered on the hysteresis midpoint**, not a straight line. A linear ramp between the two thresholds would make the signal barely move for most of its range and then swing hard near the edges — the opposite of what's useful. A sigmoid keeps the signal near its resting value away from the transition zone and moves fastest exactly where the interesting behavior change happens.
- **The steepness constant must be tuned so the signal saturates *inside* the hysteresis band, not at its literal edges.** If the sigmoid reaches ~0 and ~1 too early, it stops responding well before the mode flag actually flips, defeating the point of a graduated signal.
- **The "delta" framing is the EMA itself.** The system never reacts to a raw, instantaneous miss-rate — every sample updates an exponential moving average (`new = α·sample + (1−α)·old`), which is a weighted delta between the incoming observation and the running estimate. The continuous depth signal is derived from that delta-tracked value, not from the raw per-sample number. This is what makes the signal graduated instead of jumpy: a single noisy sample can only move the EMA by `α` of the difference, never all the way.

## Algorithm

```
// Per-sample update:
missRate = 1 − (matchedBytes / totalBytes)
ema      = α · missRate + (1 − α) · ema        // exponential delta-tracking, α ≈ 0.3

// Hard hysteresis (for legacy binary consumers):
if mode == "permissive" and ema >= upperThreshold:  mode = "restricted"
if mode == "restricted" and ema <= lowerThreshold:  mode = "permissive"

// Continuous depth (Gen-2 signal, for graduated consumers):
mid   = (lowerThreshold + upperThreshold) / 2
depth = 1 / (1 + e^(−k · (ema − mid)))          // k tuned so depth saturates inside the band

// Downstream: any consumer that wants a graduated resource (e.g. an active window size)
// scales continuously with depth instead of falling off a cliff at the mode boundary:
window = max(minWindow, round(maxWindow × (1 − depth × shrinkFactor)))
```

## Reference implementation

`index.ts` simulates a stream of samples with a novelty trace that deliberately hovers near the hysteresis boundary, and compares three views of the same underlying signal:

1. The raw per-sample miss-rate (noisy, unusable directly).
2. The binary hysteresis mode flag (stable, but still an all-or-nothing signal).
3. The continuous depth signal and the derived graduated window size (smooth, informative, no discrete jumps beyond the single mode-flag transition that the binary flag also makes).

Run it:

```bash
node index.ts
```

or with `tsx` on older Node:

```bash
npx tsx index.ts
```

The demo prints a per-tick table and asserts that the continuous window size never changes by more than one step between adjacent samples with similar EMA — i.e., no thrashing — while the binary mode plot shows the classic near-boundary flip-flop when the hysteresis band is deliberately narrowed for comparison.

## Limitations and extensions

- This guide is only the *depth signal*. What a consumer does with it — shrinking a match window, deprioritizing background work, reducing a cache TTL — is domain-specific; Guide 92 covers one concrete consumer (a self-tuning threshold and an oscillation detector) built on top of this signal.
- The sigmoid's steepness and midpoint are still manually chosen constants. Guide 92 replaces the *threshold* half of this with a self-tuning controller; the sigmoid steepness itself is left as a fixed constant here because it changes the *shape* of the response curve, not just its trigger point, and re-deriving shape parameters from live data is a materially harder (and separate) problem than re-deriving a trigger point.
- If the underlying signal has structural regime changes (not just noise) — e.g., miss-rate genuinely resets at session boundaries — reset or decay the EMA at those boundaries, or the delta-tracking will "remember" the previous regime for several samples after it's no longer relevant.
