# Agent Kernel — The Integrated Core of the Five Primitives

## Problem

Most guides in this collection isolate a single agent primitive so it can be read and run on its own. A working agent runs several of them at once: against shared state, in a defined order, with each one's output feeding the next. That integration layer is where the real coupling lives, and it is the part that almost never gets written down.

In practice the `Agent ⇄ Tool ⇄ State` contract that ties memory, tool routing, governance, spend control, and a world model together has roughly the same shape in every agent. But it is usually undocumented and welded to one system's chains, keys, prompts, and thresholds. Lifting an agent's runtime out of its product means first untangling that contract from the policy baked into it.

This is that contract and a minimal implementation of it: the five primitives behind a single, policy-free interface, composed by a thin assembly layer. It runs on Node.js built-ins with no dependencies.

The line it draws everywhere is **mechanism vs. policy**. The kernel knows how to enforce a spend limit; it does not know your limit. It knows how to gate an action on a capability; it does not know which capabilities you grant. It knows how to rank memory; it does not know what is important to you. The kernel supplies the mechanism; the agent on top supplies the policy.

## Design decisions

**Why a policy-free contract in one file?**
The kernel's ABI lives in [`src/types.ts`](./src/types.ts) and contains only shapes — no chain ids, no spend thresholds, no prompt strings, no product concepts. The contract is the stable surface that primitives and consumers agree on; the primitives are just implementations of it. Keeping policy out of the contract is what lets one kernel back very different agents without forking: the shapes do not change when the numbers do.

**Why a thin assembly layer with a replaceable composition?**
The kernel owns no control flow of its own. It exposes the five primitives directly (`memory`, `tools`, `governance`, `wallet`, `world`) so an agent can drive them however it likes, and provides one reference composition — `runIntent` — that threads them in the order a careful agent would: route → govern → spend-check → dispatch → remember. That ordering is a convenience, not a constraint; reorder or replace it freely, because the primitives do not depend on it.

**Why check the spend limit before execution but charge after success?**
A spend is authorized in two moments. `wallet.attempt()` runs before dispatch so an over-cap or over-threshold spend is denied or escalated without side effects. `wallet.record()` runs only after the spending tool actually succeeds. A transfer that throws or fails never consumes the rolling window, so a flaky downstream cannot silently burn a user's budget.

**Why invariants that override granted capabilities?**
Governance is two layers. First a capability check: the action's required capability must have been granted. Then a set of invariants — hard rules that can deny regardless of granted capabilities. Invariants always win, so a broad capability grant can never talk its way past a safety rule. Which capabilities to grant and which invariants to install is policy; the precedence between them is mechanism.

**Why a rolling-window governor that fails closed?**
The wallet enforces a total spend cap inside a time window and forces human approval for any single spend at or above a threshold. A malformed amount, or a missing/invalid config, denies rather than defaulting to permissive. Fail-closed is the only safe default for the one primitive that moves money.

**Why salience ranking with a swappable similarity function?**
Recall blends lexical similarity, recency, prior usage, and caller-supplied importance into one score. Similarity is a built-in token overlap so the primitive runs with no embeddings and no external service; swap in a vector scorer by replacing one function and the rest of the mechanism is unchanged. Recall also reinforces — a recalled item's use count rises, so frequently useful memories surface more easily over time.

**Why render the world model as text?**
The world model is a typed entity graph with parent/child links, reconstructed into a compact indented block at read time and injected into the prompt. Entity types (person, goal, project, routine, …) are caller-defined; the kernel only knows ids, labels, and parent links. The agent reasons over prose, so the world model's job is to become good prose, not to be a query engine.

## Algorithm

```
runIntent(intent, amount?):
  tool = route(intent)                       # highest trigger-term match wins
  if not tool: return denied("no tool matched")

  auth = govern(tool.capability, {intent, amount})    # capability, then invariants
  if not auth.allowed: return denied(auth.reason)

  if tool.spend:                             # only tools that move funds hit the wallet
    d = wallet.attempt(amount)               # check the window/threshold, do not charge
    if not d.allowed:        return denied(d.reason)
    if d.requiresApproval:   return needsApproval(d.reason)

  results = dispatch(tool)                    # resolve dependency closure, run in waves
  if tool.spend and results[tool].ok:
    wallet.record(amount)                     # charge only after the spend succeeded

  remember(intent -> tool)                    # record the turn for future recall
  return results[tool]
```

Tool dispatch resolves the transitive dependency closure of the requested tool, runs independent tools concurrently, passes each dependent tool its dependencies' outputs, and fails a dependent closed if a dependency is missing or failed rather than passing it `undefined`. Cycles are detected and fail closed instead of deadlocking.

## Reference implementation

The kernel is small enough to read in one pass. Each file is one concern:

```
src/types.ts        the ABI — the policy-free Agent ⇄ Tool ⇄ State contract
src/memory.ts       salience-ranked recall (similarity + recency + usage + importance)
src/toolRouter.ts   intent → tool registry with dependency-aware concurrent dispatch
src/governance.ts   capability grants plus hard invariants that always win
src/walletLimits.ts rolling-window spend governor with an approval threshold, fail-closed
src/worldModel.ts   typed entity graph rendered as a prompt context block
src/kernel.ts       the assembly layer that composes the five
demo.ts             end-to-end demo, one agent turn at a time
```

Run the demo with Node 24+ (which strips TypeScript types natively) or `tsx`:

```bash
node demo.ts
# or
npx tsx demo.ts
```

It walks one agent turn at a time: a routed read, an allowed spend, an over-threshold spend that needs approval, an over-cap spend that is denied, a revoked capability, a hard invariant firing, and the context block the agent would inject into a prompt.

## Usage

```ts
import { Kernel } from "./src/kernel.ts";

const kernel = new Kernel({
  // policy: your numbers, not the kernel's
  wallet: { limit: 200, windowMs: 60_000, approvalThreshold: 100 },
});

kernel.tools.register({
  name: "transfer",
  description: "Send funds",
  triggers: ["send", "transfer", "pay"],
  capability: "wallet.transfer",
  spend: true,                       // subject to wallet limits; charged only on success
  run: (input) => ({ sent: true, intent: input.intent }),
});

kernel.governance.grant("wallet.transfer");
kernel.governance.addInvariant({
  name: "hard-ceiling",
  check: (a) =>
    typeof a.payload.amount === "number" && a.payload.amount > 1000
      ? "exceeds hard ceiling"
      : null,
});

kernel.world.upsert({ id: "g1", type: "goal", label: "Ship v1", props: {} });

const result = await kernel.runIntent("send 50 to alice", { amount: 50 });
const context = kernel.context("transfer to payee");   // world model + relevant memory
```

`runIntent` is one reference composition. The primitives are exposed directly (`kernel.memory`, `kernel.tools`, `kernel.governance`, `kernel.wallet`, `kernel.world`), so you can wire your own loop instead.

## Relationship to the guides

This is the integrated floor; the numbered guides go deeper on individual primitives and their harder variants:

- **Memory** — guides 06 (compound salience) and 07 (reflective memory) for richer ranking, decay, and contradiction handling.
- **Tool routing** — guide 09 (intent-based selection), 55 (dependency DAG), 56 (speculative prefetch), 39 (tool critic).
- **Governance** — guide 37 (authority bands), 38 (will/constitution engine), 49 (batched approval ceremony).
- **Wallet limits** — guide 17 (spend-limit wallet), 18 (multichain spend governor).
- **World model** — guide 46 (typed world-model graph), 47 (ambient snapshot bus), 40 (conversation state kernel).
- **Audit & idempotency** — guide 25 (merkle audit anchoring), 48 (action idempotency reconciler).

The kernel is the minimal core that ties them together; the guides are how to push each primitive further.

## Limitations and extensions

- **In-memory only.** Every primitive holds its state in process; nothing persists across restarts. Back each one with your own store — the interfaces in `types.ts` are the seam to do it behind.
- **No LLM, prompt, or loop opinions.** The kernel routes, governs, spends, remembers, and renders context; it does not call a model or template a prompt. `runIntent` is a composition, not an agent loop.
- **Routing is a substring trigger match.** `intent.includes(term)` is fast and dependency-free but collides on shared substrings (`pay` in `repay`) and misses paraphrase. Guide 09 is the real router; this is the floor.
- **Approval is a signal, not a resumable flow.** `runIntent` reports `requiresApproval` and stops. A production wallet needs a continuation — an approval token or an `approved` flag an invariant checks — to resume the gated spend. Guides 49 and 20 cover the approval and passkey side.
- **No decision log.** Governance and wallet decisions are made and forgotten. An emit hook on each decision (mechanism) with a caller-supplied sink (policy) is the natural extension; guides 25 and 48 are where those decisions would be anchored and de-duplicated.
- **Not audited.** The wallet and governance logic are a clean reference, not a security boundary to ship without review.

## License

MIT — see [LICENSE](./LICENSE).
