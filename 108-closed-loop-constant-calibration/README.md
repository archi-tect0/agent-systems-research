# Guide 108 — Closed-Loop Constant Calibration with Synthetic Warmup

*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A self-tuning mechanism that uses empirical outcomes from live or synthetic turns to update internal system constants via a bounded EMA, preventing drift and ensuring alignment with observed performance.*

---

## Problem

Heuristic-based agent systems rely on "magic constants" (thresholds, coupling weights, decay rates) that are often tuned manually during development. However, the optimal values for these constants may shift as the underlying models change, user behavior evolves, or new capabilities are added. A static threshold that worked well for a specific model version might become too loose or too restrictive, leading to degraded quality or increased risk. Manually re-tuning dozens of interconnected constants across a production fleet is fragile and slow.

## Design decisions

- **Closed-Loop Feedback**: The system records per-turn "observations" (internal state like entropy or criticality) and later joins them with "outcome events" (real-world results like user satisfaction, task success, or memory recall hits). The residual error between predicted and actual outcomes drives the update.
- **Bounded Exponential Moving Average (EMA)**: To prevent radical swings from noisy data or "calibration poisoning," updates are limited to a small percentage (e.g., ≤5%) of the current value per calibration run.
- **Bootstrap Gate**: Calibration only starts after a minimum density of samples (e.g., 30 samples) is reached, ensuring the update signal isn't derived from a tiny, unrepresentative window.
- **Synthetic Warmup Harness**: To avoid a "cold start" where the system runs on suboptimal defaults for days while waiting for real traffic, a warmup engine generates synthetic observations and outcomes using the same scoring functions used in production and a reproducible random generator.
- **Namespaced Synthetic Wallet**: Synthetic data is tagged with a dedicated "phantom" wallet identifier (e.g., `phantom:calibration-warmup`). This ensures that synthetic telemetry can seed the calibration engine without polluting real user analytics or identity state.
- **Invariant Safety Rails**: Hard bounds and logical invariants (e.g., `T_WARN` must always be less than `T_CRITICAL`) are checked before any update is committed. If a calibration run would break an invariant, it is rolled back.

## Algorithm

```
// Periodic Calibration Tick (e.g., every 15 mins)
function runCalibration():
  constants = loadCurrentConstants()
  samples = queryJoinedObservationsAndOutcomes(limit: 200)
  
  if samples.length < MIN_SAMPLES:
    return // Not enough data
    
  for each constant in constants:
    residual = computeResidual(samples, constant)
    if residual is not null:
      // Apply learning rate and max-step bound
      step = alpha * residual
      maxStep = constants[constant] * 0.05
      clampedStep = sign(step) * min(abs(step), maxStep)
      
      constants[constant] = clampToHardBounds(constants[constant] + clampedStep)
      
  if checkInvariants(constants):
    saveConstants(constants)
    recordAuditLog(constants, residuals)
  else:
    rollback()

// Warmup Harness (Boot-time or on-demand)
function runWarmup(n_samples):
  for i from 1 to n_samples:
    inputState = generateRealisticRandomState(seed: i)
    observations = executeScoringFunctions(inputState)
    outcomes = generateSyntheticOutcomes(observations)
    
    writeToDb(wallet: "phantom:calibration-warmup", observations, outcomes)
```

## Reference implementation

`index.ts` demonstrates a simplified calibration loop. It seeds a mock database with synthetic "warmup" data where a threshold is intentionally set incorrectly, then runs several calibration ticks to show the threshold converging toward the optimal value while respecting step-size bounds.

```bash
node index.ts --demo
```

## Limitations and extensions

- **Simplicity of Scorer**: The reference implementation uses a simple accuracy/precision-based residual. Real-world systems might use more complex Brier scores or log-likelihood for probabilistic thresholds.
- **No Multi-Variable Optimization**: This pattern tunes constants independently. A more advanced version might use a gradient-descent approach to optimize a global loss function across multiple interdependent constants.
- **Drift Canary**: While EMA bounds provide some protection, a "canary" that compares current constants against a known-good baseline can help detect long-term systematic drift caused by feedback loops.
- **Contextual Calibration**: Constants are currently global per-system. A future extension could allow per-user or per-domain calibration where some environments require higher sensitivity than others.
