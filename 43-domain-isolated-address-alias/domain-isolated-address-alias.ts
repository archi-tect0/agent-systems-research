import crypto from "crypto";

const ALIAS_SALT = "IDENTITY-ALIAS-V1";

export interface AliasResult {
  domain: string;
  aliasAddress: string;
}

/**
 * Adapter boundary for turning a 32-byte private scalar into a public
 * address string. A production system uses secp256k1 + keccak-256 (the
 * Ethereum address scheme). To keep this file runnable on Node built-ins
 * only, the default codec below derives a deterministic 20-byte address
 * with SHA-256. Swap in a real secp256k1/keccak codec for production use.
 */
export type AddressCodec = (privKey: Buffer) => string;

export const sha256AddressCodec: AddressCodec = (privKey: Buffer): string => {
  const pub = crypto.createHash("sha256").update(privKey).digest();
  const addr = crypto.createHash("sha256").update(pub).digest().subarray(0, 20);
  return "0x" + addr.toString("hex");
};

/**
 * Normalize a domain so that "https://Example.com/", "example.com" and
 * "EXAMPLE.COM" all map to the same info string. This guarantees the alias
 * is stable across cosmetic variations of how a site identifies itself.
 */
export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Derive a deterministic, domain-scoped address from a master seed.
 *
 *   privKey = HKDF-SHA256(ikm=seed, salt=ALIAS_SALT, info="alias:<domain>", 32)
 *   address = codec(privKey)
 *
 * Properties:
 * - Deterministic: same seed + domain always yields the same alias.
 * - Domain-isolated: distinct domains yield uncorrelated addresses.
 * - Unlinkable: two sites cannot tell that two aliases share a seed.
 * - Registry-free: nothing is stored; aliases are recomputed on demand.
 */
export function deriveIdentityAlias(
  seedHex: string,
  domain: string,
  codec: AddressCodec = sha256AddressCodec,
): AliasResult {
  const normalizedDomain = normalizeDomain(domain);
  const ikm = Buffer.from(seedHex, "hex");
  const salt = Buffer.from(ALIAS_SALT);
  const info = Buffer.from(`alias:${normalizedDomain}`);
  const privKeyBytes = crypto.hkdfSync("sha256", ikm, salt, info, 32);
  const privKey = Buffer.from(privKeyBytes);
  return {
    domain: normalizedDomain,
    aliasAddress: codec(privKey),
  };
}

if (process.argv.includes("--demo")) {
  const seed = crypto.randomBytes(32).toString("hex");
  const domains = [
    "shop.example",
    "https://Forum.Example/",
    "bank.example",
    "social.example",
  ];

  console.log("=== Domain-Isolated Deterministic Address Aliases ===\n");
  console.log("Master seed (kept private): " + seed.slice(0, 16) + "...\n");

  const first: Record<string, string> = {};
  console.log("Derived aliases (one seed, per-domain info string):");
  for (const d of domains) {
    const r = deriveIdentityAlias(seed, d);
    first[r.domain] = r.aliasAddress;
    console.log(`  ${r.domain.padEnd(16)} -> ${r.aliasAddress}`);
  }

  console.log("\nReproducibility check (re-derive, must match):");
  for (const d of domains) {
    const r = deriveIdentityAlias(seed, d);
    const ok = first[normalizeDomain(d)] === r.aliasAddress;
    console.log(`  ${r.domain.padEnd(16)} -> ${ok ? "MATCH" : "MISMATCH"}`);
  }

  console.log("\nDistinctness check (all aliases differ):");
  const values = Object.values(first);
  const unique = new Set(values).size === values.length;
  console.log(`  ${values.length} domains -> ${new Set(values).size} unique addresses (${unique ? "OK" : "COLLISION"})`);

  console.log("\nNormalization check (same site, cosmetic variants):");
  const variants = ["forum.example", "https://forum.example", "FORUM.EXAMPLE/"];
  const derived = variants.map((v) => deriveIdentityAlias(seed, v).aliasAddress);
  const allSame = derived.every((a) => a === derived[0]);
  console.log(`  ${variants.join(", ")}`);
  console.log(`  -> ${allSame ? "all map to same alias (OK)" : "DIVERGED"}`);

  if (!unique || !allSame) process.exit(1);
}
