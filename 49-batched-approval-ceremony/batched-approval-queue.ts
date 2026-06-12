/**
 * Batched Single-Signature Approval Queue
 *
 * Collects several pending write actions produced during one reasoning turn and
 * authorizes the whole set with ONE approval ceremony, instead of prompting the
 * operator once per action. Actions are sorted by risk class (lowest first) so
 * execution proceeds from safest to most dangerous. Each action may carry a
 * rollback descriptor; when a late-stage action fails, the queue reports undo
 * hints for everything that already completed.
 *
 * Pure built-ins. No persistence — a batch lives for one turn.
 */

// ── Risk classes (no enum: 'as const' object + union type) ──────────────────

export const RISK_CLASS = {
  read: "read",
  draft: "draft",
  simulate: "simulate",
  low_write: "low_write",
  high_write: "high_write",
  irreversible: "irreversible",
} as const;

export type RiskClass = (typeof RISK_CLASS)[keyof typeof RISK_CLASS];

const RISK_ORDER: Record<RiskClass, number> = {
  read: 0,
  draft: 1,
  simulate: 2,
  low_write: 3,
  high_write: 4,
  irreversible: 5,
};

export type ActionStatus =
  | "pending"
  | "approved"
  | "executing"
  | "completed"
  | "failed"
  | "rolled_back";

export interface QueuedAction {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  riskClass: RiskClass;
  description: string;
  rollbackHint?: string;
  status: ActionStatus;
  result?: unknown;
  error?: string;
}

export type BatchStatus =
  | "collecting"
  | "pending_approval"
  | "approved"
  | "executing"
  | "completed"
  | "failed";

export interface ActionBatch {
  id: string;
  owner: string;
  actions: QueuedAction[];
  summary: string;
  createdAt: number;
  status: BatchStatus;
  approvalToken?: string;
}

export type ToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

let _counter = 0;
function uid(prefix: string): string {
  _counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_counter.toString(36)}`;
}

/**
 * ApprovalQueue holds in-memory batches keyed by batch id. A batch is built up
 * with enqueue(), sealed for review, approved once, then executed in order.
 */
export class ApprovalQueue {
  private batches: Map<string, ActionBatch>;

  constructor() {
    this.batches = new Map();
  }

  createBatch(owner: string): ActionBatch {
    const batch: ActionBatch = {
      id: uid("batch"),
      owner,
      actions: [],
      summary: "",
      createdAt: Date.now(),
      status: "collecting",
    };
    this.batches.set(batch.id, batch);
    return batch;
  }

  getBatch(batchId: string): ActionBatch | undefined {
    return this.batches.get(batchId);
  }

  enqueue(
    batchId: string,
    action: Omit<QueuedAction, "id" | "status">,
  ): QueuedAction {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error(`unknown batch ${batchId}`);
    if (batch.status !== "collecting") {
      throw new Error(`batch ${batchId} is not collecting`);
    }
    const queued: QueuedAction = {
      id: uid("act"),
      status: "pending",
      ...action,
    };
    batch.actions.push(queued);
    return queued;
  }

  /** Sort lowest-risk first and build a human-readable approval summary. */
  sealBatch(batchId: string): string {
    const batch = this.batches.get(batchId);
    if (!batch || batch.actions.length === 0) return "";

    batch.actions.sort(
      (a, b) => RISK_ORDER[a.riskClass] - RISK_ORDER[b.riskClass],
    );

    const hasIrreversible = batch.actions.some(
      (a) => a.riskClass === "irreversible",
    );
    const hasHighRisk = batch.actions.some(
      (a) => a.riskClass === "high_write" || a.riskClass === "irreversible",
    );

    const n = batch.actions.length;
    const lines = [
      `Approve ${n} action${n > 1 ? "s" : ""} (safest first):`,
      ...batch.actions.map(
        (a, i) => `  ${i + 1}. ${a.description} [${a.riskClass}]`,
      ),
    ];
    if (hasIrreversible) {
      lines.push("! One or more actions are irreversible. Review carefully.");
    } else if (hasHighRisk) {
      lines.push("! High-risk actions included. Approval required.");
    }

    batch.summary = lines.join("\n");
    batch.status = "pending_approval";
    return batch.summary;
  }

  /** Record a single approval ceremony result over the whole batch. */
  approveBatch(batchId: string, approvalToken: string): void {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error(`unknown batch ${batchId}`);
    if (batch.status !== "pending_approval") {
      throw new Error(`batch ${batchId} is not awaiting approval`);
    }
    batch.status = "approved";
    batch.approvalToken = approvalToken;
    for (const a of batch.actions) a.status = "approved";
  }

  /**
   * Build a rollback summary listing every already-completed action plus its
   * undo hint. Called after a mid-batch failure.
   */
  buildRollbackSummary(batchId: string): string {
    const batch = this.batches.get(batchId);
    if (!batch) return "";
    const completed = batch.actions.filter((a) => a.status === "completed");
    if (completed.length === 0) {
      return "No actions completed before failure — nothing to roll back.";
    }
    return [
      `${completed.length} action(s) completed before failure. Consider reverting:`,
      ...completed.map(
        (a) =>
          `  - ${a.description}: ${a.rollbackHint ?? "(no rollback hint supplied)"}`,
      ),
    ].join("\n");
  }

  /**
   * Execute every action in order using the supplied executor. Stops at the
   * first failure and returns rollback hints for completed actions.
   */
  async executeBatch(
    batchId: string,
    executor: ToolExecutor,
  ): Promise<{
    success: boolean;
    completed: number;
    failedAction?: string;
    rollback?: string;
  }> {
    const batch = this.batches.get(batchId);
    if (!batch) return { success: false, completed: 0, failedAction: "batch not found" };
    if (batch.status !== "approved") {
      return { success: false, completed: 0, failedAction: "batch not approved" };
    }

    batch.status = "executing";
    let completed = 0;

    for (const action of batch.actions) {
      try {
        action.status = "executing";
        action.result = await executor(action.toolName, action.args);
        action.status = "completed";
        completed += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        action.status = "failed";
        action.error = msg;
        batch.status = "failed";
        return {
          success: false,
          completed,
          failedAction: `${action.description}: ${msg}`,
          rollback: this.buildRollbackSummary(batchId),
        };
      }
    }

    batch.status = "completed";
    return { success: true, completed };
  }

  /** Drop batches older than the given age (default 10 minutes). */
  pruneExpired(maxAgeMs = 10 * 60_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, batch] of this.batches) {
      if (batch.createdAt < cutoff) this.batches.delete(id);
    }
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const run = async () => {
    const queue = new ApprovalQueue();
    const batch = queue.createBatch("operator-1");

    // Enqueue actions out of risk order to show sorting.
    queue.enqueue(batch.id, {
      toolName: "transfer_funds",
      args: { to: "0xabc", amount: 5 },
      riskClass: RISK_CLASS.irreversible,
      description: "Send 5 tokens to 0xabc",
      rollbackHint: "Funds cannot be recalled; contact 0xabc to request return.",
    });
    queue.enqueue(batch.id, {
      toolName: "draft_message",
      args: { subject: "Receipt" },
      riskClass: RISK_CLASS.draft,
      description: "Draft a receipt message",
      rollbackHint: "Delete the draft from the outbox.",
    });
    queue.enqueue(batch.id, {
      toolName: "update_contact",
      args: { id: "c-77", note: "VIP" },
      riskClass: RISK_CLASS.low_write,
      description: "Tag contact c-77 as VIP",
      rollbackHint: "Remove the VIP tag from contact c-77.",
    });
    queue.enqueue(batch.id, {
      toolName: "rename_label",
      args: { id: "l-3", name: "Archive" },
      riskClass: RISK_CLASS.high_write,
      description: "Rename label l-3 to Archive",
      rollbackHint: "Rename label l-3 back to its previous value.",
    });

    console.log("=== Sealed batch plan (sorted low -> high risk) ===");
    console.log(queue.sealBatch(batch.id));

    console.log("\n=== One approval ceremony for the whole batch ===");
    queue.approveBatch(batch.id, "approval-token-stub-xyz");
    console.log("approved with token:", queue.getBatch(batch.id)?.approvalToken);

    // Executor that fails on the high_write action to trigger rollback hints.
    const executor: ToolExecutor = async (toolName, args) => {
      await new Promise((r) => setTimeout(r, 5));
      if (toolName === "rename_label") {
        throw new Error("label service returned 409 conflict");
      }
      return { ok: true, toolName, args };
    };

    console.log("\n=== Executing batch (mid-batch failure simulated) ===");
    const outcome = await queue.executeBatch(batch.id, executor);
    console.log("success:", outcome.success);
    console.log("completed:", outcome.completed);
    console.log("failed at:", outcome.failedAction);
    console.log("\n--- rollback hints for completed actions ---");
    console.log(outcome.rollback);
  };

  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
