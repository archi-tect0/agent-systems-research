# Guide 104 — Entropy-Budget Admission Control

*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*An admission-control pattern that uses an information-theoretic entropy budget to prevent runaway context growth and silent context displacement.*

---

## Problem

LLM context windows are finite resources. When a session's total information content (the sum of active memories, tool outputs, and conversational state) approaches the context limit, new information begins to "displace" old information—often silently. Without a formal admission-control gate, an agent may continue to accept complex tasks that it fundamentally lacks the "room" to reason about coherently, leading to hallucinations, lost instructions, or "memory holes."

## Design decisions

- **Entropy Budget as an Admission Gate**: We compute a ceiling on total Shannon entropy from context size and reasoning depth ($S_{max} = \kappa \cdot \log_2(R) \cdot depthFactor(E)$), and gate admission on the ratio of current entropy to that ceiling, rather than a raw token count.
- **Entropy as a Unified Metric**: We treat the total Shannon entropy across all active subsystems as the "current information content." This allows us to compare disparate state (a database schema vs. a user's emotional state) on a single scale (nats).
- **Admission Control (Gating)**: Rather than just reporting saturation, the system acts as a gate. When saturation exceeds 85%, it triggers "active forgetting" (archiving low-confidence state). Above 100%, it must reject or compress new incoming information to maintain integrity.
- **Depth Expansion**: Recognizing that tool calls and multi-turn reasoning increase the amount of information a session can usefully carry, we allow the budget to expand slightly as depth increases, justifying the extra tokens consumed by scratchpads and tool results.
- **Invariant Coverage Check**: We ensure the session's small set of "kernel invariants" $G$ (the compact facts it must never lose) has enough degrees of freedom to encode the internal state. If $|G| < \log_2(S_{current})$, coverage is insufficient and information loss becomes likely on the next compaction pass.

> **Inspiration:** the budget curve is loosely shaped after the Bekenstein bound (entropy capped by a boundary's degrees of freedom) — a functional analogy for capacity planning, not a physical claim about the system.

## Algorithm

```
function computeGating(totalEntropy, contextSize, depth):
  maxInfo = KAPPA * log2(contextSize / BASELINE) * depthFactor(depth)
  saturation = totalEntropy / maxInfo
  
  if saturation > 1.0:
    return REJECT (Hard limit hit)
  if saturation > 0.85:
    return WARN (Trigger active forgetting / archiving)
  
  requiredDOF = ceil(totalEntropy / ln(2))
  if requiredDOF > currentInvariants:
    return UNDER_PROVISIONED (Warn of likely loss on next compaction)
    
  return OK
```

## Reference implementation

`index.ts` simulates a session accumulating entropy across multiple turns. It calculates the entropy budget, monitors saturation, and demonstrates the admission gate rejecting a "large" state update that would exceed the capacity of the current context window.

```bash
node index.ts --demo
```

## Limitations and extensions

- **Entropy Estimation**: Measuring the "true" Shannon entropy of a natural language prompt is difficult; this implementation uses a heuristic based on token counts and complexity weights as a proxy.
- **Linear Scaling**: The $\kappa$ constant is empirically calibrated for current model architectures (e.g., GPT-4 level). Different models may have different "packing densities."
- **Dynamic Archiving**: A production system would pair this gate with an automated summarization/archiving engine that targets the exact "deficit" needed to stay below the 85% safety threshold.
