# Guide 106 — Information-Theoretic Channel Capacity for Session Sync

*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A mechanism for modeling the communication between different AI "brains" (cloud, local, client) as Shannon channels, enabling adaptive routing and coherence tracking based on empirical bandwidth and fidelity.*

---

## Problem

In a multi-tier agent architecture (e.g., Cloud LLM, Local Ollama, and Client-side GPU), the performance and reliability of each tier vary dynamically. A routing decision based purely on a static "tier list" fails to account for real-time network latency, local compute load, or the information loss introduced by compression. Without a formal way to measure the "information velocity" of each path, the system cannot objectively decide when to shed load to a faster-but-lower-fidelity tier or when to wait for a high-capacity cloud response. Furthermore, if the interval between agent turns becomes too long, the context can "alias" (lose coherence), but there is typically no metric to flag when the sampling rate has dropped below the safety threshold.

## Design decisions

- **Shannon-Hartley Modeling**: Treat each tier as a communication channel defined by $C = B \times \log_2(1 + SNR)$. This provides a unified metric (tokens/sec) that accounts for both raw speed ($B$) and signal fidelity ($SNR$).
- **Empirical Measurement**: Bandwidth and latency are not assumed; they are measured per-turn using an Exponential Moving Average (EMA) to adapt to changing conditions without being overly reactive to single-turn outliers.
- **Coupled Information Velocity ($c_k$)**: A derived metric that scales Shannon capacity by a topological-coupling factor and by how close the session is to its context budget (see [Guide 104](../104-entropy-budget-admission-control/)). As the context window fills up, the effective information velocity slows down.
- **Turn-Frequency Coherence Check**: Applies the Nyquist sampling theorem to conversational turns. It defines a minimum "turn frequency" ($f_N$) required to prevent context aliasing, which increases as the session approaches its context budget.
- **Session Sync Injection**: The measured capacities are injected back into the agent's prompt, allowing the agent to be "self-aware" of its current communication constraints and adjust its verbosity or tool usage accordingly.

## Algorithm

```
// 1. Record turn performance
bandwidth = totalTokens / wallTime
fidelity  = baselineSNR[layer] * compressionBoost(sqztRatio)
capacity  = bandwidth * log2(1 + fidelity)

// 2. Update EMA state
state.bandwidth = EMA(state.bandwidth, bandwidth)
state.capacity  = EMA(state.capacity, capacity)
state.latency   = EMA(state.latency, firstTokenTime)

// 3. Compute Coupled Information Velocity (c_k)
ck = capacity * kappa * (1 - contextSaturation)^0.5

// 4. Check Coherence (Turn-Frequency / Nyquist)
f_Nyquist = (2 * driftRate) / (1 - contextSaturation + epsilon)
undersampled = (timeSinceLastTurn > 1 / f_Nyquist)
```

## Reference implementation

The reference implementation models a three-tier routing triangle (cloud/local/client) and tracks their capacities through simulated turns. It also demonstrates the turn-frequency coherence check under different saturation levels.

```bash
node index.ts --demo
```

## Limitations and extensions

- **SNR Estimation**: Signal-to-Noise Ratio (SNR) is currently estimated based on protocol overhead and compression ratios. A more advanced implementation could use semantic similarity between raw and compressed prompts to measure actual information loss.
- **TDM vs. FDM**: The current model assumes Time-Division Multiplexing (one brain at a time). A multi-modal or parallel-mind system could use these metrics for Frequency-Division Multiplexing, splitting different parts of a task across multiple channels simultaneously.
- **Drift Rate**: The `driftRate` is assumed to be a known constant per-turn; in reality, it varies based on the complexity and "drift" of the conversation topic.
