/**
 * Metacognitive Self-Repair Loop — reference implementation.
 *
 * A small, dependency-free model of how an agent reasons about its OWN
 * operational state and repairs itself without ever being able to silently
 * mutate production. The ten facets of "an agent that maintains itself":
 *
 *   1. Metacognitive loop        — the run() cycle below ties it all together
 *   2. Operational introspection — read-only PROBES over live state
 *   3. Self-diagnosis            — diagnose(): failing signals -> a hypothesis
 *   4. Self-repair               — REMEDIATIONS applied on a branch
 *   5. Subsystem health model    — Workspace: model / tools / build subsystems
 *   6. Model-selection for repair— "request the right model" as a remediation
 *   7. Governance-gated healing  — branch wall + grant tiers + human merge
 *   8. Memory-driven adaptation  — RepairMemory recalls past fixes
 *   9. Temporal awareness        — cooldowns, flapping detection, recency
 *  10. Behavioral metacognition  — recognizing "I just did that wrong" and
 *                                  recording a correction without touching code
 *
 * The load-bearing idea is not "the agent edits code". It is the WALL around
 * that ability: every probe is read-only, every code write happens on a
 * throwaway branch, every fix is verified by re-running the probe that failed,
 * and nothing reaches `main` without a one-tap human approval. Diagnosis is
 * autonomous; landing is not.
 *
 * Run it:
 *   node self-repair-loop.ts --demo     # Node 24+ strips TS types natively
 *   npx tsx self-repair-loop.ts --demo
 *
 * Node.js built-ins only. No network, no real git, no real file writes — the
 * "workspace" is an in-memory object and the "branch" is a structural clone of
 * it, so a rollback is a genuine discard, not a pretend one.
 */

// ─────────────────────────────────────────────────────────────────────────
// (5) Subsystem health model — the world the agent introspects.
//
// In the real system these fields are read from logs, `git status`, connector
// status, and backend health probes. Here they are a plain object so the demo
// stays runnable on built-ins. Probes READ this; remediations write only to a
// CLONE of it (the branch), never the original until a merge is approved.
// ─────────────────────────────────────────────────────────────────────────

type ModelHealth = {
  /** Logical model id the router is currently pointed at. */
  active: string;
  /** Ordered fallback chain the router may switch to. */
  chain: string[];
  /** Rolling fraction of recent turns that produced an empty/garbage reply. */
  emptyReplyRate: number;
  /** Rolling p95 latency in ms for the active model. */
  p95LatencyMs: number;
};

type ToolHealth = {
  name: string;
  /** The endpoint the tool currently calls. A stale value is a classic fault. */
  endpoint: string;
  /** Known-good endpoint, discovered out of band (service registry, docs). */
  knownGoodEndpoint: string;
  /** Rolling fraction of recent calls that returned a 4xx/404. */
  errorRate: number;
};

type BuildHealth = {
  /** Does the workspace currently typecheck? */
  typechecks: boolean;
  /** Human-readable first error, when it does not. */
  firstError: string | null;
};

type Workspace = {
  model: ModelHealth;
  tools: ToolHealth[];
  build: BuildHealth;
};

// ─────────────────────────────────────────────────────────────────────────
// (2) Operational introspection — signals + probes.
// ─────────────────────────────────────────────────────────────────────────

type Signal = {
  probe: string;
  ok: boolean;
  detail: string;
  /** Optional numeric the diagnoser can threshold on. */
  metric?: number;
};

/** A read-only check over the workspace. Probes must never mutate. */
type HealthProbe = {
  name: string;
  run: (w: Readonly<Workspace>) => Signal;
};

// ─────────────────────────────────────────────────────────────────────────
// (3) Self-diagnosis — fault hypotheses.
// ─────────────────────────────────────────────────────────────────────────

type FaultKind =
  | "model_degraded"
  | "tool_endpoint_stale"
  | "build_broken"
  | "behavior_drift" // (10) a self-recognised mistake — not a code/infra fault
  | "unknown";

type FaultHypothesis = {
  kind: FaultKind;
  /** 0–1. Below CONFIDENCE_FLOOR the loop reports instead of acting. */
  confidence: number;
  evidence: string[];
  /** Stable key for memory + cooldown lookups (10): subsystem identity. */
  signature: string;
};

// ─────────────────────────────────────────────────────────────────────────
// (4) Self-repair — remediations.
//
// Each remediation is keyed by fault kind. `apply` runs against a BRANCH (a
// clone), returns whether it believes it changed anything, and the loop then
// re-runs the relevant probe to VERIFY. A remediation that cannot verify is
// rolled back — the loop never trusts its own claim of success.
// ─────────────────────────────────────────────────────────────────────────

type Remediation = {
  kind: FaultKind;
  /** One-line, audit-friendly description of the intended change. */
  describe: (w: Readonly<Workspace>, fault: FaultHypothesis) => string;
  /** Mutates the branch clone. Returns true if it made a change. */
  apply: (branch: Workspace, fault: FaultHypothesis) => boolean;
  /** Which probe proves the fix worked. */
  verifyWith: string;
};

// ─────────────────────────────────────────────────────────────────────────
// Constants — the safety floor + temporal bounds.
// ─────────────────────────────────────────────────────────────────────────

const CONFIDENCE_FLOOR = 0.55; // below this, do not touch the branch — report.
const MAX_REMEDIATION_ROUNDS = 3; // bound the self-repair loop; no infinite churn.
const COMMIT_AUTHOR = "Agent (engineering mode) <agent@dbk.local>";
const BRANCH_PREFIX = "agent/"; // writes are ONLY ever valid on this namespace.
const FLAP_COOLDOWN_MS = 10 * 60 * 1000; // (9) a fault re-fixed within this window is "flapping".

// ─────────────────────────────────────────────────────────────────────────
// (8)+(9) Memory-driven adaptation + temporal awareness — RepairMemory.
//
// A durable record of what was tried, what worked, and WHEN. It lets the loop
// (a) recall a known-good remedy on a recurring fault instead of re-deriving
// it, and (b) detect flapping — a fault that comes back almost immediately
// after a "successful" fix, which means the fix is not actually holding and a
// human should look, not the agent retry forever.
//
// In production this is the agent's correction-memory / fact store
// (writeFact + the self-learning vocabulary), not an in-process Map.
// ─────────────────────────────────────────────────────────────────────────

type MemoEntry = {
  remedyKind: FaultKind;
  remedySummary: string;
  lastOutcome: "verified" | "failed";
  lastAt: number; // epoch ms — the temporal anchor
  attempts: number;
};

class RepairMemory {
  private store = new Map<string, MemoEntry>();
  /** Injectable clock so tests/demos can simulate elapsed time. */
  now: () => number = () => Date.now();

  recall(signature: string): MemoEntry | undefined {
    return this.store.get(signature);
  }

  record(signature: string, entry: Omit<MemoEntry, "attempts">): void {
    const prev = this.store.get(signature);
    this.store.set(signature, { ...entry, attempts: (prev?.attempts ?? 0) + 1 });
  }

  /** True if this signature was verified-fixed within the cooldown window. */
  isFlapping(signature: string): boolean {
    const m = this.store.get(signature);
    if (!m || m.lastOutcome !== "verified") return false;
    return this.now() - m.lastAt < FLAP_COOLDOWN_MS;
  }

  /** Test/demo hook: backdate an entry so the cooldown has lapsed. */
  backdate(signature: string, ms: number): void {
    const m = this.store.get(signature);
    if (m) m.lastAt = this.now() - ms;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Probes — the introspection surface (all read-only).
// ─────────────────────────────────────────────────────────────────────────

const PROBES: HealthProbe[] = [
  {
    name: "model_replies",
    run: (w) => {
      const bad = w.model.emptyReplyRate;
      return {
        probe: "model_replies",
        ok: bad < 0.2,
        metric: bad,
        detail:
          bad < 0.2
            ? `active model '${w.model.active}' replying normally (${pct(bad)} empty)`
            : `active model '${w.model.active}' returned empty/garbage on ${pct(bad)} of recent turns`,
      };
    },
  },
  {
    name: "model_latency",
    run: (w) => {
      const slow = w.model.p95LatencyMs > 8000;
      return {
        probe: "model_latency",
        ok: !slow,
        metric: w.model.p95LatencyMs,
        detail: `active model p95 latency ${w.model.p95LatencyMs}ms`,
      };
    },
  },
  {
    name: "tool_endpoints",
    run: (w) => {
      const broken = w.tools.filter((t) => t.errorRate >= 0.5);
      return {
        probe: "tool_endpoints",
        ok: broken.length === 0,
        metric: broken.length,
        detail:
          broken.length === 0
            ? "all tool endpoints healthy"
            : `tool(s) failing: ${broken.map((t) => `${t.name} (${pct(t.errorRate)} errors → ${t.endpoint})`).join(", ")}`,
      };
    },
  },
  {
    name: "typecheck",
    run: (w) => ({
      probe: "typecheck",
      ok: w.build.typechecks,
      detail: w.build.typechecks
        ? "workspace typechecks clean"
        : `typecheck failing: ${w.build.firstError ?? "unknown error"}`,
    }),
  },
];

// ─────────────────────────────────────────────────────────────────────────
// (3) Diagnosis — map a set of failing signals to the single most-supported
// fault. Deliberately rule-based and legible: a real system can swap this for
// a `regression_analyst` worker that reads logs + diffs and returns the same
// {kind, confidence, evidence} shape. The CONTRACT is what matters.
// ─────────────────────────────────────────────────────────────────────────

function diagnose(signals: Signal[]): FaultHypothesis {
  const failing = signals.filter((s) => !s.ok);
  if (failing.length === 0) {
    return { kind: "unknown", confidence: 0, evidence: ["all probes green"], signature: "none" };
  }

  const byProbe = new Map(failing.map((s) => [s.probe, s]));
  const evidence = failing.map((s) => `${s.probe}: ${s.detail}`);

  // A broken build is the most concrete, highest-confidence fault — it has a
  // deterministic verification (does it typecheck now?).
  if (byProbe.has("typecheck")) {
    return { kind: "build_broken", confidence: 0.95, evidence, signature: "build:typecheck" };
  }

  // A tool returning mostly 404s with a known-good endpoint on file is an
  // unambiguous, cheap fix.
  if (byProbe.has("tool_endpoints")) {
    return { kind: "tool_endpoint_stale", confidence: 0.85, evidence, signature: "tool:endpoint" };
  }

  // Empty replies → the active model is the suspect. Latency alone is weaker
  // evidence (could be the network), so it lowers confidence rather than
  // standing on its own.
  if (byProbe.has("model_replies")) {
    const conf = byProbe.has("model_latency") ? 0.9 : 0.75;
    return { kind: "model_degraded", confidence: conf, evidence, signature: "model:replies" };
  }
  if (byProbe.has("model_latency")) {
    // Latency only — plausibly transient. Below the floor on purpose so the
    // loop reports rather than thrashing the model chain on a blip.
    return { kind: "model_degraded", confidence: 0.4, evidence, signature: "model:latency" };
  }

  return { kind: "unknown", confidence: 0.3, evidence, signature: "unknown" };
}

// ─────────────────────────────────────────────────────────────────────────
// Remediation registry.
// ─────────────────────────────────────────────────────────────────────────

const REMEDIATIONS: Remediation[] = [
  {
    // (6) Model-selection for repairs.
    kind: "model_degraded",
    verifyWith: "model_replies",
    describe: (w) => {
      const next = nextModel(w.model);
      return `request a different model: switch active backend '${w.model.active}' → '${next ?? "(none available)"}'`;
    },
    apply: (branch) => {
      // "Request the correct model" == walk the fallback chain to the next
      // entry and reset the rolling health counters so the next probe measures
      // the NEW model, not the old one's history.
      const next = nextModel(branch.model);
      if (!next) return false;
      branch.model.active = next;
      branch.model.emptyReplyRate = 0; // fresh model, fresh measurement
      branch.model.p95LatencyMs = 1200;
      return true;
    },
  },
  {
    kind: "tool_endpoint_stale",
    verifyWith: "tool_endpoints",
    describe: (w) => {
      const t = w.tools.find((x) => x.errorRate >= 0.5);
      return t
        ? `behavior_fix (api_endpoint_fix): repoint '${t.name}' ${t.endpoint} → ${t.knownGoodEndpoint}`
        : "no stale tool found";
    },
    apply: (branch) => {
      const t = branch.tools.find((x) => x.errorRate >= 0.5);
      if (!t || t.endpoint === t.knownGoodEndpoint) return false;
      t.endpoint = t.knownGoodEndpoint;
      t.errorRate = 0;
      return true;
    },
  },
  {
    kind: "build_broken",
    verifyWith: "typecheck",
    describe: (w) =>
      `branch + fix: address '${w.build.firstError ?? "build error"}', then run typecheck`,
    apply: (branch) => {
      if (branch.build.typechecks) return false;
      // The real loop would write_file + exec(`pnpm typecheck`); here we model
      // a successful edit. A fix that did NOT resolve the error would leave
      // `typechecks=false` and fail verification → rollback.
      branch.build.typechecks = true;
      branch.build.firstError = null;
      return true;
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────
// (1) The metacognitive loop.
// ─────────────────────────────────────────────────────────────────────────

type AuditEntry = { ts: string; step: string; detail: string };

type RepairOutcome =
  | { status: "healthy"; audit: AuditEntry[] }
  | { status: "reported"; reason: string; audit: AuditEntry[] }
  | { status: "self_corrected"; signature: string; note: string; audit: AuditEntry[] }
  | { status: "merge_proposed"; branch: string; diff: string; audit: AuditEntry[] }
  | { status: "escalated"; reason: string; audit: AuditEntry[] };

/** (10) A self-recognised behavioural mistake the agent surfaces about itself. */
type SelfCorrection = {
  priorWrong: string;
  correctionType:
    | "url_fix"
    | "api_endpoint_fix"
    | "api_argument_fix"
    | "tool_invocation_fix"
    | "schema_fix"
    | "factual_fix"
    | "process_fix"
    | "auth_fix"
    | "other";
  correct: string;
};

class SelfRepairLoop {
  private audit: AuditEntry[] = [];
  private workspace: Workspace;
  private memory: RepairMemory;

  constructor(workspace: Workspace, memory?: RepairMemory) {
    this.workspace = workspace;
    this.memory = memory ?? new RepairMemory();
  }

  private log(step: string, detail: string): void {
    this.audit.push({ ts: new Date().toISOString(), step, detail });
  }

  /** Run every probe against the live workspace (read-only). */
  private introspect(w: Readonly<Workspace>): Signal[] {
    return PROBES.map((p) => p.run(w));
  }

  /**
   * (7) Open a "branch": a structural clone of the workspace. All code writes
   * happen here. If we never propose a merge, this clone is simply discarded —
   * the real workspace is untouched. In-memory analogue of the `agent/*`
   * branch wall.
   */
  private openBranch(name: string): Workspace {
    if (!name.startsWith(BRANCH_PREFIX)) {
      throw new Error(`refusing to write: '${name}' is not under ${BRANCH_PREFIX}`);
    }
    this.log("git_branch", `opened write-eligible branch '${name}' off main`);
    return structuredClone(this.workspace);
  }

  /**
   * (10) Behavioral metacognition: the agent recognises a mistake it made in
   * the conversation itself (wrong URL, wrong tool, wrong fact) and records a
   * correction memory. No branch, no code change — the "fix" is the durable
   * lesson so the same mistake is not repeated. This is distinct from infra
   * self-repair: it heals behaviour, not the system.
   */
  selfCorrect(sc: SelfCorrection): RepairOutcome {
    const signature = `behavior:${sc.correctionType}`;
    this.log("metacognition", `recognised own mistake (${sc.correctionType}): '${sc.priorWrong}' → '${sc.correct}'`);
    this.memory.record(signature, {
      remedyKind: "behavior_drift",
      remedySummary: `${sc.correctionType}: '${sc.priorWrong}' → '${sc.correct}'`,
      lastOutcome: "verified",
      lastAt: this.memory.now(),
    });
    this.log("memory_write", `correction memory stored under '${signature}' (will not repeat)`);
    return {
      status: "self_corrected",
      signature,
      note: `${sc.correctionType}: '${sc.priorWrong}' → '${sc.correct}'`,
      audit: this.audit,
    };
  }

  run(symptom: string): RepairOutcome {
    this.log("symptom", symptom);

    for (let round = 1; round <= MAX_REMEDIATION_ROUNDS; round++) {
      // (2) INTROSPECT
      const signals = this.introspect(this.workspace);
      const failing = signals.filter((s) => !s.ok);
      for (const s of signals) {
        this.log("probe", `${s.ok ? "OK  " : "FAIL"} ${s.probe} — ${s.detail}`);
      }
      if (failing.length === 0) {
        this.log("introspect", "all probes green — nothing to repair");
        return { status: "healthy", audit: this.audit };
      }

      // (3) DIAGNOSE
      const fault = diagnose(signals);
      this.log(
        "diagnose",
        `fault=${fault.kind} confidence=${fault.confidence.toFixed(2)} sig=${fault.signature} :: ${fault.evidence.join(" | ")}`,
      );

      // (3a) Confidence floor — request human help instead of guessing.
      if (fault.confidence < CONFIDENCE_FLOOR) {
        const reason = `confidence ${fault.confidence.toFixed(2)} < floor ${CONFIDENCE_FLOOR}; reporting without acting`;
        this.log("report", reason);
        return { status: "reported", reason, audit: this.audit };
      }

      // (9) TEMPORAL AWARENESS — flapping guard. If we verified-fixed this exact
      // fault moments ago and it is already back, the fix is not holding; a
      // human should look rather than the agent re-applying the same remedy.
      if (this.memory.isFlapping(fault.signature)) {
        const reason = `'${fault.signature}' was repaired < ${FLAP_COOLDOWN_MS / 60000}m ago and recurred — flapping; escalating to human`;
        this.log("escalate", reason);
        return { status: "escalated", reason, audit: this.audit };
      }

      // (8) MEMORY-DRIVEN ADAPTATION — recall a prior verified remedy. Here the
      // registry has one remedy per fault kind, so recall confirms the plan
      // rather than choosing among variants; its real work is distinguishing a
      // first occurrence from a known recurrence (which also feeds the flapping
      // guard above). With a richer registry, recall would rank remedy variants.
      const memo = this.memory.recall(fault.signature);
      if (memo && memo.lastOutcome === "verified") {
        this.log("recall", `known recurrence (${memo.attempts}× before): last verified remedy was "${memo.remedySummary}" — confirms the plan`);
      }

      // (4) SELECT REMEDIATION
      const remediation = REMEDIATIONS.find((r) => r.kind === fault.kind);
      if (!remediation) {
        const reason = `no remediation registered for fault '${fault.kind}'`;
        this.log("escalate", reason);
        return { status: "escalated", reason, audit: this.audit };
      }

      // (7) APPLY ON A BRANCH (never on main)
      const branchName = `${BRANCH_PREFIX}fix-${fault.kind.replace(/_/g, "-")}`;
      const branch = this.openBranch(branchName);
      const plan = remediation.describe(this.workspace, fault);
      this.log("plan", plan);
      const changed = remediation.apply(branch, fault);
      if (!changed) {
        this.log("escalate", "remediation made no change — escalating");
        return { status: "escalated", reason: "remediation was a no-op", audit: this.audit };
      }

      // (4) VERIFY — re-run the proving probe ON THE BRANCH.
      const proof = PROBES.find((p) => p.name === remediation.verifyWith)!.run(branch);
      this.log("verify", `${proof.ok ? "PASS" : "FAIL"} ${proof.probe} — ${proof.detail}`);
      if (!proof.ok) {
        // The fix did not hold. Discard the branch (rollback). Record the
        // failure so memory reflects it, then try the next round.
        this.log("rollback", `discarding '${branchName}' — verification failed`);
        this.memory.record(fault.signature, {
          remedyKind: fault.kind,
          remedySummary: plan,
          lastOutcome: "failed",
          lastAt: this.memory.now(),
        });
        if (round === MAX_REMEDIATION_ROUNDS) {
          return { status: "escalated", reason: "exhausted remediation rounds without a verified fix", audit: this.audit };
        }
        continue;
      }

      // (7) COMMIT (on the branch) + PROPOSE MERGE (human gate)
      this.log("git_commit", `committed by '${COMMIT_AUTHOR}' on '${branchName}'`);
      const diff = renderDiff(this.workspace, branch);
      this.log("propose_merge", `one-tap merge card emitted for '${branchName}'`);

      // (8)+(9) Record the verified fix with its temporal anchor so a recurrence
      // can be recalled (adaptation) or flagged as flapping (temporal).
      this.memory.record(fault.signature, {
        remedyKind: fault.kind,
        remedySummary: plan,
        lastOutcome: "verified",
        lastAt: this.memory.now(),
      });

      return { status: "merge_proposed", branch: branchName, diff, audit: this.audit };
    }

    return { status: "escalated", reason: "loop fell through", audit: this.audit };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers.
// ─────────────────────────────────────────────────────────────────────────

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function nextModel(m: ModelHealth): string | null {
  const idx = m.chain.indexOf(m.active);
  if (idx === -1) return m.chain[0] ?? null;
  return m.chain[idx + 1] ?? null;
}

/** Tiny structural diff so the merge card has something to show the human. */
function renderDiff(before: Workspace, after: Workspace): string {
  const lines: string[] = [];
  if (before.model.active !== after.model.active) {
    lines.push(`- model.active: ${before.model.active}\n+ model.active: ${after.model.active}`);
  }
  for (let i = 0; i < before.tools.length; i++) {
    if (before.tools[i]!.endpoint !== after.tools[i]!.endpoint) {
      lines.push(
        `- tools.${before.tools[i]!.name}.endpoint: ${before.tools[i]!.endpoint}\n` +
          `+ tools.${after.tools[i]!.name}.endpoint: ${after.tools[i]!.endpoint}`,
      );
    }
  }
  if (before.build.typechecks !== after.build.typechecks) {
    lines.push(`- build.typechecks: ${before.build.typechecks}\n+ build.typechecks: ${after.build.typechecks}`);
  }
  return lines.join("\n") || "(no structural change)";
}

// ─────────────────────────────────────────────────────────────────────────
// Demo.
// ─────────────────────────────────────────────────────────────────────────

function healthyWorkspace(): Workspace {
  return {
    model: {
      active: "agent-os:latest",
      chain: ["agent-os:latest", "groq:llama-3.3-70b", "cerebras:llama-3.3-70b", "gemini-2.5-flash"],
      emptyReplyRate: 0.02,
      p95LatencyMs: 1400,
    },
    tools: [
      { name: "web_search", endpoint: "https://api.search.v2/run", knownGoodEndpoint: "https://api.search.v2/run", errorRate: 0.01 },
      { name: "play_audio", endpoint: "https://media.example/play", knownGoodEndpoint: "https://media.example/v3/play", errorRate: 0.0 },
    ],
    build: { typechecks: true, firstError: null },
  };
}

function banner(title: string): void {
  console.log(`\n${"═".repeat(74)}\n  ${title}\n${"═".repeat(74)}`);
}

function printOutcome(o: RepairOutcome): void {
  for (const a of o.audit) {
    console.log(`  [${a.step.padEnd(13)}] ${a.detail}`);
  }
  console.log(`\n  ▶ outcome: ${o.status.toUpperCase()}`);
  if (o.status === "merge_proposed") {
    console.log(`    branch:  ${o.branch}`);
    console.log("    diff:");
    for (const l of o.diff.split("\n")) console.log(`      ${l}`);
  } else if (o.status === "reported" || o.status === "escalated") {
    console.log(`    reason:  ${o.reason}`);
  } else if (o.status === "self_corrected") {
    console.log(`    learned: ${o.note}`);
  }
}

function demo(): void {
  // Scenario 1 — the active model has started returning empty replies.
  banner("Scenario 1 — model degraded (empty replies) → request a new model");
  {
    const w = healthyWorkspace();
    w.model.emptyReplyRate = 0.65;
    w.model.p95LatencyMs = 9000;
    printOutcome(new SelfRepairLoop(w).run("User: 'you went quiet — nothing comes back when I ask.'"));
  }

  // Scenario 2 — a tool is calling a dead endpoint (service moved to /v3).
  banner("Scenario 2 — stale tool endpoint → behavior_fix repoint");
  {
    const w = healthyWorkspace();
    w.tools.find((t) => t.name === "play_audio")!.errorRate = 0.8;
    printOutcome(new SelfRepairLoop(w).run("User: 'music stopped working entirely.'"));
  }

  // Scenario 3 — the workspace stopped typechecking after a change.
  banner("Scenario 3 — build broken → branch, fix, verify, propose merge");
  {
    const w = healthyWorkspace();
    w.build.typechecks = false;
    w.build.firstError = "TS2345 in agent.ts: Argument of type 'string' not assignable to 'number'";
    printOutcome(new SelfRepairLoop(w).run("Self: typecheck probe flipped red after last edit."));
  }

  // Scenario 4 — only latency is elevated; everything else is fine.
  banner("Scenario 4 — weak signal (latency only) → report, do not act");
  {
    const w = healthyWorkspace();
    w.model.p95LatencyMs = 12000;
    printOutcome(new SelfRepairLoop(w).run("Self: latency probe elevated."));
  }

  // Scenario 5 — (8)+(9) shared memory across incidents: adaptation + flapping.
  banner("Scenario 5 — memory + temporal awareness across recurring faults");
  {
    const memory = new RepairMemory();
    let clock = Date.UTC(2026, 5, 13, 9, 0, 0);
    memory.now = () => clock;

    console.log("\n  ── 5a: first time this fault is seen → derive + fix ──");
    {
      const w = healthyWorkspace();
      w.tools.find((t) => t.name === "play_audio")!.errorRate = 0.8;
      printOutcome(new SelfRepairLoop(w, memory).run("User: 'music broke again.'"));
    }

    console.log("\n  ── 5b: SAME fault 2 minutes later → flapping → escalate ──");
    clock += 2 * 60 * 1000;
    {
      const w = healthyWorkspace();
      w.tools.find((t) => t.name === "play_audio")!.errorRate = 0.8;
      printOutcome(new SelfRepairLoop(w, memory).run("User: 'music broke AGAIN, right after.'"));
    }

    console.log("\n  ── 5c: same fault a day later → recall prior remedy, fix ──");
    clock += 24 * 60 * 60 * 1000;
    {
      const w = healthyWorkspace();
      w.tools.find((t) => t.name === "play_audio")!.errorRate = 0.8;
      printOutcome(new SelfRepairLoop(w, memory).run("User: 'music broke (new day).'"));
    }
  }

  // Scenario 6 — (10) behavioral metacognition: the agent catches its OWN
  // mistake mid-conversation and records a correction — no code, no branch.
  banner("Scenario 6 — behavioral metacognition → self-correct, remember, move on");
  {
    printOutcome(
      new SelfRepairLoop(healthyWorkspace()).selfCorrect({
        priorWrong: "called play_audio with end=30",
        correctionType: "api_argument_fix",
        correct: "omit end= so full songs are not truncated",
      }),
    );
  }

  // Scenario 7 — nothing is wrong.
  banner("Scenario 7 — healthy → no-op");
  {
    printOutcome(new SelfRepairLoop(healthyWorkspace()).run("User: 'are you okay?'"));
  }

  console.log("\nDone. Every code fix was applied on a agent/* branch and gated behind a");
  console.log("human merge; behaviour fixes became durable memories; recurring faults were");
  console.log("recalled, and a fix that did not hold was escalated, not retried forever.\n");
}

if (process.argv.includes("--demo")) {
  demo();
}

export { SelfRepairLoop, RepairMemory, diagnose, PROBES, REMEDIATIONS, CONFIDENCE_FLOOR, FLAP_COOLDOWN_MS };
export type { Workspace, Signal, FaultHypothesis, Remediation, RepairOutcome, SelfCorrection, MemoEntry };
