/**
 * Procedural Scene Macros for Token-Efficient 3D
 *
 * A macro is a single short command (e.g. {cmd:"macro", name:"PYRAMID",
 * params:{...}}) that expands SERVER-SIDE into a variable-length array of
 * concrete scene operations before the payload is sent to a renderer.
 *
 * The point is output-token economy: a language model that authors a 3D scene
 * emits ~8 tokens for a PYRAMID macro instead of ~60 tokens for the seven
 * boxes it expands into. The expansion uses a deterministic seeded PRNG keyed
 * by the macro parameters, so every client that receives the same macro call
 * renders a bit-identical scene — there is no random drift between machines.
 *
 * Dependencies: none. Runs on Node.js built-ins only (a small LCG PRNG is
 * implemented inline; no external math or 3D library is required).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type SceneCmd = Record<string, unknown>;
export type MacroParams = Record<string, unknown>;
export type MacroCall = { cmd: "macro"; name: string; params?: MacroParams };
type MacroFn = (params: MacroParams, prefix: string) => SceneCmd[];

// ── Deterministic PRNG (linear congruential generator) ────────────────────────
// Returns a closure that yields floats in [0, 1). The same integer seed always
// produces the same sequence on every CPU and JS engine — this is what makes
// macro expansion reproducible across clients.

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    // Numerical Recipes LCG constants; Math.imul keeps the multiply 32-bit.
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Fold an arbitrary parameter set into a stable 32-bit seed so that the same
// params always expand identically, but different params diverge.
function seedFromParams(name: string, params: MacroParams): number {
  let h = 2166136261 >>> 0; // FNV-1a offset basis
  const material = name + "|" + JSON.stringify(params, Object.keys(params).sort());
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ── Parameter coercion helpers (defensive: a model may emit junk) ─────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function num(v: unknown, def: number, lo = -1e6, hi = 1e6): number {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : def;
}
function int(v: unknown, def: number, lo: number, hi: number): number {
  return clamp(Math.round(num(v, def, lo, hi)), lo, hi);
}
function str(v: unknown, def: string): string {
  return typeof v === "string" && v ? v : def;
}

function box(
  id: string, color: string,
  x: number, y: number, z: number,
  w: number, h: number, d: number,
  emission = 0,
): SceneCmd {
  return {
    cmd: "add_object",
    id,
    props: { type: "box", color, emission, position: { x, y, z }, width: w, height: h, depth: d },
  };
}
function sphere(
  id: string, color: string,
  x: number, y: number, z: number,
  radius: number, emission = 0,
): SceneCmd {
  return {
    cmd: "add_object",
    id,
    props: { type: "sphere", color, emission, position: { x, y, z }, radius },
  };
}

// ── Macro: PYRAMID ────────────────────────────────────────────────────────────
// Stepped pyramid: N tiers of diminishing boxes + a glowing capstone.
function pyramid(p: MacroParams, prefix: string): SceneCmd[] {
  const layers = int(p["layers"], 7, 2, 16);
  const cx = num(p["x"], 0);
  const cz = num(p["z"], 0);
  const color = str(p["color"], "#C4A35A");
  const scale = num(p["scale"], 1, 0.1, 20);
  const out: SceneCmd[] = [];
  const tierH = 2.2 * scale;
  for (let i = 0; i < layers; i++) {
    const tier = layers - i;
    const side = tier * 4 * scale;
    out.push(box(`${prefix}py${i}`, color, cx, i * tierH + tierH / 2, cz, side, tierH, side, 0.05));
  }
  out.push(sphere(`${prefix}cap`, "#ffd080", cx, layers * tierH + 0.5 * scale, cz, 0.5 * scale, 5.0));
  return out;
}

// ── Macro: SPIRAL ─────────────────────────────────────────────────────────────
// Logarithmic spiral arms of glowing spheres. Uses the PRNG for per-star jitter
// so the spiral looks organic but stays reproducible.
function spiral(p: MacroParams, prefix: string): SceneCmd[] {
  const arms = int(p["arms"], 3, 1, 8);
  const perArm = int(p["starsPerArm"], 10, 3, 60);
  const maxR = num(p["r"], 20, 3, 500);
  const cy = num(p["y"], 0);
  const cx = num(p["x"], 0);
  const cz = num(p["z"], 0);
  const color = str(p["color"], "#FFD7A8");
  const emission = num(p["emission"], 1.5, 0, 8);
  const rng = makeRng(seedFromParams("SPIRAL", p));
  const out: SceneCmd[] = [];
  for (let a = 0; a < arms; a++) {
    const armOffset = (a / arms) * Math.PI * 2;
    for (let s = 0; s < perArm; s++) {
      const t = (s + 1) / perArm;
      const angle = armOffset + t * Math.PI * 3;
      const radius = t * maxR;
      const jitter = (rng() - 0.5) * maxR * 0.14;
      const px = cx + (radius + jitter) * Math.cos(angle);
      const py = cy + (rng() - 0.5) * maxR * 0.04;
      const pz = cz + (radius + jitter) * Math.sin(angle);
      const size = maxR * 0.055 * (0.3 + rng() * 0.5) * (1 - t * 0.35);
      out.push(sphere(`${prefix}sp${a}_${s}`, color, px, py, pz, size, emission));
    }
  }
  return out;
}

// ── Macro: SKYLINE ────────────────────────────────────────────────────────────
// Grid of procedurally-varied buildings — instant dense cityscape.
function skyline(p: MacroParams, prefix: string): SceneCmd[] {
  const rows = int(p["rows"], 3, 1, 10);
  const cols = int(p["cols"], 3, 1, 10);
  const spacing = num(p["spacing"], 12, 3, 200);
  const cx = num(p["x"], 0);
  const cz = num(p["z"], 0);
  const color = str(p["color"], "#2A3A5A");
  const emission = num(p["emission"], 0.25, 0, 5);
  const rng = makeRng(seedFromParams("SKYLINE", p));
  const out: SceneCmd[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const floors = 5 + Math.floor(rng() * 22);
      const w = 5.5 + rng() * 5;
      const d = 5.5 + rng() * 5;
      const px = cx + (c - (cols - 1) / 2) * spacing;
      const pz = cz + (r - (rows - 1) / 2) * spacing;
      const h = floors * 3;
      out.push(box(`${prefix}sk${r}_${c}`, color, px, h / 2, pz, w, h, d, emission));
    }
  }
  return out;
}

// ── Registry ──────────────────────────────────────────────────────────────────

const REGISTRY: Record<string, MacroFn> = {
  PYRAMID: pyramid,
  SPIRAL: spiral,
  SKYLINE: skyline,
};

export const MACRO_NAMES = Object.keys(REGISTRY);

/**
 * Expand every {cmd:"macro", name, params} command in the array into concrete
 * scene operations. Non-macro commands pass through unchanged. Unknown macro
 * names are silently dropped so a single bad call never crashes the scene.
 */
export function expandMacros(cmds: SceneCmd[]): SceneCmd[] {
  const out: SceneCmd[] = [];
  let macroIndex = 0;
  for (const cmd of cmds) {
    if (cmd["cmd"] === "macro") {
      const name = String(cmd["name"] ?? "").toUpperCase();
      const params = (cmd["params"] ?? {}) as MacroParams;
      const fn = REGISTRY[name];
      if (fn) {
        try {
          out.push(...fn(params, `m${macroIndex++}_`));
        } catch {
          /* skip malformed macro — never abort the whole batch */
        }
      }
    } else {
      out.push(cmd);
    }
  }
  return out;
}

/**
 * Convenience: expand a single macro call directly to its op array.
 */
export function expandOne(call: MacroCall): SceneCmd[] {
  return expandMacros([call as SceneCmd]);
}

// ── Demo ──────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const scene: SceneCmd[] = [
    { cmd: "macro", name: "PYRAMID", params: { layers: 7 } },
    { cmd: "macro", name: "SPIRAL", params: { arms: 3, starsPerArm: 12, r: 25 } },
    { cmd: "macro", name: "SKYLINE", params: { rows: 4, cols: 4, spacing: 14 } },
  ];

  const expanded = expandMacros(scene);
  console.log("Macro calls in:", scene.length);
  for (const call of scene) {
    const ops = expandOne(call as MacroCall);
    console.log(`  ${String((call as MacroCall).name).padEnd(8)} -> ${ops.length} ops`);
  }
  console.log("Total concrete ops out:", expanded.length);
  console.log("Approx token ratio: ~", Math.round((expanded.length * 9) / (scene.length * 8)), "x savings");

  // Determinism: same seed (same params) => byte-identical expansion.
  const a = JSON.stringify(expandOne({ cmd: "macro", name: "SKYLINE", params: { rows: 4, cols: 4, spacing: 14 } }));
  const b = JSON.stringify(expandOne({ cmd: "macro", name: "SKYLINE", params: { rows: 4, cols: 4, spacing: 14 } }));
  console.log("Deterministic (same params -> same scene):", a === b);

  // Different params => different scene.
  const c = JSON.stringify(expandOne({ cmd: "macro", name: "SKYLINE", params: { rows: 4, cols: 4, spacing: 15 } }));
  console.log("Sensitive (different params -> different scene):", a !== c);

  console.log("\nFirst 2 ops of PYRAMID:");
  console.log(JSON.stringify(expandOne({ cmd: "macro", name: "PYRAMID", params: { layers: 3 } }).slice(0, 2), null, 2));
}
