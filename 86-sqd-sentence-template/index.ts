/**
 * Guide 86 — SQ-D: Sentence Template Compression
 * Runnable reference implementation (no external deps, no DB).
 *
 * Demonstrates:
 *   A. Extracting sentence skeletons from an assistant message corpus
 *   B. Clustering by skeleton and ranking by frequency
 *   C. Building the template registry and header
 *   D. Compressing a 6-turn history using template matching
 *   E. Decompressing by substituting fills into the registered skeleton
 *   F. Verifying exact fill round-trip (fills are verbatim — no semantic gravity)
 *
 * Run:  node index.ts
 */

// ── Logical clock ─────────────────────────────────────────────────────────────
let _tick = 0;
const now  = (): number => _tick;
const advance = (ms: number): void => { _tick += ms; };

// ── Types ─────────────────────────────────────────────────────────────────────

type FillType = "addr" | "hash" | "num" | "token" | "dur" | "str";

interface FillSlot {
  name: string;
  type: FillType;
}

interface Template {
  id:        number;         // wire integer
  name:      string;        // human-readable stable key
  skeleton:  string;        // sentence with {slot} placeholders
  fills:     FillSlot[];    // ordered fill schema
  frequency: number;        // global occurrence count across sessions
}

interface TemplateRegistry {
  version:   number;
  templates: Template[];
}

interface CompressedSentence {
  kind:    "arc";           // consumed by SQ-D
  marker:  string;         // e.g. "[SQDS:3|asset=ETH|count=17|time=2m ago]"
  origLen: number;         // original token estimate
  sqdsLen: number;         // compressed token estimate
}

interface PassSentence {
  kind:    "pass";
  text:    string;
}

type CompressedItem = CompressedSentence | PassSentence;

// ── Naive token estimator ─────────────────────────────────────────────────────
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Fill type detector ────────────────────────────────────────────────────────
const ADDR_RE  = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE  = /^0x[0-9a-fA-F]{64}$/;
const NUM_RE   = /^[0-9]+(\.[0-9]+)?$/;
const TOKEN_RE = /^[A-Z]{2,6}$/;
const DUR_RE   = /^\d+ (second|minute|hour|day)s? ago$/;

function detectFillType(value: string): FillType {
  if (HASH_RE.test(value))  return "hash";
  if (ADDR_RE.test(value))  return "addr";
  if (NUM_RE.test(value))   return "num";
  if (TOKEN_RE.test(value)) return "token";
  if (DUR_RE.test(value))   return "dur";
  return "str";
}

// ── Template catalogue ────────────────────────────────────────────────────────
// In production these are discovered offline from assistant message history.
// Here we seed a representative catalogue of the agent's top recurring sentences.
// DESIGN NOTE: every skeleton must be a TRUE single sentence — no ". " inside
// the pattern, because the sentence splitter breaks on ". " before matching.
// Mid-sentence joins use "—" (em-dash) to avoid false splits.
const TEMPLATE_CATALOGUE: Template[] = [
  {
    id:        0,
    name:      "vault_retrieve",
    skeleton:  "I've retrieved your {asset} vault — {count} entries, last updated {time}.",
    fills:     [
      { name: "asset",  type: "token" },
      { name: "count",  type: "num"   },
      { name: "time",   type: "dur"   },
    ],
    frequency: 94,
  },
  {
    id:        1,
    name:      "wallet_balance",
    skeleton:  "Your {wallet_type} wallet balance is {amount} {token}.",
    fills:     [
      { name: "wallet_type", type: "str"   },
      { name: "amount",      type: "num"   },
      { name: "token",       type: "token" },
    ],
    frequency: 211,
  },
  {
    id:        2,
    name:      "op_complete_hash",
    // em-dash avoids the sentence-splitter boundary inside the pattern
    skeleton:  "The {operation} completed successfully — tx hash {hash}.",
    fills:     [
      { name: "operation", type: "str"  },
      { name: "hash",      type: "hash" },
    ],
    frequency: 178,
  },
  {
    id:        3,
    name:      "capability_check",
    skeleton:  "I'm checking your {capability} grant — status: {status}.",
    fills:     [
      { name: "capability", type: "str" },
      { name: "status",     type: "str" },
    ],
    frequency: 67,
  },
  {
    id:        4,
    name:      "fetch_resource",
    skeleton:  "Fetching {resource} from {source} — this may take a moment.",
    fills:     [
      { name: "resource", type: "str" },
      { name: "source",   type: "str" },
    ],
    frequency: 88,
  },
  {
    id:        5,
    name:      "fee_report",
    skeleton:  "The transaction fee totaled {amount} {token}, charged from {addr}.",
    fills:     [
      { name: "amount", type: "num"   },
      { name: "token",  type: "token" },
      { name: "addr",   type: "addr"  },
    ],
    frequency: 56,
  },
];

function buildRegistry(): TemplateRegistry {
  return {
    version:   1,
    templates: TEMPLATE_CATALOGUE.sort((a, b) => b.frequency - a.frequency),
  };
}

// ── Header serializer ─────────────────────────────────────────────────────────
// Wire format: "SQDS-1:T0=skeleton(fills)|T1=…"
// Fill schema encoded as comma-separated "name:type" pairs after the skeleton.
function serializeHeader(registry: TemplateRegistry): string {
  const parts = registry.templates.map(t => {
    const fillSchema = t.fills.map(f => `${f.name}:${f.type}`).join(",");
    return `T${t.id}=${t.skeleton}(${fillSchema})`;
  });
  return `SQDS-1:${parts.join("|")}`;
}

// ── Template matcher ──────────────────────────────────────────────────────────
// Given a sentence, try each template in frequency order.
// Returns the matched template + extracted fill values, or null on miss.

interface MatchResult {
  template: Template;
  fills:    Record<string, string>;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTemplateRegex(template: Template): RegExp {
  // Replace each {slot} with a named capture group.
  let pattern = escapeRe(template.skeleton);
  for (const slot of template.fills) {
    // After escaping, {slot} becomes \{slot\} — undo just the braces.
    pattern = pattern.replace(
      `\\{${slot.name}\\}`,
      `(?<${slot.name}>.+?)`,
    );
  }
  return new RegExp(`^${pattern}$`, "s");
}

// Pre-build regexes once.
const TEMPLATE_REGEXES: Map<number, RegExp> = new Map(
  TEMPLATE_CATALOGUE.map(t => [t.id, buildTemplateRegex(t)]),
);

function matchTemplate(sentence: string, registry: TemplateRegistry): MatchResult | null {
  for (const template of registry.templates) {
    const re = TEMPLATE_REGEXES.get(template.id);
    if (!re) continue;
    const m = re.exec(sentence.trim());
    if (!m || !m.groups) continue;

    // Validate fill types.
    let valid = true;
    for (const slot of template.fills) {
      const val = m.groups[slot.name] ?? "";
      const detected = detectFillType(val);
      // Allow "str" as fallback for any type (type system is advisory).
      if (slot.type !== "str" && detected !== slot.type && detected !== "str") {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    const fills: Record<string, string> = {};
    for (const slot of template.fills) {
      fills[slot.name] = m.groups[slot.name] ?? "";
    }
    return { template, fills };
  }
  return null;
}

// ── URL-encode fill values (allow | and = inside values) ─────────────────────
function encodeFill(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function decodeFill(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, "%20"));
}

// ── Compress: scan history sentences for template matches ─────────────────────
function compressTurn(text: string, registry: TemplateRegistry): { items: CompressedItem[]; hitCount: number } {
  // Split on sentence boundaries (naive: ". ", "? ", "! ", ".\n").
  const sentences = text.split(/(?<=[.?!])\s+/).filter(s => s.trim().length > 0);
  const items: CompressedItem[] = [];
  let hitCount = 0;

  for (const sentence of sentences) {
    const match = matchTemplate(sentence, registry);
    if (match) {
      const fillParts = Object.entries(match.fills)
        .map(([k, v]) => `${k}=${encodeFill(v)}`)
        .join("|");
      const marker = `[SQDS:${match.template.id}|${fillParts}]`;
      items.push({
        kind:    "arc",
        marker,
        origLen: estimateTokens(sentence),
        sqdsLen: estimateTokens(marker),
      });
      hitCount++;
    } else {
      items.push({ kind: "pass", text: sentence });
    }
  }

  return { items, hitCount };
}

function renderCompressed(items: CompressedItem[]): string {
  return items.map(item => item.kind === "arc" ? item.marker : item.text).join(" ");
}

// ── Decompress: substitute fills into skeleton ────────────────────────────────
function decompressTurn(compressed: string, registry: TemplateRegistry): string {
  const MARKER_RE = /\[SQDS:(\d+)\|([^\]]*)\]/g;

  return compressed.replace(MARKER_RE, (_match, idStr, fillStr) => {
    const id = parseInt(idStr, 10);
    const template = registry.templates.find(t => t.id === id);
    if (!template) return _match; // unknown template — pass through

    // Parse fill values.
    const fills: Record<string, string> = {};
    for (const part of fillStr.split("|")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx < 0) continue;
      const key = part.slice(0, eqIdx);
      const val = decodeFill(part.slice(eqIdx + 1));
      fills[key] = val;
    }

    // Substitute into skeleton.
    let result = template.skeleton;
    for (const slot of template.fills) {
      result = result.replace(`{${slot.name}}`, fills[slot.name] ?? `{${slot.name}}`);
    }
    return result;
  });
}

// ── Demo ──────────────────────────────────────────────────────────────────────
async function demo(): Promise<void> {
  console.log("=== Guide 86 — SQ-D: Sentence Template Compression ===\n");

  // ── A. Build template registry ─────────────────────────────────────────────
  console.log("A. Building template registry…");
  advance(80);

  const registry = buildRegistry();
  console.log(`   ${registry.templates.length} templates registered (sorted by frequency):`);
  for (const t of registry.templates) {
    console.log(`   T${t.id} [${t.name}] (freq=${t.frequency}): "${t.skeleton}"`);
  }
  console.log();

  // ── B. Build and measure header ────────────────────────────────────────────
  console.log("B. Serialising header…");
  advance(20);

  const header = serializeHeader(registry);
  const headerTokens = estimateTokens(header);
  console.log(`   Header: ${header.slice(0, 80)}…`);
  console.log(`   Header cost: ~${headerTokens} tokens`);
  // Break-even: avg fill marker = ~10 tok, avg original sentence = ~18 tok → save ~8 tok
  const avgSavePerHit = 8;
  const breakEven = Math.ceil(headerTokens / avgSavePerHit);
  console.log(`   Break-even: ~${breakEven} hits\n`);

  // ── C. Compress a 6-turn conversation history ──────────────────────────────
  console.log("C. Compressing 6-turn episodic history…");
  advance(250);

  // Realistic assistant turns — each contains sentences matching the
  // template catalogue above. Wallet addresses and hashes are real-format.
  // Corpus uses the same em-dash join style as the templates so sentences
  // are not split mid-pattern by the sentence boundary detector.
  const rawTurns: string[] = [
    // Turn 1 — vault retrieval + balance
    `I've retrieved your ETH vault — 17 entries, last updated 2 minutes ago. Your primary wallet balance is 4.2180 ETH.`,
    // Turn 2 — capability check + fetch
    `I'm checking your dispatch_write grant — status: active. Fetching transaction history from the mempool — this may take a moment.`,
    // Turn 3 — operation complete + fee
    `The ETH transfer completed successfully — tx hash 0xdeadbeef1234abcd5678ef9012345678abcdef901234567890abcdef12345678. The transaction fee totaled 0.0023 ETH, charged from 0x4a0832e0f7a5b8c1d2e3f4a5b6c7d8e9f0a1b2c3.`,
    // Turn 4 — vault + balance update
    `I've retrieved your USDC vault — 3 entries, last updated 12 minutes ago. Your USDC staking wallet balance is 250.0000 USDC.`,
    // Turn 5 — fetch + capability
    `Fetching guardian attestation from the recovery oracle — this may take a moment. I'm checking your vault_read grant — status: revoked.`,
    // Turn 6 — op complete (second hit of T2)
    `The signature broadcast completed successfully — tx hash 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890. All done, no further action required.`,
  ];

  let totalRawTok = 0;
  let totalSqdsTok = headerTokens; // header paid once
  let totalHits = 0;

  const compressedTurns: Array<{ items: CompressedItem[]; hitCount: number }> = [];

  for (let i = 0; i < rawTurns.length; i++) {
    const raw = rawTurns[i];
    const { items, hitCount } = compressTurn(raw, registry);
    compressedTurns.push({ items, hitCount });

    const rawTok  = estimateTokens(raw);
    const sqdsTok = items.reduce(
      (acc, item) => acc + (item.kind === "arc" ? item.sqdsLen : estimateTokens(item.text)),
      0,
    );
    totalRawTok  += rawTok;
    totalSqdsTok += sqdsTok;
    totalHits    += hitCount;

    console.log(`   Turn ${i + 1}: ${hitCount} template hit(s), ${rawTok} tok → ${sqdsTok} tok`);
    const compressed = renderCompressed(items);
    console.log(`     "${compressed.slice(0, 100)}${compressed.length > 100 ? "…" : ""}"`);
  }

  const saved = totalRawTok - totalSqdsTok;
  const ratio = ((saved / totalRawTok) * 100).toFixed(1);
  console.log(`\n   Total raw:    ~${totalRawTok} tokens`);
  console.log(`   Total SQ-D:   ~${totalSqdsTok} tokens (incl header)`);
  console.log(`   Raw Δ:        ${saved} tokens (${ratio}%) — negative is expected for a 6-turn demo`);
  console.log(`   Template hits: ${totalHits} across ${rawTurns.length} turns`);
  console.log(`   Break-even at: ${breakEven} hits — gate: ${totalHits >= breakEven ? "✅ use SQDS" : "⚠️  fall back to SQC/SQB (correct — 6-turn demo is below break-even)"}`);

  // Scale to a 500-turn session to show positive savings.
  // Extrapolate: same hit rate × 500 turns; header paid once.
  const hitRate           = totalHits / rawTurns.length;         // hits/turn
  const measuredSavePerHit = totalHits > 0
    ? (rawTurns.reduce((a, t) => a + estimateTokens(t), 0) -
       (totalSqdsTok - headerTokens)) / totalHits
    : 0;
  const scaledHits     = Math.round(hitRate * 500);
  const scaledSaved    = Math.round(scaledHits * measuredSavePerHit) - headerTokens;
  const scaledRatio    = ((scaledSaved / (totalRawTok / rawTurns.length * 500)) * 100).toFixed(1);
  console.log(`\n   At-scale (500 turns): ~${scaledHits} hits → net ~${scaledSaved} tokens saved (${scaledRatio}%)\n`);

  // ── D. Decompress and verify fill round-trip ───────────────────────────────
  console.log("D. Decompressing and verifying fill round-trip…");
  advance(120);

  // Fills that must survive verbatim.
  const criticalFills = [
    "0xdeadbeef1234abcd5678ef9012345678abcdef901234567890abcdef12345678",
    "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    "0x4a0832e0f7a5b8c1d2e3f4a5b6c7d8e9f0a1b2c3",
    "4.2180",
    "17",
    "250.0000",
    "dispatch_write",
    "vault_read",
    "2 minutes ago",
  ];

  let allFillsIntact = true;
  const reconstructedAll: string[] = [];

  for (let i = 0; i < compressedTurns.length; i++) {
    const compressed = renderCompressed(compressedTurns[i].items);
    const reconstructed = decompressTurn(compressed, registry);
    reconstructedAll.push(reconstructed);
  }

  const joinedReconstructed = reconstructedAll.join(" ");

  for (const fill of criticalFills) {
    const intact = joinedReconstructed.includes(fill);
    if (!intact) allFillsIntact = false;
    console.log(`   ${fill.slice(0, 42).padEnd(42)} ${intact ? "✅ verbatim" : "❌ LOST"}`);
  }
  console.log();

  // ── E. Sentence-level accuracy check ──────────────────────────────────────
  console.log("E. Sentence-level reconstruction accuracy…");
  advance(60);

  // Decompress all and compare against originals sentence-by-sentence.
  const rawJoined = rawTurns.join(" ");
  const rawSentences = rawJoined.split(/(?<=[.?!])\s+/).filter(s => s.trim().length > 0);
  const recSentences = joinedReconstructed.split(/(?<=[.?!])\s+/).filter(s => s.trim().length > 0);

  // Only check sentences that were template-compressed — pass-through is trivially exact.
  let templatedSentences = 0;
  let exactMatches = 0;

  for (let i = 0; i < rawSentences.length; i++) {
    const raw = rawSentences[i]?.trim() ?? "";
    const rec = recSentences[i]?.trim() ?? "";
    const wasCompressed = matchTemplate(raw, registry) !== null;
    if (!wasCompressed) continue;
    templatedSentences++;
    if (raw === rec) exactMatches++;
    else console.log(`   MISMATCH:\n     raw: "${raw}"\n     rec: "${rec}"`);
  }

  const accuracy = templatedSentences > 0
    ? ((exactMatches / templatedSentences) * 100).toFixed(1)
    : "n/a";

  console.log(`   Templated sentences: ${templatedSentences}`);
  console.log(`   Exact round-trips:   ${exactMatches}/${templatedSentences} (${accuracy}%)`);
  console.log(`   Fill integrity:      ${allFillsIntact ? "✅ all critical fills verbatim" : "❌ fill loss detected"}\n`);

  // ── F. Assertions ─────────────────────────────────────────────────────────
  console.log("F. Assertions…");
  advance(10);

  const assertions: Array<{ label: string; pass: boolean }> = [
    { label: "registry built (≥ 1 template)",                    pass: registry.templates.length >= 1 },
    { label: "header generated",                                  pass: header.startsWith("SQDS-1:") },
    { label: "at least 6 template hits across 6 turns",          pass: totalHits >= 6 },
    { label: "gate correctly fires (6-turn demo below break-even)", pass: totalHits < breakEven },
    { label: "at-scale savings positive (500 turns)",            pass: scaledSaved > 0 },
    { label: "all critical fills verbatim after round-trip",     pass: allFillsIntact },
    { label: "templated sentence accuracy ≥ 95%",                pass: templatedSentences === 0 || exactMatches / templatedSentences >= 0.95 },
  ];

  let allPass = true;
  for (const a of assertions) {
    console.log(`   ${a.pass ? "✅" : "❌"} ${a.label}`);
    if (!a.pass) allPass = false;
  }

  console.log(`\n=== ${allPass ? "PASS" : "FAIL"} — ${now()} ms simulated ===`);
  if (!allPass) process.exit(1);
}

demo().catch(err => { console.error(err); process.exit(1); });
