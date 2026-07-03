# Fibonacci-Harmonic Key Derivation Function (FH-KDF)


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

Standard HKDF-SHA256 is a well-audited, widely-deployed KDF. But when deriving key material for post-quantum signature algorithms like ML-DSA-65 (Crystals-Dilithium), a concern arises that falls outside the HKDF security model: **side-channel attacks on the key expansion path**.

ML-DSA-65 key generation consumes 256 bits of seed material and expands them into a large polynomial matrix. The structure of that matrix is highly regular — an attacker who can observe the timing or memory-access pattern of the keygen function may be able to correlate the input seed bytes to matrix coefficients. Adding a non-trivial mixing layer between the raw secret and the keygen call breaks the correlation without requiring a constant-time reimplementation of the expansion itself.

The secondary concern is **algorithm agility**: HKDF-SHA256 inherits any weakness in SHA-256. Wrapping the custom mixing in a standard HKDF invocation at both input and output (a security sandwich) means the output is cryptographically bound by HMAC-SHA256 regardless of whether the middle passes have any flaw. Defense in depth without sacrificing the provable security properties of HKDF.

## Design decisions

**Why Fibonacci indices for permutation?**  
A reverse-Fibonacci permutation is deterministic, parameter-free, and has a well-understood geometric structure. It is not cryptographic on its own — its purpose is to break the byte-position regularity in the 64-byte state before mixing, so that the harmonic mixing passes operate on a non-sequential arrangement. Any deterministic, invertible permutation that disrupts contiguous index locality achieves the same goal; Fibonacci was chosen for its simplicity and because the index distribution is non-uniform (denser near the start, sparser near the end), which ensures the swap pattern does not accidentally re-create a linear arrangement.

**Why harmonic series weights?**  
The harmonic series (1, 1/2, 1/3, ...) is a natural choice for progressive diffusion: early rounds blend heavily, later rounds blend lightly, so the mixing function applies strong initial dispersion followed by fine-tuning. Crucially, the weights are computed as `floor(65536 / r)` — pure integer division, platform-invariant, with no floating-point operations. This guarantees bit-identical output on every CPU architecture and JavaScript engine.

**Why integer (Q16 fixed-point) arithmetic?**  
Floating-point results vary across CPUs due to rounding modes and FMA instruction availability. A KDF must produce identical output everywhere. Q16 fixed-point (weights expressed as integers out of 65536) achieves the same blending semantics as floating-point but with a closed-form integer expression that produces the same bit pattern on all platforms.

**Why the security sandwich (HKDF-init → mix → HKDF-final)?**  
The first HKDF call binds the input key material to a domain-separated label (`fhkdf-v2-init:<info>`), preventing cross-context key reuse before mixing even starts. The final HKDF call provides a cryptographic commitment: the output is HMAC-SHA256 keyed on the original salt, so even if the harmonic mixing passes have an undiscovered linear bias, the adversary still faces a full HMAC inversion to recover the output. The custom passes add diffusion value; the HKDF wrappers provide the provable security floor.

## Algorithm

```
Input:  ikm   — input key material (Buffer)
        salt  — domain salt (Buffer)
        info  — domain-separation string
        len   — output length in bytes (≤ 64 for single call)

Step 1: base     = HKDF-SHA256(ikm, salt, "fhkdf-v2-init:<info>", 64)
Step 2: permuted = reverseFibPermutation(base)
Step 3: mixed    = harmonicMixRounds(permuted, rounds=8)
Step 4: output   = HKDF-SHA256(mixed, salt, "fhkdf-v2-final:<info>", len)

reverseFibPermutation(state):
  fibs = fibonacci_sequence_up_to(63)   // e.g. [1,1,2,3,5,8,13,21,34,55]
  rev  = reverse(fibs)                  // [55,34,21,13,8,5,3,2,1,1]
  for i in 0..len(rev)-2, step 2:
    a = rev[i]   % 64
    b = rev[i+1] % 64
    if a != b: swap(state[a], state[b])
  return state

harmonicMixRounds(state, rounds):
  for r in 1..rounds:
    W  = floor(65536 / r)          // Q16 integer weight
    NW = 65536 - W
    for i in 0..63:
      next[i] = (state[i]*W + state[(i+1)%64]*NW + 32768) >> 16  // Q16 blend
    digest = SHA256(byte(r) || state)
    for i in 0..63:
      next[i] = next[i] XOR digest[i % 32]  // avalanche diffusion
    state = next
  return state
```

The `+32768` implements round-half-up rounding in integer arithmetic (`0x8000 = 65536/2`), equivalent to `Math.round` but without floating-point.

The per-round SHA-256 XOR (avalanche step) ensures that each byte depends on all preceding bytes through the hash output. Without this step, the harmonic mixing is a linear operation and could in principle be analyzed algebraically.

## For larger outputs

When more than 64 bytes are needed, chunk the expansion: call `fhKdf` repeatedly with a distinct info suffix per block (`<info>:c0`, `<info>:c1`, ...). This makes each block output independent — an attacker who learns one block cannot derive adjacent blocks.

## Reference implementation

See [`fh-kdf.ts`](./fh-kdf.ts) in this directory.

## Usage

```typescript
import { fhKdf, fhKdfExpand } from "./fh-kdf.js";

// Derive 32 bytes of key material for post-quantum seed hardening
const seed = fhKdf(
  Buffer.from(masterSecret, "hex"),
  Buffer.from(userSalt, "hex"),
  "pq-keygen-v1",
  32,
);

// Derive 96 bytes (chunked across two 64-byte blocks internally)
const expandedKey = fhKdfExpand(
  Buffer.from(masterSecret, "hex"),
  Buffer.from(userSalt, "hex"),
  "shard-expansion-v1",
  96,
);
```

## Limitations and extensions

- **Not a replacement for HKDF alone.** FH-KDF is a pre-conditioning layer, not a standalone KDF. Use it before sensitive keygen operations where breaking input-to-output correlation is worth the extra two HKDF calls.
- **Round count.** Eight harmonic rounds was chosen to balance diffusion with performance. For hardware-constrained environments, four rounds is a reasonable minimum; above twelve provides diminishing diffusion returns.
- **Output cap.** The single-call cap of 64 bytes matches the internal state size. For larger outputs use `fhKdfExpand` — this is intentional; chunking with distinct domain labels produces independent block outputs.
- **Not post-quantum by itself.** FH-KDF uses HKDF-SHA256, which is not post-quantum secure. Pair with `pqHkdf` (guide 02) or use it as a pre-pass before a quantum-safe KDF.
