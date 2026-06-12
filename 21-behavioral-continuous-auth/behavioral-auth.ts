/**
 * Behavioral Continuous Authentication
 *
 * Maintains a running identity-confidence score from device motion (IMU) and
 * step-walking rhythm (gait), and signals a STEP-UP to a strong factor when
 * confidence drops below threshold. Behavioral signals are soft inputs — they
 * lower friction when high and add friction when low; they never replace a
 * strong factor.
 *
 *   - toFeatureVector() / verifyContinuous() : 9-dim IMU signature, EMA template,
 *                                              cosine similarity, 0.92 threshold.
 *   - toGaitVector()   / verifyGait()        : gait signature, 0.85 threshold.
 *
 * No external dependencies — standard arithmetic only.
 */

export const CONTINUOUS_THRESHOLD = 0.92;
export const GAIT_THRESHOLD = 0.85;

// ── Cosine similarity (direction, scale-tolerant) ────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ── Continuous 9-dim IMU signature ───────────────────────────────────────────

export interface ImuWindow {
  ax: number; ay: number; az: number;   // accelerometer
  gx: number; gy: number; gz: number;   // gyroscope
  pitch: number; roll: number; yaw: number; // orientation
}

export function toFeatureVector(w: ImuWindow): number[] {
  return [w.ax, w.ay, w.az, w.gx, w.gy, w.gz, w.pitch, w.roll, w.yaw];
}

export interface ContinuousResult {
  pass: boolean;
  score: number;
  stepUp: boolean;
  updatedEnrolled: number[];
}

/**
 * Compare a live sample against the enrolled template. On accept, returns an
 * EMA-updated template (caller persists it). On reject, signals step-up — the
 * session is NOT destroyed; the NEXT sensitive action must clear a strong factor.
 */
export function verifyContinuous(
  enrolled: number[],
  sample: number[],
  sampleCount: number,
): ContinuousResult {
  const score = cosineSimilarity(enrolled, sample);

  if (score >= CONTINUOUS_THRESHOLD) {
    const alpha = sampleCount > 50 ? 0.2 : 0.5; // slow down once mature
    const updatedEnrolled = enrolled.map((e, i) => alpha * sample[i] + (1 - alpha) * e);
    return { pass: true, score, stepUp: false, updatedEnrolled };
  }

  return { pass: false, score, stepUp: true, updatedEnrolled: enrolled };
}

// ── Gait signature (higher-assurance, opt-in tier) ───────────────────────────

export interface GaitSignature {
  stepCount: number;
  stepFrequency: number;
  meanMagnitude: number;
  stdMagnitude: number;
  peakIntervals: number[]; // ms between detected step peaks
}

export function toGaitVector(g: GaitSignature): number[] {
  const intervals = [...(g.peakIntervals ?? []).slice(0, 8)];
  while (intervals.length < 8) intervals.push(0);
  return [
    g.stepFrequency * 10,
    g.meanMagnitude / 10,
    g.stdMagnitude * 5,
    ...intervals.map((t) => t / 500),
  ];
}

export function enrollGait(sample: GaitSignature): { ok: true } | { ok: false; error: string } {
  if ((sample.peakIntervals?.length ?? 0) < 2) {
    return { ok: false, error: "Insufficient gait data — fewer than 2 step peaks detected. Walk more naturally or for longer." };
  }
  return { ok: true };
}

export function verifyGait(
  enrolled: GaitSignature,
  sample: GaitSignature,
): { pass: boolean; score: number; threshold: number } {
  const score = cosineSimilarity(toGaitVector(enrolled), toGaitVector(sample));
  return { pass: score >= GAIT_THRESHOLD, score, threshold: GAIT_THRESHOLD };
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  // Enrolled template for the legitimate user.
  let enrolled = toFeatureVector({ ax: 0.10, ay: 0.98, az: 0.05, gx: 0.01, gy: -0.02, gz: 0.00, pitch: 12, roll: -3, yaw: 88 });
  let count = 60;

  // A close sample from the same person — should pass and update the template.
  const sameUser = toFeatureVector({ ax: 0.11, ay: 0.97, az: 0.06, gx: 0.01, gy: -0.02, gz: 0.01, pitch: 13, roll: -3, yaw: 87 });
  const r1 = verifyContinuous(enrolled, sameUser, count);
  console.log("same user:", { pass: r1.pass, score: r1.score.toFixed(4), stepUp: r1.stepUp });
  if (r1.pass) { enrolled = r1.updatedEnrolled; count++; }

  // A very different motion pattern — should fail and request step-up.
  const impostor = toFeatureVector({ ax: -0.6, ay: 0.2, az: 0.7, gx: 0.4, gy: 0.5, gz: -0.3, pitch: -40, roll: 25, yaw: 10 });
  const r2 = verifyContinuous(enrolled, impostor, count);
  console.log("impostor: ", { pass: r2.pass, score: r2.score.toFixed(4), stepUp: r2.stepUp });

  // Gait
  const enrolledGait: GaitSignature = { stepCount: 20, stepFrequency: 1.9, meanMagnitude: 11.2, stdMagnitude: 2.1, peakIntervals: [520, 530, 515, 525, 522] };
  const liveGait: GaitSignature = { stepCount: 18, stepFrequency: 1.88, meanMagnitude: 11.0, stdMagnitude: 2.2, peakIntervals: [524, 528, 519, 521] };
  console.log("enroll gait:", enrollGait(enrolledGait));
  console.log("gait verify:", verifyGait(enrolledGait, liveGait));
}
