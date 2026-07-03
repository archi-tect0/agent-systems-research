# Guide 103 — GPU VRAM Mesh + Invariant-Sector Affinity

*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A distributed GPU registry that routes inference requests to workers based on VRAM capacity, trust tiers, and "invariant sector" affinity — layers that remain stable across diverse inputs and are kept warm in VRAM for zero-reload latency.*

---

## Problem

Running large language models (LLMs) across a heterogeneous mesh of GPU workers (browsers, edge nodes, and core servers) presents two main challenges: 
1. **Heterogeneity**: Workers have vastly different VRAM capacities, reliability levels, and trust tiers.
2. **Cold-Start Latency**: Loading model weights or KV cache shards into VRAM is expensive. Naive load-balancing leads to frequent "cache misses" where workers must evict existing layers to load new ones, destroying throughput.

Specifically, early transformer layers (the "invariant sector") are often stable across diverse inputs. If a worker frequently switches between different model shards but lacks a strategy for these stable layers, it wastes cycles reloading what could have stayed warm.

## Design decisions

- **Trust-Tiered Hierarchy**: Workers are categorized into `browser` (ephemeral/low trust), `edge` (enrolled/medium trust), and `core` (first-party/highest trust). Routing scoring prefers higher tiers for stability.
- **Challenge-Response Enrollment**: To prevent peer ID spoofing, workers must prove possession of a secret (session token or signed key) against a server-issued nonce before being marked `online`.
- **Shard & Invariant Affinity Scoring**: The assignment engine uses a multi-factor score:
    - **KV Shard Affinity**: High bonus (+60) if the worker already holds the specific KV shard requested.
    - **Invariant-Sector Affinity**: Significant bonus (+40) if the worker has the "invariant sector" (early layers, e.g., 0–16) warm in VRAM. This allows the worker to serve any request starting within that range without reloading the base layers.
- **Lease-Based Lifecycle**: Workers aren't just "given" work; they are granted a `lease` with a deadline. If a worker fails or times out, the lease expires, and the worker's failure count incremented, potentially leading to revocation.
- **Incremental Heartbeats**: Workers report their current `inferenceLoad` and `shardsHeld` via periodic heartbeats, allowing the registry to make routing decisions based on near-real-time state.

## Algorithm

```
function scoreWorker(worker, request):
  score = trustTierBonus(worker.tier) - worker.load
  
  if request.shard in worker.shardsHeld:
    score += SHARD_AFFINITY_BONUS
    
  if worker.hasInvariantWarm(0, INVARIANT_MAX) and request.startsIn(0, INVARIANT_MAX):
    score += INVARIANT_AFFINITY_BONUS
    
  return score

function assign(request):
  candidates = registry.find(status="online", model=request.model)
  best = candidates.sortBy(w => scoreWorker(w, request)).first()
  
  if best:
    lease = createLease(best, request)
    best.status = "busy"
    return lease
  return null
```

## Reference implementation

`index.ts` simulates a mesh registry with multiple workers (a browser, an edge node, and a core node). It demonstrates:
1. Registration and challenge-response verification.
2. Routing a request to a worker with specific shard affinity.
3. Routing a request to a worker with invariant-sector affinity when no specific shard match exists.
4. Automatic revocation of workers that exceed the failure threshold.

```bash
node index.ts --demo
```

## Limitations and extensions

- **Simplified Proofs**: The reference implementation uses a simplified hex-check for signed keys; a production system uses full Ed25519 or mTLS verification.
- **Static Invariant Boundary**: The `INVARIANT_LAYER_MAX` is fixed. A more advanced system might dynamically determine which layers are "stable" based on activation drift monitoring.
- **No Cross-Model Affinity**: The current registry assumes affinity only within the same `modelId`. If models share architecture (e.g., Llama-3 8B and a fine-tune), weights could theoretically be shared, but this registry treats them as distinct.
- **Centralized Registry**: This model assumes a central coordinator. A fully decentralized mesh would require a gossip-based registry or a DHT for shard discovery.
