# Deterministic Post-Quantum Action Receipts

## Problem

When an autonomous agent performs actions on a user's behalf — approving a token transfer, firing an intent, running a scheduled task — there needs to be durable, non-repudiable proof of *what was authorised and executed*. A row in an audit table is not enough: the audit table is server-controlled mutable state. If the server is compromised, restored from an old backup, or simply migrated, the audit trail can be silently rewritten, and there is no way for the user (or a third party) to prove what the agent actually did.

The stronger primitive is a **receipt that verifies from its own contents**. Each action is serialised, hashed, and signed. Given only `(payload, payloadHash, signature, publicKey)`, anyone can confirm the action was authorised by the holder of the signing key and has not been altered — no database lookup, no trust in current server state.

Two design constraints make this practical at scale. First, you cannot store a distinct signing keypair per wallet per action — that is a key-management nightmare and another mutable store to protect. Instead the signing key is **derived deterministically** from a long-lived server secret plus the wallet address, so it can always be re-created and never needs persisting. Second, because receipts are meant to remain verifiable for decades, the signature should resist a future quantum adversary: the production scheme uses ML-DSA-65 (Crystals-Dilithium). The mechanism is identical regardless of which signature algorithm sits underneath, so the algorithm lives behind an adapter.

## Design decisions

**Why canonical (key-sorted) JSON before hashing?**  
A signature commits to *bytes*, not to a logical object. `JSON.stringify` does not guarantee key order, so the same action could serialise two different ways and a later verifier would compute a different hash and reject a valid receipt. Recursively sorting object keys produces one canonical byte string for any logical value, so the hash is reproducible by any implementation on any platform years later.

**Why derive the signing key instead of storing it?**  
Storing a per-wallet keypair adds a second secret store that must itself be backed up, access-controlled, and protected from theft. A key derived via `HKDF(secret, salt=wallet, info=label)` exists only for the moment it is used and can be regenerated on demand. The blast radius collapses to a single value — the server secret — and rotating that secret cleanly retires all old keys. The receipt still embeds the public key, so verification never needs the secret.

**Why put the signature algorithm behind an adapter?**  
The receipt construction (canonicalise → hash → sign) is independent of *how* signing happens. Keeping a `SignatureAdapter` interface lets the production system use ML-DSA-65 from `@noble/post-quantum` while this reference implementation ships an Ed25519 adapter built only on Node's `crypto`. The demo runs with zero external dependencies, yet exercises the real flow: deterministic keygen from a seed, signing a hash, and asymmetric verification from a raw public key.

**Why hash first and sign the hash?**  
Signing a fixed-size 32-byte digest rather than the full payload keeps the signing cost constant and bounds the input to the signature primitive. The hash is also the natural content address of the receipt for indexing and de-duplication.

**Why must receipt signing never block the user flow?**  
Receipts are an audit primitive, not a precondition. In production `createReceipt` is wrapped in `try/catch` by callers and logged on failure — a signing or storage hiccup must never prevent the user-visible action from completing.

## Algorithm

```
deriveSigningSeed(secret, wallet, label):
  return HKDF-SHA256(ikm=secret, salt=lower(wallet), info=label, len=32)

createReceipt(input, secret, adapter):
  body = { v:1, wallet, kind, toolName, actionId, intentId,
           status, payload, signedAt }          // only these fields are signed
  canonical   = canonicalJSON(body)             // recursive key sort
  payloadHash = SHA-256(canonical)
  seed              = deriveSigningSeed(secret, wallet, label)
  (pub, sec)        = adapter.keygenFromSeed(seed)   // deterministic
  signature         = adapter.sign(payloadHash, sec)
  return body + { payloadHash, signature, publicKey: pub, signatureAlg }

verifyReceipt(receipt, adapter):
  if receipt.signatureAlg != adapter.alg: return false
  body     = same fields as above, read back from receipt
  expected = SHA-256(canonicalJSON(body))
  if expected != receipt.payloadHash: return false        // tamper
  return adapter.verify(receipt.signature,
                        receipt.payloadHash,
                        receipt.publicKey)
```

The verifier reconstructs the body from the stored fields, so any post-signing edit (e.g. inflating an amount) changes the recomputed hash and fails before the signature is even checked.

## Reference implementation

See [`deterministic-action-receipts.ts`](./deterministic-action-receipts.ts) in this directory.

Runs on Node built-ins only (`crypto`). The bundled `ed25519Adapter` provides deterministic keygen from a 32-byte seed by wrapping the seed in a PKCS8 DER blob. Production swaps in an ML-DSA-65 adapter backed by `@noble/post-quantum` (`ml_dsa65.keygen/sign/verify`) — the adapter interface is identical, so no calling code changes.

## Usage

```typescript
import crypto from "crypto";
import {
  createReceipt,
  verifyReceipt,
  ed25519Adapter,
} from "./deterministic-action-receipts.js";

const secret = crypto.randomBytes(32); // long-lived server secret

const receipt = createReceipt(
  {
    wallet:   "0xABC...1234",
    kind:     "approval",
    toolName: "transfer_tokens",
    payload:  { to: "0xfeed...", amount: "25.0", asset: "USDC" },
    status:   "executed",
    actionId: "act_001",
  },
  secret,
  ed25519Adapter,
);

console.log(verifyReceipt(receipt, ed25519Adapter)); // true
```

To use a post-quantum signer, implement the `SignatureAdapter` interface against `@noble/post-quantum/ml-dsa.js` and pass it in place of `ed25519Adapter`.

## Limitations and extensions

- **The Ed25519 adapter is a stand-in.** It demonstrates the deterministic-keygen and asymmetric-verify semantics with built-ins, but is not post-quantum. For long-horizon non-repudiation use the ML-DSA-65 adapter.
- **Server-secret rotation invalidates old public keys.** That is intentional, but it means a verifier checking very old receipts must keep the embedded public key (which receipts carry) rather than re-deriving — re-derivation only works while the secret is current.
- **No timestamp authority.** `signedAt` is self-asserted. For ordering guarantees against a malicious signer, anchor receipt hashes into an external append-only log (see the Merkle audit-anchoring guide).
- **No revocation.** A receipt proves an action happened; it cannot be un-signed. Revocation, if needed, is a separate layer that records superseding receipts.
- **Batching.** For high-volume actions, sign a Merkle root over many receipts and store per-receipt inclusion proofs to amortise signature cost.
