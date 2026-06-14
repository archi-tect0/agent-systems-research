# Multi-Turn Deliberation & Multi-Step Planning

*Carrying one intent across many turns — decomposing it into a plan graph, executing it a subgoal at a time, monitoring the assumptions it rests on, repairing it when one breaks, and escalating or abandoning it when risk spikes or confidence collapses.*

The reflective runtime ([guide 73](../73-reflective-runtime/)) gives you a complete *single-turn* cognitive cycle: route → score → govern → dispatch → remember → reflect. The counterfactual simulator ([guide 72](../72-counterfactual-simulation/)) dry-runs *one* plan on a clone before acting. This guide is the layer above both: it is what lets the agent *think longer than one turn* — pursue a goal over time, adaptively, holding intent steady while the world shifts underneath it.

This is the first guide in the Layer-3 set (the agent operating across *time*). Where Layer-2 made the agent operate on itself within a turn, Layer-3 makes a *sequence* of turns add up to a coherent pursuit. It is the difference between "do one thing well" and "pursue a goal over time, adaptively."

## Problem

A single-turn agent re-derives its intent from scratch every turn. For anything that takes more than one action — *move my savings to the hardware wallet and arm recovery* — that leaves four gaps:

1. **Intent amnesia.** Without a place to hold the plan between turns, the agent forgets what it was doing the moment the turn ends. Long-horizon goals dissolve into disconnected one-shot actions.
2. **No subgoal structure.** A goal is not a flat list — it is a graph: *whitelist* depends on *passkey*, *transfer* depends on *whitelist*, *verify quorum* depends on *enroll guardians*. Without dependencies, the agent has no notion of what is ready to run next versus what is still blocked.
3. **Stale assumptions go unnoticed mid-plan.** A plan is built against a snapshot of the world. By turn 4 the network may be down, the balance may have dropped, the user may have already moved the funds. Nothing re-checks the assumptions each subgoal rests on as new information arrives.
4. **No graceful exit.** When risk spikes mid-plan (the transfer is now larger than the per-turn limit) or confidence collapses (the goal no longer makes sense), the agent needs to *escalate* or *abandon* — not blunder forward or hang.

This guide builds a deliberation engine: a persistent buffer that carries one intent across turns, a plan graph of subgoals with dependencies, a per-turn monitor that re-checks assumptions and risk, a repair step that splices in an enabler when an assumption breaks, and explicit termination — `succeeded`, `failed`, `escalated`, or `abandoned`.

## Design decisions

**The deliberation buffer *is* the agent's continuity.** One object — root goal, plan graph, confidence, a logical turn counter, and a log — persists across every `step()`. This is the load-bearing idea: continuity across turns is a data structure you keep, not a property you hope the model remembers. Everything else operates on this buffer.

**A plan is a graph, not a list.** Each subgoal declares its `deps`; the engine runs the *first ready* subgoal (all dependencies `done`) each turn. Dependencies — not array position — decide order, so parallel branches (transfer *and* recovery setup) interleave naturally and a blocked branch simply waits.

**The monitor re-checks assumptions every single turn, against the live world.** A subgoal can declare it `assumes` a world fact (`networkUp`, `hasPasskey`). Before executing it, the engine re-reads that fact from the current world — not the world the plan was drafted against. New information arriving between turns is therefore caught at the exact moment it would invalidate the next step.

**Repair makes progress; it does not restart.** When an assumption is broken, the engine consults a `REPAIRS` library keyed by the broken fact and *splices an enabler in before the failing subgoal* — the same move as [guide 72](../72-counterfactual-simulation/)'s `repairPlan`, applied across turns instead of within a dry run. The rest of the plan, including work already done, is preserved.

**Risk is checked per subgoal, mid-plan, and escalation never acts.** Every subgoal carries a `risk` in `[0,1]`. If it exceeds the runtime's ceiling *at the moment it becomes ready*, the engine stops and returns `escalated` — it does **not** execute and then ask forgiveness. This is the passkey-floor / batched-approval boundary expressed in the planner: a high-stakes step pauses for a human before any side effect.

**Confidence collapse abandons cleanly.** A separate signal — the root goal no longer being valid — drives `confidence` toward zero. Below a floor, the engine returns `abandoned` and stops, rather than completing a plan whose reason for existing has evaporated.

**Deterministic by construction.** A logical clock (the turn counter), no wall-time, and no randomness. New information arrives from a scripted `tape` of per-turn world deltas, so the whole multi-turn trace reproduces byte-for-byte — read it for the shape of the wiring, not as a production scheduler.

## Algorithm

```
step(deliberation d, world w):
  d.turn += 1
  if rootGoal invalidated in w: d.confidence = low
  if d.confidence < floor: return d as ABANDONED
  node = first pending subgoal whose deps are all done
  if no node:
    return d as SUCCEEDED (all done) or FAILED (stuck)
  if node.risk > riskCeiling:
    return d as ESCALATED                    # pause for human, no side effect
  if node.assumes and not w[node.assumes]:   # assumption broke
    enabler = REPAIRS[node.assumes]
    if enabler and not already in plan:
      splice enabler before node; return d   # re-deliberate next turn
    else:
      mark node failed; return d as FAILED
  execute node (apply its effect to w); mark node done
  if all subgoals done: return d as SUCCEEDED

run(d, tape, w):
  for t in 0..maxTurns while d.status == running:
    apply tape[t] to w        # new information arrives this turn
    step(d, w)
```

The order is the point: confidence is checked before readiness, readiness before risk, risk before assumptions, assumptions before execution — so a collapsed goal, an out-of-band step, or a broken precondition each short-circuit *before* anything is dispatched.

## Reference implementation

[`deliberation-loop.ts`](./deliberation-loop.ts) — a standalone, dependency-free `DeliberationEngine`. The plan is a graph of pure-data subgoals, the world is a flat fact map, effects and repairs are pure functions, and new information arrives from a scripted tape. Run it:

```bash
# Node 24+ runs it directly (native TS type-strip):
node deliberation-loop.ts --demo

# or with tsx:
npx tsx deliberation-loop.ts --demo
```

The demo drives one long-horizon intent — *move savings to the hardware wallet and arm recovery* — through four scenarios:

1. **Happy path** — a six-subgoal plan runs to completion across turns; the deliberation buffer carries the intent the whole way and terminates `succeeded`.
2. **Assumption breaks → repair** — the network drops mid-plan, the monitor catches the broken `networkUp` assumption before the transfer, splices an `await_network` enabler, and the plan completes anyway.
3. **Risk escalation** — the transfer's stakes exceed the ceiling; the engine pauses at that subgoal and returns `escalated` with the funds untouched, leaving the high-stakes step for a human.
4. **Abandonment** — new information says the user already moved the funds; confidence collapses and the plan terminates `abandoned` with nothing further executed.

## How this maps to the production system

| Deliberation concept | Production mechanism |
|----------------------|----------------------|
| deliberation buffer | the durable intent carried in the conversation-state kernel ([guide 40](../40-conversation-state-kernel/)) across turns |
| plan graph + `deps` | the tool-dependency DAG ([guide 55](../55-tool-dependency-dag/)) that already orders multi-tool intents |
| per-turn monitor reading the world | the ambient snapshot bus ([guide 47](../47-ambient-snapshot-bus/)) feeding the typed world-model graph ([guide 46](../46-typed-world-model-graph/)) |
| `assumes` re-check + splice repair | the same enabler move as counterfactual simulation ([guide 72](../72-counterfactual-simulation/)), run across turns instead of within a dry run |
| `risk` ceiling | the authority bands ([guide 37](../37-agent-authority-bands/)) and multi-chain spend governor ([guide 18](../18-multichain-spend-governor/)) |
| `escalated` | the batched approval ceremony / passkey floor ([guide 49](../49-batched-approval-ceremony/)) — high-stakes steps pause for a human |
| remembering the outcome | episodic + consolidated memory ([guide 71](../71-memory-consolidation-sleep/)) so a repaired plan teaches the next one |

## Limitations and extensions

- **Greedy, single-frontier execution.** The engine runs one ready subgoal per turn in array order. For genuinely parallel work, run *all* ready subgoals per turn and reconcile their effects — taking care that two branches don't write the same fact.
- **Repairs are library-bound.** `REPAIRS` is a fixed table keyed by fact. For open-ended planning, generate candidate enablers from the tool registry the way [guide 69](../69-self-directed-capability-acquisition/) synthesizes capabilities, and dry-run each on a clone ([guide 72](../72-counterfactual-simulation/)) before splicing.
- **Confidence is a single scalar.** Real abandonment weighs evidence — pair this with the calibrated uncertainty engine ([guide 68](../68-calibrated-uncertainty-engine/)) and the belief state ([guide 75](../75-world-model-belief-state/)) so collapse is driven by accumulated contradiction, not one flag.
- **No cost in the loop.** The planner proves a plan *reachable*, not *affordable*. Compose it with the resource governor ([guide 70](../70-resource-self-governance/)) to budget the whole horizon before committing to its first expensive subgoal.
- **One assumption per subgoal.** A real step rests on several facts. Model `assumes` as a set and let the monitor repair the *first* broken one each turn, re-deliberating until all hold.
