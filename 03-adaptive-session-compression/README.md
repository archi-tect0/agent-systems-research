# Adaptive Session Symbol Table (SQ-B Compression)

## Problem

Every call to a frontier LLM API charges for input tokens. A typical conversational AI session accumulates context fast: the system prompt, conversation history, retrieved memories, tool schemas, and the current turn together can reach 8 000–20 000 tokens per call. Over a long session with dozens of turns, this compounds into significant cost and latency.

Standard approaches to this problem — truncation, summarization, retrieval-augmented context — all discard information. The question is: can we reduce token count without losing content?

The observation that makes this possible: **within a single session, the same phrases recur constantly.** A user working on a specific project will say "the authentication flow" or "the React component" or "what we discussed earlier" repeatedly. A system prompt contains fixed phrases like "you are a helpful assistant" or "always respond in JSON format" on every call. These repeated multi-word phrases are being tokenized and transmitted in full on every turn, even though the receiver already has the full text.

The SQ-B (SubQuantum-B) adaptive symbol table solves this by learning session-specific repeated phrases and assigning them compact single-token shorthand identifiers. The model receives a small codec dictionary at the start of each turn, enabling it to use `§3K9F` instead of "the authentication flow" wherever the phrase appears in its response.

## Design decisions

**Why 3–8 word n-grams?**  
Shorter n-grams (1–2 words) have too little entropy to be useful — common stopword bigrams like "the user" or "in the" save almost nothing. Longer n-grams (9+ words) are too specific to appear more than once or twice per session. The 3–8 word range captures the sweet spot of commonly-repeated semantic phrases. The 12-character minimum length filters out multi-word phrases that are too short to compress meaningfully.

**Why the entropy gate (minimum 8 bytes saved)?**  
The codec dictionary itself consumes tokens. Adding an entry that saves 2 bytes per use is not worth the overhead of including it in the dictionary header. The 8-byte threshold ensures every entry in the table pulls its weight.

**Why FNV-1a for token generation?**  
FNV-1a is a 32-bit non-cryptographic hash: fast, deterministic, no dependencies, zero allocation beyond the integer arithmetic. Token collisions (two different phrases mapping to the same §-identifier) are handled by the deduplication logic in the symbol table — the phrase is the map key, not the token. The token is just a display form.

**Why this scoring formula?**  

```
score = frequency × 0.6 + recency_weight × 0.3 + bytes_saved_per_use × 0.1
```

- `frequency × 0.6`: phrases used often are most valuable (exploitation)
- `recency_weight × 0.3`: a phrase used 20 turns ago is less likely to recur than one used 2 turns ago (decay-weighted freshness)
- `bytes_saved × 0.1`: a tie-breaker that slightly favors longer phrases

The weights were tuned empirically against typical conversational AI sessions. Frequency dominates because session-local vocabulary stabilizes after a few turns and the highest-frequency phrases are almost always the right ones to keep.

**Why 128 entries maximum?**  
The codec dictionary is injected into every call. At ~5 tokens per entry (token + phrase + separator), 128 entries costs ~640 tokens — acceptable overhead for a dictionary that typically saves 8–18% of total input tokens. Above 128 entries, the dictionary overhead starts to outweigh the savings for average sessions.

**Why evict by lowest score rather than LRU?**  
Pure LRU would evict the oldest-used entry, which might be a high-frequency phrase that happened to not appear in the last few turns. Score-based eviction keeps the entries that deliver the most compression value over the session lifetime.

## Algorithm

```
ingest(text):
  words = split(text)
  for n in 3..8:
    for each n-gram in words:
      if len(n-gram) < 12 chars: skip
      bytes_saved = len(phrase) - len(§TOKEN)
      if bytes_saved < 8: skip  // entropy gate
      if phrase in table: update frequency + recency
      else if table.size >= 128: evict(lowest_score)
      table[phrase] = { token, frequency=1, lastUsedMs=now, bytesSaved }

score(entry):
  age_ms        = now - entry.lastUsedMs
  recency       = 1 / (1 + age_ms / 60_000)
  bytes_per_use = entry.bytesSaved / entry.frequency
  return entry.frequency * 0.6 + recency * 0.3 + bytes_per_use * 0.1

evict():
  remove entry with lowest score

buildCodecDict(table):
  sorted = table.entries.sortByScore(desc)
  return "CODEC SHORTHAND\n" + sorted.map(e => `${e.token}=${e.phrase}`).join("\n")
```

The token format `§XXXXXX` uses the section-sign prefix (U+00A7) to avoid collisions with natural language, followed by up to 6 alphanumeric characters from the FNV-1a hash of the phrase expressed in base-36.

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

- **Model cooperation required.** The model must be instructed to use §-tokens when it recognizes exact phrase matches. This is a soft instruction — models don't always comply perfectly, especially shorter models. The compression gain comes from the model's outputs, not the inputs (the server decodes §-tokens before displaying to the user).
- **Session-local only.** The symbol table is per-session and ephemeral. Phrases do not carry over between sessions unless you implement a persistent cross-session vocabulary (a "global ledger" of frequently-occurring phrases across all sessions, which can be pre-seeded into new sessions — see guide 04).
- **Not for security-sensitive fields.** Do not pass §-tokens through authentication or transaction flows. The decoding step must happen before any security decision is made.
- **Token counting.** The codec dictionary injection costs ~5–8 tokens per entry. For sessions shorter than ~10 turns, the overhead may outweigh savings. Enable the entropy gate strictly for short sessions.
