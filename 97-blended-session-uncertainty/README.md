# Guide 97 — Blended Session Uncertainty Signal


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*Combines two genuinely different pressure sources — how spread-out the currently retrieved evidence is, and a lower layer's own encoding-pressure signal — into one session-level uncertainty meter, with velocity tracking to catch sudden spikes.*

---

## Problem

A reasoning layer wants a single "how uncertain is this session right now" number to decide whether to hedge, ask a clarifying question, or escalate — but the two most obvious raw inputs measure different things and neither is a reliable proxy alone. The diversity of retrieved supporting evidence says something about *what the system currently knows*; a lower-level compression/encoding-pressure signal (Guide 91) says something about *how hard a lower layer is working to represent recent input*. Conflating them, or picking only one, produces a signal that's either too noisy or misses real uncertainty spikes that only show up when both move together.

## Design decisions

- **Normalize retrieval diversity via Shannon entropy over the retrieved items' confidence weights.** A broad, evenly-weighted set of retrieved memories means the system doesn't have one clearly-best answer — that's high uncertainty. One dominant, high-confidence hit means low uncertainty, regardless of how many total items were retrieved.
- **Import the lower layer's compression-pressure signal as a second, already-normalized input rather than re-deriving it.** This is composition, not duplication — Guide 91 already solved "how do I get a smooth [0,1] encoding-pressure number," and re-implementing that logic here would create two sources of truth that can drift out of sync.
- **A weighted blend favoring retrieval diversity**, since it is more directly about what the agent currently knows, with compression pressure as a secondary contributing signal rather than an equal partner.
- **A short ring-buffer history for velocity, not just level.** A session sitting at a moderately high uncertainty for a while is a very different situation from one that just jumped there in the last turn — the *rate of change* is often the more actionable signal, especially for triggering an immediate hedge versus a slow style adjustment.
- **Gate spike detection on a stability signal borrowed from Guide 91/92's oscillation detector**, so a spike happening *because* the lower encoding layer is already unstable isn't double-counted as a fresh, independent reasoning-uncertainty event — it's the same underlying instability surfacing in two places.

## Algorithm

```
memEntropy = normalizedShannonEntropy(retrievedItemWeights)
blended    = 0.6 · memEntropy + 0.4 · compressionDepth      // compressionDepth from Guide 91

history.push(blended)                                        // short ring buffer
velocity   = blended - history[history.length - 2]

spike = blended > SPIKE_LEVEL
        && velocity > SPIKE_RATE
        && stability < LOW_CONFIDENCE_STABILITY              // from Guide 91/92
```

## Reference implementation

`index.ts` simulates a session where retrieved-memory diversity suddenly broadens (many low-confidence, evenly-weighted hits) at the same time as compression pressure rises, and shows the spike detector correctly fires. It also runs two control cases — only retrieval diversity rising, and only compression pressure rising, each with the other held flat and stability held high — and shows the spike detector does **not** fire for either alone, demonstrating the blend genuinely requires both inputs to move together.

```bash
node index.ts
```

## Limitations and extensions

- The 0.6/0.4 blend weight is fixed here; if your system has ground-truth uncertainty outcomes (e.g. "did the agent's answer turn out to be wrong"), Guide 98's calibration loop can tune this weight from residuals instead of leaving it hand-picked.
- This signal reflects *session*-level uncertainty aggregated over recent turns, not per-fact confidence. It complements, but doesn't replace, per-claim confidence scoring if your system needs to hedge at the sentence level.
- Velocity is computed over a short ring buffer (a handful of recent turns) — a session with very sparse turns (long gaps between them) will see velocity dominated by whatever happened last, which may not reflect a meaningful trend. Consider time-weighting the buffer if turn cadence is highly irregular.
