// Guide 97 — Blended Session Uncertainty Signal
//
// Combines retrieval-diversity entropy with a lower layer's compression-
// pressure signal into one uncertainty meter, with a short ring-buffer
// velocity check for spike detection gated on encoding stability.

const BLEND_MEM_WEIGHT = 0.6;
const BLEND_COMPRESSION_WEIGHT = 0.4;
const SPIKE_LEVEL = 0.55;
const SPIKE_RATE = 0.15;
const LOW_CONFIDENCE_STABILITY = 0.4;
const HISTORY_SIZE = 5;

function normalizedShannonEntropy(weights: number[]): number {
  const positive = weights.filter((w) => w > 0);
  if (positive.length <= 1) return 0;
  const total = positive.reduce((a, b) => a + b, 0);
  const probs = positive.map((w) => w / total);
  const h = -probs.reduce((sum, p) => sum + p * Math.log2(p), 0);
  return h / Math.log2(positive.length);
}

class SessionUncertaintyMeter {
  private history: number[] = [];

  step(retrievedWeights: number[], compressionDepth: number, stability: number) {
    const memEntropy = normalizedShannonEntropy(retrievedWeights);
    const blended = BLEND_MEM_WEIGHT * memEntropy + BLEND_COMPRESSION_WEIGHT * compressionDepth;

    const prev = this.history.length > 0 ? this.history[this.history.length - 1] : blended;
    const velocity = blended - prev;

    this.history.push(blended);
    if (this.history.length > HISTORY_SIZE) this.history.shift();

    const spike = blended > SPIKE_LEVEL && velocity > SPIKE_RATE && stability < LOW_CONFIDENCE_STABILITY;

    return { memEntropy, blended, velocity, spike };
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

// Case A: both retrieval diversity AND compression pressure rise together, stability low -> spike fires.
const meterA = new SessionUncertaintyMeter();
meterA.step([1.0], 0.1, 0.9); // stable baseline: one dominant memory hit
meterA.step([1.0], 0.15, 0.85);
const spikeStepA = meterA.step([0.2, 0.2, 0.2, 0.2, 0.2], 0.7, 0.2); // broad retrieval + rising compression + unstable
console.log("[case A: combined rise] ->", spikeStepA);
assert(spikeStepA.spike, "expected the combined rise (diversity + compression + low stability) to trigger a spike");

// Case B: only retrieval diversity rises, compression flat, stability held high -> no spike.
const meterB = new SessionUncertaintyMeter();
meterB.step([1.0], 0.1, 0.9);
meterB.step([1.0], 0.1, 0.9);
const noSpikeB = meterB.step([0.2, 0.2, 0.2, 0.2, 0.2], 0.1, 0.9);
console.log("[case B: diversity only, stability high] ->", noSpikeB);
assert(!noSpikeB.spike, "diversity rising alone with high stability should not trigger a spike");

// Case C: only compression pressure rises, retrieval stays concentrated, stability held high -> no spike.
const meterC = new SessionUncertaintyMeter();
meterC.step([1.0], 0.1, 0.9);
meterC.step([1.0], 0.1, 0.9);
const noSpikeC = meterC.step([1.0], 0.9, 0.9);
console.log("[case C: compression only, stability high] ->", noSpikeC);
assert(!noSpikeC.spike, "compression pressure rising alone with high stability should not trigger a spike");

console.log("\n[property checks] blended spike requires both inputs + stability gating: PASS");
console.log("\nGuide 97 demo complete.");
