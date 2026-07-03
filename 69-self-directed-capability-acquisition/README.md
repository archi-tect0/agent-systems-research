# Self-Directed Capability Acquisition


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*The agent notices a capability it does not have, drafts the tool on a throwaway branch, proves it against generated cases, and registers it inert until a human approves it and assigns an authority band.*

Self-repair ([guide 66](../66-metacognitive-self-repair/)) fixes a capability the agent *already has* and that broke. This is the other half of self-maintenance: growing a capability the agent *lacks*. It is the natural successor to the repair loop — same governance wall, opposite direction: repair restores, acquisition extends.

"Let the agent write its own tools" is, stated plainly, an account-compromise primitive wearing a helpful hat. The entire value of this guide is the **wall** around that ability, and the wall is the same one self-repair uses: a gap that must be earned, synthesis on a clone, verification before anything lands, and a human merge that assigns the new tool its privilege level.

## Problem

A capable long-running agent will repeatedly hit intents it cannot satisfy — the same little gap, over and over ("what percent is X of Y", "count the words in this"). Two naive responses are both wrong:

- **Never grow.** The agent stays brittle, forever apologizing for the same missing micro-capability while the user works around it.
- **Grow without a wall.** The agent writes and immediately runs its own new tool on the live system. One bad synthesis and there is now a live, unreviewed, unbounded capability nobody approved — exactly the elevation-of-privilege failure the whole architecture exists to prevent.

What you want sits between them: the agent **can** acquire a new capability, but only when the gap is real (recurring), only after **proving** the new tool works, and only as a **proposal** that a human turns on and assigns a privilege level to. Until then the dispatcher refuses to call it.

## Design decisions

**A capability gap is earned by recurrence, not asserted once.** A single unmet intent is noise — a one-off request that should never become permanent surface area. The `GapDetector` requires the *same* intent to recur a threshold number of times before acquisition is even attempted. This keeps the tool registry from ballooning with one-shot tools and ensures the agent only spends effort on capabilities the user actually keeps needing.

**Synthesis happens on a clone of the registry — the branch.** Exactly as guide 66 applies code fixes to a throwaway `agent/*` branch, acquisition writes the candidate tool to a `clone()` of the capability registry, never the live one. A candidate that fails verification is discarded by simply throwing the clone away — a genuine rollback, because the live registry was never mutated. The worst case of a bad synthesis is a discarded branch, not a live tool.

**The tool must pass generated tests before it can be proposed.** A capability that "exists" is worthless; a capability that *provably does the thing* is the bar. The agent generates test cases from the intent and the candidate must pass **all** of them. The demo deliberately includes a buggy candidate (returns a fraction instead of a percent) that fails its own suite and is discarded before a correct candidate lands — proving verification is load-bearing, not decorative.

**A passing tool is `proposed`, never `active`.** This is the governance hinge. Synthesis + verification are autonomous; *activation* is not. A newly acquired tool enters the live registry with status `proposed`, and the dispatcher refuses to invoke anything that is not `active`. A human approves it, and **at approval time assigns an authority band** ([guide 37](../37-agent-authority-bands/)) — the agent never gets to decide its own new tool's privilege level. No passkey ceremony (the branch wall plus human merge is the safety net, matching guide 66's reasoning), but a deliberate human act is mandatory.

**Acquired and rejected skills are remembered.** Once a tool is acquired, the same intent returns a no-op `already_have` instead of re-deriving it; a rejected attempt is recorded so the agent does not re-propose the same failing capability on a loop. This is the acquisition analogue of guide 66's repair memory — the difference between an agent that learns its own skill set and one that rediscovers the same gap forever.

## Algorithm

```
observeMiss(intent, example):
  toolName = nameFor(intent)
  if registry.has(toolName) active: return ALREADY_HAVE      # remembered skill

  if not gapDetector.observe(intent) >= threshold:           # gap must be earned
    return NOT_YET(seen)

  return acquire(intent)

acquire(intent):
  branch = registry.clone()                                  # synthesis sandbox
  for candidate in synthesize(intent):                       # codegen / library
    branch.add({ name, impl: candidate, status: proposed })
    if branch passes ALL generated test cases for intent:
      registry.add(sameTool)         # lands in LIVE registry, still 'proposed'
      remember(name = proposed)
      return PROPOSED(name)
    # else discard candidate (clone is thrown away -> rollback)
  remember(name = rejected)
  return VERIFICATION_FAILED

# governance landing — autonomous up to here; a human does this:
approve(name, band):  require status==proposed; status=active; assignBand(band)
invoke(name, args):   refuse unless status==active             # the dispatcher wall
```

## Reference implementation

[`capability-acquisition.ts`](./capability-acquisition.ts) — a standalone, dependency-free model: a `CapabilityRegistry` (with a `clone()` that is the branch), a `GapDetector`, and a `CapabilityAcquirer` that ties detect → synthesize → verify → propose together. "Synthesis" draws from a tiny library of candidate implementations (including a deliberately buggy one) so the demo stays runnable and the *control flow* — the wall — is what you read, not a toy LLM. Run it:

```bash
# Node 24+ runs it directly (native TS type-strip):
node capability-acquisition.ts --demo

# or with tsx:
npx tsx capability-acquisition.ts --demo
```

The demo exercises five scenarios:

1. **A gap must be earned** — the first two misses of `math.percent` return `NOT_YET`; one-off intents never become tools.
2. **Threshold → synthesize, buggy candidate caught** — on the third miss, a wrong implementation fails verification and is discarded on the branch; the correct one passes all three cases and is `proposed`.
3. **Proposed ≠ callable** — the dispatcher refuses to invoke the proposed tool; after a human approves it and assigns band 1, the call succeeds.
4. **Verification-failure path** — an intent whose only candidate is buggy ends in `VERIFICATION_FAILED` with nothing added to the live registry.
5. **Skill memory** — re-asking for an acquired capability returns `already_have`, not a re-synthesis.

## How this maps to the production system

| Acquisition step | Production mechanism |
|------------------|----------------------|
| gap detection by recurrence | unmet-intent telemetry (the same signal that feeds [guide 09](../09-intent-based-tool-selection/)'s intent drawers and correction memory) |
| synthesis on a clone | `git_branch` (`^agent/[a-z0-9._-]+$` only) + `write_file` on a throwaway branch, exactly as in [guide 66](../66-metacognitive-self-repair/) |
| generated verification | `run_tests` / `exec pnpm typecheck` against the branch before any proposal |
| `proposed` status + dispatcher refusal | the tool registry's lifecycle state; the dispatcher only exposes `active` tools |
| human approval + band assignment | the one-tap merge card ([guide 49](../49-batched-approval-ceremony/)) plus authority-band assignment ([guide 37](../37-agent-authority-bands/)) |
| write capability needs a grant | a new write tool also needs an `agent_capability_grants` row and an Extensions-page entry before it can act |
| skill memory | the fact/correction store — acquired and rejected capabilities persist across restarts |

## Limitations and extensions

- **Synthesis is a library pick, not real codegen.** The demo chooses from prewritten candidates so it stays runnable and deterministic. In production the candidate comes from an LLM that reads the intent; the wall (branch, verify-all, propose-not-activate) is unchanged regardless of where the code came from.
- **Verification is only as good as the generated cases.** A tool can pass weak tests and still be wrong. Invest in adversarial and property-based case generation, and treat a thin suite as a reason to keep the tool `proposed` longer, not to lower the bar.
- **No static analysis of the synthesized code.** Before proposing, a real system should lint the candidate, forbid disallowed imports/syscalls, and bound its resource use — a tool that passes its tests can still be unsafe in ways tests do not cover.
- **One implementation per tool.** This acquires a single capability. Extend the candidate loop to keep the *best* passing implementation (fastest, fewest dependencies) rather than the first, the way a richer repair registry would rank remedies.
- **Activation is the only gate modeled.** Pair acquisition with the spend governor and passkey floor so an acquired tool that touches funds or state inherits those controls automatically at approval time — acquiring a capability must never be a way to route around the floors that govern using one.
- **No deprecation path.** Capabilities should also be *removed* when they stop being used. Add usage decay so an acquired tool that goes cold is proposed for archival, keeping the surface area honest over time.
