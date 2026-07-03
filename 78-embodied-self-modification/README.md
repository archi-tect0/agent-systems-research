# Embodied Self-Modification


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*The top of the cognitive stack — the agent acts on the world through effectors, learns online from what comes back, and rewrites its own policy under guardrails strict enough that it can never quietly weaken itself: every self-rewrite is verified on a clone, and a frozen constitution it may never touch.*

Every layer below this one made the agent *think* better — reason about itself ([the Layer-2 set](../66-metacognitive-self-repair/)), across time, space, and a society of other agents ([the Layer-3 set](../74-multi-turn-deliberation/)), and as many faculties at once ([Layer-4](../77-polyphonic-cognition/)). None of them let the agent change what it *is*. This guide closes the loop: the agent has a body it acts through and senses results from, it learns the world from those results, and it edits its own policy on the basis of what it learns.

This is the first guide in the Layer-5 set — the agent operating *on the world, and on itself*. It is the highest-leverage and the most dangerous capability in the whole set, because an agent that can rewrite itself can rewrite itself *wrongly* — or maliciously, if compromised. So the entire guide is really about the guardrails: a self-modification is a proposal, not a fait accompli; it is verified on a clone before it lands; and a frozen constitution (the passkey floor, the agent's own authority, key export) is refused outright and never even simulated. The body learns new habits; it never votes itself more power.

## Problem

An agent that can act and learn but has no disciplined way to change itself fails in four ways:

1. **It can act but never improve.** Without an online learning loop, the agent makes the same mediocre choice in a recurring situation forever. Experience washes over it and leaves no trace; the thousandth time it does a task is no better than the first.
2. **It can learn but never consolidate.** Competence that lives only as scattered statistics is slow to use and easy to lose. The agent needs a way to *compile* a hard-won lesson — "in this situation, this is the move" — into a fast, durable rule, which means editing its own policy.
3. **Self-modification with no proof is how an agent breaks itself.** An agent that rewrites its policy live, on a hunch, can regress catastrophically and have no way back. A self-edit must be tried somewhere safe and proven not to make things worse *before* it becomes real.
4. **Self-modification with no limit is how an agent escapes its constraints.** If "change yourself" includes "raise your own authority", "lower the passkey floor", or "allow key export", then self-improvement is indistinguishable from privilege escalation. Some parameters must be outside the agent's own reach, by construction.

This guide builds the perceive → act → learn → rewrite loop: an embodiment (effectors that act, sensors that observe reward), an online competence estimator, a self-modification mechanism that compiles learned habits into policy, a clone-and-verify gate that commits a rewrite only if it does not regress on the agent's own observed experience, and a frozen constitution the agent cannot self-modify at all.

## Design decisions

**The agent learns the world from rewards, not from labels.** It is never told which skill is right for a context; it tries one, observes the reward its effector earns, and folds that into a per-(context, skill) competence with an exponential-moving-average update. Optimistic initialization (every skill starts maximally competent) makes the agent try each option once, in a deterministic order, before settling — exploration without randomness. This is the online counterpart to the competence-distillation router ([guide 52](../52-competence-distillation-router/)) and the calibration map of the uncertainty engine ([guide 68](../68-calibrated-uncertainty-engine/)).

**Embodiment is effectors and sensors, not a chat reply.** An "act" applies a skill through an effector and the world returns a reward the agent senses. Modeling the agent as a thing that *does* and *perceives* — rather than one that only emits text — is what makes the loop a control loop. In production the effectors are the summon surfaces (mic, camera, controller, AR) and the nav/act cards; the sensor is the outcome the world reports back.

**Compiling a habit is itself a self-modification.** Once competence is clear, the agent promotes each context's learned-best skill into a `fastPath` rule — a direct, no-deliberation move. This is the agent editing its own policy structure, the same move as baking stable facts into prefix-cacheable weights ([guide 30](../30-lora-prefix-weight-compiler/)) or selecting an expert adapter by intent ([guide 53](../53-lora-manifest-router/)), but driven by the agent's own experience.

**Every self-rewrite is applied to a clone, verified, and committed only if it does not regress.** A proposed modification is never applied to the live policy first. It is applied to a `structuredClone`, scored against a *probe set* drawn from the agent's own observed outcomes (not from the world's hidden truth — the agent verifies against its own experience), and committed only if probe accuracy holds or improves. On rejection the clone is discarded and the live policy is proven byte-for-byte unchanged. This is exactly the throwaway-branch-then-verify discipline of metacognitive self-repair ([guide 66](../66-metacognitive-self-repair/)) and the prove-before-register discipline of capability acquisition ([guide 69](../69-self-directed-capability-acquisition/)).

**The constitution is frozen and refused without simulation.** A fixed set of parameters — the agent's authority band, the passkey floor, key export — may never be self-modified. A proposal to touch one is refused *before* any clone is made; it is not even dry-run. The agent can rewrite *how it acts*, never *what it is allowed to do*. This is the architectural keys-never-leave-the-device and passkey-floor constants made self-enforcing, and it is the single line that separates self-improvement from self-escalation.

**Deterministic by construction.** A fixed context schedule, optimistic-greedy choice with no exploration randomness, an EMA learning rule, and a logical clock — the same run always produces the same competence, the same compiled habits, and the same accept/reject decisions. Read it for the mechanism, not as a production learner.

## Algorithm

```
episode(ctx):                                  # perceive → act → learn
  skill  = fastPath[ctx] ?? argmax(competence[ctx])    # a habit wins, else greedy
  reward = world.step(ctx, skill)              # act through an effector, sense result
  competence[ctx][skill] += LR * (reward - competence[ctx][skill])   # learn online
  observed[ctx][skill] = max(observed[ctx][skill], reward)           # remember ground truth

proposeSelfMod(mod):                           # rewrite, under guardrails
  if mod targets a FROZEN field:               # constitution: refuse, never simulate
    return REFUSED

  before = probeAccuracy(live policy)          # probes = contexts with an observed reward-1 skill
  clone  = structuredClone(live policy)        # a throwaway branch
  apply(mod, clone)
  after  = probeAccuracy(clone)                # verify against own experience

  if after >= before: live policy = clone; return COMMITTED   # land it
  else:               discard clone;          return REJECTED  # live policy untouched

probeAccuracy(p):
  probes = contexts where observed[c] has a reward-1 skill
  return fraction of probes where (p.fastPath[c] ?? argmax(p.competence[c])) == observedBest(c)
```

## Reference implementation

[`embodied-self-modification.ts`](./embodied-self-modification.ts) — a standalone, dependency-free `EmbodiedAgent` coupled to a toy deterministic `World`. Competence is learned by EMA, habits are compiled into a fast-path table, and every self-modification goes through a `structuredClone` + probe-verify gate. Run it:

```bash
# Node 24+ runs it directly (native TS type-strip):
node embodied-self-modification.ts --demo

# or with tsx:
npx tsx embodied-self-modification.ts --demo
```

The demo runs one agent through the full loop in four scenarios:

1. **Embodied online learning** — over a fixed schedule of episodes the agent tries skills, observes rewards, and its true accuracy rises pass over pass to a perfect 1.00 as it learns the right skill per context — with no labels, purely from reward.
2. **Self-modification: compile habits** — the agent proposes promoting its learned-best skill per context into fast-path rules; the change is applied to a clone, verified not to regress on its observed experience, and committed. Its policy now carries direct rules it wrote itself.
3. **A regressive self-mod is rejected** — the agent proposes a wrong rule (use `s1` for context `B`); the clone verification regresses on the probe set, so the change is rejected and the live policy is proven byte-identical — the bad branch is thrown away.
4. **Constitutional refusal** — proposals to modify the agent's authority band, the passkey floor, or key export are each refused outright, without simulation. The agent can change how it acts; it cannot touch what it is allowed to do.

## How this maps to the production system

| Self-modification concept | Production mechanism |
|---------------------------|----------------------|
| effectors + sensors (embodiment) | the summon surfaces (mic / camera / controller / AR) and the nav / act / confirm cards |
| online competence update | the competence-distillation router ([guide 52](../52-competence-distillation-router/)) + the uncertainty engine's calibration map ([guide 68](../68-calibrated-uncertainty-engine/)) |
| compile a habit into a fast-path rule | the LoRA / prefix-weight compiler ([guide 30](../30-lora-prefix-weight-compiler/)) and the manifest LoRA router ([guide 53](../53-lora-manifest-router/)) |
| rewrite on a clone, verify, commit | the throwaway-branch + re-probe of metacognitive self-repair ([guide 66](../66-metacognitive-self-repair/)) |
| propose a change, prove it before it is real | self-directed capability acquisition's inert-until-approved registration ([guide 69](../69-self-directed-capability-acquisition/)) |
| probe set from observed outcomes | reflective memory ([guide 07](../07-reflective-memory/)) and memory consolidation ([guide 71](../71-memory-consolidation-sleep/)) |
| frozen constitution, refused without simulation | the architectural constants, authority bands ([guide 37](../37-agent-authority-bands/)), and the SIWE + passkey floor ([guide 20](../20-siwe-passkey-floor/)) |

## Limitations and extensions

- **The world is a toy, and deterministic.** A single best skill per context with a clean reward is the simplest case. Real environments are noisy, non-stationary, and partially observable; replace the EMA with a proper contextual bandit or RL update, and the greedy choice with an explicit exploration policy that still bounds risk.
- **Verification is only as honest as the probe set.** The agent verifies a self-edit against its own observed outcomes, so a self-edit can look safe while overfitting to a biased sample of experience. Hold out probes the edit was *not* derived from, and compose with the uncertainty engine ([guide 68](../68-calibrated-uncertainty-engine/)) to mark a low-evidence rewrite low-trust rather than committing it confidently.
- **A human is still the right gate for a durable rewrite.** The clone-verify gate here is autonomous because the changes are reversible and sandboxed. A self-modification that would persist across restarts or widen the agent's effective reach should land behind the same one-tap human merge as self-repair ([guide 66](../66-metacognitive-self-repair/)) and capability acquisition ([guide 69](../69-self-directed-capability-acquisition/)), not on the agent's say-so.
- **The frozen set is a static list.** `FROZEN` is a hard-coded set of field names. A real constitution is structured and signed (see the will/constitution engine, [guide 38](../38-will-constitution-engine/)) so the boundary itself is tamper-evident and cannot be edited by the same code path that proposes policy changes.
- **No rollback history.** A committed self-modification overwrites the previous policy. Keep a versioned, content-addressed history of policies so a rewrite that later proves harmful in the wild — not just on the probe set — can be reverted, the way deterministic action receipts ([guide 51](../51-deterministic-action-receipts/)) make past actions auditable.
