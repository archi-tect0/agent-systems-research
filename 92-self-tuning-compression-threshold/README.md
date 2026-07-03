# Guide 92 — Self-Tuning Compression Threshold with Oscillation Detection


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A fixed entropy threshold for a dictionary-substitution compressor (Guide 03, refined with a continuous signal in Guide 91) needs hand-tuning per workload and goes stale as usage drifts. This guide replaces the fixed threshold with a small proportional controller that tracks a target operating rate, plus an independent diagnostic that detects when the controller itself is unstable.*

---

## Problem

A compressor that switches into a cheaper, restricted matching mode above some entropy threshold has to pick that threshold somehow. A constant works until the workload's actual novelty distribution shifts — vocabulary composition changes over the life of a long-running system, or one deployment simply has different content characteristics than the one the constant was tuned against. Two failure directions:

- **Threshold too low**: the system spends time in restricted mode far more than necessary, giving up dictionary coverage it didn't need to give up.
- **Threshold too high**: the system stays in the expensive full-matching mode during genuinely high-novelty stretches, missing the efficiency win the restricted mode exists for.

The natural fix — let the threshold adjust itself based on observed behavior — introduces a new risk: any closed feedback loop can oscillate if its correction is too aggressive relative to how fast the underlying signal actually moves. A threshold that overcorrects every cycle produces a *second*, higher-level instability on top of whatever noise already existed in the raw signal.

## Design decisions

- **A simple proportional controller, not a full PID loop.** Every fixed window of samples, compare the *actual* fraction of samples that landed in restricted mode against a *target* fraction, and nudge the threshold by `learningRate × (actual − target)`. No integral or derivative term — the extra terms buy faster convergence at the cost of a much larger tuning surface and a real risk of overshoot, which is precisely the failure mode this guide is trying to avoid introducing.
- **Clamp the threshold to a safe range.** Without a hard floor and ceiling, a controller chasing an unreachable target (e.g. a target rate the workload's actual novelty distribution can never produce) walks the threshold to a degenerate always-on or always-off value. Clamping bounds the damage from a misconfigured target to "suboptimal," not "broken."
- **A low learning rate, deliberately.** The controller only updates once per window (not per sample), and even then moves a small fraction of the way toward correction. This trades convergence speed for stability — appropriate here because the threshold only needs to track slow drift in workload characteristics, not react to every sample.
- **Oscillation detection is a separate diagnostic, not a second feedback input.** A rolling variance of the raw underlying signal (the same measurement the controller consumes) is tracked in a fixed-size ring buffer and converted to a confidence score via exponential decay: high variance collapses confidence toward 0, low variance holds it near 1. This confidence score is *exposed*, not fed back into the threshold controller itself. Wiring it back in would create a second loop that can fight the first — if the controller reacts to its own instability, small perturbations can compound. Keeping detection and correction separate means an operator (or an automated system built on top) can decide what to do when confidence drops: pause the adaptive controller, alert, or fall back to the static default — without that decision being baked into the control loop's own dynamics.
- **The confidence score is the trustworthiness gate for everything above it.** Any system consuming the adaptive threshold value should also read the confidence score and discount or ignore the threshold when confidence is low — the threshold is still a number in that state, it's just not a number anyone should currently trust.

## Algorithm

```
// Proportional controller (runs every WINDOW samples):
actualRate = coarseSamplesInWindow / WINDOW
delta      = learningRate × (actualRate − targetRate)
threshold  = clamp(threshold + delta, thresholdMin, thresholdMax)

// Oscillation detector (runs every sample, independent of the controller):
ring.push(rawSignal)                       // fixed-size ring buffer
if ring.length >= 2:
    mean       = average(ring)
    variance   = average((x - mean)^2 for x in ring)
    confidence = e^(−k × variance)         // 1.0 = stable, → 0 = oscillating
```

## Reference implementation

`index.ts` runs three scenarios against the same controller + detector:

1. **Slow drift** — the underlying novelty distribution shifts gradually over thousands of samples. The controller should track it and keep the actual coarse-mode rate near the target, while confidence stays high throughout.
2. **Sudden regime change** — novelty jumps sharply partway through. The controller should visibly correct over the following windows rather than instantly, and confidence should dip briefly during the transition without collapsing.
3. **Injected instability** — an artificially unstable signal (rapid alternation between very low and very high novelty) is fed in. The detector should catch it: confidence should drop well below the stable-scenario baseline, flagging that the adaptive threshold's current value should not be trusted.

Run it:

```bash
node index.ts
```

or with `tsx` on older Node:

```bash
npx tsx index.ts
```

The demo asserts that scenario 1 converges the actual rate to within a tolerance of the target, and that scenario 3's minimum confidence is measurably lower than scenario 1's minimum confidence — i.e. the detector actually distinguishes a stable regime from an oscillating one instead of just tracking overall signal magnitude.

## Limitations and extensions

- The controller assumes the target rate is *reachable* given the workload. If it isn't (e.g. a target of 15% coarse-mode time against a workload that's either always trivially compressible or always maximally novel, with nothing in between), the threshold will sit at one of its clamp rails indefinitely. That's a visible, diagnosable state — the clamp bounds prevent it from being a *silent* failure — but it isn't a state the controller can escape on its own; that requires either a different target or upstream changes to the workload.
- Confidence is a variance-based diagnostic on the raw signal, not a statistical test with a formal false-positive rate. It's tuned to be a fast, cheap operator-facing indicator, not a rigorous change-point detector. A system that needs a hard guarantee on detection latency or false-alarm rate should treat this as a first-pass filter feeding a more expensive confirmatory check, not as the final word.
- This guide and Guide 91 solve different halves of the same problem: Guide 91 turns a single noisy measurement into a smooth signal; this guide tunes *where* that measurement's decision boundary sits and tells you when to stop trusting the boundary. Neither replaces basic monitoring — both are complements to, not substitutes for, an operator dashboard showing the raw trend.
