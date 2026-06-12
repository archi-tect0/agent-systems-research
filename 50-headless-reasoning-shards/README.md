# Headless Read-Only Reasoning Shards

## Problem

When an agent faces a hard decision, running a single model pass is fragile: the model can be confidently wrong, and there is no second opinion. A natural improvement is to spawn several reasoning branches in parallel — a proposer, a dissenting reviewer, an independent analyst — and combine their findings. But parallel cognition introduces two new risks:

1. **Authority creep.** If every spawned branch inherits the parent's full tool access, you have multiplied the number of agents that can write the database, send mail, or move funds. A bug or a prompt injection in any one branch becomes a write to the real world.
2. **False consensus.** If you just take the first branch's answer, or average their confidences, you can ship a confident-sounding answer even when the branches actually *disagree* — which is precisely the situation where you should slow down.

This guide implements **headless reasoning shards**: disposable, time-boxed workers restricted to read-only tools, each returning strict JSON with a `confidence` score and `conflict_flags`. A **merge gate** in the parent inspects the set of results and decides whether the parent may emit a confident answer — withholding confidence whenever branches disagree, without ever widening the write surface.

## Design decisions

**Why restrict shards to read-only tools?**
The whole point of fanning out is to gain more analysis cheaply, not to multiply write authority. Shards may read the web, recall memory, and inspect code, but they cannot send, sign, transfer, delete, or persist. The parent agent remains the *sole* authority for any side-effecting action. A shard's only output is JSON the parent reads — so even a fully compromised shard can at worst produce a bad opinion, never a bad write. The implementation enforces this twice: a whitelist of read-only tool names, plus a regex guard (`assertReadOnly`) that rejects any tool name matching write-ish verbs, as a defence against an accidentally over-broad whitelist.

**Why time-box every shard?**
A branch that hangs — a slow model, a stuck tool call — must not stall the whole decision. Each shard races its reasoner against a per-shard TTL using `Promise.race` against a `setTimeout`. A shard that misses its deadline is simply marked `timeout` and discarded; the merge gate proceeds with whoever finished. This bounds worst-case latency to the longest TTL, regardless of how badly one branch misbehaves.

**Why require strict JSON with `confidence` and `conflict_flags`?**
The merge gate has to reason about agreement without understanding the domain. A uniform contract makes that possible: `confidence` lets the gate drop speculative results below a floor; `conflict_flags` lets a shard explicitly report "this contradicts the task premise" in a machine-readable way. Free-form prose cannot be merged mechanically; a fixed schema can. Results that fail validation are treated like failures (`schema_violation`) and discarded rather than guessed at.

**Why detect disagreement instead of voting?**
Majority voting hides minority dissent — but in safety-critical reasoning the dissent is often the signal. The merge gate computes pairwise similarity between the substantive answers; if any pair falls below an agreement threshold, the branches *disagree* and the gate withholds a confident answer entirely. It returns `confident: false` with a reason, so the parent can escalate, gather more evidence, or ask the user — rather than picking a side it cannot justify. A dedicated `dissent_reviewer` role can also force caution directly by raising a `conflict_flag` or recommending a block.

**Why a pluggable reasoner function instead of a hardwired model call?**
The shard machinery — time-boxing, validation, the merge gate — is independent of *how* a branch thinks. Injecting the reasoner as a function (`Reasoner`) keeps the file runnable on built-ins (the demo uses a deterministic stub), lets tests drive disagreement and timeouts deterministically, and lets production swap in a real model adapter without touching the merge logic.

**Why is the gate's output a judgement, not an action?**
The merge gate returns `{ confident, answer, reason, conflicts, discarded }` — a recommendation. It deliberately does not act. Keeping the gate side-effect-free preserves the invariant that only the parent's main loop can write, and makes the gate trivially testable.

## Algorithm

```
runShard(spec, reasoner):
  assertReadOnly(spec.readOnlyTools)               // reject write-ish tools
  raw = race(reasoner(role, task, tools), timeout(spec.ttlMs))
  if raw == TIMEOUT:        return { status: "timeout" }
  result = validate(raw)                            // strict JSON contract
  if invalid:               return { status: "schema_violation" }
  return { status: "ok", result }

mergeGate(outcomes, { minConfidence, agreementThreshold }):
  discarded = outcomes where status != "ok"
  usable    = ok results with confidence >= minConfidence
  flags     = all conflict_flags raised by usable results
  if usable empty:          return { confident: false, reason: "no usable result" }

  minSim = min pairwise similarity(answer_i, answer_j) over usable
  disagree = (usable > 1) and (minSim < agreementThreshold)

  if flags nonempty or disagree:
                            return { confident: false, conflicts: flags }
  if dissent_reviewer recommends "block":
                            return { confident: false, reason: "dissent blocks" }
  return { confident: true, answer: proposer.answer }

reasonInParallel(specs, reasoner):
  outcomes = await Promise.all(specs.map(runShard))
  return { outcomes, decision: mergeGate(outcomes) }
```

## Reference implementation

See [`headless-reasoning-shards.ts`](./headless-reasoning-shards.ts) in this directory. No external dependencies — pure built-ins (`Promise` + `setTimeout` for time-boxing). The reasoner is injected, so a real model adapter can replace the demo stub without changing the merge logic.

## Usage

```typescript
import {
  reasonInParallel,
  SHARD_ROLE,
  type Reasoner,
  type ShardSpec,
} from "./headless-reasoning-shards.js";

const reasoner: Reasoner = async (role, task, readOnlyTools) => {
  // Wrap a model call here. It only ever gets read-only tools.
  return callModel(role, task, readOnlyTools); // must return the strict JSON shape
};

const specs: ShardSpec[] = [
  { role: SHARD_ROLE.proposer,         task: { issue }, ttlMs: 4000, readOnlyTools: ["web_search", "recall_memory"] },
  { role: SHARD_ROLE.dissent_reviewer, task: { issue }, ttlMs: 4000, readOnlyTools: ["recall_memory"] },
];

const { outcomes, decision } = await reasonInParallel(specs, reasoner);

if (decision.confident) {
  act(decision.answer);          // parent — the only writer — proceeds
} else {
  escalate(decision.reason, decision.conflicts); // disagreement: don't guess
}
```

## Limitations and extensions

- **Similarity is lexical.** The demo's agreement check is token-overlap (Jaccard), which catches "deploy now" vs "do not deploy" but can be fooled by paraphrase. For production, replace `similarity` with an embedding cosine or a small judge model — the merge gate's structure is unchanged.
- **Timeouts abandon, they do not cancel.** `Promise.race` resolves on the TTL, but the underlying reasoner promise keeps running until it settles. If the reasoner holds expensive resources, pass it an `AbortSignal` and have it cancel real work when the deadline fires.
- **No recursion limit here.** The source system caps shard depth and per-wallet concurrency. If you let shards spawn child shards, add a depth counter and a concurrency cap or a single bad branch can fan out unboundedly.
- **The write boundary is enforced by convention + a name regex.** That stops accidental misuse, not a determined attacker who controls tool registration. In a real deployment, enforce read-only at the tool dispatcher, not only at the whitelist.
- **The gate picks the first proposer when branches agree.** If multiple proposers agree but phrase things differently, you may want to synthesize a merged answer rather than choosing one verbatim. Add a synthesis pass that runs only on the agreement path.
