# Metacognitive Self-Repair Loop


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*Introspect → diagnose → request the right model → fix on a branch → verify → human-gated merge — with a memory of what already worked.*

The point where an agent stops being a chatbot and starts being an operator is the moment it can answer **"what is wrong with me right now?"** — and then do something about it without being able to quietly break itself. This is the first guide in the set that describes how an agent **maintains itself**: it reasons about its own operational state, repairs a fault, remembers the repair, and restores functionality, with the entire write surface walled behind a throwaway branch and a one-tap human approval.

This is the metacognition layer. Not "the agent edits code," but **the agent observes its own behaviour, forms a hypothesis about a malfunction, applies a remedy in isolation, proves the remedy worked, records it for next time, and only then asks a human to land it.**

## The ten facets of "an agent that maintains itself"

Self-maintenance is not one trick; it is ten capabilities that have to interlock. This guide names them explicitly and the reference implementation demonstrates each:

1. **Metacognitive loop** — the single cycle that ties the rest together (`run()`).
2. **Operational introspection** — always-on, read-only probes over live state (model health, tool error rates, build status).
3. **Self-diagnosis** — turning failing signals into one hypothesis with evidence and a confidence number.
4. **Self-repair** — applying a remedy: switch model, repoint endpoint, fix code.
5. **Subsystem health model** — an explicit model of the parts that can fail (model / tools / build), so a fault localises to a subsystem.
6. **Model-selection for repairs** — "request a different model" is a first-class remedy, not a special case.
7. **Governance-gated healing** — the branch wall + grant tiers + a human merge; diagnosis is autonomous, landing is not.
8. **Memory-driven adaptation** — recall a known-good remedy on a recurring fault instead of re-deriving it.
9. **Temporal awareness** — cooldowns and recency: a fault re-fixed seconds ago is *flapping* and escalates instead of looping.
10. **Behavioral metacognition** — recognising a mistake the agent itself made mid-conversation and recording a correction, healing behaviour rather than infrastructure.

## Problem

A long-running agent degrades in ways the user notices before the agent does:

- the active model starts returning empty replies after a provider hiccup;
- a tool keeps calling an endpoint the service moved last week;
- a self-authored change stopped the workspace from typechecking;
- latency creeps up and turns feel sluggish;
- the agent itself used the wrong argument on a tool two turns ago and only now realises it.

The naive responses are both wrong. **Silent fallback** ("just swap the model and say nothing") hides a real fault and erodes trust — the user has no idea anything happened, and a transient blip triggers a permanent change. **Unrestricted self-edit** ("let the agent rewrite whatever it wants on the live tree") is an account-compromise primitive wearing a helpful hat: one bad diagnosis and the agent breaks `main` for everyone, irreversibly, with no human in the loop.

What you actually want sits between them, and it is the ten facets working together:

1. The agent **knows** when it is malfunctioning (introspection — facet 2 — always-on, read-only).
2. It can **localise** the fault to a subsystem and **explain** it concretely (facets 3 + 5: a diagnosis with evidence and a confidence number, not a vibe).
3. It can **request the correct resource** — a different model, a fixed endpoint, a code change (facets 4 + 6).
4. It can **apply the fix in a sandbox** that cannot touch production until approved (facet 7).
5. It **proves** the fix worked by re-running the exact check that failed (facet 4, verification).
6. It **remembers** what worked and when, so a recurrence is handled faster and a fix that does not hold is escalated, not retried forever (facets 8 + 9).
7. It can **correct its own behaviour** when the fault is a mistake it made, not a broken system (facet 10).
8. A **human lands** the code change with one tap (facet 7).

## Design decisions

**Probes are read-only and always-on; writes are gated and branch-only.** (Facets 2, 7.) The introspection surface (model health, tool error rates, typecheck status) requires only a read grant and never mutates anything. The repair surface — open a branch, write a file, run a command, commit — requires a separate write grant *and* is structurally incapable of touching `main`. In the real system this is the `engineering_read` vs `engineering_write` split; here it is `PROBES` (pure functions) vs `REMEDIATIONS` (which only ever mutate a clone).

**The world is modelled as named subsystems.** (Facet 5.) `Workspace` is not an opaque blob — it is `{ model, tools, build }`. A fault therefore localises: a failing `typecheck` probe is a `build` fault, a 404-ing tool is a `tools` fault. This is what lets diagnosis produce a stable *signature* (`tool:endpoint`, `model:replies`, `build:typecheck`) that memory and cooldowns key on. This minimal three-field model is enough for the loop; the richer, typed dependency graph it generalises to — with failure localisation *through* healthy-looking intermediates and blast-radius queries — is its own guide ([guide 67, Agent Self-Model Graph](../67-agent-self-model-graph/)). Read 67 for the formal self-model schema; this loop is what *acts on* it.

**The branch is the sandbox.** (Facet 7.) Every code fix is applied to a structural clone of the workspace on a `agent/*` branch. If the fix fails verification, the clone is discarded — a genuine rollback, because the live workspace was never touched. This is the load-bearing safety property: the worst case of a wrong diagnosis is a discarded branch, not a broken production tree. Opening a branch whose name is not under the `agent/` prefix throws — there is no code path that writes to `main` directly.

**Diagnosis carries a confidence number, and there is a floor.** (Facet 3.) A fault hypothesis is `{ kind, confidence, evidence, signature }`. Below `CONFIDENCE_FLOOR` (0.55 here) the loop **reports and stops** rather than acting — a single elevated-latency reading is plausibly a network blip, and thrashing the model chain on a blip is worse than waiting. Strong, deterministic faults (a broken typecheck) score high because their fix has a deterministic proof; weak, ambiguous faults score low on purpose. The single hard floor here is the minimal version; making that number *calibrated* (anchored to the agent's measured hit rate) and the floor *risk-scaled* is [guide 68, Calibrated Uncertainty Engine](../68-calibrated-uncertainty-engine/) — drop its `decide()` in where this loop compares `confidence` to `CONFIDENCE_FLOOR` and the report/act split becomes abstain/escalate/act.

**Verification re-runs the probe that failed — the agent never trusts its own success claim.** (Facet 4.) A remediation returns "I changed something," not "I fixed it." The loop then re-runs the *specific* probe that proves the fault is gone (`verifyWith`). A fix that edits a file but does not make the typecheck pass fails verification and is rolled back. This closes the gap between "I did a thing" and "the thing worked."

**"Request the correct model" is a first-class remediation.** (Facet 6.) Detecting that the active backend is degraded and walking to the next entry in the fallback chain is modelled exactly like any other fix: apply on the branch, reset the rolling health counters so the next probe measures the *new* model, verify replies recovered, propose the merge. (The deeper routing mechanics — fast-fail named modes vs. an auto-waterfall cascade, per-backend health probes — are [guide 12, Resilient Multi-Provider LLM Routing](../12-resilient-llm-routing/); this loop is what *decides to invoke* that machinery and proves it helped.)

**Repairs are remembered, and recency changes the decision.** (Facets 8, 9.) Every verified fix is recorded in `RepairMemory` keyed by fault signature, with a timestamp. Two things fall out of that one record:

- *Adaptation* — when the same fault recurs later, the loop recalls that this is a *known recurrence* with a previously-verified remedy, rather than treating it as novel. In this reference the registry holds one remedy per fault kind, so recall *confirms* the plan rather than choosing between variants; its load-bearing job is distinguishing a first occurrence from a recurrence (which is exactly what the flapping guard keys on). In a production registry with several candidate remedies per fault, the same recall would rank the known-good one first — the hook is the same, only the registry is richer.
- *Temporal awareness / flapping guard* — if a fault was verified-fixed within `FLAP_COOLDOWN_MS` and is *already back*, the fix is not holding. Re-applying the same remedy would be a loop; instead the agent **escalates to a human**. Recency is not decoration here — the same fault produces a different decision depending on *when* it last happened.

This is the difference between an agent that learns and one that re-solves the same incident from zero every time — and the safety valve that stops "self-healing" from becoming "self-thrashing."

**Behavioral mistakes heal as memory, not code.** (Facet 10.) Not every fault is infrastructure. Sometimes the agent itself called a tool with the wrong argument or stated a wrong fact, and realises it a turn later. That is *behavioral metacognition*: there is no branch to open and nothing to typecheck — the correct repair is to record a durable correction (`url_fix`, `api_argument_fix`, `factual_fix`, …) so the mistake is not repeated. `selfCorrect()` models this as its own path: recognise → write correction memory → move on. It is deliberately separate from code self-repair because conflating "I broke the build" with "I misremembered an endpoint" leads to opening branches for things a memory write should fix.

**Landing is human-gated, with no passkey.** (Facet 7.) The final step of a code fix is a one-tap merge card, not an automatic `git merge`. The branch wall plus the audit trail are the safety net, so a passkey ceremony would be friction without a matching threat — but a human still has to approve. Diagnosis, the fix, and the memory are autonomous; the change reaching `main` is a deliberate human act.

**Every step is audited under a fixed identity.** Commits are authored by a fixed `Agent (engineering mode)` identity so a self-authored change is never mistaken for a human one, and the full introspect→diagnose→plan→verify→merge trail is recorded. Self-repair you cannot reconstruct after the fact is not self-repair; it is an unlogged actor with write access.

## Algorithm

```
repair(symptom):
  for round in 1..MAX_ROUNDS:
    # 2. INTROSPECT — read-only probes over the subsystem health model
    signals = [probe.run(workspace) for probe in PROBES]
    if all signals ok: return HEALTHY

    # 3. DIAGNOSE — failing signals -> {kind, confidence, evidence, signature}
    fault = diagnose(signals)
    if fault.confidence < CONFIDENCE_FLOOR:
      return REPORTED(fault.evidence)              # explain, do not act

    # 9. TEMPORAL — was this just fixed and it's already back?
    if memory.isFlapping(fault.signature):
      return ESCALATED("flapping — fix not holding")

    # 8. MEMORY — recall a prior verified remedy for this signature
    memo = memory.recall(fault.signature)          # informs the plan

    # 4. SELECT + 7. APPLY ON A BRANCH (never on main)
    remediation = REMEDIATIONS[fault.kind] or return ESCALATED
    branch = clone(workspace) on "agent/fix-<kind>"   # prefix enforced
    changed = remediation.apply(branch, fault)
    if not changed: return ESCALATED

    # 4. VERIFY — re-run the proving probe ON THE BRANCH
    if not PROBES[remediation.verifyWith].run(branch).ok:
      memory.record(signature, outcome=failed)
      discard branch (rollback); continue          # try again or exhaust rounds

    # 7. COMMIT + PROPOSE MERGE — human one-tap lands it
    commit(branch, author=AGENT_ENGINEERING)
    memory.record(signature, outcome=verified, at=now)   # 8+9
    return MERGE_PROPOSED(branch, diff)

# 10. BEHAVIORAL METACOGNITION — a separate entry point, no branch:
selfCorrect(mistake):
  memory.record("behavior:" + mistake.type, verified)
  return SELF_CORRECTED(lesson)
```

## Reference implementation

[`self-repair-loop.ts`](./self-repair-loop.ts) — a standalone, dependency-free model of the whole loop. The "workspace" is an in-memory object of named subsystems, a "branch" is a `structuredClone` of it, a rollback is a real discard, and `RepairMemory` is an in-process `Map` with an injectable clock so the demo can simulate time passing. Run it:

```bash
# Node 24+ runs it directly (native TS type-strip):
node self-repair-loop.ts --demo

# or with tsx:
npx tsx self-repair-loop.ts --demo
```

The demo exercises seven scenarios end to end:

1. **Model degraded** — active model returns empty replies → diagnose `model_degraded` (0.90) → request the next model in the chain → verify replies recover → propose merge. *(facets 2–7)*
2. **Stale tool endpoint** — a tool 404s against a moved endpoint → `tool_endpoint_stale` (0.85) → repoint to the known-good URL → verify → propose merge.
3. **Build broken** — workspace stops typechecking → `build_broken` (0.95) → branch + fix → verify typecheck → propose merge.
4. **Weak signal** — latency alone is elevated → `model_degraded` (0.40) < floor → **report, do not act**. *(facet 3)*
5. **Memory + temporal awareness across recurring faults** *(facets 8, 9)* — the same tool fault, three times on a shared memory: (5a) first occurrence is diagnosed and fixed; (5b) two minutes later it recurs → detected as **flapping → escalate to a human**; (5c) a day later it recurs → the prior remedy is **recalled** and re-applied.
6. **Behavioral metacognition** *(facet 10)* — the agent recognises it called a tool with the wrong argument and records a correction memory — no branch, no code change.
7. **Healthy** — all probes green → no-op.

Each prints its full audit trail so you can watch the introspect→diagnose→plan→verify→merge sequence and see exactly where the branch wall, the confidence floor, the flapping guard, and the memory recall kick in.

## How this maps to the production system

The reference file isolates the *control loop*. In the live agent the same shape is wired across several real components:

| Facet / loop step | Production mechanism |
|-------------------|----------------------|
| Introspect (2) | `git_status`, engineering log reads, `connector_status`, `project_status`, backend health probes (all read-only, `engineering_read`) |
| Subsystem health model (5) | per-backend `HealthGuard` state, tool error telemetry, the typecheck/build gate — each a distinct, separately-probeable subsystem |
| Diagnose (3) | a disposable, time-boxed `regression_analyst` worker (Band 0/1, read-only) that reads logs + diffs and returns `{ confidence, conflict_flags, recommendation }` — it cannot write |
| Request the model (6) | the resilient router's fallback chain ([guide 12](../12-resilient-llm-routing/)) and per-role sub-model selection (thinking vs. tooling models) |
| Apply on a branch (4, 7) | `git_branch` (`^agent/[a-z0-9._-]+$` only — the *sole* way to make the tree write-eligible), `write_file`, `exec` (allow-listed `pnpm`/`tsc`/`git`/`node`/`psql`; `rm`/`sudo`/`curl`/subshells blocked) |
| Verify (4) | `run_tests` / `exec pnpm typecheck` before any commit |
| Commit (7) | `git_commit`, fixed author `Agent (engineering mode)`, **fails on `main`**, requires `engineering_write` |
| Restore (7) | `propose_merge` → one-tap merge card → server-side `git merge --no-ff` on the human's approval |
| Memory-driven adaptation (8) | the correction-memory / fact store (`writeFact`) and the self-learning vocabulary — verified fixes and behaviour corrections persist across turns and restarts |
| Temporal awareness (9) | the agent scheduler + worker TTLs + rolling health windows; rate-limiting self-repair per fault signature so a non-holding fix escalates instead of looping |
| Behavioral metacognition (10) | the `behavior_fix` tool's `is_self_correction` + `correction_type` taxonomy (`url_fix`, `api_endpoint_fix`, `api_argument_fix`, `factual_fix`, …) — runtime self-corrections recorded as memory, not code |

## Formalism: schemas, protocols, and the governance boundary

The prose above describes the loop; these are the contracts it runs on, made explicit so they can be reimplemented without reverse-engineering the code.

**Repair-shard format.** The reference keeps memory deliberately minimal — `RepairMemory` stores one `MemoEntry` per fault signature: `{ remedyKind, remedySummary, lastOutcome, lastAt, attempts }`. That is all the loop here needs: `lastOutcome` + `lastAt` + `attempts` drive recall and the flapping guard. The *production* repair shard it generalises to is a superset — the extra fields below are what a real audit trail and cross-restart store would carry, not what this reference persists:

```
RepairShard (production superset of MemoEntry)
  signature:    string        # e.g. "tool:play_audio:endpoint" — the recall/cooldown key
  remedyKind:   FaultKind      # model_degraded | tool_endpoint_stale | build_broken | behavior:*  (stored)
  remedySummary:string         # human-readable remedy (stored)
  lastOutcome:  "verified" | "failed"   # (stored)
  lastAt:       number         # ms epoch — recency drives the flapping guard (stored)
  attempts:     number         # (stored)
  verifiedBy:   string | null  # production add: the probe id whose re-run proved it
  branch:       string | null  # production add: the agent/* branch the fix landed from
  author:       fixed agent id # production add: never a human — the merge is the human act
```

A coarse `signature` conflates distinct incidents (see Limitations); widen it (tool name + endpoint host) in production so recall fetches the *right* shard.

**Verification protocol (the "I changed something" → "it works" gate).** A remediation never reports success; it reports a *change* plus the probe that should now pass:

1. Remediation returns `{ changed: bool, verifyWith: probeId }`. If `changed == false` → `ESCALATE` (the remedy did not apply).
2. Re-run *exactly* `PROBES[verifyWith]` **on the branch**, not the whole probe set — the proof must be the inverse of the symptom.
3. Probe green → proceed to commit + propose. Probe still failing → record a `failed` shard, roll back, and either retry within the round cap or `ESCALATE`.
4. The proving probe must have a deterministic result (a typecheck, a smoke request), never a heuristic average — a fix verified by a noisy probe is not verified.

**Rollback strategy.** Rollback is structural, not compensating. Because every write lands on a `structuredClone` of the workspace (the branch), "rolling back" is *discarding the clone* — the live tree was never mutated, so there is nothing to undo. The strategy has three tiers, by failure point: (a) remedy did not apply → discard branch, escalate; (b) remedy applied but failed verification → discard branch, record `failed` shard, retry/escalate; (c) verified and merged but the fault recurs within `FLAP_COOLDOWN_MS` → the merge is treated as non-holding, the flapping guard escalates to a human instead of re-merging. There is no "revert a bad merge" path here because nothing merges without passing verification first; the human merge is the last gate, and an auto-merge tier (if ever added) must carry the citation-bound, one-tap-revert controls of [guide 22](../22-autonomous-threat-response/).

**Governance boundary.** The wall between autonomous and human-gated, by phase:

| Phase | Actor | Grant / gate | Can touch `main`? |
|-------|-------|--------------|-------------------|
| Introspect (probes) | agent, autonomous | read grant (`engineering_read`) | no — pure reads |
| Diagnose (hypothesis + confidence) | agent, autonomous | none (in-memory) | no |
| Recall / flapping check | agent, autonomous | repair-shard memory | no |
| Apply remedy on a branch | agent, autonomous | write grant (`engineering_write`) + `agent/*` prefix | no — clone only |
| Verify (re-run proving probe) | agent, autonomous | read grant | no — branch only |
| Commit on branch | agent, autonomous | write grant, fixed author, **throws on `main`** | no |
| Propose merge | agent, autonomous | emits a one-tap card | no |
| **Merge to `main`** | **human** | **one-tap approval** | **yes — only here** |
| Behavioural self-correct | agent, autonomous | memory write only | no — never code |

Everything above the bold row is the agent acting on itself inside a sandbox; the single bold row is the only place a self-authored change reaches production, and it is a human act. Capability *acquisition* (growing a new tool rather than repairing one) reuses this exact boundary — see [guide 69, Self-Directed Capability Acquisition](../69-self-directed-capability-acquisition/), where a synthesized tool lands `proposed` and a human approves it and assigns its authority band.

## Limitations and extensions

- **The diagnoser here is rule-based.** That is deliberate — it keeps the contract legible. Swap it for an LLM `regression_analyst` worker; as long as it returns `{ kind, confidence, evidence, signature }` the rest of the loop is unchanged. Keep the confidence floor regardless of how the number is produced.
- **One fault per round.** Real incidents are often comorbid (a model swap that also needs a config edit). Extend `diagnose` to return a ranked list and let the loop sequence remediations, but keep each one independently verified.
- **Verification is as good as your probes.** A fix can pass a weak probe and still be wrong. Invest in probes with deterministic proofs (typecheck, a smoke request) over heuristic ones (latency averages).
- **Memory keyed by signature is coarse.** Two genuinely different `tool:endpoint` faults share a key here. In production, widen the signature (tool name + endpoint host) so adaptation recalls the *right* remedy and flapping detection does not conflate distinct incidents.
- **No automatic merge, by design.** If you ever add an auto-merge tier for a narrow class of fixes, gate it the way [guide 22, Autonomous Threat Response](../22-autonomous-threat-response/) gates its defensive writes: citation-bound, hard-capped, burst-auto-paused, and one-tap revertible. Self-repair without a revert path is not a feature.
- **Loops can thrash.** The round cap bounds churn inside one incident; the flapping guard bounds it across incidents. Together they ensure a fix that keeps failing reaches a human instead of retrying forever.
