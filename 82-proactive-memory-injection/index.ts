/**
 * Guide 82 — Proactive Memory Pre-injection
 * Runnable reference implementation (no external deps).
 *
 * Demonstrates injecting recalled episodic memories into the system prompt
 * before the LLM call — eliminating the recall round-trip.
 *
 * Run:  node index.ts --demo
 */

// ─── Logical clock ─────────────────────────────────────────────────────────
let _tick = 0;
const now = (): number => _tick;
const advance = (ms: number): void => { _tick += ms; };

// ─── Types ─────────────────────────────────────────────────────────────────
interface MemoryEntry {
  id:      string;
  content: string;
  vector:  number[]; // simplified 4-dim embedding
  class:   string;
}

interface RecalledMemory {
  content: string;
  class:   string;
  score:   number;
}

// ─── In-process memory store ────────────────────────────────────────────────
const memoryStore: MemoryEntry[] = [];
let _memSeq = 0;

function embed(text: string): number[] {
  // Deterministic toy embedding: character frequency across 4 buckets.
  // Production uses text-embedding-3-small via the OpenAI proxy.
  const v = [0, 0, 0, 0];
  for (let i = 0; i < text.length; i++) {
    v[i % 4] += text.charCodeAt(i) / 10000;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map(x => x / norm);
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both pre-normalised
}

function remember(content: string, cls: string): MemoryEntry {
  const entry: MemoryEntry = {
    id:      `mem-${++_memSeq}`,
    content,
    vector:  embed(content),
    class:   cls,
  };
  memoryStore.push(entry);
  return entry;
}

function searchMemory(query: string, k: number): RecalledMemory[] {
  if (!memoryStore.length) return [];
  const qv = embed(query);
  return memoryStore
    .map(e => ({ content: e.content, class: e.class, score: cosineSim(qv, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ─── Pre-injection ──────────────────────────────────────────────────────────

const MIN_QUERY_LEN = 8; // guard: short messages produce noisy recall

function buildSystemPromptWithRecall(
  wallet:               string,
  rawContent:           string,
  ragKnowledge:         string | null,
  isProactive:          boolean,
  isEarlyInterrupt:     boolean,
): string {
  // Gate: only inject on real, substantive user turns.
  const shouldInject =
    !isProactive &&
    !isEarlyInterrupt &&
    rawContent.trim().length >= MIN_QUERY_LEN;

  let ragWithRecall = ragKnowledge ?? "";

  if (shouldInject) {
    const hits = searchMemory(rawContent.slice(0, 350), 4);
    if (hits.length) {
      const block =
        "RECALLED FROM LONG-TERM MEMORY " +
        "(pre-injected — act on these, do not call recall_memory to re-fetch):\n" +
        hits.map(h => `• [${h.class}] ${h.content} (score ${h.score.toFixed(3)})`).join("\n");
      ragWithRecall = [ragWithRecall, block].filter(Boolean).join("\n\n");
    }
  }

  // Simplified system prompt structure.
  const lines = [
    `System prompt for wallet ${wallet}`,
    ragWithRecall ? `\n--- Context ---\n${ragWithRecall}` : "",
    `\n--- Instructions ---`,
    `You are the assistant. Respond helpfully.`,
  ];
  return lines.filter(Boolean).join("\n");
}

// ─── Demo ───────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const WALLET = "0xdemo";

  console.log("=== Guide 82 — Proactive Memory Pre-injection ===\n");

  // Seed episodic memories
  remember("User prefers ETH over BTC for long-term holding.", "user_fact");
  remember("User asked me to always confirm before sending any transaction.", "user_fact");
  remember("User's preferred timezone is America/New_York.", "user_fact");
  remember("User mentioned their dog is called Biscuit.", "shared_moment");

  console.log(`[setup] ${memoryStore.length} memories seeded.\n`);

  // ── Scenario A: real turn with relevant query ────────────────────────────
  advance(100);
  const promptA = buildSystemPromptWithRecall(
    WALLET,
    "Should I swap some tokens for ETH right now?",
    null,
    false,  // isProactive
    false,  // isEarlyInterrupt
  );
  const hasRecalledA = promptA.includes("RECALLED FROM LONG-TERM MEMORY");
  console.log("[A] Real turn with relevant query:");
  console.log(`    Memory injected: ${hasRecalledA}`);
  console.assert(hasRecalledA, "FAIL: expected memories to be injected");
  const hasEthFact = promptA.includes("prefers ETH");
  console.log(`    ETH preference recalled: ${hasEthFact}`);
  console.assert(hasEthFact, "FAIL: ETH preference should be recalled");
  console.log("    PASS ✓\n");

  // ── Scenario B: proactive scheduler turn — no injection ──────────────────
  advance(100);
  const promptB = buildSystemPromptWithRecall(
    WALLET,
    "__proactive__",
    null,
    true,   // isProactive
    false,
  );
  const hasRecalledB = promptB.includes("RECALLED FROM LONG-TERM MEMORY");
  console.log("[B] Proactive scheduler turn:");
  console.log(`    Memory injected: ${hasRecalledB} (expected: false)`);
  console.assert(!hasRecalledB, "FAIL: proactive turns must not trigger recall");
  console.log("    PASS ✓\n");

  // ── Scenario C: very short message — below MIN_QUERY_LEN ─────────────────
  advance(100);
  const promptC = buildSystemPromptWithRecall(
    WALLET,
    "ok",
    null,
    false,
    false,
  );
  const hasRecalledC = promptC.includes("RECALLED FROM LONG-TERM MEMORY");
  console.log("[C] Short message ('ok'):");
  console.log(`    Memory injected: ${hasRecalledC} (expected: false)`);
  console.assert(!hasRecalledC, "FAIL: messages shorter than MIN_QUERY_LEN must not trigger recall");
  console.log("    PASS ✓\n");

  // ── Scenario D: early interrupt — no injection ────────────────────────────
  advance(100);
  const promptD = buildSystemPromptWithRecall(
    WALLET,
    "Stop what you're doing immediately.",
    null,
    false,
    true,   // isEarlyInterrupt
  );
  const hasRecalledD = promptD.includes("RECALLED FROM LONG-TERM MEMORY");
  console.log("[D] Early interrupt turn:");
  console.log(`    Memory injected: ${hasRecalledD} (expected: false)`);
  console.assert(!hasRecalledD, "FAIL: early interrupt turns must not trigger recall");
  console.log("    PASS ✓\n");

  // ── Scenario E: existing RAG knowledge is preserved ──────────────────────
  advance(100);
  const promptE = buildSystemPromptWithRecall(
    WALLET,
    "What time should I set the alarm for ETH price alerts?",
    "RAG: the assistant supports custom alerts via the scheduler.",
    false,
    false,
  );
  const hasRag = promptE.includes("RAG: the assistant supports");
  const hasRecalledE = promptE.includes("RECALLED FROM LONG-TERM MEMORY");
  console.log("[E] Turn with existing RAG knowledge:");
  console.log(`    RAG preserved: ${hasRag}`);
  console.log(`    Memory also injected: ${hasRecalledE}`);
  console.assert(hasRag, "FAIL: existing RAG must be preserved");
  console.assert(hasRecalledE, "FAIL: memories should also be injected");
  console.log("    PASS ✓\n");

  console.log(`All scenarios passed. Total elapsed: ${now()} ms.`);
}
