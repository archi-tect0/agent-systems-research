/**
 * select-seed.ts — pick the closest of the 100 seeds for an app/game idea.
 *
 * Two modes:
 *
 *   1. Exact axis selection:
 *      node select-seed.ts --domain realtime-game --governance full-autonomy --latency realtime
 *
 *   2. Free-text description (keyword-scored fuzzy match against each axis's
 *      name/description/examples):
 *      node select-seed.ts --describe "a multiplayer card game where an AI opponent bluffs"
 *
 * Prints the matching seed.json plus a recommended reading order pulled from
 * research/README.md's catalog numbers. Node 24+ runs this directly; no deps.
 */
import { DOMAINS, GOVERNANCE, LATENCY, buildSeed, type AxisValue } from "./matrix.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

function scoreAxisValue(v: AxisValue, text: string): number {
  const hay = text.toLowerCase();
  let score = 0;
  const nameTokens = v.name.toLowerCase().split(/\W+/).filter(Boolean);
  const idTokens = v.id.split("-");
  for (const t of [...nameTokens, ...idTokens]) {
    if (t.length > 2 && hay.includes(t)) score += 3;
  }
  const descTokens = v.description.toLowerCase().split(/\W+/).filter((t) => t.length > 4);
  for (const t of descTokens) {
    if (hay.includes(t)) score += 1;
  }
  for (const ex of v.examples) {
    const exTokens = ex.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
    for (const t of exTokens) {
      if (hay.includes(t)) score += 2;
    }
  }
  return score;
}

function bestMatch(values: AxisValue[], text: string): AxisValue {
  let best = values[0];
  let bestScore = -1;
  for (const v of values) {
    const s = scoreAxisValue(v, text);
    if (s > bestScore) {
      bestScore = s;
      best = v;
    }
  }
  return best;
}

function findAxisValue(values: AxisValue[], id: string, axisName: string): AxisValue {
  const found = values.find((v) => v.id === id);
  if (!found) {
    const valid = values.map((v) => v.id).join(", ");
    throw new Error(`Unknown ${axisName} "${id}". Valid values: ${valid}`);
  }
  return found;
}

function guideLine(n: number): string {
  return `  - ${String(n).padStart(3, "0")}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let domain: AxisValue, governance: AxisValue, latency: AxisValue;

  if (args.describe) {
    domain = bestMatch(DOMAINS, args.describe);
    governance = bestMatch(GOVERNANCE, args.describe);
    latency = bestMatch(LATENCY, args.describe);
    console.log(`Matched from description: "${args.describe}"`);
  } else if (args.domain && args.governance && args.latency) {
    domain = findAxisValue(DOMAINS, args.domain, "domain");
    governance = findAxisValue(GOVERNANCE, args.governance, "governance");
    latency = findAxisValue(LATENCY, args.latency, "latency");
  } else {
    console.log("Usage:");
    console.log('  node select-seed.ts --describe "a co-op dungeon crawler with an AI dungeon master"');
    console.log("  node select-seed.ts --domain <id> --governance <id> --latency <id>");
    console.log("");
    console.log("Domains:    " + DOMAINS.map((d) => d.id).join(", "));
    console.log("Governance: " + GOVERNANCE.map((g) => g.id).join(", "));
    console.log("Latency:    " + LATENCY.map((l) => l.id).join(", "));
    process.exit(args.describe === undefined && !args.domain ? 1 : 0);
  }

  const seed = buildSeed(domain, governance, latency);

  console.log("");
  console.log(`Seed: ${seed.id}`);
  console.log(`  ${seed.pitch}`);
  console.log("");
  console.log(`Domain      — ${domain.name}: ${domain.description}`);
  console.log(`Governance  — ${governance.name}: ${governance.description}`);
  console.log(`Latency     — ${latency.name}: ${latency.description}`);
  console.log("");
  console.log("Recommended reading order (research/ guide numbers, most load-bearing first):");
  console.log(seed.recommendedGuides.map(guideLine).join("\n"));
  console.log("");
  console.log(JSON.stringify(seed, null, 2));
}

main();
