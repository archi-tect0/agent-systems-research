# Speculative Tool Prefetch from Stream Heads

## Problem

An agent runtime that lets a language model call tools usually runs in phases: the model streams its response, then — once generation is far enough along — a dispatch phase parses out the tool calls and executes them. Those tools (read a vault entry, recall a memory, run a search) often involve I/O with real latency. Because dispatch is serial after generation, the user waits for the model to finish *and then* waits again for the tool round-trip. On common repeated paths that second wait is pure dead time.

But the model usually telegraphs its intent early. By the time it has streamed "Let me open your vault…", it is very likely about to call a vault-read tool with a predictable argument. The information needed to guess the tool call exists long before the dispatch phase formally produces it.

The idea is to exploit that gap. While the model is still streaming the *head* of its response, a small, cheap predictor inspects the first N tokens and guesses which tools are about to be called. Each confident guess is executed in the background immediately. By the time the real dispatch phase fires, the result is already sitting in a cache — turning a serial round-trip into a near-zero-latency cache hit.

The hard constraint is that this must be free when it's wrong. A misprediction has to be completely harmless: the speculative work that no one consumes simply expires, its in-flight request is aborted, and — critically — the foreground response path is never blocked, slowed, or corrupted by prefetch activity. Prediction errors are swallowed, prefetch emits are no-ops, and failed prefetches are not cached so the real dispatch handles them normally.

## Design decisions

**Why fire prediction off the stream head instead of the full response?**
The whole point is to overlap tool execution with generation. Waiting for the complete response to predict would leave no time to hide. Prediction fires once, exactly when `activationTokens` have been observed — early enough to win the race, late enough that the head carries real signal.

**Why a confidence threshold?**
Speculative execution spends real resources (a tool call, possibly billable I/O). Only predictions at or above `confidenceThreshold` are worth that spend. Low-confidence guesses are dropped rather than gambled on, keeping wasted work bounded.

**Why a content-addressed cache key (sha256 of stable-stringified args)?**
A prefetched result is only reusable if the real call has the *same* tool name and *same* arguments. Hashing a deterministic, key-sorted serialization of the args means `{a,b}` and `{b,a}` collide to the same key, so a correct prediction with semantically-equal arguments is recognized as a hit even if the key order differs.

**Why a TTL on cache entries?**
A prefetch that is never consumed must not leak. Each entry carries `expiresAt = createdAt + ttlMs`; on consume, an expired entry is aborted and deleted, returning a miss. The TTL bounds how long speculative work and its result linger.

**Why does `consume` return null while a prefetch is still computing?**
If the prediction was right but the background tool hasn't resolved yet (`done === false`), there is no result to hand back. Returning null tells the caller to run the tool itself rather than block waiting on the speculative copy — the foreground never stalls on prefetch.

**Why never cache a failed prefetch?**
If the speculative execution throws, the entry is deleted instead of caching the error. The real dispatch then runs the tool normally and surfaces any genuine failure through the proper path — prefetch failures never become user-visible.

**Why swallow predictor errors entirely?**
The predictor is best-effort. If it throws or returns garbage, `runPrediction` simply returns. A broken predictor degrades to "no prefetch," never to "broken response." The same principle makes the prefetch context's emit a no-op so speculative side effects can't reach the user's active stream.

## Algorithm

```
class SpeculativePrefetcher(predictor, toolRunner, activationTokens=15,
                            confidenceThreshold=0.7, ttlMs=8000):

  observeToken(token):
    if predicted: return
    tokensSeen += 1; tokenBuffer.push(token)
    if tokensSeen >= activationTokens:
      predicted = true
      runPrediction(tokenBuffer.join(""))     // fire once, in background

  runPrediction(partialText):
    try   predictions = await predictor(partialText)
    catch return                              // predictor errors are swallowed
    for pred in predictions:
      if pred.name not a string: skip
      if pred.confidence < confidenceThreshold: skip
      prefetchOne(pred)

  prefetchOne(pred):
    key = toolName + ":" + sha256(stableStringify(args))
    if cache has key: return
    entry = { key, createdAt: now, expiresAt: now+ttlMs,
              result: null, done: false, consumed: false, abort }
    cache.set(key, entry)
    try
      result = await toolRunner(pred.name, pred.args)
      if entry.abort.aborted: return
      entry.result = result; entry.done = true
    catch
      cache.delete(key)                       // never cache failures

  consume(toolName, args) -> { result, hit } | null:
    entry = cache.get(toolName + ":" + sha256(stableStringify(args)))
    if not entry: return null                 // miss
    if entry.expiresAt <= now: abort+delete; return null   // expired
    if not entry.done: return null            // still computing — caller runs it
    entry.consumed = true
    return { result: entry.result, hit: true }

  cleanup():        abort all entries, clear cache, clear buffer   // at stream end
  discardedCount(): count of cached entries never consumed (mispredictions)
  settle():         await all in-flight prefetch work (testing/demos)
```

## Reference implementation

See [`speculative-tool-prefetch.ts`](./speculative-tool-prefetch.ts) in this directory.

It runs on Node.js built-ins only (`crypto` for cache-key hashing). The `predictor` and `toolRunner` are injected through the constructor as plain function types: production systems pass a nano-model predictor and a tool-registry runner, while the demo passes deterministic stubs. The production source (`sqNeuralPrefetch.ts`) wires the same pattern to a real small model and the live tool dispatcher behind those two injection points.

## Usage

```typescript
import {
  SpeculativePrefetcher,
  type Predictor,
  type ToolRunner,
  type ToolPrediction,
} from "./speculative-tool-prefetch.js";

// A predictor: inspect the partial stream head, return likely tool calls.
const predictor: Predictor = async (partialText) => {
  if (partialText.toLowerCase().includes("vault")) {
    return [{ name: "vault_read", args: { slug: "notes" }, confidence: 0.9 }];
  }
  return [];
};

// A runner that actually executes a tool (here, your tool registry).
const toolRunner: ToolRunner = async (name, args) => runTool(name, args);

const prefetcher = new SpeculativePrefetcher({
  predictor,
  toolRunner,
  activationTokens: 15,     // fire prediction after 15 tokens
  confidenceThreshold: 0.7, // only prefetch confident guesses
  ttlMs: 8_000,             // cached results live 8s
});

// Feed streamed tokens as the model produces them.
for await (const token of modelStream) {
  prefetcher.observeToken(token);
  emitToUser(token);
}

// At dispatch time, try the cache before running the tool for real.
const cached = prefetcher.consume("vault_read", { slug: "notes" });
const result = cached?.hit ? cached.result : await toolRunner("vault_read", { slug: "notes" });

// At stream end: abort in-flight prefetches and clear the cache.
prefetcher.cleanup();

// Observability: how many speculative results were wasted.
const wasted = prefetcher.discardedCount();
```

## Limitations and extensions

- **Prediction fires exactly once.** After `activationTokens` the predictor runs a single time. A turn whose tool intent only becomes clear later in the stream will not be re-predicted; a multi-shot variant would re-run prediction at intervals.
- **Read-mostly tools only.** Prefetching a tool with side effects would execute it speculatively even on mispredictions. This pattern is safe for idempotent reads; write/mutating tools must be excluded from the predictor's output.
- **Wasted work on misprediction.** Confident-but-wrong predictions spend a real tool call whose result is discarded. The confidence threshold and TTL bound the waste but do not eliminate it; track `discardedCount()` to tune the threshold.
- **Args must match exactly.** A hit requires the real call's arguments to hash identically to the predicted ones. A near-miss (same tool, slightly different args) is a cache miss and runs normally.
- **No cross-turn cache.** `cleanup()` clears everything at stream end, so speculative results never carry across turns. Persisting hits would require an explicit, separately-invalidated cache layer.
```
