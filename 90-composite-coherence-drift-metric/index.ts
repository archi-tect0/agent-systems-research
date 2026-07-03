/**
 * Guide 90 — Composite Coherence Score: Integration, Drift, and Decay
 *
 * Demonstrates:
 *   A. Coupling normalization (smooth sigmoid, no single-pair saturation)
 *   B. Composite coherence score C = I × R × (1−L) × G
 *   C. Signed drift with a stability floor term
 *   D. Decay envelope / half-life for cached-reading validity
 *   E. Status classification (nominal/improving/degrading/recovering/volatile/critical)
 *   F. A simulated multi-tick run that catches a coupling collapse none of the
 *      four raw inputs alone would flag as a hard failure
 *
 * No external dependencies. Deterministic (fixed input schedule, no RNG).
 */

// ── Constants ────────────────────────────────────────────────────────────────

const COHERENCE_THRESHOLD = 0.35; // C_c
const DRIFT_FLOOR_KAPPA = 0.08; // κ_floor
const CRITICALITY_VOLATILE_THRESHOLD = 0.6;
const MIN_TAU = 0.5;
const MAX_TAU = 50;

// ── Types ────────────────────────────────────────────────────────────────────

interface TickInputs {
  tick: number;
  rawCoupling: number; // ∈ [0, ∞)
  reachability: number; // R ∈ [0,1]
  resolutionLoss: number; // L ∈ [0,1]
  invariantIntegrity: number; // G ∈ [0,1]
  cost: number; // arbitrary per-tick cost/error signal
  saturation: number; // buffer/context fullness ∈ [0,1]
  decoherenceTurns: number; // how long context normally stays self-consistent
  stabilityConfidence: number; // rolling confidence in current encoding ∈ [0,1]
}

type Status =
  | "nominal"
  | "improving"
  | "degrading"
  | "recovering"
  | "volatile"
  | "critical";

interface TickResult {
  tick: number;
  coherence: number;
  drift: number;
  criticality: number;
  tau: number;
  halfLife: number;
  status: Status;
}

// ── Core formulas ────────────────────────────────────────────────────────────

/** Normalize raw coupling to [0,1] via a smooth sigmoid so one very high pairwise
 *  coupling can't dominate the composite score by itself. */
function normalizeCoupling(rawCoupling: number): number {
  return 1 - Math.exp(-2 * Math.max(0, rawCoupling));
}

/** Composite coherence score C = I × R × (1−L) × G. All four factors must be
 *  simultaneously reasonable — a single collapsed factor zeroes the whole score. */
function computeCoherence(
  rawCoupling: number,
  reachability: number,
  resolutionLoss: number,
  invariantIntegrity: number,
): number {
  const integration = normalizeCoupling(rawCoupling);
  return (
    integration *
    clamp01(reachability) *
    (1 - clamp01(resolutionLoss)) *
    clamp01(invariantIntegrity)
  );
}

/** Rolling criticality proxy: normalized magnitude of cost acceleration.
 *  High criticality = system near a regime change; amplifies drift. */
function computeCriticality(costHistory: number[]): number {
  if (costHistory.length < 3) return 0;
  const n = costHistory.length;
  const d1 = costHistory[n - 1] - costHistory[n - 2];
  const d2 = costHistory[n - 2] - costHistory[n - 3];
  const accel = Math.abs(d1 - d2);
  return Math.max(0, Math.min(1, accel * 4)); // scaled to be readable in [0,1] for this demo
}

/** Signed drift: primary term (cost-rate × criticality × threshold activation)
 *  plus a stability floor so a flat cost history above threshold still reports
 *  a small positive drift instead of an artificial "neutral" reading. */
function computeDrift(
  coherence: number,
  costDelta: number,
  criticality: number,
  stabilityConfidence: number,
): number {
  const primary =
    -costDelta * clamp01(criticality) * Math.tanh(coherence - COHERENCE_THRESHOLD);
  const floor =
    clamp01(stabilityConfidence) *
    DRIFT_FLOOR_KAPPA *
    Math.min(coherence / COHERENCE_THRESHOLD, 2);
  return Math.max(-1, Math.min(1, primary + floor));
}

/** Decay envelope: how long the current (coherence, drift) reading stays
 *  trustworthy before it should be recomputed from fresh inputs. */
function computeDecayEnvelope(
  decoherenceTurns: number,
  saturation: number,
  drift: number,
): { tau: number; halfLife: number } {
  const absDrift = Math.max(0.01, Math.abs(drift));
  const raw = decoherenceTurns * Math.max(0, 1 - clamp01(saturation)) * Math.pow(absDrift, -0.5);
  const tau = Math.max(MIN_TAU, Math.min(MAX_TAU, raw));
  return { tau, halfLife: Math.LN2 * tau };
}

/** Reduce (coherence, drift, criticality) to an operational status label. */
function classifyStatus(coherence: number, drift: number, criticality: number): Status {
  if (criticality >= CRITICALITY_VOLATILE_THRESHOLD) return "volatile";
  const above = coherence >= COHERENCE_THRESHOLD;
  if (above && Math.abs(drift) < 0.03) return "nominal";
  if (above && drift > 0) return "improving";
  if (above && drift <= 0) return "degrading";
  if (!above && drift > 0) return "recovering";
  return "critical";
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// ── Simulated tick schedule ──────────────────────────────────────────────────
// A short run where every individual metric stays "fine" in isolation for a
// while, then coupling collapses (subsystems drift out of sync) even though
// reachability/loss/invariants look unremarkable — the failure mode a naive
// per-metric alerting setup would miss.

const SCHEDULE: TickInputs[] = [
  { tick: 1, rawCoupling: 0.05, reachability: 0.70, resolutionLoss: 0.30, invariantIntegrity: 1.0, cost: 1.00, saturation: 0.20, decoherenceTurns: 12, stabilityConfidence: 0.80 },
  { tick: 2, rawCoupling: 0.60, reachability: 0.85, resolutionLoss: 0.20, invariantIntegrity: 1.0, cost: 0.85, saturation: 0.25, decoherenceTurns: 12, stabilityConfidence: 0.80 },
  { tick: 3, rawCoupling: 0.90, reachability: 0.90, resolutionLoss: 0.15, invariantIntegrity: 1.0, cost: 0.70, saturation: 0.30, decoherenceTurns: 12, stabilityConfidence: 0.85 },
  { tick: 4, rawCoupling: 1.10, reachability: 0.92, resolutionLoss: 0.12, invariantIntegrity: 1.0, cost: 0.55, saturation: 0.30, decoherenceTurns: 12, stabilityConfidence: 0.85 },
  { tick: 5, rawCoupling: 1.20, reachability: 0.93, resolutionLoss: 0.10, invariantIntegrity: 1.0, cost: 0.50, saturation: 0.35, decoherenceTurns: 12, stabilityConfidence: 0.90 },
  // ── coupling collapse: reachability/loss/invariants barely move ──
  { tick: 6, rawCoupling: 0.35, reachability: 0.90, resolutionLoss: 0.12, invariantIntegrity: 1.0, cost: 0.65, saturation: 0.35, decoherenceTurns: 12, stabilityConfidence: 0.75 },
  { tick: 7, rawCoupling: 0.10, reachability: 0.88, resolutionLoss: 0.14, invariantIntegrity: 1.0, cost: 0.90, saturation: 0.40, decoherenceTurns: 12, stabilityConfidence: 0.55 },
  { tick: 8, rawCoupling: 0.02, reachability: 0.87, resolutionLoss: 0.15, invariantIntegrity: 1.0, cost: 1.20, saturation: 0.45, decoherenceTurns: 12, stabilityConfidence: 0.40 },
  // ── recovery ──
  { tick: 9, rawCoupling: 0.40, reachability: 0.88, resolutionLoss: 0.15, invariantIntegrity: 1.0, cost: 0.95, saturation: 0.40, decoherenceTurns: 12, stabilityConfidence: 0.55 },
  { tick: 10, rawCoupling: 0.85, reachability: 0.90, resolutionLoss: 0.13, invariantIntegrity: 1.0, cost: 0.70, saturation: 0.35, decoherenceTurns: 12, stabilityConfidence: 0.70 },
];

function run(): TickResult[] {
  const costHistory: number[] = [];
  const results: TickResult[] = [];
  let prevCost: number | null = null;

  for (const t of SCHEDULE) {
    costHistory.push(t.cost);
    const coherence = computeCoherence(t.rawCoupling, t.reachability, t.resolutionLoss, t.invariantIntegrity);
    const criticality = computeCriticality(costHistory);
    const costDelta = prevCost === null ? 0 : t.cost - prevCost;
    const drift = computeDrift(coherence, costDelta, criticality, t.stabilityConfidence);
    const { tau, halfLife } = computeDecayEnvelope(t.decoherenceTurns, t.saturation, drift);
    const status = classifyStatus(coherence, drift, criticality);

    results.push({ tick: t.tick, coherence, drift, criticality, tau, halfLife, status });
    prevCost = t.cost;
  }
  return results;
}

function fmt(n: number): string {
  return n.toFixed(3).padStart(7);
}

function main() {
  const results = run();

  console.log("tick | coherence |   drift  | criticality |   tau  | half-life | status");
  console.log("-----|-----------|----------|-------------|--------|-----------|----------");
  for (const r of results) {
    console.log(
      `${String(r.tick).padStart(4)} | ${fmt(r.coherence)}   | ${fmt(r.drift)} | ${fmt(r.criticality)}     | ${fmt(r.tau)} | ${fmt(r.halfLife)}   | ${r.status}`,
    );
  }

  const collapseTick = results.find((r) => r.tick === 8)!;
  console.log("\n--- Assertion: coupling collapse is caught by the composite score ---");
  console.log(
    `Tick 8: reachability/loss/invariants are near their tick-5 values, but coherence dropped ` +
      `from ${fmt(results[4].coherence).trim()} (tick 5) to ${fmt(collapseTick.coherence).trim()} (tick 8) ` +
      `and status is "${collapseTick.status}" — a per-metric dashboard averaging the four raw inputs ` +
      `would not have flagged this, since three of the four inputs barely moved.`,
  );

  if (collapseTick.coherence >= COHERENCE_THRESHOLD) {
    throw new Error("Demo invariant violated: expected coupling collapse to drop coherence below threshold");
  }
  if (results[4].coherence < COHERENCE_THRESHOLD) {
    throw new Error("Demo invariant violated: expected tick 5 (pre-collapse) coherence to be above threshold");
  }

  const recoveryTick = results.find((r) => r.tick === 10)!;
  console.log(
    `Tick 10: coupling recovered, coherence back to ${fmt(recoveryTick.coherence).trim()}, ` +
      `status "${recoveryTick.status}" — drift correctly reports the recovery direction.`,
  );
}

main();
