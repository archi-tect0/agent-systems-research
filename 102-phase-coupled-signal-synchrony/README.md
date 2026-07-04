# Guide 102 — Phase-Coupled Signal Synchrony (Kuramoto Model)


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A 5-node Kuramoto phase-coupling network that computes a synchrony order parameter (R_t) as a composite synchrony/urgency signal across five functional channels — salience, memory, conflict, saturation, and regulation — with a fast/slow blend so a sudden high-salience input can spike the fast path without waiting for the whole ring to synchronize.*

---

## Problem

A single-scalar signal (e.g., `arousal = 0.8`) or a 2D point (valence/arousal) can't capture the transition from a fragmented, inconsistent internal state to a unified one, nor can it provide a mechanism for a fast "reflex" path vs. a slower "deliberation" path blend.

## Design decisions

- **Five-node Kuramoto network**: Instead of one variable, we use five coupled oscillators, one per functional channel: salience (priority/magnitude spikes), memory (session-entropy load), conflict (rate of change of entropy — how fast internal state is destabilizing), saturation (how close a resource is to its limit), and regulation (a stabilizing signal driven by invariant/identity integrity). Each name describes what the channel's input signal is, nothing more.
- **Synchrony as a Composite Signal**: The global order parameter $R_t$ measures how unified the five channels are. A high $R_t$ marks a "synchrony event," where the channels lock into a single composite signal.
- **Fast/Slow Blend**: The model derives two output components: $V_{fast}$ (driven by immediate phase jumps in the salience node) and $V_{slow}$ (a deliberate, ring-wide response).
- **Exogenous Drives ($\eta_i$)**: Each node is sensitive to a different system input (e.g., entropy for the memory node, identity integrity for the regulation node), so the composite signal emerges from real operational metrics rather than being hand-set.

## Algorithm

The system updates per turn $t$:

1.  **Phase Update (Eq.30)**: Each node $i$ updates its phase $\theta_i$ based on its natural frequency $\omega_i$, coupling $K$ from other nodes, and exogenous drive $\eta_i$.
    $$\theta_i(t+1) = \theta_i(t) + \omega_i + \sum_j K_{ij} \sin(\theta_j - \theta_i) + \eta_i(t)$$
2.  **Order Parameter (Eq.31)**: Calculate global synchrony $R_t$.
    $$R_t = \left| \frac{1}{N} \sum_{j=1}^N e^{i\theta_j} \right|$$
3.  **Output Blend (Eq.33)**: Blend fast (salience-driven) and slow (ring-wide) output.
    $$V_t^* = (1 - \rho_t) \cdot V_{fast} + \rho_t \cdot V_{slow}$$
    where $\rho_t$ is a weight derived from system integrity and confidence.

## Reference implementation

`index.ts` implements the 5-node Kuramoto network with the specific frequencies and coupling constants used in the production implementation. It demonstrates how a sudden input spike (exogenous drive) causes a phase jump and a subsequent increase in global synchrony.

```bash
node index.ts --demo
```

## Limitations and extensions

- **Simplified Coupling**: The coupling matrix $K$ is static in this implementation; a more advanced version could make $K$ dynamic based on Hebbian-style learning rules.
- **Time-Step Sensitivity**: The Kuramoto model is sensitive to the integration time step. In this discrete turn-based implementation, we assume $\Delta t = 1$ turn, which requires careful calibration of $\omega_i$ to avoid aliasing.
- **Dimensionality**: While 5 nodes cover the core signal channels used here, complex agents might benefit from more granular sub-networks for specific tasks.
