# Behavioral Continuous Authentication

## Problem

Authentication is almost always a single gate: pass the login, get a session, then the session is trusted until it expires. Everything after the gate is implicitly the same person. But a device can change hands *after* the gate — handed to someone, snatched while unlocked, used by a different person who knows the PIN. A one-time check at login cannot notice this.

Behavioral biometrics close the gap by *continuously* re-checking identity from how the device is held and moved — signals the device already produces (accelerometer, gyroscope, orientation) without any extra user action. The hypothesis is that motion patterns — micro-tremor, the way the device tilts when you reach for it, gait while walking with it — are stable enough within a person and different enough between people to serve as a soft, always-on identity signal.

The design goal is modest and honest: **not** to authenticate from motion alone (too noisy), but to maintain a running confidence score and *step up* to a strong factor (passkey, PIN) the moment confidence drops below a threshold. Behavioral auth lowers friction when confidence is high and raises a hard wall the instant it isn't.

## Design decisions

**Why a fixed-length feature vector instead of raw sample streams?**
Raw IMU streams are unbounded, unaligned, and expensive to compare. Each window of motion is reduced to a fixed 9-dimensional feature vector — three accelerometer axes, three gyroscope axes, and three orientation angles (pitch, roll, yaw) — summarizing the window. A fixed vector makes comparison a single cheap operation and makes the enrolled template a small, stable thing to store.

**Why cosine similarity?**
Cosine similarity compares the *direction* of two feature vectors, not their magnitude. This is the right choice because behavioral signatures should be scale-tolerant: holding the phone slightly more firmly scales magnitudes up across the board but should not change *who* is holding it. Cosine ranges in `[-1, 1]`, is cheap, and has no training phase — it works from the first enrolled sample.

**Why an exponential moving average (EMA) on the enrolled template?**
A person's motion drifts slowly (new phone case, an injury, a different chair). A static template enrolled once goes stale. The enrolled vector is therefore updated as an EMA of incoming *accepted* samples: `enrolled = α·sample + (1-α)·enrolled`. The smoothing factor adapts to maturity — a faster `α = 0.5` while the profile is young (≤ 50 samples) so it converges quickly, then a slower `α = 0.2` once mature so a single odd window cannot yank the template around. Only samples that *pass* update the template, so an impostor's motion never trains the model toward themselves.

**Why a 0.92 acceptance threshold for the continuous score (and 0.85 for gait)?**
The threshold is the entire risk dial. Too low and an impostor passes; too high and the legitimate user gets stepped up constantly (friction). 0.92 on the 9-dim continuous vector is deliberately strict — continuous auth runs constantly and a false accept is a security failure, so it errs toward stepping up. The dedicated *gait* variant (walking signature) uses a looser 0.85 because gait windows are inherently noisier and the gait check is one signal among several rather than a constant gate. Thresholds are per-signal, tuned to each signal's noise floor.

**Why "step up" rather than "log out"?**
A score below threshold does not mean "impostor" with certainty — it means "confidence dropped". The proportionate response is to demand a strong factor for the *next* sensitive action, not to nuke the session. If the real user re-authenticates, they continue; if it was a handoff, the strong factor blocks it. Logging out on every dip would make the feature unusable.

**Why a separate gait signature with its own feature extraction?**
Gait (walking rhythm) is a distinct, well-studied behavioral channel. Its signature is extracted differently — step count, step frequency, mean/std of acceleration magnitude, and the intervals between detected step peaks — and normalized into its own vector before cosine comparison. It is a higher-assurance, opt-in tier (the example marks gait-enrolled profiles as an elevated tier requiring proximity) precisely because a clean gait sample is harder to fake than a single held-still window. It requires a minimum number of step peaks to enroll, rejecting samples too short to be meaningful.

## Algorithm

### Continuous IMU signature

```
features(window) = [ ax, ay, az, gx, gy, gz, pitch, roll, yaw ]   // 9 dims

cosine(a, b) = dot(a,b) / (||a|| · ||b||)        // direction, scale-tolerant

verify(enrolled, sample, sampleCount):
  score = cosine(enrolled, sample)
  if score >= 0.92:
    α = sampleCount > 50 ? 0.2 : 0.5             // slow once mature
    enrolled = α·sample + (1-α)·enrolled          // EMA, accepted samples only
    return { pass: true, score, stepUp: false }
  else:
    return { pass: false, score, stepUp: true }   // demand strong factor next

# stepUp=true gates the NEXT sensitive action behind passkey/PIN; the session
# is NOT destroyed.
```

### Gait signature

```
gaitVector(g) = [ stepFrequency·10, meanMagnitude/10, stdMagnitude·5,
                  ...8 peak-intervals/500 (zero-padded) ]

enrollGait(sample):
  require sample.peakIntervals.length >= 2     // else: insufficient gait data
  store sample as elevated-tier template (proximity required)

verifyGait(enrolled, sample):
  score = cosine(gaitVector(enrolled), gaitVector(sample))
  return { pass: score >= 0.85, score }
```

## Reference implementation

See [`behavioral-auth.ts`](./behavioral-auth.ts) in this directory.

It uses only standard arithmetic — no external dependencies. Both the continuous 9-dim signature and the gait signature are implemented, with their respective thresholds and the EMA template update.

## Usage

```typescript
import {
  toFeatureVector,
  verifyContinuous,
  toGaitVector,
  verifyGait,
  CONTINUOUS_THRESHOLD,
  GAIT_THRESHOLD,
} from "./behavioral-auth.js";

// Continuous: compare a live window against the enrolled template.
const result = verifyContinuous(enrolledVector, liveSample, profile.sampleCount);
if (result.pass) {
  profile.enrolledVector = result.updatedEnrolled;  // EMA only on accept
  profile.sampleCount++;
} else if (result.stepUp) {
  requireStrongFactor();   // passkey / PIN before the next sensitive action
}

// Gait: higher-assurance, opt-in tier.
const g = verifyGait(enrolledGait, liveGait);
if (!g.pass) requireProximityOrStepUp();
```

## Limitations and extensions

- **Behavioral signals are soft, never primary.** A passing continuous score must not by itself authorize a high-value action; it is a confidence input that *avoids* friction when high and *adds* friction when low. The hard floor is always a strong factor (see guide 20).
- **Cosine ignores magnitude by design — and that cuts both ways.** Two different people producing similarly-*shaped* but differently-scaled motion can score high. Where magnitude is discriminative, add a magnitude-aware term or a per-dimension z-score.
- **EMA can be slowly poisoned only through accepted samples.** Because only passing samples update the template, an impostor cannot train it unless they already pass — but a patient attacker who barely passes could nudge it over time. Cap per-update drift and periodically require strong re-enrollment.
- **Thresholds are population-agnostic here.** 0.92 / 0.85 are reasonable defaults but ideally are calibrated per-user (and per-device) from a false-accept/false-reject sweep on real data.
- **Privacy.** Motion data is biometric. Keep feature extraction on-device, store only the reduced template, and treat the template as sensitive personal data.
- **Cold start.** A brand-new profile has no stable template; the fast `α = 0.5` shortens warm-up, but treat the first several windows as low-confidence and lean on the strong factor until the template matures.
