# Guide 105 — Parallel Mind Background Physics Engine


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A physics-based model for managing background task cognitive load and thread return pressure, ensuring that autonomous agent work doesn't saturate the primary context.*

---

## Problem

Autonomous agents often need to perform long-running background tasks (research, media verification, memory consolidation) while maintaining a responsive primary conversation. If these tasks are unconstrained, they can saturate the agent's "Parallel Mind," leading to cognitive incoherence, high resource costs, or a cluttered context window. There is no simple way to balance the urgency of completing a background task against the immediate needs of the user without a formal model.

## Design decisions

- **Bekenstein Saturation Limit**: Inspired by the Bekenstein bound (see [Guide 104](../104-bekenstein-entropy-gating/)), we enforce a hard limit on concurrent background tasks (default = 3). This prevents the "Parallel Mind" from fragmenting too far.
- **Entropy-Based Load (Eq. 24)**: Instead of a flat count, we measure the "cognitive load" (entropy) using status-weighted priorities. A task that is still `queued` (unstarted) imposes more uncertainty/load than one that is `active` or already `verifying` results.
- **Decaying Return Pressure (R_i) (Eq. 25)**: As time passes, the "pressure" to return to a background thread decays. This models the human-like tendency to "forget" a task if it hasn't been attended to, but prioritizes high-priority tasks for re-integration into the main conversation.
- **Priority-Weighted Urgency**: Higher priority tasks contribute more to the background entropy and maintain higher return pressure for longer periods.

## Algorithm

```
# Eq.24: Background Entropy Load
H_bg = 1 - exp(−Σ_i w_i × u_i)
  where:
    w_i = task_priority / 10
    u_i = status_weight (queued: 1.0, active: 0.7, verifying: 0.5)

# Eq.25: Thread Return Pressure
R_i = χ_i × exp(−Δt_i / t_half) × (1 − C_merge)
  where:
    χ_i = task_priority / 10
    Δt_i = time since task creation
    t_half = half-life for return (default 30m)
    C_merge = context merge cost (default 0.3)
```

## Reference implementation

`index.ts` implements a `BackgroundManager` that manages a task queue and calculates both Eq. 24 and Eq. 25. It demonstrates entropy reduction as tasks move towards completion and pressure decay over time.

```bash
node index.ts --demo
```

## Limitations and extensions

- **Static status weights**: The weights for `queued`, `active`, and `verifying` are empirical; a more sophisticated system might adjust these based on the specific `kind` of task (e.g., `research` vs `memory_consolidation`).
- **Linear decay**: Eq. 25 uses an exponential decay for return pressure. While this matches many physical systems, different task types might benefit from different decay profiles (e.g., a "deadline" task might have *increasing* pressure as the deadline approaches).
- **Single-wallet focus**: The current implementation assumes a per-wallet (user) limit. In a multi-tenant environment, global resource constraints might also need to be factored into the entropy calculation.
