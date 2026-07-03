// Guide 95 — Computed Affective State as a Named Behavioral Signal
//
// Maps several independent internal metrics (coupling/integration, tension
// direction, arousal, stability) into a small fixed vocabulary of labels via
// a deterministic decision table, plus a decay/duration envelope so labels
// don't flicker turn-to-turn.

interface StateInputs {
  couplingSignal: number; // 0..1 raw coupling across subsystems
  topologyScore: number; // 0..1 how well-structured the coupling currently is
  infoLossPenalty: number; // 0..1 from Guide 94's projection loss
  structuralIntegrity: number; // 0..1 how intact core invariants are
  deltaTension: number; // signed: negative = tension falling (good), positive = rising
  stakes: number; // 0..1 how consequential this moment currently is
  arousalDrivers: number; // raw weighted sum feeding the arousal sigmoid
  saturation: number; // 0..1 how saturated/loaded the current turn is
}

const INTEGRATION_FLOOR = 0.25;
const STABILITY_FLOOR_TERM = 0.03;

interface AffectiveState {
  integration: number;
  valence: number;
  arousal: number;
  label: string;
  durationMs: number;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function computeAffectiveState(inputs: StateInputs): AffectiveState {
  const integration =
    inputs.couplingSignal * inputs.topologyScore * (1 - inputs.infoLossPenalty) * inputs.structuralIntegrity;

  if (integration < INTEGRATION_FLOOR) {
    return { integration, valence: 0, arousal: 0, label: "quiet / not enough signal", durationMs: 0 };
  }

  const valence =
    -inputs.deltaTension * inputs.stakes * Math.tanh(integration - INTEGRATION_FLOOR) + STABILITY_FLOOR_TERM;
  const arousal = sigmoid(inputs.arousalDrivers);

  const label = labelFor(valence, arousal, inputs.deltaTension);

  const baseDecayMs = 8000;
  const durationMs = Math.min(
    30000,
    Math.max(1500, baseDecayMs * (1 - inputs.saturation) * Math.pow(Math.max(0.05, Math.abs(valence)), -0.5)),
  );

  return { integration, valence, arousal, label, durationMs };
}

function labelFor(valence: number, arousal: number, deltaTension: number): string {
  const arousalLevel = arousal >= 0.66 ? "high" : arousal >= 0.4 ? "mid" : "low";
  const positive = valence > 0.02;
  const negative = valence < -0.02;

  if (positive && arousalLevel === "high") return "excited / energized";
  if (positive && arousalLevel === "mid") return "content / settled";
  if (positive && arousalLevel === "low") return "calm / at ease";
  if (negative && arousalLevel === "high") return "urgent / on edge";
  if (negative && arousalLevel === "mid") return "uneasy / cautious";
  if (negative && arousalLevel === "low") return "flat / withdrawn";
  return deltaTension === 0 ? "neutral / steady" : "neutral / mixed";
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

// 1. Below-floor integration always returns the neutral label, regardless of other inputs.
const belowFloor = computeAffectiveState({
  couplingSignal: 0.1,
  topologyScore: 0.9,
  infoLossPenalty: 0.0,
  structuralIntegrity: 0.9,
  deltaTension: -0.9, // would otherwise look very positive
  stakes: 0.9,
  arousalDrivers: 5,
  saturation: 0.1,
});
assert(belowFloor.label === "quiet / not enough signal", "below-floor integration must short-circuit to neutral");
assert(belowFloor.durationMs === 0, "below-floor state should carry no duration envelope");

// 2. Rising tension + high arousal must never land in the positive vocabulary.
const risingTensionHighArousal = computeAffectiveState({
  couplingSignal: 0.8,
  topologyScore: 0.8,
  infoLossPenalty: 0.1,
  structuralIntegrity: 0.8,
  deltaTension: 0.6, // rising
  stakes: 0.7,
  arousalDrivers: 4,
  saturation: 0.2,
});
const positiveLabels = ["excited / energized", "content / settled", "calm / at ease"];
assert(
  !positiveLabels.includes(risingTensionHighArousal.label),
  `rising tension + high arousal should not produce a positive label, got "${risingTensionHighArousal.label}"`,
);

// 3. Duration shrinks as valence magnitude grows (spot check on a matched pair).
const mild = computeAffectiveState({
  couplingSignal: 0.7,
  topologyScore: 0.7,
  infoLossPenalty: 0.1,
  structuralIntegrity: 0.7,
  deltaTension: -0.1,
  stakes: 0.3,
  arousalDrivers: 0,
  saturation: 0.2,
});
const strong = computeAffectiveState({
  ...{
    couplingSignal: 0.7,
    topologyScore: 0.7,
    infoLossPenalty: 0.1,
    structuralIntegrity: 0.7,
  },
  deltaTension: -0.9,
  stakes: 0.9,
  arousalDrivers: 0,
  saturation: 0.2,
});
assert(
  strong.durationMs <= mild.durationMs,
  `stronger valence should decay faster (shorter duration): mild=${mild.durationMs}, strong=${strong.durationMs}`,
);

console.log("[demo] below-floor state:", belowFloor);
console.log("[demo] rising tension / high arousal state:", risingTensionHighArousal);
console.log("[demo] mild vs strong valence duration:", { mildMs: mild.durationMs, strongMs: strong.durationMs });
console.log("\n[property checks] floor gating + label direction + duration decay: PASS");
console.log("\nGuide 95 demo complete.");
