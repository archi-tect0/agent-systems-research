/**
 * Wallet-to-Wallet End-to-End Encrypted Messaging
 *
 * A private messaging system addressed by wallet. The server is a BLIND relay:
 * it stores opaque ciphertext envelopes it cannot decrypt, manages folders
 * (inbox/sent/archive/trash), tracks read state, and indexes ONLY metadata
 * (subject + addressing) into an agent-memory sink — never the message body.
 *
 * Each message envelope is three opaque fields the server treats as blobs:
 *   - bodyCiphertext       : encrypted body
 *   - bodyIv               : per-message nonce / IV
 *   - ephemeralPublicKey   : sender's fresh ephemeral public key (forward secrecy)
 *
 * Encryption happens entirely on the client. The included `DemoCrypto` helper
 * plays the client role (ECDH + AES-GCM via Node's crypto) so the demo shows a
 * real round-trip the server never sees in plaintext.
 *
 * Dependencies: Node.js built-in "crypto" only.
 */

import crypto from "crypto";

// ── Server-side types ────────────────────────────────────────────────────────

export interface Envelope {
  bodyCiphertext: string;
  bodyIv: string;
  ephemeralPublicKey: string;
}

export interface Message extends Envelope {
  id: string;
  senderWallet: string;
  recipientWallet: string;
  subject: string;
  senderHandle: string | null;
  recipientHandle: string | null;
  threadId: string | null;
  sentAt: number;
  readAt: number | null;
  archivedAt: number | null;
  deletedAt: number | null;
}

/** Memory note — metadata ONLY, never the encrypted body. */
export interface MemoryNote {
  wallet: string;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
}

export type MemorySink = (note: MemoryNote) => void;

export class MessageError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "MessageError";
  }
}

// ── Server: blind relay + folder manager + key directory ─────────────────────

export class MessageRelay {
  private messages = new Map<string, Message>();
  private keys = new Map<string, { publicKeyB64: string; updatedAt: number }>();

  private remember: MemorySink;
  /** @param remember memory sink; receives metadata only, fire-and-forget. */
  constructor(remember: MemorySink = () => {}) {
    this.remember = remember;
  }

  private norm(w: string): string {
    return w.toLowerCase();
  }

  // ── Public-key directory ────────────────────────────────────────────────────
  publishKey(wallet: string, publicKeyB64: string): void {
    if (!publicKeyB64) throw new MessageError(400, "publicKeyB64_required");
    this.keys.set(this.norm(wallet), { publicKeyB64, updatedAt: Date.now() });
  }

  getKey(wallet: string): { publicKeyB64: string } | null {
    const k = this.keys.get(this.norm(wallet));
    return k ? { publicKeyB64: k.publicKeyB64 } : null;
  }

  // ── Send: store opaque envelope, index metadata only ────────────────────────
  send(
    senderWallet: string,
    msg: {
      recipientWallet: string;
      subject: string;
      bodyCiphertext: string;
      bodyIv: string;
      ephemeralPublicKey: string;
      threadId?: string;
      senderHandle?: string | null;
      recipientHandle?: string | null;
    },
  ): Message {
    if (!msg.recipientWallet || !msg.subject || !msg.bodyCiphertext || !msg.bodyIv || !msg.ephemeralPublicKey) {
      throw new MessageError(400, "recipient_subject_and_envelope_required");
    }

    const m: Message = {
      id: crypto.randomUUID(),
      senderWallet: this.norm(senderWallet),
      recipientWallet: this.norm(msg.recipientWallet),
      subject: msg.subject,
      bodyCiphertext: msg.bodyCiphertext,      // opaque — server cannot read
      bodyIv: msg.bodyIv,                       // opaque
      ephemeralPublicKey: msg.ephemeralPublicKey, // opaque
      senderHandle: msg.senderHandle ?? null,
      recipientHandle: msg.recipientHandle ?? null,
      threadId: msg.threadId ?? null,
      sentAt: Date.now(),
      readAt: null,
      archivedAt: null,
      deletedAt: null,
    };
    this.messages.set(m.id, m);

    // Index METADATA ONLY into agent memory. The body is never passed here.
    // Fire-and-forget + non-fatal: a memory failure must not block delivery.
    try {
      const to = m.recipientHandle ?? m.recipientWallet.slice(0, 10) + "…";
      this.remember({
        wallet: m.senderWallet,
        content: `Message sent to ${to}: "${m.subject}"`,
        source: "message_sent",
        metadata: {
          kind: "message",
          direction: "sent",
          messageId: m.id,
          recipientWallet: m.recipientWallet,
          recipientHandle: m.recipientHandle,
          subject: m.subject,
          sentAt: new Date(m.sentAt).toISOString(),
        },
      });
    } catch {
      /* non-fatal */
    }

    return m;
  }

  // ── Read: wallet-scoped; stamps readAt for the recipient ────────────────────
  readMessage(callerWallet: string, id: string): Message {
    const w = this.norm(callerWallet);
    const m = this.messages.get(id);
    if (!m || (m.senderWallet !== w && m.recipientWallet !== w)) {
      throw new MessageError(404, "not_found");
    }
    if (m.recipientWallet === w && !m.readAt) m.readAt = Date.now();
    return m;
  }

  // ── Folders (single-row state, derived from columns + role) ─────────────────
  inbox(callerWallet: string): Message[] {
    const w = this.norm(callerWallet);
    return this.sortNewest(
      [...this.messages.values()].filter((m) => m.recipientWallet === w && !m.archivedAt && !m.deletedAt),
    );
  }

  sent(callerWallet: string): Message[] {
    const w = this.norm(callerWallet);
    return this.sortNewest([...this.messages.values()].filter((m) => m.senderWallet === w && !m.deletedAt));
  }

  archiveFolder(callerWallet: string): Message[] {
    const w = this.norm(callerWallet);
    return this.sortNewest(
      [...this.messages.values()].filter((m) => m.recipientWallet === w && m.archivedAt && !m.deletedAt),
    );
  }

  trash(callerWallet: string): Message[] {
    const w = this.norm(callerWallet);
    return this.sortNewest(
      [...this.messages.values()].filter((m) => (m.senderWallet === w || m.recipientWallet === w) && m.deletedAt),
    );
  }

  private sortNewest(list: Message[]): Message[] {
    return list.sort((a, b) => b.sentAt - a.sentAt);
  }

  // ── State transitions (wallet-scoped) ───────────────────────────────────────
  markRead(callerWallet: string, id: string): Message {
    const w = this.norm(callerWallet);
    const m = this.messages.get(id);
    if (!m || m.recipientWallet !== w) throw new MessageError(404, "not_found");
    m.readAt = Date.now();
    return m;
  }

  toggleArchive(callerWallet: string, id: string): Message {
    const w = this.norm(callerWallet);
    const m = this.messages.get(id);
    if (!m || m.recipientWallet !== w) throw new MessageError(404, "not_found");
    m.archivedAt = m.archivedAt ? null : Date.now();
    return m;
  }

  /** Soft delete (→ trash), then hard delete on a second call. */
  deleteMessage(callerWallet: string, id: string): { ok: true; hard: boolean } {
    const w = this.norm(callerWallet);
    const m = this.messages.get(id);
    if (!m || (m.senderWallet !== w && m.recipientWallet !== w)) throw new MessageError(404, "not_found");
    if (m.deletedAt) {
      this.messages.delete(id);
      return { ok: true, hard: true };
    }
    m.deletedAt = Date.now();
    return { ok: true, hard: false };
  }

  // ── Stats ───────────────────────────────────────────────────────────────────
  stats(callerWallet: string): { inboxCount: number; unreadCount: number; sentCount: number; archiveCount: number; trashCount: number } {
    const inbox = this.inbox(callerWallet);
    return {
      inboxCount: inbox.length,
      unreadCount: inbox.filter((m) => !m.readAt).length,
      sentCount: this.sent(callerWallet).length,
      archiveCount: this.archiveFolder(callerWallet).length,
      trashCount: this.trash(callerWallet).length,
    };
  }
}

// ── DemoCrypto: stands in for the CLIENT (ECDH + AES-GCM) ─────────────────────
// Demonstrates a real sealed-box-style round-trip. The server never runs this.

export class DemoCrypto {
  /** A user's long-term identity keypair (X25519). */
  static generateIdentity(): { publicKeyB64: string; privateKeyB64: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
    return {
      publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      privateKeyB64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    };
  }

  private static importPublic(b64: string): crypto.KeyObject {
    return crypto.createPublicKey({ key: Buffer.from(b64, "base64"), type: "spki", format: "der" });
  }
  private static importPrivate(b64: string): crypto.KeyObject {
    return crypto.createPrivateKey({ key: Buffer.from(b64, "base64"), type: "pkcs8", format: "der" });
  }

  /** Encrypt a body to a recipient's published public key. Returns an envelope. */
  static seal(recipientPublicKeyB64: string, plaintext: string): Envelope {
    const eph = crypto.generateKeyPairSync("x25519"); // fresh ephemeral key per message
    const shared = crypto.diffieHellman({
      privateKey: eph.privateKey,
      publicKey: this.importPublic(recipientPublicKeyB64),
    });
    const aesKey = crypto.createHash("sha256").update(shared).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      bodyCiphertext: Buffer.concat([ct, tag]).toString("base64"),
      bodyIv: iv.toString("base64"),
      ephemeralPublicKey: eph.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    };
  }

  /** Decrypt an envelope with the recipient's long-term private key. */
  static open(recipientPrivateKeyB64: string, env: Envelope): string {
    const shared = crypto.diffieHellman({
      privateKey: this.importPrivate(recipientPrivateKeyB64),
      publicKey: this.importPublic(env.ephemeralPublicKey),
    });
    const aesKey = crypto.createHash("sha256").update(shared).digest();
    const raw = Buffer.from(env.bodyCiphertext, "base64");
    const ct = raw.subarray(0, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(env.bodyIv, "base64"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const memoryNotes: MemoryNote[] = [];
  const relay = new MessageRelay((note) => memoryNotes.push(note));

  const alice = DemoCrypto.generateIdentity();
  const bob = DemoCrypto.generateIdentity();
  relay.publishKey("0xALICE", alice.publicKeyB64);
  relay.publishKey("0xBOB", bob.publicKeyB64);

  // Alice encrypts to Bob's published key (client-side) and sends an opaque envelope
  const bobPub = relay.getKey("0xBOB")!.publicKeyB64;
  const env = DemoCrypto.seal(bobPub, "the audit is clean");
  const stored = relay.send("0xALICE", { recipientWallet: "0xBOB", subject: "Audit", ...env });

  console.log("server stored ciphertext only:", stored.bodyCiphertext.slice(0, 16) + "…");
  console.log("server has no key — body is opaque to it");

  // Memory indexed METADATA only (no ciphertext, no plaintext)
  console.log("memory note:", memoryNotes[0]?.content);
  console.log("memory has no body field:", !("body" in (memoryNotes[0]?.metadata ?? {})));

  // Bob reads from inbox and decrypts locally
  const inboxMsg = relay.inbox("0xBOB")[0]!;
  const full = relay.readMessage("0xBOB", inboxMsg.id);
  console.log("bob decrypts:", DemoCrypto.open(bob.privateKeyB64, full));

  // A stranger cannot read the message by id
  try { relay.readMessage("0xSTRANGER", inboxMsg.id); }
  catch (e) { console.log("stranger read rejected:", (e as MessageError).code); }

  // Folder + delete semantics
  console.log("stats:", relay.stats("0xBOB"));
  console.log("soft delete:", relay.deleteMessage("0xBOB", inboxMsg.id));
  console.log("hard delete:", relay.deleteMessage("0xBOB", inboxMsg.id));
}
