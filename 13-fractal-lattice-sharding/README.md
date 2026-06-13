# Committed Lattice Secret Sharing

## Problem

Shamir Secret Sharing (SSS) splits a secret into *n* shares such that any *k* of them reconstruct it and any *k-1* reveal nothing. It is the standard tool for guardian-based key recovery: distribute shares to *n* trusted parties, recover the master seed when *k* of them cooperate.

SSS has one sharp edge that bites in practice: **it does not detect corrupted shares.** Lagrange interpolation will happily combine *k* shares and produce *a* secret — but if even one share has been silently altered (bit-rot in storage, a malicious guardian substituting a fabricated share, two shards accidentally taken from different splitting sessions), the interpolation produces a *different, wrong* secret with no error. The recovery flow then attempts to decrypt a vault or re-derive a wallet with garbage key material and fails opaquely several steps later, far from the actual cause.

The goal here is to wrap plain SSS with a **public commitment** so the system can verify, *before* attempting any decryption, that the collected shares reconstruct the original secret and not some corrupted variant. The commitment must be safe to store alongside the shares (it reveals nothing about the secret) and cheap to check.

## Design decisions

**Why expand the seed into a high-dimensional vector before committing?**
A naive commitment is just `SHA-256(masterSeed)`. That works, but it commits to the 32-byte seed directly — the same value the SSS shares protect. Expanding the seed deterministically into a large (1024-byte) *lattice vector* and committing to *that* gives a commitment that is a function of the full derivation pipeline, not just the raw seed. Any divergence in the reconstructed seed produces a completely different lattice vector (avalanche), and therefore a different commitment. The expansion also produces key material used for a secondary verification path (see below).

**Why 1024 dimensions split into four quadrants?**
The dimension count is a tunable parameter; 1024 bytes (4 × 256) is large enough that the cross-mixing step has meaningful structure and small enough to hash quickly. The four-quadrant layout exists so the expansion can apply a **cross-mix** — each quadrant is blended with its neighbour — which couples all regions of the vector together. This is purely a diffusion device: it ensures the commitment depends on every byte of the expanded material, not just on independent blocks.

**Why a fixed-point integer cross-mix?**
The cross-mix uses Q16 fixed-point integer arithmetic (weights expressed as integers out of 65536) rather than floating point. A commitment must reconstruct bit-for-bit on every machine that ever verifies it — a guardian's phone, a recovery server, a cold-storage laptop. Floating-point rounding varies across CPUs and JS engines; integer arithmetic does not. The harmonic weights `floor(65536 / r)` and the round-half-up term `+0x8000` give the same blend semantics as floating point with platform-invariant output.

**Why two reconstruction formats (single-split vs per-quadrant)?**
The straightforward design splits the *master seed* once with SSS (each guardian holds one share) and uses the lattice purely as a commitment. An earlier variant split *each quadrant* separately (each guardian held four shares) and reconstructed the lattice directly, recovering the seed by AES-decrypting a wrapped copy. The single-split format cuts guardian payload 4× and is the default; the per-quadrant format is supported for backward compatibility. The reference implementation auto-detects which format a share set uses by inspecting its length.

**Why also AES-wrap the seed under a lattice-derived key?**
The lattice vector is hashed to produce an AES-256-GCM key that wraps a copy of the master seed (`encryptedMasterSeed`). In the single-split format this is a redundant secondary path; in the per-quadrant format it is the *primary* recovery path (reconstruct quadrants → rebuild lattice → derive key → decrypt). GCM's authentication tag provides a second, independent integrity check: even if a commitment somehow matched, a corrupted lattice key would fail the GCM tag rather than emit wrong plaintext.

## Algorithm

```
Split(masterSeed, n, k):
  latticeVector = expandToLattice(masterSeed)          // 1024 bytes
  commitment    = SHA-256(latticeVector)               // public, store with shares
  encMaster     = AES-256-GCM(masterSeed, key=SHA-256(latticeVector))
  shares        = SSS_split(masterSeed, n, k)           // one share per guardian
  for each guardian i:
    store { shareIndex: i, share: shares[i], commitment, encMaster }

expandToLattice(masterSeed):
  raw   = KDF_expand(masterSeed, "lattice-v1", 1024)    // deterministic
  quads = split raw into 4 × 256-byte quadrants
  return concat(crossMix(quads))

crossMix(quads):                                        // Q16 fixed-point
  fibs    = reverse(fibonacci_up_to(255))
  weights = [ floor(65536 / (i+1)) for i in 0.. ]       // harmonic, integer
  for qi in 0..3:
    src = quads[(qi + 1) mod 4]                          // neighbour
    for each fib index idx (mod 256):
      W = weights[step]; NW = 65536 - W
      quads[qi][idx] = (quads[qi][idx]*W + src[idx]*NW + 0x8000) >> 16
  return quads

Verify(shareSets):                                      // before any decryption
  if shares are single-split:
    seed    = SSS_combine(shareSets.map(s => s.share))
    lattice = expandToLattice(seed)
  else:                                                  // per-quadrant legacy
    lattice = concat(SSS_combine each quadrant)
  return SHA-256(lattice) == shareSets[0].commitment

Reconstruct(shareSets):
  require Verify(shareSets) == true
  if single-split: return SSS_combine(shareSets.map(s => s.share))
  else:            return AES-256-GCM-decrypt(encMaster, key=SHA-256(lattice))
```

The split commits once; every reconstruction re-derives the lattice from the *recovered* secret and checks the commitment matches. A single altered share changes the recovered seed, which avalanches through `expandToLattice` into a different commitment, and verification fails cleanly with a "shards corrupted or from different sessions" error instead of returning a wrong secret.

## Reference implementation

See [`lattice-sharding.ts`](./lattice-sharding.ts) in this directory.

External dependency: `secrets.js-grempe` for the underlying GF(2^8) Shamir split/combine. The lattice expansion, cross-mix, commitment, and AES wrapping use only the Node.js `crypto` built-in.

## Usage

```typescript
import {
  splitWithCommitment,
  verifyCommitment,
  reconstructSecret,
} from "./lattice-sharding.js";

// Split a 32-byte master seed across 5 guardians, any 3 can recover
const masterSeed = crypto.randomBytes(32);
const { shards, commitment } = splitWithCommitment(masterSeed, 5, 3);

// Distribute one shard to each guardian; store `commitment` publicly.

// At recovery time, collect any 3 shard sets and verify BEFORE decrypting:
const collected = [shards[0], shards[2], shards[4]];
if (!verifyCommitment(collected)) {
  throw new Error("shard set fails commitment — corrupted or mismatched");
}
const recovered = reconstructSecret(collected);   // === masterSeed
```

## Limitations and extensions

- **The commitment is not a per-share proof.** It verifies the *combined* set, not each share independently. To attribute corruption to a specific guardian you would need a per-share commitment scheme (e.g. Feldman or Pedersen VSS, which commit to the polynomial coefficients). This design deliberately trades that granularity for simplicity — it answers "will this set reconstruct correctly?" not "which guardian lied?".
- **No protection against a quorum of colluding guardians.** Any *k* guardians can reconstruct the secret; that is the SSS threshold model by design. The commitment defends against accidental corruption and single-share substitution, not against a malicious quorum.
- **Commitment reveals the dimension and pipeline, not the secret.** `SHA-256` of the expanded vector is preimage-resistant; publishing it leaks nothing usable. Do not, however, reuse the same commitment across unrelated secrets — treat it as a per-secret public value.
- **KDF choice.** The reference uses chunked HKDF-SHA256 for `expandToLattice`. In a deployment that already has a diffusion-hardened KDF (see guide 01), substitute it here so the expansion inherits the same pre-conditioning — the commitment logic is unchanged.
- **Pluggable dimension.** 1024/4 is a default. Larger vectors cost more hashing per verify; smaller ones reduce diffusion in the cross-mix. Keep the dimension a fixed protocol constant so old commitments stay verifiable.

```text
———————————————————————————————————————————————————————————————
 LATTICE RESIDUE · commitment-vector spill · no action required
 blk  2724373728284811412e362a27342e0d0b096b312b26612d425d576b68
      7d633810446c0e636d3b1828160705007d7c72636a6b556a1b226e726a
      6407701b017a7d777661600d014b73757373687513000562652e2c256b
      1f04056b6d1272776b455041262a2d2a226b4e435c38366e2e2833041f
      133f2d262d6102667c0e2d2a2f27697d1911513231263061244b114723
      20632f202f495441627e632824325e45412e242e637c6b657a770d6810
      0b00780003067d6d0a080c670d425227317e262c3b59481f6b2c2d252e
      760a53462229276e2e394954416c69630f686b4b435c26652436282f48
      1103796b633b2e390d455b2e6525312e255911432a22266d6132424414
      3920632b2e26481f136320242461780d5e556b766a
———————————————————————————————————————————————————————————————
```
