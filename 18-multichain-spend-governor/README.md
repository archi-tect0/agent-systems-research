# Multi-Chain Spend Governor (velocity limits + fail-closed pricing + guardian freeze)


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A wallet holds assets on many chains — Bitcoin, Solana (and its SPL tokens), TRON, and a family of EVM chains — and we want to enforce **one coherent spending policy across all of them**:

- a **per-transaction** cap (no single transfer larger than X),
- a **daily** cap (no more than Y total across all chains per UTC day),
- and a **guardian freeze** that can halt *every* outbound transfer during an incident.

The hard part is that the policy is denominated in one unit (ETH-equivalent) but the spends arrive in BTC, lamports, SPL token smallest-units, swap inputs, TRX, and native EVM value. To enforce a unified daily total you must **price every spend into the common unit at transfer time** — and pricing is a network call that can fail. The dangerous failure mode is obvious: if "I couldn't get a price" silently becomes "0," every limit evaporates exactly when the oracle is down. So the governor must **fail closed**.

A second subtlety: the system keys timelocks under a *normalized* wallet identifier. If you query the freeze table with the wrong identifier shape, the freeze silently doesn't apply and the user is unprotected. Identifier normalization is a security control, not a formatting nicety.

## Design decisions

**Why one ETH-equivalent unit for all chains.**
A daily cap is only meaningful if it aggregates across chains — otherwise an attacker just spreads a drain over BTC + SOL + TRX to stay under each chain's individual limit. Converting everything to a single numéraire (here, ETH-equivalent) makes "no more than Y per day, total" enforceable regardless of which chains the spends touch.

**Why every price conversion returns `number | null`, never a bare number.**
`nativeChainToEth`, `splTokenToEth`, and `swapInputToEth` all return `null` when pricing is unavailable — unsupported token, oracle timeout, missing field, zero divisor. **Callers must treat `null` as a hard block, never as zero.** This is the central fail-closed invariant: an unpriceable spend is an *unboundable* spend, and an unboundable spend cannot be allowed under a value-denominated policy. Returning `0` would mean "this transfer counts for nothing against your limits," which is precisely the bypass we must prevent.

**Why unknown tokens are rejected, not estimated.**
`swapInputToEth` looks up token decimals in an explicit allow-list (`KNOWN_SPL_DECIMALS`). A token not in the list returns `null`. Guessing decimals would mis-scale the amount by orders of magnitude; refusing to price an unknown token is the safe default. Same philosophy for SPL pricing: only tokens the system can confidently price are spendable through the governed path.

**Why the daily total counts `pending` + `confirmed` + `executed`.**
The daily accumulator sums transactions in *all three* in-flight/settled states since UTC midnight — not just confirmed ones. If it counted only confirmed transactions, an attacker could fire many transactions in quick succession (all still `pending`) and blow past the daily cap before any confirms. Counting pending spends against the limit closes that race.

**Why UTC midnight, not local time.**
The daily window resets at `setUTCHours(0,0,0,0)`. A fixed, timezone-independent boundary means the limit can't be doubled by riding a local-midnight rollover, and it is unambiguous across a globally distributed system.

**Why the guardian timelock blocks *all* outbound transfers unconditionally.**
When a guardian timelock is active (not executed, not cancelled), `checkVelocity` returns `timelock_active` and the transfer is blocked regardless of amount — even a 1-wei transfer, even under all limits. A freeze is a freeze: during an incident the safe action is to stop everything, not to keep allowing "small" spends.

**Why wallet-identifier normalization is mandatory before the freeze lookup.**
Timelocks are stored under the *bare* user ID, with any `passkey:` prefix stripped. The governor calls `normalizeWalletForTimelock()` before querying the freeze table. Skip this and a passkey-account holder's freeze would be stored under one identifier but looked up under another — the freeze would silently not match, leaving the account unprotected. The normalization is what makes the freeze actually apply.

**Why the velocity policy is checked before the freeze, but both gate the spend.**
Per-tx and daily caps are cheap, local checks; the freeze is a separate table lookup. Either failing blocks the spend. The order is an optimization; the semantics are AND.

## Algorithm

```
checkVelocity(wallet, amountEth):
    policy = getOrCreatePolicy(wallet)          # defaults exist for every wallet
    if policy.enabled:
        if amountEth > policy.perTxLimit:
            block "per_tx_limit_exceeded"
        spent = sum(amountEth) of txs in {pending,confirmed,executed}
                where queuedAt >= UTC_midnight
        if spent + amountEth > policy.dailyLimit:
            block "daily_limit_exceeded"
    # Freeze: stored under the NORMALIZED id (passkey: prefix stripped)
    lock = activeTimelock(normalizeWalletForTimelock(wallet))
    if lock:
        block "timelock_active"     # blocks ALL outbound, any amount
    allow

priceToEth(chain, amount) -> number | null:
    convert via oracle; return null on any failure
    # caller: null  ==>  HARD BLOCK (never treat as 0)
```

To govern a spend on any chain: price the native/token amount to ETH-equivalent (block if `null`), then run `checkVelocity`.

## Reference implementation

See [`spend-governor.ts`](./spend-governor.ts) in this directory.

It reproduces the policy machine exactly — per-tx and daily caps, the three-state daily accumulator with a UTC-midnight window, fail-closed `number | null` pricing, the unknown-token allow-list, identifier normalization, and the all-blocking guardian freeze — over an in-memory ledger. The live oracle HTTP calls are replaced by an injectable price source so the logic is deterministic and runnable offline; the fail-closed contract (a `null` price hard-blocks) is preserved.

Dependencies: Node.js built-in `crypto` only.

## Usage

```typescript
import { SpendGovernor } from "./spend-governor.js";

const gov = new SpendGovernor({
  prices: { btc: 60000, sol: 150, trx: 0.12, eth: 3000 },   // null = unpriceable
});
gov.setPolicy("user-wallet", { perTxLimitEth: 1, dailyLimitEth: 3, enabled: true });

// Price a BTC spend into ETH-equivalent, then govern it
const eth = gov.nativeChainToEth("btc", 0.01);   // → number | null
if (eth === null) throw new Error("unpriceable → hard block");
const result = gov.checkVelocity("user-wallet", eth);
// → { ok: true }  or  { ok: false, reason, details }

// Freeze everything during an incident
gov.setGuardianTimelock("user-wallet", "suspected_compromise");
gov.checkVelocity("user-wallet", 0.0001);
// → { ok: false, reason: "timelock_active" }   (blocks ANY amount)
```

## Limitations and extensions

- **Oracle availability becomes a liveness dependency.** Because pricing fails closed, an oracle outage blocks *all* cross-chain spends through the governed path. That is the correct safety trade-off, but it means you should run redundant price sources and cache last-known-good prices with a freshness bound — never fall back to zero.
- **Price manipulation is a residual risk.** A manipulated oracle could under-price a spend so it slips under the cap. Use multiple independent sources and sanity bounds; treat wild deltas as `null` (fail closed).
- **Per-tx + daily caps don't bound *count*.** Many tiny spends each under the per-tx cap can still be annoying (gas drain) even if the daily ETH cap holds. Add a transaction-count limit if needed.
- **The daily window is a hard UTC boundary.** A burst straddling midnight can spend up to the cap on each side. Tighten with a rolling 24-hour window if that matters for your threat model.
- **Normalization must match wherever timelocks are written.** The freeze lookup is only correct if writers store under the same normalized identifier. Keep `normalizeWalletForTimelock` the single source of truth and call it on both the read and write paths.
- **Stubbed pricing/ledger.** Production uses live CoinGecko / Jupiter quotes and a real `wallet_transactions` table; the reference file injects prices and uses an in-memory ledger to stay self-contained.
