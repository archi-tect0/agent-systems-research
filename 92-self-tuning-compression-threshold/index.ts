// Guide 92 — Self-Tuning Compression Threshold with Oscillation Detection
//
// Three scenarios against the same controller + detector:
//   1. slow drift        -> controller tracks target rate, confidence stays high
//   2. sudden regime jump -> controller corrects over following windows
//   3. injected instability -> detector confidence collapses, flagging distrust
//
// Run: node index.ts   (or: npx tsx index.ts)

const WINDOW        = 50;     // samples per controller update
const LEARNING_RATE  = 0.03;
const TARGET_RATE    = 0.15;
const THRESHOLD_MIN  = 0.35;
const THRESHOLD_MAX  = 0.75;
const THRESHOLD_INIT = 0.55;

const RING_SIZE = 20;
const K_VARIANCE = 15;

class AdaptiveController {
  threshold = THRESHOLD_INIT;
  private samplesInWindow = 0;
  private coarseInWindow = 0;

  private ring: number[] = [];
  confidence = 1.0;

  private minConfidenceSeen = 1.0;

  step(rawSignal: number): { isCoarse: boolean; confidence: number } {
    const isCoarse = rawSignal >= this.threshold;

    this.samplesInWindow++;
    if (isCoarse) this.coarseInWindow++;

    if (this.samplesInWindow >= WINDOW) {
      const actualRate = this.coarseInWindow / this.samplesInWindow;
      const delta = LEARNING_RATE * (actualRate - TARGET_RATE);
      this.threshold = Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, this.threshold + delta));
      this.samplesInWindow = 0;
      this.coarseInWindow = 0;
    }

    this.ring.push(rawSignal);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    if (this.ring.length >= 2) {
      const mean = this.ring.reduce((a, b) => a + b, 0) / this.ring.length;
      const variance = this.ring.reduce((a, b) => a + (b - mean) ** 2, 0) / this.ring.length;
      this.confidence = Math.exp(-K_VARIANCE * variance);
    }
    this.minConfidenceSeen = Math.min(this.minConfidenceSeen, this.confidence);

    return { isCoarse, confidence: this.confidence };
  }

  getMinConfidence(): number {
    return this.minConfidenceSeen;
  }
}

function runScenario(name: string, n: number, signalAt: (i: number) => number) {
  const controller = new AdaptiveController();
  let coarseCount = 0;
  const thresholdSamples: number[] = [];

  for (let i = 0; i < n; i++) {
    const { isCoarse } = controller.step(signalAt(i));
    if (isCoarse) coarseCount++;
    if (i % WINDOW === WINDOW - 1) thresholdSamples.push(controller.threshold);
  }

  const finalRate = coarseCount / n;
  console.log(`\n=== ${name} ===`);
  console.log(`samples=${n}  finalCoarseRate=${finalRate.toFixed(3)} (target=${TARGET_RATE})`);
  console.log(`threshold trajectory (per window): ${thresholdSamples.map((t) => t.toFixed(3)).join(" -> ")}`);
  console.log(`min confidence observed: ${controller.getMinConfidence().toFixed(4)}`);

  return { finalRate, minConfidence: controller.getMinConfidence(), thresholdSamples };
}

// ── Scenario 1: slow drift ───────────────────────────────────────────────
// Novelty distribution centered near the threshold, drifting gently upward
// over the run. The controller should keep the actual rate near target.
const s1 = runScenario("Scenario 1: slow drift", 2000, (i) => {
  const drift = 0.40 + (i / 2000) * 0.15; // slowly rises 0.40 -> 0.55
  const noise = Math.sin(i * 0.37) * 0.05;
  return Math.min(1, Math.max(0, drift + noise));
});

// ── Scenario 2: sudden regime change ─────────────────────────────────────
const s2 = runScenario("Scenario 2: sudden regime change", 2000, (i) => {
  const base = i < 1000 ? 0.40 : 0.62; // jumps at the midpoint
  const noise = Math.sin(i * 0.53) * 0.04;
  return Math.min(1, Math.max(0, base + noise));
});

// ── Scenario 3: injected instability ─────────────────────────────────────
// Rapid alternation between very low and very high novelty -- a genuinely
// unstable regime the detector should flag.
const s3 = runScenario("Scenario 3: injected instability", 2000, (i) => {
  return i % 2 === 0 ? 0.05 : 0.95;
});

// ── Assertions ────────────────────────────────────────────────────────────
console.log("\n--- Assertions ---");

const rateTolerance = 0.06;
console.log(`Scenario 1 final rate within tolerance of target: |${s1.finalRate.toFixed(3)} - ${TARGET_RATE}| <= ${rateTolerance}`);
if (Math.abs(s1.finalRate - TARGET_RATE) > rateTolerance) {
  throw new Error("Controller failed to converge to target rate under slow drift.");
}

console.log(`Scenario 1 min confidence (stable regime): ${s1.minConfidence.toFixed(4)}`);
console.log(`Scenario 3 min confidence (unstable regime): ${s3.minConfidence.toFixed(4)}`);
if (!(s3.minConfidence < s1.minConfidence - 0.3)) {
  throw new Error("Oscillation detector failed to distinguish an unstable regime from a stable one.");
}

console.log(`Scenario 2 threshold trajectory shows correction after the jump: ${s2.thresholdSamples[0].toFixed(3)} -> ${s2.thresholdSamples[s2.thresholdSamples.length - 1].toFixed(3)}`);
if (s2.thresholdSamples[s2.thresholdSamples.length - 1] <= s2.thresholdSamples[0]) {
  throw new Error("Controller did not raise the threshold in response to the sudden increase in novelty.");
}

console.log("\nOK — controller tracks target rate under drift, corrects after a regime change, and the detector flags genuine instability without a second feedback loop.");
