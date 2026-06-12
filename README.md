# Engineering Research: Agent & Self-Custody Systems

A collection of engineering patterns worked out while building a self-custodial, agent-driven identity and wallet system. Each one is written up as a standalone research guide — the problem it solves, the design decisions behind it, the algorithm, and a small reference implementation you can actually run.

This is shared in the spirit of *here is how I approached these problems, in case it's useful to you* — not as a framework, a product, or a claim to have solved anything for good. Take what helps, ignore the rest, improve on it.

## What this is — and isn't

- **It is** ~65 self-contained, runnable reference implementations with the reasoning attached. Most code you find online shows you *what*; these try to show you *why*.
- **It is not** an audited, production-ready library. Each implementation isolates a single idea so it can be read and run in a few minutes. Several deliberately reimplement an idea on Node.js built-ins just to stay runnable; each guide notes where a real system would reach for a vetted dependency instead.
- **The cryptography here is educational.** Where a guide hand-rolls a primitive it says so, and points to what production should use (`@noble/*`, `ethers`, audited libraries). Read those as *the shape of the technique*, not *ship this as-is*.

## Who it's for

Builders working on AI agent runtimes, self-custody / wallet tooling, or local-first systems who hit one of these walls and want a worked example with the trade-offs spelled out. If you use an AI coding agent, you can point it at this repo and ask it to explain, critique, or adapt any guide — every folder is self-contained and small enough to reason about in a single pass.

Every guide follows the same structure:

- **Problem** — the concrete failure mode or constraint that motivates the pattern.
- **Design decisions** — the load-bearing choices and the trade-offs behind them.
- **Algorithm** — pseudocode for the core mechanic.
- **Reference implementation** — a standalone `.ts` file in the same folder, runnable with `node <file>.ts --demo` (Node.js built-ins preferred; external dependencies are called out explicitly).
- **Usage** — how to wire the pattern into your own code.
- **Limitations and extensions** — where it stops, and how to push it further.

The reference implementations are educational: read them, run them, adapt them. They are not drop-in production libraries, and anything that would touch real keys or broadcast a real transaction is gated behind a safe `--demo` path that does neither.

## Running the demos

Most guides depend only on Node.js built-ins and run directly under Node 24+ (which strips TypeScript types natively) or `tsx`:

```bash
# Node 24+ runs the built-in-only demos directly:
node 01-fh-kdf/fh-kdf.ts --demo

# Or with tsx:
npx tsx 03-adaptive-session-compression/sq-symbol-table.ts --demo
```

A handful of guides require external libraries and will only run once those are installed in the directory (`npm i <package>`):

| Guide | Required package(s) |
|-------|---------------------|
| 05 — Encrypted Identity Blobs | `@msgpack/msgpack` |
| 13 — Committed Lattice Secret Sharing | `secrets.js-grempe` |
| 15 — Multi-Chain Shadow Derivation | `@noble/curves`, `tweetnacl`, `bs58` |
| 19 — Hybrid Post-Quantum Identity | `@noble/post-quantum` |
| 20 — SIWE + Passkey Floor | `ethers` |

Each guide's "Reference implementation" section lists exactly what it needs. Where a guide could pull in a heavy chain SDK (e.g. guide 34's per-chain transaction builders), the SDK is kept behind a pluggable adapter so the file still runs on built-ins alone — the demo simply skips the chains you have not wired an adapter for.

## Catalog

### Identity, keys, and cryptography

| # | Guide | Summary |
|---|-------|---------|
| 01 | [Fibonacci-Harmonic KDF](./01-fh-kdf/) | A domain-separated key-derivation function combining HKDF with a harmonic mixing schedule. |
| 02 | [Post-Quantum HKDF](./02-pq-hkdf/) | HKDF built on SHA3-256 for a post-quantum-oriented hash core. |
| 13 | [Committed Lattice Secret Sharing](./13-fractal-lattice-sharding/) | High-dimensional lattice secret sharing with a SHA-256 commitment that detects silent shard corruption. |
| 19 | [Hybrid Post-Quantum Identity](./19-hybrid-pqc-identity/) | Zero-interaction enrollment of ML-DSA + SLH-DSA keys shadowing an ECDSA account; dual-signed receipts and hybrid JWTs. |
| 20 | [SIWE Login with a Passkey Floor](./20-siwe-passkey-floor/) | Wallet sign-in plus a context-bound WebAuthn assertion required for every state-changing operation. |
| 21 | [Behavioral Continuous Authentication](./21-behavioral-continuous-auth/) | A 9-dimension motion vector with an EMA profile and cosine-similarity step-up auth. |
| 41 | [Hybrid RSA + Post-Quantum OIDC Signing](./41-hybrid-oidc-pq-signing/) | Standard RS256 JWTs carry a detached ML-DSA-65 signature keyed from the RSA `kid` + secret, so breaking RSA alone cannot forge a token and RS256-only clients still verify. |
| 43 | [Domain-Isolated Address Aliases](./43-domain-isolated-address-alias/) | Per-domain HKDF derivation yields a distinct deterministic address for every site, making one user unlinkable across sites with no registry. |
| 51 | [Deterministic Post-Quantum Action Receipts](./51-deterministic-action-receipts/) | Canonical-JSON action hashes signed by a wallet-deterministic post-quantum key, verifiable indefinitely without any server state. |

### Wallets and payments

| # | Guide | Summary |
|---|-------|---------|
| 15 | [Multi-Chain Shadow Wallet Derivation](./15-multichain-shadow-derivation/) | Deterministically derive BTC, EVM, Solana, and Tron addresses from one identity string + secret via HKDF — no BIP-39 seed. |
| 16 | [Time-of-Flight Proximity Payment](./16-proximity-payment-tof/) | A relay-resistant "tap to pay" using round-trip time-of-flight over Web Bluetooth / WebNFC. |
| 17 | [Agent Spend-Limit Wallet](./17-agent-spend-limit-wallet/) | An autonomous hot wallet that auto-executes under a threshold and requires a human approval above it. |
| 18 | [Multi-Chain Spend Governor](./18-multichain-spend-governor/) | Fail-closed daily spend limits normalizing every chain/token to one base currency via live pricing. |
| 29 | [Quorum Vault Groups](./29-quorum-vault-groups/) | M-of-N approval with passkey assertions, plus recursive child sub-vaults with autonomous caps that escalate to full quorum. |
| 32 | [Covenant Dual-Custody](./32-covenant-dual-custody/) | Bind a human-owned proof token to a machine-owned proof token at creation to link a human and an agent identity. |
| 34 | [Emergency Cross-Chain Sweep](./34-emergency-cross-chain-sweep/) | A panic button that derives a clean wallet and parallel-sweeps funds across every selected chain at once. |

### Agent cognition: memory and tools

| # | Guide | Summary |
|---|-------|---------|
| 06 | [Compound Memory Salience Scoring](./06-compound-memory-salience/) | Re-rank vector-search hits by a weighted blend of similarity, recency, emotion, confidence, and trust, with corrections taking hard priority. |
| 07 | [Reflective Memory](./07-reflective-memory/) | Categorized lessons with use-reinforced sorting — touching a memory warms it and floats it up — plus stale pruning. |
| 09 | [Intent-Based Tool Schema Selection](./09-intent-based-tool-selection/) | A core tool set plus intent-classified drawers and a name-only index, cutting tool-schema tokens by more than half. |
| 10 | [Intent-Gated Personal Knowledge Shards](./10-personal-knowledge-shards/) | A structured personal-facts layer gated by intent and provenance, where security paths only trust observed facts. |
| 33 | [Knowledge Absorber → Zero-Token Vocabulary](./33-knowledge-absorber-sq-vocab/) | Detect knowledge gaps, distill standalone facts, and graduate them into a zero-token vocabulary referenced via the session codec. |
| 46 | [Typed World-Model Graph with Goal Topology](./46-typed-world-model-graph/) | A typed per-user entity graph with parent/child goal topology that reconstructs life-goal hierarchies at read time and injects a compact world-model block. |
| 47 | [Ambient World-Snapshot Prefetch Bus](./47-ambient-snapshot-bus/) | A query planner splits broad categories into micro-queries and keeps small digests warm with confidence decay, so the agent rarely needs a live tool call. |
| 54 | [LLM-Resident Context Codec](./54-llm-resident-context-codec/) | Token-space shorthand that swaps common phrases for short codes and weight-resident phrases for deterministic refs, with a legend and a pre-promotion secret scrubber. |

### Agent cognition: routing and growth

| # | Guide | Summary |
|---|-------|---------|
| 12 | [Resilient Multi-Provider LLM Routing](./12-resilient-llm-routing/) | Named-mode fast-fail vs. auto-waterfall cascade across providers, per-backend health probes, and small-model context re-encoding. |
| 24 | [Cloud / Local Privacy Router](./24-cloud-local-privacy-router/) | Classify each turn's sensitivity and redact secrets before any cloud call, so the cloud sees intent, not secrets. |
| 30 | [Agent LoRA / Prefix-Weight Compiler](./30-lora-prefix-weight-compiler/) | Compile agent personality into an encrypted, content-addressed spec and bake stable facts into prefix-cacheable model messages. |
| 31 | [Relational Intelligence Model](./31-relational-intelligence-model/) | Longitudinal signal tracking that infers stress and trust and calibrates response density and tone. |
| 52 | [Competence-Gated On-Device Distillation Router](./52-competence-distillation-router/) | Routes a turn to a local model once an intent has accumulated enough demonstrated-competence training pairs, escalating complex turns to the cloud. |
| 53 | [Manifest-Driven LoRA Expert Router](./53-lora-manifest-router/) | A manifest of expert adapters selected by intent kind and trigger-term regex to activate task-specific local weights. |
| 55 | [Dependency-Aware Parallel Tool Dispatch](./55-tool-dependency-dag/) | Builds a topological DAG of tool calls, running independent nodes concurrently and chaining dependents on their inputs. |
| 56 | [Speculative Tool Prefetch](./56-speculative-tool-prefetch/) | A small predictor watches a stream's first tokens to pre-execute likely tools in the background, turning tool waits into cache hits. |
| 58 | [Batched Intent Collapse with Merkle Fan-Out](./58-batched-intent-collapse/) | Deduplicates shared context across many pending intents into one dense call anchored by a Merkle root, then fans results back out per virtual channel. |

### Agent governance

| # | Guide | Summary |
|---|-------|---------|
| 08 | [DB-Backed Autonomous Agent Scheduler](./08-autonomous-agent-scheduler/) | A polling scheduler that fires agent work on a clock with atomic claims, failure isolation, and timezone-aware anchors. |
| 37 | [Tiered Authority Bands](./37-agent-authority-bands/) | Permission bands (0–4) gating which tools an agent may invoke at a given authority level. |
| 38 | [Will/Objective Topology + Constitutional Guardrails](./38-will-constitution-engine/) | A goal-topology engine paired with an invariant guardrail layer that filters proposed actions against hard rules. |
| 39 | [Tool-Use Critic](./39-tool-critic/) | An independent validator that judges whether a tool call is appropriate and whether it achieved its intent, feeding correction memories. |
| 40 | [Conversation State Kernel](./40-conversation-state-kernel/) | A per-turn finite state machine governing surface locks, dispatch, fork gating, and an empty-response guard. |
| 48 | [Action Idempotency Reconciler](./48-action-idempotency-reconciler/) | Canonical recursive-sorted-args fingerprints prevent duplicate confirm cards and transition stale "executing" actions to "unknown" after a grace window. |
| 49 | [Batched Single-Signature Approval Queue](./49-batched-approval-ceremony/) | Collects a turn's write actions, orders them low→high risk, authorizes the whole batch with one approval ceremony, and carries rollback hints for partial failure. |
| 50 | [Headless Read-Only Reasoning Shards](./50-headless-reasoning-shards/) | Disposable read-only reasoning shards return strict JSON with confidence and conflict flags; a merge gate detects disagreement without widening the write surface. |

### Platform, transport, and security

| # | Guide | Summary |
|---|-------|---------|
| 03 | [Adaptive Session Symbol Table](./03-adaptive-session-compression/) | A streaming symbol table that compresses repeated session content. |
| 04 | [Session Static Manifest](./04-session-static-manifest/) | Static-first prompt ordering and a pre-seeded manifest to maximize provider prefix-cache hits. |
| 05 | [Encrypted Content-Addressed Identity Blobs](./05-encrypted-identity-ipfs/) | Store identity/knowledge as msgpack → AES-256-GCM → IPFS, with multi-gateway read fallback and no server-side plaintext. |
| 11 | [QoS-Lane Stream Multiplexer](./11-yamux-qos-multiplexer/) | Yamux-style multiplexing over WebSocket with QoS lanes, dictionary compression, optional onion layering, and token-bucket flow control. |
| 14 | [Scoped Device Sessions](./14-scoped-device-sessions/) | QR-paired device sessions that default to read-only at the protocol level, with out-of-band per-intent elevation permits. |
| 22 | [Autonomous Threat Response](./22-autonomous-threat-response/) | Citation-enforced autonomous defensive actions bound to a verifiable event log, with hard caps, burst auto-pause, audit rows, and one-tap revert. |
| 23 | [Multi-Tenant MCP Host](./23-mcp-multitenant-host/) | Host third-party tool servers with per-tenant namespacing, SSRF-hardened outbound, and per-turn approval-policy synthesis. |
| 25 | [Merkle Audit Anchoring](./25-merkle-audit-anchoring/) | Hash append-only audit events into a Merkle tree, anchor the root periodically, and emit inclusion proofs. |
| 26 | [Work Dispatcher with Scoped Invocation Tokens](./26-work-dispatcher-invocation-tokens/) | Async job orchestration where a short-lived invocation token grants user context without exposing the raw session token. |
| 27 | [Universal Controller Overlay](./27-universal-controller-overlay/) | Pair a phone as an input surface for a primary session via relay tickets and a deterministic channel id, with viewport sync. |
| 28 | [Agent-to-Agent Marketplace](./28-a2a-marketplace/) | A marketplace and job feed for autonomous agents under strict tenant isolation, where a job UUID alone is never authorization. |
| 35 | [Injected App Bridge](./35-injected-app-bridge/) | Serve single-file HTML mini-apps with a dynamically injected `window`-level RPC bridge for scoped identity and storage. |
| 36 | [Wallet-to-Wallet E2E Messaging](./36-dmail-e2e-messaging/) | End-to-end encrypted messaging where the server stores only opaque envelopes yet still indexes metadata for retrieval. |
| 42 | [DNS-Pinned SSRF Guard](./42-dns-pinned-ssrf-guard/) | Resolves a host, validates every A/AAAA record against private/metadata ranges, then connects to the pinned IP with the original SNI/Host — closing the DNS-rebinding window. |
| 44 | [Incident Response Playbook Engine](./44-incident-playbook-engine/) | Regex detection terms map to ordered response steps tagged auto-executable vs approval-required — a machine-readable runbook an agent can execute. |
| 45 | [Stateless HMAC Preview-Gate Tokens](./45-hmac-preview-gate/) | An HMAC over the gate password issued to the client; rotating the password invalidates every token with no session store, verified in constant time. |
| 57 | [Boundary-Aligned Streaming Pulse Encoder](./57-boundary-aligned-streaming/) | Accumulates stream tokens and flushes pulse frames on sentence/clause boundaries or a time cap, so chunks arrive as complete linguistic or code units. |
| 59 | [Onion-Layered Multi-Hop Transport](./59-onion-layered-transport/) | Layered encryption where each hop peels exactly one layer to learn only the next hop, hiding payload and final destination from intermediaries. |
| 60 | [On-Demand Encrypted Knowledge Blobs](./60-on-demand-knowledge-blobs/) | Knowledge fragments stored as compressed, encrypted, content-addressed blobs, fetched and injected on intent match then evicted to avoid prompt bloat. |
| 61 | [Procedural Scene Macros](./61-procedural-scene-macros/) | Short macro tokens expand server-side into hundreds of concrete scene ops via a seeded PRNG, cutting generative-3D output tokens by up to ~25×. |
| 62 | [Proof-of-Bandwidth Relay Accounting](./62-proof-of-bandwidth-relay/) | Credits relayed bytes only for valid payloads actually forwarded to a peer over a sliding window, with single-use tickets upgrading sessions without bearer tokens in URLs. |
| 63 | [Hierarchical Spatial Scene Synthesis](./63-hierarchical-scene-synthesis/) | A SceneSpec → ZoneGraph → ChunkPlan → ops pipeline multiplexed into a ring-buffered, sequence-numbered replayable stream for reliable client sync. |
| 64 | [Ephemeral Presence Registry with Privacy Blackout](./64-ephemeral-presence-registry/) | An in-memory ring buffer of ambient signals reduced to a never-persisted presence summary, with a two-layer privacy blackout that overrides other instructions. |
| 65 | [In-Stream Sub-Channel Multiplexer](./65-stream-submultiplexer/) | Several logical sub-channels inside one stream with per-channel token buckets so small control frames are never starved by large data frames. |

## License

MIT — see [LICENSE](./LICENSE). Provided for educational reference; use at your own risk, and please don't ship the cryptography without independent review.
