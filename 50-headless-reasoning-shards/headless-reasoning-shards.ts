/**
 * Headless Read-Only Reasoning Shards
 *
 * A parent reasoner spawns disposable, time-boxed worker shards. Each shard is
 * restricted to read-only tools and must return strict JSON carrying a
 * confidence score and conflict_flags. The parent runs several shards in
 * parallel (e.g. a proposer and a dissent reviewer), then applies a merge gate
 * that detects disagreement between branches and withholds a confident answer
 * when they conflict — all WITHOUT widening the write surface.
 *
 * Pure built-ins: Promise + setTimeout for time-boxing.
 */

// ── Roles (no enum: 'as const' object + union type) ─────────────────────────

export const SHARD_ROLE = {
  proposer: "proposer",
  dissent_reviewer: "dissent_reviewer",
  analyst: "analyst",
} as const;

export type ShardRole = (typeof SHARD_ROLE)[keyof typeof SHARD_ROLE];

/** The strict result contract every shard must satisfy. */
export interface ShardResult {
  role: ShardRole;
  answer: string;
  confidence: number; // 0..1
  conflict_flags: string[];
  recommendation: string;
}

export interface ShardOutcome {
  role: ShardRole;
  status: "ok" | "schema_violation" | "timeout" | "error";
  result?: ShardResult;
  error?: string;
  elapsedMs: number;
}

/**
 * A reasoner is a pluggable async function. In production this wraps a model
 * call; in the demo it is a deterministic stub. It is NEVER given write tools —
 * the parent only ever reads its JSON output.
 */
export type Reasoner = (
  role: ShardRole,
  task: Record<string, unknown>,
  readOnlyTools: ReadonlyArray<string>,
) => Promise<unknown>;

export interface ShardSpec {
  role: ShardRole;
  task: Record<string, unknown>;
  ttlMs: number;
  /** Read-only tool whitelist surfaced to the reasoner. Never includes writes. */
  readOnlyTools: ReadonlyArray<string>;
}

const READ_ONLY_DEFAULT = ["web_search", "web_fetch", "recall_memory", "show_code"] as const;

/** Reject any tool name that looks like a write. Belt-and-suspenders. */
function assertReadOnly(tools: ReadonlyArray<string>): void {
  const writeish = /(write|send|delete|update|create|sign|transfer|anchor|arm|mint)/i;
  for (const t of tools) {
    if (writeish.test(t)) {
      throw new Error(`shard tool whitelist contains a write-capable tool: ${t}`);
    }
  }
}

/** Validate the strict JSON contract without pulling in a schema library. */
function validateResult(value: unknown, role: ShardRole): ShardResult | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "result is not an object";
  }
  const o = value as Record<string, unknown>;
  if (typeof o["answer"] !== "string") return "answer must be string";
  if (typeof o["confidence"] !== "number") return "confidence must be number";
  if ((o["confidence"] as number) < 0 || (o["confidence"] as number) > 1) {
    return "confidence must be within 0..1";
  }
  if (!Array.isArray(o["conflict_flags"])) return "conflict_flags must be array";
  if (typeof o["recommendation"] !== "string") return "recommendation must be string";
  return {
    role,
    answer: o["answer"] as string,
    confidence: o["confidence"] as number,
    conflict_flags: (o["conflict_flags"] as unknown[]).map(String),
    recommendation: o["recommendation"] as string,
  };
}

/** Run a single shard, racing the reasoner against its TTL. */
export async function runShard(spec: ShardSpec, reasoner: Reasoner): Promise<ShardOutcome> {
  assertReadOnly(spec.readOnlyTools);
  const start = Date.now();

  const timeout = new Promise<"__timeout__">((resolve) =>
    setTimeout(() => resolve("__timeout__"), spec.ttlMs),
  );

  try {
    const raw = await Promise.race([
      reasoner(spec.role, spec.task, spec.readOnlyTools),
      timeout,
    ]);

    if (raw === "__timeout__") {
      return { role: spec.role, status: "timeout", elapsedMs: Date.now() - start };
    }

    const validated = validateResult(raw, spec.role);
    if (typeof validated === "string") {
      return {
        role: spec.role,
        status: "schema_violation",
        error: validated,
        elapsedMs: Date.now() - start,
      };
    }
    return { role: spec.role, status: "ok", result: validated, elapsedMs: Date.now() - start };
  } catch (err) {
    return {
      role: spec.role,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - start,
    };
  }
}

export interface MergeDecision {
  confident: boolean;
  answer: string | null;
  reason: string;
  agreeingShards: number;
  conflicts: string[];
  discarded: Array<{ role: ShardRole; status: string }>;
}

export interface MergeOptions {
  /** Minimum confidence for a usable shard. */
  minConfidence: number;
  /** Below this similarity, two answers count as disagreeing. */
  agreementThreshold: number;
}

const DEFAULT_MERGE: MergeOptions = { minConfidence: 0.6, agreementThreshold: 0.5 };

/** Cheap token-overlap similarity (Jaccard over lowercased word sets). */
function similarity(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));
  const A = toks(a);
  const B = toks(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * The merge gate. Takes all shard outcomes and decides whether the parent may
 * emit a confident answer. It withholds confidence when branches disagree or
 * when any shard raised conflict_flags. It never produces a write — only a
 * judgement the parent reasoner can act on.
 */
export function mergeGate(
  outcomes: ShardOutcome[],
  opts: MergeOptions = DEFAULT_MERGE,
): MergeDecision {
  const discarded = outcomes
    .filter((o) => o.status !== "ok")
    .map((o) => ({ role: o.role, status: o.status }));

  const usable = outcomes
    .filter((o) => o.status === "ok" && o.result)
    .map((o) => o.result as ShardResult)
    .filter((r) => r.confidence >= opts.minConfidence);

  const raisedFlags = outcomes
    .filter((o) => o.status === "ok" && o.result && o.result.conflict_flags.length > 0)
    .flatMap((o) => (o.result as ShardResult).conflict_flags);

  if (usable.length === 0) {
    return {
      confident: false,
      answer: null,
      reason: "no shard returned a usable, sufficiently-confident result",
      agreeingShards: 0,
      conflicts: raisedFlags,
      discarded,
    };
  }

  // A dissent reviewer that blocks/objects forces caution regardless of score.
  const dissent = usable.find((r) => r.role === SHARD_ROLE.dissent_reviewer);
  const proposers = usable.filter((r) => r.role !== SHARD_ROLE.dissent_reviewer);

  // Detect pairwise disagreement among the substantive answers.
  const answers = usable.map((r) => r.answer);
  let minSim = 1;
  for (let i = 0; i < answers.length; i++) {
    for (let j = i + 1; j < answers.length; j++) {
      minSim = Math.min(minSim, similarity(answers[i], answers[j]));
    }
  }
  const disagree = answers.length > 1 && minSim < opts.agreementThreshold;

  if (raisedFlags.length > 0 || disagree) {
    return {
      confident: false,
      answer: null,
      reason: disagree
        ? "parallel branches disagree — withholding a confident answer"
        : "a shard raised conflict_flags — withholding a confident answer",
      agreeingShards: 0,
      conflicts: raisedFlags,
      discarded,
    };
  }

  if (dissent && dissent.recommendation.toLowerCase().includes("block")) {
    return {
      confident: false,
      answer: null,
      reason: "dissent reviewer recommends blocking",
      agreeingShards: usable.length,
      conflicts: raisedFlags,
      discarded,
    };
  }

  const chosen = (proposers[0] ?? usable[0]).answer;
  return {
    confident: true,
    answer: chosen,
    reason: "branches agree and no conflicts were flagged",
    agreeingShards: usable.length,
    conflicts: [],
    discarded,
  };
}

/** Spawn all shards in parallel and run the merge gate over the results. */
export async function reasonInParallel(
  specs: ShardSpec[],
  reasoner: Reasoner,
  opts?: MergeOptions,
): Promise<{ outcomes: ShardOutcome[]; decision: MergeDecision }> {
  const outcomes = await Promise.all(specs.map((s) => runShard(s, reasoner)));
  const decision = mergeGate(outcomes, opts);
  return { outcomes, decision };
}

// ── Demo ────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  // Stub reasoner: deterministic, no network. Two shards disagree; one hangs
  // past its TTL so it gets discarded by the time-box.
  const stubReasoner: Reasoner = (role, _task) => {
    if (role === SHARD_ROLE.proposer) {
      return Promise.resolve({
        answer: "Deploy the patch now; the regression is in the cache layer.",
        confidence: 0.82,
        conflict_flags: [],
        recommendation: "Ship the cache-layer fix.",
      });
    }
    if (role === SHARD_ROLE.dissent_reviewer) {
      return Promise.resolve({
        answer: "Do not deploy; the evidence points at the auth layer, not cache.",
        confidence: 0.78,
        conflict_flags: ["proposer attributes regression to cache without a stack trace"],
        recommendation: "Block deploy until the auth hypothesis is ruled out.",
      });
    }
    // analyst shard hangs forever -> hits TTL and is discarded.
    return new Promise(() => {});
  };

  const specs: ShardSpec[] = [
    { role: SHARD_ROLE.proposer, task: { issue: "checkout 500s" }, ttlMs: 200, readOnlyTools: READ_ONLY_DEFAULT },
    { role: SHARD_ROLE.dissent_reviewer, task: { issue: "checkout 500s" }, ttlMs: 200, readOnlyTools: READ_ONLY_DEFAULT },
    { role: SHARD_ROLE.analyst, task: { issue: "checkout 500s" }, ttlMs: 100, readOnlyTools: READ_ONLY_DEFAULT },
  ];

  reasonInParallel(specs, stubReasoner)
    .then(({ outcomes, decision }) => {
      console.log("=== Shard outcomes ===");
      for (const o of outcomes) {
        const conf = o.result ? ` conf=${o.result.confidence}` : "";
        console.log(`  ${o.role}: ${o.status}${conf} (${o.elapsedMs}ms)`);
      }

      console.log("\n=== Merge gate decision ===");
      console.log("confident:", decision.confident);
      console.log("answer:", decision.answer);
      console.log("reason:", decision.reason);
      if (decision.conflicts.length) {
        console.log("conflict_flags:");
        for (const c of decision.conflicts) console.log("  -", c);
      }
      if (decision.discarded.length) {
        console.log("discarded shards:");
        for (const d of decision.discarded) console.log(`  - ${d.role}: ${d.status}`);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
