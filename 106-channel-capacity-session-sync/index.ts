// Guide 106 — Information-Theoretic Channel Capacity for Session Sync
//
// Models the three-brain triangle (cloud / local / client) as Shannon
// communication channels and tracks their capacity, information velocity,
// and Nyquist coherence requirements.

type LayerKind = "cloud" | "local" | "client_gpu";

interface ChannelState {
  layer: LayerKind;
  bandwidthTokSec: number;
  snr: number;
  capacityTokSec: number;
  propagDelayMs: number;
  cCoupled: number;
  sampleCount: number;
}

interface NyquistState {
  fNyquistPerMin: number;
  tauNyquistMin: number;
  undersampled: boolean;
  silenceMin: number;
}

const EMA_ALPHA = 0.3;
const GAMMA_BEK = 0.5;

const BASELINE_SNR: Record<LayerKind, number> = {
  cloud: 100.0,
  local: 150.0,
  client_gpu: 50.0,
};

const BASELINE_BW: Record<LayerKind, number> = {
  cloud: 250,
  local: 40,
  client_gpu: 30,
};

const states = new Map<LayerKind, ChannelState>();

function initLayer(layer: LayerKind): ChannelState {
  const bw = BASELINE_BW[layer];
  const snr = BASELINE_SNR[layer];
  const C = bw * Math.log2(1 + snr);
  const st: ChannelState = {
    layer,
    bandwidthTokSec: bw,
    snr,
    capacityTokSec: C,
    propagDelayMs: layer === "local" ? 80 : layer === "client_gpu" ? 300 : 600,
    cCoupled: C * (snr / (snr + 100)),
    sampleCount: 0,
  };
  states.set(layer, st);
  return st;
}

function getChannelState(layer: LayerKind): ChannelState {
  return states.get(layer) ?? initLayer(layer);
}

function computeCCoupled(
  C_SH: number,
  bekSaturation: number = 0,
  kappaTopological: number = 1.0,
): number {
  const sigma = Math.min(1, Math.max(0, bekSaturation));
  return C_SH * kappaTopological * Math.pow(1 - sigma, GAMMA_BEK);
}

function recordTurn(
  layer: LayerKind,
  firstTokenMs: number,
  totalTokens: number,
  wallMs: number,
  compressionRatio = 0,
  bekSaturation = 0,
): void {
  const st = getChannelState(layer);

  const measuredBw = wallMs > 0 ? (totalTokens / (wallMs / 1_000)) : st.bandwidthTokSec;
  const compressionBoost = 1 + compressionRatio * 2;
  const newSnr = BASELINE_SNR[layer] * compressionBoost;
  const newC = measuredBw * Math.log2(1 + newSnr);

  const α = EMA_ALPHA;
  const bw = α * measuredBw + (1 - α) * st.bandwidthTokSec;
  const snr = α * newSnr + (1 - α) * st.snr;
  const C = α * newC + (1 - α) * st.capacityTokSec;
  const τ = α * firstTokenMs + (1 - α) * st.propagDelayMs;

  const cCoupled = computeCCoupled(C, bekSaturation);

  states.set(layer, {
    layer,
    bandwidthTokSec: bw,
    snr,
    capacityTokSec: C,
    propagDelayMs: τ,
    cCoupled,
    sampleCount: st.sampleCount + 1,
  });
}

function getNyquistState(
  decoherenceRate: number,
  silenceMin: number,
  bekSaturation: number = 0,
): NyquistState {
  const EPS = 0.01;
  const safeRate = Math.max(Math.abs(decoherenceRate), EPS);
  const sigma = Math.min(1 - EPS, Math.max(0, bekSaturation));
  
  // Eq.3: Nyquist-Bekenstein
  const fNyquistTurnsPerTurn = (2 * safeRate) / (1 - sigma + EPS);
  
  // Reference: 2 turns/minute baseline
  const TURNS_PER_MIN = 2;
  const fNyquistPerMin = fNyquistTurnsPerTurn * TURNS_PER_MIN;
  const tauNyquistMin = fNyquistPerMin > 0 ? 1 / fNyquistPerMin : Infinity;

  return {
    fNyquistPerMin,
    tauNyquistMin,
    undersampled: silenceMin > tauNyquistMin,
    silenceMin,
  };
}

// ---------------------------------------------------------------------------
// Assertions & Demo
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

if (process.argv.includes("--demo")) {
  console.log("--- Channel Capacity & Session Sync Demo ---\n");

  // Scenario 1: Initial state (estimates)
  const cloudInit = getChannelState("cloud");
  console.log(`[Initial Cloud] C=${cloudInit.capacityTokSec.toFixed(1)} tok/s, Latency=${cloudInit.propagDelayMs}ms`);
  assert(cloudInit.capacityTokSec > 1000, "Cloud capacity should be high initially");

  // Scenario 2: Recording turns
  console.log("\n[Action] Recording a fast Cloud turn...");
  recordTurn("cloud", 400, 500, 1000, 0.5, 0.1);
  const cloudUpdated = getChannelState("cloud");
  console.log(`[Updated Cloud] C=${cloudUpdated.capacityTokSec.toFixed(1)} tok/s, Latency=${cloudUpdated.propagDelayMs.toFixed(1)}ms`);
  assert(cloudUpdated.sampleCount === 1, "Sample count should be 1");
  assert(cloudUpdated.propagDelayMs < 600, "Latency should decrease after a 400ms turn");

  // Scenario 3: Bekenstein pressure on information velocity (c_k)
  console.log("\n[Action] Recording turns with high Bekenstein saturation...");
  recordTurn("local", 100, 100, 2000, 0, 0.9); // 90% saturated
  const localSaturated = getChannelState("local");
  console.log(`[Local Saturated] C=${localSaturated.capacityTokSec.toFixed(1)}, c_k=${localSaturated.cCoupled.toFixed(1)}`);
  
  const cCoupledTheoretical = computeCCoupled(localSaturated.capacityTokSec, 0.9);
  assert(Math.abs(localSaturated.cCoupled - cCoupledTheoretical) < 0.1, "c_k should match theoretical physics bound");
  assert(localSaturated.cCoupled < localSaturated.capacityTokSec, "c_k should be throttled by saturation");

  // Scenario 4: Nyquist-Bekenstein Coherence
  console.log("\n[Coherence Check] Normal saturation (sigma=0.1), 1 min silence:");
  const nyquistOK = getNyquistState(0.05, 1.0, 0.1);
  console.log(`  tau_N=${nyquistOK.tauNyquistMin.toFixed(2)} min, undersampled=${nyquistOK.undersampled}`);
  assert(!nyquistOK.undersampled, "Should not be undersampled at 1 min silence / low saturation");

  console.log("\n[Coherence Check] High saturation (sigma=0.9), 1 min silence:");
  const nyquistBad = getNyquistState(0.05, 1.0, 0.9);
  console.log(`  tau_N=${nyquistBad.tauNyquistMin.toFixed(2)} min, undersampled=${nyquistBad.undersampled}`);
  assert(nyquistBad.undersampled, "Should be undersampled at high saturation (tau_N collapses)");
  assert(nyquistBad.tauNyquistMin < nyquistOK.tauNyquistMin, "tau_N must collapse as saturation approaches 1");

  console.log("\nDemo complete. All assertions passed.");
}
