# Hybrid RSA + Post-Quantum OIDC Token Signing


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

An OpenID Connect provider signs ID tokens with RS256 (RSA + SHA-256). RSA is not quantum-resistant: a sufficiently large quantum computer running Shor's algorithm could recover the RSA private key from its public key and forge tokens at will. Migrating an existing OIDC deployment to a post-quantum signature scheme is awkward because the entire relying-party ecosystem only understands RS256 — flipping the `alg` to a PQC algorithm overnight would break every client that has not been upgraded.

The goal is to harden the provider *today*, in a way that is invisible to legacy clients but gives forward-looking clients real quantum resistance, and to do it without inflating key-management overhead. A naïve approach — store a second PQ keypair next to the RSA key, rotate them on separate schedules, publish both — doubles the operational surface and the failure modes.

This guide describes a drop-in hardening layer: every token keeps its standard RS256 signature *and* gains a **detached** post-quantum signature computed over the entire RS256 token. Breaking RSA alone no longer forges a token, because the attacker must also forge the PQ signature, whose private key never appears in the token and is derived from a server secret. Legacy clients verify the RS256 layer and ignore the extra fields; PQ-aware clients verify both.

## Design decisions

**Why a detached signature instead of a new `alg`?**  
Putting `alg: "ML-DSA-65"` directly in the JWT header would make the token unparseable by RS256-only verifiers — the very ecosystem we are trying not to break. A detached signature lives *outside* the JWT (returned as a sibling field `pq_sig` in the token response, or as an additional JWKS-discoverable proof). The JWT on the wire is byte-for-byte a normal RS256 token. Legacy clients are completely unaffected; PQ-aware clients pick up the extra field and verify it.

**Why sign the full RS256 token (`header.payload.rsa_sig`) rather than just the payload?**  
Covering the RSA signature too binds the two layers together. An attacker who somehow forged a valid RSA signature for a chosen payload still could not assemble a token that passes PQ verification, because the PQ signature commits to the exact RSA signature bytes. The two layers reinforce each other instead of being independent.

**Why derive the PQ keypair from the RSA `kid` + secret instead of storing it?**  
Storage is a liability: another secret to back up, rotate, and leak. By deriving the PQ seed as `HKDF(secret, salt=kid, info="oidc-pq-v1")`, the PQ keypair is a pure function of the RSA key id and a server secret. When the RSA key rotates (new `kid`), the PQ key rotates with it automatically — no separate rotation schedule. The PQ key is re-derivable at any time from the same two inputs, so disaster recovery only needs the RSA key history and the secret.

**Why keep the PQ algorithm behind an adapter interface?**  
The token-assembly logic should not care which PQ scheme is in use. The `PqSigner` interface (`keygen` / `sign` / `verify`) lets you start with ML-DSA-65 and later add a hash-based backup (SLH-DSA) or swap algorithms entirely without touching the JWT plumbing. It also lets this reference file run on Node built-ins using an HMAC stub, while a one-line adapter wires in the real `@noble/post-quantum` implementation.

**Why publish the PQ public key in JWKS under `kty: "PQK"`?**  
Relying parties already fetch JWKS to get the RS256 key. Adding the PQ public key as an extra JWKS entry (using the draft JOSE post-quantum key representation) means PQ-aware clients discover it through the same well-known endpoint. Clients that do not understand the `kty` simply skip that entry, so the JWKS stays backward-compatible.

## Algorithm

```
Key setup (per RSA key id `kid`):
  seed       = HKDF-SHA256(secret, salt=kid, info="oidc-pq-v1", 32)
  pqKeyPair  = PqSigner.keygen(seed)          # deterministic, never stored
  pqKid      = "pq-" + kid

Issue token:
  idToken    = RS256_JWT(header{alg:RS256,kid}, payload, rsaPrivateKey)
  pqSig      = PqSigner.sign(pqKeyPair.secretKey, utf8(idToken))
  return { idToken, pqSig, pqAlg, pqKid }

Legacy client (RS256-only):
  verify RSA signature over header.payload     # ignores pqSig entirely

PQ-aware client:
  rsaValid = RS256_verify(idToken, rsaPublicKey)
  pqValid  = PqSigner.verify(pqPublicKey, utf8(idToken), pqSig)
  accept iff rsaValid AND pqValid

JWKS:
  keys = [ { RSA jwk, alg:RS256, kid },
           { kty:"PQK", alg:pqAlg, kid:pqKid, x:base64url(pqPublicKey) } ]
```

## Reference implementation

See [`hybrid-oidc-pq-signing.ts`](./hybrid-oidc-pq-signing.ts) in this directory.

Runs on Node.js built-in `crypto` only, using an HMAC-based stub for the post-quantum signer. A production deployment swaps in an `@noble/post-quantum/ml-dsa.js` adapter (a ~6-line object implementing the `PqSigner` interface — shown in the source comments); the rest of the code is unchanged.

## Usage

```typescript
import crypto from "crypto";
import {
  createHmacStubSigner,
  derivePqKeyPair,
  signIdTokenHybrid,
  verifyHybrid,
  verifyRs256,
  getJwks,
} from "./hybrid-oidc-pq-signing.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "rsa-2024";
const secret = process.env.SESSION_SECRET ?? "dev-secret";
const signer = createHmacStubSigner(); // swap for the ML-DSA-65 adapter in prod

// Issue a hybrid token
const hybrid = signIdTokenHybrid({
  rsaPrivateKey: privateKey,
  kid,
  payload: { sub: "alice", scope: "openid" },
  signer,
  secret,
});

// Legacy RS256-only client
const payload = verifyRs256(hybrid.idToken, publicKey);

// PQ-aware client (verifies both layers)
const { publicKey: pqPub, pqKid } = derivePqKeyPair(signer, kid, secret);
const result = verifyHybrid(hybrid, publicKey, signer, pqPub);

// Publish discovery document
const jwks = getJwks({ rsaPublicKey: publicKey, kid, pqPublicKey: pqPub, pqKid, pqAlg: signer.alg });
```

## Limitations and extensions

- **The HMAC stub is symmetric and not post-quantum.** It exists only so the file runs on built-ins. Production MUST use a real PQ scheme (ML-DSA-65 via `@noble/post-quantum`); the adapter boundary makes that a drop-in change.
- **Detached signatures need a transport.** This guide returns `pqSig` as a sibling field of the token. You must decide where it travels (token response body, an `x-pq-signature` header, or a JWKS-anchored proof) and document it so PQ-aware clients know where to look.
- **Key rotation overlap.** During RSA key rotation, keep previous `kid`s verifiable for a TTL window; derive each prior PQ key from its own `kid` so recently-issued hybrid tokens still verify. The same overlap logic that exists for RS256 keys applies unchanged to the derived PQ keys.
- **Redirect-URI validation is a related concern, not the same one.** The bundled `redirectUriMatches` helper enforces a same-origin check for relative redirect URIs (blocking cross-origin code delivery). It is included because it lives in the same OIDC flow, but it is an independent control from token signing.
- **Algorithm agility.** To support a second PQ algorithm (e.g. a hash-based backup), publish a second `PQK` JWKS entry and attach a second detached signature; verifiers can accept either.
