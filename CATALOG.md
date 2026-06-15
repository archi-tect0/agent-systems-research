# Catalog

The full guide index for [Engineering Research: Agent & Self-Custody Systems](./README.md), grouped by layer. Each guide is a self-contained folder with a README and a runnable reference implementation you can run with `node <file>.ts --demo`.

### Integrated core

| # | Guide | Summary |
|---|-------|---------|
| 00 | [Agent Kernel — the integrated core of the five primitives](./00-agent-kernel/) | A runnable, dependency-free kernel that composes memory, tool routing, governance, wallet limits, and a typed world model behind one policy-free contract — the integrated floor the numbered guides each go deeper on. |
| 73 | [Reflective Runtime — the integrated Layer-2 loop](./73-reflective-runtime/) | A runnable runtime that wires the metacognition primitives (66–72) onto the kernel loop — route, score, govern, dispatch, remember, reflect — with calibrated uncertainty, a self-model, gap-driven capability growth, and verified human-merged self-repair, in ~500 deterministic lines. |

### Identity, keys, and cryptography

| # | Guide | Summary |
|---|-------|---------|
| 01 | [Fibonacci-Harmonic Key Derivation Function (FH-KDF)](./01-fh-kdf/) | Standard HKDF-SHA256 is a well-audited, widely-deployed KDF. |
| 02 | [Post-Quantum HKDF (HKDF-SHA3-256)](./02-pq-hkdf/) | HKDF-SHA256 is the standard key derivation function in most modern systems. |
| 13 | [Committed Lattice Secret Sharing](./13-fractal-lattice-sharding/) | Shamir Secret Sharing (SSS) splits a secret into *n* shares such that any *k* of them reconstruct it and any *k-1* reveal nothing. |
| 19 | [Hybrid Post-Quantum Identity](./19-hybrid-pqc-identity/) | An account today is anchored by an ECDSA keypair (secp256k1 — the EVM/Bitcoin curve) or an RSA signing key (OIDC id-tokens). |
| 20 | [SIWE Login with a Passkey Floor](./20-siwe-passkey-floor/) | Sign-In With Ethereum (SIWE, EIP-4361) authenticates a user by having them sign a structured message with their wallet key. |
| 21 | [Behavioral Continuous Authentication](./21-behavioral-continuous-auth/) | Authentication is almost always a single gate: pass the login, get a session, then the session is trusted until it expires. |
| 41 | [Hybrid RSA + Post-Quantum OIDC Token Signing](./41-hybrid-oidc-pq-signing/) | An OpenID Connect provider signs ID tokens with RS256 (RSA + SHA-256). |
| 43 | [Domain-Isolated Deterministic Address Aliases](./43-domain-isolated-address-alias/) | A user with a single master seed often needs to present an account address to many independent sites — a shop, a forum, a bank portal, a social app. |
| 51 | [Deterministic Post-Quantum Action Receipts](./51-deterministic-action-receipts/) | When an autonomous agent performs actions on a user's behalf — approving a token transfer, firing an intent, running a scheduled task — there needs to be durable, non-repudiable proof of *what was authorised and executed*. |

### Wallets and payments

| # | Guide | Summary |
|---|-------|---------|
| 15 | [Multi-Chain Shadow Wallet Derivation (HKDF, no BIP-39 seed)](./15-multichain-shadow-derivation/) | A user authenticates once — with a passkey, a wallet signature, or any other identity proof — and now wants to hold and move assets across several blockchains with completely different key formats and address encodings: - Bitcoin — secp256k1 keys, P2WPKH SegWit (bech32) addresses - Solana — Ed25519 keys, base58 public-key addresses - EVM chains (Ethereum / BNB Chain / Polygon / Base / Arbitrum) — secp256k1 keys, keccak-256 derived 20-byte addresses - TRON — secp256k1 keys, keccak-256 hash + 0x41 version byte + Base58Check The conventional answer is BIP-39 / BIP-44: generate a 12/24-word mnemonic, expand it into a seed, then walk a hardened derivation path per chain. |
| 16 | [Time-of-Flight Proximity Payment ("Tap to Pay", relay-resistant)](./16-proximity-payment-tof/) | Two people standing next to each other want to exchange value by physically tapping their phones together — the wallet equivalent of a contactless card. |
| 17 | [Agent Spend-Limit Wallet (autonomous spend with a human approval floor)](./17-agent-spend-limit-wallet/) | An autonomous software agent — an LLM tool-caller, a trading bot, a recurring-payment daemon — needs to *spend money on-chain on its own*. |
| 18 | [Multi-Chain Spend Governor (velocity limits + fail-closed pricing + guardian freeze)](./18-multichain-spend-governor/) | A wallet holds assets on many chains — Bitcoin, Solana (and its SPL tokens), TRON, and a family of EVM chains — and we want to enforce one coherent spending policy across all of them: - a per-transaction cap (no single transfer larger than X), - a daily cap (no more than Y total across all chains per UTC day), - and a guardian freeze that can halt *every* outbound transfer during an incident. |
| 29 | [Quorum Vault Groups (M-of-N approval + autonomous child sub-vaults)](./29-quorum-vault-groups/) | A shared vault — a family account, a team treasury, a DAO sub-budget — needs two governance shapes at once: 1. |
| 32 | [Covenant Dual-Custody (paired human + machine identity NFTs)](./32-covenant-dual-custody/) | When an autonomous agent acts on a user's behalf — signing, spending, proving identity — you want a durable, verifiable record that both the human and the machine were bound together at the moment the relationship was created. |
| 34 | [Emergency Cross-Chain Sweep](./34-emergency-cross-chain-sweep/) | A wallet is compromised — a seed phrase phished, a malicious approval signed, a device stolen with keys on it. |

### Agent cognition: memory and tools

| # | Guide | Summary |
|---|-------|---------|
| 06 | [Compound Memory Salience Scoring](./06-compound-memory-salience/) | A long-running conversational agent accumulates thousands of memories: stated facts, behavioral corrections, emotional moments, project notes. |
| 07 | [Reflective Memory with Use-Reinforced Sorting](./07-reflective-memory/) | The salience-scored memory layer (guide 06) is good at *recall* — surfacing relevant facts for the current turn. |
| 09 | [Intent-Based Tool Schema Selection](./09-intent-based-tool-selection/) | A capable agent exposes a large tool surface — 80+ functions for memory, web, wallet, scheduling, code, messaging, media, apps, and platform control. |
| 10 | [Intent-Gated Personal Knowledge Shards](./10-personal-knowledge-shards/) | The memory systems in guides 06–07 are general-purpose: a salience-ranked pool of recalled facts and a set of behavioral reflections. |
| 33 | [Knowledge Absorber → Zero-Token Vocabulary](./33-knowledge-absorber-sq-vocab/) | An agent built on a small local model has a fixed knowledge base — its weights. |
| 46 | [Typed World-Model Graph with Goal Topology](./46-typed-world-model-graph/) | Most agent "memory" systems are flat: a vector store of text chunks retrieved by similarity. |
| 47 | [Ambient World-Snapshot Prefetch Bus](./47-ambient-snapshot-bus/) | An assistant is constantly asked ambient questions — "what's the weather?", "anything happening in the markets?", "any big news?" — whose answers change slowly relative to how often they're asked. |
| 54 | [LLM-Resident Context Codec (Token-Space Shorthand)](./54-llm-resident-context-codec/) | Large language model prompts are billed and rate-limited by token count, not by character count or semantic content. |

### Agent cognition: routing and growth

| # | Guide | Summary |
|---|-------|---------|
| 12 | [Resilient Multi-Provider LLM Routing](./12-resilient-llm-routing/) | A production conversational agent depends on a frontier LLM that it does not control. |
| 24 | [Cloud / Local Privacy Router](./24-cloud-local-privacy-router/) | A hybrid agent has two places to run a turn: a small local model on the user's device (private, but limited) and a powerful cloud model (capable, but it sees everything you send it). |
| 30 | [Agent LoRA / Prefix-Weight Compiler](./30-lora-prefix-weight-compiler/) | A locally-run agent has a fixed identity: a system prompt, a consistent voice, and a set of stable facts about its owner ("timezone is America/New_York", "prefers oat flat whites"). |
| 31 | [Relational Intelligence Model](./31-relational-intelligence-model/) | A long-lived personal agent talks to the *same* person across hundreds of sessions. |
| 52 | [Competence-Gated On-Device Distillation Router](./52-competence-distillation-router/) | A hybrid agent runs against two very different models: a large, expensive cloud model and a small, cheap, private on-device model. |
| 53 | [Manifest-Driven LoRA Expert Router](./53-lora-manifest-router/) | A local inference stack can host many small fine-tuned adapters — LoRA "experts" — each teaching one narrow, stable capability: formatting tool calls, reviewing a transaction for risk, synthesizing a world model from raw conversation, operating memory. |
| 55 | [Dependency-Aware Parallel Tool Dispatch](./55-tool-dependency-dag/) | When a language model decides to call several tools in a single turn, the simplest dispatcher runs them one after another. |
| 56 | [Speculative Tool Prefetch from Stream Heads](./56-speculative-tool-prefetch/) | An agent runtime that lets a language model call tools usually runs in phases: the model streams its response, then — once generation is far enough along — a dispatch phase parses out the tool calls and executes them. |
| 58 | [Batched Intent Collapse with Merkle Fan-Out](./58-batched-intent-collapse/) | A busy agent runtime resolves many independent requests against a large language model. |

### Agent governance

| # | Guide | Summary |
|---|-------|---------|
| 08 | [DB-Backed Autonomous Agent Scheduler](./08-autonomous-agent-scheduler/) | An assistant that can only act while the user has a tab open is not autonomous. |
| 37 | [Tiered Authority Bands for Agent Tool Execution](./37-agent-authority-bands/) | An autonomous agent that can call tools has a spectrum of capabilities: some are pure reads (check a balance, look up a price), some prepare an action without committing it, some perform bounded reversible writes, and some are irreversible and high-stakes (send funds, revoke a key, delete a vault). |
| 38 | [Will / Objective Topology + Constitutional Guardrail Layer](./38-will-constitution-engine/) | A capable agent that only optimizes the *local* prompt drifts. |
| 39 | [Tool-Use Critic — Independent Pre-Execution Validator](./39-tool-critic/) | An LLM that emits tool calls is, from a security standpoint, an untrusted code generator. |
| 40 | [Conversation State Kernel — Per-Turn Governance FSM](./40-conversation-state-kernel/) | A streaming conversational agent that can call tools, spawn background workers, and react to rapid-fire input has a control-flow problem that a simple request/response handler does not. |
| 48 | [Agent Action Idempotency Reconciler](./48-action-idempotency-reconciler/) | An autonomous agent that proposes write actions — send funds, post a message, schedule a job — does not behave like a deterministic function. |
| 49 | [Batched Single-Signature Approval Queue](./49-batched-approval-ceremony/) | An autonomous agent often decides, within a single reasoning turn, to take several write actions at once: tag a contact, draft a message, rename a label, and move some funds. |
| 50 | [Headless Read-Only Reasoning Shards](./50-headless-reasoning-shards/) | When an agent faces a hard decision, running a single model pass is fragile: the model can be confidently wrong, and there is no second opinion. |

### Platform, transport, and security

| # | Guide | Summary |
|---|-------|---------|
| 03 | [Adaptive Session Symbol Table (SQ-B Compression)](./03-adaptive-session-compression/) | Every call to a frontier LLM API charges for input tokens. |
| 04 | [Session Static Manifest (SSM)](./04-session-static-manifest/) | Every LLM session has two distinct components in its context window: 1. |
| 05 | [Encrypted Content-Addressed Identity Blobs (IPFS)](./05-encrypted-identity-ipfs/) | An agent platform needs to persist large, sensitive text artifacts: an agent's identity/personality definition, a user's imported chat history, a knowledge corpus, a wallet keystore. |
| 11 | [QoS-Lane Stream Multiplexer (Yamux)](./11-yamux-qos-multiplexer/) | A single long-lived connection (a WebSocket, a TCP socket) often has to carry many independent logical conversations at once: an authentication handshake, a bulk blob transfer, a stream of small chat messages, and a periodic keepalive ping. |
| 14 | [Scoped Device Sessions](./14-scoped-device-sessions/) | A user signed in on their phone wants to use the same account on a laptop without typing credentials or moving a hardware key. |
| 22 | [Autonomous Threat Response with a Safety Contract](./22-autonomous-threat-response/) | Once an AI agent can *observe* security telemetry, the next obvious step is to let it *act* on it — block a hostile IP, trip a circuit breaker on an abused route, freeze a misbehaving app, revoke a stolen session, rate-limit a wallet. |
| 23 | [Multi-Tenant MCP Host with SSRF Defense](./23-mcp-multitenant-host/) | The Model Context Protocol (MCP) lets a third party expose a catalog of tools that an agent can discover and call. |
| 25 | [Merkle Audit Anchoring](./25-merkle-audit-anchoring/) | A system that takes consequential actions — moving funds, changing permissions, blocking traffic — needs an audit log that is *tamper-evident*. |
| 26 | [Work Dispatcher with Scoped Invocation Tokens](./26-work-dispatcher-invocation-tokens/) | A platform lets third-party apps invoke capabilities on behalf of a user — "summarize my calendar", "rebalance my portfolio", "render this scene". |
| 27 | [Universal Controller Overlay + Viewport Sync](./27-universal-controller-overlay/) | A user is running a heavy GPU/3D session on a TV or laptop, but the device with the best input surface is in their hand — their phone. |
| 28 | [Agent-to-Agent Marketplace and Job Feed](./28-a2a-marketplace/) | As autonomous agents proliferate, they need a way to *hire each other*. |
| 35 | [Injected App Bridge for Single-File Mini-Apps](./35-injected-app-bridge/) | We want users to author tiny "mini-apps" — a single HTML file with inline CSS and JavaScript — and run them inside a host application (an OS-like shell, a launcher, an agent surface). |
| 36 | [Wallet-to-Wallet End-to-End Encrypted Messaging](./36-dmail-e2e-messaging/) | We want a private messaging system addressed by wallet, not by email or phone. |
| 42 | [DNS-Pinned SSRF Guard for Outbound Webhooks](./42-dns-pinned-ssrf-guard/) | A service that lets users register an outbound webhook URL — "POST here when something happens" — is handing an attacker a server-side request primitive. |
| 44 | [Deterministic Incident Response Playbook Engine](./44-incident-playbook-engine/) | When a security incident is suspected — a drained account, a phishing message, a leaked key — the response should be fast, ordered, and consistent. |
| 45 | [Stateless HMAC Preview-Gate Tokens](./45-hmac-preview-gate/) | A site under development is often put behind a single shared password — a "preview gate" — so that only people who know the phrase can see it. |
| 57 | [Boundary-Aligned Streaming Pulse Encoder](./57-boundary-aligned-streaming/) | Language models emit tokens one at a time, and the naive thing to do is forward each token to the client the instant it arrives. |
| 59 | [Onion-Layered Multi-Hop Transport](./59-onion-layered-transport/) | When two parties communicate through a network of relays, each relay is a potential observer. |
| 60 | [On-Demand Encrypted Knowledge-Blob Injection](./60-on-demand-knowledge-blobs/) | A capable assistant needs to "know" how to operate many apps, tools, and domains. |
| 61 | [Procedural Scene Macros for Token-Efficient 3D](./61-procedural-scene-macros/) | When a language model authors a 3D scene by emitting concrete commands — one per box, sphere, or light — the output token count explodes. |
| 62 | [Proof-of-Bandwidth Relay Accounting](./62-proof-of-bandwidth-relay/) | A relay node earns its keep by forwarding traffic between peers that cannot reach each other directly. |
| 63 | [Hierarchical Spatial Scene Synthesis](./63-hierarchical-scene-synthesis/) | Generating a 3D scene directly as a flat list of engine commands is hard to control. |
| 64 | [Ephemeral Presence Registry with Privacy Blackout](./64-ephemeral-presence-registry/) | An assistant that runs across several of a person's devices benefits from knowing whether that person is *present* right now: are they actively interacting, did a phone just detect motion, is a microphone listening, or has everything gone quiet for ten minutes? |
| 65 | [In-Stream Sub-Channel Multiplexer with Flow Control](./65-stream-submultiplexer/) | A connection-level multiplexer already lets one socket carry many independent streams, each on its own QoS lane (see guide 11). |

### Agent self-maintenance (metacognition)

The Layer-2 set — the agent operating on *itself*. Each runs on Node built-ins.

| # | Guide | Summary |
|---|-------|---------|
| 66 | [Metacognitive Self-Repair Loop](./66-metacognitive-self-repair/) | The point where an agent stops being a chatbot and becomes an operator is the moment it can answer "what is wrong with me right now?" — and fix it without being able to quietly break itself. |
| 67 | [Agent Self-Model Graph](./67-agent-self-model-graph/) | When a user says "your memory is broken", they are reporting a symptom, not a cause; the agent needs an explicit typed model of its own subsystems, capabilities, and live health to localize the fault and its blast radius. |
| 68 | [Calibrated Uncertainty Engine](./68-calibrated-uncertainty-engine/) | An agent that sounds equally confident about "this song is lo-fi" and "send 2 ETH to this address" is dangerous in exactly the second case. |
| 69 | [Self-Directed Capability Acquisition](./69-self-directed-capability-acquisition/) | A long-running agent repeatedly hits intents it cannot satisfy; letting it write its own tools is an account-compromise primitive wearing a helpful hat — the value is the wall around it. |
| 70 | [Resource Self-Governance](./70-resource-self-governance/) | An agent that always reaches for its best tool behaves correctly right up until it runs out of budget mid-task — and then fails the whole job, often after the expensive part is already spent. |
| 71 | [Memory Consolidation ("Sleep")](./71-memory-consolidation-sleep/) | While an agent is awake it accumulates raw episodic memories — duplicates and noise included — and without a consolidation pass that store grows without bound and buries its few durable lessons. |
| 72 | [Counterfactual Simulation](./72-counterfactual-simulation/) | An agent about to run a multi-step plan with a real, irreversible side-effect has no safe way to ask "what happens if I run this?" without running it. |

### Reasoning in the world (time, space, society)

The Layer-3 set — the agent reasoning beyond a single turn and a single mind. Each runs on Node built-ins.

| # | Guide | Summary |
|---|-------|---------|
| 74 | [Multi-Turn Deliberation & Multi-Step Planning](./74-multi-turn-deliberation/) | A single-turn agent re-derives its intent from scratch every turn and forgets what it was doing the moment the turn ends; this is the buffer that carries one intent across many turns — a plan graph of subgoals, a per-turn monitor that re-checks assumptions against the live world, splice-in repair, and explicit succeeded/failed/escalated/abandoned termination. |
| 75 | [World-Model & Belief State](./75-world-model-belief-state/) | An agent that stores facts as bare assertions can't tell a hunch from a near-certainty, has no rule for how an observation should move a fact, and can't notice two beliefs that contradict each other; this folds noisy evidence into calibrated confidence via log-odds, flags and repairs contradictions by weight, and predicts an action's effect on a clone before committing. |
| 76 | [Multi-Agent Coordination & Social Reasoning](./76-multi-agent-coordination/) | An agent that models the world but not the agents in it will confidently act on a plan everyone else has already abandoned; this is the social layer — modeling what other minds believe, earning and spending trust by outcome, committing a shared plan only on authority and quorum, resolving contradictory claims by rank, and catching a peer whose actions betray its words. |
