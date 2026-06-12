/**
 * On-Demand Encrypted Knowledge-Blob Injection
 *
 * A capable assistant needs to "know" how to operate many apps, tools, and
 * domains. Baking all of that knowledge into one static system prompt is wasteful:
 * the model pays the token cost of every capability on every turn, even the ones
 * it never uses. It also leaks the full surface of what the assistant can do.
 *
 * This system stores each capability's knowledge as a small, compressed,
 * encrypted, content-addressed blob. The base prompt stays tiny. When an incoming
 * turn matches a capability's intent patterns, its blob is fetched by content
 * hash, decrypted with a per-capability derived key, decompressed, and its
 * knowledge fragment is injected into *this turn's* context only. After the turn
 * the fragment is evicted, so nothing accumulates and prompt bloat is bounded.
 *
 * Pipeline:
 *   publish:  spec → JSON → zlib deflate → AES-256-GCM → store at sha256(ct) (cid)
 *   load:     cid → fetch ct → AES-256-GCM open → zlib inflate → spec
 *   turn:     match intent → resolve knowledge → inject → (turn runs) → evict
 *
 * The in-memory content store keyed by hash stands in for a content-addressed
 * network (e.g. IPFS). Dependencies: Node.js built-in "crypto" and "zlib".
 */

import crypto from "crypto";
import zlib from "zlib";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BlobSpec = {
  appId:          string;
  name:           string;
  intentPatterns: string[];
  /** The knowledge fragment injected into context when this app is invoked. */
  knowledge:      string;
};

export type EncryptedBlob = {
  appId: string;
  salt:  string; // hex 16 bytes — HKDF input
  iv:    string; // hex 12 bytes — GCM nonce
  tag:   string; // hex 16 bytes — GCM auth tag
  ct:    string; // hex — deflate(JSON(spec)) encrypted
};

// ── Key derivation + content store ──────────────────────────────────────────────

function deriveKey(masterSecret: string, appId: string, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(masterSecret), salt, `knowledge-blob:${appId}`, 32));
}

/** Content-addressed store: cid = sha256(ciphertext). Stands in for IPFS. */
export class ContentStore {
  private objects = new Map<string, EncryptedBlob>();

  put(blob: EncryptedBlob): string {
    const cid = crypto.createHash("sha256").update(blob.ct, "hex").digest("hex");
    this.objects.set(cid, blob);
    return cid;
  }
  get(cid: string): EncryptedBlob | undefined {
    return this.objects.get(cid);
  }
  size(): number {
    return this.objects.size;
  }
}

// ── publish / load ──────────────────────────────────────────────────────────────

export function publishBlob(spec: BlobSpec, masterSecret: string, store: ContentStore): string {
  const salt   = crypto.randomBytes(16);
  const iv     = crypto.randomBytes(12);
  const key    = deriveKey(masterSecret, spec.appId, salt);
  const packed = zlib.deflateSync(Buffer.from(JSON.stringify(spec), "utf8"));

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct     = Buffer.concat([cipher.update(packed), cipher.final()]);

  const blob: EncryptedBlob = {
    appId: spec.appId,
    salt:  salt.toString("hex"),
    iv:    iv.toString("hex"),
    tag:   cipher.getAuthTag().toString("hex"),
    ct:    ct.toString("hex"),
  };
  return store.put(blob);
}

export function loadBlob(cid: string, masterSecret: string, store: ContentStore): BlobSpec {
  const blob = store.get(cid);
  if (!blob) throw new Error(`loadBlob: no object at cid ${cid.slice(0, 12)}…`);

  const key      = deriveKey(masterSecret, blob.appId, Buffer.from(blob.salt, "hex"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
  decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
  const packed = Buffer.concat([decipher.update(Buffer.from(blob.ct, "hex")), decipher.final()]);
  const json   = zlib.inflateSync(packed).toString("utf8");
  return JSON.parse(json) as BlobSpec;
}

// ── Registry + turn-scoped context window ──────────────────────────────────────

export class KnowledgeRouter {
  private readonly store:        ContentStore;
  private readonly masterSecret: string;
  /** appId → cid (and the intent patterns kept in the clear for matching). */
  private registry = new Map<string, { cid: string; patterns: string[] }>();
  /** Knowledge fragments injected into the *current* turn only. */
  private injected = new Map<string, string>();

  constructor(store: ContentStore, masterSecret: string) {
    this.store        = store;
    this.masterSecret = masterSecret;
  }

  /** Register a capability so its blob can be matched + loaded on demand. */
  register(spec: BlobSpec): string {
    const cid = publishBlob(spec, this.masterSecret, this.store);
    this.registry.set(spec.appId, { cid, patterns: spec.intentPatterns });
    return cid;
  }

  /** Substring intent match → appId, or null if nothing matches. */
  matchIntent(userMessage: string): string | null {
    const lower = userMessage.toLowerCase();
    for (const [appId, entry] of this.registry) {
      for (const p of entry.patterns) {
        if (lower.includes(p.toLowerCase())) return appId;
      }
    }
    return null;
  }

  /** Resolve + decrypt the matched app's knowledge and inject it into this turn. */
  inject(appId: string): string {
    const entry = this.registry.get(appId);
    if (!entry) throw new Error(`inject: ${appId} not registered`);
    const spec = loadBlob(entry.cid, this.masterSecret, this.store);
    this.injected.set(appId, spec.knowledge);
    return spec.knowledge;
  }

  /** The fragments currently resident in context (what the model would see). */
  activeContext(): string {
    return [...this.injected.values()].join("\n\n");
  }

  /** Evict everything injected this turn — keeps the base prompt small. */
  evictAll(): void {
    this.injected.clear();
  }
}

// ── Demo ────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const store  = new ContentStore();
  const router = new KnowledgeRouter(store, "demo-master-secret");

  router.register({
    appId:          "mail",
    name:           "Mail",
    intentPatterns: ["send email", "check mail", "inbox", "compose"],
    knowledge:      "Mail: use send_message(recipient, body) to send; read_inbox() to list. " +
                    "Messages are end-to-end encrypted with the recipient's derived public key.",
  });
  router.register({
    appId:          "vault",
    name:           "Vault",
    intentPatterns: ["open vault", "my secrets", "stored credentials"],
    knowledge:      "Vault: read_vault(slug) / write_vault(slug, blob). Blobs are AES-256-GCM " +
                    "encrypted client-side; CIDs are content-addressed.",
  });

  console.log("objects in content store:", store.size());
  console.log("base context size:", router.activeContext().length, "chars (empty until a turn matches)\n");

  // ── A turn arrives ──────────────────────────────────────────────────────────
  const turn = "Can you check mail for me?";
  const appId = router.matchIntent(turn);
  console.log(`turn: ${JSON.stringify(turn)} → matched:`, appId);

  if (appId) {
    const fragment = router.inject(appId);
    console.log("injected fragment:", JSON.stringify(fragment.slice(0, 60) + "…"));
    console.log("active context size during turn:", router.activeContext().length, "chars");
  }

  // ── Turn ends → evict so nothing accumulates ────────────────────────────────
  router.evictAll();
  console.log("active context size after evict:", router.activeContext().length, "chars");

  // ── Tamper check: a corrupted ciphertext fails authentication ───────────────
  const entry = (router as unknown as { registry: Map<string, { cid: string }> }).registry.get("vault");
  if (entry) {
    const blob = store.get(entry.cid);
    if (blob) {
      const corrupted: EncryptedBlob = { ...blob, ct: "00" + blob.ct.slice(2) };
      const fakeStore = new ContentStore();
      const fakeCid   = fakeStore.put(corrupted);
      try {
        loadBlob(fakeCid, "demo-master-secret", fakeStore);
        console.log("\ntampered blob: UNEXPECTEDLY DECRYPTED");
      } catch {
        console.log("\ntampered blob: rejected (GCM auth failure) — as expected");
      }
    }
  }
}
