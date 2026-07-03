// Guide 99 — Implicit Preference Distillation from Binary Feedback
//
// Turns thumbs up/down ratings into per-dimension EMA style weights via a
// bank of cheap heuristic detectors, and queues contrastive training pairs
// with an explicit pending/training/done status.

type Rating = "up" | "down";

interface Detector {
  name: string;
  detect: (text: string) => number; // returns a value in [-1, 1] or {0, ±1}
}

const detectors: Detector[] = [
  { name: "has_list", detect: (t) => (/(^|\n)[-*]\s/.test(t) ? 1 : 0) },
  { name: "has_code", detect: (t) => (/```/.test(t) ? 1 : 0) },
  { name: "is_long", detect: (t) => (t.length > 400 ? 1 : 0) },
  { name: "is_short", detect: (t) => (t.length < 120 ? 1 : 0) },
  { name: "formal_tone", detect: (t) => (/\b(furthermore|therefore|shall)\b/i.test(t) ? 1 : 0) },
  { name: "casual_tone", detect: (t) => (/\b(yeah|gonna|kinda)\b/i.test(t) ? 1 : 0) },
  {
    name: "flaky_detector",
    detect: (t) => {
      if (t.includes("__CRASH__")) throw new Error("simulated detector failure");
      return 0;
    },
  },
];

const ALPHA = 0.25;

interface TrainingPair {
  chosen: string;
  rejected: string;
  status: "pending" | "training" | "done";
}

class PreferenceDistiller {
  weights: Record<string, Record<string, number>> = {};
  trainingPairs: TrainingPair[] = [];

  private weightsFor(identity: string): Record<string, number> {
    if (!this.weights[identity]) this.weights[identity] = {};
    return this.weights[identity];
  }

  processRating(identity: string, responseText: string, rating: Rating, alternativeText?: string): void {
    const sign = rating === "up" ? 1 : -1;
    const w = this.weightsFor(identity);

    for (const d of detectors) {
      try {
        const signal = d.detect(responseText) * sign;
        const prev = w[d.name] ?? 0;
        const updated = prev * (1 - ALPHA) + signal * ALPHA;
        w[d.name] = Math.max(-1, Math.min(1, updated));
      } catch (err) {
        console.log(`[detector failure isolated] ${d.name}: ${(err as Error).message}`);
        // continue processing other detectors
      }
    }

    if (alternativeText) {
      this.trainingPairs.push({ chosen: responseText, rejected: alternativeText, status: "pending" });
    }
  }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const distiller = new PreferenceDistiller();
const identity = "wallet_abc";

const longListResponse =
  "- first point about the topic in detail\n- second point about the topic\n- third point with more detail\n" +
  "x".repeat(400);
const shortPlainResponse = "Sure, done.";

// Repeated up-ratings on long, listy responses; repeated down-ratings on short plain ones.
for (let i = 0; i < 12; i++) {
  distiller.processRating(identity, longListResponse, "up", "some rejected alternative text here");
  distiller.processRating(identity, shortPlainResponse, "down", "a better alternative would have been longer");
}

const w = distiller.weights[identity];
console.log("[converged weights]", w);

assert(w.has_list > 0.3, `expected has_list weight to converge positive from repeated up-ratings, got ${w.has_list}`);
assert(w.is_long > 0.3, `expected is_long weight to converge positive, got ${w.is_long}`);
assert(w.is_short < -0.3, `expected is_short weight to converge negative from repeated down-ratings, got ${w.is_short}`);

// Weights must stay clamped within [-1, 1] even under many more repeated ratings.
for (let i = 0; i < 100; i++) {
  distiller.processRating(identity, longListResponse, "up");
}
assert(w.has_list <= 1 && w.has_list >= -1, "weight must stay clamped to [-1, 1]");

// A flaky detector crashing must not prevent other detectors from updating in the same round.
const beforeCrashRound = { ...distiller.weights[identity] };
distiller.processRating(identity, longListResponse + " __CRASH__", "up");
const afterCrashRound = distiller.weights[identity];
assert(
  afterCrashRound.has_list !== beforeCrashRound.has_list || afterCrashRound.has_list === 1,
  "other detectors must still update even when one detector throws",
);

// Training pairs carry correct pending status and preserve chosen/rejected text.
// Each loop iteration issued two rated calls (one up, one down), both with an alternative
// text supplied, so 12 iterations enqueue 24 pairs.
assert(distiller.trainingPairs.length === 24, `expected 24 queued training pairs, got ${distiller.trainingPairs.length}`);
assert(
  distiller.trainingPairs.every((p) => p.status === "pending"),
  "all freshly queued training pairs must start as pending",
);
assert(distiller.trainingPairs[0].chosen === longListResponse, "chosen text must be preserved verbatim");

console.log(`\n[training queue] ${distiller.trainingPairs.length} pairs, all pending`);
console.log("\n[property checks] weight convergence + clamping + detector isolation + queue integrity: PASS");
console.log("\nGuide 99 demo complete.");
