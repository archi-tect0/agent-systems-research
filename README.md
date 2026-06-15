# Engineering Research: Agent & Self-Custody Systems

A collection of engineering patterns worked out while building a self-custodial, agent-driven identity and wallet system. Each one is written up as a standalone research guide — the problem it solves, the design decisions behind it, the algorithm, and a small reference implementation you can actually run.

This is shared in the spirit of *here is how I approached these problems, in case it's useful to you* — not as a framework, a product, or a claim to have solved anything for good. Take what helps, ignore the rest, improve on it.

## What this is — and isn't

- **It is** ~76 self-contained, runnable reference implementations with the reasoning attached. Most code you find online shows you *what*; these try to show you *why*.
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

## How the pieces fit together

Each guide stands alone, but they were extracted from one real system, so they stack into layers rather than sitting in a flat pile. Read bottom-to-top, the catalog is roughly an agent acting on a user's behalf — from the substrate it runs on, up through the keys that identify it, to the governance that gates what it does:

```
                 intent ──▶ action
  ┌────────────────────────────────────────────────┐
  │  Reflection   observe, repair, and grow the     │
  │               agent itself, gated like a write  │
  ├────────────────────────────────────────────────┤
  │  Governance   gate every write before it lands  │
  ├────────────────────────────────────────────────┤
  │  Cognition    decide what to do (memory,        │
  │               world model, routing)             │
  ├────────────────────────────────────────────────┤
  │  Wallet       hold and move value under policy  │
  ├────────────────────────────────────────────────┤
  │  Identity     who the actor is                  │
  ├────────────────────────────────────────────────┤
  │  Platform     the substrate underneath          │
  └────────────────────────────────────────────────┘
       (self-maintenance at the top, transport at the base)
```

The threads that run between the layers matter more than the layers themselves:

- **Identity anchors the wallet.** A passkey/SIWE login or PQ identity (19–21) binds a shadow-derived wallet (15) and its spend policy (17, 18) to a specific actor — no seed phrase to manage.
- **Cognition splits into context and dispatch.** Memory (06, 07, 10) and the typed world model (46, 47) supply *what the agent knows*; intent routing and parallel tool dispatch (09, 55, 56) turn *what it wants* into tool calls.
- **Governance wraps every write.** Authority bands (37), the will/constitution layer (38), an independent critic (39), the per-turn FSM (40), the batched approval queue (49), and idempotency (48) sit between intent and side effect — with receipts and audit anchoring (25, 48, 51) recording what happened.
- **`00-agent-kernel` is where five of these meet.** It composes memory, tool routing, governance, wallet limits, and a world model into one small runnable floor. Start there for the whole shape, then drop into a numbered guide for depth.
- **Self-maintenance is the reflective layer (66–72).** The agent operates on *itself*: a self-model (67) and repair loop (66) diagnose and fix faults, capability acquisition (69) grows missing tools, calibrated uncertainty (68) and resource self-governance (70) decide *whether* and *how cheaply* to act, memory consolidation (71) prunes what it learned, and counterfactual simulation (72) dry-runs irreversible plans — all behind the same throwaway-branch + human-merge gate as governance. The **reflective runtime (73)** wires these into one loop, as `00` does for the base five.
- **Reasoning in the world is Layer-3 (74–76).** Across *time*, *space*, and *society*: deliberation (74) carries one intent over many turns as a plan graph, repairing or abandoning it as the world shifts; the belief state (75) holds what's true *with* calibrated confidence, repairing contradictions and predicting on a clone; coordination (76) models other minds, earns trust by outcome, and commits only on authority and quorum.

These are reference patterns, not a packaged stack: nothing here forces you to adopt the layer above or below it. The map is for orientation — take a single layer, or trace one thread end to end.

### Start here

New to this? Read these six in order — the integrated core, then one guide from each layer:

[`00`](./00-agent-kernel/) core → [`20`](./20-siwe-passkey-floor/) identity → [`17`](./17-agent-spend-limit-wallet/) wallet → [`06`](./06-compound-memory-salience/) cognition → [`37`](./37-agent-authority-bands/) governance → [`25`](./25-merkle-audit-anchoring/) platform

The kernel (`00`) ties the layers together. Its reference loop, `runIntent`, runs the same pipeline every turn:

```
intent
  ↓
route → govern → spend-check → dispatch → remember
```

Spend is *checked* before dispatch but the wallet is only *charged* after the tool succeeds. Building the prompt is a separate call — `context()` renders the world model plus the most relevant memory.

## Catalog

All ~76 guides live in [CATALOG.md](./CATALOG.md), grouped by layer. Each is a self-contained folder with a README and a runnable `.ts` reference implementation.

- [Integrated core](./CATALOG.md#integrated-core) — `00`, `73`
- [Identity, keys, and cryptography](./CATALOG.md#identity-keys-and-cryptography)
- [Wallets and payments](./CATALOG.md#wallets-and-payments)
- [Agent cognition: memory and tools](./CATALOG.md#agent-cognition-memory-and-tools)
- [Agent cognition: routing and growth](./CATALOG.md#agent-cognition-routing-and-growth)
- [Agent governance](./CATALOG.md#agent-governance)
- [Platform, transport, and security](./CATALOG.md#platform-transport-and-security)
- [Agent self-maintenance (metacognition)](./CATALOG.md#agent-self-maintenance-metacognition) — Layer-2, `66`–`72`
- [Reasoning in the world (time, space, society)](./CATALOG.md#reasoning-in-the-world-time-space-society) — Layer-3, `74`–`76`

## License

MIT — see [LICENSE](./LICENSE). Provided for educational reference; use at your own risk, and please don't ship the cryptography without independent review.

```text
———————————————————————————————————————————————————————————————
 INTEGRATION RECONCILER · build residue · no action required
 okm  bc612f21b81018010116129ea096dceddac7393c497805a207f4915457
      3f556f9edd3e16b2f74eb007ca366b243c121c93ea8c43a5a23d37b2c1
      76db1af727978a5d13de65a1439702b61e4af50d26ccc10675666c2c19
      27d68132497ca372dcc7689a283217c1e7bccff867194185a2257aec35
      54b1b1f172637b05cb07399ab08bfdadccc30f579f63b0072039cd1062
      1d98cae1be4975a3778dd02e1da6d20b0f46137c080c47b463a3924921
      cd05d9b8a7ec63330f492323e0f3596e37c38e9edb80ae11ece184035d
      c1db8f6f9d92bf39ab3c5b79a8b2492a0410973a21e6fbb41295d60061
      bf25ef79b8c7667bb8cf23ba3cfa70f1c0ea077fef80aaa1140ee087ef
      f49a4c3be79443e18bf4d227380c9461050965eacc42223096dd3a3917
      89bc311e099047445715e422befc5dba0a0eb9
———————————————————————————————————————————————————————————————
```
