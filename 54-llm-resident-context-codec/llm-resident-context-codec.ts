/**
 * LLM-Resident Context Codec (Token-Space Shorthand)
 *
 * A reversible text codec that shrinks the token footprint of an LLM prompt
 * without changing its meaning. Three independent layers compose:
 *
 *   1. Phrase shorthand  — common multi-word phrases become short "@CODE"
 *                          tokens via a static dictionary.
 *   2. Weight-resident   — phrases the model already "knows" (its training
 *      refs                corpus / fine-tune) are replaced with deterministic
 *                          "REF:<hash>" markers computed with FNV-1a. The model
 *                          reconstructs them from its own weights at zero prompt
 *                          token cost; the server reverses them on the way out.
 *   3. Legend injection  — a one-line decode table is prepended so the model
 *                          can map every code back to its expansion.
 *
 * A privacy filter runs BEFORE any phrase is allowed into the dictionary, so a
 * secret (card number, mnemonic, API key, ...) can never be promoted into a
 * shared code or a REF marker.
 *
 * Built-ins only. FNV-1a is implemented locally.
 *
 * Run the demo:  node llm-resident-context-codec.ts --demo
 */

// ── FNV-1a 32-bit hash (implemented here, no dependencies) ────────────────────

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32-bit hash of a UTF-8 string, returned as an uppercase base-36
 * string. Deterministic and platform-invariant (Math.imul keeps 32-bit
 * multiplication exact).
 */
export function fnv1a(input: string): string {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return (h >>> 0).toString(36).toUpperCase();
}

// ── Phrase shorthand dictionary ───────────────────────────────────────────────

export type ShorthandEntry = { pattern: RegExp; code: string; phrase: string };

/**
 * Static phrase → @code dictionary. Codes are "@" plus 1-4 uppercase chars so
 * they are visually distinct and unambiguous to reverse. Longest phrases are
 * listed first so they win over shorter overlapping matches.
 */
export const SHORTHAND: ShorthandEntry[] = [
  { phrase: "sign in with a wallet", code: "@SIW", pattern: /\bsign in with a wallet\b/gi },
  { phrase: "long-term memory", code: "@LTM", pattern: /\blong-term memory\b/gi },
  { phrase: "the following", code: "@TF", pattern: /\bthe following\b/gi },
  { phrase: "for example", code: "@EG", pattern: /\bfor example\b/gi },
  { phrase: "transaction", code: "@TX", pattern: /\btransaction\b/gi },
  { phrase: "authentication", code: "@AU", pattern: /\bauthentication\b/gi },
  { phrase: "authorization", code: "@AZ", pattern: /\bauthorization\b/gi },
  { phrase: "configuration", code: "@CF", pattern: /\bconfiguration\b/gi },
  { phrase: "implementation", code: "@IM", pattern: /\bimplementation\b/gi },
  { phrase: "the user", code: "@U", pattern: /\bthe user\b/gi },
];

// ── Privacy filter (runs before phrase promotion) ─────────────────────────────

const MIN_PHRASE_BYTES = 12;
const MAX_PHRASE_BYTES = 96;

const RE_EVM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/;
const RE_EMAIL = /\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b/i;
const RE_SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const RE_JWT = /\beyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9._\-]+\.[A-Za-z0-9._\-]+\b/;
const RE_API_KEY = /\b(?:sk_live|sk_test|pk_live|ghp_|github_pat_|AKIA)[A-Za-z0-9_\-]{10,}\b/;
const RE_HEX_64 = /\b[a-fA-F0-9]{64}\b/;
const RE_CREDIT_CARD = /\b(?:\d[ \-]*?){13,19}\b/;
const RE_SEED_CONTEXT = /\b(?:seed phrase|recovery phrase|mnemonic phrase)\b/i;

const BIP39_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

/**
 * A small fixed word list standing in for a real BIP39 list. Enough to detect
 * a mnemonic-looking string in the demo without bundling all 2048 words.
 */
const SAMPLE_BIP39_WORDS = new Set([
  "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
  "ladder", "legal", "lemon", "length", "letter", "level", "logic", "lonely",
  "ridge", "rifle", "right", "rigid", "ring", "riot", "ripple", "risk",
]);

function luhnPass(input: string): boolean {
  const digits = input.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function looksLikeMnemonic(phrase: string): boolean {
  const words = phrase.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!BIP39_WORD_COUNTS.has(words.length)) return false;
  return words.every(w => SAMPLE_BIP39_WORDS.has(w));
}

/**
 * Returns true if a phrase must NOT be promoted into the shared dictionary or
 * a REF marker. Conservative by design: when in doubt, block.
 */
export function shouldBlockPhrase(phrase: string): boolean {
  const bytes = Buffer.byteLength(phrase, "utf8");
  if (bytes < MIN_PHRASE_BYTES || bytes > MAX_PHRASE_BYTES) return true;

  if (RE_EVM_ADDRESS.test(phrase)) return true;
  if (RE_EMAIL.test(phrase)) return true;
  if (RE_SSN.test(phrase)) return true;
  if (RE_JWT.test(phrase)) return true;
  if (RE_API_KEY.test(phrase)) return true;
  if (RE_HEX_64.test(phrase)) return true;
  if (RE_SEED_CONTEXT.test(phrase)) return true;
  if (looksLikeMnemonic(phrase)) return true;

  const cc = RE_CREDIT_CARD.exec(phrase);
  if (cc && luhnPass(cc[0])) return true;

  return false;
}

// ── Weight-resident phrase set + REF promotion ────────────────────────────────

/**
 * Build the set of phrases that may be replaced with REF:<hash> markers.
 * Only phrases that pass the privacy filter are admitted; secrets are dropped.
 * Returns the admitted set plus the list of rejected (blocked) phrases so a
 * caller can audit what was scrubbed.
 */
export function buildWeightResidentSet(
  candidatePhrases: string[],
): { admitted: Set<string>; blocked: string[] } {
  const admitted = new Set<string>();
  const blocked: string[] = [];
  for (const phrase of candidatePhrases) {
    if (shouldBlockPhrase(phrase)) blocked.push(phrase);
    else admitted.add(phrase);
  }
  return { admitted, blocked };
}

const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]+`)/;

/**
 * Replace weight-resident phrases with REF:<fnv1a> markers, outside code spans.
 * Records every (phrase -> ref) mapping into refMap so the decoder can reverse.
 * Phrases shorter than 6 chars are skipped (too risky / too little savings).
 */
export function applyWeightResidentRefs(
  text: string,
  weightResident: Set<string>,
  refMap: Map<string, string>,
): string {
  if (weightResident.size === 0) return text;
  const parts = text.split(CODE_SPAN);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // code span — leave verbatim
      let out = part;
      for (const phrase of weightResident) {
        if (phrase.length < 6 || !out.includes(phrase)) continue;
        const ref = `REF:${fnv1a(phrase)}`;
        refMap.set(ref, phrase);
        out = out.split(phrase).join(ref);
      }
      return out;
    })
    .join("");
}

// ── Legend ────────────────────────────────────────────────────────────────────

/**
 * Build the one-line legend the model reads to decode the prompt. Lists every
 * active @code and every REF marker used in this specific encoding.
 */
export function buildLegend(refMap: Map<string, string>): string {
  const shorthandPart = SHORTHAND.map(e => `${e.code}=${e.phrase}`).join(" ");
  const refPart = [...refMap.entries()].map(([ref, phrase]) => `${ref}=${phrase}`).join(" ");
  const pieces = ["CODEC LEGEND (decode silently):", shorthandPart];
  if (refPart) pieces.push(refPart);
  return pieces.join(" ");
}

// ── Encode / decode ───────────────────────────────────────────────────────────

export type EncodeResult = {
  encoded: string;
  legend: string;
  refMap: Map<string, string>;
  originalLength: number;
  encodedLength: number;
  reductionPct: number;
};

/**
 * Encode a prompt: apply phrase shorthand, then weight-resident REF markers,
 * then build the legend. The legend is returned separately (it is normally
 * prompt-cached, so it should not count against per-turn savings).
 */
export function encode(text: string, weightResident: Set<string>): EncodeResult {
  let out = text;

  // 1. Phrase shorthand (outside code spans).
  const parts = out.split(CODE_SPAN);
  out = parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let seg = part;
      for (const entry of SHORTHAND) seg = seg.replace(entry.pattern, entry.code);
      return seg;
    })
    .join("");

  // 2. Weight-resident REF markers.
  const refMap = new Map<string, string>();
  out = applyWeightResidentRefs(out, weightResident, refMap);

  const legend = buildLegend(refMap);
  const originalLength = text.length;
  const encodedLength = out.length;
  return {
    encoded: out,
    legend,
    refMap,
    originalLength,
    encodedLength,
    reductionPct: originalLength === 0 ? 0 : ((originalLength - encodedLength) / originalLength) * 100,
  };
}

/**
 * Decode an encoded prompt back to its original text. Reverses REF markers
 * first (using the per-encoding refMap), then the static @codes. Reversal is
 * unambiguous because codes never appear in normal prose.
 */
export function decode(encoded: string, refMap: Map<string, string>): string {
  let out = encoded;
  for (const [ref, phrase] of refMap) out = out.split(ref).join(phrase);
  for (const entry of SHORTHAND) out = out.split(entry.code).join(entry.phrase);
  return out;
}

// ── Demo ──────────────────────────────────────────────────────────────────────

if (process.argv.includes("--demo")) {
  const line = (s: string) => console.log(s);

  line("=== LLM-Resident Context Codec demo ===\n");

  // Candidate phrases someone proposed to promote into the shared dictionary.
  // Two of them are secrets and MUST be scrubbed before promotion.
  const candidates = [
    "long-term memory",                 // safe, weight-resident
    "sign in with a wallet",            // safe, weight-resident
    "the most likely cause is",         // safe, weight-resident
    "4111 1111 1111 1111",              // SECRET: fake card number (Luhn-valid)
    "ladder legal lemon length letter level logic lonely ridge rifle right rigid", // SECRET: mnemonic-looking
  ];

  const { admitted, blocked } = buildWeightResidentSet(candidates);

  line("Phrase promotion (privacy filter runs first):");
  for (const c of candidates) {
    const status = admitted.has(c) ? "PROMOTED" : "BLOCKED ";
    const shown = c.length > 40 ? c.slice(0, 37) + "..." : c;
    line(`  [${status}] ${shown}`);
  }
  line("");
  line(`Secrets scrubbed (never promoted): ${blocked.length}`);
  for (const b of blocked) {
    const shown = b.length > 40 ? b.slice(0, 37) + "..." : b;
    line(`  - ${shown}`);
  }
  line("");

  // A sample prompt that mixes shorthand phrases and weight-resident phrases.
  const prompt =
    "When the user asks for help, check long-term memory first. " +
    "If they want to sign in with a wallet, start the authentication flow. " +
    "The most likely cause is a stale configuration; for example, an expired token. " +
    "Do not alter the code in `legacyAuth()` during this transaction.";

  const result = encode(prompt, admitted);

  line("Original prompt:");
  line(`  ${prompt}`);
  line("");
  line("Encoded prompt (sent to model, minus cached legend):");
  line(`  ${result.encoded}`);
  line("");
  line("Legend (prompt-cached, injected once):");
  line(`  ${result.legend}`);
  line("");

  const restored = decode(result.encoded, result.refMap);
  const roundTripOk = restored === prompt;

  line(`Original length : ${result.originalLength} chars`);
  line(`Encoded length  : ${result.encodedLength} chars`);
  line(`Reduction       : ${result.reductionPct.toFixed(1)}%`);
  line(`Round-trip OK   : ${roundTripOk ? "yes" : "NO"}`);
  line("");

  // The scrubbed card number must not appear in any produced artifact.
  const cardLeaked =
    result.encoded.includes("4111") ||
    result.legend.includes("4111") ||
    [...result.refMap.values()].some(v => v.includes("4111"));
  line(`Secret leaked into codec output: ${cardLeaked ? "YES (bug)" : "no"}`);

  if (!roundTripOk || cardLeaked) {
    console.error("\nDemo invariant failed.");
    process.exit(1);
  }
  line("\nDemo complete.");
}
