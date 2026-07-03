# Session Static Manifest (SSM)


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

Every LLM session has two distinct components in its context window:

1. **Static blobs** — the system prompt, personality configuration, tool catalog, and capability grants. These are identical across every turn within a session and often identical across many sessions on the same server.
2. **Dynamic context** — the conversation history, retrieved memories, retrieved knowledge, tool results, and the current user message. This changes every turn.

Two inefficiencies arise from treating these the same way:

**Compression table cold start.** If you use a session-local phrase dictionary (see guide 03 — SQ-B), the table starts empty. The first few turns of every session produce poor compression because the model hasn't seen enough text to build a useful vocabulary. But the static blobs are available at boot time, before any user connects. Pre-seeding the symbol table from these blobs gives every new session a rich vocabulary from turn 1.

**Redundant provider billing for static content.** Anthropic and Google both offer prompt caching: if the system-prompt prefix is identical between calls, they charge a reduced rate (or nothing) for the cached portion. But their caching requires the prefix to be byte-identical and flagged with a `cache_control` header. Knowing the stable hash of the static portion lets you attach this header correctly — and detect when a grant change invalidates the cache.

## Design decisions

**One global seed, applied per-session.**  
At server boot, concatenate all static blobs (system prompt, knowledge base, tool catalog) into a single seed string. Store this globally. When a new session's first turn starts, clone the global seed's vocabulary into that session's symbol table. Subsequent turns skip the seeding step because the vocabulary is already populated. This means the cost of seeding (iterating through 3 000-character chunks and extracting n-grams) is paid once at boot, not once per session.

**Per-session hash tracking.**  
Store a short SHA-256 hash of the static portion per active conversation. When building a prompt, recompute the hash and compare. If it matches, attach `cache_control: {"type": "ephemeral"}` to the Anthropic message or use the cached Gemini context name. If it doesn't match (a capability grant was added or revoked mid-session), skip the cache and invalidate the external provider cache.

**Cap at 512 live sessions.**  
The SSM map is in-process memory. At 512 entries (two small integers per entry), this is negligible. The cap prevents unbounded growth if conversations are never explicitly closed — evict the oldest entry on overflow.

**3 000-character ingest chunks.**  
Ingesting the full seed as one pass would produce mostly low-frequency n-grams (each phrase appears only once). Chunking at 3 000 characters ensures that phrases spanning chunk boundaries are still discovered on the overlapping-region ingest. This is a practical approximation — it's not necessary for correctness, only for completeness.

## Algorithm

```
// Boot time
static_seed = concat(system_prompt, knowledge_blob, tool_catalog, capability_manifest)
global_seed_text = static_seed

// First turn of a new session
if not ssm[conv_id].seeded:
  for chunk in chunks(global_seed_text, 3000 chars):
    session_symbol_table.ingest(chunk)
  ssm[conv_id].seeded = true

// Every turn (for provider caching)
static_hash = sha256(static_portion)[0:12]   // 12 hex chars, compact
if ssm[conv_id].hash != static_hash:
  ssm[conv_id].hash = static_hash
  // mark Anthropic / Gemini cache as stale
```

## How it interacts with SQ-B (guide 03)

The global seed pre-populates each session's symbol table with phrases from the static blobs. This means phrases like "the user's wallet address" or "tool: navigate_to" — which appear in the system prompt and will also appear in conversation turns — are already in the vocabulary with high byte-savings scores. When the conversation starts and these phrases appear in user messages and model responses, the symbol table treats them as high-frequency candidates immediately rather than waiting for them to accumulate frequency naturally.

The pre-seeded entries start with `frequency=1` (from the boot ingest), so they rank lower than phrases that have appeared multiple times in the live conversation. But they still pass the entropy gate and occupy table slots, ready to be promoted when they recur.

## How it enables provider prompt caching

```typescript
// Anthropic example
const staticHash = hashStaticBlob(systemPrompt + knowledgeBlob);

if (staticHashMatches(convId, staticHash)) {
  // The static prefix hasn't changed — safe to use cached version
  messages = [
    {
      role: "user",
      content: [
        { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
        { type: "text", text: dynamicContext },
      ],
    },
    ...conversationHistory,
  ];
} else {
  // Static content changed (e.g. new capability grant) — rebuild without cache
  setStaticHash(convId, staticHash);
  messages = buildMessagesWithoutCache(...);
}
```

Anthropic charges ~10% of normal input token price for cache hits on the static prefix. For sessions with many turns and a large system prompt, this reduces cost significantly.

## Reference implementation

See [`session-static-manifest.ts`](./session-static-manifest.ts) in this directory.

## Usage

```typescript
import {
  setGlobalStaticSeedText,
  preSeedSymbolTable,
  hashStaticBlob,
  setStaticHash,
  staticHashMatches,
} from "./session-static-manifest.js";

// 1. At boot, register the server-wide static content (system prompt + knowledge base).
setGlobalStaticSeedText(systemPrompt + knowledgeBase);

// 2. On a session's first turn, pre-seed its symbol table from the static content
//    so repeated phrases compress from turn one instead of warming up over time.
preSeedSymbolTable(convId, ingestableTables);

// 3. Each turn, decide whether the provider prefix cache is still valid.
const staticHash = hashStaticBlob(staticBlob);
if (staticHashMatches(convId, staticHash)) {
  // Reuse the cached static prefix — only the dynamic tail is re-billed.
} else {
  setStaticHash(convId, staticHash); // static content changed; rebuild the prefix
}
```

## Limitations and extensions

- **In-process only.** The SSM map lives in process memory and is not persisted to the database. A server restart resets all seeded flags — sessions pick up from a fresh-seeded state on their next turn. This is acceptable because the boot seed is deterministic and fast.
- **Assumes static content is truly static.** If your system prompt changes frequently (e.g. per-user system prompts with highly variable content), pre-seeding is less effective. The approach works best when the core system prompt and knowledge base are server-wide constants.
- **Hash-based cache invalidation is conservative.** Any change to the static portion (even adding a single capability grant) invalidates the entire provider cache for that session. Finer-grained invalidation (caching each static section independently) is possible but significantly more complex.
