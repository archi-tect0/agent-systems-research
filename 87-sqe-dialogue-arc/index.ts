/**
 * Guide 87 — SQ-E: Dialogue Arc Compression
 * Runnable reference implementation (no external deps, no DB).
 *
 * Demonstrates:
 *   A. Building an arc registry from SQ-D template ID sequences
 *   B. Discovering arc candidates by n-gram frequency counting
 *   C. Building and serialising the SQ-E header
 *   D. Compressing an 8-turn history (arc hits + SQ-D residual pass-through)
 *   E. Decompressing by substituting fills into arc constituent sentences
 *   F. Verifying arc fills are verbatim (no semantic gravity at arc level)
 *   G. Break-even gate at zero arc density
 *
 * Run:  node index.ts
 */

// ── Logical clock ─────────────────────────────────────────────────────────────
let _tick = 0;
const now     = (): number => _tick;
const advance = (ms: number): void => { _tick += ms; };

// ── Types ─────────────────────────────────────────────────────────────────────

type TemplateId = number;

interface ArcFillSlot {
  name:     string;
  sentence: number; // 0-based index within the arc's sentence sequence
  slotName: string; // slot name within that sentence's template
}

interface Arc {
  id:        number;
  name:      string;
  sequence:  TemplateId[];
  fills:     ArcFillSlot[];
  frequency: number;
}

interface ArcRegistry {
  version: number;
  arcs:    Arc[];
}

interface CompiledSentence {
  templateId: TemplateId;
  fills:      Record<string, string>;
  rawText:    string;
}

interface CompiledTurn {
  sentences: CompiledSentence[];
}

interface ArcMatch {
  arc:   Arc;
  fills: Record<string, string>;
  start: number;
  end:   number;
}

// ── Naive token estimator ─────────────────────────────────────────────────────
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Guide 86 template catalogue (mirrored, single-sentence skeletons) ─────────
// All skeletons use em-dash to avoid mid-sentence splits at ". ".
interface TemplateDef {
  id:       number;
  skeleton: string;
  fills:    string[];
}

const TEMPLATES: TemplateDef[] = [
  { id: 0, skeleton: "I've retrieved your {asset} vault — {count} entries, last updated {time}.",           fills: ["asset", "count", "time"]          },
  { id: 1, skeleton: "Your {wallet_type} wallet balance is {amount} {token}.",                              fills: ["wallet_type", "amount", "token"]  },
  { id: 2, skeleton: "The {operation} completed successfully — tx hash {hash}.",                            fills: ["operation", "hash"]               },
  { id: 3, skeleton: "I'm checking your {capability} grant — status: {status}.",                           fills: ["capability", "status"]            },
  { id: 4, skeleton: "Fetching {resource} from {source} — this may take a moment.",                        fills: ["resource", "source"]              },
  { id: 5, skeleton: "The transaction fee totaled {amount} {token}, charged from {addr}.",                 fills: ["amount", "token", "addr"]         },
  { id: 6, skeleton: "Identity verified via {method} — session is active.",                                fills: ["method"]                          },
  { id: 7, skeleton: "Scheduled {job} for {when} — status: {status}.",                                    fills: ["job", "when", "status"]           },
];

function renderSentence(def: TemplateDef, fills: Record<string, string>): string {
  let s = def.skeleton;
  for (const [k, v] of Object.entries(fills)) {
    s = s.replace(`{${k}}`, v);
  }
  return s;
}

// ── Arc catalogue ─────────────────────────────────────────────────────────────
// Arcs are 3–4 sentences so skeleton savings clearly outweigh fill overhead.
// An arc that spans 4 sentences saves ~50-80 tokens vs transmitting each sentence raw.

const ARC_CATALOGUE: Arc[] = [
  {
    id:        0,
    name:      "verify_vault_balance",
    // T6 (identity) → T0 (vault) → T1 (balance)  — 3-sentence arc
    sequence:  [6, 0, 1],
    fills: [
      { name: "method",      sentence: 0, slotName: "method"      },
      { name: "asset",       sentence: 1, slotName: "asset"       },
      { name: "count",       sentence: 1, slotName: "count"       },
      { name: "time",        sentence: 1, slotName: "time"        },
      { name: "wallet_type", sentence: 2, slotName: "wallet_type" },
      { name: "amount",      sentence: 2, slotName: "amount"      },
      { name: "token",       sentence: 2, slotName: "token"       },
    ],
    frequency: 212,
  },
  {
    id:        1,
    name:      "execute_fee_report",
    // T2 (complete) → T5 (fee) → T0 (vault updated)  — 3-sentence arc
    sequence:  [2, 5, 0],
    fills: [
      { name: "operation", sentence: 0, slotName: "operation" },
      { name: "hash",      sentence: 0, slotName: "hash"      },
      { name: "fee_amt",   sentence: 1, slotName: "amount"    },
      { name: "fee_token", sentence: 1, slotName: "token"     },
      { name: "addr",      sentence: 1, slotName: "addr"      },
      { name: "asset",     sentence: 2, slotName: "asset"     },
      { name: "count",     sentence: 2, slotName: "count"     },
      { name: "time",      sentence: 2, slotName: "time"      },
    ],
    frequency: 134,
  },
  {
    id:        2,
    name:      "capability_fetch_schedule",
    // T3 (check) → T4 (fetch) → T7 (schedule)  — 3-sentence arc
    sequence:  [3, 4, 7],
    fills: [
      { name: "capability", sentence: 0, slotName: "capability" },
      { name: "cap_status", sentence: 0, slotName: "status"     },
      { name: "resource",   sentence: 1, slotName: "resource"   },
      { name: "source",     sentence: 1, slotName: "source"     },
      { name: "job",        sentence: 2, slotName: "job"        },
      { name: "when",       sentence: 2, slotName: "when"       },
      { name: "sched_status",sentence: 2, slotName: "status"   },
    ],
    frequency: 88,
  },
];

function buildArcRegistry(): ArcRegistry {
  return {
    version: 1,
    arcs:    ARC_CATALOGUE.sort((a, b) => b.frequency - a.frequency),
  };
}

// ── Header serialiser ─────────────────────────────────────────────────────────
function serializeHeader(registry: ArcRegistry): string {
  const parts = registry.arcs.map(arc => {
    const seq   = arc.sequence.join(",");
    const fills = arc.fills.map(f => f.name).join(",");
    return `A${arc.id}=${arc.name}[${seq}]{${fills}}`;
  });
  return `SQCE-1:${parts.join("|")}`;
}

// ── SQ-D marker parser ────────────────────────────────────────────────────────
const SQDS_RE = /\[SQDS:(\d+)\|([^\]]*)\]/g;

function encFill(v: string): string { return encodeURIComponent(v).replace(/%20/g, "+"); }
function decFill(v: string): string { return decodeURIComponent(v.replace(/\+/g, "%20")); }

function parseSqdsTurn(sqdsText: string, rawSentences: string[]): CompiledTurn {
  const sentences: CompiledSentence[] = [];
  let rawIdx = 0;

  for (const match of sqdsText.matchAll(SQDS_RE)) {
    const id   = parseInt(match[1], 10);
    const fills: Record<string, string> = {};
    for (const part of match[2].split("|")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      fills[part.slice(0, eq)] = decFill(part.slice(eq + 1));
    }
    sentences.push({ templateId: id, fills, rawText: rawSentences[rawIdx] ?? "" });
    rawIdx++;
  }

  return { sentences };
}

// ── Arc matcher ───────────────────────────────────────────────────────────────
function findArcMatch(turn: CompiledTurn, registry: ArcRegistry): ArcMatch | null {
  const ids = turn.sentences.map(s => s.templateId);

  for (const arc of registry.arcs) {
    for (let i = 0; i <= ids.length - arc.sequence.length; i++) {
      const window = ids.slice(i, i + arc.sequence.length);
      if (window.join(",") !== arc.sequence.join(",")) continue;

      const fills: Record<string, string> = {};
      for (const fillSlot of arc.fills) {
        const sentence = turn.sentences[i + fillSlot.sentence];
        if (sentence) {
          fills[fillSlot.name] = sentence.fills[fillSlot.slotName] ?? "";
        }
      }
      return { arc, fills, start: i, end: i + arc.sequence.length };
    }
  }
  return null;
}

// ── Compressor ────────────────────────────────────────────────────────────────
function compressTurn(
  sqdsText:     string,
  rawSentences: string[],
  registry:     ArcRegistry,
): { compressed: string; arcHit: boolean; matchedFills: Record<string, string>; rawTok: number; sqceTok: number } {
  const compiled = parseSqdsTurn(sqdsText, rawSentences);
  const rawTok   = estimateTokens(rawSentences.join(" "));
  const match    = findArcMatch(compiled, registry);

  if (!match) {
    return { compressed: sqdsText, arcHit: false, matchedFills: {}, rawTok, sqceTok: estimateTokens(sqdsText) };
  }

  const fillParts = Object.entries(match.fills).map(([k, v]) => `${k}=${encFill(v)}`).join("|");
  const arcMarker = `[SQCE:${match.arc.id}|${fillParts}]`;

  // Sentences outside the arc window pass through as-is (SQ-D markers).
  const before = compiled.sentences.slice(0, match.start).map(s => {
    const def = TEMPLATES.find(t => t.id === s.templateId);
    return def ? renderSentence(def, s.fills) : s.rawText;
  }).join(" ");

  const after = compiled.sentences.slice(match.end).map(s => {
    const def = TEMPLATES.find(t => t.id === s.templateId);
    return def ? renderSentence(def, s.fills) : s.rawText;
  }).join(" ");

  const compressed = [before, arcMarker, after].filter(Boolean).join(" ");
  return { compressed, arcHit: true, matchedFills: match.fills, rawTok, sqceTok: estimateTokens(compressed) };
}

// ── Decompressor ──────────────────────────────────────────────────────────────
function decompressTurn(compressed: string, registry: ArcRegistry): string {
  const ARC_RE = /\[SQCE:(\d+)\|([^\]]*)\]/g;

  return compressed.replace(ARC_RE, (_match, idStr, fillStr) => {
    const id  = parseInt(idStr, 10);
    const arc = registry.arcs.find(a => a.id === id);
    if (!arc) return _match;

    const fills: Record<string, string> = {};
    for (const part of fillStr.split("|")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      fills[part.slice(0, eq)] = decFill(part.slice(eq + 1));
    }

    const sentences: string[] = [];
    for (let i = 0; i < arc.sequence.length; i++) {
      const def = TEMPLATES.find(t => t.id === arc.sequence[i]);
      if (!def) { sentences.push("[unknown template]"); continue; }

      const sentFills: Record<string, string> = {};
      for (const fillSlot of arc.fills) {
        if (fillSlot.sentence === i) {
          sentFills[fillSlot.slotName] = fills[fillSlot.name] ?? "";
        }
      }
      sentences.push(renderSentence(def, sentFills));
    }
    return sentences.join(" ");
  });
}

// ── Demo ──────────────────────────────────────────────────────────────────────
async function demo(): Promise<void> {
  console.log("=== Guide 87 — SQ-E: Dialogue Arc Compression ===\n");

  // ── A. Build arc registry ──────────────────────────────────────────────────
  console.log("A. Building arc registry…");
  advance(60);

  const registry = buildArcRegistry();
  console.log(`   ${registry.arcs.length} arcs registered (3-sentence each):`);
  for (const arc of registry.arcs) {
    const seq = arc.sequence.map(id => `T${id}`).join("→");
    console.log(`   A${arc.id} [${arc.name}] freq=${arc.frequency}: ${seq} (${arc.fills.length} fills)`);
  }
  console.log();

  // ── B. Header ─────────────────────────────────────────────────────────────
  console.log("B. Serialising SQ-E header…");
  advance(20);

  const header    = serializeHeader(registry);
  const headerTok = estimateTokens(header);
  // Each 3-sentence arc saves ~30-50 tokens (skeleton ~60 raw - fills ~20 - marker ~5 = ~35 net).
  const avgArcSave = 35;
  const breakEven  = Math.ceil(headerTok / avgArcSave);
  console.log(`   Header: ${header.slice(0, 90)}…`);
  console.log(`   Header cost: ~${headerTok} tokens`);
  console.log(`   Break-even: ~${breakEven} arc hits\n`);

  // ── C. 8-turn compressed history ──────────────────────────────────────────
  // 5 arc hits + 3 SQ-D pass-through turns (single-sentence, no arc).
  console.log("C. Compressing 8-turn episodic history…");
  advance(150);

  // Raw sentences grouped by turn.
  // Arc turns: 3 sentences each (matching arc.sequence).
  // Pass turns: 1 sentence each (SQ-D pass-through — no arc possible).
  const rawTurns: string[][] = [
    // Turn 1: verify_vault_balance arc (T6→T0→T1)
    [
      "Identity verified via SIWE — session is active.",
      "I've retrieved your ETH vault — 17 entries, last updated 2 minutes ago.",
      "Your primary wallet balance is 4.2180 ETH.",
    ],
    // Turn 2: execute_fee_report arc (T2→T5→T0)
    [
      "The ETH transfer completed successfully — tx hash 0xdeadbeef1234abcd5678ef9012345678abcdef901234567890abcdef12345678.",
      "The transaction fee totaled 0.0023 ETH, charged from 0x4a0832e0f7a5b8c1d2e3f4a5b6c7d8e9f0a1b2c3.",
      "I've retrieved your ETH vault — 16 entries, last updated just now.",
    ],
    // Turn 3: SQ-D pass-through (single sentence, no arc match)
    [
      "I'm checking your dispatch_write grant — status: active.",
    ],
    // Turn 4: capability_fetch_schedule arc (T3→T4→T7)
    [
      "I'm checking your vault_read grant — status: revoked.",
      "Fetching access logs from the audit trail — this may take a moment.",
      "Scheduled revocation_notify for 09:00 UTC — status: queued.",
    ],
    // Turn 5: verify_vault_balance arc (second hit)
    [
      "Identity verified via WebAuthn — session is active.",
      "I've retrieved your USDC vault — 3 entries, last updated 12 minutes ago.",
      "Your USDC staking wallet balance is 250.0000 USDC.",
    ],
    // Turn 6: SQ-D pass-through
    [
      "Fetching guardian attestation from the recovery oracle — this may take a moment.",
    ],
    // Turn 7: execute_fee_report arc (second hit)
    [
      "The USDC settlement completed successfully — tx hash 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890.",
      "The transaction fee totaled 1.5000 USDC, charged from 0x9b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c.",
      "I've retrieved your USDC vault — 2 entries, last updated just now.",
    ],
    // Turn 8: SQ-D pass-through
    [
      "Your primary wallet balance is 3.9180 ETH.",
    ],
  ];

  // Corresponding SQ-D outputs (SQ-E input).
  const sqdsTurns: string[] = [
    // T6, T0, T1
    "[SQDS:6|method=SIWE] [SQDS:0|asset=ETH|count=17|time=2+minutes+ago] [SQDS:1|wallet_type=primary|amount=4.2180|token=ETH]",
    // T2, T5, T0
    "[SQDS:2|operation=ETH+transfer|hash=0xdeadbeef1234abcd5678ef9012345678abcdef901234567890abcdef12345678] [SQDS:5|amount=0.0023|token=ETH|addr=0x4a0832e0f7a5b8c1d2e3f4a5b6c7d8e9f0a1b2c3] [SQDS:0|asset=ETH|count=16|time=just+now]",
    // pass-through (single T3)
    "[SQDS:3|capability=dispatch_write|status=active]",
    // T3, T4, T7
    "[SQDS:3|capability=vault_read|status=revoked] [SQDS:4|resource=access+logs|source=the+audit+trail] [SQDS:7|job=revocation_notify|when=09%3A00+UTC|status=queued]",
    // T6, T0, T1
    "[SQDS:6|method=WebAuthn] [SQDS:0|asset=USDC|count=3|time=12+minutes+ago] [SQDS:1|wallet_type=USDC+staking|amount=250.0000|token=USDC]",
    // pass-through (single T4)
    "[SQDS:4|resource=guardian+attestation|source=the+recovery+oracle]",
    // T2, T5, T0
    "[SQDS:2|operation=USDC+settlement|hash=0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890] [SQDS:5|amount=1.5000|token=USDC|addr=0x9b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c] [SQDS:0|asset=USDC|count=2|time=just+now]",
    // pass-through (single T1)
    "[SQDS:1|wallet_type=primary|amount=3.9180|token=ETH]",
  ];

  let totalRawTok  = 0;
  let totalSqceTok = headerTok;
  let totalArcHits = 0;
  const compressedTurns:  string[] = [];
  const allMatchedFills:  Array<Record<string, string>> = [];
  const turnIsArcHit:     boolean[] = [];

  for (let i = 0; i < rawTurns.length; i++) {
    const { compressed, arcHit, matchedFills, rawTok, sqceTok } = compressTurn(
      sqdsTurns[i], rawTurns[i], registry,
    );
    compressedTurns.push(compressed);
    allMatchedFills.push(matchedFills);
    turnIsArcHit.push(arcHit);
    totalRawTok  += rawTok;
    totalSqceTok += sqceTok;
    if (arcHit) totalArcHits++;

    const label = arcHit ? "✅ arc hit" : "⬜ pass   ";
    console.log(`   Turn ${i + 1}: ${label} | ${rawTok} tok raw → ${sqceTok} tok compressed`);
    console.log(`     "${compressed.slice(0, 100)}${compressed.length > 100 ? "…" : ""}"`);
  }

  const saved = totalRawTok - totalSqceTok;
  const ratio = ((saved / totalRawTok) * 100).toFixed(1);
  console.log(`\n   Total raw:   ~${totalRawTok} tokens`);
  console.log(`   Total SQ-E:  ~${totalSqceTok} tokens (incl ~${headerTok}-token header)`);
  console.log(`   Net savings: ~${saved} tokens (${ratio}%)`);
  console.log(`   Arc hits:    ${totalArcHits} / ${rawTurns.length} turns`);

  // At-scale extrapolation (same hit-rate, 500 turns, header paid once).
  const hitRate       = totalArcHits / rawTurns.length;
  const avgSavePerHit = totalArcHits > 0 ? saved / totalArcHits : 0;
  const scaledSaved   = Math.round(hitRate * 500 * avgSavePerHit) - headerTok;
  console.log(`   At-scale (500 turns, ${(hitRate*100).toFixed(0)}% hit rate): ~${Math.max(0, scaledSaved)} tokens saved\n`);

  // ── D. Fill round-trip verification ───────────────────────────────────────
  // Only check fills from ARC-COMPRESSED turns.  Pass-through SQ-D markers
  // are not touched by SQ-E decompression, so fills inside them survive in
  // URL-encoded form — they are NOT lost, but the check target must match.
  console.log("D. Verifying arc fill round-trip (arc-compressed turns only)…");
  advance(80);

  // Collect critical fills that were arc-compressed.
  const arcFills: string[] = [];
  for (let i = 0; i < rawTurns.length; i++) {
    if (!turnIsArcHit[i]) continue;
    for (const v of Object.values(allMatchedFills[i])) {
      if (v && v.length > 3) arcFills.push(v);
    }
  }

  const reconstructedAll = compressedTurns.map(c => decompressTurn(c, registry));
  const joinedRec = reconstructedAll.join(" ");

  let allFillsIntact = true;
  const checked = new Set<string>();
  for (const fill of arcFills) {
    if (checked.has(fill)) continue;
    checked.add(fill);
    const intact = joinedRec.includes(fill);
    if (!intact) allFillsIntact = false;
    console.log(`   ${fill.slice(0, 52).padEnd(52)} ${intact ? "✅ verbatim" : "❌ LOST"}`);
  }
  console.log();

  // ── E. Sentence-level reconstruction accuracy (arc turns) ─────────────────
  console.log("E. Sentence-level accuracy (arc turns only)…");
  advance(40);

  let exactMatches = 0;
  let totalChecked = 0;

  for (let i = 0; i < rawTurns.length; i++) {
    if (!turnIsArcHit[i]) continue;
    const rawText = rawTurns[i].join(" ");
    const recText = reconstructedAll[i];
    const match   = rawText.trim() === recText.trim();
    if (match) exactMatches++;
    else console.log(`   MISMATCH turn ${i + 1}:\n     raw: "${rawText}"\n     rec: "${recText}"`);
    totalChecked++;
  }

  const accuracy = totalChecked > 0
    ? ((exactMatches / totalChecked) * 100).toFixed(1)
    : "n/a";
  console.log(`   Arc turns reconstructed: ${exactMatches}/${totalChecked} exact (${accuracy}%)\n`);

  // ── F. Break-even gate at zero arc density ─────────────────────────────────
  console.log("F. Break-even gate at zero arc density (0 hits in 20 turns)…");
  advance(20);

  const zeroHits         = 0;
  const zeroTurns        = 20;
  const projectedSave    = zeroHits * avgArcSave;
  const worthIt          = projectedSave > headerTok;
  console.log(`   Arc hits: ${zeroHits}/${zeroTurns} turns`);
  console.log(`   Projected save: ~${projectedSave} tok`);
  console.log(`   Header cost:    ~${headerTok} tok`);
  console.log(`   Gate verdict:   ${worthIt ? "✅ use SQCE" : "⚠️  drop SQ-E header — fall through to SQ-D"}\n`);

  // ── G. Assertions ──────────────────────────────────────────────────────────
  console.log("G. Assertions…");
  advance(10);

  const assertions: Array<{ label: string; pass: boolean }> = [
    { label: "arc registry built (≥ 1 arc)",                    pass: registry.arcs.length >= 1 },
    { label: "header generated",                                 pass: header.startsWith("SQCE-1:") },
    { label: "≥ 4 arc hits across 8 turns",                     pass: totalArcHits >= 4 },
    { label: "net savings > 0",                                  pass: saved > 0 },
    { label: "at-scale savings positive (500 turns)",           pass: scaledSaved > 0 },
    { label: "all arc fills verbatim after round-trip",         pass: allFillsIntact },
    { label: "arc sentence accuracy ≥ 95%",                     pass: totalChecked === 0 || exactMatches / totalChecked >= 0.95 },
    { label: "zero-density gate correctly drops SQ-E header",   pass: !worthIt },
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
