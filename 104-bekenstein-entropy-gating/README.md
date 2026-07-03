# Guide 104 — Bekenstein Bound Entropy Gating with Admission Control

*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

*A cognitive admission-control pattern that uses an information-theoretic entropy ceiling to prevent session decoherence and context displacement.*

---

## Problem

LLM context windows are finite resources. When a session's total information content (the sum of active memories, tool outputs, and conversational state) approaches the context limit, new information begins to "displace" old information—often silently. Without a formal admission-control gate, an agent may continue to accept complex tasks that it fundamentally lacks the "room" to reason about coherently, leading to hallucinations, lost instructions, or "memory holes."

## Design decisions

- **Cognitive Analogue of the Bekenstein Bound**: We adapt the physical Bekenstein bound ($S \leq 2\pi RE / \hbar c$) by replacing physical constants with cognitive ones: Context tokens ($R$), reasoning depth ($E$), and a capacity constant ($\kappa$).
- **Entropy as a Unified Metric**: We treat the total Shannon entropy across all active subsystems as the "current information content." This allows us to compare disparate state (a database schema vs. a user's emotional state) on a single scale (nats).
- **Admission Control (Gating)**: Rather than just reporting saturation, the system acts as a gate. When saturation exceeds 85%, it triggers "active forgetting" (archiving low-confidence state). Above 100%, it must reject or compress new incoming information to maintain integrity.
- **Depth Expansion**: Recognizing that tool calls and multi-turn reasoning increase the "effective" energy of the system, we allow the bound to expand slightly as depth increases, justifying the extra tokens consumed by scratchpads and tool results.
- **Holographic Completeness**: We ensure the "boundary" of the session (the invariant set $G$) has sufficient degrees of freedom to encode the internal state. If $|G| < \log_2(S_{current})$, the session is "sub-holographic" and information loss is mathematically guaranteed.

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
    return SUB_HOLOGRAPHIC (Warn of inevitable loss)
    
  return OK
```

## Reference implementation

`index.ts` simulates a session accumulating entropy across multiple turns. It calculates the Bekenstein bound, monitors saturation, and demonstrates the admission gate rejecting a "large" state update that would exceed the cognitive capacity of the current context window.

```bash
node index.ts --demo
```

## Limitations and extensions

- **Entropy Estimation**: Measuring the "true" Shannon entropy of a natural language prompt is difficult; this implementation uses a heuristic based on token counts and complexity weights as a proxy.
- **Linear Scaling**: The $\kappa$ constant is empirically calibrated for current model architectures (e.g., GPT-4 level). Different models may have different "packing densities."
- **Dynamic Archiving**: A production system would pair this gate with an automated summarization/archiving engine that targets the exact "deficit" needed to stay below the 85% safety threshold.
