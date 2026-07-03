/**
 * Guide 84 — Self-Audit Dissent Loop
 * Runnable reference implementation (no external deps, no DB).
 *
 * Demonstrates:
 *   A. PolicyEngine emits a warn verdict → outbound entry created
 *   B. dissentReviewer scans outbound → writes self_audit lesson
 *   C. Second tick is idempotent (no duplicate lesson)
 *   D. Lesson content embeds the outbound ID for idempotency tracking
 *
 * Run:  node index.ts
 */

// ── Logical clock ────────────────────────────────────────────────────────────
let _tick = 0;
const now = (): number => _tick;
const advance = (ms: number): void => { _tick += ms; };

// ── In-memory stand-ins for DB tables ────────────────────────────────────────
interface OutboundRow {
  id: string;
  wallet: string;
  body: string;
  created_at: number;
}

interface ReflectiveRow {
  id: string;
  wallet: string;
  category: string;
  content: string;
  confidence: number;
  source: string;
  created_at: number;
}

const agentOutbound: OutboundRow[] = [];
const kaiReflectiveMemory: ReflectiveRow[] = [];

let _idSeq = 0;
const newId = (): string => `id-${++_idSeq}`;

// ── PolicyEngine stub ─────────────────────────────────────────────────────────
type Verdict = "allow" | "warn" | "block";

interface PolicyResult {
  verdict: Verdict;
  reason?: string;
}

function checkPolicy(wallet: string, toolName: string, args: Record<string, unknown>): PolicyResult {
  // Stub: flag any tool that touches a "sensitive" arg key.
  const sensitiveKeys = ["private_key", "seed_phrase", "admin_override"];
  for (const k of sensitiveKeys) {
    if (k in args) {
      return {
        verdict: "warn",
        reason: `Tool '${toolName}' received sensitive argument '${k}' — verify intent aligns with boundary convictions.`,
      };
    }
  }
  return { verdict: "allow" };
}

// ── Emit a policy warn to agent_outbound ─────────────────────────────────────
function emitPolicyWarn(wallet: string, reason: string): OutboundRow {
  const row: OutboundRow = {
    id:         newId(),
    wallet,
    body:       `⚠️ Policy note: ${reason}`,
    created_at: now(),
  };
  agentOutbound.push(row);
  return row;
}

// ── dissentReviewer — the async learner ──────────────────────────────────────
const MAX_PER_TICK = 10;

async function tickDissentReview(): Promise<number> {
  const warns = agentOutbound
    .filter(r => r.body.startsWith("⚠️ Policy note:"))
    .slice(0, MAX_PER_TICK);

  let inserted = 0;

  for (const row of warns) {
    // Idempotency: check if a reflective entry already references this ID.
    const existing = kaiReflectiveMemory.find(
      m => m.wallet === row.wallet && m.content.includes(row.id),
    );
    if (existing) continue;

    const reason = row.body.replace(/^⚠️ Policy note:\s*/i, "").slice(0, 300);

    const lesson: ReflectiveRow = {
      id:         newId(),
      wallet:     row.wallet,
      category:   "self_audit",
      content:    `[dissentReview:${row.id}] PolicyEngine warn: ${reason} — consider whether this tool choice aligned with declared boundaries.`,
      confidence: 0.85,
      source:     "dissent_reviewer",
      created_at: now(),
    };
    kaiReflectiveMemory.push(lesson);
    inserted++;
  }

  return inserted;
}

// ── Scheduler tick stub ───────────────────────────────────────────────────────
async function schedulerTick(label: string): Promise<void> {
  console.log(`\n[tick] ${label} @ t=${now()}`);
  const inserted = await tickDissentReview();
  console.log(`  dissentReviewer: ${inserted} new lesson(s) written`);
}

// ── Demo ──────────────────────────────────────────────────────────────────────
async function demo(): Promise<void> {
  console.log("=== Guide 84 — Self-Audit Dissent Loop ===\n");

  const wallet = "e74e4ca3";

  // ── A. Simulate a tool call that triggers a warn verdict ─────────────────
  advance(1_000);
  console.log("A. Agent calls export_key with private_key arg…");
  const result = checkPolicy(wallet, "export_key", { private_key: "0xdeadbeef" });
  console.log(`   verdict: ${result.verdict}  reason: ${result.reason}`);

  const outRow = emitPolicyWarn(wallet, result.reason!);
  console.log(`   outbound row created: id=${outRow.id}`);
  console.log(`   agent_outbound.length = ${agentOutbound.length}`);

  // ── B. First scheduler tick — lesson should be written ───────────────────
  advance(30_000);
  await schedulerTick("tick-1");

  console.log(`   kai_reflective_memory.length = ${kaiReflectiveMemory.length}`);
  const lesson = kaiReflectiveMemory[0];
  console.log(`   lesson.category  = ${lesson.category}`);
  console.log(`   lesson.source    = ${lesson.source}`);
  console.log(`   lesson.content   = ${lesson.content.slice(0, 120)}…`);

  // ── C. Second scheduler tick — idempotent, no duplicate ─────────────────
  advance(30_000);
  await schedulerTick("tick-2 (idempotency check)");

  console.log(`   kai_reflective_memory.length = ${kaiReflectiveMemory.length} (should still be 1)`);

  // ── D. Second warn verdict → second lesson (different outbound ID) ────────
  advance(5_000);
  console.log("\nD. Agent calls bulk_delete with admin_override…");
  const result2 = checkPolicy(wallet, "bulk_delete", { admin_override: true, target: "all" });
  const outRow2 = emitPolicyWarn(wallet, result2.reason!);
  console.log(`   outbound row created: id=${outRow2.id}`);

  advance(30_000);
  await schedulerTick("tick-3 (second warn)");

  console.log(`   kai_reflective_memory.length = ${kaiReflectiveMemory.length} (should be 2)`);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n=== Summary ===");
  for (const m of kaiReflectiveMemory) {
    console.log(`  [${m.category}] source=${m.source} confidence=${m.confidence}`);
    console.log(`    ${m.content.slice(0, 100)}…`);
  }

  // ── Assertions ───────────────────────────────────────────────────────────
  console.log("\n=== Assertions ===");
  const assertions: Array<[boolean, string]> = [
    [agentOutbound.length === 2,           "Two outbound warn rows created"],
    [kaiReflectiveMemory.length === 2,     "Two reflective lessons (idempotency held)"],
    [kaiReflectiveMemory.every(m => m.category === "self_audit"), "All lessons are category=self_audit"],
    [kaiReflectiveMemory.every(m => m.source === "dissent_reviewer"), "All lessons sourced from dissent_reviewer"],
    [kaiReflectiveMemory[0].content.includes(agentOutbound[0].id), "Lesson 1 embeds outbound ID for idempotency"],
    [kaiReflectiveMemory[1].content.includes(agentOutbound[1].id), "Lesson 2 embeds outbound ID for idempotency"],
  ];

  let passed = 0;
  for (const [ok, label] of assertions) {
    console.log(`  ${ok ? "✅" : "❌"} ${label}`);
    if (ok) passed++;
  }

  console.log(`\n${passed}/${assertions.length} assertions passed`);
  if (passed < assertions.length) process.exit(1);
}

demo().catch(err => { console.error(err); process.exit(1); });
