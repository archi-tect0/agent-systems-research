# Counterfactual Simulation


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*Dry-running a multi-step, partly-irreversible plan against a clone of the world model — proving it safe, catching its first failure, exposing strand risk, and repairing it — all before touching anything real.*

The metacognitive self-repair guide ([guide 66](../66-metacognitive-self-repair/)) and the capability-acquisition guide ([guide 69](../69-self-directed-capability-acquisition/)) share one safety move: act on a *clone*, never the live thing. This guide points that move forward in time. Instead of repairing a fault after it happens, the agent *predicts* the fault by simulating its plan on a copy of the world — and avoids the fault entirely.

This is the sixth guide in the Layer-2 set (the agent operating on *itself*). It is the planning-time counterpart to the run-time safety the rest of the set provides: think before you touch the irreversible.

## Problem

An agent about to run a multi-step plan with a real, irreversible side-effect (send funds, then confirm) has no safe way to ask "what happens if I run this?" without running it. That leaves three gaps:

1. **Invalid plans discovered the expensive way.** A plan that fails its precondition at step 3 should be caught *before* steps 1 and 2 commit real side-effects — not after.
2. **Strand risk is invisible.** The dangerous case for an irreversible action is not "it fails cleanly" but "it half-succeeds" — the funds leave the wallet and *then* the network drops before confirmation. A plan that looks fine on the happy path can strand the user on the failure branch, and nothing surfaces that until it happens for real.
3. **No path from "infeasible" to "feasible".** When a plan fails because setup is missing (no passkey, recipient not whitelisted), the agent should be able to *discover and order* the missing steps, not just report a wall.

This guide builds a simulator that runs a plan against a `structuredClone` of the world, checks preconditions and applies effects on the copy, explores the failure branch of irreversible steps, and repairs an incomplete plan by splicing in enablers.

## Design decisions

**Everything runs on a `structuredClone`; the real world is never touched.** `simulate` clones the world once and mutates only the copy. This is the load-bearing invariant: the worst case of simulating even a catastrophic plan is a discarded object. The demo proves it by asserting the original world is byte-for-byte unchanged after a full send-and-confirm simulation.

**Actions carry their own preconditions and effects as pure functions.** An `Action` is `{ pre(w) → {ok, reason}, effect(w) → w' }`. Keeping preconditions and effects *with* the action (rather than in a central interpreter) means the same action definitions drive simulation, repair, and — in production — real execution, so the simulated semantics cannot drift from the executed ones.

**A plan stops at its first unmet precondition.** Simulation walks the plan in order and halts at the first `pre` that returns `ok: false`, recording the step, the action, and the reason. The first failure is the actionable one; everything after it is contingent on a state that will never be reached, so reporting later "failures" would be noise.

**Irreversible steps get a counterfactual failure branch.** Reversible actions are simulated only on the happy path — if they fail, you retry. Irreversible actions additionally declare a `failureEffect`: the world if the action *half-succeeds* (broadcast lands, confirmation never returns). The simulator forks the clone, applies `failureEffect`, and flags `stranded` when value left the wallet with zero confirmations. This is the whole point of simulating before an irreversible act — it surfaces the loss-without-recourse case that the happy path hides.

**Repair makes *progress*, not one-shot fixes.** `repairPlan` re-simulates, and when it finds an unmet precondition it consults a library of `ENABLER` actions keyed by the world predicate each one establishes. The acceptance test for an enabler is deliberately loose: insert it if it makes the failing precondition pass **or** flips it to a *different* unmet precondition. That looseness is what lets a chain assemble itself — installing the app doesn't enable the send directly, but it enables passkey enrollment, which enables whitelisting, which enables the send. Requiring each enabler to fully fix the action in one step would never discover the chain.

**Enablers respect their own preconditions, so the repaired plan is correctly ordered.** Each enabler is itself an `Action` with a `pre`. Because repair inserts an enabler before the failing step and then re-simulates from the top, an enabler whose own precondition is unmet simply becomes the *next* failure to repair — which splices *its* enabler in ahead of it. The result is a topologically correct sequence (install → enroll → whitelist → send → confirm) discovered without any explicit dependency declaration.

## Algorithm

```
simulate(world, plan):
  sandbox = structuredClone(world)           # real state never touched
  for i, action in plan:
    check = action.pre(sandbox)
    record(check)
    if not check.ok:
      firstFailure = { step: i, reason: check.reason }
      break                                   # stop at first unmet precondition
    if action.irreversible and action.failureEffect:
      fork = action.failureEffect(clone(sandbox))      # counterfactual branch
      stranded = fork.sent > sandbox.sent and fork.confirmations == 0
      record riskBranch(stranded)
    sandbox = action.effect(sandbox)
  return { feasible: no firstFailure, trace, firstFailure, terminal: sandbox, riskBranch }

repairPlan(world, plan):
  loop up to maxInserts:
    result = simulate(world, plan)
    if result.feasible: return plan
    failed = plan[result.firstFailure.step]
    enabler = findEnabler(world, plan, failed)         # fixes OR makes progress
    if no enabler: return plan                         # unrepairable
    plan = insert enabler before the failing step

findEnabler(world, plan, failed):
  replay plan up to the failure -> state
  base = failed.pre(state)
  for enabler not already in plan:
    after = failed.pre(enabler.effect(clone(state)))
    if after.ok or after.reason != base.reason: return enabler   # progress
```

## Reference implementation

[`counterfactual-simulation.ts`](./counterfactual-simulation.ts) — a standalone, dependency-free `CounterfactualSimulator`. The world is a plain object (so `structuredClone` is a perfect, cheap copy), actions are pure-function records, and an `ENABLERS` library keys setup actions by the predicate they establish. Run it:

```bash
# Node 24+ runs it directly (native TS type-strip):
node counterfactual-simulation.ts --demo

# or with tsx:
npx tsx counterfactual-simulation.ts --demo
```

The demo models a wallet send (`send_eth`, irreversible) followed by a confirmation, and exercises four scenarios:

1. **Feasible plan** — a fully set-up world simulates end to end; the terminal state is shown and the *real* world is proven unchanged (clone proof).
2. **Infeasible plan** — a missing passkey is surfaced as the first unmet precondition, with nothing sent for real.
3. **Counterfactual failure branch** — the irreversible send's `failureEffect` shows funds leaving with zero confirmations → `stranded = true`, so the agent can require a confirmation-gated send before acting.
4. **Plan repair** — starting from an empty world, the simulator discovers and orders the three missing setup steps (install → enroll passkey → whitelist) and re-simulates to a feasible plan — all on clones.

## How this maps to the production system

| Simulation concept | Production mechanism |
|--------------------|----------------------|
| `World` object | a projection of the typed world-model graph ([guide 46](../46-typed-world-model-graph/)) into a cloneable snapshot |
| `Action.pre` | the server-side guards a tool already enforces (passkey floor, whitelist, balance, network) |
| `Action.effect` | the tool's real side-effect — the *same* definition, so simulation can't diverge from execution |
| `structuredClone` sandbox | dry-running a plan without issuing real wallet/vault/marketplace writes |
| `firstFailure` | the precondition error the agent would otherwise hit at run time, surfaced at plan time |
| irreversible `failureEffect` + `stranded` | the "funds sent, never confirmed" risk that gates a transfer behind a confirmation/undo step |
| `ENABLERS` + `repairPlan` | the agent proposing the missing setup steps (install, enroll, whitelist) in the right order |
| reversible vs. irreversible | the passkey floor and one-tap-undo boundaries from the architectural constants |

## Limitations and extensions

- **The world model is only as good as its projection.** Simulation is sound only over facts the `World` actually captures. A side-effect the model omits (gas price spikes, a downstream webhook) is invisible to the dry run. Keep the projection honest and narrow rather than broad and wrong.
- **One failure branch per irreversible step.** Real irreversibility has many failure modes (reverted tx, partial fill, reorg). Model `failureEffect` as a *set* of branches and flag the plan if *any* strands the user.
- **Repair is greedy and library-bound.** `repairPlan` only knows the enablers in `ENABLERS`. For open-ended planning, generate candidate enablers from the tool registry (the way [guide 69](../69-self-directed-capability-acquisition/) synthesizes capabilities) instead of a fixed table.
- **No cost in the loop.** Simulation proves a plan *feasible*, not *affordable*. Compose it with the resource governor ([guide 70](../70-resource-self-governance/)) to budget the whole simulated plan before committing to its first expensive step.
- **Deterministic effects only.** Effects here are pure and certain. For probabilistic outcomes, run the simulation as a rollout (sample `effect` vs. `failureEffect` by likelihood) and report the distribution of terminal states, not a single trace.
