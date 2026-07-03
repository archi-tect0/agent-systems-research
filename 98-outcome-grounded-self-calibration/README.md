# Guide 98 — Outcome-Grounded Self-Calibrating Constants Loop


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A general pattern for letting hand-tuned decision thresholds correct themselves from labeled real-world outcomes, with bounded steps, invariant checks, rollback, and drift monitoring — so no single bad batch of data can wreck a threshold, and slow drift still gets caught.*

---

## Problem

Any system with several hand-tuned decision thresholds (when to flag something as urgent, how much to trust a specific routing decision, when to gate a risky action behind extra confirmation) will drift out of calibration as real usage patterns evolve. Manually re-tuning these doesn't scale past a small number of constants, and naive "auto-tune from the latest batch" approaches are dangerous — a single noisy or adversarial batch of labeled outcomes could push a safety-relevant threshold somewhere it should never go.

## Design decisions

- **Separate the prediction stream from the outcome stream and join them after the fact.** Labels almost always arrive later than the predictions they're judging (sometimes much later — a routing decision's real quality might not be knowable until several turns downstream). Trying to calibrate synchronously with the prediction forces premature, unlabeled updates.
- **Per-threshold residual functions, computed independently per constant**, not a single shared calibration formula. Different constants have different available ground truth — some compare against a target rate (e.g. "urgent flags should fire about 5% of the time"), others compare adverse-outcome rates above vs. below the current threshold. Forcing one calibration formula onto every constant would make some of them uncalibratable.
- **Every update goes through a bounded EMA step — max relative change per calibration run.** This is the same "delta, not jump" principle used for compression-depth smoothing (Guide 91) and preference weights (Guide 99), now applied to safety-relevant thresholds: no single run, however extreme its residual, can move a constant more than a fixed maximum step.
- **A bootstrap gate that refuses to update anything until enough labeled samples exist.** Calibrating from three data points is worse than not calibrating at all.
- **Hard invariant checks before committing, with all-or-nothing rollback.** If a proposed batch of updates would break a required relationship between constants (e.g. a "warn" threshold must always stay strictly below its paired "critical" threshold), the entire batch is rolled back — never partially applied, since a partial apply could itself violate the invariant it was trying to protect.
- **Every run writes an immutable audit row, whether it committed, was gated by the bootstrap check, or rolled back.** This is what makes the loop debuggable after the fact, and it's what a canary drift check (below) reads from.
- **A separate, slower canary check comparing current values against the first-ever calibrated baseline**, distinct from per-run correctness. A single run can look perfectly valid (bounded step, invariants satisfied) while a long sequence of such runs still drifts a constant somewhere unintended over weeks — that's a different failure mode (slow drift, possibly adversarial) from "did this run apply cleanly," and needs its own alert.

## Algorithm

```
residual = residualFn[constant](labeledOutcomes)          // per-constant, ground-truth-specific
if sampleCount < BOOTSTRAP_MIN: skip (log "bootstrap_gated")

proposed = boundedEmaStep(current, current + residual * stepSize, maxRelativeStep)

if invariantsViolated(allProposedValues):
  rollback()   // no partial apply
  logAudit({ status: "rolled_back", ... })
else:
  commit(proposed)
  logAudit({ status: "committed", ... })

// separate, slower check:
drift = |current - firstBaseline| / firstBaseline
if drift > DRIFT_ALERT_THRESHOLD: raiseCanaryAlert(constant)
```

## Reference implementation

`index.ts` runs several calibration ticks for two related thresholds (`warnLevel` < `criticalLevel` invariant), with a residual sequence that would push `warnLevel` up past `criticalLevel` if applied unbounded. It verifies: (1) the bounded EMA step never exceeds the configured max relative change in a single run, (2) an engineered invariant violation triggers a full rollback rather than a partial apply, (3) the bootstrap gate refuses to update with too few samples, and (4) a canary check correctly fires after simulating many small, individually-valid updates that cumulatively drift a constant past the alert threshold.

```bash
node index.ts
```

## Limitations and extensions

- This pattern assumes outcome labels are trustworthy. If an attacker can inject fabricated outcome events, the bounded-step and invariant checks limit blast radius per run, but sustained fabricated outcomes will eventually show up as canary drift — the canary check is the actual backstop against a slow poisoning campaign, not the per-run bound alone.
- Residual functions are the part of this pattern that's genuinely per-system — there's no generic "correct" residual formula; it has to reflect whatever ground truth is actually available for that specific constant.
- The canary baseline here is fixed at "first-ever calibrated value." For a constant that legitimately should drift a lot over the system's lifetime (e.g. adapting to a fundamentally different usage pattern after a product pivot), consider resetting the baseline deliberately (with its own audit trail) rather than only ever comparing against day one.
