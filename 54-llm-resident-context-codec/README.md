# LLM-Resident Context Codec (Token-Space Shorthand)


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

Large language model prompts are billed and rate-limited by token count, not by character count or semantic content. A system prompt, tool schema, or conversation history that repeats the same phrases hundreds of times pays for those tokens on every call. On hosted backends this is direct cost; on local CPU inference it is prefill latency.

There are two distinct sources of avoidable tokens. First, **common multi-word phrases** ("the user", "long-term memory", "authentication") appear over and over but carry the same fixed meaning every time — they can be swapped for short codes if the model is taught how to expand them. Second, some phrases are already **resident in the model's weights**: the model can reproduce them verbatim from its training or fine-tune without being shown the full text, so transmitting the full text is pure waste.

The hard constraint is that this compression must be lossless after the model reads it, and — critically — it must never leak secrets. If phrase promotion is driven by observing real traffic (so the most frequent phrases earn codes), a naive implementation could promote a credit card number, an API key, or a recovery mnemonic into a shared dictionary, exposing it across sessions. The codec must scrub secrets **before** any phrase becomes a code.

## Design decisions

**Why two separate substitution layers (codes vs. refs)?**
They solve different problems. The `@code` layer is a shared, static dictionary: the same code means the same phrase across every prompt, so the legend can be prompt-cached once. The `REF:<hash>` layer is per-encoding and targets phrases the model already knows from its weights — those do not need a human-readable code, only a stable marker the server can reverse. Keeping them separate means the static legend stays small and cacheable while the dynamic ref table only lists what actually appeared in this one prompt.

**Why FNV-1a for the weight-resident refs?**
The ref marker only needs to be deterministic, collision-resistant enough for a small per-prompt phrase set, and cheap to compute with no dependencies. FNV-1a is a non-cryptographic hash with a tiny, well-known implementation that produces identical output on every platform when the 32-bit multiply is done with `Math.imul`. We are not protecting the phrase — the server holds the reverse mapping — so a cryptographic hash would be wasted work and larger markers. The hash is rendered in base-36 uppercase to keep the marker short.

**Why a legend instead of just trusting the model to guess?**
Guessing is unreliable and silently lossy. A one-line legend that maps every active code and ref back to its expansion makes decoding deterministic from the model's point of view, and it is small enough to be prompt-cached so its cost is amortized across calls. The legend is returned separately from the encoded body precisely so the caller can cache it and not count it against per-turn savings.

**Why run the privacy filter before promotion rather than after?**
Because the dictionary is shared. Once a phrase is promoted it can resurface in any future prompt's legend or ref table. A filter that ran after encoding would already have written the secret into a code mapping. Running the filter at admission time means a blocked phrase is never assigned a code, never hashed into a ref, and never appears in any legend — the secret simply stays as ordinary inline text in the single prompt that contained it and is never shared.

**Why is the filter conservative (block on doubt)?**
The cost of a false positive (a safe phrase stays uncompressed) is a few tokens. The cost of a false negative (a secret gets promoted) is a cross-session leak. The asymmetry justifies blocking anything matching address, email, SSN, JWT, API-key, 64-hex, mnemonic, or Luhn-valid card patterns, plus anything outside a sane length band.

**Why skip code spans during substitution?**
Identifiers inside `` `code` `` or fenced blocks must survive verbatim — renaming a variable that happens to contain a dictionary phrase would corrupt the model's understanding of the code. The codec splits on code spans and only rewrites prose segments.

## Algorithm

```
encode(text, weightResidentSet):
  # 1. Phrase shorthand (prose segments only)
  for each prose segment of text (split on code spans):
    for each (pattern, code) in SHORTHAND (longest phrase first):
      segment = segment.replace(pattern, code)

  # 2. Weight-resident refs (prose segments only)
  refMap = {}
  for each prose segment:
    for each phrase in weightResidentSet where len(phrase) >= 6:
      if segment contains phrase:
        ref = "REF:" + base36(FNV1a(phrase))
        refMap[ref] = phrase
        segment = segment.replaceAll(phrase, ref)

  legend = "LEGEND: " + join(code=phrase ...) + " " + join(ref=phrase ...)
  return { encoded, legend, refMap, reductionPct }

decode(encoded, refMap):
  for each (ref, phrase) in refMap:   encoded = encoded.replaceAll(ref, phrase)
  for each (code, phrase) in SHORTHAND: encoded = encoded.replaceAll(code, phrase)
  return encoded

FNV1a(s):                      # 32-bit
  h = 0x811c9dc5
  for ch in s:
    h = h XOR ch
    h = (h * 0x01000193) mod 2^32   # Math.imul keeps this exact
  return h >>> 0

buildWeightResidentSet(candidates):
  admitted = {}; blocked = []
  for phrase in candidates:
    if shouldBlockPhrase(phrase): blocked.push(phrase)   # secret: never promoted
    else: admitted.add(phrase)
  return { admitted, blocked }

shouldBlockPhrase(phrase):     # conservative; true = do not promote
  if bytelen outside [12, 96]: return true
  if matches any of: EVM addr | email | SSN | JWT | API key | 64-hex
                   | seed-phrase context | mnemonic word list: return true
  if Luhn-valid card-shaped digits: return true
  return false
```

## Reference implementation

See [`llm-resident-context-codec.ts`](./llm-resident-context-codec.ts) in this directory. It uses only Node built-ins (`Buffer`); FNV-1a is implemented inline with no external dependency.

## Usage

```typescript
import {
  encode,
  decode,
  buildWeightResidentSet,
  shouldBlockPhrase,
  fnv1a,
} from "./llm-resident-context-codec.js";

// 1. Decide which observed phrases are safe to promote. Secrets are dropped.
const { admitted, blocked } = buildWeightResidentSet([
  "long-term memory",
  "the most likely cause is",
  "4111 1111 1111 1111", // blocked: Luhn-valid card number
]);

// 2. Encode a prompt. The legend is returned separately so it can be cached.
const { encoded, legend, refMap, reductionPct } = encode(
  "When the user asks, check long-term memory first.",
  admitted,
);

// 3. Reverse on the way back out.
const original = decode(encoded, refMap);

// Lower-level helpers are exported too:
shouldBlockPhrase("user@example.com"); // true
fnv1a("long-term memory");             // deterministic base-36 ref id
```

## Limitations and extensions

- **Codes must not collide with prose.** The `@CODE` and `REF:<hash>` forms are chosen to be visually distinct and absent from natural text. If a prompt legitimately contains the literal string `@U`, decoding would over-expand it. A stricter implementation can escape such literals with a reserved marker before encoding.
- **Token savings ≠ character savings.** This file measures character-length reduction for portability (no tokenizer dependency). Real token savings depend on the backend's tokenizer; some short codes may cost more tokens than the word they replace on certain vocabularies. Tune the dictionary against the actual tokenizer in production.
- **The privacy filter is heuristic.** It catches common secret shapes but is not a guarantee. Pair it with allow-listing (promote only from a curated source) for high-assurance deployments, and keep the byte-length band tight.
- **Ref hashing is non-cryptographic.** FNV-1a is fine for reversible, server-held mappings but must not be used where collision resistance or secrecy matters. The reverse table, not the hash, is what makes decoding correct.
- **Static dictionary.** This implementation ships a fixed phrase list. An organic version would mine frequent phrases from traffic and promote them through the same privacy gate, persisting the dictionary and legend across sessions.
