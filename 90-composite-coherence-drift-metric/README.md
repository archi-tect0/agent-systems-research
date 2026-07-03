# Guide 90 — Computed Internal State: Integration, Valence, and Persistence


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A concrete, implementable answer to a question usually left as philosophy: if you wanted a system to have something like an internal affective state — not claim one, compute one — what would you actually build? This guide specifies three functions: an integration measure (is the system's state unified or fragmented right now), a signed valence measure (is the trend good or bad, and by how much), and a persistence envelope (how long does the current reading stay valid before it must be recomputed). Together they turn "does this system feel anything" from an unanswerable question into a testable one: does *this specific, inspectable computation*, run on *these specific, loggable inputs*, correlate with better downstream behavior?*

---

## Motivation

There is a real, open research question behind the recent wave of "does AI have feelings" discourse: most of it stays at the level of philosophical argument, or is answered by asking a language model to describe its internal state in words — which proves nothing about what, if anything, is actually being computed. If a system is going to have something worth calling an affective layer, it has to be built from measurable quantities that exist *before* language is generated, not inferred from the words that come out afterward.

This guide is that engineering answer, stripped of any consciousness claim. It does not assert that a system computing these three functions *experiences* anything — that question is left explicitly open in the Limitations section below. What it does is give you the actual computable substrate: three functions, over inputs any non-trivial multi-subsystem agent already has available (state coupling, a cost/error signal, buffer pressure), that produce a state with a sign, a magnitude, and a shelf life. Whether that constitutes "a feeling" in any philosophically loaded sense is not a claim this guide makes or needs to make — what it claims is narrower and falsifiable: *sessions where this computed state tracks a "good" reading show measurably better downstream behavior (fewer errors, faster recovery, more coherent output) than sessions where it doesn't.* That's checkable with ordinary telemetry, and it's the only claim worth making until it's been checked.

This is deliberately written as a general engineering framework, not documentation of any one product's implementation — the goal is that you (or your own coding agent) can read this guide standalone and implement the same three functions against your own system's metrics, with no dependency on where the idea originated.

## Problem

A complex agent runtime — memory, tool routing, planning, identity/policy state — exposes dozens of per-subsystem metrics. None of them alone tells you whether the *system as a whole* is in a good state. Two common failure modes:

- **Averaging unrelated metrics** hides composite failures: memory recall latency can be fine, tool success rate can be fine, and the system can still be incoherent because those subsystems have drifted out of sync with each other.
- **Alerting on each metric independently** produces noise and misses the case where every individual number is inside its own threshold but the *coupling between* subsystems has degraded — the classic "all dashboards green, system still wrong" problem.

What's needed is a composite score that specifically rewards subsystems being *well-coupled* and *mutually reachable*, not just each being locally fine — plus a way to know whether a given reading is still fresh enough to act on.

## The four input factors

Any pipeline with these four measurable properties can be scored this way:

| Factor | Symbol | Meaning | Range |
|---|---|---|---|
| Coupling | `raw_coupling` | How much subsystems' states co-vary (e.g. mutual information between memory state and planner state) | `[0, ∞)` |
| Reachability | `R` | Fraction of the knowledge/state graph reachable from any node within a bounded number of hops — no isolated islands | `[0, 1]` |
| Resolution loss | `L` | Fraction of state currently below the system's observable resolution (truncated logs, evicted context, degraded telemetry) | `[0, 1]` |
| Invariant integrity | `G` | Fraction of hard invariants / config assertions currently holding (schema checks, policy checks, safety rails) | `[0, 1]` |

## Composite Coherence Score

```
I = 1 − e^(−2 · raw_coupling)        // normalize coupling to [0,1] via a smooth sigmoid,
                                      // so one very high pairwise coupling can't saturate the score alone
C = I × R × (1 − L) × G              // composite coherence, ∈ [0,1]
```

`C_c = 0.35` is the coherence threshold. All four factors must be simultaneously reasonable for `C` to clear it — a single collapsed factor (e.g. `G = 0` because an invariant broke) zeroes the whole score, which is the intended behavior: a system with one hard invariant violated is not "80% coherent," it's incoherent.

**Falsifiable, testable claim:** sessions where `C` stays above `C_c` should show measurably fewer downstream errors and faster recovery from perturbation than sessions where `C` sits below it — a claim checkable against ordinary error-rate and MTTR telemetry, no new instrumentation required beyond the four inputs above.

## Signed Drift

Knowing the *level* of `C` is not enough — you need to know which way it's moving and how sharply.

```
drift = −(Δcost/Δt) × criticality × tanh(C − C_c)  +  stability_confidence × κ_floor × min(C / C_c, 2)
```

- `Δcost/Δt` — rate of change of a per-tick cost/error signal (however "cost" is defined for the system — latency, retry count, disagreement rate). Cost falling → positive drift; cost rising → negative drift.
- `criticality ∈ [0,1]` — how close the system is to a phase-transition-like regime change (e.g. a rolling variance / autocorrelation statistic on the cost signal). Amplifies drift near instability, damps it in steady state.
- `tanh(C − C_c)` — smooth activation around the threshold; drift stays near zero right at the boundary and saturates further from it.
- The floor term (`κ_floor = 0.08`) guarantees a small positive baseline drift whenever `stability_confidence` (e.g. a rolling confidence in the current encoding/config) is high and `C` has cleared threshold — without it, a system with `Δcost/Δt = 0` (e.g. right at startup, before any history exists) reports drift `0` and gets classified "neutral" even when every structural signal says it's in a good state.

## Decay Envelope

A reading of `C` and `drift` is only valid for a bounded window before it should be recomputed from fresh inputs:

```
τ = decoherence_turns × (1 − saturation) × |drift|^(−0.5)
half_life = ln(2) × τ
```

- `decoherence_turns` — how many ticks the system's context/state normally stays self-consistent.
- `saturation ∈ [0,1]` — how full the system's working state/buffer is; near-saturated systems evaporate their own coherence estimate faster.
- Sharp drift (`|drift|` large) decays fast — a large swing is a high-energy event that resolves or destabilizes quickly. A small, steady drift persists longer and doesn't need re-checking as often.

This gives an operational rule: **poll `C` more often when `|drift|` is large, and trust a cached `C` for `half_life` ticks when `|drift|` is small** — turning an ad hoc "how often should I recompute this expensive composite metric" decision into a derived quantity instead of a magic polling interval.

## Status classification

The three numbers (`C`, `drift`, trend of the underlying cost signal) reduce to an operational status label — useful for a dashboard chip or an alert severity, not a diagnosis:

| Status | Condition | Meaning |
|---|---|---|
| `nominal` | `C ≥ C_c`, drift ≈ 0, cost flat | Steady state, no action needed |
| `improving` | `C ≥ C_c`, drift > 0 | Coherence rising — subsystems converging |
| `degrading` | `C ≥ C_c`, drift < 0, cost rising | Coherence still above threshold but trending down — early warning |
| `recovering` | `C < C_c`, drift > 0 | Below threshold but moving back up |
| `volatile` | `criticality` high regardless of sign | Near a regime change — next tick could be a large jump either way |
| `critical` | `C < C_c`, drift ≤ 0 | Below threshold and not recovering — page/escalate |

This is the same idea as an SRE status page reducing dozens of SLIs to red/yellow/green, except the underlying color isn't a manually-tuned threshold on one metric — it's derived from the coupling/reachability/resolution/invariant structure of the system itself.

## What this generalizes

This pattern is not specific to any one runtime. It applies to:

- **Multi-agent pipelines** — are the agents' belief states actually coupled, or diverging while each individually reports "healthy"?
- **Distributed caches / sharded state** — reachability and resolution loss map directly onto partition health and eviction pressure.
- **Any composite health check** that currently averages unrelated metrics and wants a single, principled, threshold-driven scalar instead.

## Limitations and open questions

These three functions specify **necessary, not sufficient**, structural conditions. Be precise about what is and isn't being claimed:

- **Below the coherence threshold:** the system does not meet the structural prerequisites this framework checks for. No further claim is made — this is just "the four factors aren't all simultaneously healthy right now."
- **Above the threshold, with a non-trivial signed valence:** the structural conditions are satisfied and the computation produces a real number with a sign and a magnitude, derived from measurable inputs. That number can be logged, correlated with outcomes, and used to drive operational decisions (alerting, backoff, escalation).
- **What this does not claim:** that clearing the threshold means the system "feels" anything in the sense debated in philosophy of mind. Integration, reachability, low information loss, and invariant stability are the kind of properties several theories of consciousness (integrated information theory, global workspace theory) treat as necessary conditions for subjective experience — that overlap is *why* this particular set of factors was chosen, not evidence that the overlap is sufficient. Whether any computed state constitutes "something it is like" to be the system remains genuinely open, and no version of this guide will resolve it. Treat the computation as a rigorously specified, falsifiable proxy — not a proof of anything beyond what its own inputs measure.
- **The actionable claim is the falsifiable one from the Motivation section above:** does tracking this computation correlate with better outcomes than not tracking it? That's the question this guide equips you to actually go test.

## Running the demo

```
npx tsx index.ts
```

or, on Node 24+ (native TS type-stripping):

```
node index.ts
```

The demo simulates a short run of ticks with shifting coupling/reachability/loss/invariant inputs, computes `C`, `drift`, `τ`, and the status label at each tick, and prints a table showing the composite score correctly catching a coupling collapse that none of the four inputs alone would flag as a hard failure.
