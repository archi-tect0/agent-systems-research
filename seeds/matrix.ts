/**
 * The 100-Seed Combinatoric Archetype Matrix
 *
 * See ../README.md#100-seeds for the full explanation. This file is the
 * single source of truth for the matrix: three independent axes —
 * Domain x Governance x Latency (5 x 5 x 4 = 100 combinations) — each
 * mapped to the subset of the research/ catalog most load-bearing for
 * that axis value. generate-seeds.ts and select-seed.ts both import this
 * file; nothing here talks to a filesystem or network.
 */

export type Axis = "domain" | "governance" | "latency";

export interface AxisValue {
  id: string;
  name: string;
  description: string;
  /** A few concrete apps/games/products this axis value evokes — including things that don't exist yet. */
  examples: string[];
  /** Guide numbers (as they appear in research/README.md's catalog) most relevant to this axis value. */
  guides: number[];
}

export const DOMAINS: AxisValue[] = [
  {
    id: "consumer-app",
    name: "Consumer App",
    description:
      "Everyday utility and productivity software — the agent reads/writes structured personal data and calls a modest set of well-known tools.",
    examples: ["habit tracker", "personal finance dashboard", "note-taking app", "meal planner", "travel itinerary builder"],
    guides: [9, 12, 37, 49, 68, 8, 10, 60, 71],
  },
  {
    id: "realtime-game",
    name: "Real-Time Game",
    description:
      "Multiplayer or single-player interactive entertainment where state must sync at sub-frame latency and the agent may be a player, narrator, or opponent.",
    examples: ["co-op dungeon crawler with an AI dungeon master", "1v1 card game with a bluffing AI opponent", "shared-world sandbox", "rhythm game with generative levels"],
    guides: [11, 27, 57, 61, 63, 64, 65, 83],
  },
  {
    id: "creative-media",
    name: "Creative / Generative Media",
    description:
      "Tools that generate or remix art, music, video, or 3D scenes — the agent's output *is* the product, not just a means to an action.",
    examples: ["AI album cover generator", "procedural music composer", "text-to-3D scene builder", "style-transfer video editor"],
    guides: [30, 54, 61, 63, 35, 5],
  },
  {
    id: "embodied-iot",
    name: "Embodied / Physical-IoT",
    description:
      "Software with a physical or spatial footprint — hardware pairing, proximity, ambient presence, or AR overlays on the real world.",
    examples: ["tap-to-pay wearable", "AR room-scanning assistant", "smart-home routine composer", "proximity-based group check-in"],
    guides: [16, 21, 27, 64, 42, 44],
  },
  {
    id: "emergent-agent",
    name: "Emergent Multi-Agent / Speculative",
    description:
      "Categories that don't fully exist yet — societies of cooperating or competing agents, agent-run micro-businesses, self-modifying software written by the thing it runs.",
    examples: ["agent-run marketplace stall that negotiates its own prices", "swarm of agents co-authoring a living document", "self-patching game NPC economy", "AI guild that hires other AIs for sub-tasks"],
    guides: [28, 76, 77, 78, 69, 66, 67, 81, 38],
  },
];

export const GOVERNANCE: AxisValue[] = [
  {
    id: "full-autonomy",
    name: "Full Autonomy",
    description: "The agent acts unsupervised within its declared authority band — no per-action human gate.",
    examples: ["background inbox triage", "auto-adjusting thermostat schedule", "self-balancing game difficulty"],
    guides: [37, 38, 22, 70, 78, 17],
  },
  {
    id: "passkey-gated",
    name: "Passkey-Gated",
    description: "Every state-changing action requires a fresh biometric/WebAuthn proof — the passkey floor.",
    examples: ["wallet transfer confirmation", "guardian recovery approval", "high-value in-game trade"],
    guides: [20, 14, 29, 45, 49],
  },
  {
    id: "budgeted-delegation",
    name: "Budgeted Delegation",
    description: "The agent has a spend/action budget and acts freely inside it, escalating only when it would exceed the cap.",
    examples: ["daily grocery auto-reorder under a $50 cap", "in-game currency auto-spend on consumables", "ad-spend autopilot with a monthly ceiling"],
    guides: [17, 18, 70, 96],
  },
  {
    id: "quorum-consensus",
    name: "Quorum / Consensus",
    description: "Multiple parties — agents and/or humans — must agree before an action lands.",
    examples: ["family shared-vault withdrawal", "guild treasury spend", "multi-agent negotiation settlement"],
    guides: [29, 32, 76, 49],
  },
  {
    id: "human-approval-queue",
    name: "Human Approval Queue",
    description: "The agent proposes a batch of actions; a human reviews and approves before anything executes.",
    examples: ["draft-and-review social posting", "proposed code merge queue", "weekly budget reallocation review"],
    guides: [49, 48, 44, 39],
  },
];

export const LATENCY: AxisValue[] = [
  {
    id: "realtime",
    name: "Real-Time (<100ms)",
    description: "Synchronous interaction loop where the agent must respond within a frame or a breath — games, AR, voice.",
    examples: ["live game opponent", "voice-interrupt assistant", "AR overlay that tracks head movement"],
    guides: [11, 57, 65, 83, 56],
  },
  {
    id: "interactive",
    name: "Interactive (sub-second)",
    description: "Conversational, turn-based UI latency — the user waits for one reply, not a stream of frames.",
    examples: ["chat assistant", "form-filling copilot", "code review comment bot"],
    guides: [12, 9, 50, 68, 40],
  },
  {
    id: "async-background",
    name: "Async / Background (seconds–minutes)",
    description: "Work that runs off the interaction thread and reports back — jobs, pipelines, batch tool chains.",
    examples: ["nightly portfolio rebalance job", "batch image upscaling queue", "multi-step research report generator"],
    guides: [8, 26, 55, 58, 71],
  },
  {
    id: "scheduled-deferred",
    name: "Scheduled / Deferred (minutes–days)",
    description: "Clock-driven or long-horizon work — cron-like recurrence, slow calibration, periodic audits.",
    examples: ["weekly digest email", "quarterly goal check-in", "self-tuning threshold recalibration"],
    guides: [8, 71, 98, 101, 44],
  },
];

export interface Seed {
  id: string;
  domain: AxisValue;
  governance: AxisValue;
  latency: AxisValue;
  /** Deduped, frequency-ranked guide numbers across all three axes. */
  recommendedGuides: number[];
  /** One-line pitch combining all three axes. */
  pitch: string;
}

function rankGuides(...lists: number[][]): number[] {
  const freq = new Map<number, number>();
  for (const list of lists) {
    for (const g of list) freq.set(g, (freq.get(g) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([g]) => g);
}

export function buildSeed(domain: AxisValue, governance: AxisValue, latency: AxisValue): Seed {
  return {
    id: `${domain.id}--${governance.id}--${latency.id}`,
    domain,
    governance,
    latency,
    recommendedGuides: rankGuides(domain.guides, governance.guides, latency.guides),
    pitch: `A ${domain.name.toLowerCase()} governed by ${governance.name.toLowerCase()}, operating at ${latency.name.toLowerCase()} latency.`,
  };
}

export function allSeeds(): Seed[] {
  const seeds: Seed[] = [];
  for (const d of DOMAINS) {
    for (const g of GOVERNANCE) {
      for (const l of LATENCY) {
        seeds.push(buildSeed(d, g, l));
      }
    }
  }
  return seeds;
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes("--demo")) {
  const seeds = allSeeds();
  console.log(`Generated ${seeds.length} seeds (expected ${DOMAINS.length * GOVERNANCE.length * LATENCY.length}).`);
  console.log(JSON.stringify(seeds[0], null, 2));
}
