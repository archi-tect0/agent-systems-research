# agent-kernel

A minimal, MIT-licensed kernel for agent runtimes.

**Not a framework. Not a product.** A tiny, dependency-free core that implements
the five things every capable agent needs and almost everyone re-invents badly:

1. **Memory** — a salience-ranked store; recall blends similarity, recency, use, and importance.
2. **Tool routing** — an intent → tool registry with dependency-aware, concurrent dispatch.
3. **Governance** — capability grants plus hard invariants that can always say no.
4. **Wallet limits** — a rolling-window spend governor with an approval threshold, fail-closed.
5. **World model** — a typed entity graph rendered as a context block for a prompt.

The whole thing is a few hundred lines of TypeScript on Node.js built-ins. You
can read it in one sitting, run it without installing anything, and lift any
single primitive out on its own.

## Why this exists

Most "agent frameworks" are large, opinionated, and tangled with a specific
product. But the *runtime* underneath any agent is small. The hard interface —
the `Agent ⇄ Tool ⇄ State` contract — is the same everywhere; it's just usually
undocumented and welded to one company's wallet, chains, and prompts.

This kernel extracts that contract and nothing else.

The dividing line it draws everywhere: **the kernel ships the *mechanism*; your
agent ships the *policy*.** The kernel knows how to enforce a spend limit; it
does not know your limit. It knows how to gate an action on a capability; it
does not know which capabilities you grant. It knows how to rank memory; it does
not know what's important to you. You bring the policy; the kernel runs it.

## Run it

```bash
node demo.ts        # Node 24+ (runs TypeScript directly)
# or
npx tsx demo.ts     # any recent Node
```

The demo runs one agent turn at a time and shows every primitive: a routed read,
an allowed spend, an over-threshold spend that needs approval, an over-cap spend
that's denied, a capability that's been revoked, a hard invariant firing, and
the context block the agent would inject into a prompt.

## Use it

```ts
import { Kernel } from "./src/kernel.ts";

const kernel = new Kernel({
  // policy: your numbers, not the kernel's
  wallet: { limit: 200, windowMs: 60_000, approvalThreshold: 100 },
});

// register tools (a tool may depend on other tools)
kernel.tools.register({
  name: "transfer",
  description: "Send funds",
  triggers: ["send", "transfer", "pay"],
  capability: "wallet.transfer",
  spend: true, // subject to wallet limits; charged only on success
  run: (input) => ({ sent: true, intent: input.intent }),
});

// grant capabilities and install invariants (policy)
kernel.governance.grant("wallet.transfer");
kernel.governance.addInvariant({
  name: "hard-ceiling",
  check: (a) => (typeof a.payload.amount === "number" && a.payload.amount > 1000
    ? "exceeds hard ceiling" : null),
});

// seed the world model
kernel.world.upsert({ id: "g1", type: "goal", label: "Ship v1", props: {} });

// run an intent — route → govern → spend-check → dispatch → remember
const result = await kernel.runIntent("send 50 to alice", { amount: 50 });

// build the prompt context block
const context = kernel.context("transfer to payee");
```

You are not required to use `runIntent`. It is one reference composition of the
five primitives; the primitives are exposed directly (`kernel.memory`,
`kernel.tools`, `kernel.governance`, `kernel.wallet`, `kernel.world`) so you can
wire your own loop.

## The contract

The full ABI lives in [`src/types.ts`](./src/types.ts) — it is deliberately
policy-free: no chain ids, no thresholds, no prompts, no product concepts. That
file is the thing to read first; the primitives are just implementations of it.

## Layout

```
src/types.ts        the ABI — the Agent ⇄ Tool ⇄ State contract
src/memory.ts       primitive 1 — memory
src/toolRouter.ts   primitive 2 — tool routing
src/governance.ts   primitive 3 — governance
src/walletLimits.ts primitive 4 — wallet limits
src/worldModel.ts   primitive 5 — world model
src/kernel.ts       the assembly layer that composes the five
demo.ts             end-to-end demo
```

## Relationship to the guides

This kernel is the small, integrated core. The guides in the parent directory go
deep on individual primitives and their harder variants — richer memory ranking,
dependency-DAG dispatch, approval/passkey flows, session scoping, idempotency,
spend policy. Treat this kernel as the floor and the guides as the ways to push
each primitive further.

## Non-goals

- No LLM client, no prompt templating, no agent loop opinions — bring your own.
- No persistence — every primitive is in-memory; back them with your own store.
- No network, no chains, no keys — those are policy you supply at the edges.
- Not audited. The wallet and governance logic are a clean reference, not a
  security boundary you should ship without review.

## License

MIT — see [LICENSE](./LICENSE).
