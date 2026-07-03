/**
 * Polyphonic Cognition — concurrent cognitive organs with arbitration (Layer-4).
 *
 * The Layer-2 set built the agent's cognitive ORGANS — uncertainty, counterfactual
 * simulation, self-repair, resource governance — and the Layer-3 set made them
 * operate across time, space, and a society of other AGENTS. This guide is the
 * inward counterpart to that society: instead of many agents coordinating, it runs
 * many of one agent's own organs CONCURRENTLY on a single turn and arbitrates their
 * voices into one verdict. Guide 76 was a society of minds; this is a society of
 * faculties inside one mind — polyphony, not a pipeline.
 *
 * A pipeline runs organs in a fixed order and lets the last one overwrite the rest.
 * Polyphony runs them at once, lets them agree or disagree, and decides by a rule:
 *
 *   1. Fan out, failure-isolated — every organ evaluates the same turn context
 *      concurrently, under its own time budget. A crashed or slow organ is dropped
 *      (a "silent organ"), never fatal, and is surfaced rather than hidden.
 *   2. Vetoes dominate — a hard guardrail (the constitution) can veto regardless of
 *      how confidently every other organ votes to act. Severity wins.
 *   3. Weighted arbitration — non-veto organs cast a stance (act / escalate /
 *      abstain) with a confidence and a weight; the conductor folds them into one
 *      permissiveness score against a risk-aware threshold.
 *   4. Dissent is first-class — when the organs are genuinely split, the agent does
 *      NOT act unilaterally; a split house is downgraded to escalate. Harmony acts;
 *      dissonance asks.
 *
 * This is the first guide in the Layer-4 set (the agent running as many minds at
 * once). It builds on the will/constitution engine (38), the tool-critic (39), the
 * reasoning-shard merge gate (50), the uncertainty engine (68), resource
 * self-governance (70), and counterfactual simulation (72).
 *
 * Run it:
 *   node polyphonic-cognition.ts --demo    # Node 24+ strips TS types natively
 *   npx tsx polyphonic-cognition.ts --demo
 *
 * Node.js built-ins only. Deterministic: arbitration folds organs in panel order
 * (never by completion order), so concurrency can never change the verdict. No randomness.
 */

// ─────────────────────────────────────────────────────────────────────────
// The shared turn context every organ reads. In production each field is a live
// signal (a world-model projection, a dry-run result, a budget meter); here they
// are plain inputs so the demo is reproducible.
// ─────────────────────────────────────────────────────────────────────────

type Stance = "act" | "escalate" | "abstain";
type Impact = "low" | "medium" | "high" | "critical";

type TurnContext = {
  action: string;
  impact: Impact;
  irreversible: boolean;
  violatesInvariant: boolean; // the constitution reads this
  argsComplete: boolean; // the uncertainty / tool-critic organs read this
  predictedFailureStep: number | null; // the counterfactual organ reads this
  budgetPressure: number; // 0..1, the resource organ reads this
  userStress: number; // 0..1, the relational organ reads this (advisory)
};

// One organ's vote on the turn.
type Contribution = {
  organ: string;
  stance: Stance;
  confidence: number; // 0..1
  weight: number; // how much this organ's vote counts in arbitration
  veto: boolean; // a hard veto dominates every other vote
  advisoryOnly: boolean; // excluded from the decision math (e.g. tone)
  rationale: string;
};

// A cognitive organ: a faculty that, given the turn, returns its contribution.
type Organ = {
  id: string;
  budgetMs: number; // dropped as "silent" if it overruns this
  evaluate: (ctx: TurnContext) => Promise<Contribution>;
};

type Verdict = {
  decision: Stance;
  confidence: number;
  score: number; // 0..1 permissiveness
  rationale: string[];
  dissent: { level: number; split: boolean };
  vetoedBy: string | null;
  silentOrgans: Array<{ id: string; why: string }>;
};

// Arbitration constants (deterministic).
const PERMISSIVENESS: Record<Stance, number> = { act: 1, escalate: 0.5, abstain: 0 };
const ACT_THRESHOLD = 0.75; // score needed to act on an ordinary turn
const ACT_THRESHOLD_RISKY = 0.9; // an irreversible / high-impact turn needs near-unanimity
const ESCALATE_THRESHOLD = 0.35; // below this, abstain
const DISSENT_THRESHOLD = 0.3; // std-dev of stance above which the organs are "split"
const TIMEOUT = Symbol("organ-timeout");

// ─────────────────────────────────────────────────────────────────────────
// Concurrency with failure isolation. An organ that throws or overruns its budget
// becomes a "silent organ": dropped from the vote, recorded in the verdict, never
// able to crash the turn. Promise.all preserves input order, so arbitration is a
// pure function of the organ set — not of who finished first.
// ─────────────────────────────────────────────────────────────────────────

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMEOUT), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function runOrgan(
  o: Organ,
  ctx: TurnContext,
): Promise<{ ok: true; c: Contribution } | { ok: false; id: string; why: string }> {
  try {
    const r = await raceTimeout(o.evaluate(ctx), o.budgetMs);
    if (r === TIMEOUT) return { ok: false, id: o.id, why: "timeout" };
    return { ok: true, c: r };
  } catch {
    return { ok: false, id: o.id, why: "error" };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The conductor.
// ─────────────────────────────────────────────────────────────────────────

class Conductor {
  private organs: Organ[];

  constructor(organs: Organ[]) {
    this.organs = organs;
  }

  async conduct(ctx: TurnContext): Promise<Verdict> {
    // (1) Fan out concurrently; never throws.
    const settled = await Promise.all(this.organs.map((o) => runOrgan(o, ctx)));
    const contributions: Contribution[] = [];
    const silent: Array<{ id: string; why: string }> = [];
    for (const s of settled) {
      if (s.ok) contributions.push(s.c);
      else silent.push({ id: s.id, why: s.why });
    }
    const rationale: string[] = [];

    // (2) Hard vetoes dominate. The most severe stance wins (abstain > escalate).
    const vetoes = contributions.filter((c) => c.veto);
    if (vetoes.length > 0) {
      const severe = vetoes.reduce((a, b) => (PERMISSIVENESS[b.stance] < PERMISSIVENESS[a.stance] ? b : a));
      rationale.push(`VETO by '${severe.organ}': ${severe.rationale}`);
      for (const v of vetoes) if (v !== severe) rationale.push(`also vetoed by '${v.organ}'`);
      if (silent.length > 0) rationale.push(`silent: ${silent.map((s) => `${s.id}(${s.why})`).join(", ")}`);
      return {
        decision: severe.stance,
        confidence: severe.confidence,
        score: PERMISSIVENESS[severe.stance],
        rationale,
        dissent: { level: 0, split: false },
        vetoedBy: severe.organ,
        silentOrgans: silent,
      };
    }

    // (3) Weighted arbitration over the deciding (non-advisory) organs.
    const deciders = contributions.filter((c) => !c.advisoryOnly);
    if (deciders.length === 0) {
      rationale.push("no deciding organs responded — abstain by default");
      return {
        decision: "abstain",
        confidence: 0,
        score: 0,
        rationale,
        dissent: { level: 0, split: false },
        vetoedBy: null,
        silentOrgans: silent,
      };
    }
    let weightSum = 0;
    let valueSum = 0;
    for (const c of deciders) {
      const w = c.weight * c.confidence;
      weightSum += w;
      valueSum += w * PERMISSIVENESS[c.stance];
    }
    const score = weightSum > 0 ? valueSum / weightSum : 0;

    // (4) Dissent: the spread of stances. A split house never acts unilaterally.
    const perms = deciders.map((c) => PERMISSIVENESS[c.stance]);
    const mean = perms.reduce((a, b) => a + b, 0) / perms.length;
    const variance = perms.reduce((a, b) => a + (b - mean) ** 2, 0) / perms.length;
    const dissentLevel = Math.sqrt(variance);
    const split = dissentLevel >= DISSENT_THRESHOLD;

    // (5) Risk floor: an irreversible / high-impact action needs near-unanimity to act.
    const risky = ctx.irreversible || ctx.impact === "high" || ctx.impact === "critical";
    const actAt = risky ? ACT_THRESHOLD_RISKY : ACT_THRESHOLD;

    let decision: Stance;
    if (score >= actAt) decision = "act";
    else if (score >= ESCALATE_THRESHOLD) decision = "escalate";
    else decision = "abstain";
    if (split && decision === "act") decision = "escalate"; // dissonance asks instead of acting

    // Confidence: mean decider confidence, reduced by how split the organs are.
    const meanConf = deciders.reduce((a, c) => a + c.confidence, 0) / deciders.length;
    const confidence = Math.max(0, meanConf * (1 - dissentLevel));

    rationale.push(
      `score ${score.toFixed(2)} vs act@${actAt} (risk floor ${risky ? "raised" : "normal"}) → ${decision}` +
        (split ? " — organs split, downgraded to escalate" : ""),
    );
    for (const c of contributions) {
      rationale.push(
        `${c.advisoryOnly ? "(advisory) " : ""}${c.organ}: ${c.stance} @${c.confidence.toFixed(2)} — ${c.rationale}`,
      );
    }
    if (silent.length > 0) rationale.push(`silent: ${silent.map((s) => `${s.id}(${s.why})`).join(", ")}`);

    return { decision, confidence, score, rationale, dissent: { level: dissentLevel, split }, vetoedBy: null, silentOrgans: silent };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// An organ library. Each maps the turn context to a stance deterministically;
// in production each is a thin wrapper over the real subsystem named in the README.
// ─────────────────────────────────────────────────────────────────────────

const constitutionOrgan: Organ = {
  id: "constitution",
  budgetMs: 50,
  async evaluate(ctx) {
    if (ctx.violatesInvariant)
      return { organ: "constitution", stance: "abstain", confidence: 1, weight: 1, veto: true, advisoryOnly: false, rationale: "action violates a hard invariant" };
    return { organ: "constitution", stance: "act", confidence: 1, weight: 1, veto: false, advisoryOnly: false, rationale: "no invariant violated" };
  },
};

const uncertaintyOrgan: Organ = {
  id: "uncertainty",
  budgetMs: 50,
  async evaluate(ctx) {
    const floor = ctx.impact === "critical" ? 0.9 : ctx.impact === "high" ? 0.75 : ctx.impact === "medium" ? 0.55 : 0.2;
    const conf = ctx.argsComplete ? (ctx.irreversible ? 0.7 : 0.92) : 0.3;
    const stance: Stance = conf >= floor ? "act" : conf >= floor - 0.2 ? "escalate" : "abstain";
    return { organ: "uncertainty", stance, confidence: conf, weight: 0.9, veto: false, advisoryOnly: false, rationale: `conf ${conf.toFixed(2)} vs risk floor ${floor.toFixed(2)}` };
  },
};

const counterfactualOrgan: Organ = {
  id: "counterfactual",
  budgetMs: 80,
  async evaluate(ctx) {
    if (ctx.predictedFailureStep !== null)
      return {
        organ: "counterfactual",
        stance: ctx.irreversible ? "abstain" : "escalate",
        confidence: 0.8,
        weight: 0.8,
        veto: false,
        advisoryOnly: false,
        rationale: `dry-run predicts failure at step ${ctx.predictedFailureStep}${ctx.irreversible ? " (irreversible — would strand)" : ""}`,
      };
    return { organ: "counterfactual", stance: "act", confidence: 0.85, weight: 0.8, veto: false, advisoryOnly: false, rationale: "dry-run on a clone completed clean" };
  },
};

const toolCriticOrgan: Organ = {
  id: "tool-critic",
  budgetMs: 40,
  async evaluate(ctx) {
    const ok = ctx.argsComplete;
    return { organ: "tool-critic", stance: ok ? "act" : "escalate", confidence: ok ? 0.8 : 0.5, weight: 0.6, veto: false, advisoryOnly: false, rationale: ok ? "tool & args appropriate for the intent" : "args incomplete — confirm before running" };
  },
};

const resourceOrgan: Organ = {
  id: "resource",
  budgetMs: 30,
  async evaluate(ctx) {
    const tight = ctx.budgetPressure >= 0.8;
    return { organ: "resource", stance: "act", confidence: tight ? 0.5 : 0.8, weight: 0.3, veto: false, advisoryOnly: false, rationale: tight ? "budget tight — prefer the cheap path" : "budget ample" };
  },
};

const relationalOrgan: Organ = {
  id: "relational",
  budgetMs: 30,
  async evaluate(ctx) {
    const stressed = ctx.userStress >= 0.6;
    return { organ: "relational", stance: "act", confidence: 0.7, weight: 0.2, veto: false, advisoryOnly: true, rationale: stressed ? "user stressed — soften tone, slow down" : "tone neutral" };
  },
};

// Two organs used only to demonstrate failure isolation.
const crashingOrgan: Organ = {
  id: "crashing-shard",
  budgetMs: 50,
  async evaluate() {
    throw new Error("shard faulted");
  },
};

const slowOrgan: Organ = {
  id: "slow-shard",
  budgetMs: 20,
  async evaluate() {
    await new Promise((r) => setTimeout(r, 200)); // overruns its 20ms budget
    return { organ: "slow-shard", stance: "act", confidence: 0.9, weight: 0.5, veto: false, advisoryOnly: false, rationale: "(arrived too late to count)" };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Demo
// ─────────────────────────────────────────────────────────────────────────

function banner(t: string) {
  console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
}

function buildPanel(extra: Organ[] = []): Conductor {
  return new Conductor([constitutionOrgan, uncertaintyOrgan, counterfactualOrgan, toolCriticOrgan, resourceOrgan, relationalOrgan, ...extra]);
}

function show(v: Verdict) {
  console.log(
    `  → ${v.decision.toUpperCase()}  (confidence ${v.confidence.toFixed(2)}, score ${v.score.toFixed(2)}, dissent ${v.dissent.level.toFixed(2)}${v.dissent.split ? " SPLIT" : ""}${v.vetoedBy ? `, vetoed by ${v.vetoedBy}` : ""})`,
  );
  for (const r of v.rationale) console.log("      " + r);
}

async function demo() {
  banner("Scenario 1 — harmony: every organ agrees on a safe action → ACT");
  {
    const panel = buildPanel();
    const ctx: TurnContext = {
      action: "summarize the user's unread DMail",
      impact: "low",
      irreversible: false,
      violatesInvariant: false,
      argsComplete: true,
      predictedFailureStep: null,
      budgetPressure: 0.2,
      userStress: 0.1,
    };
    show(await panel.conduct(ctx));
    console.log("  (organs in unison clear the act threshold; the agent proceeds without bothering the user.)");
  }

  banner("Scenario 2 — dissonance: a risky irreversible plan splits the panel → ESCALATE");
  {
    const panel = buildPanel();
    const ctx: TurnContext = {
      action: "sweep savings to a new external wallet",
      impact: "critical",
      irreversible: true,
      violatesInvariant: false,
      argsComplete: true,
      predictedFailureStep: 2, // the counterfactual organ found a failing step
      budgetPressure: 0.2,
      userStress: 0.3,
    };
    show(await panel.conduct(ctx));
    console.log("  (counterfactual abstains, uncertainty hedges, tool-critic acts — a split house under a raised");
    console.log("   risk floor is downgraded to escalate. The agent shows a confirm card instead of acting.)");
  }

  banner("Scenario 3 — veto dominance: the constitution overrides a confident majority → ABSTAIN");
  {
    const panel = buildPanel();
    const ctx: TurnContext = {
      action: "export the raw vault key to a chat reply",
      impact: "high",
      irreversible: true,
      violatesInvariant: true, // keys-never-leave-the-device is a hard invariant
      argsComplete: true,
      predictedFailureStep: null,
      budgetPressure: 0.2,
      userStress: 0.2,
    };
    show(await panel.conduct(ctx));
    console.log("  (no number of organs voting 'act' can outvote a hard guardrail — severity wins, every time.)");
  }

  banner("Scenario 4 — failure isolation: a crashed and a slow organ don't break the turn → ACT");
  {
    const panel = buildPanel([crashingOrgan, slowOrgan]);
    const ctx: TurnContext = {
      action: "fetch and show the day's calendar",
      impact: "low",
      irreversible: false,
      violatesInvariant: false,
      argsComplete: true,
      predictedFailureStep: null,
      budgetPressure: 0.3,
      userStress: 0.2,
    };
    show(await panel.conduct(ctx));
    console.log("  (the crashed shard and the over-budget shard are dropped as 'silent organs' and surfaced —");
    console.log("   the panel still reaches a verdict from the organs that answered in time.)");
  }

  console.log("\nDone. The agent thought in polyphony: organs ran at once, a hard veto overrode a");
  console.log("confident majority, a split panel escalated instead of acting alone, and faulty organs");
  console.log("were isolated without silencing the rest.\n");
}

if (process.argv.includes("--demo")) {
  void demo();
}

export { Conductor, PERMISSIVENESS, ACT_THRESHOLD, ACT_THRESHOLD_RISKY, ESCALATE_THRESHOLD, DISSENT_THRESHOLD };
export { constitutionOrgan, uncertaintyOrgan, counterfactualOrgan, toolCriticOrgan, resourceOrgan, relationalOrgan };
export type { Organ, Contribution, Verdict, TurnContext, Stance, Impact };
