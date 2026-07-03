# Resource Self-Governance


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*An agent that budgets its own tokens, latency, and cost — trading quality for cheaper paths under pressure, and protecting a reserve so it can always afford to finish.*

The calibrated-uncertainty engine ([guide 68](../68-calibrated-uncertainty-engine/)) decides *whether* to act by weighing confidence against risk. It leaves one term open: what an action *costs*. This guide fills it in. It is the part of a self-maintaining agent that watches its own resource envelope — how many tokens, how much wall-clock, how much money a task has burned — and chooses *how* to do the next step so the whole job lands inside the budget.

This is the fourth guide in the Layer-2 set (the agent operating on *itself*). Where guide 68 governs the act/abstain decision, this governs the cheap/expensive decision — and the two compose: confidence says "answer", governance says "answer with the small model, you're nearly out of time".

## Problem

An agent that always reaches for its best tool behaves correctly right up until it runs out of budget mid-task — and then it fails the *whole* job, often after the expensive part is already spent. Three things are missing:

1. **A multi-resource view.** Tokens, latency, and money drain at different rates. A task can be rich in tokens and nearly out of wall-clock; the agent must let the **binding** resource (the one closest to empty) drive the decision, not an average that hides the shortage.
2. **Graceful degradation.** The same menu of paths — frontier model, small model, cached heuristic — should resolve to the *best* path when budget is plentiful and the *cheapest viable* path when it is scarce, without a separate code path for each regime.
3. **A protected reserve.** If the agent spends every last token on intermediate steps, it cannot afford to actually deliver the answer. It needs to hold a slice back for the finish line and refuse to touch it on ordinary mid-task steps.

This guide builds a resource ledger and a governor that makes the cheap/expensive choice against it, with the reserve as a first-class invariant.

## Design decisions

**Three resources, and the binding one wins.** A `Budget` is `{ tokens, latency_ms, cost_cents }`, and pressure is computed as the *minimum* fraction remaining across all three — not the mean. "Plenty of tokens but 12% of the time left" must behave like "12% left", because the resource that runs out first is the one that kills the task. Averaging would let an abundant resource mask a starved one until it is too late.

**Pressure tiers scale cost-aversion, not the option set.** The governor scores every path the same way at every pressure level: `score = utility − costAversion × normalizedCost`. What changes with pressure is a single scalar, `costAversion`, which climbs from `0.25` (abundant) to `0.9` (tight) to `2.5` (critical). At low aversion the high-utility frontier path wins; at high aversion the same arithmetic makes the cheap path win. One scoring rule, three regimes — degradation falls out of the math instead of being hand-coded per tier.

**Cost is normalized against the *original* budget, by the binding resource.** `normCost(est)` is the maximum over resources of `est[k] / budget[k]` — the fraction of the whole budget this path would consume in whichever dimension it is heaviest. Normalizing keeps tokens, milliseconds, and cents comparable in one score, and taking the max (not the sum) means a path that is cheap on two axes but ruinous on the third is correctly penalized.

**The reserve is protected by default and unlocked only to finish.** The ledger holds back `reserveFraction` (15%) of the original budget. Ordinary steps see `available = remaining − reserve`; a step explicitly marked `isFinalize` sees the full `remaining`. Crucially the unlock is tied to *being the finish line*, not to pressure: even at `critical` pressure a non-finalize step still may not touch the reserve. This is what produces the key behavior: at low budget a *mid-task* step **abstains** rather than eat the reserve, but the *finalization* step is allowed to spend it — so the agent always keeps enough in the tank to actually deliver.

**Abstention is an honest outcome, not an error.** When nothing fits even with the reserve, `choose` returns an `abstain` decision with a reason instead of forcing the cheapest path through. An agent that pretends to complete a task it cannot afford is worse than one that says so.

## Algorithm

```
Budget = { tokens, latency_ms, cost_cents }
pressure(ledger):                          # binding resource sets the tier
  f = min over k ( remaining[k] / budget[k] )
  f >= 0.5 -> abundant ; f >= 0.2 -> tight ; else -> critical

normCost(est, budget):                     # fraction of budget in heaviest dimension
  return max over k ( est[k] / budget[k] )

choose(step, options, isFinalize):
  tier = tierFor(pressure(ledger))
  includeReserve = isFinalize              # only the finish line may touch the reserve
  avail = remaining − (includeReserve ? 0 : reserve)

  affordable = [ o for o in options if o.est <= avail in every resource ]
  if affordable is empty:
    return ABSTAIN(reason)                  # honest: cannot complete in budget

  best = argmax over affordable of ( o.utility − tier.costAversion * normCost(o.est) )
  usedReserve = best.est does NOT fit within (remaining − reserve)
  return PROCEED(best, usedReserve)

commit(decision): ledger.charge(decision.option.est)
```

## Reference implementation

[`resource-self-governance.ts`](./resource-self-governance.ts) — a standalone, dependency-free `ResourceLedger` + `ResourceGovernor`. Budgets are plain objects, the ledger tracks spend and computes pressure/reserve/availability, and `choose` is a pure scoring pass. Run it:

```bash
# Node 24+ runs it directly (native TS type-strip):
node resource-self-governance.ts --demo

# or with tsx:
npx tsx resource-self-governance.ts --demo
```

The demo gives a fixed budget (`100k tokens / 60s / 50¢`, 15% reserve) three ways to answer a step (frontier+search, small+cache, heuristic+memory) and two ways to finalize, then exercises five scenarios:

1. **Abundant budget** — nothing spent → low cost-aversion → the frontier path wins on utility.
2. **Tight budget** — at 30% remaining the frontier path no longer fits the non-reserve budget → it degrades to the small model.
3. **Critical pressure, mid-task** — only the reserve is left and a non-finalize step may not spend it → **abstain**, preserving enough budget to actually deliver.
4. **Finalize step** — same depleted ledger, but the finish line unlocks the reserve → the summary gets delivered.
5. **Truly empty** — nothing fits even with the reserve → an honest abstain instead of a pretend completion.

## How this maps to the production system

| Governance concept | Production mechanism |
|--------------------|----------------------|
| `Budget` resources | per-turn token caps, the agent-turn latency budget, the cloud-provider cost meter |
| binding-resource `pressure` | the waterfall backend health/quota signals that already force model downgrades under load |
| `PathOption` (utility + est) | the choice between frontier vs. small vs. cached/heuristic answer paths the router already arbitrates |
| `costAversion` per tier | the implicit "use the cheap path when we're throttled" policy, made explicit and continuous |
| `normCost` against budget | normalizing token/latency/cost so one number ranks heterogeneous paths |
| protected `reserve` | holding back enough budget to always run the final summary/deliver step |
| `isFinalize` unlock | the distinction between an intermediate tool call and the user-facing reply that must complete |
| `abstain` decision | the empty-response guard's deterministic fallback when no affordable path exists |

## Limitations and extensions

- **Estimates are static.** Each path's `est` is a fixed guess. In production, learn it: track actual spend per path and feed an exponential moving average back into `est`, the way [guide 68](../68-calibrated-uncertainty-engine/) calibrates confidence against outcomes.
- **Cost-aversion is a step function over three tiers.** It is intentionally coarse so the behavior is legible. If you need smoother degradation, make `costAversion` a continuous function of `fractionRemaining` (e.g. `λ = a·(1−f)^b`) — the scoring rule is unchanged.
- **The binding resource is the max over equal-weighted axes.** If money matters more than latency for a given task, weight the axes in both `normCost` and the affordability check rather than treating all three as equally fatal.
- **Reserve is a flat fraction.** A long agentic task may need a *growing* reserve as more irreversible steps accumulate. Compute the reserve from the estimated cost of the remaining must-do steps instead of a fixed 15%.
- **One step at a time.** The governor optimizes each step greedily. For a known multi-step plan, pair it with the counterfactual simulator ([guide 72](../72-counterfactual-simulation/)) to budget the *whole* plan before committing to the first expensive path.
