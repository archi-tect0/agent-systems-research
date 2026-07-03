# Batched Single-Signature Approval Queue


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

An autonomous agent often decides, within a single reasoning turn, to take several write actions at once: tag a contact, draft a message, rename a label, and move some funds. The naive approach prompts the operator for approval once per action — three or four separate confirmation ceremonies (passkey taps, signatures, MFA prompts) for what the user thinks of as one request. This is both annoying and dangerous: approval fatigue trains people to confirm without reading.

The opposite extreme — one blanket "let the agent do anything" grant — removes the human from the loop entirely. What we want is a middle path: **collect the whole set of pending write actions, present them as one reviewable plan, and authorize the batch with a single approval ceremony.** Two further requirements fall out of doing this safely:

1. **Execution order matters.** If a batch contains both a reversible label edit and an irreversible fund transfer, we want the cheap, recoverable actions to run first. If something goes wrong early, the dangerous action never executes.
2. **Partial failure must be recoverable.** Once a batch is approved and execution begins, an action in the middle can still fail (a service returns a conflict, a network call times out). The operator then needs to know exactly what already happened and how to undo it.

## Design decisions

**Why batch approvals into one ceremony instead of approving each action?**
Each approval ceremony has a fixed human cost and a fixed security value. Repeating it per action multiplies the cost without multiplying the value — the operator is approving the same intent. Batching collapses N ceremonies into one while preserving the critical property that a human reviewed the full list before anything ran. The single summary is the security artifact: it enumerates every action and its risk class so the reviewer sees the whole blast radius at once.

**Why sort actions lowest-risk-first?**
Execution order is a safety lever. Sorting by risk class (`read < draft < simulate < low_write < high_write < irreversible`) means the recoverable, low-consequence actions execute first and the irreversible ones last. If any action fails, execution stops immediately — so a failure is most likely to occur while only cheap actions have completed, and the expensive irreversible action at the tail never fires. Sorting also makes the approval summary read like a risk ramp, which helps the reviewer focus attention on the bottom of the list.

**Why carry a rollback hint per action instead of an automatic undo?**
True automatic rollback requires every tool to expose a transactional inverse, which most real-world side-effecting tools do not. A rollback *hint* is a pragmatic compromise: a human-readable string describing how to undo this specific action ("Remove the VIP tag from contact c-77"). It costs nothing to attach at enqueue time and turns a mid-batch failure from a mystery into a checklist. The queue does not attempt to execute the undo — it surfaces the hints and leaves the decision to the operator or a follow-up turn.

**Why is the batch in-memory and short-lived?**
A batch represents the write actions of a single turn. It is not a durable work queue. Keeping it in process (a `Map` keyed by batch id) keeps the model simple and avoids leaking half-approved intentions across turns. A `pruneExpired` sweep drops batches older than a few minutes so an abandoned, never-approved batch cannot be resurrected later. The *durable* record — if you need one for audit — is the approval ceremony result, not the transient queue.

**Why stop at the first failure rather than continuing?**
Continuing past a failure assumes the remaining actions are independent of the one that failed, which is rarely safe to assume. Stopping immediately bounds the damage and produces a clean cut point: everything before the failure completed, everything after never started. The rollback summary then only has to describe the completed prefix.

## Algorithm

```
createBatch(owner):
  batch = { id, owner, actions: [], status: "collecting" }

enqueue(batchId, action):
  require batch.status == "collecting"
  append action {id, status: "pending", riskClass, description, rollbackHint?}

sealBatch(batchId):
  sort actions by RISK_ORDER[riskClass] ascending     // low -> high
  summary = numbered list of "description [riskClass]"
  if any irreversible: append irreversible warning
  else if any high_write/irreversible: append high-risk warning
  batch.status = "pending_approval"
  return summary                                        // shown to reviewer

approveBatch(batchId, approvalToken):                   // ONE ceremony
  require batch.status == "pending_approval"
  batch.status = "approved"; record approvalToken

executeBatch(batchId, executor):
  require batch.status == "approved"
  for action in batch.actions:                          // already sorted
    try:
      action.result = await executor(action.toolName, action.args)
      action.status = "completed"
    catch err:
      action.status = "failed"; batch.status = "failed"
      return { success: false, failedAction, rollback: buildRollbackSummary() }
  batch.status = "completed"; return { success: true }

buildRollbackSummary(batchId):
  completed = actions where status == "completed"
  return list of "description: rollbackHint" for each completed action
```

## Reference implementation

See [`batched-approval-queue.ts`](./batched-approval-queue.ts) in this directory. No external dependencies — pure built-ins (`setTimeout` in the demo executor only).

## Usage

```typescript
import { ApprovalQueue, RISK_CLASS, type ToolExecutor } from "./batched-approval-queue.js";

const queue = new ApprovalQueue();
const batch = queue.createBatch("operator-1");

queue.enqueue(batch.id, {
  toolName: "update_contact",
  args: { id: "c-77", note: "VIP" },
  riskClass: RISK_CLASS.low_write,
  description: "Tag contact c-77 as VIP",
  rollbackHint: "Remove the VIP tag from contact c-77.",
});
queue.enqueue(batch.id, {
  toolName: "transfer_funds",
  args: { to: "0xabc", amount: 5 },
  riskClass: RISK_CLASS.irreversible,
  description: "Send 5 tokens to 0xabc",
  rollbackHint: "Funds cannot be recalled; request a return.",
});

// One ceremony over the whole batch:
const plan = queue.sealBatch(batch.id);     // sorted low -> high, with warnings
queue.approveBatch(batch.id, "approval-token-from-passkey-or-mfa");

const executor: ToolExecutor = async (toolName, args) => callTool(toolName, args);
const outcome = await queue.executeBatch(batch.id, executor);
if (!outcome.success) {
  console.log(outcome.failedAction);
  console.log(outcome.rollback);            // undo hints for completed actions
}
```

## Limitations and extensions

- **Rollback is advisory, not automatic.** The queue surfaces undo hints; it does not execute them. For tools that expose a transactional inverse, you could extend `executeBatch` to call a registered `undo(toolName, result)` for each completed action on failure.
- **Stop-on-first-failure is conservative.** If your actions are provably independent, you may prefer to continue and collect all failures. Add a per-batch `continueOnError` flag and accumulate failures rather than returning at the first one.
- **Single approval token covers the whole batch.** This assumes the reviewer saw the full plan. If risk classes can change between seal and approval (e.g. a price moves a transfer into a higher tier), re-seal and re-approve rather than reusing a stale token.
- **In-memory store is per-process.** Across a restart, unexecuted batches are lost (intentionally). If you need batches to survive a crash between approval and execution, persist the sealed plan and the approval token, then replay `executeBatch` on recovery.
- **Risk ordering is a fixed total order.** Two actions in the same risk class keep their enqueue order. If intra-class ordering matters (e.g. create-before-reference dependencies), add an explicit dependency field and topologically sort within each risk tier.
