# Guide 107 — Resonance Probe + Coupling Engine


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*How to measure the attractor subspace of a concept in embedding space (Resonance Probe) and determine if two LLMs are phase-locked enough to share phase-modulated state (Resonance Coupling).*

---

## Problem

In a multi-model agent system (e.g., a cloud "server" model and a local "local" model), we often want to steer the local model toward a specific cognitive state without sending a heavy token stream. Traditional RAG relies on keyword or semantic search, which can be noisy. Furthermore, we need a way to quantify how "in sync" two models are—if their internal oscillation carriers (frequency, decoherence, phase) diverge, transferring conceptual state becomes inefficient or misleading.

## Design decisions

- **PCA-Based Subspace Identification**: Instead of using raw embeddings, we identify the top-k principal components (the "attractor subspace") for a concept. This reduces noise and captures the core semantic dimensions.
- **Ridge Probe**: We use ridge regression in the reduced subspace to find the specific direction (bias vector) that separates a concept's "trigger" prompts from negative or neutral samples.
- **Zero-Token Injection**: By identifying memories aligned with this bias vector, we can prime the model's context with existing semantic gravity rather than generating new tokens.
- **Eq.13 Resonance Coupling**: We implement the THB (Temporal Harmonic Brain) formula to compute a coupling coefficient $K_{res}$. This measures the phase-locking between models based on their frequency ($\omega$), decoherence ($\tau_d$), and phase ($\phi$).
- **Pure TypeScript Implementation**: All matrix operations (Power-iteration PCA, Gaussian elimination for Ridge) are implemented in pure TS to remain dependency-free and runnable in any Node.js environment.

## Algorithm

### Resonance Probe
```
1. Embed N trigger prompts (positive) and M negative prompts.
2. Center the embeddings and perform Power-iteration PCA to find top-k components R.
3. Project centered embeddings onto R to get low-dim coordinates Z.
4. Solve (ZᵀZ + λI)w = Zᵀy for probe weights w.
5. Lift w back to embedding space: bias = Rᵀ @ w.
6. Use bias vector to retrieve memories aligned with the concept's attractor.
```

### Resonance Coupling (Eq.13)
```
Kres = exp(−|ωs − ωl| / ωref) · exp(−|τs_d − τl_d| / τref) · cos(φs − φl)

- High Kres (>0.7): Models are phase-locked; use local completion from phase packets.
- Low Kres (<0.2): Models are out of resonance; rely on full token streams.
```

## Reference implementation

```bash
node index.ts --demo
```

## Limitations and extensions

- **Power Iteration**: The PCA implementation uses power iteration, which is efficient for top-k components but may converge slowly for very high ranks or near-degenerate data.
- **Linear Map**: This implementation focuses on finding the bias vector within a single model's space. A "Bridge" (implemented in production) adds a linear map to translate these vectors between different embedding models.
- **Static Phases**: In the demo, oscillator phases are static. A production system would accumulate phase ($\phi = \omega \cdot turn \pmod{2\pi}$) across a conversation.
- **Scorer Complexity**: The probe uses simple ridge regression; non-linear probes (e.g., small MLPs) could capture more complex conceptual boundaries but would require a heavier runtime.
