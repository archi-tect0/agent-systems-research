# Polyphonic Cognition


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*Many of one agent's own cognitive faculties running at once on a single turn — uncertainty, counterfactual simulation, the constitution, the tool-critic, budget and tone — fanned out concurrently and arbitrated into one verdict, where a hard guardrail can veto a confident majority and a genuinely split panel escalates instead of acting alone.*

The Layer-2 set built the agent's cognitive *organs* — calibrated uncertainty ([guide 68](../68-calibrated-uncertainty-engine/)), counterfactual simulation ([guide 72](../72-counterfactual-simulation/)), self-repair ([guide 66](../66-metacognitive-self-repair/)), resource governance ([guide 70](../70-resource-self-governance/)). The Layer-3 set made the agent reason across time, space, and a society of other *agents* ([guide 76](../76-multi-agent-coordination/)). This guide is the inward counterpart to that society: rather than many agents coordinating outward, it runs many of *one* agent's own organs concurrently on a single turn and arbitrates their voices into one decision.

This is the first guide in the Layer-4 set — the agent running as *many minds at once*. Where guide 76 was a society of minds reasoning with each other, this is a society of faculties reasoning *inside* one mind. The difference from everything before it is structural: the earlier guides invoke organs one after another in a fixed pipeline, where the last step quietly overwrites the rest. Polyphony runs them together, lets them agree or disagree out loud, and decides by an explicit rule.

## Problem

An agent that consults its faculties one at a time, in a hard-coded order, fails in four ways:

1. **The pipeline hides disagreement.** If uncertainty runs, then the tool-critic runs, then governance runs, whichever runs last shapes the decision and the earlier signals are lost. The agent can be deeply conflicted — one faculty screaming *stop*, another confidently saying *go* — and none of that tension reaches the verdict.
2. **No faculty can truly override another.** A hard guardrail ("keys never leave the device") should be able to stop an action no matter how confident every other signal is. In a weighted pipeline a veto is just another vote, so a sufficiently confident majority can drown out a rule that was never meant to be outvoted.
3. **A slow or broken faculty stalls or crashes the turn.** When organs are chained, one that hangs on a network call or throws an exception takes the whole turn down with it. There is no notion of "decide with the faculties that answered in time."
4. **Splits are resolved by accident, not by policy.** When the agent's faculties are evenly divided, a pipeline still produces *some* answer — usually whatever the last stage said. There is no rule that says "when you are genuinely of two minds about an irreversible action, ask rather than act."

This guide builds a conductor: a set of cognitive organs that each return a typed contribution (a stance, a confidence, a weight, an optional hard veto), fanned out concurrently under per-organ time budgets, with failure-isolated execution, veto dominance, weighted arbitration against a risk-aware threshold, and dissent promoted to a first-class signal that downgrades *act* to *escalate*.

## Design decisions

**Every faculty is an organ with the same shape — a stance, a confidence, and a weight.** Uncertainty, the counterfactual simulator, the constitution, the tool-critic, the resource governor, and the relational model all implement one `evaluate(turn) → Contribution` interface. Putting them behind a uniform contract is what lets them be run together and compared, exactly as guide 76 put humans, agents, and tools behind one `Peer` shape.

**Organs run concurrently, and arbitration is independent of who finishes first.** The conductor fans every organ out at once and waits for all of them, but it folds the results *in panel order* (the fixed input order), never by completion order. Concurrency buys latency; it must never change the verdict. The same turn always produces the same decision no matter which organ happened to win the race.

**A hard veto dominates every vote.** An organ may mark its contribution `veto: true`. If any does, arbitration stops and the most severe vetoing stance wins — `abstain` over `escalate` — regardless of how many organs, how confidently, voted to act. This is the architectural keys-never-leave-the-device and passkey-floor constants expressed as cognition: some rules are not up for a vote.

**Non-veto organs are arbitrated by a weighted permissiveness score against a risk-aware floor.** Each stance maps to a permissiveness value (`act`=1, `escalate`=0.5, `abstain`=0); the conductor takes the weight-and-confidence-weighted mean and compares it to a threshold. The threshold is *raised* for an irreversible or high-impact action, so a risky turn needs near-unanimity to act while a trivial one needs only a rough majority — the same graded-by-stakes idea as the uncertainty engine's risk floors ([guide 68](../68-calibrated-uncertainty-engine/)).

**Dissent is first-class: a split panel escalates instead of acting.** The conductor measures the spread of stances. When the organs are genuinely divided, the action is downgraded from *act* to *escalate* and the verdict's confidence is reduced in proportion to the disagreement. Harmony acts; dissonance asks. This is the reasoning-shard merge gate ([guide 50](../50-headless-reasoning-shards/)) generalized from read-only shards to the agent's whole faculty set.

**Faculties are failure-isolated.** Each organ runs under its own time budget; one that throws or overruns is dropped as a *silent organ*, recorded in the verdict, and never allowed to crash or stall the turn. A degraded panel still decides — and is honest that it decided with fewer voices.

**Deterministic by construction.** Stances, weights, and thresholds are fixed; arbitration folds by id; there is no wall-time input and no randomness. The same turn context always yields the same verdict — read it for the mechanism, not as a production ensemble.

## Algorithm

```
conduct(ctx, organs):
  settled = await all(organs.map(o => runOrgan(o, ctx)))   # concurrent, never throws
  contributions = settled.where(ok)                         # folded in panel order, not finish order
  silent        = settled.where(!ok)                        # crashed / timed-out organs

  vetoes = contributions.where(veto)                        # (1) veto dominance
  if vetoes: return most-severe(vetoes) stance              #     abstain > escalate

  deciders = contributions.where(!advisoryOnly)             # (2) weighted arbitration
  score = Σ(weight·confidence·permissiveness) / Σ(weight·confidence)

  dissent = stddev(stance permissiveness over deciders)     # (3) dissent
  split   = dissent >= DISSENT_THRESHOLD

  actAt = (irreversible or high impact) ? 0.9 : 0.75        # (4) risk-aware floor
  decision = score >= actAt ? act : score >= 0.35 ? escalate : abstain
  if split and decision == act: decision = escalate         #     a split house asks

  confidence = mean(decider confidence) · (1 - dissent)
  return { decision, confidence, score, dissent, silent }

runOrgan(o, ctx):                                           # failure isolation
  try: r = await raceTimeout(o.evaluate(ctx), o.budgetMs)
       return r == TIMEOUT ? silent(o, "timeout") : ok(r)
  catch: return silent(o, "error")
```

## Reference implementation

[`polyphonic-cognition.ts`](./polyphonic-cognition.ts) — a standalone, dependency-free `Conductor` plus an organ library (constitution, uncertainty, counterfactual, tool-critic, resource, relational). Organs are plain async functions of the turn context, run concurrently with `Promise.all`, and arbitrated by pure arithmetic. Run it:

```bash
# Node 24+ runs it directly (native TS type-strip):
node polyphonic-cognition.ts --demo

# or with tsx:
npx tsx polyphonic-cognition.ts --demo
```

The demo puts a six-organ panel through four turns:

1. **Harmony → act** — a safe, low-impact read (summarize unread mail). Every organ votes act with high confidence, the score clears the ordinary threshold, and the agent proceeds without bothering the user.
2. **Dissonance → escalate** — an irreversible critical sweep where the counterfactual organ abstains (it found a failing step), uncertainty hedges, and the tool-critic still votes act. Under a raised risk floor the split panel is downgraded to escalate, so the agent shows a confirm card instead of acting.
3. **Veto dominance → abstain** — an action that violates a hard invariant (export a raw key to a chat reply). The constitution organ vetoes; the verdict is abstain even though every other organ would have acted — severity beats the majority.
4. **Failure isolation → act** — a benign turn with one organ that throws and one that overruns its budget. Both are dropped as *silent organs* and surfaced in the verdict, and the panel still decides from the organs that answered in time.

## How this maps to the production system

| Polyphony concept | Production mechanism |
|-------------------|----------------------|
| organ: constitution veto | the will/constitution guardrail layer ([guide 38](../38-will-constitution-engine/)) |
| organ: uncertainty stance | the calibrated uncertainty engine ([guide 68](../68-calibrated-uncertainty-engine/)) |
| organ: counterfactual risk | counterfactual simulation on a clone ([guide 72](../72-counterfactual-simulation/)) |
| organ: tool appropriateness | the tool-use critic ([guide 39](../39-tool-critic/)) |
| organ: budget pressure | resource self-governance ([guide 70](../70-resource-self-governance/)) |
| organ: tone (advisory) | the relational-intelligence model ([guide 31](../31-relational-intelligence-model/)) |
| concurrent fan-out + ordered fold | the headless reasoning shards' merge gate ([guide 50](../50-headless-reasoning-shards/)) |
| dissent downgrades act → escalate | the act / escalate / abstain floor ([guide 68](../68-calibrated-uncertainty-engine/)) feeding the approval ceremony ([guide 49](../49-batched-approval-ceremony/)) |
| silent-organ isolation | the per-turn conversation-state kernel's empty-response guard ([guide 40](../40-conversation-state-kernel/)) |

## Limitations and extensions

- **Weights and thresholds are static.** The arbitration weights are fixed here. A real panel should learn them — an organ that is repeatedly overruled and proven right should gain weight (feed the tool-critic's outcome memory back into the weights), so the panel calibrates which faculties to trust on which kinds of turn.
- **Dissent is a single scalar.** A standard deviation says *how much* the organs disagree, not *about what*. Surface the disagreement structurally — "uncertainty and counterfactual disagree about reversibility" — so the escalation card tells the user the actual fault line, not just that one exists.
- **Veto is all-or-nothing.** One veto stops the turn. A graded constitution (soft vetoes that demand a second human, hard vetoes that abstain outright) would let the agent distinguish "never" from "not without explicit sign-off".
- **No cross-turn memory of the panel.** Each turn is arbitrated fresh. An organ that keeps flip-flopping, or a panel that keeps escalating the same intent, is a signal in itself — track verdict history and compose with self-repair ([guide 66](../66-metacognitive-self-repair/)) when the panel itself looks unhealthy.
- **Organs are assumed independent.** Two organs that both read the same upstream signal double-count it in the weighted mean, exactly like correlated evidence in the belief state ([guide 75](../75-world-model-belief-state/)). Track provenance and down-weight organs that share inputs before summing their votes.
