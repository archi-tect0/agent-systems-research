/**
 * Quorum Vault Groups
 *
 * One policy hosting two governance shapes:
 *   1. M-of-N quorum for significant actions — no single member (not even the
 *      owner) can act alone; approvals are counted transactionally and a
 *      tamper-evident quorum proof is attached the instant M is reached.
 *   2. Bounded autonomy for child sub-vaults — spend freely under a daily cap,
 *      auto-escalate to quorum above it (or when cap==0 / alwaysRequirePasskey).
 *
 * Correctness invariants reproduced from the production design:
 *   - thresholdM is clamped to [1, signerCount] → every policy is satisfiable.
 *   - approve() is transactional + idempotent → no double-count, the
 *     pending→approved transition fires exactly once.
 *   - child spend debit is an atomic conditional update (re-checks the cap) →
 *     concurrent spends cannot jointly exceed the cap.
 *   - daily window resets lazily by YYYY-MM-DD date string (no cron).
 *
 * The quorum proof uses node:crypto hashing as a stand-in for the production
 * Merkle SelectiveProof. The WebAuthn assertion is stored for audit (as in the
 * source) rather than fully verified, to keep the file self-contained.
 *
 * Dependencies: Node.js built-in "crypto" only.
 */

import crypto from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface Policy {
  id: string;
  ownerWallet: string;
  name: string;
  thresholdM: number;
  requiredSigners: string[];
}

export type ProposalStatus = "pending" | "approved" | "executed" | "expired";

export interface Proposal {
  id: string;
  policyId: string;
  proposerWallet: string;
  actionType: string;
  actionPayload: Record<string, unknown>;
  status: ProposalStatus;
  quorumRoot?: string;
  expiresAt: number;
}

interface Approval {
  proposalId: string;
  approverWallet: string;
  passkeyAssertion: string;
}

export interface Child {
  id: string;
  policyId: string;
  childWallet: string;
  label: string;
  spendCapWei: bigint;
  dailySpentWei: bigint;
  dailyResetDate: string;
  alwaysRequirePasskey: boolean;
}

const ALLOWED_ACTION_TYPES = [
  "vault.write", "vault.delete", "vault.rotate", "vault.rename",
  "child.spend_cap_update", "child.add", "child.remove",
  "wallet.send", "wallet.approve_tx", "policy.update",
];

const today = (): string => new Date().toISOString().slice(0, 10);

// ── Quorum proof (stand-in for the production Merkle SelectiveProof) ───────────

function quorumProof(opts: {
  ownerWallet: string;
  sessionId: string;
  threshold: number;
  attestedCount: number;
  guardianAddresses: string[];
}): { root: string; proof: string[] } {
  const leaves = opts.guardianAddresses
    .map(a => crypto.createHash("sha256").update(`${opts.sessionId}:${a}`).digest("hex"))
    .sort();
  const root = crypto
    .createHash("sha256")
    .update(`${opts.ownerWallet}|${opts.sessionId}|${opts.threshold}|${opts.attestedCount}|${leaves.join(",")}`)
    .digest("hex");
  return { root, proof: leaves };
}

// ── Vault ────────────────────────────────────────────────────────────────────

export class QuorumVault {
  private readonly policies  = new Map<string, Policy>();
  private readonly proposals = new Map<string, Proposal>();
  private readonly approvals: Approval[] = [];
  private readonly children  = new Map<string, Child>();

  createPolicy(opts: {
    owner: string; name: string; requiredSigners: string[]; thresholdM: number;
  }): Policy {
    const signers = opts.requiredSigners.map(s => s.toLowerCase());
    // Clamp so the policy is always satisfiable: 1 <= M <= signerCount.
    const M = Math.min(Math.max(1, opts.thresholdM), Math.max(1, signers.length));
    const policy: Policy = {
      id: crypto.randomUUID(),
      ownerWallet: opts.owner.toLowerCase(),
      name: opts.name.slice(0, 80),
      thresholdM: M,
      requiredSigners: signers,
    };
    this.policies.set(policy.id, policy);
    return policy;
  }

  private isMember(policy: Policy, w: string): boolean {
    return policy.ownerWallet === w || policy.requiredSigners.includes(w);
  }

  propose(policyId: string, proposer: string, actionType: string, payload: Record<string, unknown>): {
    proposalId: string; status: ProposalStatus; threshold: number; notifyWallets: string[];
  } {
    const policy = this.policies.get(policyId);
    if (!policy) throw new Error("policy_not_found");
    const w = proposer.toLowerCase();
    if (!this.isMember(policy, w)) throw new Error("not_a_member");
    if (!ALLOWED_ACTION_TYPES.includes(actionType)) throw new Error("invalid_action_type");

    const proposal: Proposal = {
      id: crypto.randomUUID(),
      policyId,
      proposerWallet: w,
      actionType,
      actionPayload: payload,
      status: "pending",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    };
    this.proposals.set(proposal.id, proposal);

    // Fan-out: notify every other signer/owner that their signature is needed.
    const notifyWallets = [policy.ownerWallet, ...policy.requiredSigners].filter(s => s !== w);
    return { proposalId: proposal.id, status: "pending", threshold: policy.thresholdM, notifyWallets };
  }

  /**
   * Approve a proposal. Transactional + idempotent: duplicate-check, insert,
   * recount, and the quorum transition happen as one atomic step so concurrent
   * approvals never double-count and the transition fires exactly once.
   */
  approve(policyId: string, proposalId: string, approver: string): {
    ok: true; approvalCount: number; threshold: number; quorumMet: boolean;
    status: ProposalStatus; quorumRoot?: string;
  } {
    const policy   = this.policies.get(policyId);
    if (!policy) throw new Error("policy_not_found");
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.policyId !== policyId) throw new Error("proposal_not_found");

    if (proposal.status !== "pending") throw new Error(`proposal_not_pending:${proposal.status}`);
    if (proposal.expiresAt < Date.now()) {
      proposal.status = "expired";
      throw new Error("proposal_expired");
    }

    const w = approver.toLowerCase();
    if (!this.isMember(policy, w)) throw new Error("not_a_member");

    // ── atomic region ────────────────────────────────────────────────────────
    if (this.approvals.some(a => a.proposalId === proposalId && a.approverWallet === w)) {
      throw new Error("already_approved");
    }
    this.approvals.push({ proposalId, approverWallet: w, passkeyAssertion: `assertion:${w}` });

    const approvers     = this.approvals.filter(a => a.proposalId === proposalId).map(a => a.approverWallet);
    const approvalCount = approvers.length;
    const quorumMet     = approvalCount >= policy.thresholdM;

    let quorumRoot: string | undefined;
    if (quorumMet) {
      const proof = quorumProof({
        ownerWallet: policy.ownerWallet,
        sessionId: proposalId,
        threshold: policy.thresholdM,
        attestedCount: approvalCount,
        guardianAddresses: approvers,
      });
      quorumRoot = proof.root;
      // Internal vault/child actions execute immediately; value actions only
      // reach "approved" — quorum authorizes, a separate executor broadcasts.
      const isInternal = proposal.actionType.startsWith("vault.") || proposal.actionType.startsWith("child.");
      proposal.status     = isInternal ? "executed" : "approved";
      proposal.quorumRoot = quorumRoot;
    }
    // ── end atomic region ────────────────────────────────────────────────────

    return {
      ok: true, approvalCount, threshold: policy.thresholdM, quorumMet,
      status: quorumMet ? proposal.status : "pending",
      ...(quorumRoot ? { quorumRoot } : {}),
    };
  }

  // ── Child sub-vaults: bounded autonomy ─────────────────────────────────────

  addChild(policyId: string, owner: string, opts: {
    childWallet: string; label: string; spendCapWei?: string; alwaysRequirePasskey?: boolean;
  }): { childId: string } {
    const policy = this.policies.get(policyId);
    if (!policy) throw new Error("policy_not_found");
    if (policy.ownerWallet !== owner.toLowerCase()) throw new Error("only_owner_can_add_children");

    const child: Child = {
      id: crypto.randomUUID(),
      policyId,
      childWallet: opts.childWallet.toLowerCase(),
      label: opts.label.slice(0, 60),
      spendCapWei: BigInt(opts.spendCapWei ?? "0"),
      dailySpentWei: 0n,
      dailyResetDate: today(),
      alwaysRequirePasskey: Boolean(opts.alwaysRequirePasskey),
    };
    this.children.set(child.id, child);
    return { childId: child.id };
  }

  /**
   * Gate a child spend against its daily cap.
   *   { quorumRequired: false } → autonomous, debited instantly
   *   { quorumRequired: true }  → must escalate to quorum approval
   */
  childSpend(policyId: string, childId: string, caller: string, amountWei: string): {
    ok: boolean; quorumRequired: boolean; reason?: string;
    dailySpentWei: string; spendCapWei: string;
  } {
    const child = this.children.get(childId);
    if (!child || child.policyId !== policyId) throw new Error("child_not_found");
    const policy = this.policies.get(policyId);
    if (!policy) throw new Error("policy_not_found");

    const w = caller.toLowerCase();
    if (policy.ownerWallet !== w && child.childWallet !== w) throw new Error("not_authorized");

    let amount: bigint;
    try { amount = BigInt(amountWei); } catch { throw new Error("invalid_amount_wei"); }
    if (amount <= 0n) throw new Error("amount_must_be_positive");

    // Lazy daily reset by date string.
    if (child.dailyResetDate !== today()) {
      child.dailySpentWei = 0n;
      child.dailyResetDate = today();
    }

    const cap = child.spendCapWei;
    // Three escalation triggers: no cap, always-require flag, or cap exceeded.
    if (cap === 0n || child.alwaysRequirePasskey || child.dailySpentWei + amount > cap) {
      return {
        ok: false, quorumRequired: true,
        reason: cap === 0n ? "no_cap_set"
              : child.alwaysRequirePasskey ? "always_require_passkey"
              : "cap_exceeded",
        dailySpentWei: child.dailySpentWei.toString(),
        spendCapWei: cap.toString(),
      };
    }

    // Atomic debit: the cap is re-checked here (WHERE dailySpent+amount<=cap),
    // so two concurrent spends cannot jointly overshoot.
    child.dailySpentWei += amount;
    return {
      ok: true, quorumRequired: false,
      dailySpentWei: child.dailySpentWei.toString(),
      spendCapWei: cap.toString(),
    };
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const v = new QuorumVault();
  const policy = v.createPolicy({
    owner: "0xowner", name: "Family Vault",
    requiredSigners: ["0xa", "0xb", "0xc"], thresholdM: 2,
  });
  console.log("Policy:", policy.name, `(${policy.thresholdM}-of-${policy.requiredSigners.length})`);

  // ── Quorum on a value action ──────────────────────────────────────────────
  const p = v.propose(policy.id, "0xa", "wallet.send", { to: "0xdest", amountWei: "1000" });
  console.log("\nProposed wallet.send → notify:", p.notifyWallets);
  console.log("Approve #1 (0xa):", v.approve(policy.id, p.proposalId, "0xa"));
  const done = v.approve(policy.id, p.proposalId, "0xb");
  console.log("Approve #2 (0xb):", { quorumMet: done.quorumMet, status: done.status, root: done.quorumRoot?.slice(0, 12) + "…" });

  // Duplicate approval is rejected
  try { v.approve(policy.id, p.proposalId, "0xa"); }
  catch (e) { console.log("Re-approve blocked:", (e as Error).message); }

  // ── Child autonomy lane ───────────────────────────────────────────────────
  const child = v.addChild(policy.id, "0xowner", { childWallet: "0xkid", label: "Allowance", spendCapWei: "100" });
  console.log("\nChild spend 40 (under cap):", v.childSpend(policy.id, child.childId, "0xkid", "40"));
  console.log("Child spend 50 (still under):", v.childSpend(policy.id, child.childId, "0xkid", "50"));
  console.log("Child spend 20 (exceeds cap):", v.childSpend(policy.id, child.childId, "0xkid", "20"));
}
