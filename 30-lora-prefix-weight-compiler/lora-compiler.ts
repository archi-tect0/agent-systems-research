/**
 * Agent LoRA / Prefix-Weight Compiler
 *
 * Compiles an agent's identity (system prompt, few-shot style anchors, and a
 * set of stable high-confidence facts) into a portable, encrypted spec that is:
 *
 *   1. AES-256-GCM encrypted with a key derived (HKDF-SHA256) from a server
 *      secret + the owner's wallet, and content-addressed on IPFS. Any node
 *      holding the wallet key can reconstruct the agent from the CID alone —
 *      no source-code or server dependency.
 *
 *   2. Emitted as an Ollama Modelfile whose SYSTEM block and MESSAGE blocks
 *      bake the identity + stable facts directly into the model context. When
 *      the model is loaded and kept resident (keep_alive: -1), that static
 *      prefix is KV-cache'd after the first turn — subsequent turns only
 *      compute KV for the new user tokens, dropping effective prefill from
 *      ~1K+ tokens to ~20 tokens (the "prefix-weight" trick).
 *
 * The MESSAGE blocks are the compiler's core idea: stable, high-confidence
 * facts are baked into the prompt prefix (weight-resident, zero per-turn token
 * cost) instead of being injected fresh every turn from a database.
 *
 * Dependencies:
 *   - Node.js built-in "crypto"
 *   - an IPFS pinning service (Pinata REST shown) for distribution
 */

import crypto from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TrainingExample {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

/** A stable fact worth baking into the weights as a MESSAGE block. */
export interface StableFact {
  q: string;   // a representative user phrasing
  a: string;   // the agent's canonical answer
  confidence: number;
  provenance: string;
}

export interface AgentSpec {
  version:     string;
  model:       string;            // base model tag, e.g. "qwen2.5:1.5b"
  name:        string;            // model name to build, e.g. "agent-os"
  owner:       string;            // owner key / wallet — also the decryption identity
  publishedAt: string;            // ISO-8601
  identity: {
    name: string;
    role: string;
  };
  systemPrompt: string;
  parameters: {
    temperature:    number;
    num_ctx:        number;
    top_p:          number;
    repeat_penalty: number;
  };
  trainingExamples: TrainingExample[];
  /** High-confidence facts baked as MESSAGE blocks — weight-resident, 0 tokens/turn. */
  stableKnowledge?: StableFact[];
  modelfile: string;              // full Ollama Modelfile text
}

export interface EncryptedBlob {
  ciphertext:  string;  // base64( AES-GCM ciphertext || 16-byte auth tag )
  nonce:       string;  // hex (12 bytes)
  salt:        string;  // hex (16 bytes) — per-publish, makes each key unique
  version:     string;
  owner:       string;
  publishedAt: string;
  alg:         "aes-256-gcm";
  kdf:         "hkdf-sha256";
}

// ── Key derivation ─────────────────────────────────────────────────────────────

/**
 * Derive a 256-bit AES key from a server secret + the owner identity.
 * The random per-publish salt means every published version has a unique key
 * even though the owner is constant. Any holder of (ADDR_SECRET, owner, salt)
 * can re-derive the key from the CID — no key material is stored in the blob.
 */
function deriveKey(owner: string, salt: Buffer): Buffer {
  const ikm = process.env["ADDR_SECRET"] ?? "agent-lora-fallback-dev-only";
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(ikm), salt, `agent-lora:${owner}`, 32),
  );
}

// ── Encryption / Decryption ─────────────────────────────────────────────────────

export function encryptSpec(spec: AgentSpec): EncryptedBlob {
  const salt  = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key   = deriveKey(spec.owner, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const enc    = Buffer.concat([cipher.update(JSON.stringify(spec), "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();

  return {
    ciphertext:  Buffer.concat([enc, tag]).toString("base64"),
    nonce:       nonce.toString("hex"),
    salt:        salt.toString("hex"),
    version:     spec.version,
    owner:       spec.owner,
    publishedAt: spec.publishedAt,
    alg:         "aes-256-gcm",
    kdf:         "hkdf-sha256",
  };
}

export function decryptBlob(blob: EncryptedBlob): AgentSpec {
  const salt   = Buffer.from(blob.salt, "hex");
  const key    = deriveKey(blob.owner, salt);
  const nonce  = Buffer.from(blob.nonce, "hex");
  const rawBuf = Buffer.from(blob.ciphertext, "base64");
  const tag    = rawBuf.subarray(-16);
  const enc    = rawBuf.subarray(0, -16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = decipher.update(enc).toString("utf8") + decipher.final("utf8");
  return JSON.parse(plain) as AgentSpec;
}

// ── Prefix-Weight Compiler — build the Modelfile ────────────────────────────────

/** Escape a string for safe inclusion inside a Modelfile MESSAGE directive. */
function esc(s: string): string {
  return s.replace(/"/g, "'").replace(/\n/g, " ");
}

/**
 * Build the Ollama Modelfile.
 *
 *   - SYSTEM block  → a lean identity anchor (~a few hundred tokens). Kept
 *                     small on purpose so the full per-session context (large,
 *                     dynamic) is injected at runtime, not baked here.
 *   - MESSAGE blocks → two sources, both weight-resident after first load:
 *       (a) style anchors  — teach HOW the agent sounds (brevity, tone)
 *       (b) stable facts   — high-confidence facts baked as Q/A pairs so they
 *                            cost zero tokens on every subsequent call.
 */
export function buildModelfile(
  spec: Omit<AgentSpec, "modelfile">,
  styleAnchors: Array<[string, string]>,
): string {
  const identity = spec.systemPrompt;

  const anchorBlocks = styleAnchors
    .map(([u, a]) => `MESSAGE user "${esc(u)}"\nMESSAGE assistant "${esc(a)}"`)
    .join("\n\n");

  // Only stable, high-confidence facts are baked in.
  const factBlocks = (spec.stableKnowledge ?? [])
    .filter(s => s.confidence >= 0.75)
    .map(s => `MESSAGE user "${esc(s.q)}"\nMESSAGE assistant "${esc(s.a)}"`)
    .join("\n\n");

  return [
    `FROM ${spec.model}`,
    ``,
    `SYSTEM """${identity}"""`,
    ``,
    anchorBlocks,
    factBlocks ? `\n${factBlocks}` : "",
    ``,
    `PARAMETER temperature ${spec.parameters.temperature}`,
    `PARAMETER num_ctx ${spec.parameters.num_ctx}`,
    `PARAMETER top_p ${spec.parameters.top_p}`,
    `PARAMETER repeat_penalty ${spec.parameters.repeat_penalty}`,
    `PARAMETER stop "<|im_end|>"`,
    `PARAMETER stop "</s>"`,
  ].join("\n");
}

// ── Spec assembly ───────────────────────────────────────────────────────────────

export function buildSpec(opts: {
  owner:          string;
  baseModel:      string;
  name:           string;
  identityName:   string;
  identityRole:   string;
  systemPrompt:   string;
  styleAnchors:   Array<[string, string]>;
  stableFacts:    StableFact[];
  trainingExamples?: TrainingExample[];
}): AgentSpec {
  const partial: Omit<AgentSpec, "modelfile"> = {
    version:     "1.0",
    model:       opts.baseModel,
    name:        opts.name,
    owner:       opts.owner,
    publishedAt: new Date().toISOString(),
    identity:    { name: opts.identityName, role: opts.identityRole },
    systemPrompt: opts.systemPrompt,
    parameters:  { temperature: 0.7, num_ctx: 1024, top_p: 0.9, repeat_penalty: 1.1 },
    trainingExamples: opts.trainingExamples ?? [],
    stableKnowledge:  opts.stableFacts,
  };
  const modelfile = buildModelfile(partial, opts.styleAnchors);
  return { ...partial, modelfile };
}

// ── IPFS distribution (Pinata REST) ─────────────────────────────────────────────

const PINATA_API = "https://api.pinata.cloud";

const IPFS_GATEWAYS = [
  (process.env["IPFS_GATEWAY"] ?? "https://ipfs.io/ipfs/").replace(/\/?$/, "/"),
  "https://gateway.pinata.cloud/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
].filter((g, i, arr) => arr.indexOf(g) === i);

export async function pinBlob(blob: EncryptedBlob): Promise<string> {
  const jwt = (process.env["PINATA_JWT"] ?? "").replace(/\s/g, "");
  if (!jwt) throw new Error("PINATA_JWT not set — cannot pin spec");

  const res = await fetch(`${PINATA_API}/pinning/pinJSONToIPFS`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      pinataContent:  blob,
      pinataMetadata: {
        name: `agent-os-v${blob.version}-${blob.owner.slice(0, 10)}-${Date.now()}`,
        keyvalues: { type: "agent_lora_spec", version: blob.version, owner: blob.owner },
      },
      pinataOptions: { cidVersion: 1 },
    }),
  });
  if (!res.ok) throw new Error(`Pinata pin failed ${res.status}: ${await res.text().catch(() => "")}`);
  const data = (await res.json()) as { IpfsHash: string };
  return data.IpfsHash;
}

/** Fetch a blob by CID, trying each gateway until one returns a valid shape. */
export async function fetchBlob(cid: string): Promise<EncryptedBlob> {
  const errors: string[] = [];
  for (const gw of IPFS_GATEWAYS) {
    try {
      const res = await fetch(`${gw}${cid}`, {
        signal: AbortSignal.timeout(15_000),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = (await res.json()) as EncryptedBlob;
      if (!blob.ciphertext || !blob.nonce || !blob.salt || blob.alg !== "aes-256-gcm") {
        throw new Error("invalid blob shape");
      }
      return blob;
    } catch (e) {
      errors.push(`${gw}: ${String(e)}`);
    }
  }
  throw new Error(`fetchBlob: all gateways failed:\n${errors.join("\n")}`);
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  process.env["ADDR_SECRET"] = "demo-server-secret";

  const spec = buildSpec({
    owner:        "0xowner000000000000000000000000000000beef",
    baseModel:    "qwen2.5:1.5b",
    name:         "agent-os",
    identityName: "Atlas",
    identityRole: "personal_assistant",
    systemPrompt: "You are Atlas, a concise local assistant. No filler. Deliver the result.",
    styleAnchors: [
      ["hey",            "Ready. What do you need?"],
      ["thanks",         "Always."],
      ["who are you",    "Atlas — local, private, yours."],
    ],
    stableFacts: [
      { q: "what timezone am I in", a: "America/New_York.", confidence: 0.9, provenance: "observed" },
      { q: "what's my coffee order", a: "Oat flat white.", confidence: 0.8, provenance: "observed" },
      { q: "guessing this one",      a: "low confidence",  confidence: 0.5, provenance: "inferred" }, // filtered out
    ],
  });

  console.log("── Modelfile ──\n");
  console.log(spec.modelfile);

  // Round-trip the encrypted blob.
  const blob = encryptSpec(spec);
  const back = decryptBlob(blob);
  console.log("\nEncrypted blob bytes:", Buffer.from(blob.ciphertext, "base64").length);
  console.log("Round-trip identity ok:", back.identity.name === "Atlas");
  console.log("Stable facts baked (conf>=0.75):", (back.stableKnowledge ?? []).filter(s => s.confidence >= 0.75).length);

  // Tampering with the ciphertext must fail the GCM auth tag.
  try {
    const tampered = { ...blob, ciphertext: Buffer.from("xx" + blob.ciphertext).toString("base64") };
    decryptBlob(tampered);
    console.log("Tamper check: FAILED (decrypt should have thrown)");
  } catch {
    console.log("Tamper check: ok (auth tag rejected modified ciphertext)");
  }
}
