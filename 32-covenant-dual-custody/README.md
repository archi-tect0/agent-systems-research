# Covenant Dual-Custody (paired human + machine identity NFTs)


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

When an autonomous agent acts on a user's behalf — signing, spending, proving identity — you want a durable, verifiable record that **both the human and the machine were bound together at the moment the relationship was created**. Not "the user has an agent" as a mutable config flag, but a cryptographic artifact that says: *this human identity and this specific machine identity were co-minted, as a pair, at bind time.*

The pattern mints **two linked NFT records per identity**:

- a **user NFT** registered to the user's own wallet — the *human proof*,
- a **machine NFT** registered to a deterministically derived companion wallet — the *machine proof*,

both linked by a single covenant row. The pairing is the point: neither NFT means much alone, but together they attest that the human and the machine co-signed the identity covenant at creation. The companion wallet's address must be **reconstructible from the user's wallet alone** (so the link can always be re-verified), and minting must be **idempotent** (bind, register, and first-access can all trigger it, but a user must never end up with duplicate or conflicting pairs).

## Design decisions

**Why deterministically derive the companion wallet instead of generating one.**
The machine-side wallet address is derived from the user's wallet via `HKDF-SHA256` with a covenant-specific domain (`salt = "COVENANT-V1"`, `info = "machine-covenant-address"`) over `"<wallet>:<ADDR_SECRET>"`. Because it is derived, anyone who knows the user's wallet (and holds the secret) can *recompute* the companion address and confirm the pairing — there is no separately stored mapping that could drift or be forged. The companion identity is mathematically *of* the user identity, not merely associated with it.

**Why exactly two NFTs, registered to two different owners.**
The whole construct is a *dual-custody* attestation. The human proof is owned by the user's wallet; the machine proof is owned by the derived companion wallet. Putting them under different owners is what makes the pair meaningful — it records two distinct custodians who were jointly committed at mint time, rather than one wallet holding two tokens.

**Why a single covenant row links the two.**
Beyond the two asset records, one `identity_covenants` row stores `{ wallet, userNftAssetId, companionWallet, machineNftAssetId, status }`. This is the authoritative link and the idempotency anchor: its presence means "this user already has a covenant." Verification is a join, not a guess.

**Why minting is idempotent and keyed on the user wallet.**
The covenant can be triggered from several places — wallet bind, passkey registration, or a lazy mint on first read. Each path calls the same mint function, which **first checks for an existing covenant row** and, if found, returns the existing pair unchanged. A user therefore always has *exactly one* covenant no matter how many times the trigger fires. Idempotency is enforced at the link row, the single source of truth.

**Why mint failures are non-fatal.**
The covenant is a binding artifact, not a gate on the user's core flow. The mint function catches all errors, logs them, and returns `null` rather than throwing — a transient database hiccup at bind time must not block the user from signing in. The lazy-mint-on-read path then heals the gap on the next access. (Read endpoints that *require* the covenant still surface an explicit error if mint genuinely cannot complete.)

**Why lazy mint on first GET.**
The read endpoint mints the pair on demand if it is absent, then returns the freshly created row. This means the covenant exists by the time anyone asks for it, even if the eager bind-time mint was skipped or failed — convergence toward "every identity has a covenant" without a migration sweep.

**Why human-readable names and serial numbers.**
Each NFT carries a descriptive name (human-proof / machine-proof) and a random serial. These are display/audit affordances; the security-relevant data is the owner wallet, the derived companion address, and the link row.

## Algorithm

```
deriveCompanionWallet(wallet):
    raw  = HKDF-SHA256(
             ikm  = "<wallet>:<ADDR_SECRET>",
             salt = "COVENANT-V1",
             info = "machine-covenant-address",
             len  = 32)
    return "0x" + hex(raw)[0..40]            # reconstructible from wallet alone

mintCovenantPair(wallet):                    # idempotent, never throws
    if covenantRow(wallet) exists:
        return existing pair                 # idempotency anchor
    companion = deriveCompanionWallet(wallet)
    userNft     = insert asset(owner = wallet,    role = "user")      # human proof
    machineNft  = insert asset(owner = companion, role = "machine")   # machine proof
    insert covenantRow(wallet, userNft, companion, machineNft, "active")
    return pair                              # on any error: log, return null

GET /covenant:                               # lazy mint
    row = covenantRow(caller)
    if not row: row = mintCovenantPair(caller)
    return row
```

## Reference implementation

See [`covenant-mint.ts`](./covenant-mint.ts) in this directory.

It implements the deterministic companion-wallet derivation, the idempotent paired mint, the non-fatal error contract, and the lazy-mint-on-read accessor over an in-memory store standing in for the `asset_items` and `identity_covenants` tables.

Dependencies: Node.js built-in `crypto` only.

## Usage

```typescript
import { CovenantRegistry } from "./covenant-mint.js";

const reg = new CovenantRegistry(process.env.ADDR_SECRET!);

// Idempotent mint — bind time, register time, or first read all call this
const first  = reg.mintCovenantPair("0xUserWallet");
const second = reg.mintCovenantPair("0xUserWallet");
console.log(first.created, second.created);          // true  false
console.log(first.companionWallet === second.companionWallet); // true (deterministic)

// Lazy mint on read
const row = reg.getCovenant("0xAnotherUser");        // mints if absent
console.log(row.userNftAssetId, row.machineNftAssetId);

// Anyone can re-derive the companion address from the user wallet alone
console.log(reg.deriveCompanionWallet("0xUserWallet") === first.companionWallet); // true
```

## Limitations and extensions

- **Off-chain records, not on-chain tokens.** These are NFT-shaped database rows, not minted ERC-721s. They give a verifiable internal attestation; bridging to a real chain (so third parties can verify without the backend) is a separate step.
- **The secret gates re-derivation.** The companion address is only recomputable by a party holding `ADDR_SECRET`. That is deliberate — it keeps the companion identity from being trivially enumerable — but it means external verification requires either the secret or a published commitment. Guard and version `ADDR_SECRET` as with all shadow derivation.
- **`status` is a single flag.** The covenant row carries an `active` status but no revocation/rotation lifecycle out of the box. Add status transitions (`revoked`, `rotated`) and a version on the derivation info string if you need to retire and re-mint a pair.
- **Idempotency is per-wallet, not per-derivation-version.** Bumping the derivation domain (`COVENANT-V2`) would derive a *different* companion wallet; reconcile old and new covenants explicitly rather than assuming one row per user forever.
- **Mint being non-fatal means callers must not assume success.** Eager triggers return `null` on failure by design; rely on the lazy-mint read path (or an explicit error on covenant-required endpoints) to guarantee eventual existence.
