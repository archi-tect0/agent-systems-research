# The 100-Seed Combinatoric Archetype Matrix

*Part of the [research/ index](../README.md).*

A generator that turns "I want to build X" into a starting reading list from the research/ catalog, by placing X on three independent axes and reading off the guides most load-bearing for that combination.

## The three axes

| Axis | 5 or 4 values |
|------|--------|
| **Domain** — what kind of product | `consumer-app`, `realtime-game`, `creative-media`, `embodied-iot`, `emergent-agent` |
| **Governance** — how much autonomy the agent gets | `full-autonomy`, `passkey-gated`, `budgeted-delegation`, `quorum-consensus`, `human-approval-queue` |
| **Latency** — how fast it has to respond | `realtime`, `interactive`, `async-background`, `scheduled-deferred` |

5 domains × 5 governance models × 4 latency tiers = **100 seeds**. Each seed is a `{domain, governance, latency}` triple with a ranked, deduplicated list of guide numbers pulled from all three axes — the guides that show up in more than one axis rank first.

`emergent-agent` is deliberately the domain for products that don't fully exist yet — agent-run marketplaces, self-patching NPC economies, societies of cooperating or competing agents — so the matrix doesn't just cover known app/game categories.

## Files

- `matrix.ts` — source of truth: the 5+5+4 axis definitions (name, description, examples, guide numbers) and the `buildSeed`/`allSeeds` functions. Nothing here touches the filesystem.
- `generate-seeds.ts` — writes all 100 combinations to `generated/*.seed.json`. Re-run after editing `matrix.ts`.
- `select-seed.ts` — CLI to pick the closest seed for an idea, either by exact axis ids or by free-text keyword match against each axis's name/description/examples.
- `generated/` — the 100 generated `<domain>--<governance>--<latency>.seed.json` files (regenerate, don't hand-edit).

## Usage

```bash
# Regenerate all 100 seed.json files after changing matrix.ts:
node generate-seeds.ts

# Exact axis selection:
node select-seed.ts --domain realtime-game --governance full-autonomy --latency realtime

# Free-text match — scores each axis independently against the description:
node select-seed.ts --describe "an agent that negotiates prices at a marketplace stall"
```

Each seed prints a pitch, the three axis descriptions, a ranked reading order (guide numbers into the main catalog), and the full seed JSON.

## Limitations and extensions

- The keyword matcher in `select-seed.ts` is intentionally simple (token overlap, no embeddings) so it stays dependency-free and auditable — for an ambiguous description, pass `--domain/--governance/--latency` explicitly instead of trusting the guess.
- Guide-to-axis mappings in `matrix.ts` are a curated starting point, not exhaustive; a seed's reading list is a *floor*, not a ceiling — pull in any other catalog guide the specific idea needs.
- Extending an axis (e.g. adding a 6th domain) means updating `matrix.ts` and re-running `generate-seeds.ts`; the other two axes are unaffected since the three lists are fully independent.
