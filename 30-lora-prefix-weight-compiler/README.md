# Agent LoRA / Prefix-Weight Compiler


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

A locally-run agent has a fixed identity: a system prompt, a consistent voice, and a set of stable facts about its owner ("timezone is America/New_York", "prefers oat flat whites"). Two costs come from carrying that identity:

1. **Per-turn token cost.** If the identity and stable facts are injected into the context on every turn, you pay to re-encode the same ~1K+ tokens every single time, even though they never change.

2. **Portability and lock-in.** If the identity lives only in application source code and a server database, the agent cannot be moved. Rebuilding it on another machine means redeploying code and copying a database — there is no single artifact that *is* the agent.

This guide describes a compiler that solves both. It takes the agent's identity and stable knowledge and produces two outputs from one spec: **(a)** an encrypted, content-addressed blob on IPFS that any node with the owner's key can reconstruct the agent from, and **(b)** an Ollama Modelfile that bakes the static identity into the model's prompt prefix so it becomes KV-cache-resident — turning a 1K+ token prefill into ~20 tokens on every turn after the first.

## Design decisions

**The prefix-weight trick: bake static facts as `MESSAGE` blocks.**
Ollama Modelfiles support `SYSTEM` (a system prompt) and `MESSAGE` (pre-loaded conversation turns). When the model is loaded and pinned in RAM (`keep_alive: -1`), everything in the `SYSTEM` + `MESSAGE` prefix is processed once; its key/value attention cache is retained. Every later turn only computes KV for the *new* user tokens. So putting stable facts into `MESSAGE` blocks makes them **weight-resident**: present in the model's working context at zero marginal token cost per turn. This is not fine-tuning — no gradients, no adapter training — it is exploiting the prompt cache as if it were a cheap, instantly-recompilable weight layer. (Real LoRA adapter training is a separate, heavier pipeline; this compiler produces the prefix layer.)

**Lean `SYSTEM`, dynamic context injected at runtime.**
The `SYSTEM` block is deliberately a small identity anchor, not the agent's entire knowledge base. The large, fast-changing per-session context (recent memories, current task state) is injected at runtime by the application, *not* baked into the Modelfile — baking it would overflow the context window and would go stale the moment anything changed. Only the genuinely stable parts (identity, voice, high-confidence facts) belong in the prefix.

**Only high-confidence, stable facts get baked.**
A fact baked into the prefix is hard to retract — it is in the model's context for the lifetime of that model build. So the compiler bakes only facts above a confidence floor (≥ 0.75) and with trustworthy provenance. Low-confidence or inferred facts stay in the runtime-injection path where they can be corrected or dropped cheaply.

**Style anchors teach *how*, facts teach *what*.**
Two kinds of `MESSAGE` blocks are emitted. *Style anchors* are short canonical exchanges that teach the model's voice (brevity, tone, no filler). *Stable facts* are Q/A pairs that teach durable knowledge. Separating them keeps each concern editable on its own.

**Encrypt the whole spec; content-address it.**
The full spec (which can include personal facts) is serialized, encrypted with AES-256-GCM, and pinned to IPFS. The CID is the agent's portable address. Because IPFS is public, encryption is mandatory: the blob is opaque to anyone without the key.

**Key derivation binds the spec to an owner without storing a key.**
The AES key is derived via HKDF-SHA256 from a server secret (`ADDR_SECRET`) plus the owner identity, salted with a fresh random per-publish salt that travels in the (public) blob header. No key material is stored anywhere — any node holding the server secret and the owner identity re-derives the exact key from the CID. The fresh salt means each published version has a distinct key even though the owner is constant.

**GCM gives confidentiality *and* integrity.**
AES-256-GCM's authentication tag means a tampered blob fails to decrypt rather than silently yielding corrupted identity data. A content-addressed blob is already integrity-checked by its CID, but the GCM tag protects the *plaintext* against an attacker who can serve a different (validly-CID'd) ciphertext.

**Multi-gateway read fallback.**
Reads try several IPFS gateways in order until one returns a structurally valid blob, so a single gateway outage doesn't make the agent unrecoverable.

## Algorithm

```
buildSpec(identity, styleAnchors, stableFacts):
  spec = { version, model, owner, identity, systemPrompt, parameters,
           stableKnowledge: stableFacts }
  spec.modelfile = buildModelfile(spec, styleAnchors)
  return spec

buildModelfile(spec, styleAnchors):
  FROM <base model>
  SYSTEM """<lean identity anchor>"""
  for (u, a) in styleAnchors:            MESSAGE user u / MESSAGE assistant a
  for f in stableFacts where conf>=0.75: MESSAGE user f.q / MESSAGE assistant f.a
  PARAMETER temperature / num_ctx / top_p / repeat_penalty / stop...

publish(spec):
  salt  = random(16); nonce = random(12)
  key   = HKDF-SHA256(ADDR_SECRET, salt, info="agent-lora:" + owner, 32)
  ct    = AES-256-GCM(key, nonce, JSON(spec))   // ciphertext || tag
  blob  = { ct, nonce, salt, owner, version, alg, kdf }
  cid   = pinToIPFS(blob)
  return cid

reconstruct(cid):
  blob = fetch from first working gateway
  key  = HKDF-SHA256(ADDR_SECRET, blob.salt, "agent-lora:" + blob.owner, 32)
  spec = AES-256-GCM-decrypt(key, blob.nonce, blob.ct)   // verifies tag
  ollama create <name> -f spec.modelfile
```

## Cost intuition

On a CPU-hosted small model, a pure conversation turn that would prefill ~1K+ identity tokens drops to recomputing only the new user tokens (~20) once the prefix is cached. The first turn after a model load pays the full prefill; every turn after that rides the cache. Time-to-first-token falls correspondingly (e.g. ~300 ms → sub-100 ms for short turns) because the expensive prefill is amortized.

## Reference implementation

See [`lora-compiler.ts`](./lora-compiler.ts) in this directory.

## Usage

```typescript
import { buildSpec, encryptSpec, decryptBlob, pinBlob, fetchBlob } from "./lora-compiler.js";

const spec = buildSpec({
  owner: walletAddress,
  baseModel: "qwen2.5:1.5b",
  name: "agent-os",
  identityName: "Atlas",
  identityRole: "personal_assistant",
  systemPrompt: leanIdentityAnchor,
  styleAnchors: [["hey", "Ready. What do you need?"], ["thanks", "Always."]],
  stableFacts: highConfidenceShards,   // only conf>=0.75 get baked
});

// Apply locally: `ollama create agent-os -f <(echo "$modelfile")`
applyModelfile(spec.modelfile);

// Publish a portable, encrypted copy.
const cid = await pinBlob(encryptSpec(spec));

// Reconstruct on any node holding the owner key + server secret.
const restored = decryptBlob(await fetchBlob(cid));
```

## Limitations and extensions

- **Not adapter fine-tuning.** This compiler produces a *prefix* layer (prompt-cache-resident `MESSAGE` blocks), not trained LoRA weights. It gives you near-instant, retractable "knowledge" at the cost of context-window space, not a permanently altered weight matrix. The two compose: bake the stable prefix here, train a real adapter separately on accumulated examples.
- **Prefix space is finite.** Every baked fact consumes context-window tokens (cached, but still counted against `num_ctx`). Bake only the highest-value stable facts; a runaway `stableKnowledge` list will crowd out room for the live per-turn context.
- **Cache invalidation is coarse.** Editing any baked fact requires rebuilding the model (and warms cold again on next load). This is fine for genuinely stable facts and wrong for anything that changes weekly — keep volatile data in the runtime-injection path.
- **Key custody is the whole security model.** Anyone with the server secret + owner identity can decrypt the blob. Rotating `ADDR_SECRET` invalidates every previously published CID's derivable key. Protect it accordingly.
- **`MESSAGE`-block escaping is minimal.** The reference escapes quotes and newlines; a production version should robustly handle all Modelfile metacharacters and length-cap each block.
