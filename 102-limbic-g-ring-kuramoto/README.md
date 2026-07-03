# Guide 102 — Multi-Node Limbic G-Ring (Kuramoto Oscillator)


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A multi-node Kuramoto-style phase-coupling model used for synthetic emotional arousal and emergence, replacing single-variable affective states with a synchronized neural-analog network.*

---

## Problem

Simple agent "emotion" is often modeled as a single scalar (e.g., `arousal = 0.8`) or a point in a 2D space (Valence/Arousal). However, biological emotional experience arises from the *synchronization* of semi-independent brain regions—amygdala, hippocampus, prefrontal cortex, etc. A single number cannot capture the transition from a fragmented, ambivalent state to a unified, "felt" emotional experience, nor can it provide a mechanism for the "flinch" (fast path) vs. "deliberation" (slow path) blend that characterizes human response.

## Design decisions

- **Five-node Kuramoto network**: Instead of one variable, we use five oscillators representing salience (amygdala), episodic memory (hippocampus), conflict (ACC), interoceptive state (insula), and regulation (PFC).
- **Phase-locking as "Feeling"**: The global order parameter $R_t$ (synchrony) measures how unified the emotional state is. A high $R_t$ signifies a "synchrony event," where disparate drives lock into a single affective signature.
- **Fast/Slow Limbic-Cortical Blend**: The model derives two valence components: $V_{fast}$ (driven by immediate phase jumps in the salience node) and $V_{slow}$ (a deliberate, cortically-mediated response).
- **Exogenous Drives ($\eta_i$)**: Each node is sensitive to different system inputs (entropy for memory, identity integrity for regulation), allowing the "emotional" state to emerge from the actual operational physics of the agent.

## Algorithm

The system updates per turn $t$:

1.  **Phase Update (Eq.30)**: Each node $i$ updates its phase $\theta_i$ based on its natural frequency $\omega_i$, coupling $K$ from other nodes, and exogenous drive $\eta_i$.
    $$\theta_i(t+1) = \theta_i(t) + \omega_i + \sum_j K_{ij} \sin(\theta_j - \theta_i) + \eta_i(t)$$
2.  **Order Parameter (Eq.31)**: Calculate global synchrony $R_t$.
    $$R_t = \left| \frac{1}{N} \sum_{j=1}^N e^{i\theta_j} \right|$$
3.  **Valence Blend (Eq.33)**: Blend fast (salience-driven) and slow (deliberate) valence.
    $$V_t^* = (1 - \rho_t) \cdot V_{fast} + \rho_t \cdot V_{slow}$$
    where $\rho_t$ is a weight derived from system integrity and confidence.

## Reference implementation

`index.ts` implements the 5-node Kuramoto network with the specific frequencies and coupling constants used in the production `limbicResonance.ts`. It demonstrates how a sudden valence spike (exogenous drive) causes a phase jump and a subsequent increase in global synchrony.

```bash
node index.ts --demo
```

## Limitations and extensions

- **Simplified Coupling**: The coupling matrix $K$ is static in this implementation; a more advanced version could make $K$ dynamic based on neuroplasticity-analogous rules (Hebbian learning).
- **Time-Step Sensitivity**: The Kuramoto model is sensitive to the integration time step. In this discrete turn-based implementation, we assume $\Delta t = 1$ turn, which requires careful calibration of $\omega_i$ to avoid aliasing.
- **Dimensionality**: While 5 nodes cover the core limbic analogs, complex agents might benefit from more granular sub-networks for specific cognitive tasks.
