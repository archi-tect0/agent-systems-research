# Manifest-Driven LoRA Expert Router


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A local inference stack can host many small fine-tuned adapters — LoRA "experts" — each teaching one narrow, stable capability: formatting tool calls, reviewing a transaction for risk, synthesizing a world model from raw conversation, operating memory. Keeping each capability in its own adapter is attractive because each can be trained, evaluated, and upgraded independently, and each carries an explicit boundary describing what it does and does not do.

But hosting many adapters raises a routing question that has to be answered *before* the base model runs: for this particular turn, which adapter(s) should be activated? Loading the wrong expert wastes the activation budget and can degrade output (a transaction-review adapter is unhelpful when the user is making small talk). Loading none, when one clearly applies, leaves quality on the table. And activating an adapter that has been trained but not yet validated for production is a correctness risk.

The selection must also be cheap. It runs on the hot path of every turn, so it cannot itself invoke a model. It needs a fast, declarative decision driven by signals already available: the classified intent of the turn and the raw user text.

This router answers that with a manifest. Every adapter declares the intent kinds it serves, a trigger-term regex matched against the user text, a deployment status, and a capability list. Selection scores each *deployed* adapter by intent-kind match plus trigger-term match, returns the top matches in priority order, and falls through to the unaugmented base model when nothing matches or nothing is deployed.

This is deliberately distinct from a **prefix-weight compiler** (guide 30), which fuses adapter weights ahead of time into a single artifact. There, the experts are merged before inference; here, the manifest *is* the routing table, adapters stay modular and separately swappable, and the activation decision is made per-turn at request time.

## Design decisions

**Why a declarative manifest instead of hard-coded routing logic?**
Each adapter advertises its own activation criteria (intent kinds, trigger terms) and its capability boundary alongside its weights. Adding, removing, or retuning an expert is a data change to the manifest array, not a rewrite of the router. The router stays a small, stable scoring loop.

**Why is status — specifically "deployed" — a gate?**
An adapter moves through `not_trained` → `training` → `ready` → `deployed`. Only `deployed` adapters are ever activated. A `ready` adapter has weights but has not been promoted to production; routing to it would expose users to an unvetted expert. Gating on status means the same manifest can describe the full roadmap while only the validated subset participates in routing. `markDeployed` flips an adapter to `deployed` at boot when its weight file is found.

**Why score on both intent kind and trigger terms?**
Intent kind is the strongest signal (weight 10) — it is a structured classification of what the turn is about. Trigger terms (weight 8) are a regex over the user text that catches cases the intent classifier may have labeled broadly. Combining them lets a turn that is, say, `intent=wallet` *and* mentions "unlimited approval" score higher on the transaction-guard expert than on a generic wallet expert.

**Why return up to two adapters within a "close band"?**
Some turns legitimately span two experts — approving a transaction that the user also wants remembered. After sorting by score, any runner-up within `CLOSE_BAND` (3 points) of the top is also returned, capped at two. This lets the stack load both relevant experts without diluting clearly single-expert turns.

**Why fall through to the unaugmented base model on no match?**
Forcing an adapter onto an unrelated turn is worse than running plain. When no deployed adapter scores above zero, selection returns an empty set and the base model runs as-is. "No expert" is a valid, safe routing outcome.

**Why cap the scanned user text?**
Only the first 800 characters are matched against trigger regexes. Trigger terms that signal intent appear early in a request; scanning the whole of a very long paste would add cost without improving the decision.

## Algorithm

```
selectAdapters(intentKind, userText, library = ADAPTER_LIBRARY):
  text = userText[0..800]

  scored = for each adapter m in library where m.status == "deployed":
             score = 0
             if m.triggerKinds contains intentKind:  score += KIND_WEIGHT (10)
             if m.triggerTerms matches text:          score += TERM_WEIGHT (8)
             yield { m, score }

  scored = scored where score > 0, sorted by score descending

  if scored is empty:
    return { adapters: [], primary: null, reason: "no_match: base model runs unaugmented" }

  top = scored[0]
  selected = scored
               where (top.score - score) <= CLOSE_BAND (3)   // runners-up
               take first 2
               map to adapter
  return {
    adapters: selected,
    primary:  selected[0],
    reason:   "matched intent=<kind> top=<id> score=<n>",
  }

markDeployed(library, id, modelFile):
  m = library.find(id)
  if not m: return false
  m.status = "deployed"; m.modelFile = modelFile
  return true
```

## Reference implementation

See [`lora-manifest-router.ts`](./lora-manifest-router.ts) in this directory.

It runs on Node.js built-ins only — no external dependencies. The manifest (`ADAPTER_LIBRARY`) is plain data, so a real deployment substitutes its own adapter list and weight files. The production source (`loraLibrary.ts`) extends the same scoring model with an additional tool-family overlap signal, but the intent-kind + trigger-term core is identical.

## Usage

```typescript
import {
  selectAdapters,
  markDeployed,
  ADAPTER_LIBRARY,
  type AdapterManifest,
  type AdapterSelection,
} from "./lora-manifest-router.js";

// Route a turn: pass the classified intent kind and the raw user text.
const sel: AdapterSelection = selectAdapters(
  "wallet",
  "should I approve this unlimited token allowance?",
);
// sel.adapters -> [transaction_guard, ...]
// sel.primary  -> the highest-scoring AdapterManifest (or null)
// sel.reason   -> human-readable explanation

if (sel.primary === null) {
  // no deployed adapter matched — run the base model unaugmented
} else {
  for (const adapter of sel.adapters) {
    loadAdapterWeights(adapter.modelFile); // your loader
  }
}

// Promote an adapter to "deployed" at boot when its weight file is found.
markDeployed(ADAPTER_LIBRARY, "memory_operator", "memory_operator:v1");

// Route against a custom library instead of the default:
const customLib: AdapterManifest[] = [/* ... */];
selectAdapters("tool_use", "run a web search", customLib);
```

## Limitations and extensions

- **Keyword triggers are coarse.** Trigger-term regexes catch surface phrasing, not meaning. A turn that needs an expert but avoids its trigger words may miss; conversely an unrelated turn that happens to contain a trigger word may match. A learned classifier could replace or supplement the regex layer.
- **Static integer weights.** `KIND_WEIGHT`, `TERM_WEIGHT`, and `CLOSE_BAND` are hand-tuned constants. They are not learned from routing outcomes; tuning them is a manual exercise.
- **At most two adapters.** The close-band cap returns two experts maximum. Stacks that can compose more (or that have a hard one-adapter limit) must adjust the selection slice.
- **No runtime cost/latency awareness.** Selection scores relevance only; it does not weigh an adapter's load time or VRAM footprint. A budget-aware variant would factor those in.
- **Status is the only deployment gate.** The router trusts that a `deployed` adapter's weights are actually present and healthy. Verifying the weight file at activation time is the caller's responsibility.
- **Not weight fusion.** Unlike a prefix-weight compiler (guide 30), adapters are kept modular and chosen per-turn; this trades the lower per-call overhead of a pre-fused artifact for independent upgradeability and explicit capability boundaries.
```
