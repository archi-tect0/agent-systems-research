# Deterministic Incident Response Playbook Engine


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

When a security incident is suspected — a drained account, a phishing message, a leaked key — the response should be fast, ordered, and consistent. Humans under stress skip steps, reorder them, or forget evidence collection. An autonomous agent has the opposite failure mode: without an explicit runbook it improvises, and improvised security actions are exactly the actions you do not want an agent taking on its own.

What is needed is a **machine-readable runbook**: a fixed catalogue of incident types, each with a regex that recognizes the incident from free text, and an ordered list of response steps. Crucially, each step must be tagged with whether the agent may run it autonomously (read-only triage, evidence archiving, notifications) or whether it must pause for explicit human approval (freezing funds, revoking sessions, rotating keys). The agent then executes the auto steps immediately and queues the approval-gated steps for a human, so containment begins instantly while irreversible actions stay under human control.

The engine is deliberately deterministic: the same alert text always maps to the same playbook and the same step plan. There is no model inference in the detection or planning path — just regular expressions and a sorted list — which makes the behavior auditable and testable.

## Design decisions

**Why regex detection terms instead of a classifier?**
Detection has to be deterministic and explainable. A regex per playbook makes the trigger condition a piece of reviewable source: a responder can read exactly which words fire which playbook, write unit tests against it, and reason about false positives. A learned classifier would be opaque and could drift; for a small, fixed set of high-value incident types, hand-tuned patterns are both sufficient and accountable. The classifier can sit *upstream* feeding text into this engine, but the engine itself stays deterministic.

**Why tag every step `autoExecutable` vs `requiresApproval`?**
The two tags encode a trust boundary. Read-only and reversible actions — pulling transaction history, scanning URLs, archiving evidence, notifying guardians — can run the instant an incident is detected, because the cost of a false positive is negligible. Irreversible or high-impact actions — freezing funds, revoking sessions, rotating keys, moving money — must wait for a human, because a false positive there is itself an incident. Encoding this per step lets the agent act fast where it is safe and stop where it is not, instead of treating the whole playbook as all-auto or all-manual.

**Why a strict `order` field and a sorted plan?**
Response steps have dependencies: you detect before you contain, contain before you archive, archive before you recover. Storing an explicit integer order and sorting on it means the plan is reproducible regardless of how the steps array happens to be written, and it gives the executor a single canonical sequence to walk. Partitioning the sorted list into auto and approval buckets preserves that order within each bucket.

**Why split the plan into `autoSteps`, `approvalSteps`, and `ordered`?**
Different consumers want different views. The executor walks `ordered` to preserve dependencies; the auto-runner pulls `autoSteps` to fire immediately; an approval UI shows `approvalSteps` as a batch for a human to authorize in one pass. Computing all three once from a single sort keeps them consistent with each other.

**Why an optional `toolHint` rather than a hard tool binding?**
Steps describe *intent* ("freeze the account", "revoke approvals"), not a specific implementation. A `toolHint` suggests which tool the executing agent should reach for, but leaving it optional and advisory keeps the playbook portable: the same runbook works across deployments whose tool names differ, and steps that are pure reasoning carry no hint at all.

## Algorithm

```
Catalogue: PLAYBOOKS[] each = {
  id, title, description, severity 1..5,
  detectionTerms : RegExp,
  steps[] each = { order, kind, description, toolHint?, autoExecutable, requiresApproval }
}

detectPlaybook(text):
  for p in PLAYBOOKS:               // first match wins, catalogue order
    if p.detectionTerms.test(text): return p
  return null

buildStepPlan(playbook):
  ordered  = sort(playbook.steps by order ascending)
  return {
    ordered,
    autoSteps     = ordered where autoExecutable,
    approvalSteps = ordered where requiresApproval,
  }

Execution by an agent:
  pb = detectPlaybook(alertText)
  if pb:
    plan = buildStepPlan(pb)
    run plan.autoSteps now (read-only / reversible)
    queue plan.approvalSteps for human authorization
    execute approved steps following plan.ordered
```

## Reference implementation

See [`incident-playbook-engine.ts`](./incident-playbook-engine.ts) in this directory. It is pure TypeScript on Node built-ins with no external dependencies.

## Usage

```typescript
import { detectPlaybook, buildStepPlan, getPlaybook, PLAYBOOKS } from "./incident-playbook-engine.js";

// Recognize an incident from free text.
const pb = detectPlaybook("my wallet got drained overnight");
if (pb) {
  console.log(pb.id, pb.severity); // "wallet_compromise" 5

  // Build the ordered, partitioned execution plan.
  const plan = buildStepPlan(pb);
  for (const step of plan.autoSteps) {
    // run immediately — read-only / reversible
  }
  for (const step of plan.approvalSteps) {
    // queue for human authorization before executing
  }
  // plan.ordered preserves cross-step dependencies
}

// Direct lookup by id, or iterate the full catalogue.
const known = getPlaybook("phishing_message");
const allIds = PLAYBOOKS.map((p) => p.id);
```

## Limitations and extensions

- **First-match detection.** `detectPlaybook` returns the first catalogue entry whose regex matches; an alert that mentions two incident types only fires one playbook. Order the catalogue by severity, or extend to return all matches if simultaneous incidents must be handled.
- **Regex brittleness.** Hand-written patterns miss paraphrases and can false-positive on quoted text. Pair the engine with an upstream classifier that normalizes alerts into canonical phrasing before detection.
- **Static catalogue.** The playbooks are compiled in. Loading them from signed configuration would let responders update runbooks without redeploying, at the cost of needing to validate the loaded definitions.
- **No execution state.** The engine plans but does not track which steps have run. A real deployment wraps it with a per-incident state machine that records step completion, approvals granted, and outcomes for the audit trail.
- **Tool hints are advisory.** Steps name an intent and suggest a tool but do not bind to one. The executing agent must map hints to its actual tool registry and handle missing tools gracefully.
