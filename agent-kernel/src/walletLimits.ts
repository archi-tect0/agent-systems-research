// Primitive 4 — Wallet limits.
//
// A rolling-window spend governor. It enforces a total spend cap inside a time
// window and forces human approval for any single spend at or above a
// threshold. It fails closed: a malformed amount, or a missing/invalid config,
// denies. The kernel ships this enforcement mechanism; the actual numbers
// (cap, window, threshold) are policy supplied by the agent.

import type { SpendDecision, WalletConfig } from "./types.ts";

interface Spend {
  at: number;
  amount: number;
}

export class WalletLimits {
  limit: number;
  windowMs: number;
  approvalThreshold: number;
  spends: Spend[];
  configError: string | null;

  constructor(cfg: WalletConfig) {
    this.limit = cfg.limit;
    this.windowMs = cfg.windowMs;
    this.approvalThreshold = cfg.approvalThreshold;
    this.spends = [];
    this.configError = WalletLimits.validate(cfg);
  }

  private static validate(cfg: WalletConfig): string | null {
    if (!Number.isFinite(cfg.limit) || cfg.limit <= 0) return "invalid limit";
    if (!Number.isFinite(cfg.windowMs) || cfg.windowMs <= 0) return "invalid window";
    if (!Number.isFinite(cfg.approvalThreshold) || cfg.approvalThreshold < 0) {
      return "invalid approval threshold";
    }
    return null;
  }

  private prune(now: number): void {
    if (!Number.isFinite(this.windowMs)) return;
    const cutoff = now - this.windowMs;
    this.spends = this.spends.filter((s) => s.at >= cutoff);
  }

  spent(now = Date.now()): number {
    this.prune(now);
    return this.spends.reduce((sum, s) => sum + s.amount, 0);
  }

  remaining(now = Date.now()): number {
    return Math.max(0, this.limit - this.spent(now));
  }

  attempt(amount: number, now = Date.now()): SpendDecision {
    if (this.configError) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `wallet misconfigured: ${this.configError}`,
        remaining: 0,
      };
    }
    const remaining = this.remaining(now);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { allowed: false, requiresApproval: false, reason: "invalid amount", remaining };
    }
    if (this.spent(now) + amount > this.limit) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `exceeds window limit (${remaining} remaining)`,
        remaining,
      };
    }
    if (amount >= this.approvalThreshold) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: `amount >= approval threshold (${this.approvalThreshold})`,
        remaining,
      };
    }
    return { allowed: true, requiresApproval: false, reason: "ok", remaining };
  }

  record(amount: number, now = Date.now()): void {
    if (this.configError) return;
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.spends.push({ at: now, amount });
  }
}
