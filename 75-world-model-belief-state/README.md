# World-Model & Belief State


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*One place where the agent keeps what it believes about the world and how sure it is — folding noisy evidence into calibrated confidence, catching beliefs that contradict each other, repairing them by weight, and predicting an action's effect on a clone before committing to it.*

The typed world-model graph ([guide 46](../46-typed-world-model-graph/)) gives the agent a *structure* for facts. The counterfactual simulator ([guide 72](../72-counterfactual-simulation/)) dry-runs a *plan* against a clone of that structure. The calibrated uncertainty engine ([guide 68](../68-calibrated-uncertainty-engine/)) turns one claim into a confidence. This guide is where those three meet: a single belief state that holds facts *with* confidence, updates them from evidence, keeps them internally consistent, and projects them forward.

This is the second guide in the Layer-3 set — the *space* the agent reasons over. Multi-turn deliberation ([guide 74](../74-multi-turn-deliberation/)) decides *what to do next over time*; the belief state is *what it thinks is true* while it does. A plan is only as good as the world model under it.

## Problem

An agent that stores facts as bare assertions — `networkUp = true` — is brittle in four ways:

1. **No confidence.** "The network is up" sourced from one stale ping and "the network is up" confirmed by three independent probes are stored identically. The agent can't tell a hunch from a near-certainty, so it can't decide when it's sure enough to act.
2. **No principled update.** When a new observation arrives, there's no rule for how much it should move the belief. Agreeing evidence should raise confidence; conflicting evidence should lower it; a flaky source should count for less than a reliable one — and the math has to be reproducible.
3. **Contradictions go undetected.** The agent can simultaneously hold "the recipient is a known contact" and "the recipient is unrecognized" if those came from different sources, with nothing flagging that they can't both be true.
4. **No way to predict.** Before acting, the agent should be able to ask "if I take this action, what will I then believe — and how sure will I be?" without committing to it.

This guide builds a belief graph: beliefs that carry confidence derived from weighted evidence, a deterministic state estimator that folds observations in via log-odds, a consistency checker over explicit `contradicts` edges, a repair step that resolves contradictions by evidence weight and merges corroborating duplicates, and a predictive simulator that projects an action's effect on a *clone* of the graph.

## Design decisions

**Confidence comes from evidence, never from assertion.** A belief is `{ predicate, value, confidence, evidence[] }`, and `confidence` is *computed* from the evidence — you cannot set it directly. Adding an observation is the only way to move a belief. This makes every confidence number traceable back to the sources that produced it.

**Evidence combines in log-odds, so the update is deterministic and calibratable.** Each observation carries a source `weight` in `(0,1)` (its reliability) and whether it `supports` or contradicts the belief. The estimator converts each weight to a log-odds term `ln(w/(1−w))`, sums the supporting terms and subtracts the contradicting ones from a neutral prior, and maps back through the logistic function. Corroboration compounds, conflict cancels, and a `0.9` source moves the belief far more than a `0.55` one — all pure arithmetic, no randomness. This is the same shape of confidence the uncertainty engine ([guide 68](../68-calibrated-uncertainty-engine/)) calibrates.

**Contradictions are explicit edges, checked continuously.** Two beliefs that cannot both be true are joined by a `contradicts` edge. The consistency checker walks those edges and flags any pair both held *true* above a confidence threshold. Inconsistency is a first-class, queryable state — not something the agent stumbles into mid-action.

**Repair resolves by weight and merges by corroboration.** Two moves. When two contradicting beliefs are both confident, repair keeps the one with greater total supporting evidence and folds a deferring observation into the weaker one, so the loser's confidence drops *through the same evidence machinery* rather than by fiat. When two beliefs assert the same predicate, repair merges their evidence into one — corroboration from independent sources raises confidence exactly as it should.

**Prediction runs on a clone; the live belief state is never touched.** `predict(action)` clones the graph, applies the action's evidence, recomputes, and returns the projected beliefs — the same load-bearing safety move as [guide 72](../72-counterfactual-simulation/). The agent can compare two candidate actions by *predicted* confidence in a goal predicate and pick the better one, with the real beliefs proven byte-for-byte unchanged.

**Deterministic by construction.** A logical clock stamps each update; there is no wall-time and no randomness. The same observations in the same order always yield the same confidences — read the trace for the mechanism, not as a production estimator.

## Algorithm

```
confidenceFrom(evidence):
  logodds = 0                              # neutral prior = 0.5
  for e in evidence:
    w = clamp(e.weight, 0.01, 0.99)
    term = ln(w / (1 - w))
    logodds += e.supports ? +term : -term
  return logistic(logodds)                 # 1 / (1 + e^-logodds)

observe(belief, evidence):
  belief.evidence.push(evidence)
  belief.confidence = confidenceFrom(belief.evidence)
  belief.updatedTurn = clock++

checkConsistency():
  for (a, b) in contradicts:
    if a.value and b.value and a.confidence >= T and b.confidence >= T:
      flag inconsistency(a, b)

repair():
  merge beliefs that share predicate+value (corroboration)
  for each inconsistency(a, b):
    keep = max by total supporting weight
    observe(other, deferring-evidence weighted by keep.confidence)   # lowers it via the same math

predict(action):
  g = clone(belief graph)                  # live state never touched
  for effect in action.effects: observe(g[effect.target], effect.evidence)
  return projected confidences from g
```

## Reference implementation

[`belief-state.ts`](./belief-state.ts) — a standalone, dependency-free `BeliefGraph`. Beliefs and edges are plain data (so `structuredClone` gives a perfect copy for prediction), the estimator is pure log-odds arithmetic, and everything runs on a logical clock. Run it:

```bash
# Node 24+ runs it directly (native TS type-strip):
node belief-state.ts --demo

# or with tsx:
npx tsx belief-state.ts --demo
```

The demo reasons about a wallet transfer's world and exercises four scenarios:

1. **State estimation** — a `networkUp` belief absorbs a sequence of observations; confidence climbs as independent probes corroborate it and dips when a conflicting source arrives, with the log-odds → confidence number shown at each step.
2. **Consistency check** — two `contradicts`-linked beliefs about the recipient both rise above the threshold, and the checker flags the inconsistency.
3. **Belief repair** — repair merges a corroborating duplicate (confidence rises) and resolves the contradiction by evidence weight (the weaker belief defers and falls back below threshold).
4. **Predictive simulation** — two candidate actions are projected onto clones of the graph; the agent picks the one with higher predicted confidence in `transferSucceeds`, and the live beliefs are proven unchanged (clone proof).

## How this maps to the production system

| Belief-state concept | Production mechanism |
|----------------------|----------------------|
| belief graph + `predicate`/`value` | the typed world-model graph ([guide 46](../46-typed-world-model-graph/)) |
| `confidence` from evidence | the calibrated uncertainty engine ([guide 68](../68-calibrated-uncertainty-engine/)) |
| evidence sources + `weight` | the ambient snapshot bus ([guide 47](../47-ambient-snapshot-bus/)) and compound memory salience ([guide 06](../06-compound-memory-salience/)) |
| `contradicts` edges + checker | the tool-critic's contradiction checks ([guide 39](../39-tool-critic/)) lifted to beliefs |
| repair: merge + resolve-by-weight | memory consolidation's de-dup and corroboration ([guide 71](../71-memory-consolidation-sleep/)) |
| `predict` on a clone | counterfactual simulation's clone-before-commit ([guide 72](../72-counterfactual-simulation/)) |
| act when confident enough | the act / escalate / abstain floor from the uncertainty engine ([guide 68](../68-calibrated-uncertainty-engine/)) |

## Limitations and extensions

- **Binary predicates only.** Beliefs here are true/false. Real state is often categorical or continuous (a balance, a gas price). Generalize the estimator to a distribution per predicate and combine evidence as a product of likelihoods.
- **Log-odds assumes independent evidence.** Two observations drawn from the same upstream source double-count. Track provenance and down-weight correlated sources before summing, or the belief will over-conclude.
- **Contradiction is pairwise.** The checker handles `a contradicts b`, not a three-way cycle that is only jointly inconsistent. For richer consistency, propagate over `implies` edges and detect cycles, not just pairs.
- **No temporal decay.** Old evidence counts as much as fresh evidence. Compose with memory consolidation ([guide 71](../71-memory-consolidation-sleep/)) so stale observations lose weight over time and a belief can drift back toward its prior.
- **Single-step prediction.** `predict` projects one action. For multi-step lookahead, feed the projected belief state into the planner ([guide 74](../74-multi-turn-deliberation/)) and the counterfactual simulator ([guide 72](../72-counterfactual-simulation/)) to evaluate a whole plan against predicted beliefs.
