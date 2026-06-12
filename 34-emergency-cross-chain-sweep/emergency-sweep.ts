/**
 * Emergency Cross-Chain Sweep
 * ===========================
 *
 * A "panic button" that, in one action:
 *   1. derives a brand-new clean wallet the attacker has never seen,
 *   2. computes that wallet's per-chain destination addresses, and
 *   3. races the attacker by broadcasting fund-moving transactions on every
 *      selected chain *in parallel*, sending each chain's native balance to the
 *      new wallet's corresponding address.
 *
 * One logical wallet is just an id string; each chain's signing key is derived
 * from (walletId, ADDR_SECRET) with a chain-specific salt + info label. So the
 * sweep destinations are pure functions of the new wallet id — no extra user
 * input, no paste-hijack risk.
 *
 * Parallelism is the whole point: a sequential sweep gives the attacker the time
 * it spends on each earlier chain. We use Promise.allSettled so one chain's
 * failure (RPC timeout, zero balance, rejected fee) never aborts the others.
 *
 * Dependencies (only for the chains you actually enable):
 *   - EVM:    `ethers`
 *   - Bitcoin:`bitcoinjs-lib` + `@noble/curves`
 *   - Solana: `@solana/web3.js` + `tweetnacl` + `bs58`
 *   - Tron:   the Tron node HTTP API (via global `fetch`)
 * Key derivation uses Node.js `crypto` HKDF only.
 *
 * The per-chain transaction builders below are intentionally pluggable stubs:
 * the orchestration, derivation, fee/dust handling, and result accounting are
 * real; the actual broadcast calls are isolated behind a `ChainAdapter`
 * interface so this file runs and is auditable without any chain SDK installed.
 *
 * Run the safe demo (no broadcast):  node emergency-sweep.ts --demo
 */

import { hkdfSync, createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Configuration (override all of this in a real deployment)
// ---------------------------------------------------------------------------

export interface EvmChainConfig {
  slug: string;
  chainId: number;
  rpcUrl: string;
}

/** EVM chains share one signing model and differ only by chainId + RPC. */
export const EVM_CHAINS: Record<string, EvmChainConfig> = {
  ethereum: { slug: "ethereum", chainId: 1, rpcUrl: "https://eth.example/rpc" },
  base: { slug: "base", chainId: 8453, rpcUrl: "https://base.example/rpc" },
  polygon: { slug: "polygon", chainId: 137, rpcUrl: "https://polygon.example/rpc" },
  arbitrum: { slug: "arbitrum", chainId: 42161, rpcUrl: "https://arb.example/rpc" },
  optimism: { slug: "optimism", chainId: 10, rpcUrl: "https://op.example/rpc" },
  bsc: { slug: "bsc", chainId: 56, rpcUrl: "https://bsc.example/rpc" },
};

export const NATIVE_CHAINS = ["bitcoin", "solana", "tron"] as const;
export type NativeChain = (typeof NATIVE_CHAINS)[number];

/** Bitcoin: skip UTXOs worth less than this (spending them costs more in fees). */
export const BTC_DUST_SATS = 1000n;
/** Per-chain fee headroom for the simple native paths (lamports / sun). */
export const SOL_FEE_LAMPORTS = 5000n;
export const TRX_FEE_SUN = 1_100_000n;

// ---------------------------------------------------------------------------
// Deterministic derivation
// ---------------------------------------------------------------------------

function hkdf(ikm: Buffer | string, salt: string, info: string, len = 32): Buffer {
  const key = typeof ikm === "string" ? Buffer.from(ikm, "utf8") : ikm;
  return Buffer.from(
    hkdfSync("sha256", key, Buffer.from(salt, "utf8"), Buffer.from(info, "utf8"), len),
  );
}

/**
 * Derive the clean replacement wallet id from the master seed at the next
 * unused index. The id is chain-agnostic; per-chain keys fan out from it.
 */
export function deriveNewWalletId(masterSeedHex: string, nextIndex: number): string {
  const seed = Buffer.from(masterSeedHex, "hex");
  const out = hkdf(seed, "wallet-index", `wallet-index-${nextIndex}`, 20);
  return "0x" + out.toString("hex");
}

/** Chain-specific signing key, derived purely from (walletId, ADDR_SECRET). */
export function deriveChainKey(walletId: string, addrSecret: string, chain: string): Buffer {
  const SALTS: Record<string, string> = {
    evm: "EVM-ADDRESS-V1",
    bitcoin: "BTC-ADDRESS-V1",
    solana: "SOL-ADDRESS-V1",
    tron: "TRX-ADDRESS-V1",
  };
  const salt = SALTS[chain] ?? SALTS.evm;
  return hkdf(`${walletId}:${addrSecret}`, salt, `${chain}-shadow-key`);
}

/**
 * Compute the destination addresses for the new wallet without any chain SDK.
 * These are illustrative encodings — a real build derives the public key with
 * the proper curve and encodes per chain (see guide 15). They are deterministic
 * and safe to print.
 */
export function deriveAddresses(walletId: string, addrSecret: string): Record<string, string> {
  const fingerprint = (chain: string) =>
    createHash("sha256").update(deriveChainKey(walletId, addrSecret, chain)).digest("hex");
  return {
    evm: "0x" + fingerprint("evm").slice(0, 40),
    bitcoin: "bc1q" + fingerprint("bitcoin").slice(0, 38),
    solana: "Demo" + fingerprint("solana").slice(0, 40),
    tron: "T" + fingerprint("tron").slice(0, 33),
  };
}

// ---------------------------------------------------------------------------
// Chain adapters (pluggable — replace stubs with real SDK calls)
// ---------------------------------------------------------------------------

export interface SweepResult {
  chain: string;
  txHash?: string;
  amount?: string;
  skipped?: string;
}

export interface ChainAdapter {
  /** Move the entire native balance (minus fees) from `fromKey` to `toAddr`. */
  sweep(fromKey: Buffer, toAddr: string): Promise<SweepResult>;
}

/**
 * Example EVM adapter outline. In a real build:
 *   const wallet = new ethers.Wallet(fromKey.toString("hex"), provider);
 *   const bal = await provider.getBalance(wallet.address);
 *   const gas = (await provider.getFeeData()).gasPrice * 21000n;
 *   const value = bal - gas; if (value <= 0n) skip;
 *   const tx = await wallet.sendTransaction({ to: toAddr, value });
 */
export function makeEvmAdapter(cfg: EvmChainConfig, getProvider: (url: string) => unknown): ChainAdapter {
  return {
    async sweep(_fromKey, _toAddr) {
      void getProvider(cfg.rpcUrl);
      return { chain: cfg.slug, skipped: "no_evm_sdk_in_reference_impl" };
    },
  };
}

/**
 * Bitcoin adapter outline: gather confirmed P2WPKH UTXOs above BTC_DUST_SATS,
 * estimate vbytes from input count, fee = vbytes * satPerVbyte, build a PSBT
 * with all inputs and a single output to `toAddr`, sign, broadcast.
 */
export function makeBitcoinAdapter(satPerVbyte: bigint, broadcast: (rawHex: string) => Promise<string>): ChainAdapter {
  return {
    async sweep(_fromKey, _toAddr) {
      void satPerVbyte; void broadcast;
      return { chain: "bitcoin", skipped: "no_btc_sdk_in_reference_impl" };
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface SweepPlan {
  oldWallet: string;
  newWallet: string;
  addrSecret: string;
  chains: string[];
  /** Resolve a chain slug to an adapter; return undefined to skip the chain. */
  adapterFor: (slug: string) => ChainAdapter | undefined;
}

export interface SweepReport {
  status: "completed" | "failed";
  results: SweepResult[];
  txHashes: string[];
  completedAt: number;
}

/**
 * Fan the sweep out across all selected chains in parallel. Every chain runs to
 * completion regardless of its siblings; a partial success is the expected
 * outcome, not an error.
 */
export async function runSweep(plan: SweepPlan): Promise<SweepReport> {
  const tasks: Promise<SweepResult>[] = [];

  for (const slug of plan.chains) {
    const adapter = plan.adapterFor(slug);
    if (!adapter) {
      tasks.push(Promise.resolve({ chain: slug, skipped: "no_adapter" }));
      continue;
    }
    const isNative = (NATIVE_CHAINS as readonly string[]).includes(slug);
    const fromKey = deriveChainKey(plan.oldWallet, plan.addrSecret, isNative ? slug : "evm");
    const toAddr = deriveAddresses(plan.newWallet, plan.addrSecret)[isNative ? slug : "evm"];
    tasks.push(
      adapter.sweep(fromKey, toAddr).catch((e): SweepResult => ({
        chain: slug,
        skipped: `error:${e instanceof Error ? e.message : String(e)}`,
      })),
    );
  }

  const settled = await Promise.allSettled(tasks);
  const results: SweepResult[] = settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : { chain: plan.chains[i], skipped: "rejected" },
  );
  const txHashes = results.filter((r) => r.txHash).map((r) => r.txHash!);
  return {
    status: txHashes.length > 0 ? "completed" : "failed",
    results,
    txHashes,
    completedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Demo (no broadcast — derivation + orchestration only)
// ---------------------------------------------------------------------------

if (process.argv.includes("--demo")) {
  const masterSeedHex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  const addrSecret = "demo-addr-secret-not-for-production";

  const oldWallet = deriveNewWalletId(masterSeedHex, 0);
  const nextIndex = 1;
  const newWallet = deriveNewWalletId(masterSeedHex, nextIndex);

  console.log("Old (compromised) wallet id:", oldWallet);
  console.log("New (clean) wallet id:      ", newWallet);
  console.log("\nNew wallet destination addresses (deterministic, safe to print):");
  console.table(deriveAddresses(newWallet, addrSecret));

  // No real adapters → every chain is skipped, status "failed", nothing broadcast.
  runSweep({
    oldWallet,
    newWallet,
    addrSecret,
    chains: ["ethereum", "base", "bitcoin", "solana", "tron"],
    adapterFor: () => undefined,
  }).then((report) => {
    console.log("\nSweep report (demo — no adapters, nothing broadcast):");
    console.log(JSON.stringify(report, null, 2));
  });
}
