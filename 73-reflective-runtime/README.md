# Reflective Runtime

*The integrated loop: one runnable runtime that wires the Layer-2 metacognition primitives (66–72) onto the kernel — route, score, govern, dispatch, remember, reflect — in ~500 deterministic lines.*

Every other guide describes one primitive in isolation. The integrated core ([guide 00](../00-agent-kernel/)) composes the five base primitives — memory, tool routing, governance, wallet limits, a world model — into one turn loop, but it predates the metacognition layer. This guide is the **reflective** counterpart: it adds the parts of an agent that operate on *itself* and shows them composing in a single loop you can run.

It is intentionally minimal and **deterministic** — a logical clock, no wall-time, no randomness — so the trace reproduces byte-for-byte. Read it for the *shape of the wiring*, not as a production runtime. Where a real system would reach for a vetted dependency (a vector store, a model gateway, a sandbox), the file notes it and runs on Node built-ins instead.

## What it demonstrates

One loop, six threads from the catalog drawn through it:

| Thread | In this runtime | Source guide(s) |
|--------|-----------------|-----------------|
| **Kernel loop** | `runTurn()`: route → score → govern → dispatch → remember → reflect | [00](../00-agent-kernel/) |
| **Memory read/write** | a salience store with kinds (`short`/`episodic`/`semantic`/`self`) + a consolidation pass | [06](../06-compound-memory-salience/), [07](../07-reflective-memory/), [71](../71-memory-consolidation-sleep/) |
| **Reflection cycle** | a self-model graph that localizes a fault to its root cause and computes blast radius | [66](../66-metacognitive-self-repair/), [67](../67-agent-self-model-graph/) |
| **Uncertainty scoring** | calibrated confidence → `act` / `escalate` / `abstain` against a risk-scaled floor | [68](../68-calibrated-uncertainty-engine/) |
| **Capability registry** | tools gated by authority band + status, grown from a recurring gap | [37](../37-agent-authority-bands/), [69](../69-self-directed-capability-acquisition/) |
| **Self-repair hooks** | fix a fault on a clone, verify it, land it behind a human merge, remember the remedy | [66](../66-metacognitive-self-repair/) |

## The loop

```
intent
  ↓
route ──(no active tool)──▶ count gap ──(recurs)──▶ draft + verify ──▶ propose (inert)
  ↓ (matched)
score ──▶ calibrate ──▶ decide ─── abstain / escalate / act   (floor scales with risk)
  ↓ (act)
govern (authority band)
  ↓ (allowed)
dispatch ──(fault)──▶ reflect: root-cause ──▶ repair on a clone ──▶ verify ──▶ human-merge ──▶ retry
  ↓ (ok)
remember (episodic) ──▶ calibration learns from the outcome
```

The order is the point. Confidence is checked **before** governance, which is checked **before** dispatch, so a low-confidence or out-of-band action never reaches a side effect. Reflection only runs **on a fault**, and the repair it produces is never trusted until it is verified on a throwaway clone and merged by a human.

## Design decisions

**The runtime owns the policy; the primitives stay mechanism.** Exactly as in guide 00, each component (memory, self-model, uncertainty, governance, registry) is policy-free. The risk floors, the authority band granted, the gap threshold, the repair cooldown, and the merge gate all live in the runtime that threads them — so the same primitives can be re-wired into a different loop without change.

**Confidence gates before the band, and the band gates before dispatch.** A single calibrated number decides act/escalate/abstain against a floor that scales with stakes (a `0.85` plays a song but escalates a transfer). Only if it clears does the authority band check run, and only if *that* clears does anything execute. Two independent gates in series: one about *certainty*, one about *permission*.

**A fault is localized, not guessed.** When a dispatch fails, the runtime does not retry the symptom. It walks the self-model from the failing capability down to the deepest unhealthy dependency — the root cause — and reports the blast radius (which other capabilities that fault takes down) before attempting anything.

**Repair is autonomous; landing is not.** The remedy is applied to a `clone()` of the self-model and verified there; the live model is untouched until a human `self-repair.merge` grant lets the verified branch land. Without the grant, a *verified* fix still only escalates. A re-fix inside the cooldown window is treated as flapping and escalates instead of looping.

**Growth is earned and inert by default.** A new capability is drafted only after the same gap recurs, must pass its own generated tests before it can be proposed, and enters the registry as `proposed` — unreachable by the router until a human approves it and assigns its authority band. The agent never sets its own privilege level.

**Memory is one store with kinds and a sleep pass.** Writes are tagged `short` / `episodic` / `semantic` / `self`; reads blend similarity, recency, usage, and salience. A consolidation pass forgets low-value noise, fuses near-duplicates (corroboration *raises* salience), and promotes anything corroborated across ≥ 3 distinct sessions into a pinned semantic lesson.

## Running it

```bash
node reflective-runtime.ts          # Node 24+ (strips TS types natively)
# or
npx tsx reflective-runtime.ts
```

The demo drives one scenario through every path: a confidence-gated action set, an authority-band denial then grant, an endpoint failure that triggers reflect-and-repair, a recurring gap that grows a verified tool, and a consolidation pass that promotes a recurring lesson — then prints the self-model, the calibration Brier score, and the context block the agent would inject.

## Where a real system diverges

- **Routing** here is trigger-term matching; production routes with an intent classifier or the LLM itself (see [guide 09](../09-intent-based-tool-selection/)).
- **Similarity** is token-set Jaccard; swap in cosine over embeddings — the consolidation logic downstream is identical.
- **Tool execution** runs in-process; a runtime that synthesizes its own tools must execute candidates in a real sandbox, not `new Function`-style trust.
- **The merge gate** is a boolean grant; production binds it to the batched approval ceremony and a passkey signature (see [guide 49](../49-batched-approval-ceremony/)).
