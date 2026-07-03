/**
 * Generates all 100 seed.json files from matrix.ts into ./generated/.
 *
 * Usage:
 *   node generate-seeds.ts
 *   node generate-seeds.ts --demo   (generates + prints a summary, same effect)
 *
 * Node 24+ runs this directly (native TS stripping). No external deps.
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { allSeeds, DOMAINS, GOVERNANCE, LATENCY } from "./matrix.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "generated");

function main() {
  if (existsSync(OUT_DIR)) {
    for (const f of readdirSync(OUT_DIR)) {
      if (f.endsWith(".seed.json")) rmSync(join(OUT_DIR, f));
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const seeds = allSeeds();
  for (const seed of seeds) {
    writeFileSync(join(OUT_DIR, `${seed.id}.seed.json`), JSON.stringify(seed, null, 2) + "\n");
  }

  const expected = DOMAINS.length * GOVERNANCE.length * LATENCY.length;
  console.log(`Wrote ${seeds.length} seed.json files to ${OUT_DIR} (expected ${expected}).`);
  if (seeds.length !== expected) {
    console.error("Mismatch — matrix.ts axes changed without updating this generator's expectations.");
    process.exitCode = 1;
  }
}

main();
