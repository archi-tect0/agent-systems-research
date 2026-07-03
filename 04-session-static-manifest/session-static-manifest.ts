/**
 * Session Static Manifest (SSM)
 *
 * Manages two concerns for LLM sessions with large static system prompts:
 *
 * 1. Symbol table pre-seeding: seeds each session's compression dictionary
 *    from the static blobs at boot so compression is good from turn 1.
 *
 * 2. Static-hash tracking: SHA-256 hash of the static prompt portion,
 *    used to attach provider cache_control headers and detect invalidation.
 *
 * Dependencies: Node.js built-in "crypto" module. Pair with SqSymbolTable
 * from guide 03 for the compression functionality.
 */

import { createHash } from "node:crypto";

// ── Global boot-time seed ──────────────────────────────────────────────────────

let _globalSeedText: string | null = null;

/**
 * Call once at server boot after loading all static blobs.
 * Concatenate: system_prompt + knowledge_base + tool_catalog + any other
 * content that is identical across all sessions.
 */
export function setGlobalStaticSeedText(text: string): void {
  _globalSeedText = text;
}

export function getGlobalStaticSeedText(): string | null {
  return _globalSeedText;
}

// ── Per-session tracking ───────────────────────────────────────────────────────

interface SsmEntry {
  hash:   string;   // SHA-256(static_portion)[0:12]
  seeded: boolean;  // true once the symbol table has been pre-seeded for this session
}

// Maps conversationId (number or string) → SSM entry
const _ssm     = new Map<string | number, SsmEntry>();
const SSM_MAX  = 512; // max live sessions in memory

function evictOldest(): void {
  const key = _ssm.keys().next().value;
  if (key !== undefined) _ssm.delete(key);
}

// ── Hash helper ────────────────────────────────────────────────────────────────

/**
 * SHA-256 hash of the static prompt portion, truncated to 12 hex chars.
 * Compact enough for log fields; unique enough to detect any content change.
 */
export function hashStaticBlob(staticBlob: string): string {
  return createHash("sha256").update(staticBlob).digest("hex").slice(0, 12);
}

// ── Pre-seeding ────────────────────────────────────────────────────────────────

/**
 * A minimal interface for any symbol table that accepts ingest(text).
 * Pair with SqSymbolTable from guide 03.
 */
export interface IngestableTable {
  ingest(text: string): void;
}

/**
 * Pre-seed a session's symbol table from the global static blobs.
 *
 * Call on the first turn of each new session. Safe to call on subsequent
 * turns — it is a no-op if already seeded.
 *
 * Ingests in 3 000-character chunks so the symbol table discovers phrases
 * across all sections of the static content.
 */
export function preSeedSymbolTable(
  convId:    string | number,
  symTable:  IngestableTable,
): void {
  const entry = _ssm.get(convId);
  if (entry?.seeded) return; // already done

  const seed = _globalSeedText;
  if (seed) {
    const CHUNK_SIZE = 3_000;
    for (let i = 0; i < seed.length; i += CHUNK_SIZE) {
      symTable.ingest(seed.slice(i, i + CHUNK_SIZE));
    }
  }

  if (_ssm.size >= SSM_MAX) evictOldest();
  if (entry) {
    entry.seeded = true;
  } else {
    _ssm.set(convId, { hash: "", seeded: true });
  }
}

// ── Hash tracking ──────────────────────────────────────────────────────────────

/** Record the static blob hash for a session. Call at turn start. */
export function setStaticHash(convId: string | number, hash: string): void {
  const entry = _ssm.get(convId);
  if (entry) {
    entry.hash = hash;
  } else {
    if (_ssm.size >= SSM_MAX) evictOldest();
    _ssm.set(convId, { hash, seeded: false });
  }
}

/**
 * Returns true if the stored hash matches — the static content has not changed.
 * A mismatch means a capability grant was added/revoked and any external
 * provider cache (Anthropic, Gemini) should be considered stale.
 */
export function staticHashMatches(convId: string | number, hash: string): boolean {
  return _ssm.get(convId)?.hash === hash;
}

/** Evict a session's SSM entry (call on conversation end or capability change). */
export function evictSession(convId: string | number): void {
  _ssm.delete(convId);
}

/** Cache stats for telemetry. */
export function ssmStats(): { sessions: number; maxSessions: number } {
  return { sessions: _ssm.size, maxSessions: SSM_MAX };
}

// ── Example: integrating SSM into an LLM turn handler ─────────────────────────

if (process.argv[2] === "--demo") {
  // Simulate a minimal SqSymbolTable for demonstration
  const mockTable: IngestableTable & { phrases: string[] } = {
    phrases: [],
    ingest(text: string) {
      // In real use, this calls SqSymbolTable.ingest(text)
      const words = text.split(/\s+/);
      for (let n = 3; n <= 5; n++) {
        for (let i = 0; i <= words.length - n; i++) {
          const phrase = words.slice(i, i + n).join(" ");
          if (phrase.length >= 12) this.phrases.push(phrase);
        }
      }
    },
  };

  // Boot: set the global seed from all static blobs
  const systemPrompt  = "You are an AI assistant with access to the user's wallet and vault.";
  const knowledgeBlob = "The user prefers concise responses. The user's primary language is English.";
  const toolCatalog   = "Available tools: navigate_to, web_search, remember, recall_memory";

  setGlobalStaticSeedText([systemPrompt, knowledgeBlob, toolCatalog].join("\n\n"));

  // First turn of a new session
  const convId = "conv-123";
  preSeedSymbolTable(convId, mockTable);
  console.log(`Symbol table pre-seeded with ${mockTable.phrases.length} phrase candidates`);

  // Hash tracking for provider caching
  const staticContent = systemPrompt + knowledgeBlob;
  const hash1 = hashStaticBlob(staticContent);
  setStaticHash(convId, hash1);
  console.log("Static hash:", hash1);
  console.log("Hash matches:", staticHashMatches(convId, hash1));

  // Simulate a capability grant change (static content changed)
  const updatedContent = staticContent + "\nGranted: vault_write capability";
  const hash2 = hashStaticBlob(updatedContent);
  console.log("After grant change, hash matches:", staticHashMatches(convId, hash2));
  // → false: provider cache should be invalidated

  setStaticHash(convId, hash2); // record the new hash
  console.log("After update, hash matches:", staticHashMatches(convId, hash2)); // → true

  console.log("SSM stats:", ssmStats());
}
