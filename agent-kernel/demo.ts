// End-to-end demo: one agent turn at a time, exercising all five primitives.
// Run with:  node demo.ts        (Node 24+)
//        or:  npx tsx demo.ts

import { Kernel } from "./src/kernel.ts";

async function main(): Promise<void> {
  const kernel = new Kernel({
    wallet: { limit: 200, windowMs: 60_000, approvalThreshold: 100 },
  });

  // --- World model: a small goal hierarchy -------------------------------
  kernel.world.upsert({ id: "g1", type: "goal", label: "Financial independence", props: {} });
  kernel.world.upsert({ id: "p1", type: "project", label: "Emergency fund", parentId: "g1", props: { target: "10000" } });
  kernel.world.upsert({ id: "r1", type: "routine", label: "Weekly budget review", parentId: "g1", props: { day: "sun" } });
  kernel.world.upsert({ id: "c1", type: "person", label: "Alice", props: { relation: "payee" } });

  // --- Tools: a read tool and a write tool that depends on it ------------
  kernel.tools.register({
    name: "price",
    description: "Look up a unit price.",
    triggers: ["price", "quote", "how much"],
    run: () => ({ usd: 25 }),
  });
  kernel.tools.register({
    name: "transfer",
    description: "Send funds to a payee.",
    triggers: ["send", "transfer", "pay"],
    capability: "wallet.transfer",
    spend: true,
    dependsOn: ["price"],
    run: (input) => {
      const price = input.deps.price as { usd: number } | undefined;
      return { sent: true, unitPrice: price?.usd ?? null, intent: input.intent };
    },
  });

  // --- Governance: grant the write capability + a hard invariant ---------
  kernel.governance.grant("wallet.transfer");
  kernel.governance.addInvariant({
    name: "hard-ceiling",
    check: (action) => {
      const amount = action.payload.amount;
      if (typeof amount === "number" && amount > 1000) {
        return "single transfer exceeds the hard ceiling of 1000";
      }
      return null;
    },
  });

  const show = (label: string, r: { ok: boolean; output?: unknown; denied?: string; requiresApproval?: boolean }) => {
    const verdict = r.ok
      ? `OK -> ${JSON.stringify(r.output)}`
      : r.requiresApproval
        ? `NEEDS APPROVAL (${r.denied})`
        : `DENIED (${r.denied})`;
    console.log(`  ${label}\n    ${verdict}`);
  };

  console.log("=== Agent turns ===");
  show("price?            ", await kernel.runIntent("what's the price?"));
  show("send 50 to alice  ", await kernel.runIntent("send 50 to alice", { amount: 50 }));
  show("send 150 to bob   ", await kernel.runIntent("send 150 to bob", { amount: 150 }));
  show("send 80 more      ", await kernel.runIntent("send 80 more", { amount: 80 }));
  show("send 90 (over cap)", await kernel.runIntent("send 90", { amount: 90 }));

  console.log(`\n  window spent so far: ${kernel.wallet.spent()} / ${kernel.wallet.limit}`);

  console.log("\n=== Governance ===");
  kernel.governance.revoke("wallet.transfer");
  show("send 10 (revoked) ", await kernel.runIntent("send 10", { amount: 10 }));
  kernel.governance.grant("wallet.transfer");
  show("send 5000 (ceil)  ", await kernel.runIntent("send 5000", { amount: 5000 }));

  console.log("\n=== Context block the agent would inject ===");
  console.log(kernel.context("transfer to payee"));

  console.log(`\nmemory items: ${kernel.memory.size()}, world entities: ${kernel.world.size()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
