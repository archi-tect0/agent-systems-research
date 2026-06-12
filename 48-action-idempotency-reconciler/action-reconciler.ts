/**
 * Agent Action Idempotency Reconciler
 *
 * Two mechanical guarantees for an autonomous agent that proposes write actions
 * (send funds, post a message, schedule a job) the user must confirm:
 *
 *   1. Never mint a second confirm card for the same logical action while one is
 *      still unresolved. The same (wallet, tool, canonical(args)) within the live
 *      window returns the SAME pending row — so a model that re-plans and
 *      re-proposes the identical action can't spam duplicate confirmations.
 *
 *   2. Never silently retry an action whose outcome is unknown. A row stuck in
 *      `executing` past a callback grace window transitions to `unknown` (not
 *      back to `pending`), forcing manual inspection instead of a blind re-run
 *      that might double-commit.
 *
 * The dedupe is keyed by a canonical fingerprint: args are serialised with keys
 * sorted recursively, so `{a:1,b:2}` and `{b:2,a:1}` collide as intended.
 *
 * Dependencies: Node.js built-in "crypto" only. The store is an in-memory Map
 * standing in for the partial unique index on agent_pending_actions; see the
 * README for how the DB index makes guarantee #1 race-safe across processes.
 */

import crypto from "crypto";

// ── Status model ────────────────────────────────────────────────────────────

export const LIVE_STATUSES = ["pending", "approved", "executing", "unknown"] as const;
export const TERMINAL_STATUSES = ["succeeded", "failed", "rejected", "expired"] as const;
export type ActionStatus =
  | (typeof LIVE_STATUSES)[number]
  | (typeof TERMINAL_STATUSES)[number];

function isLive(status: ActionStatus): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status);
}

// ── Canonical fingerprint ───────────────────────────────────────────────────

/** Stable JSON: object keys sorted recursively so logically-equal args produce
 *  identical strings regardless of insertion order. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") + "}";
}

export function computeIdempotencyKey(
  wallet: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const canonical = `${wallet.toLowerCase()}|${toolName}|${canonicalJSON(args)}`;
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// ── Pending action row ──────────────────────────────────────────────────────

export interface PendingAction {
  id:             string;
  wallet:         string;
  toolName:       string;
  toolArgs:       Record<string, unknown>;
  summary:        string;
  riskLevel:      string;
  idempotencyKey: string;
  status:         ActionStatus;
  createdAt:      number;
  expiresAt:      number;
  /** Set when the row enters `executing`; drives the unknown-escalation sweep. */
  executingAt:    number | null;
  resolvedAt:     number | null;
}

export interface FindOrCreateInput {
  wallet:    string;
  toolName:  string;
  toolArgs:  Record<string, unknown>;
  summary:   string;
  riskLevel: string;
  ttlMs:     number;
}

const CALLBACK_GRACE_MS = 90_000;

// ── The reconciler ──────────────────────────────────────────────────────────

export class ActionReconciler {
  private rows: Map<string, PendingAction>;
  private seq: number;
  private graceMs: number;

  constructor(opts?: { graceMs?: number }) {
    this.rows = new Map();
    this.seq = 0;
    this.graceMs = opts?.graceMs ?? CALLBACK_GRACE_MS;
  }

  /**
   * Return the live row for this (wallet, tool, canonical args) if one exists,
   * else create a fresh pending row. `reused` tells the caller whether to
   * surface a NEW confirm card or point at the existing one.
   */
  findOrCreatePending(input: FindOrCreateInput): { row: PendingAction; reused: boolean } {
    const wallet = input.wallet.toLowerCase();
    const idempotencyKey = computeIdempotencyKey(wallet, input.toolName, input.toolArgs);

    const existing = this.findLiveByKey(wallet, idempotencyKey);
    if (existing) return { row: existing, reused: true };

    const now = Date.now();
    this.seq += 1;
    const row: PendingAction = {
      id:             `act_${this.seq.toString(36)}`,
      wallet,
      toolName:       input.toolName,
      toolArgs:       input.toolArgs,
      summary:        input.summary,
      riskLevel:      input.riskLevel,
      idempotencyKey,
      status:         "pending",
      createdAt:      now,
      expiresAt:      now + input.ttlMs,
      executingAt:    null,
      resolvedAt:     null,
    };
    this.rows.set(row.id, row);
    return { row, reused: false };
  }

  private findLiveByKey(wallet: string, idempotencyKey: string): PendingAction | null {
    for (const row of this.rows.values()) {
      if (row.wallet === wallet && row.idempotencyKey === idempotencyKey && isLive(row.status)) {
        return row;
      }
    }
    return null;
  }

  /** Transition a pending/approved row into executing (records executingAt). */
  markExecuting(id: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.status = "executing";
    row.executingAt = Date.now();
  }

  /** Resolve a row to a terminal state — frees its idempotency key for reuse. */
  resolve(id: string, status: (typeof TERMINAL_STATUSES)[number]): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.status = status;
    row.resolvedAt = Date.now();
  }

  /**
   * Periodic sweep (run ~every minute):
   *   - pending/approved past expiresAt  -> expired
   *   - executing past the grace window  -> unknown (NOT retried)
   */
  sweep(now = Date.now()): { expired: number; unknown: number } {
    let expired = 0;
    let unknown = 0;
    const graceCutoff = now - this.graceMs;

    for (const row of this.rows.values()) {
      if ((row.status === "pending" || row.status === "approved") && row.expiresAt < now) {
        row.status = "expired";
        row.resolvedAt = now;
        expired++;
      } else if (row.status === "executing") {
        const ref = row.executingAt ?? row.createdAt;
        if (ref < graceCutoff) {
          row.status = "unknown";
          unknown++;
        }
      }
    }
    return { expired, unknown };
  }

  get(id: string): PendingAction | null {
    return this.rows.get(id) ?? null;
  }

  liveCount(): number {
    let n = 0;
    for (const r of this.rows.values()) if (isLive(r.status)) n++;
    return n;
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const rec = new ActionReconciler({ graceMs: 1000 }); // 1s grace for the demo

  const wallet = "0xAbC123";
  const send = {
    wallet, toolName: "send_funds",
    toolArgs: { to: "0xdead", amount: 5, token: "USDC" },
    summary: "Send 5 USDC to 0xdead", riskLevel: "high_write", ttlMs: 60_000,
  };

  // First proposal → new confirm card.
  const a = rec.findOrCreatePending(send);
  console.log("first:", { id: a.row.id, reused: a.reused, status: a.row.status });

  // Re-plan proposes the SAME action with keys in a different order → dedupe.
  const b = rec.findOrCreatePending({
    ...send,
    toolArgs: { token: "USDC", amount: 5, to: "0xdead" }, // reordered keys
  });
  console.log("duplicate:", { id: b.row.id, reused: b.reused, sameRow: b.row.id === a.row.id });

  // A genuinely different action → distinct row.
  const c = rec.findOrCreatePending({ ...send, toolArgs: { ...send.toolArgs, amount: 6 } });
  console.log("different amount:", { id: c.row.id, reused: c.reused });

  console.log("\nidempotency keys:");
  console.log("  a:", a.row.idempotencyKey.slice(0, 16), "…");
  console.log("  b:", b.row.idempotencyKey.slice(0, 16), "… (== a)");
  console.log("  c:", c.row.idempotencyKey.slice(0, 16), "… (!= a)");

  // Move `a` into executing and let it stall past the grace window.
  rec.markExecuting(a.row.id);
  console.log("\nafter markExecuting:", rec.get(a.row.id)!.status);

  setTimeout(() => {
    const swept = rec.sweep();
    console.log("sweep result:", swept);
    console.log("stalled action is now:", rec.get(a.row.id)!.status, "(manual inspection, not retried)");

    // Once it resolves, the key is free again — a fresh proposal is NOT deduped.
    rec.resolve(a.row.id, "failed");
    const d = rec.findOrCreatePending(send);
    console.log("re-propose after resolve:", { id: d.row.id, reused: d.reused });
    console.log("live count:", rec.liveCount());
  }, 1100);
}
