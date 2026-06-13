# Calibrated Uncertainty Engine

*One honest number per claim — derived from evidence, bent toward the agent's real hit rate, and turned into act / escalate / abstain against a floor that scales with the stakes.*

An agent that sounds equally confident about "this song is lo-fi" and "send 2 ETH to this address" is dangerous in exactly the second case. This guide gives the agent a single **calibrated confidence** per decision and a policy that converts it into one of three actions. The number is *calibrated* — meaning it has been checked against reality, so a stated "0.9" actually corresponds to being right about nine times in ten, not to a tone of voice.

This is a Layer-2 capability (the agent reasoning about *its own* certainty). Guide 66's repair loop has a single hard `CONFIDENCE_FLOOR`; this guide is the machinery that makes such a floor *mean* something and lets it differ by how much is at stake.

## Problem

LLM "confidence" is uncalibrated by default: models are routinely overconfident, and a raw softmax-ish number says nothing about a real-world hit rate. Three failures follow:

- **Overconfidence on high-stakes actions.** The model says 0.9, acts, and is wrong often enough to matter — but the action was irreversible.
- **No abstention.** Faced with thin evidence, the agent produces a confident-sounding guess instead of "I don't know", which is the answer that actually preserves trust.
- **One threshold for everything.** A 0.7 that is fine for recommending a track is reckless for moving funds. A single global floor is either too timid for trivia or too reckless for transactions.

What you want is: a confidence **derived from evidence**, **corrected against the agent's measured track record**, and **compared to a floor that scales with risk**, with a continuous score that tells you whether the numbers are getting more honest over time.

## Design decisions

**Evidence is combined with a weighted geometric mean, not an average.** Confidence is built from independent factors — how many sources agree, how fresh the data is, the agent's prior reliability on this *kind* of claim, and how much evidence backs it. A weighted *geometric* mean means a single near-zero factor (no corroboration at all) drags the whole result toward zero, instead of being averaged away by three confident-but-irrelevant factors. "I'm sure, but nothing backs it up" should not score high, and the geometric mean enforces that.

**Calibration is learned from outcomes, per confidence bin.** Predictions are bucketed into ten bins by stated confidence. For each bin the engine knows the *average predicted* confidence and the *actual* hit rate. `calibrate(raw)` replaces a raw number with the empirical hit rate of its bin. If the agent historically says "0.9" in a bin that only hits 0.6, a fresh 0.9 gets bent down toward 0.6. This is the whole point: the number is anchored to measured reality, not to the model's self-image.

**Thin bins are smoothed and blended, never trusted blindly.** A bin with three data points should not override a strong prior. Two guards: Laplace smoothing pulls a thin bin toward 0.5 (maximum ignorance), and a trust weight (`n / (n + 5)`) blends the empirical rate against the raw confidence in proportion to how much data the bin actually has. With no history at all, `calibrate` returns the raw prior unchanged — the engine earns the right to override the prior as evidence accumulates.

**The decision floor scales with risk, and there is an escalation band below it.** Each risk tier (`low / medium / high / critical`) has a floor and a band beneath it. Above the floor → **act**. Inside the band → **escalate** (ask a human, get a second opinion). Below the band → **abstain**. The same calibrated 0.82 plays a song (low) and refuses an irreversible transfer (critical). This is the structural reason a wallet send needs near-certainty while a recommendation needs only a lean.

**Honesty is measured with a Brier score.** The engine reports its own Brier score (mean squared error of confidence vs outcome) and a per-bin reliability table. This makes calibration *observable*: you can watch the Brier score fall as the calibration map learns, and you can see in the table exactly which bin is overconfident. A confidence system you cannot score is just a vibe with decimals.

## Algorithm

```
rawConfidence(evidence):                       # weighted geometric mean in (0,1)
  return exp( Σ wᵢ·ln(clamp(factorᵢ)) / Σ wᵢ )

calibrate(raw):                                # bend toward measured hit rate
  bin   = floor(raw * 10)
  hist  = predictions whose bin == bin
  if hist empty: return raw                    # no evidence -> trust the prior
  smoothed = (hits + 1) / (n + 2)              # Laplace
  trust    = n / (n + 5)
  return raw·(1 - trust) + smoothed·trust

decide(calibrated, risk):                      # floor + escalation band per tier
  {floor, band} = RISK_FLOORS[risk]
  if calibrated >= floor:        return ACT
  if calibrated >= floor - band: return ESCALATE
  return ABSTAIN

observeOutcome(confidence, correct):           # close the loop
  history.push({confidence, correct})          # feeds calibrate() and brier()

brier(): mean( (confidence - (correct?1:0))² ) # lower is better; 0.25 = always 0.5
```

## Reference implementation

[`calibrated-uncertainty.ts`](./calibrated-uncertainty.ts) — a standalone, dependency-free `UncertaintyEngine` plus the `CalibrationModel` it wraps. History is an in-memory array; a tiny seeded PRNG makes the calibration demo reproducible. Run it:

```bash
# Node 24+ runs it directly (native TS type-strip):
node calibrated-uncertainty.ts --demo

# or with tsx:
npx tsx calibrated-uncertainty.ts --demo
```

The demo exercises four scenarios:

1. **Evidence → raw confidence** — strong evidence scores ~0.90; flipping one factor to near-zero collapses it to ~0.40, showing the geometric mean punishing the weak link.
2. **Per-risk decision policy** — the *same* calibrated 0.82 returns ACT for low/medium/high and ABSTAIN for critical.
3. **Calibration corrects overconfidence** — trained on 400 outcomes where "0.9" claims only held ~60% of the time, the reliability table shows the 0.9 bin hitting 0.62, and a fresh raw-0.95 claim is bent down to ~0.63 → ESCALATE instead of ACT.
4. **Abstain on thin evidence** — weak evidence produces a low confidence and an ABSTAIN, the honest non-answer.

## How this maps to the production system

| Engine concept | Production mechanism |
|----------------|----------------------|
| evidence factors | source/shard agreement from [guide 50](../50-headless-reasoning-shards/), recency from the snapshot bus ([guide 47](../47-ambient-snapshot-bus/)), prior reliability from correction memory, sample strength from retrieval counts |
| `priorReliability` | the agent's measured hit rate per intent kind, read from the same store the tool-critic ([guide 39](../39-tool-critic/)) writes |
| calibration map | per-intent-kind outcome history persisted across turns and restarts |
| `RISK_FLOORS` | the existing risk tiers behind the passkey floor and spend governor ([guides 17](../17-agent-spend-limit-wallet/), [18](../18-multichain-spend-governor/)) |
| ESCALATE | route to a human approval card or a second-opinion reasoning shard |
| ABSTAIN | the empty-response guard's "say what you don't know" path ([guide 40](../40-conversation-state-kernel/)) |
| Brier / reliability table | an observability surface for whether the agent's self-reported certainty is honest over time |

## Limitations and extensions

- **Global calibration conflates domains.** One calibration map across all claim types learns an average that fits none. Key the map by intent kind (factual recall vs endpoint health vs arithmetic) so each domain gets its own correction curve.
- **Ten linear bins are coarse.** Equal-width bins put most traffic in a couple of buckets. Use adaptive (equal-mass) bins or isotonic regression for a smoother calibration map once you have volume.
- **Outcomes must be labelable.** Calibration needs a ground-truth signal ("was that claim right?"). Where outcomes are delayed or unobservable, fall back to the raw prior and mark the decision low-trust rather than fabricating a label.
- **No cost term in the policy.** `decide` weighs confidence against risk but not against the *cost* of escalating. Pair it with a resource self-governor so a cheap action with marginal confidence acts while an expensive one escalates.
- **The floors are static.** `RISK_FLOORS` is fixed here. A relational layer ([guide 31](../31-relational-intelligence-model/)) could raise the floor when the user is stressed or the context is unfamiliar, so the agent hedges more exactly when the cost of being wrong is highest.
