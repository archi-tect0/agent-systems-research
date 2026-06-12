import crypto from "crypto";

const TOKEN_PREFIX = "gate:";

/**
 * Issue a stateless gate token for a given password.
 *
 *   token = HMAC-SHA256(secret, "gate:" + password)  (hex)
 *
 * The token is a deterministic function of (secret, password). No session
 * record is stored anywhere; the token IS the proof that the holder knew
 * the password at issue time.
 */
export function issueGateToken(secret: string, password: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${TOKEN_PREFIX}${password}`)
    .digest("hex");
}

/**
 * Verify a token against the current password using a constant-time
 * comparison. Returns false (never throws) on any malformed input.
 *
 * Because the expected value is recomputed from the CURRENT password,
 * rotating the password changes the expected HMAC and instantly
 * invalidates every previously issued token — with no session store to
 * purge.
 */
export function verifyGateToken(secret: string, currentPassword: string, token: string): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const expected = issueGateToken(secret, currentPassword);
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(token, "hex");
    b = Buffer.from(expected, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

if (process.argv.includes("--demo")) {
  const secret = crypto.randomBytes(32).toString("hex");
  let password = "first-access-phrase";

  console.log("=== Stateless HMAC Preview-Gate Tokens ===\n");
  console.log("Server secret (fixed): " + secret.slice(0, 16) + "...");
  console.log('Current password:      "' + password + '"\n');

  const token = issueGateToken(secret, password);
  console.log("Issued token to client: " + token.slice(0, 24) + "...");

  const okNow = verifyGateToken(secret, password, token);
  console.log("Verify with current password -> " + (okNow ? "ACCEPTED" : "REJECTED"));

  const wrong = verifyGateToken(secret, password, "deadbeef");
  console.log("Verify a forged token        -> " + (wrong ? "ACCEPTED" : "REJECTED"));

  console.log("\n--- rotating password (no session DB to purge) ---\n");
  password = "rotated-access-phrase";
  console.log('New password: "' + password + '"');

  const okAfterRotate = verifyGateToken(secret, password, token);
  console.log("Old token vs new password    -> " + (okAfterRotate ? "ACCEPTED" : "REJECTED"));

  const fresh = issueGateToken(secret, password);
  const okFresh = verifyGateToken(secret, password, fresh);
  console.log("Re-issued token vs new pwd   -> " + (okFresh ? "ACCEPTED" : "REJECTED"));

  const pass = okNow && !wrong && !okAfterRotate && okFresh;
  console.log("\nResult: " + (pass ? "all expectations met" : "UNEXPECTED"));
  if (!pass) process.exit(1);
}
