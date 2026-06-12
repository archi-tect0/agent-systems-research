/**
 * Multi-Chain Shadow Wallet Derivation
 *
 * Deterministically derives a distinct keypair + address for Bitcoin, Solana,
 * EVM chains, and TRON from a single identity string plus a server-held secret,
 * using HKDF-SHA256 (RFC 5869). No BIP-39 mnemonic, no seed phrase, no per-key
 * storage — the same address re-derives identically on any machine forever.
 *
 * Key separation:
 *   ikm  = "<identity>:<addrSecret>"   (two-factor: per-user id + server secret)
 *   salt = "<CHAIN>-ADDRESS-V1"        (chain + version domain separation)
 *   info = "<chain>-shadow-key"        (role domain separation)
 *
 * Each chain gets an independent uniformly-random 32-byte key; learning one
 * chain's key reveals nothing about the others.
 *
 * Dependencies:
 *   @noble/curves  — secp256k1, ed25519
 *   @noble/hashes  — keccak_256, ripemd160, sha256, base58, bech32
 *   node:crypto    — hkdfSync
 */

import crypto from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ed25519 } from "@noble/curves/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/legacy";
import { base58, bech32 } from "@noble/hashes/utils";

// ── Core derivation ─────────────────────────────────────────────────────────

/**
 * Derive a chain-specific 32-byte key.
 *
 * @param identity   user identity string (login handle / root address)
 * @param addrSecret server-held secret — never sent to the client
 * @param salt       chain + version domain ("SHADOW-BTC-ADDRESS-V1")
 * @param info       role domain ("btc-shadow-key")
 */
function deriveKey(identity: string, addrSecret: string, salt: string, info: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(`${identity}:${addrSecret}`),
      Buffer.from(salt),
      Buffer.from(info),
      32,
    ),
  );
}

// ── Bitcoin (P2WPKH / native SegWit) ─────────────────────────────────────────

export function deriveBtc(identity: string, addrSecret: string): {
  privateKey: Buffer;
  publicKey: Buffer;
  address: string;
} {
  const privateKey = deriveKey(identity, addrSecret, "SHADOW-BTC-ADDRESS-V1", "btc-shadow-key");
  const publicKey  = Buffer.from(secp256k1.getPublicKey(privateKey, true)); // 33-byte compressed

  // Witness program v0 = ripemd160(sha256(pubkey)) — 20 bytes
  const program = ripemd160(sha256(publicKey));
  // bech32: hrp "bc", witness version 0 prepended as a 5-bit word
  const words = [0, ...bech32.toWords(program)];
  const address = bech32.encode("bc", words);

  return { privateKey, publicKey, address };
}

// ── Solana (Ed25519) ─────────────────────────────────────────────────────────

export function deriveSol(identity: string, addrSecret: string): {
  seed: Buffer;
  publicKey: Buffer;
  address: string;
} {
  // For Ed25519 the 32-byte HKDF output is the *seed*; the library expands it.
  const seed      = deriveKey(identity, addrSecret, "SHADOW-SOL-ADDRESS-V1", "sol-shadow-key");
  const publicKey = Buffer.from(ed25519.getPublicKey(seed)); // 32 bytes
  const address   = base58.encode(publicKey);
  return { seed, publicKey, address };
}

// ── EVM (Ethereum / BNB Chain / Polygon / Base / …) ──────────────────────────

export function deriveEvm(identity: string, addrSecret: string): {
  privateKey: Buffer;
  address: string;
} {
  // For secp256k1 chains the 32 bytes ARE the scalar private key.
  const privateKey   = deriveKey(identity, addrSecret, "SHADOW-EVM-ADDRESS-V1", "evm-shadow-key");
  const uncompressed = secp256k1.getPublicKey(privateKey, false); // 65 bytes (0x04 || X || Y)
  const hash         = keccak_256(uncompressed.slice(1));         // drop 0x04 prefix
  const addrBytes    = Buffer.from(hash.slice(12));               // last 20 bytes
  return { privateKey, address: toEip55(addrBytes) };
}

/** EIP-55 mixed-case checksum encoding of a 20-byte address. */
function toEip55(addrBytes: Buffer): string {
  const hex  = addrBytes.toString("hex");
  const hash = Buffer.from(keccak_256(Buffer.from(hex, "ascii"))).toString("hex");
  let out = "0x";
  for (let i = 0; i < hex.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return out;
}

// ── TRON (secp256k1 + keccak + 0x41 version + Base58Check) ────────────────────

export function deriveTron(identity: string, addrSecret: string): {
  privateKey: Buffer;
  address: string;
} {
  const privateKey   = deriveKey(identity, addrSecret, "SHADOW-TRX-ADDRESS-V1", "tron-shadow-key");
  const uncompressed = secp256k1.getPublicKey(privateKey, false);
  const hash         = keccak_256(uncompressed.slice(1));
  const raw20        = Buffer.from(hash.slice(12));               // same 20 bytes as EVM
  const payload      = Buffer.concat([Buffer.from([0x41]), raw20]); // 0x41 = TRON mainnet prefix
  const checksum     = Buffer.from(sha256(sha256(payload))).slice(0, 4);
  const address      = base58.encode(Buffer.concat([payload, checksum]));
  return { privateKey, address };
}

// ── Convenience: derive every chain at once ──────────────────────────────────

export function deriveAllChains(identity: string, addrSecret: string): {
  btc: string;
  sol: string;
  evm: string;
  tron: string;
} {
  return {
    btc:  deriveBtc(identity, addrSecret).address,
    sol:  deriveSol(identity, addrSecret).address,
    evm:  deriveEvm(identity, addrSecret).address,
    tron: deriveTron(identity, addrSecret).address,
  };
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const identity   = "user@example.com";
  const addrSecret = "demo-server-secret-keep-this-safe";

  const all = deriveAllChains(identity, addrSecret);
  console.log("Derived shadow addresses:");
  console.log("  BTC  (P2WPKH):", all.btc);
  console.log("  SOL  (Ed25519):", all.sol);
  console.log("  EVM  (all EVM chains):", all.evm);
  console.log("  TRON (Base58Check):", all.tron);

  // Determinism: same inputs → same outputs
  const again = deriveAllChains(identity, addrSecret);
  console.log("\nDeterministic:", JSON.stringify(all) === JSON.stringify(again));

  // Domain isolation: a different identity yields entirely different addresses
  const other = deriveAllChains("someone-else@example.com", addrSecret);
  console.log("Identity-isolated:", all.evm !== other.evm && all.btc !== other.btc);
}
