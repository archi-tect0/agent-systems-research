# Post-Quantum HKDF (HKDF-SHA3-256)

## Problem

HKDF-SHA256 is the standard key derivation function in most modern systems. Its security depends on the collision-resistance and preimage-resistance of SHA-256. SHA-256 is a Merkle-Damgård construction — a structural family that is known to be vulnerable to length-extension attacks (mitigated by HMAC but still part of the attack surface analysts consider).

Against a cryptographically-relevant quantum computer, Grover's algorithm provides a quadratic speedup for preimage search. The precise picture matters here: classically, SHA-256 offers **256-bit preimage resistance** and **128-bit collision resistance** (the latter bounded by the birthday paradox). Grover's algorithm attacks *preimage* resistance specifically, reducing it from 256 bits to **128 bits**. A 256-bit hash therefore lands at a uniform 128-bit post-quantum floor — which is exactly the long-term target baseline, matching the 128-bit symmetric security of AES-128.

The larger concern is **structural independence**. SHA-256 (Merkle-Damgård with Davies-Meyer compression) and SHA3-256 (Keccak sponge construction) have no design-level relationship. A cryptanalytic break in SHA-256 that exploits the Merkle-Damgård structure does not transfer to SHA3-256. For long-lived key derivations — vault keys, identity roots, wallet derivation paths — using a structurally-independent hash as the fallback-ready alternative costs almost nothing and adds a meaningful layer of algorithm agility.

## Design decisions

**Why SHA3-256 specifically?**  
SHA3-256 is a NIST-standardized hash function from the Keccak family (sponge construction). It provides:
- 128-bit post-quantum security (same as SHA-256 — the output size is 256 bits, Grover halves it)
- Structural independence from all SHA-1/SHA-2 family members
- Native availability in Node.js `crypto` module (`createHash("sha3-256")`)
- No external dependencies

SHA3-512 would provide 256-bit post-quantum security but with larger output blocks and slower computation. For 256-bit key derivation, SHA3-256 is the right balance.

**Why RFC 5869 structure?**  
HKDF is a two-step construction (extract → expand) with well-understood security proofs. The extract step converts arbitrary-length input key material into a uniform pseudorandom key using HMAC. The expand step derives arbitrary amounts of output keying material from that PRK. Reimplementing this structure with SHA3-256 instead of SHA-256 inherits the HKDF security proofs while upgrading the hash.

**Why keep HMAC at all, given SHA-3 is a sponge?**  
SHA3-256 is a Keccak sponge construction and is naturally immune to length-extension attacks. Unlike SHA-256, it does not *need* the nested inner/outer structure of HMAC to be a secure keyed primitive — NIST's dedicated keyed construction for Keccak is KMAC (SP 800-185), which drops HMAC's padding entirely and is faster. This implementation keeps HMAC anyway, as a deliberate trade-off: it lets the construction follow RFC 5869 verbatim, inheriting that protocol's widely-trusted, easily-audited security proofs, with the only change being the hash identifier. The cost is a negligible amount of hashing overhead; the benefit is that there is no novel construction to re-prove. A KMAC-based variant is a reasonable future optimization if performance ever matters.

**Why not just use `hkdfSync("sha3-256", ...)`?**  
Node.js `hkdfSync` supports SHA-3 in recent versions, but availability varies by OpenSSL version and runtime. A manual HKDF-SHA3-256 implementation using `createHmac("sha3-256")` is 25 lines, has no external dependencies, and works on any Node.js ≥ 18 regardless of OpenSSL flags. The manual implementation is also easier to audit — it is a direct translation of RFC 5869.

## Algorithm

```
HKDF-SHA3-256(IKM, Salt, Info, Length):

  Extract:
    if Salt is empty: Salt = 0x00...00 (32 bytes of zeros)
    PRK = HMAC-SHA3-256(key=Salt, data=IKM)

  Expand:
    N   = ceil(Length / 32)    // SHA3-256 produces 32-byte blocks
    T_0 = zero-length byte buffer   // an empty BUFFER, not the string ""
    for i in 1..N:
      T_i = HMAC-SHA3-256(key=PRK, data=T_{i-1} || Info || byte(i))
    return (T_1 || T_2 || ... || T_N)[0..Length]
```

This is RFC 5869 verbatim, with SHA-256 replaced by SHA3-256 in all HMAC calls.

Note on `T_0`: it must be a **zero-length byte buffer** (`Buffer.alloc(0)`), not the empty string `""`. The first iteration computes `HMAC(PRK, T_0 || Info || byte(1))`; if `T_0` is a JS string, the concatenation can silently coerce types or alter the byte layout depending on the binary helpers in use, producing output that diverges from any reference vector. The reference implementation initializes it as `Buffer.alloc(0)`.

## Relationship to FH-KDF

FH-KDF (guide 01) is an application-level diffusion layer using HKDF-SHA256. The two are complementary:

- Use `pqHkdf` (this guide) for all **new** key derivations where you want structural independence from SHA-2.
- Use `fhKdf` from guide 01 as a pre-conditioning layer before sensitive keygen operations where correlation between input and output is the concern.
- For maximum defense-in-depth: `pqHkdf` for the outer KDF, `fhKdf` as a pre-pass before post-quantum keygen.

Existing data derived with HKDF-SHA256 continues to be decrypted using the SHA-256 path — key derivation upgrades are opt-in at the per-feature level.

## Reference implementation

See [`pq-hkdf.ts`](./pq-hkdf.ts) in this directory.

## Usage

```typescript
import { pqHkdf } from "./pq-hkdf.js";

// Derive a 32-byte vault encryption key
const vaultKey = pqHkdf(
  Buffer.from(masterSecret, "hex"),
  "vault-key-v2",
  "user-vault-encryption",
  32,
);

// Derive a 64-byte wallet derivation root
const walletRoot = pqHkdf(
  Buffer.from(masterSecret, "hex"),
  "wallet-root-v2",
  "hd-wallet-derivation",
  64,
);
```

## Limitations and extensions

- **Post-quantum but not quantum-safe at 128 bits.** SHA3-256 provides 128-bit post-quantum security. For 256-bit post-quantum security, use SHA3-512 (adjust `HASH_ALG` and `HASH_LEN` in the implementation).
- **Same key space as SHA-256 HKDF.** Switching the hash does not automatically migrate existing keys — both derivation paths must be maintained in parallel during any transition.
- **Not a quantum-safe signing algorithm.** HKDF is for key derivation only. For quantum-safe signatures, see ML-DSA-65 (Crystals-Dilithium) from `@noble/post-quantum`.
