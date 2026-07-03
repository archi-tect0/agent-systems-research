# Guide 99 — Implicit Preference Distillation from Binary Feedback


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*Turns cheap thumbs-up/down signals into durable, per-dimension style weights and structured contrastive training pairs, without hand-labeling anything.*

---

## Problem

A binary rating (thumbs up / thumbs down) on a response is nearly free to collect but nearly useless in raw form — it says "this was good" or "this was bad," not *what specifically* was good or bad. Turning that into something actionable requires: (a) durable, per-dimension style weights the system can read cheaply on every subsequent turn to adjust its own behavior, and (b) structured contrastive pairs a downstream fine-tuning pipeline can train on — both without a human ever labeling *why* a rating was positive or negative.

## Design decisions

- **A small bank of cheap heuristic detectors run against the rated response text**, rather than an extra model call per rating. Structural detectors (has a list, includes code, is long, is short) and tonal detectors (formal-marker words present, casual-marker words present) are fast, deterministic, and good enough to correlate with *some* of what a rating is actually reacting to.
- **Each detector's signal is multiplied by the rating's sign** (up = +1, down = −1) before being folded into a weight. A "has a list" detector firing on an up-rated response pushes the list-preference weight up; the same detector firing on a down-rated response pushes it down.
- **Per-(identity, signal) EMA weights, decoupled from each other.** Multiple independent style dimensions (brevity, structure, tone) should each converge at their own pace from their own evidence — mixing them into one aggregate score would hide which specific dimension a user actually cares about.
- **A slow EMA blend, not a hard overwrite**, so one outlier rating doesn't swing a weight to an extreme — the same "smooth, not jumpy" principle used for compression-depth (Guide 91) and calibration constants (Guide 98).
- **Contrastive pairs are queued separately with an explicit status field** (`pending` → `training` → `done`) rather than trained on immediately — this lets a downstream training job claim work without racing another consumer, and keeps the fast, synchronous rating-processing path free of any dependency on when training actually runs.
- **Failures are isolated per detector.** One detector throwing (a malformed response, an edge case in the heuristic) must not prevent the other detectors' weights from updating — style-weight extraction should degrade gracefully, not atomically fail.

## Algorithm

```
sign = rating === "up" ? +1 : -1

for each detector d in detectorBank:
  signal_d = d(responseText) × sign          // detector emits a value in [-1, 1] or {0, ±1}
  try:
    weight[identity][d.name] = weight[identity][d.name] * (1 - α) + signal_d * α
    weight[identity][d.name] = clamp(weight[identity][d.name], -1, 1)
  catch: log and continue                    // isolate detector failures

enqueue trainingPair({ chosen: ratedText, rejected: alternativeText, status: "pending" })
```

## Reference implementation

`index.ts` feeds a sequence of rated responses with known structural properties (long vs. short, bulleted vs. not) and alternating up/down ratings through the pipeline, then verifies: (1) each style weight converges toward the sign implied by its correlated ratings, (2) weights stay clamped within bounds even under a long run of consistent ratings, (3) a simulated detector failure for one signal does not prevent other signals from updating that same round, and (4) queued training pairs carry the correct `pending` status and preserve chosen/rejected text.

```bash
node index.ts
```

## Limitations and extensions

- Heuristic detectors are a correlation, not a causal explanation — a user might dislike a long response for a completely unrelated reason, and the "brevity" weight would still shift. This is an acceptable tradeoff for a cheap, always-on signal; it is not a substitute for structured feedback surveys if you need ground truth.
- The EMA rate (`α`) controls how quickly a weight reacts to new ratings versus how much history it retains — tune it per deployment; a very active user profile can afford a slower rate than a sparse one.
- This guide only closes the loop up to enqueuing training pairs; the training job itself (dequeue, batch, fine-tune, mark `done`) is out of scope and highly specific to whatever training stack consumes the queue.
