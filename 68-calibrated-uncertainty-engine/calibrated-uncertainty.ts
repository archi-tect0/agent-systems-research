/**
 * Calibrated Uncertainty Engine — reference implementation.
 *
 * An agent that always sounds equally sure is useless at the two moments that
 * matter: when it should hedge, and when it should refuse. This module gives the
 * agent a single honest number per claim — a CALIBRATED confidence — and a
 * policy that turns that number into one of three actions: act, escalate, or
 * abstain. The number is honest because it is checked against reality over time:
 * predictions are scored (Brier), bucketed, and the raw model confidence is bent
 * toward what actually happened so a "0.9" comes to mean "right ~90% of the time".
 *
 * The four pieces:
 *
 *   1. Evidence -> raw confidence — combine independent factors (source
 *      agreement, recency, prior reliability, sample size) into one prior.
 *   2. Calibration map            — learned from (predicted, outcome) history;
 *      corrects systematic over/under-confidence per confidence bin.
 *   3. Decision policy            — calibrated confidence vs a PER-RISK floor:
 *      a wallet send needs more certainty than a music recommendation.
 *   4. Scoring                    — Brier score + reliability so you can SEE
 *      whether the numbers are getting more honest, not just more numerous.
 *
 * The load-bearing idea: confidence is not vibes. It is a measurable claim about
 * a future hit rate, and an agent that tracks its own Brier score can notice "I
 * am systematically overconfident about endpoints" and correct for it.
 *
 * Run it:
 *   node calibrated-uncertainty.ts --demo     # Node 24+ strips TS types natively
 *   npx tsx calibrated-uncertainty.ts --demo
 *
 * Node.js built-ins only. No network. The history is an in-memory array.
 */

// ─────────────────────────────────────────────────────────────────────────
// (1) Evidence -> raw confidence.
//
// Each factor is a number in [0,1] with a weight. We combine them as a
// weighted geometric mean rather than an arithmetic one: a single near-zero
// factor (e.g. "no corroborating source") should drag the whole thing down,
// not be averaged away by three confident-but-irrelevant factors.
// ─────────────────────────────────────────────────────────────────────────

type Evidence = {
  /** Fraction of independent sources/shards that agree, in [0,1]. */
  sourceAgreement: number;
  /** Freshness of the supporting data, in [0,1] (1 = just observed). */
  recency: number;
  /** This agent's historical hit rate on THIS kind of claim, in [0,1]. */
  priorReliability: number;
  /** How much evidence backs it, in [0,1] (1 = many corroborating samples). */
  sampleStrength: number;
};

const FACTOR_WEIGHTS: Record<keyof Evidence, number> = {
  sourceAgreement: 1.0,
  recency: 0.6,
  priorReliability: 1.2,
  sampleStrength: 0.8,
};

function rawConfidence(e: Evidence): number {
  const entries = Object.entries(e) as [keyof Evidence, number][];
  let wsum = 0;
  let logsum = 0;
  for (const [k, v] of entries) {
    const w = FACTOR_WEIGHTS[k];
    // Clamp away from 0 so log is finite; a true 0 factor still crushes the result.
    const x = Math.min(0.999, Math.max(0.001, v));
    logsum += w * Math.log(x);
    wsum += w;
  }
  return Math.exp(logsum / wsum); // weighted geometric mean
}

// ─────────────────────────────────────────────────────────────────────────
// (4) + (2) Calibration: learn from (predicted, outcome) pairs.
//
// We bucket past predictions into 10 bins by predicted confidence. For each bin
// we know the AVERAGE predicted confidence and the ACTUAL hit rate. The
// calibration map replaces a raw confidence with the actual hit rate of its
// bin (with Laplace smoothing for thin bins). If the agent says "0.9" but only
// hits 0.6 in that bin, calibrated("0.9") -> ~0.6.
// ─────────────────────────────────────────────────────────────────────────

type Prediction = { confidence: number; correct: boolean };

class CalibrationModel {
  private history: Prediction[] = [];
  private readonly bins = 10;

  record(confidence: number, correct: boolean): void {
    this.history.push({ confidence: clamp01(confidence), correct });
  }

  private binOf(c: number): number {
    return Math.min(this.bins - 1, Math.floor(clamp01(c) * this.bins));
  }

  /** Map a raw confidence to the empirical hit rate of its bin (smoothed). */
  calibrate(raw: number): number {
    const b = this.binOf(raw);
    const inBin = this.history.filter((p) => this.binOf(p.confidence) === b);
    if (inBin.length === 0) return raw; // no evidence yet -> trust the prior
    const hits = inBin.filter((p) => p.correct).length;
    // Laplace smoothing pulls thin bins toward 0.5 (max ignorance).
    const smoothed = (hits + 1) / (inBin.length + 2);
    // Blend toward the empirical rate proportional to how much data we have.
    const trust = inBin.length / (inBin.length + 5);
    return raw * (1 - trust) + smoothed * trust;
  }

  /** Brier score over all history: mean squared error of confidence vs outcome.
   *  Lower is better; 0 is perfect, 0.25 is "always guessed 0.5". */
  brier(): number {
    if (this.history.length === 0) return NaN;
    let s = 0;
    for (const p of this.history) s += (p.confidence - (p.correct ? 1 : 0)) ** 2;
    return s / this.history.length;
  }

  /** A reliability table: per-bin predicted-vs-actual, the calibration X-ray. */
  reliabilityTable(): { bin: string; n: number; predicted: number; actual: number }[] {
    const rows: { bin: string; n: number; predicted: number; actual: number }[] = [];
    for (let b = 0; b < this.bins; b++) {
      const inBin = this.history.filter((p) => this.binOf(p.confidence) === b);
      if (inBin.length === 0) continue;
      const predicted = mean(inBin.map((p) => p.confidence));
      const actual = inBin.filter((p) => p.correct).length / inBin.length;
      rows.push({ bin: `${(b / this.bins).toFixed(1)}-${((b + 1) / this.bins).toFixed(1)}`, n: inBin.length, predicted, actual });
    }
    return rows;
  }

  size(): number {
    return this.history.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// (3) Decision policy — calibrated confidence vs a per-risk floor.
//
// The same confidence means different things for different actions. A floor and
// an "escalation band" below it are defined per risk tier. Above floor -> act;
// inside the band -> escalate (ask a human / a second opinion); below the band
// -> abstain (say "I don't know" rather than guess).
// ─────────────────────────────────────────────────────────────────────────

type RiskTier = "low" | "medium" | "high" | "critical";

const RISK_FLOORS: Record<RiskTier, { floor: number; escalateBand: number }> = {
  low: { floor: 0.4, escalateBand: 0.15 }, // recommend a song
  medium: { floor: 0.6, escalateBand: 0.15 }, // change a setting
  high: { floor: 0.8, escalateBand: 0.1 }, // move funds under a limit
  critical: { floor: 0.95, escalateBand: 0.04 }, // irreversible / above limit
};

type Decision = "act" | "escalate" | "abstain";

function decide(calibrated: number, risk: RiskTier): Decision {
  const { floor, escalateBand } = RISK_FLOORS[risk];
  if (calibrated >= floor) return "act";
  if (calibrated >= floor - escalateBand) return "escalate";
  return "abstain";
}

// ─────────────────────────────────────────────────────────────────────────
// The engine ties evidence -> raw -> calibrated -> decision, and records the
// outcome back into the calibration model so the next number is more honest.
// ─────────────────────────────────────────────────────────────────────────

class UncertaintyEngine {
  private cal = new CalibrationModel();

  assess(evidence: Evidence, risk: RiskTier): { raw: number; calibrated: number; decision: Decision } {
    const raw = rawConfidence(evidence);
    const calibrated = this.cal.calibrate(raw);
    return { raw, calibrated, decision: decide(calibrated, risk) };
  }

  /** Close the loop: tell the engine whether a prior assessment turned out right. */
  observeOutcome(confidence: number, correct: boolean): void {
    this.cal.record(confidence, correct);
  }

  brier(): number {
    return this.cal.brier();
  }
  reliabilityTable() {
    return this.cal.reliabilityTable();
  }
  trained(): number {
    return this.cal.size();
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ─────────────────────────────────────────────────────────────────────────
// Demo
// ─────────────────────────────────────────────────────────────────────────

function banner(t: string) {
  console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
}

function demo() {
  banner("Scenario 1 — evidence -> raw confidence (weak link drags it down)");
  {
    const strong: Evidence = { sourceAgreement: 0.95, recency: 0.9, priorReliability: 0.85, sampleStrength: 0.9 };
    const oneWeak: Evidence = { sourceAgreement: 0.05, recency: 0.9, priorReliability: 0.85, sampleStrength: 0.9 };
    console.log(`  strong evidence       -> raw ${rawConfidence(strong).toFixed(3)}`);
    console.log(`  one near-zero factor  -> raw ${rawConfidence(oneWeak).toFixed(3)}  (geometric mean punishes it)`);
  }

  banner("Scenario 2 — per-risk decision policy on the SAME confidence");
  {
    const c = 0.82;
    for (const risk of ["low", "medium", "high", "critical"] as RiskTier[]) {
      console.log(`  calibrated ${c} @ risk=${risk.padEnd(8)} -> ${decide(c, risk).toUpperCase()}`);
    }
    console.log("  (same number; a song plays, a critical transfer abstains.)");
  }

  banner("Scenario 3 — calibration learns the agent is OVERCONFIDENT, then corrects");
  {
    const eng = new UncertaintyEngine();
    // Simulate a history where claims made at ~0.9 only actually hold ~60%.
    const rng = mulberry32(42);
    for (let i = 0; i < 200; i++) {
      const stated = 0.9;
      const trueRate = 0.6; // reality
      eng.observeOutcome(stated, rng() < trueRate);
    }
    // Also a well-calibrated band at 0.5.
    for (let i = 0; i < 200; i++) eng.observeOutcome(0.5, rng() < 0.5);

    console.log(`  trained on ${eng.trained()} outcomes; Brier = ${eng.brier().toFixed(3)} (lower=better)`);
    console.log("  reliability table (predicted vs actual):");
    for (const r of eng.reliabilityTable()) {
      console.log(`    bin ${r.bin}  n=${String(r.n).padStart(3)}  predicted ${r.predicted.toFixed(2)}  actual ${r.actual.toFixed(2)}`);
    }
    // A fresh raw 0.9 claim now gets bent down toward the empirical ~0.6.
    const ev: Evidence = { sourceAgreement: 0.95, recency: 0.95, priorReliability: 0.95, sampleStrength: 0.95 };
    const a = eng.assess(ev, "high");
    console.log(`\n  new claim: raw ${a.raw.toFixed(3)} -> calibrated ${a.calibrated.toFixed(3)} @ risk=high -> ${a.decision.toUpperCase()}`);
    console.log("  (raw said act; calibrated knows 0.9 here means ~0.6, so it ESCALATES.)");
  }

  banner("Scenario 4 — abstain instead of bluffing on thin evidence");
  {
    const eng = new UncertaintyEngine();
    const thin: Evidence = { sourceAgreement: 0.3, recency: 0.4, priorReliability: 0.5, sampleStrength: 0.2 };
    const a = eng.assess(thin, "medium");
    console.log(`  raw ${a.raw.toFixed(3)} -> calibrated ${a.calibrated.toFixed(3)} @ risk=medium -> ${a.decision.toUpperCase()}`);
    console.log("  ('I don't have enough to say' beats a confident wrong answer.)");
  }

  console.log("\nDone. Confidence here is a checkable prediction, not a tone of voice: it is");
  console.log("derived from evidence, bent toward the agent's real hit rate, and turned into");
  console.log("act / escalate / abstain against a floor that scales with how much is at stake.\n");
}

/** Tiny deterministic PRNG so the demo is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

if (process.argv.includes("--demo")) {
  demo();
}

export { UncertaintyEngine, CalibrationModel, rawConfidence, decide, RISK_FLOORS };
export type { Evidence, RiskTier, Decision, Prediction };
