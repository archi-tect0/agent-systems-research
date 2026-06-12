/**
 * Multi-Chain Spend Governor
 *
 * Enforces ONE spending policy across many chains (BTC / SOL / SPL tokens /
 * TRON / EVM):
 *   - per-transaction cap
 *   - daily cap (aggregate across all chains, UTC-midnight window)
 *   - guardian freeze that blocks ALL outbound transfers, any amount
 *
 * Two invariants matter most:
 *
 *   1. FAIL-CLOSED PRICING. Every price conversion returns `number | null`.
 *      `null` means "unpriceable" and callers MUST treat it as a hard block —
 *      never as 0. An unpriceable spend is an unboundable spend, and an
 *      unboundable spend cannot be allowed under a value-denominated policy.
 *
 *   2. IDENTIFIER NORMALIZATION. Timelocks are keyed under the bare user id
 *      (passkey: prefix stripped). The freeze lookup MUST normalize first, or
 *      the freeze silently fails to match and the account is unprotected.
 *
 * The daily accumulator counts pending + confirmed + executed transactions so a
 * burst of still-pending spends cannot outrun the cap.
 *
 * Live oracle HTTP calls are replaced by an injectable price source so the
 * logic is deterministic and runnable offline. The fail-closed contract is kept.
 *
 * Dependencies: Node.js built-in "crypto" only.
 */

import crypto from "crypto";

// ── Identifier normalization (security control, not formatting) ───────────────

export function normalizeWalletForTimelock(wallet: string): string {
  return wallet.startsWith("passkey:") ? wallet.slice(8) : wallet;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type TxStatus = "pending" | "confirmed" | "executed" | "failed" | "cancelled";

export interface LedgerTx {
  wallet: string;
  amountEth: number;
  status: TxStatus;
  queuedAt: number;       // ms epoch
}

export interface Policy {
  perTxLimitEth: number;
  dailyLimitEth: number;
  enabled: boolean;
}

export type VelocityResult =
  | { ok: true }
  | {
      ok: false;
      reason: "per_tx_limit_exceeded" | "daily_limit_exceeded" | "timelock_active";
      details: string;
    };

/** Injectable price source. A missing key (undefined) means "unpriceable". */
export interface PriceSource {
  btc?: number;
  sol?: number;
  trx?: number;
  eth?: number;
}

export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

/** Only tokens with KNOWN decimals are spendable; others fail closed. */
export const KNOWN_SPL_DECIMALS: Record<string, number> = {
  "So11111111111111111111111111111111111111112": 9, // SOL (lamports)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6, // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": 6, // USDT
};

// ── Governor ─────────────────────────────────────────────────────────────────

export class SpendGovernor {
  private readonly prices: PriceSource;
  /** Whole-token price in USD for known SPL mints (stub for Jupiter). */
  private readonly splUsd: Record<string, number>;
  private readonly policies = new Map<string, Policy>();
  private readonly ledger: LedgerTx[] = [];
  private readonly freezes = new Map<string, string>(); // normalizedWallet → action

  constructor(opts: { prices: PriceSource; splUsd?: Record<string, number> }) {
    this.prices = opts.prices;
    this.splUsd = opts.splUsd ?? {
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 1, // USDC
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 1, // USDT
    };
  }

  setPolicy(wallet: string, p: Policy): void {
    this.policies.set(wallet, p);
  }

  private getOrCreatePolicy(wallet: string): Policy {
    let p = this.policies.get(wallet);
    if (!p) {
      p = { perTxLimitEth: 0.1, dailyLimitEth: 0.5, enabled: true };
      this.policies.set(wallet, p);
    }
    return p;
  }

  /** Record a spend in the shared ledger so daily accounting stays accurate. */
  record(tx: { wallet: string; amountEth: number; status?: TxStatus }): void {
    this.ledger.push({
      wallet: tx.wallet,
      amountEth: tx.amountEth > 0 ? tx.amountEth : 0,
      status: tx.status ?? "pending",
      queuedAt: Date.now(),
    });
  }

  /** Activate a guardian freeze (stored under the NORMALIZED identifier). */
  setGuardianTimelock(wallet: string, action: string): void {
    this.freezes.set(normalizeWalletForTimelock(wallet), action);
  }

  clearGuardianTimelock(wallet: string): void {
    this.freezes.delete(normalizeWalletForTimelock(wallet));
  }

  // ── Fail-closed pricing — every method returns number | null ───────────────

  nativeChainToEth(chain: "btc" | "sol" | "trx", amount: number): number | null {
    if (amount <= 0) return 0;
    const chainUsd = this.prices[chain];
    const ethUsd   = this.prices.eth;
    if (!chainUsd || !ethUsd || ethUsd === 0) return null; // fail closed
    return (amount * chainUsd) / ethUsd;
  }

  splTokenToEth(mintAddress: string, humanAmount: number): number | null {
    if (humanAmount <= 0) return 0;
    if (mintAddress === NATIVE_SOL_MINT) return this.nativeChainToEth("sol", humanAmount);
    const tokenUsd = this.splUsd[mintAddress];
    const ethUsd   = this.prices.eth;
    if (!tokenUsd || !ethUsd || ethUsd === 0) return null; // unsupported/unpriceable → fail closed
    return (humanAmount * tokenUsd) / ethUsd;
  }

  swapInputToEth(mintAddress: string, amountSmallest: number): number | null {
    if (amountSmallest <= 0) return 0;
    if (mintAddress === NATIVE_SOL_MINT) return this.nativeChainToEth("sol", amountSmallest / 1e9);
    const decimals = KNOWN_SPL_DECIMALS[mintAddress];
    if (decimals === undefined) return null; // unknown token → fail closed (never guess decimals)
    return this.splTokenToEth(mintAddress, amountSmallest / Math.pow(10, decimals));
  }

  // ── Daily accumulator: pending + confirmed + executed since UTC midnight ────

  private dailySpentEth(wallet: string): number {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const startMs = start.getTime();
    return this.ledger
      .filter(t =>
        t.wallet === wallet &&
        (t.status === "pending" || t.status === "confirmed" || t.status === "executed") &&
        t.queuedAt >= startMs,
      )
      .reduce((sum, t) => sum + t.amountEth, 0);
  }

  // ── The gate ───────────────────────────────────────────────────────────────

  checkVelocity(wallet: string, amountEth: number): VelocityResult {
    const policy = this.getOrCreatePolicy(wallet);

    if (policy.enabled) {
      if (amountEth > policy.perTxLimitEth) {
        return {
          ok: false,
          reason: "per_tx_limit_exceeded",
          details: `Amount ${amountEth.toFixed(6)} ETH exceeds the per-tx limit of ${policy.perTxLimitEth} ETH`,
        };
      }
      const spent = this.dailySpentEth(wallet);
      if (spent + amountEth > policy.dailyLimitEth) {
        return {
          ok: false,
          reason: "daily_limit_exceeded",
          details: `This transaction would bring today's total to ${(spent + amountEth).toFixed(6)} ETH, ` +
                   `exceeding the daily limit of ${policy.dailyLimitEth} ETH (${spent.toFixed(6)} ETH already sent today)`,
        };
      }
    }

    // Freeze: look up under the NORMALIZED id. Blocks ALL outbound, any amount.
    const action = this.freezes.get(normalizeWalletForTimelock(wallet));
    if (action) {
      return {
        ok: false,
        reason: "timelock_active",
        details: `A guardian timelock for action "${action}" is pending. Outbound transactions are blocked until it is executed or cancelled.`,
      };
    }

    return { ok: true };
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const gov = new SpendGovernor({ prices: { btc: 60000, sol: 150, trx: 0.12, eth: 3000 } });
  gov.setPolicy("user-wallet", { perTxLimitEth: 1, dailyLimitEth: 3, enabled: true });

  // Price a BTC spend → ETH-equivalent, then govern it
  const ethEq = gov.nativeChainToEth("btc", 0.01)!; // 0.01 BTC = $600 = 0.2 ETH
  console.log("0.01 BTC ≈", ethEq.toFixed(4), "ETH");
  gov.record({ wallet: "user-wallet", amountEth: ethEq });
  console.log("Spend 1:", gov.checkVelocity("user-wallet", ethEq));

  // Per-tx cap: a 0.5 BTC spend ≈ 10 ETH > 1 ETH per-tx limit
  const big = gov.nativeChainToEth("btc", 0.5)!;
  console.log("\n0.5 BTC ≈", big.toFixed(2), "ETH →", gov.checkVelocity("user-wallet", big));

  // Fail-closed: oracle down for ETH → null price must hard-block
  const broke = new SpendGovernor({ prices: { btc: 60000 /* eth missing */ } });
  const price = broke.nativeChainToEth("btc", 0.01);
  console.log("\nOracle down →", price, "(caller must hard-block, never treat as 0)");

  // Unknown SPL token → fail closed
  console.log("Unknown token swap →", gov.swapInputToEth("UnknownMint1111111111111111111111111111111", 1_000_000));

  // Guardian freeze blocks any amount — even with a passkey: prefixed id
  gov.setGuardianTimelock("passkey:user-wallet", "suspected_compromise");
  console.log("\nFrozen (1 wei):", gov.checkVelocity("passkey:user-wallet", 0.000000001));
}
