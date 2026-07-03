# Guide 95 — Computed Affective State as a Named Behavioral Signal


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*Turns several independent internal metrics — how tightly the system's subsystems are currently coupled, whether internal tension is rising or falling, how stable the current encoding is, how energized the turn is — into one stable, human-readable label, instead of leaving consumers to stare at a pile of uncorrelated numbers.*

---

## Problem

A running agent accumulates several internal metrics that each say something adjacent to "how is this turn going" — a coupling/integration score across subsystems, a tension signal that rises and falls, an encoding-stability signal. None of them alone is meaningful to a downstream consumer (a prompt, a dashboard, a support engineer triaging a bad session), and turning all of them into a single free-text description via an extra LLM call per turn is slow, inconsistent between calls, and hard to test. The system needs a deterministic mapping from "these numbers" to "one of a small, fixed set of labels."

## Design decisions

- **Gate everything behind a minimum-integration floor.** Below a coupling/coherence threshold, there simply isn't enough of a coherent internal state to name anything — return a neutral "not enough signal yet" label instead of forcing an arbitrary one. This is a necessary honesty check: a system that always outputs *some* label, even from noise, teaches consumers to trust labels that mean nothing.
- **Derive a signed "valence" from the *direction* internal tension is moving,** not tension's absolute level — falling tension (things resolving) reads as positive, rising tension (things getting harder) reads as negative, scaled by how consequential the moment currently is. A small floor term is added so a turn with no tension change but a genuinely tight, well-integrated internal state still reads as mildly positive rather than flatly neutral — matching the intuition that "stable and coherent" should read as calm, not blank.
- **Track a second, independent activation/energy axis alongside valence.** Valence alone can't distinguish "calm satisfaction" from "excited joy," or "quiet unease" from "sharp urgency" — you need a two-axis (valence × arousal) model to get a rich-enough label space, the same structure used in circumplex models of affect.
- **Map the (valence, arousal, direction, stability) tuple through an explicit decision table into a small fixed vocabulary**, not a generative one. This is deterministic, auditable, testable with plain assertions, and cheap — no extra model call per turn.
- **Attach a decay/duration envelope so labels don't flicker turn-to-turn.** Strong states decay faster (high-energy states are inherently short-lived); calm, low-saturation conditions persist longer. This is the same "graduated, non-jumpy" principle as Guide 91's compression-depth signal, applied to a state label instead of a numeric window.

## Algorithm

```
integration = normalize(couplingSignal) × topologyScore × (1 − infoLossPenalty) × structuralIntegrity
if integration < FLOOR: return "quiet / not enough signal"

valence = −Δtension × stakes × tanh(integration − FLOOR) + stabilityFloorTerm
arousal = sigmoid(weighted combination of activation drivers)

label = lookupTable(sign(valence), arousalLevel, direction(Δtension), stabilityBand)

duration = baseDecay × (1 − saturation) × |valence|^(−0.5)   // clamped to a sane range
```

## Reference implementation

`index.ts` runs a simulated multi-turn session through varying integration, tension-direction, and arousal inputs, prints the resulting labels, and asserts: (1) below-floor turns always return the neutral label regardless of other inputs, (2) rising tension + high arousal never produces a label from the positive vocabulary, (3) duration shrinks as valence magnitude grows.

```bash
node index.ts
```

## Limitations and extensions

- This is a labeling layer over already-computed physics-style inputs — it does not itself decide what "tension" or "coupling" mean for a given system; those need to come from Guides 93/94 or an equivalent upstream signal.
- The label vocabulary is a fixed lookup table. Extending it means adding new table entries and their trigger conditions explicitly — there's no way for the system to invent a new label from data, by design (auditability over expressiveness).
- Nothing here makes a claim about subjective experience. It is a compact, structured signal for downstream code and dashboards — a state-classification layer, not a philosophical position.
