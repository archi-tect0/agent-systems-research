/**
 * Self-Directed Capability Acquisition — reference implementation.
 *
 * Self-repair (guide 66) fixes a capability the agent ALREADY has and that
 * broke. This is the other half of self-maintenance: noticing a capability the
 * agent does NOT have, and growing it — drafting a new tool, proving it works on
 * generated cases, and registering it behind the SAME governance wall self-repair
 * uses (throwaway branch, human merge, an authority band assigned on the way in).
 *
 * "Let the agent write its own tools" is, said plainly, an account-compromise
 * primitive. The whole guide is the wall around that ability:
 *
 *   1. Gap detection      — a capability gap is EARNED, not asserted: the same
 *      unmet intent has to recur N times before the agent is allowed to act.
 *   2. Synthesis on a branch — the new tool's spec + impl are written to a clone
 *      of the registry, never the live one.
 *   3. Generated verification — the agent generates test cases from the intent
 *      and the tool must pass ALL of them; a tool that "exists" but fails its own
 *      tests is discarded (a real rollback — the live registry was never touched).
 *   4. Governance on landing — a passing tool is registered as `proposed`, NOT
 *      `active`: a human approves it and an authority band is assigned. Until
 *      then the dispatcher refuses to call it.
 *   5. Skill memory        — acquired skills (and rejected attempts) are recorded
 *      so the agent does not re-derive or re-propose the same thing.
 *
 * The load-bearing property is identical to self-repair's: the worst case of a
 * bad self-authored capability is a discarded branch and a rejected proposal —
 * never a live tool nobody approved.
 *
 * Run it:
 *   node capability-acquisition.ts --demo     # Node 24+ strips TS types natively
 *   npx tsx capability-acquisition.ts --demo
 *
 * Node.js built-ins only. No network, no real codegen — "synthesis" picks from a
 * small library of candidate implementations so the demo stays runnable and the
 * CONTROL FLOW (the wall) is what you read, not a toy LLM.
 */

// ─────────────────────────────────────────────────────────────────────────
// (4) The capability registry — the thing being protected.
// ─────────────────────────────────────────────────────────────────────────

type ToolStatus = "proposed" | "active" | "rejected";

type ToolSpec = {
  name: string;
  description: string;
  /** Authority band required to invoke; assigned by a human at approval time. */
  band: number | null;
  status: ToolStatus;
  /** The implementation under test. Pure function for the demo. */
  impl: (args: Record<string, unknown>) => unknown;
};

class CapabilityRegistry {
  private tools = new Map<string, ToolSpec>();

  has(name: string): boolean {
    return this.tools.has(name) && this.tools.get(name)!.status === "active";
  }
  add(spec: ToolSpec): void {
    this.tools.set(spec.name, spec);
  }
  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }
  /** The dispatcher's view: only ACTIVE tools may be invoked. */
  invoke(name: string, args: Record<string, unknown>): unknown {
    const t = this.tools.get(name);
    if (!t) throw new Error(`unknown tool: ${name}`);
    if (t.status !== "active") throw new Error(`tool '${name}' is ${t.status}, not active — refused`);
    return t.impl(args);
  }
  /** A structural clone — the "branch" the synthesizer writes to. */
  clone(): CapabilityRegistry {
    const c = new CapabilityRegistry();
    for (const t of this.tools.values()) c.add({ ...t });
    return c;
  }
  list(): ToolSpec[] {
    return [...this.tools.values()];
  }
}

// ─────────────────────────────────────────────────────────────────────────
// (1) Gap detection — a gap must be EARNED by recurrence.
// ─────────────────────────────────────────────────────────────────────────

type IntentMiss = { intent: string; example: string };

class GapDetector {
  private counts = new Map<string, { n: number; lastExample: string }>();
  private readonly threshold: number;
  constructor(threshold = 3) {
    this.threshold = threshold;
  }
  /** Record an intent the agent could not satisfy. Returns true once it qualifies. */
  observe(miss: IntentMiss): boolean {
    const c = this.counts.get(miss.intent) ?? { n: 0, lastExample: "" };
    c.n += 1;
    c.lastExample = miss.example;
    this.counts.set(miss.intent, c);
    return c.n >= this.threshold;
  }
  count(intent: string): number {
    return this.counts.get(intent)?.n ?? 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// (3) Verification — generated cases the candidate must pass.
//
// In production these come from an LLM that reads the intent; here a small map
// supplies deterministic (args -> expected) cases per intent so the demo proves
// the WALL: a candidate that fails any case is discarded.
// ─────────────────────────────────────────────────────────────────────────

type TestCase = { args: Record<string, unknown>; expect: unknown };

const TEST_SUITES: Record<string, TestCase[]> = {
  "math.percent": [
    { args: { part: 50, whole: 200 }, expect: 25 },
    { args: { part: 1, whole: 4 }, expect: 25 },
    { args: { part: 3, whole: 3 }, expect: 100 },
  ],
  "text.wordcount": [
    { args: { text: "one two three" }, expect: 3 },
    { args: { text: "" }, expect: 0 },
    { args: { text: "  spaced   out  words " }, expect: 3 },
  ],
};

// A tiny library the synthesizer "draws from" — including a deliberately buggy
// percent impl, so the demo shows a candidate failing verification and rolling
// back before a correct one lands.
const CANDIDATE_IMPLS: Record<string, ((args: Record<string, unknown>) => unknown)[]> = {
  "math.percent": [
    (a) => (a.part as number) / (a.whole as number), // BUG: forgot *100 — synthesized first, fails verification, discarded on the branch
    (a) => ((a.part as number) / (a.whole as number)) * 100, // correct — passes every case, gets proposed
  ],
  "text.wordcount": [
    (a) => String(a.text).trim().split(/\s+/).filter(Boolean).length, // correct
  ],
};

type AcquisitionOutcome =
  | { kind: "not_yet"; intent: string; seen: number }
  | { kind: "no_candidate"; intent: string }
  | { kind: "verification_failed"; intent: string; tried: number }
  | { kind: "proposed"; name: string; passed: number }
  | { kind: "already_have"; name: string };

// ─────────────────────────────────────────────────────────────────────────
// The acquirer ties it together: detect -> synthesize on a branch -> verify ->
// propose (never auto-activate).
// ─────────────────────────────────────────────────────────────────────────

class CapabilityAcquirer {
  private registry: CapabilityRegistry;
  private gaps: GapDetector;
  /** (5) skill memory — what we acquired or already rejected. */
  private skillMemory = new Map<string, "proposed" | "rejected">();

  constructor(registry: CapabilityRegistry, threshold = 3) {
    this.registry = registry;
    this.gaps = new GapDetector(threshold);
  }

  observeMiss(miss: IntentMiss): AcquisitionOutcome {
    const toolName = intentToToolName(miss.intent);
    if (this.registry.has(toolName)) return { kind: "already_have", name: toolName };

    // (5) Skill memory short-circuit: never re-synthesize something we already
    // proposed (awaiting a human) or already rejected (its only candidates fail).
    const remembered = this.skillMemory.get(toolName);
    if (remembered === "proposed") return { kind: "proposed", name: toolName, passed: 0 };
    if (remembered === "rejected") return { kind: "verification_failed", intent: miss.intent, tried: 0 };

    const qualifies = this.gaps.observe(miss);
    if (!qualifies) return { kind: "not_yet", intent: miss.intent, seen: this.gaps.count(miss.intent) };

    return this.acquire(miss.intent);
  }

  private acquire(intent: string): AcquisitionOutcome {
    const candidates = CANDIDATE_IMPLS[intent] ?? [];
    const suite = TEST_SUITES[intent] ?? [];
    if (candidates.length === 0 || suite.length === 0) return { kind: "no_candidate", intent };

    // (2) Work on a CLONE of the registry — the branch.
    const branch = this.registry.clone();
    const name = intentToToolName(intent);

    let tried = 0;
    for (const impl of candidates) {
      tried += 1;
      const spec: ToolSpec = { name, description: `auto-acquired: ${intent}`, band: null, status: "proposed", impl };
      branch.add(spec);

      // (3) Verify against every generated case ON THE BRANCH.
      const passed = this.runSuite(branch, name, suite);
      if (passed === suite.length) {
        // Promote the branch's proposed tool into the LIVE registry — still
        // 'proposed', so the dispatcher will refuse it until a human approves.
        this.registry.add({ ...spec });
        this.skillMemory.set(name, "proposed");
        return { kind: "proposed", name, passed };
      }
      // failed -> discard this candidate (the branch tool is simply overwritten)
    }
    this.skillMemory.set(name, "rejected");
    return { kind: "verification_failed", intent, tried };
  }

  private runSuite(reg: CapabilityRegistry, name: string, suite: TestCase[]): number {
    let passed = 0;
    for (const tc of suite) {
      let got: unknown;
      try {
        got = reg.get(name)!.impl(tc.args);
      } catch {
        got = Symbol("threw");
      }
      if (Object.is(got, tc.expect)) passed += 1;
    }
    return passed;
  }

  /** (4) Governance landing — a human approves and assigns an authority band. */
  approve(name: string, band: number): void {
    const t = this.registry.get(name);
    if (!t) throw new Error(`unknown tool: ${name}`);
    if (t.status !== "proposed") throw new Error(`tool '${name}' is ${t.status}, not proposed`);
    t.status = "active";
    t.band = band;
  }
  reject(name: string): void {
    const t = this.registry.get(name);
    if (t) t.status = "rejected";
    this.skillMemory.set(name, "rejected");
  }
}

function intentToToolName(intent: string): string {
  return intent.replace(/[^a-z0-9]+/gi, "_");
}

// ─────────────────────────────────────────────────────────────────────────
// Demo
// ─────────────────────────────────────────────────────────────────────────

function banner(t: string) {
  console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
}

function demo() {
  const registry = new CapabilityRegistry();
  const acq = new CapabilityAcquirer(registry, 3);

  banner("Scenario 1 — a gap must be EARNED: first misses do not trigger codegen");
  {
    console.log("  " + JSON.stringify(acq.observeMiss({ intent: "math.percent", example: "what % is 50 of 200?" })));
    console.log("  " + JSON.stringify(acq.observeMiss({ intent: "math.percent", example: "1 of 4 as a percent?" })));
    console.log("  (two misses — still NOT_YET; one-off intents never become tools.)");
  }

  banner("Scenario 2 — threshold reached → synthesize, a buggy candidate is caught");
  {
    const out = acq.observeMiss({ intent: "math.percent", example: "3 of 3?" });
    console.log("  outcome: " + JSON.stringify(out));
    console.log("  (the FIRST candidate returns 0.25 instead of 25 — it fails verification and is");
    console.log("   discarded on the branch; the SECOND, correct candidate passed all 3 cases and");
    console.log("   is now PROPOSED. Nothing reached the live registry until a candidate verified.)");
  }

  banner("Scenario 3 — a PROPOSED tool cannot be invoked until a human approves");
  {
    try {
      registry.invoke("math_percent", { part: 50, whole: 200 });
    } catch (e) {
      console.log("  dispatcher refused: " + (e as Error).message);
    }
    acq.approve("math_percent", 1); // human approves, assigns authority band 1
    console.log("  after human approval (band 1): math_percent(50,200) = " + registry.invoke("math_percent", { part: 50, whole: 200 }));
  }

  banner("Scenario 4 — verification failure path (no correct candidate available)");
  {
    const reg2 = new CapabilityRegistry();
    const acq2 = new CapabilityAcquirer(reg2, 1);
    // Force an intent whose only candidate is buggy by reusing the buggy percent
    // impl under a different intent with the SAME strict suite.
    TEST_SUITES["math.badpercent"] = TEST_SUITES["math.percent"];
    CANDIDATE_IMPLS["math.badpercent"] = [(a) => (a.part as number) / (a.whole as number)]; // always wrong
    const out = acq2.observeMiss({ intent: "math.badpercent", example: "fails on purpose" });
    console.log("  outcome: " + JSON.stringify(out));
    console.log("  (no candidate passed; nothing was added to the live registry.)");
    const again = acq2.observeMiss({ intent: "math.badpercent", example: "asked yet again" });
    console.log("  re-asked: " + JSON.stringify(again));
    console.log("  (skill memory remembers the rejection — tried:0, so the agent does not re-synthesize on a loop.)");
  }

  banner("Scenario 5 — acquired skill is remembered; re-asking is a no-op");
  {
    const out = acq.observeMiss({ intent: "math.percent", example: "asked again" });
    console.log("  outcome: " + JSON.stringify(out));
  }

  console.log("\n  final registry:");
  for (const t of registry.list()) console.log(`    • ${t.name} — status=${t.status} band=${t.band}`);

  console.log("\nDone. A capability gap had to recur before the agent acted; synthesis and");
  console.log("verification happened on a clone; a failing candidate was discarded; and the");
  console.log("new tool stayed inert until a human approved it and gave it an authority band.\n");
}

if (process.argv.includes("--demo")) {
  demo();
}

export { CapabilityRegistry, CapabilityAcquirer, GapDetector };
export type { ToolSpec, ToolStatus, IntentMiss, AcquisitionOutcome, TestCase };
