# Emergency Cross-Chain Sweep

## Problem

A wallet is compromised — a seed phrase phished, a malicious approval signed, a device stolen with keys on it. The user has minutes, sometimes seconds, before an attacker drains everything. Worse, a single deterministic wallet often controls *addresses on many chains at once* (the same key material derives Bitcoin, EVM, Solana, and Tron addresses). The attacker can sweep all of them; so must the defender.

The emergency response is a **panic button**: with one action, (1) derive a brand-new clean wallet the attacker has never seen, (2) mark the old wallet compromised, and (3) race the attacker by broadcasting fund-moving transactions on *every* selected chain in parallel, sending each chain's balance to the new wallet's corresponding address. Speed and parallelism are the whole point — a sequential sweep gives the attacker the time it spends on each earlier chain.

## Design decisions

**Why derive a new deterministic wallet instead of asking the user for a destination?**
In a panic, the user may not have a safe address ready, and typing one invites a paste-hijack or a fat-finger to an attacker address. Deriving the new wallet from the user's master seed at the next unused index gives a destination that is (a) instantly available, (b) already backed up by the same recovery that protects the master seed, and (c) controlled by the same per-chain derivation, so a single new wallet id yields fresh BTC/EVM/SOL/TRX addresses automatically. The old default is flagged compromised and the new one becomes default in the same step.

**Why a single wallet id that fans out into per-chain keys?**
The new wallet is just an id string derived as `HKDF(masterSeed, "wallet-index-<n>")`. Each chain's signing key is then derived from `(walletId, ADDR_SECRET)` with a chain-specific salt and info label. This keeps the wallet model chain-agnostic — one logical wallet, many chain identities — and means the sweep destination addresses are pure functions of the new id, computable without any extra user input.

**Why `Promise.allSettled` over the chains rather than `Promise.all`?**
Chains fail independently and constantly: an RPC times out, a node rejects a fee, a chain has zero balance. `Promise.all` would reject the whole batch on the first failure, abandoning chains that could have succeeded. `allSettled` lets every chain's sweep run to completion regardless of its siblings, and the orchestrator records a per-chain result (`txHash` or a `skipped` reason). A partial success is the *expected* outcome, not an error.

**Why split native chains from EVM chains?**
EVM chains (Ethereum, Base, Polygon, Arbitrum, Optimism, BSC) share one signing model (secp256k1 + `eth_sendTransaction` semantics) and differ only by chain id and RPC URL — they iterate over a config table. The native chains each need bespoke transaction construction: Bitcoin builds and signs a PSBT spending confirmed UTXOs; Solana builds a `SystemProgram.transfer`; Tron creates and signs a raw transaction via its node API. Separating them keeps the EVM path a tight loop and isolates each native chain's idiosyncrasies.

**Why "send everything minus fees" with careful dust handling?**
A sweep empties an address, so each chain computes `balance - fee` and sends a single output with no change. Bitcoin must additionally skip UTXOs below a dust threshold (spending them costs more in fees than they are worth) and estimate vbytes from the input count to set a fee that gets mined promptly. EVM subtracts `gasPrice × 21000`. Solana and Tron subtract a fixed fee headroom. If `balance - fee` falls to the dust threshold (or to zero for account-model chains), that chain is skipped with a reason rather than broadcasting a transaction that cannot confirm.

**Why respond `202 Accepted` and sweep in the background?**
Broadcasting across many chains, each with multi-second RPC round-trips, can take tens of seconds. Blocking the HTTP response that long is fragile (client timeouts) and pointless (the user just needs to know it started). The endpoint records a swap row with status `sweeping`, kicks off the orchestrator with `setImmediate`, and returns `202` immediately with the new wallet address. The client polls a status endpoint that reports per-chain results as they settle, flipping to `completed` (any tx broadcast) or `failed` (all chains skipped).

**Why keep chain RPC endpoints pluggable?**
The RPC URLs, the dust threshold, and the fee headroom constants are all configuration. Public RPCs rate-limit and occasionally lie; a real deployment swaps in its own nodes. Isolating them as a config table means adding a chain or changing a provider is a data change, not a code change.

## Algorithm

```
POST /wallet/emergency { chains[] }:
  binding = resolveSession(token); reject scoped sessions   // see guide 14
  nextIndex = count(existing wallet indexes for this account)
  newWallet = "0x" + HKDF(masterSeed, "wallet-index-"+nextIndex)[..20]
  register newWallet as default; flag old default compromised
  swap = insert { wallet, newWallet, status: "sweeping", chains }
  setImmediate(() => runSweep(swap.id, oldWallet, newWallet, chains, ADDR_SECRET))
  return 202 { swap, newWallet }

runSweep(oldWallet, newWallet, chains, addrSecret):
  evm    = chains where not native
  native = chains in { bitcoin, solana, tron }
  tasks  = []
  for slug in evm:    tasks.push(sweepEvm(old, new, slug, addrSecret))
  if bitcoin: tasks.push(sweepBtc(old, new, addrSecret))
  if solana:  tasks.push(sweepSolana(old, new, addrSecret))
  if tron:    tasks.push(sweepTron(old, new, addrSecret))
  await Promise.allSettled(tasks)              // independent per chain
  status = anyTxBroadcast ? "completed" : "failed"
  persist { status, txHashes, perChainResults, completedAt }

sweepEvm(old, new, slug, secret):
  key = deriveEvmKey(old, secret); from = address(key)
  bal = getBalance(from); if 0: skip
  gasCost = gasPrice * 21000; amt = bal - gasCost; if amt<=0: skip
  send { to: address(deriveEvmKey(new, secret)), value: amt }

sweepBtc(old, new, secret):
  utxos = confirmed UTXOs of P2WPKH(old) above dust; if none: skip
  fee = vbytes(utxos) * satPerVbyte; amt = sum(utxos) - fee; if amt<=dust: skip
  build PSBT (all inputs → single output to P2WPKH(new)), sign, broadcast

sweepSolana / sweepTron: analogous — balance - fixed fee, single transfer.
```

Each chain reports `{ txHash, amount }` on success or `{ skipped: reason }` on no-op/failure; the orchestrator never lets one chain's failure stop the others.

## Reference implementation

See [`emergency-sweep.ts`](./emergency-sweep.ts) in this directory.

External dependencies (only those needed for the chains you enable): `ethers` (EVM), `bitcoinjs-lib` + `@noble/curves` (BTC), `@solana/web3.js` + `tweetnacl` + `bs58` (Solana), and the Tron node HTTP API (via `fetch`). The per-chain key derivation uses Node.js `crypto` HKDF. The chain RPCs and dust/fee constants are config you should override.

> **Note:** the per-chain transaction builders are pluggable `ChainAdapter`s. The derivation, orchestration, fee/dust handling, and result accounting are real, but the bundled adapters are stubs that return `skipped` until you inject adapters wired to real chain SDKs (`ethers`, `bitcoinjs-lib`, `@solana/web3.js`, the Tron node API). Once you do, and point them at mainnet RPCs with a funded key, `runSweep` broadcasts *real* fund-moving transactions. The `--demo` block injects no adapters and broadcasts nothing — it only derives the new wallet and the per-chain destination addresses so you can inspect the deterministic outputs safely.

## Usage

```typescript
import {
  deriveNewWalletId,
  deriveAddresses,
  runSweep,
  makeEvmAdapter,
  makeBitcoinAdapter,
  EVM_CHAINS,
  type ChainAdapter,
} from "./emergency-sweep.js";

// Derive the clean replacement wallet from the master seed + next index.
const newWallet = deriveNewWalletId(masterSeedHex, nextIndex);

// Inspect the destination addresses (no broadcast).
console.log(deriveAddresses(newWallet, process.env.ADDR_SECRET!));

// Wire up adapters for the chains you want to sweep, then fire the parallel
// sweep. With real adapters injected this broadcasts real txs on each chain.
const adapterFor = (slug: string): ChainAdapter | undefined => {
  if (EVM_CHAINS[slug]) return makeEvmAdapter(EVM_CHAINS[slug], makeProvider);
  if (slug === "bitcoin") return makeBitcoinAdapter(satPerVbyte, broadcastBtc);
  return undefined; // chain not enabled → skipped
};

const report = await runSweep({
  oldWallet,
  newWallet,
  addrSecret: process.env.ADDR_SECRET!,
  chains: ["ethereum", "base", "bitcoin", "solana"],
  adapterFor,
});
```

## Limitations and extensions

- **Native-token only.** This sweeps each chain's *native* asset (ETH, BTC, SOL, TRX). ERC-20 / SPL / TRC-20 token balances need per-token transfer calls and are not covered by the native-balance path — add a token-enumeration + transfer step per chain.
- **It is a race, and races can be lost.** If the attacker already holds the keys, they may broadcast first or front-run with higher fees. The sweep maximizes the defender's odds (parallelism, prompt fees) but guarantees nothing once keys are out.
- **Public RPCs are unreliable for emergencies.** Rate limits and timeouts under load are exactly the failure mode you hit during an incident. Use dedicated, paid endpoints for any real deployment.
- **Fee estimation is best-effort.** Static gas limits and simple fee heuristics can underpay during congestion (tx stuck) or overpay. Production should use live fee oracles and consider replace-by-fee.
- **The destination derives from the same master seed.** If the *master seed itself* is compromised (not just one derived key), the new wallet is also compromised. In that case the sweep must target an out-of-band, independently-keyed cold address instead of a derived index.
- **Idempotency.** A double-tapped panic button could create two swaps. Guard with a per-account in-flight lock so a second emergency request joins or rejects rather than racing itself.
