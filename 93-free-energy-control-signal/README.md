# Guide 93 — Free-Energy-Style Control Signal for Behavioral Mode Gating


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A single scalar that fuses several unrelated pressure signals into one comparable "how cautious should I be right now" number, with clean thresholds mapped directly to behavior changes.*

---

## Problem

An agent runtime typically ends up with several independent signals that each say something about how much trouble the current turn might be in: how uncertain the retrieved context is, how far a fast/cheap execution path has drifted from the full-fidelity one, how much information a summarization step is throwing away, how intact the system's own core invariants are. Individually these numbers are useful for debugging, but nothing reads them together, so no single behavior change (be more conservative, ask before acting, prefer cheap reads over risky writes) is ever triggered by their *combination* — only by whichever one signal someone happened to wire up first.

## Design decisions

- **A weighted linear combination of already-bounded [0,1] components**, not a learned model — every input is understandable in isolation, so the fused signal's behavior is auditable by reading the weights, not by inspecting training data.
- **Signs matter and are explicit.** Some components should *raise* the caution signal (uncertainty, drift, information loss); one should *lower* it (how intact the system's core commitments currently are) and is subtracted. Getting a sign wrong here is a real bug class — a "protective" term that's actually additive will make the gate fire when it shouldn't.
- **Floor at zero, then squash with `tanh`.** The raw weighted sum has no natural upper bound and can be negative before any real pressure exists; flooring at zero keeps "no pressure" clamped to exactly the floor, and `tanh` gives a comparison-friendly value in (0,1) without needing to hand-tune the weights so their sum happens to equal 1.
- **Two fixed thresholds mapped straight to behavior, not just a display number.** A signal nobody acts on isn't a control signal, it's a metric. Crossing the lower threshold should change *something concrete* (surface more caveats, prefer cheaper operations); crossing the upper one should change something more consequential (ask before acting, restrict what's automatically allowed this turn).

## Algorithm

```
F   = pressure + α·drift + β·infoLoss − γ·structuralIntegrity
F   = max(0, F)                    // floor
Fn  = tanh(F)                      // squash to (0,1) for thresholding

regime =
  Fn ≥ CRITICAL  ? "critical"  :   // ask before acting; restrict write actions
  Fn ≥ ELEVATED  ? "elevated"  :   // prefer cheap/read operations; surface caveats
  "stable"                         // normal operation
```

## Reference implementation

`index.ts` runs synthetic sessions through the fused signal and checks two properties that matter more than any specific numeric output: **monotonicity** (raising any pressure component, holding the others fixed, never lowers F) and **protective direction** (raising the structural-integrity term, holding pressure fixed, never raises F). It also walks a full session trace through all three regimes and prints the resulting behavior-mode transitions.

```bash
node index.ts
```

## Limitations and extensions

- The weights (`α`, `β`, `γ`) are fixed constants here. Guide 98 covers making constants like these self-tune from labeled outcomes instead of staying hand-picked forever.
- This produces one scalar per turn from already-computed components; it says nothing about *where* the pressure is coming from. Guide 94 (interstitial loss accounting) is a natural upstream feed for the information-loss component, and Guide 97 (blended session uncertainty) is a natural feed for the pressure component.
- `tanh` squashing means very large raw sums compress into a narrow range near 1.0 — useful for stable thresholding, but it means the fused signal alone can't distinguish "somewhat over threshold" from "wildly over threshold." Keep the raw (pre-squash) value around in logs if that distinction matters for debugging.
