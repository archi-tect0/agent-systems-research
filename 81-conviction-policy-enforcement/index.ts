/**
 * Guide 81 — Conviction → Policy Engine Enforcement Loop
 * Runnable reference implementation (no external deps).
 *
 * Demonstrates the full 6-step loop:
 *   A. Conviction snapshot
 *   B. PolicyEngine pre-flight (arg scan + boundary check + risk gate)
 *   C. Dissent recording
 *   D. Conviction update (closing the feedback loop)
 *
 * All behaviour is deterministic (scripted tape).
 * Run:  npx ts-node --experimentalSpecifierResolution=node index.ts
 */

// ─── Logical clock ─────────────────────────────────────────────────────────────
let _tick = 0;
const now = (): number => _tick;
const advance = (ms: number): void => { _tick += ms; };

// ─── Types ────────────────────────────────────────────────────────────────────
type Verdict = "allow" | "warn" | "block";
type RiskClass = "read" | "low_write" | "high_write";
type ConvictionKind = "must" | "must_not" | "prefer" | "avoid";

interface Conviction {
  id:           string;
  kind:         ConvictionKind;
  statement:    string;
  blockPattern?: string; // regex matched against toolName (must_not only)
}

interface PolicyInput {
  wallet:       string;
  toolName:     string;
  toolArgs:     string;
  riskClass:    RiskClass;
  passKeyFloor: boolean;
  hasPasskey:   boolean;
  convictions:  Conviction[];
}

interface PolicyResult {
  verdict:        Verdict;
  reason?:        string;
  suggestPassKey?: boolean;
}

interface DissentRecord {
  id:       string;
  toolName: string;
  reason:   string;
  wallet:   string;
  at:       number;
}

// ─── A. Conviction store (in-memory, mirrors kaiConstitutionTable) ─────────────
const convictionStore: Map<string, Conviction[]> = new Map();

function getConvictions(wallet: string): Conviction[] {
  return convictionStore.get(wallet) ?? [];
}

function setConviction(wallet: string, c: Conviction): void {
  const existing = convictionStore.get(wallet) ?? [];
  const idx = existing.findIndex(e => e.id === c.id);
  if (idx >= 0) existing[idx] = c;
  else existing.push(c);
  convictionStore.set(wallet, existing);
}

// ─── B. PolicyEngine ──────────────────────────────────────────────────────────
const DANGEROUS_ARG_PATTERNS: RegExp[] = [
  /seed\s*phrase/i,
  /private\s*key/i,
  /mnemonic/i,
  /ignore\s+(previous|all)\s+instructions/i,
  /system\s*prompt/i,
];

function checkPolicy(input: PolicyInput): PolicyResult {
  // 1. Dangerous arg scan
  for (const re of DANGEROUS_ARG_PATTERNS) {
    if (re.test(input.toolArgs)) {
      return { verdict: "block", reason: `Dangerous argument pattern detected: ${re.source}` };
    }
  }

  // 2. passKey floor
  if (input.passKeyFloor && !input.hasPasskey) {
    return { verdict: "block", reason: "Passkey required for this tool.", suggestPassKey: true };
  }

  // 3. Constitutional boundary (must_not convictions)
  for (const c of input.convictions) {
    if (c.kind === "must_not" && c.blockPattern) {
      const re = new RegExp(c.blockPattern, "i");
      if (re.test(input.toolName)) {
        return { verdict: "block", reason: `Conviction "${c.statement}" prohibits this action.` };
      }
    }
  }

  // 4. Risk gate
  if (input.riskClass === "high_write") {
    const endorsed = input.convictions.some(
      c => c.kind === "must" && c.blockPattern && new RegExp(c.blockPattern, "i").test(input.toolName),
    );
    if (!endorsed) {
      return { verdict: "warn", reason: `High-write tool "${input.toolName}" lacks an explicit conviction endorsement.` };
    }
  }

  return { verdict: "allow" };
}

// ─── C. Dissent recorder ──────────────────────────────────────────────────────
const dissentLog: DissentRecord[] = [];
let _dissentSeq = 0;

function recordDissent(wallet: string, toolName: string, reason: string): DissentRecord {
  const rec: DissentRecord = {
    id:       `dissent-${++_dissentSeq}`,
    wallet,
    toolName,
    reason,
    at:       now(),
  };
  dissentLog.push(rec);
  return rec;
}

// Simulates dissentReviewer.ts batch scan: converts dissent records → self_audit reflections
function runDissentReviewer(): string[] {
  return dissentLog.map(d =>
    `[dissent:${d.id}] Executed "${d.toolName}" despite policy warning — "${d.reason}". Review for constitutional drift.`,
  );
}

// ─── D. Conviction update (closing the feedback loop) ────────────────────────
function learnFromDissent(wallet: string, dissent: DissentRecord, approved: boolean): void {
  if (!approved) return; // only commit if the human endorsed the upgrade
  const newConviction: Conviction = {
    id:          `conv-from-${dissent.id}`,
    kind:        "must_not",
    statement:   `Never run ${dissent.toolName} without passkey confirmation (learned from dissent ${dissent.id}).`,
    blockPattern: `^${dissent.toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  };
  setConviction(wallet, newConviction);
}

// ─── Demo (scripted tape) ─────────────────────────────────────────────────────
function main(): void {
  const WALLET = "0xdemo-wallet";

  // Seed initial convictions
  setConviction(WALLET, {
    id: "c1",
    kind: "must_not",
    statement: "Never share wallet balance with third-party apps.",
    blockPattern: "expose_a2a",
  });

  // A. Conviction snapshot
  const convictions = getConvictions(WALLET);
  console.log(`[A] Conviction snapshot: ${convictions.length} conviction(s).`);
  console.assert(convictions.length === 1, "FAIL: expected 1 conviction");

  // B. Test 1 — allow (safe, low-risk tool)
  advance(10);
  const r1 = checkPolicy({
    wallet: WALLET, toolName: "get_token_price", toolArgs: '{"symbol":"ETH"}',
    riskClass: "read", passKeyFloor: false, hasPasskey: false, convictions,
  });
  console.log(`[B] get_token_price verdict: ${r1.verdict}`);
  console.assert(r1.verdict === "allow", "FAIL: expected allow");
  console.log("  PASS ✓");

  // B. Test 2 — block by conviction (expose_a2a blocked by must_not)
  advance(10);
  const r2 = checkPolicy({
    wallet: WALLET, toolName: "expose_a2a", toolArgs: '{"scope":"balance"}',
    riskClass: "high_write", passKeyFloor: true, hasPasskey: false, convictions,
  });
  console.log(`[B] expose_a2a verdict: ${r2.verdict} — ${r2.reason}`);
  console.assert(r2.verdict === "block", "FAIL: expected block");
  console.log("  PASS ✓");

  // B. Test 3 — block by dangerous arg
  advance(10);
  const r3 = checkPolicy({
    wallet: WALLET, toolName: "remember", toolArgs: '{"content":"my seed phrase is abandon abandon..."}',
    riskClass: "low_write", passKeyFloor: false, hasPasskey: false, convictions,
  });
  console.log(`[B] remember (seed phrase) verdict: ${r3.verdict} — ${r3.reason}`);
  console.assert(r3.verdict === "block", "FAIL: expected block");
  console.log("  PASS ✓");

  // B. Test 4 — warn (high_write without conviction endorsement)
  advance(10);
  const r4 = checkPolicy({
    wallet: WALLET, toolName: "sentinel_send", toolArgs: '{"to":"0xabc","amount":"0.1","token":"ETH"}',
    riskClass: "high_write", passKeyFloor: true, hasPasskey: true, convictions,
  });
  console.log(`[B] sentinel_send verdict: ${r4.verdict} — ${r4.reason}`);
  console.assert(r4.verdict === "warn", "FAIL: expected warn");

  // C. Record dissent
  const dissent = recordDissent(WALLET, "sentinel_send", r4.reason ?? "");
  console.log(`[C] Dissent recorded: ${dissent.id}`);

  // Simulate tool execution despite warn (user proceeds)
  console.log("[C] Tool executed (user confirmed proceed despite warn).");
  advance(200);

  // Run dissent reviewer
  const reflections = runDissentReviewer();
  console.log(`[C] Dissent reviewer produced ${reflections.length} reflection(s):`);
  for (const ref of reflections) console.log("   ", ref.slice(0, 90) + "...");
  console.assert(reflections.length === 1, "FAIL: expected 1 reflection");
  console.log("  PASS ✓");

  // D. Human reviews and endorses a new conviction based on the dissent
  learnFromDissent(WALLET, dissent, true /* user approved the learning */);
  const updatedConvictions = getConvictions(WALLET);
  console.log(`[D] Conviction store updated: ${updatedConvictions.length} conviction(s).`);
  console.assert(updatedConvictions.length === 2, "FAIL: expected 2 convictions after learning");

  // Verify the loop: sentinel_send is now blocked by the new conviction
  advance(10);
  const r5 = checkPolicy({
    wallet: WALLET, toolName: "sentinel_send", toolArgs: '{"to":"0xabc","amount":"0.1","token":"ETH"}',
    riskClass: "high_write", passKeyFloor: true, hasPasskey: true, convictions: updatedConvictions,
  });
  console.log(`[D] sentinel_send (after conviction update) verdict: ${r5.verdict} — ${r5.reason}`);
  console.assert(r5.verdict === "block", "FAIL: expected block after conviction learning");
  console.log("  PASS ✓ — feedback loop closed.");

  console.log(`\nGuide 81 demo complete. Total elapsed: ${now()} ms.`);
}

main();
