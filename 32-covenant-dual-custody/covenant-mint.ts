/**
 * Covenant Dual-Custody — paired human + machine identity NFTs
 *
 * Mints TWO linked NFT records per identity at bind time:
 *   user NFT     → owned by the user's wallet           (human proof)
 *   machine NFT  → owned by a DERIVED companion wallet   (machine proof)
 * linked by one covenant row. The pairing attests that the human and the
 * machine were co-minted together at creation.
 *
 * Key properties reproduced from the production design:
 *   - The companion wallet is DETERMINISTICALLY DERIVED from the user wallet via
 *     HKDF-SHA256, so the pairing is always re-verifiable from the user wallet
 *     alone — no separately stored mapping that could drift or be forged.
 *   - mintCovenantPair is IDEMPOTENT (keyed on the covenant row) and NON-FATAL
 *     (catches all errors, returns null) so a transient failure at bind time
 *     never blocks the user; the lazy-mint-on-read path heals the gap.
 *
 * In-memory stores stand in for the asset_items + identity_covenants tables.
 *
 * Dependencies: Node.js built-in "crypto" only.
 */

import crypto from "crypto";

const COVENANT_DOMAIN = "COVENANT-V1";

// ── Types ────────────────────────────────────────────────────────────────────

interface AssetItem {
  id: string;
  ownerWallet: string;
  name: string;
  description: string;
  category: "covenant_nft";
  serialNumber: string;
  metadata: Record<string, unknown>;
}

export interface CovenantRow {
  wallet: string;
  userNftAssetId: string;
  companionWallet: string;
  machineNftAssetId: string;
  status: "active";
}

export interface CovenantMintResult {
  created: boolean;
  wallet: string;
  userNftAssetId: string;
  machineNftAssetId: string;
  companionWallet: string;
}

// ── Registry ─────────────────────────────────────────────────────────────────

export class CovenantRegistry {
  private readonly addrSecret: string;
  private readonly assets    = new Map<string, AssetItem>();
  private readonly covenants = new Map<string, CovenantRow>();

  constructor(addrSecret: string) {
    this.addrSecret = addrSecret;
  }

  /** Deterministically derive the companion (machine) wallet for a user wallet. */
  deriveCompanionWallet(wallet: string): string {
    const raw = crypto.hkdfSync(
      "sha256",
      Buffer.from(`${wallet.toLowerCase()}:${this.addrSecret}`),
      Buffer.from(COVENANT_DOMAIN),
      Buffer.from("machine-covenant-address"),
      32,
    );
    return "0x" + Buffer.from(raw).toString("hex").slice(0, 40);
  }

  private covenantNftName(wallet: string, role: "user" | "machine"): string {
    const short = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
    return role === "user"
      ? `Identity Covenant · Human Proof · ${short}`
      : `Identity Covenant · Machine Proof · ${short}`;
  }

  private insertAsset(a: Omit<AssetItem, "id">): AssetItem {
    const item: AssetItem = { id: crypto.randomUUID(), ...a };
    this.assets.set(item.id, item);
    return item;
  }

  /**
   * Mint (or return existing) covenant NFT pair. Idempotent + non-fatal:
   * returns the existing pair if one exists, returns null on any error.
   */
  mintCovenantPair(wallet: string): CovenantMintResult | null {
    const w = wallet.toLowerCase();
    try {
      // Idempotency: the covenant row is the single source of truth.
      const existing = this.covenants.get(w);
      if (existing) {
        return {
          created: false,
          wallet: w,
          userNftAssetId: existing.userNftAssetId,
          machineNftAssetId: existing.machineNftAssetId,
          companionWallet: existing.companionWallet,
        };
      }

      const companionWallet = this.deriveCompanionWallet(w);
      const mintedAt = new Date().toISOString();

      // Human proof — owned by the user's own wallet.
      const userNft = this.insertAsset({
        ownerWallet: w,
        name: this.covenantNftName(w, "user"),
        description: "Identity Covenant — Human Proof. Minted at wallet bind time; certifies the human side of the identity covenant.",
        category: "covenant_nft",
        serialNumber: `COVENANT-HUMAN-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
        metadata: { type: "covenant", role: "user", wallet: w, mintedAt },
      });

      // Machine proof — owned by the DERIVED companion wallet.
      const machineNft = this.insertAsset({
        ownerWallet: companionWallet,
        name: this.covenantNftName(w, "machine"),
        description: "Identity Covenant — Machine Proof. Minted at wallet bind time; certifies the machine side of the identity covenant.",
        category: "covenant_nft",
        serialNumber: `COVENANT-MACHINE-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
        metadata: { type: "covenant", role: "machine", userWallet: w, companionWallet, mintedAt },
      });

      // Link both in the authoritative covenant row.
      const row: CovenantRow = {
        wallet: w,
        userNftAssetId: userNft.id,
        companionWallet,
        machineNftAssetId: machineNft.id,
        status: "active",
      };
      this.covenants.set(w, row);

      return {
        created: true,
        wallet: w,
        userNftAssetId: userNft.id,
        machineNftAssetId: machineNft.id,
        companionWallet,
      };
    } catch {
      // Non-fatal: never block the user's core flow on a covenant mint failure.
      return null;
    }
  }

  /** GET /covenant — lazy-mint the pair on first read if absent. */
  getCovenant(wallet: string): CovenantRow {
    const w = wallet.toLowerCase();
    const row = this.covenants.get(w);
    if (row) return row;

    const result = this.mintCovenantPair(w);
    if (!result) throw new Error("covenant_mint_failed");
    const fresh = this.covenants.get(w);
    if (!fresh) throw new Error("covenant_row_missing_after_mint");
    return fresh;
  }

  /** Look up an asset record (for verification / display). */
  getAsset(assetId: string): AssetItem | undefined {
    return this.assets.get(assetId);
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const reg = new CovenantRegistry("demo-server-secret");

  // Idempotent mint
  const first  = reg.mintCovenantPair("0xUserWallet")!;
  const second = reg.mintCovenantPair("0xUserWallet")!;
  console.log("First mint created:", first.created, "| second:", second.created);
  console.log("Companion wallet:", first.companionWallet);
  console.log("Deterministic across calls:", first.companionWallet === second.companionWallet);

  // The pair is two NFTs owned by two different custodians
  const userNft    = reg.getAsset(first.userNftAssetId)!;
  const machineNft = reg.getAsset(first.machineNftAssetId)!;
  console.log("\nHuman proof  owner:", userNft.ownerWallet);
  console.log("Machine proof owner:", machineNft.ownerWallet);
  console.log("Distinct custodians:", userNft.ownerWallet !== machineNft.ownerWallet);

  // Companion is re-derivable from the user wallet alone
  console.log("\nRe-derived matches:", reg.deriveCompanionWallet("0xUserWallet") === first.companionWallet);

  // Lazy mint on read
  const row = reg.getCovenant("0xAnotherUser");
  console.log("\nLazy-minted on read:", row.wallet, "→", row.machineNftAssetId.slice(0, 8) + "…");
}
