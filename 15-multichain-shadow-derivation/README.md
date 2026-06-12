# Multi-Chain Shadow Wallet Derivation (HKDF, no BIP-39 seed)

## Problem

A user authenticates once — with a passkey, a wallet signature, or any other identity proof — and now wants to hold and move assets across several blockchains with completely different key formats and address encodings:

- **Bitcoin** — secp256k1 keys, P2WPKH SegWit (bech32) addresses
- **Solana** — Ed25519 keys, base58 public-key addresses
- **EVM chains** (Ethereum / BNB Chain / Polygon / Base / Arbitrum) — secp256k1 keys, keccak-256 derived 20-byte addresses
- **TRON** — secp256k1 keys, keccak-256 hash + `0x41` version byte + Base58Check

The conventional answer is BIP-39 / BIP-44: generate a 12/24-word mnemonic, expand it into a seed, then walk a hardened derivation path per chain. That works, but it forces the user (or the server) to **store and protect a seed phrase**, which is the single most fragile artifact in self-custody. Lose it and the funds are gone; leak it and every chain is drained at once. It also couples wallet recovery to a string of words that has nothing to do with how the user actually logs in.

The pattern here removes the seed phrase entirely. **One identity string + one server-held secret are deterministically expanded into a distinct keypair per chain via HKDF-SHA256.** There is no mnemonic to back up. Re-deriving the same address on any chain only ever requires the identity string (recovered at login) and the secret — nothing is persisted that, alone, unlocks funds.

## Design decisions

**Why HKDF instead of BIP-32/44?**
BIP-32 hardened derivation is itself an HMAC-SHA512 tree. We do not need the *tree* — we need a flat set of per-chain keys that never collide. HKDF-SHA256 (RFC 5869) gives exactly that: a domain-separated extract+expand where changing the salt or info string yields an independent, uniformly random 32-byte key. Each chain gets its own `(salt, info)` pair, so the BTC key reveals nothing about the SOL key even though both descend from the same input.

**Why split the secret across two HKDF inputs?**
The input keying material is `"<identity>:<ADDR_SECRET>"` — the user-scoped identity string concatenated with a server-side secret. Neither half alone derives a key:
- The identity string is public-ish (it is the user's login handle / address) but useless without the secret.
- The secret is shared infrastructure but useless without knowing *which* identity to derive for.

This is a deliberate two-factor split: an attacker needs both the per-user identity and the server secret to reconstruct any key.

**Why a distinct salt *and* info per chain?**
Domain separation is doubled on purpose. The salt encodes the chain + version (`SHADOW-BTC-ADDRESS-V1`) and the info encodes the role (`btc-shadow-key`). Either alone would separate the domains; using both makes accidental cross-chain key reuse essentially impossible and leaves room to version-bump a single chain's derivation without disturbing the others.

**Why per-chain address encoding lives next to derivation.**
A raw 32-byte key is meaningless until it is turned into the address each network expects. The reference implementation keeps the keygen and the address codec together per chain so the full path "secret → key → address" is auditable in one place:
- BTC: secp256k1 compressed pubkey → P2WPKH witness program → bech32.
- SOL: Ed25519 keypair from the 32-byte seed → base58 of the 32-byte public key.
- EVM: secp256k1 → keccak-256 of the uncompressed pubkey (minus prefix) → last 20 bytes → EIP-55 checksum.
- TRON: same keccak path as EVM, then prepend `0x41` and Base58Check (double-SHA-256 checksum).

**Why the EVM key is chain-agnostic.**
There is one EVM key for *all* EVM chains. The same 20-byte address is valid on Ethereum, BNB Chain, Polygon, Base, and every other EVM network because they share the secp256k1 + keccak address scheme. Chain selection happens at RPC time (chain ID), not at derivation time.

## Algorithm

```
Input:  identity    — user identity string (login handle / root address)
        addrSecret  — server-held secret (high entropy, never sent to client)

For each chain:
    ikm  = utf8("<identity>:<addrSecret>")
    salt = utf8("<CHAIN>-ADDRESS-V1")
    info = utf8("<chain>-shadow-key")
    key  = HKDF-SHA256(ikm, salt, info, 32 bytes)

Bitcoin (P2WPKH):
    priv   = key
    pub    = secp256k1.compressedPublicKey(priv)        // 33 bytes
    addr   = bech32( witnessV0( ripemd160(sha256(pub)) ) )

Solana (Ed25519):
    seed   = key
    kp     = ed25519.keypairFromSeed(seed)
    addr   = base58(kp.publicKey)                        // 32 bytes

EVM (ETH / BNB / Polygon / …):
    priv   = key
    pub    = secp256k1.uncompressedPublicKey(priv)       // 65 bytes
    addr   = eip55( keccak256(pub[1..])[12..] )          // last 20 bytes

TRON:
    priv   = key
    pub    = secp256k1.uncompressedPublicKey(priv)
    raw20  = keccak256(pub[1..])[12..]
    payload= 0x41 || raw20
    addr   = base58( payload || sha256(sha256(payload))[0..4] )
```

The whole scheme is deterministic and stateless: given the same `(identity, addrSecret)`, every address re-derives identically forever, on any machine, with no database lookup.

## Reference implementation

See [`shadow-derivation.ts`](./shadow-derivation.ts) in this directory.

External dependencies (called out explicitly, all widely audited):
- `@noble/curves` — secp256k1 and Ed25519 primitives
- `@noble/hashes` — keccak-256, ripemd160, sha256, base58 / bech32 codecs
- Node.js built-in `crypto` — `hkdfSync`

The implementation uses `@noble/*` so it runs without `bitcoinjs-lib`, `ethers`, `@solana/web3.js`, or `tweetnacl`. In production those higher-level libraries are perfectly fine substitutes — the derivation constants and byte layout are what matter and are reproduced exactly here.

## Usage

```typescript
import { deriveAllChains } from "./shadow-derivation.js";

const addresses = deriveAllChains("user@example.com", process.env.ADDR_SECRET!);
console.log(addresses);
// {
//   btc:  "bc1q...",
//   sol:  "9xQ...",
//   evm:  "0xAbC...",   // valid on Ethereum, BNB, Polygon, Base, ...
//   tron: "TR7..."
// }
```

To sign on a given chain, derive the keypair (not just the address) and hand the raw key to that chain's signing library — `bitcoinjs-lib` for a PSBT, `ethers.Wallet` for an EVM tx, `@solana/web3.js` for a Solana tx, etc.

## Limitations and extensions

- **The secret is the crown jewel.** Because there is no per-key storage, anyone who learns both a user's identity string and `ADDR_SECRET` can derive that user's keys on every chain. Protect `ADDR_SECRET` like a master key (HSM / KMS) and rotate by version-bumping the salt (`...-V2`) — old funds stay reachable via the `-V1` path while new addresses use `-V2`.
- **No hierarchical sub-accounts by default.** This is a flat derivation. To get multiple addresses per chain for one user, fold an index into the info string (`btc-shadow-key:<index>`), exactly as the larger system does for EVM "wallet indexes."
- **Address-encoding correctness is critical.** A bug in bech32 / Base58Check / EIP-55 produces a *plausible-looking but wrong* address and funds sent there are unrecoverable. Pin the codec library versions and cover each chain with known-answer tests.
- **Not a substitute for a passkey/assertion floor on spends.** Deterministic derivation controls *where* funds live; it does not authorize *moving* them. Pair it with a per-transaction authentication step (see guides 17, 18, 20) so a leaked session token alone cannot broadcast.
- **Ed25519 vs secp256k1 seed semantics differ.** For Solana the 32-byte HKDF output is used as the Ed25519 *seed* (the library expands it to the full 64-byte secret key); for secp256k1 chains the 32 bytes *are* the scalar private key. Keep that distinction explicit when porting.
