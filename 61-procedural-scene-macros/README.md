# Procedural Scene Macros for Token-Efficient 3D


*Part of the [research/ index](../README.md) — see [Start Here](../README.md#start-here) for the recommended reading order.*

## Problem

When a language model authors a 3D scene by emitting concrete commands — one
per box, sphere, or light — the output token count explodes. A modest stepped
pyramid is seven boxes plus a capstone; written out object-by-object that is
roughly sixty output tokens. A spiral galaxy of thirty stars is several hundred.
Output tokens are the expensive, latency-bound half of an LLM turn: the model
generates them serially, the user waits for them, and you pay per token. A scene
of any visual richness quickly becomes both slow and costly to describe directly.

The structure of these scenes is also highly repetitive. A pyramid is always
"N diminishing tiers stacked on a shared axis." A cityscape is "a grid of
buildings with varied heights." The model is spending its scarce output budget
re-deriving boilerplate geometry that a few parameters fully determine. That is
work better done by a deterministic expander on the server.

The catch is consistency. If the server expands a macro using `Math.random()`,
two clients that receive the same macro call render *different* scenes, and a
client that reconnects and re-expands gets a third. For a shared or replayable
render surface that is unacceptable. The expansion must be a pure function of
the macro name and its parameters.

## Design decisions

**Why expand server-side instead of teaching the model the geometry?**
The model is good at *intent* ("put a pyramid here, seven tiers, weathered stone") and
bad at cheaply emitting the hundred coordinates that intent implies. Splitting
the labour — model emits the parametric call, server emits the geometry — plays
to both strengths. The model's output shrinks by 5–25×, and the geometry logic
lives in normal, testable, version-controlled code instead of in prompt tokens.

**Why a seeded PRNG instead of `Math.random()`?**
Macros need controlled variation (buildings of different heights, stars with
organic jitter) but every client must compute the *same* variation. A linear
congruential generator seeded deterministically from the macro parameters gives
both: the output looks irregular, yet identical inputs always produce an
identical sequence on every CPU and JS engine. There is no shared random state
and no drift between machines or between an initial render and a later replay.

**Why derive the seed from the parameters with FNV-1a?**
The seed must change when the scene should change and stay fixed when it
shouldn't. Hashing the macro name plus a canonical (key-sorted) JSON encoding of
its parameters with FNV-1a means `{rows:4,cols:4}` and `{cols:4,rows:4}` seed
identically, while `spacing:14` and `spacing:15` diverge. Integer-only hashing
keeps the seed platform-invariant.

**Why coerce and clamp every parameter?**
The macro caller is a language model, which will eventually emit a string where
a number belongs, a negative tier count, or a thousand-storey building. Each
parameter passes through a small `num`/`int`/`str` coercion with explicit
defaults and bounds, so a malformed call degrades to a sensible default rather
than producing a broken or denial-of-service-sized scene.

**Why silently drop unknown macros?**
A scene batch may mix macros with literal object commands. If the model invents
a macro name that isn't registered, dropping that one command keeps the rest of
the scene intact — far better than aborting the whole render over one typo.

## Algorithm

```
expandMacros(cmds):
  out = []
  macroIndex = 0
  for cmd in cmds:
    if cmd.cmd != "macro":
      out.push(cmd)                       # literal op passes through
      continue
    fn = REGISTRY[upper(cmd.name)]
    if fn is null: continue               # unknown macro -> drop
    try: out.push(...fn(cmd.params, "m{macroIndex++}_"))
    catch: continue                       # malformed -> skip, never abort
  return out

seedFromParams(name, params):
  material = name + "|" + JSON(params sorted by key)
  h = FNV-1a-32(material)
  return h

makeRng(seed):                            # LCG, floats in [0,1)
  s = seed
  return () => { s = (1664525*s + 1013904223) mod 2^32; return s / 2^32 }

# A macro fn is a pure (params, prefix) -> SceneCmd[]:
pyramid(params, prefix):
  layers, x, z, color, scale  = coerced params
  for i in 0..layers-1:
    side = (layers - i) * 4 * scale
    emit box at (x, i*tierH + tierH/2, z) sized side x tierH x side
  emit glowing capstone sphere on top
```

`Math.imul` is used for both the FNV multiply and the LCG multiply so the
arithmetic stays exactly 32-bit, which is what guarantees the same sequence on
every engine.

## Reference implementation

See [`scene-macros.ts`](./scene-macros.ts) in this directory. It runs on Node.js
built-ins only — the PRNG and the parameter-seed hash are implemented inline, so
no external math or 3D library is required.

## Usage

```typescript
import { expandMacros, expandOne, MACRO_NAMES } from "./scene-macros.js";

// A model emits a tiny macro batch:
const sceneBatch = [
  { cmd: "macro", name: "PYRAMID", params: { layers: 7 } },
  { cmd: "macro", name: "SKYLINE", params: { rows: 4, cols: 4, spacing: 14 } },
  { cmd: "add_object", id: "ground", props: { type: "plane" } }, // literal passes through
];

const concreteOps = expandMacros(sceneBatch); // -> ~24 add_object commands

// Expand a single call (e.g. to inspect its op count):
const stars = expandOne({ cmd: "macro", name: "SPIRAL", params: { arms: 3, starsPerArm: 12 } });

console.log("registered macros:", MACRO_NAMES); // ["PYRAMID","SPIRAL","SKYLINE"]
```

## Limitations and extensions

- **The macro library is the ceiling.** A scene can only be as expressive as the
  registered macros. Real deployments carry a dozen or more (rings, clusters,
  arches, obelisks, reefs); add a `MacroFn` and one registry entry per shape.
- **Floating-point coordinates are emitted as-is.** The PRNG is integer-exact,
  but the trig and scaling that turn its output into positions use IEEE-754
  doubles, which are identical across conformant engines but not across
  arbitrary fixed-point renderers. If you need bit-exact geometry on exotic
  targets, quantise the emitted coordinates to a fixed grid.
- **No nesting.** Macros expand to literal ops, not to other macros. Recursive
  expansion (a `DISTRICT` macro that emits several `SKYLINE` calls) is a natural
  extension — bound the recursion depth to keep expansion cost predictable.
- **Send the legend to the model.** The model can only call macros it knows
  about. Inject a compact legend (name, parameters, defaults) into the system
  context so it authors valid calls; keep that legend in sync with the registry.
