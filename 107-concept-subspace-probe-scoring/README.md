# Guide 107 — Concept Subspace Probe and Cross-Model Agreement Scoring


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*How to locate the subspace of a concept in embedding space (Concept Probe) and score whether two LLMs are in close enough agreement to share compact state (Agreement Scoring).*

---

## Problem

In a multi-model agent system (e.g., a cloud "server" model and a local "local" model), we often want to steer the local model toward a specific cognitive state without sending a heavy token stream. Traditional RAG relies on keyword or semantic search, which can be noisy. Furthermore, we need a way to quantify how well two models agree — if their embedding statistics (scale, drift, offset) diverge, transferring compact state becomes inefficient or misleading.

## Design decisions

- **PCA-Based Subspace Identification**: Instead of using raw embeddings, we identify the top-k principal components (the concept's subspace) for a concept. This reduces noise and captures the core semantic dimensions.
- **Ridge Probe**: We use ridge regression in the reduced subspace to find the specific direction (bias vector) that separates a concept's "trigger" prompts from negative or neutral samples.
- **Zero-Token Injection**: By identifying memories aligned with this bias vector, we can prime the model's context with existing semantic gravity rather than generating new tokens.
- **Eq.13 Agreement Score**: A coupling coefficient $K_{res}$ scores how closely two models' embedding statistics agree, based on their scale ($\omega$), drift ($\tau_d$), and offset ($\phi$).
- **Pure TypeScript Implementation**: All matrix operations (Power-iteration PCA, Gaussian elimination for Ridge) are implemented in pure TS to remain dependency-free and runnable in any Node.js environment.

> **Inspiration:** the agreement-score formula is loosely shaped after a coupled-oscillator resonance term — a functional analogy for combining three similarity signals into one score, not a claim that the models are physically coupled.

## Algorithm

### Concept Subspace Probe
```
1. Embed N trigger prompts (positive) and M negative prompts.
2. Center the embeddings and perform Power-iteration PCA to find top-k components R.
3. Project centered embeddings onto R to get low-dim coordinates Z.
4. Solve (ZᵀZ + λI)w = Zᵀy for probe weights w.
5. Lift w back to embedding space: bias = Rᵀ @ w.
6. Use bias vector to retrieve memories aligned with the concept's subspace.
```

### Cross-Model Agreement Score (Eq.13)
```
Kres = exp(−|ωs − ωl| / ωref) · exp(−|τs_d − τl_d| / τref) · cos(φs − φl)

- High Kres (>0.7): Models are in close agreement; use local completion from compact state.
- Low Kres (<0.2): Models disagree; rely on full token streams.
```

## Reference implementation

```bash
node index.ts --demo
```

## Limitations and extensions

- **Power Iteration**: The PCA implementation uses power iteration, which is efficient for top-k components but may converge slowly for very high ranks or near-degenerate data.
- **Linear Map**: This implementation focuses on finding the bias vector within a single model's space. A "Bridge" (implemented in production) adds a linear map to translate these vectors between different embedding models.
- **Static Signals**: In the demo, the scale/drift/offset signals are static. A production system would accumulate offset ($\phi = \omega \cdot turn \pmod{2\pi}$) across a conversation.
- **Scorer Complexity**: The probe uses simple ridge regression; non-linear probes (e.g., small MLPs) could capture more complex conceptual boundaries but would require a heavier runtime.
