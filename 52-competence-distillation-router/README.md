# Competence-Gated On-Device Distillation Router


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A hybrid agent runs against two very different models: a large, expensive cloud model and a small, cheap, private on-device model. The naive approaches both fail. Routing everything to the cloud is costly, slow on first token, and leaks every turn off-device. Routing everything local burns trust the first time the small model botches a transaction or a security decision.

The hard part is *when* to trust the local model. Its competence is not uniform — it may handle "what's the weather" perfectly while being hopeless at a multi-step token swap. And competence is not static: as the local model is continuously fine-tuned on the cloud model's outputs, its reliable surface grows over time.

What you want is a router that **routes by demonstrated competence**. It should keep escalating an intent to the cloud until there is concrete evidence the local model has had enough examples to learn it, then hand the easy instances of that intent to the local model while still escalating the hard ones. This automates the local-first transition: each kind of request graduates to on-device handling on its own schedule, driven by accumulated training data rather than a hand-tuned switch.

## Design decisions

**Why count training pairs per intent as the gate?**  
Every turn the cloud model handles is logged as an input→output training pair that the local model later learns from. The pair count for an intent is therefore a direct, observable proxy for "how much has the local model been taught about this kind of request." Gating local routing on a minimum pair count means the local model never receives live traffic for an intent it has not yet had a fair chance to learn. The graduation is per-intent, not global, so common intents go local quickly while rare ones keep escalating.

**Why score with tool entropy, familiarity, and message length?**  
All three are computable instantly with no database round-trip, which matters because routing happens on the critical path of every turn. Fewer selected tools means a simpler, more mechanical turn the small model can mimic. A known-simple intent is more likely to be in-distribution. A short message carries less nuance to misread. They are heuristics, deliberately cheap, and combine into a single 0–1 confidence score compared against a threshold.

**Why an unconditional always-escalate set?**  
Some intents are high-stakes regardless of how many examples exist — spending funds, writing to a vault, responding to a threat, running code. For these the downside of a local mistake dwarfs any latency or cost saving, so they bypass scoring entirely and always go to the cloud. Competence is necessary but not sufficient; consequence matters too.

**Why a baseline score of 0.5 with additive signals?**  
Starting neutral and nudging up or down keeps each signal's contribution legible and bounded, and makes the threshold easy to reason about. A turn with no special signals sits at 0.5 and stays on the cloud under the default 0.75 threshold — local routing must be actively *earned* by positive signals.

## Algorithm

```
recordCloudDecision(intent):                 # called whenever cloud handles a turn
  pairCounts[intent] += 1

route(intent, toolNames, messageLen):
  pairs = pairCounts[intent]

  if pairs < minPairs:                        # Gate 1: not enough demonstrated competence
    return CLOUD ("pair_gate")
  if intent in alwaysEscalate or any tool in alwaysEscalate:
    return CLOUD ("always_escalate")          # Gate 2: high stakes

  score = 0.5
  if intent in simpleIntents:        score += 0.25      # familiarity
  score += toolEntropyBonus(len(toolNames))             # fewer tools ⇒ higher
  score += messageLengthBonus(messageLen)               # shorter ⇒ higher
  score += min(0.10, (pairs - minPairs) / 200)          # more data ⇒ more confident
  clamp score to [0, 1]

  return (score >= confidenceThreshold) ? LOCAL : CLOUD
```

The feedback loop is the point: turns that route to the cloud feed `recordCloudDecision`, which raises the pair count, which eventually lets future instances of that intent pass the gate and (if they score high enough) route locally.

## Reference implementation

See [`competence-distillation-router.ts`](./competence-distillation-router.ts) in this directory.

Pure TypeScript on Node built-ins — no external dependencies. The training-pair store is an in-memory `Map<intent, count>`; production persists it to a `training_pairs` table and reloads counts at boot.

## Usage

```typescript
import { CompetenceRouter, DEFAULT_CONFIG } from "./competence-distillation-router.js";

const router = new CompetenceRouter({ ...DEFAULT_CONFIG, minPairs: 50 });

const decision = router.route("weather", ["get_weather"], /* messageLen */ 30);
if (decision.routeLocal) {
  // run the on-device model
} else {
  // run the cloud model, then log the pair so the intent can graduate
  router.recordCloudDecision("weather");
}
console.log(decision.reason);
```

## Limitations and extensions

- **Pair count is a proxy, not a guarantee.** Many pairs do not prove the local model actually learned the intent — only that it had the opportunity. Pair with an offline eval that measures local-vs-cloud agreement per intent and feed that into the score.
- **Heuristic signals are coarse.** Tool count and message length approximate difficulty; they can misjudge a short but tricky request. A learned difficulty classifier could replace the hand-tuned bonuses.
- **No shadow-mode validation.** A safer rollout runs the local model in parallel with the cloud on graduated intents, compares outputs, and only flips to local-only once agreement is high. The decision object exposes everything needed to drive that.
- **Cold start.** Every intent begins on the cloud. Seeding pair counts from a pre-trained baseline lets common intents start closer to graduation.
- **Threshold tuning is global.** A single `confidenceThreshold` may be too strict for trivial intents and too loose for borderline ones; per-intent thresholds are a natural extension.
