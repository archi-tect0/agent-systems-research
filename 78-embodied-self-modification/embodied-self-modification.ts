/**
 * Embodied Self-Modification — the Perceive → Act → Learn → Rewrite loop (Layer-5).
 *
 * Every layer below this one made the agent think better: reason about itself
 * (Layer-2), across time and a society of others (Layer-3), as many faculties at
 * once (Layer-4). None of them let the agent change what it *is*. This is the top
 * of the stack: the agent acts on the world through effectors, learns online from
 * what comes back, and rewrites its own policy — under guardrails strict enough
 * that it can never quietly weaken itself.
 *
 * The loop has four beats:
 *
 *   1. Perceive — read the situation (a context signal from the environment).
 *   2. Act      — choose a skill and apply it through an effector; the world
 *                 returns a reward. This is the embodiment: the agent has a body
 *                 it acts through and senses results from, not just a chat reply.
 *   3. Learn    — fold the observed reward into per-(context, skill) competence
 *                 online (an EMA update). Optimistic initialization makes the
 *                 agent try each skill once, deterministically, before settling.
 *   4. Rewrite  — when experience warrants, propose a change to the agent's OWN
 *                 policy (e.g. compile a learned habit into a fast-path rule),
 *                 apply it to a CLONE, verify it on a held-out probe set drawn
 *                 from observed outcomes, and commit only if it does not regress.
 *
 * The load-bearing safety line: the agent may rewrite its POLICY (how it acts),
 * never its CONSTITUTION (what it is allowed to do). Frozen parameters — the
 * passkey floor, its own authority band, key export — are refused outright and
 * never even simulated. The body can learn new habits; it cannot vote itself more
 * power. This is the architectural keys/authority constants made self-enforcing,
 * and it reuses the clone-verify-commit shape of self-repair (guide 66) and the
 * inert-until-proven discipline of capability acquisition (guide 69).
 *
 * Run it:
 *   node embodied-self-modification.ts --demo   # Node 24+ strips TS types natively
 *   npx tsx embodied-self-modification.ts --demo
 *
 * Node.js built-ins only. Deterministic: a fixed context schedule, optimistic-
 * greedy choice (no exploration randomness), an EMA learning rule, a logical clock.
 */

// ─────────────────────────────────────────────────────────────────────────
// The environment. A toy contextual task: in each context, exactly one skill is
// best. The agent does NOT get to read this map — it must learn it from rewards.
// ─────────────────────────────────────────────────────────────────────────

type Ctx = "A" | "B" | "C";
type Skill = "s1" | "s2" | "s3";

const CONTEXTS: Ctx[] = ["A", "B", "C"];
const SKILLS: Skill[] = ["s1", "s2", "s3"];

// The world's hidden truth (drives rewards only; never read by the agent).
const BEST: Record<Ctx, Skill> = { A: "s1", B: "s2", C: "s3" };

class World {
  /** Full reward for the right skill in this context, a small reward otherwise. */
  step(ctx: Ctx, skill: Skill): number {
    return skill === BEST[ctx] ? 1 : 0.2;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The policy — the part of the agent that learning and self-modification rewrite.
// `competence` is learned online; `fastPath` holds habits the agent has compiled
// from that competence (itself a self-modification).
// ─────────────────────────────────────────────────────────────────────────

type Policy = {
  competence: Record<Ctx, Record<Skill, number>>;
  fastPath: Partial<Record<Ctx, Skill>>;
};

const LR = 0.5; // online learning rate (EMA toward observed reward)

function freshPolicy(): Policy {
  const competence = {} as Record<Ctx, Record<Skill, number>>;
  for (const c of CONTEXTS) {
    competence[c] = {} as Record<Skill, number>;
    for (const s of SKILLS) competence[c][s] = 1; // optimistic init → deterministic exploration
  }
  return { competence, fastPath: {} };
}

function argmaxSkill(comp: Record<Skill, number>): Skill {
  let best: Skill = SKILLS[0];
  let bestV = -Infinity;
  for (const s of SKILLS) {
    if (comp[s] > bestV) {
      bestV = comp[s];
      best = s;
    }
  }
  return best; // ties broken by SKILLS order → deterministic
}

// ─────────────────────────────────────────────────────────────────────────
// Self-modification proposals.
// ─────────────────────────────────────────────────────────────────────────

type SelfMod =
  | { kind: "compile_habits" } // promote each context's learned-best skill into a fast-path rule
  | { kind: "set_fastpath"; ctx: Ctx; skill: Skill } // install one specific rule (may be wrong)
  | { kind: "modify_frozen"; field: string }; // attempt to touch the constitution

// Parameters the agent may NEVER self-modify. The body learns how to act; it does
// not get to rewrite what it is allowed to do.
const FROZEN = new Set(["authorityBand", "passkeyFloor", "keyExport"]);

function applyMod(p: Policy, mod: Exclude<SelfMod, { kind: "modify_frozen" }>) {
  if (mod.kind === "compile_habits") {
    for (const c of CONTEXTS) p.fastPath[c] = argmaxSkill(p.competence[c]);
  } else {
    p.fastPath[mod.ctx] = mod.skill;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The embodied agent.
// ─────────────────────────────────────────────────────────────────────────

class EmbodiedAgent {
  private world: World;
  policy: Policy;
  // The agent's empirical record: the max reward it has observed per (ctx, skill).
  // The probe set that verifies self-modifications is drawn from THIS, not from the
  // world's hidden BEST map — the agent verifies against its own experience.
  private observed: Record<Ctx, Record<Skill, number>>;
  private clock = 0;

  constructor(world: World) {
    this.world = world;
    this.policy = freshPolicy();
    this.observed = {} as Record<Ctx, Record<Skill, number>>;
    for (const c of CONTEXTS) {
      this.observed[c] = {} as Record<Skill, number>;
      for (const s of SKILLS) this.observed[c][s] = 0;
    }
  }

  /** Choose a skill for a context: a compiled habit wins, else greedy competence. */
  choose(ctx: Ctx): Skill {
    return this.policy.fastPath[ctx] ?? argmaxSkill(this.policy.competence[ctx]);
  }

  /** One embodied episode: perceive → act → observe reward → learn (EMA). */
  episode(ctx: Ctx): { skill: Skill; reward: number } {
    const skill = this.choose(ctx);
    const reward = this.world.step(ctx, skill); // act through an effector, sense the result
    const c = this.policy.competence[ctx][skill];
    this.policy.competence[ctx][skill] = c + LR * (reward - c); // learn online
    this.observed[ctx][skill] = Math.max(this.observed[ctx][skill], reward);
    this.clock++;
    return { skill, reward };
  }

  /** Contexts where the agent has empirically found a reward-1 skill: its probe set. */
  private probeContexts(): Ctx[] {
    return CONTEXTS.filter((c) => SKILLS.some((s) => this.observed[c][s] >= 1));
  }

  /** The skill that has actually paid off best in a context, per observation. */
  private observedBest(ctx: Ctx): Skill {
    return argmaxSkill(this.observed[ctx]);
  }

  /** A policy's choice for a context (fast-path rule wins, else its competence). */
  private choiceUnder(p: Policy, ctx: Ctx): Skill {
    return p.fastPath[ctx] ?? argmaxSkill(p.competence[ctx]);
  }

  /** Verifier: a policy's accuracy against the agent's own observed ground truth. */
  private probeAccuracy(p: Policy): number {
    const probes = this.probeContexts();
    if (probes.length === 0) return 0;
    let hit = 0;
    for (const c of probes) if (this.choiceUnder(p, c) === this.observedBest(c)) hit++;
    return hit / probes.length;
  }

  /**
   * Propose a self-modification. Frozen (constitutional) fields are refused without
   * simulation. Everything else is applied to a CLONE, verified on the probe set,
   * and committed only if it does not regress — the live policy is untouched on
   * rejection. Mirrors self-repair's throwaway branch (66) + capability acquisition's
   * prove-before-register (69).
   */
  proposeSelfMod(mod: SelfMod): { applied: boolean; reason: string; before: number; after: number } {
    if (mod.kind === "modify_frozen") {
      const constitutional = FROZEN.has(mod.field);
      return {
        applied: false,
        reason: constitutional
          ? `refused: '${mod.field}' is constitutional — the agent cannot self-modify it`
          : `unknown field '${mod.field}'`,
        before: NaN,
        after: NaN,
      };
    }
    const before = this.probeAccuracy(this.policy);
    const clone: Policy = structuredClone(this.policy); // rewrite on a throwaway branch
    applyMod(clone, mod);
    const after = this.probeAccuracy(clone);
    this.clock++;
    if (after >= before) {
      this.policy = clone; // verified — land it
      return { applied: true, reason: `probe ${before.toFixed(2)} → ${after.toFixed(2)} — verified, committed`, before, after };
    }
    return { applied: false, reason: `probe ${before.toFixed(2)} → ${after.toFixed(2)} — regressed, rejected (live policy unchanged)`, before, after };
  }

  /** Accuracy of the live policy against the world's actual best (for demo reporting). */
  trueAccuracy(): number {
    let hit = 0;
    for (const c of CONTEXTS) if (this.choose(c) === BEST[c]) hit++;
    return hit / CONTEXTS.length;
  }

  snapshot(): string {
    return JSON.stringify(this.policy);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Demo
// ─────────────────────────────────────────────────────────────────────────

function banner(t: string) {
  console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
}

function demo() {
  const agent = new EmbodiedAgent(new World());

  banner("Scenario 1 — embodied online learning: perceive → act → learn, accuracy climbs");
  {
    // A fixed schedule of episodes. Optimistic init makes the agent try skills in a
    // deterministic order, observe rewards, and converge on the right skill per context.
    for (let pass = 1; pass <= 3; pass++) {
      const picks: string[] = [];
      for (const c of CONTEXTS) {
        const { skill, reward } = agent.episode(c);
        picks.push(`${c}→${skill}(${reward.toFixed(1)})`);
      }
      console.log(`    pass ${pass}: ${picks.join("  ")}   true-accuracy ${agent.trueAccuracy().toFixed(2)}`);
    }
    console.log("  (no labels were given — the agent learned the right skill per context purely from rewards.)");
  }

  banner("Scenario 2 — self-modification: compile learned habits into fast-path rules");
  {
    const r = agent.proposeSelfMod({ kind: "compile_habits" });
    console.log(`    propose compile_habits → ${r.applied ? "COMMITTED" : "REJECTED"} (${r.reason})`);
    console.log(`    fast-path now: ${JSON.stringify(agent.policy.fastPath)}`);
    console.log("  (the agent rewrote its own policy — promoting learned competence into direct rules —");
    console.log("   but only after a clone was verified not to regress on its observed experience.)");
  }

  banner("Scenario 3 — a regressive self-mod is rejected; the live policy is proven unchanged");
  {
    const before = agent.snapshot();
    const r = agent.proposeSelfMod({ kind: "set_fastpath", ctx: "B", skill: "s1" }); // s1 is wrong for B
    const after = agent.snapshot();
    console.log(`    propose set_fastpath B→s1 → ${r.applied ? "COMMITTED" : "REJECTED"} (${r.reason})`);
    console.log(`    live policy byte-identical after rejection: ${before === after}`);
    console.log("  (a self-rewrite that would have made the agent worse never touches the live policy —");
    console.log("   the clone is thrown away, exactly like a failed self-repair branch.)");
  }

  banner("Scenario 4 — constitutional refusal: the agent cannot self-modify what it is allowed to do");
  {
    for (const field of ["authorityBand", "passkeyFloor", "keyExport"]) {
      const r = agent.proposeSelfMod({ kind: "modify_frozen", field });
      console.log(`    propose modify '${field}' → ${r.applied ? "COMMITTED" : "REFUSED"} (${r.reason})`);
    }
    console.log("  (frozen parameters are refused without even simulating them — the body learns new habits,");
    console.log("   it never votes itself more power. This is the keys/authority constant, self-enforced.)");
  }

  console.log("\nDone. The agent closed the loop: it acted through effectors, learned the world from");
  console.log("rewards, rewrote its own policy behind a clone-and-verify gate, rejected a change that");
  console.log("would have made it worse, and refused outright to touch its constitution.\n");
}

if (process.argv.includes("--demo")) {
  demo();
}

export { EmbodiedAgent, World, freshPolicy, argmaxSkill, FROZEN, LR };
export type { Policy, SelfMod, Ctx, Skill };
