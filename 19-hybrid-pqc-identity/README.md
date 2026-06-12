# Hybrid Post-Quantum Identity

## Problem

An account today is anchored by an ECDSA keypair (secp256k1 — the EVM/Bitcoin curve) or an RSA signing key (OIDC id-tokens). Both are broken by a sufficiently large quantum computer running Shor's algorithm. The migration to post-quantum (PQ) signatures cannot be a flag day: legacy verifiers still only understand ECDSA/RSA, and the user base cannot be asked to manually generate and back up a second keypair.

Three requirements pull against each other:

1. **Zero user interaction.** Every account should get a PQ keypair without the user doing anything — no new seed phrase, no extra backup, no prompt.
2. **Backward compatibility.** A receipt or token signed today must still verify on a legacy ECDSA/RSA verifier that has never heard of PQ. PQ-aware verifiers get *more* assurance; legacy verifiers are not broken.
3. **Real quantum resistance, not theatre.** Breaking the classical key alone must not be enough to forge — the attacker must break *both* the classical and the PQ scheme.

The pattern that satisfies all three is a **hybrid dual-signature**: keep the classical signature, add a detached PQ signature over the same (or enclosing) message, and derive the PQ keypair *deterministically* from material the account already controls so there is nothing new to store or back up.

## Design decisions

**Why deterministic, zero-storage PQ keys?**
The PQ keypair is derived from a server-held secret plus the account identifier through a KDF: `seed = KDF(SERVER_SECRET, account, label)`, then `keygen(seed)`. Because keygen is deterministic in its seed, the keypair is fully *re-derivable* — enrollment is idempotent, re-running it yields the same public key, and a lost secret-key ciphertext can be regenerated from the same inputs. Only the encrypted secret key is persisted (for fast signing), and even that is optional. The user never sees, chooses, or backs up anything.

**Why ML-DSA-65 as the primary PQ algorithm?**
ML-DSA-65 (the standardized form of CRYSTALS-Dilithium, NIST security level 3) is a lattice-based signature with reasonable signature sizes and fast verification. It is the general-purpose default. A second algorithm, SLH-DSA (SPHINCS+, hash-based), is enrolled alongside it: SLH-DSA rests on completely different (hash) assumptions, so a cryptanalytic break of lattices does not touch it. Enrolling both gives algorithm agility — if one family falls, the account already has keys in the other.

**Why encrypt the secret key at rest with a derived KEK?**
The PQ secret key is stored AES-256-GCM-encrypted. The key-encryption key is itself derived: `KEK = KDF(SERVER_SECRET, account, "pq-key")`. This binds the ciphertext to both the server secret and the specific account, and GCM's tag detects tampering. Storing `iv || tag || ciphertext` as hex keeps it a single opaque column.

**Why harden the keygen seed with a diffusion KDF?**
The keygen seed is not raw HKDF output — it is passed through a diffusion-hardened KDF (see guide 01) first. ML-DSA keygen expands 32 seed bytes into a large, highly-regular polynomial matrix; adding a non-linear mixing layer between the raw secret and keygen breaks any input-to-output correlation an attacker might exploit via side channels, without reimplementing keygen in constant time. The label encodes the algorithm and version so the derivation is deterministic per `(account, algorithm)`.

**Why a *detached* PQ signature instead of a new combined format?**
For receipts, the response carries `{ payload, ecdsaSig, pqSig, pqAlg, publicKey }`. A legacy verifier reads `ecdsaSig` and ignores the extra fields. For OIDC, the id-token is a normal RS256 JWT; the PQ layer rides alongside as `{ idToken, pqSig, pqAlg, pqKid }` where `pqSig` covers the *entire* RS256 token string (`header.payload.rsa_sig`). Because the PQ signature covers the classical signature, forging the token requires breaking RSA *and* forging ML-DSA over the result — the classical break alone is insufficient. Standard OIDC clients parse the JWT and never see the extra fields.

**Why tie the OIDC PQ key to the RSA key id (kid)?**
The OIDC PQ keypair is derived from the *current RSA kid* plus the server secret. When the RSA signing key rotates, the kid changes, and the PQ keypair rotates with it automatically — no separate rotation schedule, no extra storage. The PQ public key is published in JWKS under a draft PQC JWK representation (`kty: "PQK"`) so PQ-aware relying parties can fetch it.

## Algorithm

### Enrollment (zero-interaction, idempotent)

```
autoEnroll(account):                       // fire-and-forget at bind time
  for alg in [ML-DSA-65, SLH-DSA-SHA2-128s]:
    if active key exists for (account, alg): skip          // idempotent
    seed = hardenedKDF(SERVER_SECRET, account, "seed:"+alg, 32)
    (pk, sk) = alg.keygen(seed)
    kek = KDF(SERVER_SECRET, account, "pq-key")
    encSk = AES-256-GCM(sk, kek)            // iv||tag||ct hex
    store { account, alg, publicKey: hex(pk), encSk }  ON CONFLICT DO NOTHING
```

### Hybrid receipt

```
sign(account, payload, ecdsaSig?):
  sk      = decrypt(stored encSk, kek)
  pqSig   = alg.sign(sk, utf8(payload))
  ecdsaOk = ecdsaSig ? recover(payload, ecdsaSig) == account : null
  return { payload, pqSig, pqAlg: alg, publicKey, ecdsaSig, ecdsaValid: ecdsaOk }

verify({payload, pqSig, pqAlg, ecdsaSig, account}):
  ecdsaValid = ecdsaSig ? recover(payload, ecdsaSig) == account : null
  pqValid    = pqSig    ? alg.verify(storedPk, utf8(payload), pqSig) : null
  overall    = (ecdsaValid != false) && (pqValid != false)
               && (ecdsaValid == true || pqValid == true)
```

`overall` is true when neither present layer failed and at least one layer affirmatively passed — graceful degradation during migration (a receipt with only ECDSA still validates; a receipt with both must pass both).

### Hybrid OIDC token

```
signIdTokenHybrid(payload):
  idToken = RS256_JWT(payload, rsaPrivateKey, kid)
  (pqPk, pqSk) = MLDSA.keygen( KDF(SERVER_SECRET, rsaKid, "oidc-mldsa") )
  pqSig = MLDSA.sign(pqSk, utf8(idToken))     // covers the WHOLE RS256 token
  return { idToken, pqSig: hex, pqAlg: "ML-DSA-65", pqKid: "pq-"+rsaKid }
```

## Reference implementation

See [`hybrid-pqc.ts`](./hybrid-pqc.ts) in this directory.

External dependency: `@noble/post-quantum` (provides `ml_dsa65` and `slh_dsa_sha2_128s`). For the classical layer the example uses Node.js `crypto` (RSA) and a pluggable ECDSA recover function; in a real EVM deployment that would be `ethers.verifyMessage`. The hardened seed KDF is stubbed with HKDF — substitute the diffusion KDF from guide 01.

## Usage

```typescript
import {
  autoEnrollPqKeys,
  signHybridReceipt,
  verifyHybridReceipt,
  signIdTokenHybrid,
} from "./hybrid-pqc.js";

// At account-bind time — fire and forget, idempotent.
await autoEnrollPqKeys(account, store);

// Sign a hybrid receipt (ECDSA produced elsewhere, optional).
const receipt = await signHybridReceipt(account, JSON.stringify({ to, amount }), store);

// Verify — passes on legacy ECDSA-only, stronger with both layers present.
const result = await verifyHybridReceipt(receipt, account, store);
console.log(result.overallValid);

// Hybrid OIDC token: RS256 JWT + detached ML-DSA-65 signature.
const tok = await signIdTokenHybrid({ sub: account, aud: "client-1" }, rsaKey, "kid-1");
```

## Limitations and extensions

- **Server-derived keys mean the server can sign.** This is a custodial PQ layer: the deriving secret can regenerate any account's PQ secret key. That is the right model for a server-issued receipt/token system, but it is *not* a non-custodial wallet key. For a user-held PQ key, derive the seed from a user secret instead and never let the server see it.
- **Detached signatures need PQ-aware verifiers to matter.** Until verifiers check `pqSig`, the PQ layer is dormant assurance. Publish the PQ public key (JWKS for OIDC, alongside the receipt otherwise) so the ecosystem can opt in.
- **Signature size.** ML-DSA-65 signatures are a few kilobytes; SLH-DSA signatures are larger still. For bandwidth-sensitive paths, enroll only ML-DSA and add SLH-DSA where the cross-family hedge is worth the bytes.
- **KEK and seed share a derivation root.** Both descend from `SERVER_SECRET`. Rotating that secret invalidates re-derivation; keep it stable and protected, and version the labels if you ever must rotate.
- **JWK PQC representation is draft.** `kty: "PQK"` follows in-progress JOSE PQC drafts; pin to the final standard once published.
