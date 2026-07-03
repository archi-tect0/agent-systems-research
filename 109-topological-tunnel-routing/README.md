# Guide 109 — Topological Tunneling Gain via Memory Graph Analysis

*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A multi-hop information-routing mechanism that uses Topological Data Analysis (TDA) to measure memory connectivity and modulate recall confidence and session channel capacity.*

---

## Problem

In large-scale agent memory systems, recall is often treated as a flat retrieval task (e.g., top-K vector search). However, memory is naturally structured as a graph of related concepts. When these concepts form isolated "islands" (disconnected components) or "holes" (circular dependencies without a central anchor), information cannot flow freely. A standard retrieval might find a relevant fact, but if that fact is topologically isolated from the current reasoning context, the agent's confidence in using it should be lower, as the "tunneling cost" to bridge those regions is high.

## Design decisions

- **Topological Invariants as Proxies**: Instead of expensive persistent homology calculations on every turn, we use Betti numbers (β₀ and β₁) as fast proxies for graph connectivity.
  - **β₀ (Zeroth Betti Number)**: The number of connected components (concept clusters). More clusters generally increase potential channel capacity (more diverse knowledge) but can fragment the space.
  - **β₁ (First Betti Number)**: The number of independent loops or "holes". In our implementation, we proxy this by counting "sparse" clusters (those with very few members), which represent fragmented regions where information is trapped or missing links.
- **Topological Tunneling Gain (G_topo)**: An exponential decay function `exp(−β₁ / (β₀ + 1))`. When the graph has many holes (high β₁) relative to its connectivity (β₀), the gain drops toward zero, suppressing the confidence of cross-cluster recalls.
- **Capacity Coupling (κ_topo)**: A linear multiplier for session channel capacity. A well-connected graph (high β₀ with low β₁) boosts effective capacity, while a loopy, fragmented graph penalizes it.
- **Fast DB-Level Approximation**: The production system derives these numbers directly from SQL aggregates over the `agent_memories` and `memory_concept_clusters` tables, enabling turn-by-turn adaptation without significant latency.

## Algorithm

```
# β₀ = number of distinct non-null clusters
# β₁ = number of sparse clusters (members < 3)

G_topo = exp(−β₁ / (β₀ + 1))

κ_topo = 1.0 + (β₀ − 1) × 0.05 − β₁ × 0.08
κ_topo = max(0.1, κ_topo)

# Recall confidence adjustment:
finalConfidence = rawConfidence * G_topo (if recall bridges clusters)
```

## Reference implementation

`index.ts` simulates a memory graph with varying connectivity. It demonstrates how "healthy" clusters (many members, no holes) provide maximum tunneling gain and a capacity boost, while "fragmented" clusters (sparse members, many holes) trigger topological suppression.

```bash
node index.ts --demo
```

## Limitations and extensions

- **Proxy Accuracy**: The use of sparse clusters as a proxy for β₁ is a heuristic. A more robust implementation would use a Vietoris-Rips complex and persistent homology, though this requires significantly more compute.
- **Dynamic Topology**: The current model assumes a static view of the graph during a single turn. Real-time updates to the topology (e.g., as the agent "learns" and merges clusters) could be used to drive "aha!" moments when a topological hole is closed.
- **Identity Masking**: While this mechanism is called a "tunnel," it is distinct from cryptographic onion routing. It describes information "routing" through concept space, not the obscuring of network identities (which is handled by Guide 59).
