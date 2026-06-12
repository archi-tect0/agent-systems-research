/**
 * Agent Spend-Limit Wallet
 *
 * A wallet an autonomous agent can spend from on its own — but only within
 * bounds. Three tiers:
 *   amount > ceiling         → rejected outright (hard wall, no override)
 *   threshold < amt ≤ ceiling → pending, requires a human passkey approval
 *   amount ≤ threshold        → queued, auto-executed (no human)
 *
 * Key properties reproduced from the production design:
 *   - The signing key is DERIVED on demand via HKDF-SHA256, never stored.
 *   - The PASSKEY FLOOR: a stolen session token alone cannot broadcast — the
 *     approve step demands a fresh WebAuthn assertion bound to the tx id.
 *   - The approval is an ATOMIC conditional transition (UPDATE…WHERE
 *     status='pending'), so concurrent approvals can never double-spend.
 *
 * The on-chain broadcast and the @simplewebauthn/server verification are
 * STUBBED so this file is self-contained and runnable. The cryptographic shape
 * (derivation, single-use tx-bound assertion, atomic claim) is exact.
 *
 * Dependencies: Node.js built-in "crypto" only.
 */

import crypto from "crypto";

// ── Key derivation (same shadow-derivation pattern, agent role) ───────────────

function deriveAgentKey(rootWallet: string, addrSecret: string): string {
  const ikm     = Buffer.from(`agent:${rootWallet}:${addrSecret}`);
  const derived = crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), "AGENT-WALLET-V1", 32);
  return "0x" + Buffer.from(derived).toString("hex");
}

/** Deterministic pseudo-address derived from the key (stands in for the signer). */
function addressFromKey(privKeyHex: string): string {
  const h = crypto.createHash("sha256").update(privKeyHex).digest("hex");
  return "0x" + h.slice(0, 40);
}

// ── Types ────────────────────────────────────────────────────────────────────

export type TxStatus = "queued" | "pending" | "approved" | "executed" | "failed" | "rejected";

export interface SpendConfig {
  thresholdEth: number;   // trust budget the user grants the agent
  ceilingEth: number;     // absolute max the user will ever lose to one tx
  enabled: boolean;
}

export interface AgentTx {
  id: string;
  amountEth: number;
  recipient: string;
  reason: string;
  status: TxStatus;
  txHash?: string;
}

/** Stand-in for a verified WebAuthn assertion. Production: @simplewebauthn/server. */
export interface PasskeyAssertion {
  txId: string;            // the assertion must be bound to this tx id
  valid: boolean;          // result of the real verifier
}

// ── Wallet ───────────────────────────────────────────────────────────────────

export class AgentWallet {
  readonly address: string;
  private readonly privKey: string;
  private config: SpendConfig = { thresholdEth: 0, ceilingEth: 0, enabled: false };
  private readonly txs = new Map<string, AgentTx>();
  private readonly consumedChallenges = new Set<string>();

  constructor(rootWallet: string, addrSecret: string) {
    this.privKey = deriveAgentKey(rootWallet, addrSecret);
    this.address = addressFromKey(this.privKey);
  }

  configure(cfg: Partial<SpendConfig>): void {
    if (cfg.thresholdEth !== undefined) {
      if (!isFinite(cfg.thresholdEth) || cfg.thresholdEth < 0) throw new Error("thresholdEth_invalid");
      this.config.thresholdEth = cfg.thresholdEth;
    }
    if (cfg.ceilingEth !== undefined) {
      if (!isFinite(cfg.ceilingEth) || cfg.ceilingEth <= 0) throw new Error("ceilingEth_invalid");
      this.config.ceilingEth = cfg.ceilingEth;
    }
    if (cfg.enabled !== undefined) this.config.enabled = cfg.enabled;
  }

  /** Agent proposes a spend. Returns the tier outcome. */
  spend(req: { amountEth: number; recipient: string; reason: string }): { txId: string; status: TxStatus } {
    if (!this.config.enabled) throw new Error("SPEND_WALLET_DISABLED");
    if (!req.amountEth || !req.recipient || !req.reason) throw new Error("amount_recipient_reason_required");

    // Hard wall first — unconditional, no assertion can ever override it.
    if (req.amountEth > this.config.ceilingEth) throw new Error("EXCEEDS_CEILING");

    const requiresApproval = req.amountEth > this.config.thresholdEth;
    const status: TxStatus = requiresApproval ? "pending" : "queued";

    const tx: AgentTx = {
      id: crypto.randomUUID(),
      amountEth: req.amountEth,
      recipient: req.recipient.toLowerCase(),
      reason: req.reason,
      status,
    };
    this.txs.set(tx.id, tx);

    // Sub-threshold spends auto-execute immediately (no human in the loop).
    if (!requiresApproval) this.broadcast(tx);

    return { txId: tx.id, status: tx.status };
  }

  /**
   * Human approves a pending spend. THE PASSKEY FLOOR: a valid assertion bound
   * to this exact tx id is mandatory — a session token alone is not enough.
   */
  approve(txId: string, assertion: PasskeyAssertion): { ok: true; txHash?: string } {
    // 1. Verify the WebAuthn assertion (stub of @simplewebauthn/server).
    if (!assertion || assertion.txId !== txId || !assertion.valid) {
      throw new Error("webauthn_failed");
    }
    // 2. Single-use: a verified assertion/challenge cannot be replayed.
    const challengeKey = `agent-approve:${txId}`;
    if (this.consumedChallenges.has(challengeKey)) throw new Error("challenge_already_consumed");

    // 3. Atomic conditional claim — only the first caller flips pending→approved.
    const tx = this.txs.get(txId);
    if (!tx) throw new Error("transaction_not_found");
    if (tx.status !== "pending") throw new Error(`already_${tx.status}`);
    tx.status = "approved";
    this.consumedChallenges.add(challengeKey);

    // 4. Broadcast only AFTER the atomic claim.
    this.broadcast(tx);
    return { ok: true, txHash: tx.txHash };
  }

  reject(txId: string): { ok: true } {
    const tx = this.txs.get(txId);
    if (tx && (tx.status === "pending" || tx.status === "queued")) tx.status = "rejected";
    return { ok: true };
  }

  history(): AgentTx[] {
    return [...this.txs.values()];
  }

  /** Stub for on-chain broadcast. Production: ethers signer + provider. */
  private broadcast(tx: AgentTx): void {
    try {
      tx.txHash = "0x" + crypto.randomBytes(32).toString("hex");
      tx.status = "executed";
    } catch {
      tx.status = "failed";
    }
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const w = new AgentWallet("user-root-wallet", "demo-server-secret");
  w.configure({ thresholdEth: 0.05, ceilingEth: 1.0, enabled: true });
  console.log("Agent wallet address:", w.address);

  // Tier 3: under threshold → auto-executes
  const small = w.spend({ amountEth: 0.01, recipient: "0xabc", reason: "API top-up" });
  console.log("\nSmall spend:", small.status, "(auto-executed)");

  // Tier 2: over threshold → pending, needs human approval
  const big = w.spend({ amountEth: 0.5, recipient: "0xdef", reason: "invoice" });
  console.log("Large spend:", big.status, "(needs approval)");

  // Passkey floor: a stolen token (no/invalid assertion) cannot approve
  try {
    w.approve(big.txId, { txId: big.txId, valid: false });
  } catch (e) {
    console.log("  Stolen-token approve blocked:", (e as Error).message);
  }

  // Valid passkey assertion approves and broadcasts
  const ok = w.approve(big.txId, { txId: big.txId, valid: true });
  console.log("  Approved with passkey →", ok.txHash?.slice(0, 14) + "…");

  // Double-spend guard: a second approval finds no pending row
  try {
    w.approve(big.txId, { txId: big.txId, valid: true });
  } catch (e) {
    console.log("  Double-approve blocked:", (e as Error).message);
  }

  // Tier 1: hard wall — no assertion can ever unlock above the ceiling
  try {
    w.spend({ amountEth: 5, recipient: "0x000", reason: "oops" });
  } catch (e) {
    console.log("\nCeiling wall:", (e as Error).message);
  }
}
