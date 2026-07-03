// Primitive 3 — Governance.
//
// A two-layer gate. First a capability check: the action's required capability
// must have been granted. Then a set of invariants — hard rules that can deny
// an action regardless of granted capabilities. Invariants always win, so a
// granted capability can never override a safety rule. This is the mechanism;
// which capabilities to grant and which invariants to install is policy.

import type { AuthorizeResult, GovernanceAction, Invariant } from "./types.ts";

export class Governance {
  grants: Set<string>;
  invariants: Invariant[];

  constructor() {
    this.grants = new Set();
    this.invariants = [];
  }

  grant(capability: string): void {
    this.grants.add(capability);
  }

  revoke(capability: string): void {
    this.grants.delete(capability);
  }

  has(capability: string): boolean {
    return this.grants.has(capability);
  }

  addInvariant(inv: Invariant): void {
    this.invariants.push(inv);
  }

  authorize(action: GovernanceAction): AuthorizeResult {
    if (action.capability && !this.grants.has(action.capability)) {
      return { allowed: false, reason: `missing capability: ${action.capability}` };
    }
    for (const inv of this.invariants) {
      const denial = inv.check(action);
      if (denial) {
        return { allowed: false, reason: `invariant ${inv.name}: ${denial}` };
      }
    }
    return { allowed: true, reason: "ok" };
  }
}
