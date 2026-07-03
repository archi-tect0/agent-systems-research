# Domain-Isolated Deterministic Address Aliases


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A user with a single master seed often needs to present an account address to many independent sites — a shop, a forum, a bank portal, a social app. Reusing one address everywhere is convenient but destroys privacy: any two sites (or any on-chain observer) can correlate the shared address and link the user's activity across contexts.

The naive fix is to generate a fresh random address per site and store a mapping somewhere. That reintroduces state: a registry that must be backed up, synced across devices, and protected — and whose loss means losing access to every per-site identity. What we want instead is a way to produce a **distinct, stable address for each domain** that is recomputed on demand from the master seed, with no stored mapping and no way for two sites to tell that their two addresses came from the same root.

This is **distinct from per-chain key derivation** (see guide 15, multichain shadow derivation). Per-chain derivation produces *the user's own spending keys* on Ethereum, Bitcoin, Solana, etc. — addresses the user controls and funds. Domain aliases produce *throwaway identity handles* scoped to a website's domain string; they exist for unlinkability and login, not for being the user's canonical chain wallet. The two mechanisms use the same primitive (HKDF) but answer different questions: "which chain?" versus "which site?".

## Design decisions

**Why HKDF with a per-domain `info` string?**
HKDF's `info` parameter is purpose-built for domain separation: distinct `info` values produce cryptographically independent output from the same input key material. Encoding the site's domain as `info = "alias:<domain>"` means each domain gets an independent 32-byte private scalar, and learning one alias tells an attacker nothing about any other. No counters, no per-site secrets, no registry — the domain string *is* the lookup key, and the derivation is the lookup.

**Why normalize the domain first?**
A site can refer to itself as `https://Example.com/`, `example.com`, or `EXAMPLE.COM`. If those produced different aliases the user would appear as different identities to the same site depending on cosmetic formatting. Lower-casing, trimming, stripping the scheme prefix, and removing trailing slashes collapses these variants to one canonical `info` string so the alias is stable.

**Why a fixed salt rather than a per-user random salt?**
The secret entropy already lives in the master seed (the HKDF `ikm`). The salt here serves as a protocol-level domain separator — a version tag that distinguishes this alias scheme from any other HKDF use of the same seed. A constant salt keeps derivation reproducible from the seed alone, with no extra material to store, while the version string (`IDENTITY-ALIAS-V1`) lets the scheme be rotated later by bumping the version.

**Why hide the address codec behind an adapter?**
A real deployment turns the 32-byte scalar into an address with secp256k1 (public key) + keccak-256 (Ethereum address encoding). Those are external dependencies. The derivation logic — HKDF with per-domain `info` — is the actual contribution and is fully expressible on Node built-ins. Putting the scalar→address step behind an `AddressCodec` interface lets the file run anywhere with a SHA-256 placeholder codec while a production build injects the real secp256k1/keccak codec without touching the derivation path.

**Why no central registry at all?**
Statelessness is the whole point. Because every alias is a pure function of `(seed, domain)`, any device holding the seed can reproduce every alias instantly. There is nothing to back up beyond the seed itself, nothing to sync, and no single store whose compromise leaks the full set of a user's site identities.

## Algorithm

```
Input:  seed    — master seed (hex), the HKDF input key material
        domain  — the site identifier (any cosmetic form)
        codec   — scalar -> address function (secp256k1/keccak in prod)

normalizeDomain(domain):
  d = lowercase(trim(domain))
  d = strip leading "http://" or "https://"
  d = strip trailing "/"
  return d

deriveIdentityAlias(seed, domain, codec):
  dom    = normalizeDomain(domain)
  ikm    = bytes(seed, hex)
  salt   = bytes("IDENTITY-ALIAS-V1")
  info   = bytes("alias:" + dom)
  priv   = HKDF-SHA256(ikm, salt, info, 32)      // 32-byte private scalar
  return { domain: dom, aliasAddress: codec(priv) }
```

Different `domain` values change `info`, which makes HKDF emit independent scalars, which the codec maps to uncorrelated addresses. The same `(seed, domain)` always reproduces the same scalar and therefore the same address.

## Reference implementation

See [`domain-isolated-address-alias.ts`](./domain-isolated-address-alias.ts) in this directory. The derivation runs entirely on the Node `crypto` built-in; the production address codec (secp256k1 + keccak-256) is an external dependency hidden behind the `AddressCodec` adapter, and the demo uses a SHA-256 placeholder codec so the file runs with no extra packages.

## Usage

```typescript
import { deriveIdentityAlias, normalizeDomain, sha256AddressCodec } from "./domain-isolated-address-alias.js";
import type { AddressCodec } from "./domain-isolated-address-alias.js";

// Derive a per-site alias from one master seed.
const a = deriveIdentityAlias(masterSeedHex, "https://shop.example/");
console.log(a.domain);        // "shop.example"
console.log(a.aliasAddress);  // 0x... deterministic per (seed, domain)

// A different site yields an uncorrelated address.
const b = deriveIdentityAlias(masterSeedHex, "forum.example");

// Inject a production secp256k1 + keccak-256 codec in real deployments.
const realCodec: AddressCodec = (priv) => toEthAddress(priv);
const c = deriveIdentityAlias(masterSeedHex, "bank.example", realCodec);

// Normalization is exposed for callers that want to canonicalize first.
normalizeDomain("EXAMPLE.COM/"); // "example.com"
```

## Limitations and extensions

- **Placeholder codec is not a real address scheme.** `sha256AddressCodec` produces a deterministic 20-byte value for demonstration only. Inject a secp256k1 + keccak-256 codec for any address that must be valid on a real chain.
- **Domain string is the security boundary.** Aliases are only as well-isolated as the domain normalization. If two genuinely different sites are normalized to the same string they share an alias; pick the canonical identifier (e.g. registrable domain) deliberately.
- **No revocation per site.** Because aliases are pure functions of the seed, you cannot "rotate" one site's alias without changing the scheme version (the salt). Add a per-domain version suffix to `info` (`alias:<domain>:v2`) if per-site rotation is required.
- **Not a spending wallet.** These aliases are identity handles, not the user's canonical chain accounts. Use guide 15 (multichain shadow derivation) for funded per-chain keys.
- **Seed compromise is total.** Anyone with the master seed can recompute every alias. Protect the seed with the same rigor as any root key; the statelessness that removes the registry also removes any second factor.
