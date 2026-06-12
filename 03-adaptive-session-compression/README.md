# Adaptive Session Symbol Table (SQ-B Compression)

## Problem

Every call to a frontier LLM API charges for input tokens. A typical conversational AI session accumulates context fast: the system prompt, conversation history, retrieved memories, tool schemas, and the current turn together can reach 8 000–20 000 tokens per call. Over a long session with dozens of turns, this compounds into significant cost and latency.

Standard approaches to this problem — truncation, summarization, retrieval-augmented context — all discard information. The question is: can we reduce token count without losing content?

The observation that makes this possible: **within a single session, the same phrases recur constantly.** A user working on a specific project will say "the authentication flow" or "the React component" or "what we discussed earlier" repeatedly. A system prompt contains fixed phrases like "you are a helpful assistant" or "always respond in JSON format" on every call. These repeated multi-word phrases are being tokenized and transmitted in full on every turn, even though the receiver already has the full text.

The SQ-B (SubQuantum-B) adaptive symbol table solves this by learning session-specific repeated phrases and assigning them compact shorthand identifiers. The model receives a small codec dictionary at the start of each turn, enabling it to use `~3K9F` instead of "the authentication flow" wherever the phrase appears in its response.

## Design decisions

**Why 5–8 word n-grams?**  
The shorthand token is not free: it costs tokens of its own (see "Why a single-token prefix" below) plus a per-entry line in the codec dictionary header. A short 3–4 word phrase often tokenizes to roughly the same number of tokens as its shorthand plus that overhead — net-negative compression. Longer phrases carry enough tokens that replacing them clears the overhead with room to spare. Shorter n-grams (1–2 words) also have too little entropy (stopword bigrams like "the user" save nothing); n-grams of 9+ words are too specific to recur. The 5–8 word range, with a 20-character minimum, is where compression is reliably net-positive.

**Why the entropy gate (minimum 8 bytes saved)?**  
The codec dictionary itself consumes tokens. Adding an entry that saves 2 bytes per use is not worth the overhead of including it in the dictionary header. The 8-byte threshold ensures every entry in the table pulls its weight.

**Why FNV-1a for token generation?**  
FNV-1a is a 32-bit non-cryptographic hash: fast, deterministic, no dependencies, zero allocation beyond the integer arithmetic. Token collisions (two different phrases mapping to the same ~-identifier) are handled by the deduplication logic in the symbol table — the phrase is the map key, not the token. The token is just a display form.

**Why a single-token ASCII prefix (`~`)?**  
The point of the shorthand is to cost fewer tokens than the phrase it replaces, so the prefix character must itself be cheap. The section sign `§` (U+00A7) is multi-byte UTF-8 and tokenizes to ~2 tokens on common byte-pair tokenizers (cl100k_base, o200k_base); a `§XXXX` shorthand can therefore cost 3–4 tokens — frequently more than the short phrase it was meant to compress. A single-byte ASCII prefix such as `~` (or `_`) is digested as a single token, keeping the shorthand genuinely compact. This is the same economics that drives the 5+ word n-gram floor.

**Why this scoring formula?**  

```
score = frequency × 0.6 + recency_weight × 0.3 + bytes_saved_per_use × 0.1
```

- `frequency × 0.6`: phrases used often are most valuable (exploitation)
- `recency_weight × 0.3`: a phrase used 20 turns ago is less likely to recur than one used 2 turns ago (decay-weighted freshness)
- `bytes_saved_per_use × 0.1`: a static tie-breaker that slightly favors longer phrases

The tie-breaker must be **bytes saved per use** — a constant for a given phrase (phrase length minus token length). The implementation accumulates `bytesSaved` on every hit, so `bytesSaved / frequency` correctly recovers that stable per-use figure. The trap to avoid: storing a single-use constant and *then* dividing it by frequency, which would make the term shrink as a phrase recurs — actively penalizing the most-repeated phrases, the exact opposite of the intent. The weights were tuned empirically; frequency dominates because session-local vocabulary stabilizes after a few turns and the highest-frequency phrases are almost always the right ones to keep.

**Why 128 entries maximum?**  
The codec dictionary is injected into every call. At ~5 tokens per entry (token + phrase + separator), 128 entries costs ~640 tokens — acceptable overhead for a dictionary that typically saves 8–18% of total input tokens. Above 128 entries, the dictionary overhead starts to outweigh the savings for average sessions.

**Why evict by lowest score rather than LRU?**  
Pure LRU would evict the oldest-used entry, which might be a high-frequency phrase that happened to not appear in the last few turns. Score-based eviction keeps the entries that deliver the most compression value over the session lifetime.

## Algorithm

```
ingest(text):
  words = split(text)
  for n in 5..8:
    for each n-gram in words:
      if len(n-gram) < 20 chars: skip
      bytes_saved = len(phrase) - len(~TOKEN)   // per-use, constant for this phrase
      if bytes_saved < 8: skip  // entropy gate
      if phrase in table:
        entry.frequency  += 1
        entry.lastUsedMs  = now
        entry.bytesSaved += bytes_saved          // accumulate cumulative total
      else:
        if table.size >= 128: evict(lowest_score)
        table[phrase] = { token, frequency=1, lastUsedMs=now, bytesSaved=bytes_saved }

score(entry):
  age_ms        = now - entry.lastUsedMs
  recency       = 1 / (1 + age_ms / 60_000)
  bytes_per_use = entry.bytesSaved / entry.frequency   // cumulative ÷ uses = stable per-use value
  return entry.frequency * 0.6 + recency * 0.3 + bytes_per_use * 0.1

evict():
  remove entry with lowest score

buildCodecDict(table):
  sorted = table.entries.sortByScore(desc)
  return "CODEC SHORTHAND\n" + sorted.map(e => `${e.token}=${e.phrase}`).join("\n")
```

The token format `~XXXXXX` uses a single-byte tilde prefix followed by up to 6 alphanumeric characters from the FNV-1a hash of the phrase expressed in base-36. The prefix is ASCII on purpose: a multi-byte prefix like `§` (U+00A7) tokenizes to ~2 tokens on byte-pair tokenizers, which can make a short shorthand cost more tokens than the phrase it replaces. See "Why a single-token ASCII prefix" above.

## Layering with provider-level caching

The symbol table reduces tokens transmitted per call. This is complementary to provider-level prompt caching (Anthropic cache_control, Gemini context caching): provider caching eliminates re-billing for static prefixes; SQ-B reduces the dynamic suffix that changes every turn. Together they address the two distinct sources of token cost.

See guide 04 (Session Static Manifest) for how the static prefix is pre-seeded into the symbol table at boot to give good compression from the first turn.

## Reference implementation

See [`sq-symbol-table.ts`](./sq-symbol-table.ts) in this directory.

## Usage

```typescript
import { SqSymbolTable } from "./sq-symbol-table.js";

const table = new SqSymbolTable("session-abc-123");

// Ingest the system prompt at session start
table.ingest(systemPromptText);

// Ingest each turn of the conversation
table.ingest(userMessage);
table.ingest(assistantResponse);

// Build the codec dictionary to inject before each LLM call
const codecBlock = table.buildCodecInjection();

// The final system prompt includes the codec block:
// const prompt = systemPromptText + "\n\n" + codecBlock;
```

## Limitations and extensions

- **Model cooperation required.** The model must be instructed to use ~-tokens when it recognizes exact phrase matches. This is a soft instruction. Large models follow it well, but smaller/faster edge models frequently hallucinate the non-semantic hashes or slip back into natural language — which breaks the server-side decode path. Treat a missing or garbled token as "leave the text as-is" rather than a hard error. The compression gain comes from the model's outputs, not the inputs (the server decodes ~-tokens before displaying to the user).
- **Bytes are a proxy for tokens.** The entropy gate and scoring measure bytes, but billing is in tokens, and the two do not map 1:1. The 5+ word floor and single-token prefix exist to keep the byte heuristic conservative enough that positive byte savings reliably imply positive token savings. For maximum accuracy, gate on an actual tokenizer count (e.g. `tiktoken`) instead of byte length.
- **Session-local only.** The symbol table is per-session and ephemeral. Phrases do not carry over between sessions unless you implement a persistent cross-session vocabulary (a "global ledger" of frequently-occurring phrases across all sessions, which can be pre-seeded into new sessions — see guide 04).
- **Not for security-sensitive fields.** Do not pass ~-tokens through authentication or transaction flows. The decoding step must happen before any security decision is made.
- **Token counting.** The codec dictionary injection costs ~5–8 tokens per entry. For sessions shorter than ~10 turns, the overhead may outweigh savings. Enable the entropy gate strictly for short sessions.
