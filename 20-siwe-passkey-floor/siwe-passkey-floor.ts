/**
 * SIWE Login with a Passkey Floor
 *
 * EIP-4361 (Sign-In With Ethereum) login with strict per-field validation and
 * a single-use nonce, plus a "passkey floor": every state-changing wallet
 * operation must carry a FRESH WebAuthn assertion, wallet-scoped and single-use.
 * A stolen session token alone cannot move funds.
 *
 *   - validateSiweMessage()   : pin domain / chain / nonce / age / URI.
 *   - verifySiweBind()        : field validation + ecrecover + nonce consume.
 *   - issueTransferChallenge(): per-action WebAuthn challenge, 3-min single-use.
 *   - verifyWalletAssertion() : enforce a fresh assertion before any mutation.
 *
 * Dependencies:
 *   - "ethers"                       (verifyMessage)
 *   - "@simplewebauthn/server"       (generate/verify authentication)
 *   - Node.js built-in "crypto"
 */

import crypto from "crypto";
import { ethers } from "ethers";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

// ── Server config (pin to your deployment) ───────────────────────────────────

export const SIWE_EXPECTED_DOMAIN = process.env.SIWE_EXPECTED_DOMAIN ?? "app.example.com";
export const SIWE_EXPECTED_CHAIN_ID = Number(process.env.SIWE_EXPECTED_CHAIN_ID ?? "1");
export const NONCE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_TTL_MS = 3 * 60 * 1000;

// Only first-party clients may mint a full session straight from a signature.
const ALLOWED_BIND_CLIENTS = new Set<string>(["primary-web-v1", "primary-mobile-v1"]);

// ── SIWE message validation ──────────────────────────────────────────────────

export function validateSiweMessage(message: string, wallet: string, nonce: string): string | null {
  const firstLine = message.split("\n")[0] ?? "";
  const domainMatch = firstLine.match(/^(.+) wants you to sign in with your Ethereum account:$/);
  if (!domainMatch) {
    return "SIWE message must begin with '{domain} wants you to sign in with your Ethereum account:'";
  }
  const messageDomain = domainMatch[1].trim();
  const msgHost = messageDomain.replace(/^https?:\/\//, "").split("/")[0];
  if (msgHost !== SIWE_EXPECTED_DOMAIN) {
    return `SIWE domain mismatch: '${messageDomain}' is not the registered domain`;
  }

  const addressLine = (message.split("\n")[1] ?? "").trim();
  if (addressLine.toLowerCase() !== wallet.toLowerCase()) {
    return "SIWE address does not match the submitted wallet";
  }

  if (!/^Version:\s*1$/im.test(message)) return "SIWE Version must be '1'";

  const chainMatch = message.match(/^Chain ID:\s*(\d+)$/im);
  if (!chainMatch) return "SIWE message missing 'Chain ID' field";
  if (Number(chainMatch[1]) !== SIWE_EXPECTED_CHAIN_ID) {
    return `SIWE Chain ID mismatch: message declares ${chainMatch[1]}, server expects ${SIWE_EXPECTED_CHAIN_ID}`;
  }

  const nonceMatch = message.match(/^Nonce:\s*([a-f0-9]+)$/im);
  if (!nonceMatch || nonceMatch[1].trim() !== nonce) {
    return "SIWE Nonce field is missing or does not match the server-issued nonce";
  }

  const issuedMatch = message.match(/^Issued At:\s*(.+)$/im);
  if (!issuedMatch) return "SIWE message missing 'Issued At' field";
  const issuedAt = new Date(issuedMatch[1].trim());
  if (Number.isNaN(issuedAt.getTime())) return "SIWE 'Issued At' is not a valid ISO 8601 timestamp";
  const age = Date.now() - issuedAt.getTime();
  if (age > NONCE_TTL_MS || age < -NONCE_TTL_MS) {
    return `SIWE message is too old or issued in the future (age: ${Math.round(age / 1000)}s, max: ${NONCE_TTL_MS / 1000}s)`;
  }

  const uriMatch = message.match(/^URI:\s*(.+)$/im);
  if (!uriMatch) return "SIWE message missing 'URI' field";
  try {
    const uriHost = new URL(uriMatch[1].trim()).host;
    if (uriHost !== SIWE_EXPECTED_DOMAIN) {
      return `SIWE URI host '${uriHost}' does not match expected domain '${SIWE_EXPECTED_DOMAIN}'`;
    }
  } catch {
    return "SIWE 'URI' field is not a valid URL";
  }

  return null;
}

// ── Store interfaces (wire to your DB) ───────────────────────────────────────

export interface NonceStore {
  issue(): Promise<{ nonce: string; expiresAt: Date }>;
  consume(nonce: string): Promise<boolean>; // true if found-unexpired and deleted
}
export interface ChallengeStore {
  store(challenge: string, type: string, userId?: string): Promise<void>;
  consume(challenge: string, type: string): Promise<{ userId?: string | null } | null>;
}
export interface PasskeyCredential {
  credentialId: string;
  publicKey: string;      // base64url
  counter: number;
  transports?: string | null;
}
export interface CredentialStore {
  forUser(userId: string): Promise<PasskeyCredential[]>;
  byId(userId: string, credentialId: string): Promise<PasskeyCredential | null>;
  bumpCounter(credentialId: string, counter: number): Promise<void>;
}

export interface SessionBinding {
  wallet: string;
  passkeyUserId: string | null;
  clientId: string;
}

export interface BindDeps {
  nonces: NonceStore;
  createSession: (wallet: string) => Promise<string>;
}

// ── SIWE bind ────────────────────────────────────────────────────────────────

export async function verifySiweBind(
  input: { message: string; signature: string; wallet: string; clientId: string; nonce: string },
  deps: BindDeps,
): Promise<{ ok: true; sessionToken: string } | { ok: false; status: number; error: string }> {
  if (!ALLOWED_BIND_CLIENTS.has(input.clientId)) {
    return { ok: false, status: 403, error: "This client is not permitted to use the direct bind endpoint." };
  }

  const err = validateSiweMessage(input.message, input.wallet, input.nonce);
  if (err) return { ok: false, status: 400, error: err };

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(input.message, input.signature);
  } catch {
    return { ok: false, status: 401, error: "Signature recovery failed" };
  }
  if (recovered.toLowerCase() !== input.wallet.toLowerCase()) {
    return { ok: false, status: 401, error: "Recovered signer does not match wallet" };
  }

  if (!(await deps.nonces.consume(input.nonce))) {
    return { ok: false, status: 401, error: "Nonce already used or expired" };
  }

  const sessionToken = await deps.createSession(input.wallet);
  return { ok: true, sessionToken };
}

// ── Passkey floor ────────────────────────────────────────────────────────────

export interface FloorDeps {
  challenges: ChallengeStore;
  credentials: CredentialStore;
  rpID: string;
  origin: string;
}

export async function issueTransferChallenge(binding: SessionBinding, deps: FloorDeps) {
  if (!binding.passkeyUserId) {
    return { error: "passkey_required", message: "Transfer challenge requires a passkey-authenticated session." };
  }
  const creds = await deps.credentials.forUser(binding.passkeyUserId);
  const options = await generateAuthenticationOptions({
    rpID: deps.rpID,
    userVerification: "required",
    allowCredentials: creds.map((c) => ({
      id: c.credentialId,
      transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransportFuture[]) : undefined,
    })),
  });
  await deps.challenges.store(options.challenge, `wallet-transfer:${binding.wallet}`, binding.passkeyUserId);
  return options;
}

interface AssertionReq {
  body: { credential?: Record<string, unknown> };
}

export async function verifyWalletAssertion(
  req: AssertionReq,
  binding: SessionBinding,
  challengeType: string,
  deps: FloorDeps,
): Promise<
  | { verified: true; credentialId: string; newCounter: number | null }
  | { verified: false; status: number; error: string; message?: string }
> {
  if (!binding.passkeyUserId) {
    return { verified: false, status: 403, error: "passkey_required", message: "This action requires a passkey-authenticated session." };
  }

  const credential = req.body.credential;
  if (!credential || !credential["response"] || !credential["id"]) {
    return { verified: false, status: 400, error: "credential_required", message: "A fresh passkey assertion is required. Call transfer-challenge first." };
  }

  const resp = credential["response"] as Record<string, unknown>;
  const cdj = resp["clientDataJSON"] as string | undefined;
  if (!cdj) return { verified: false, status: 400, error: "invalid_credential" };

  let expectedChallenge: string;
  try {
    expectedChallenge = (JSON.parse(Buffer.from(cdj, "base64url").toString()) as { challenge: string }).challenge;
  } catch {
    return { verified: false, status: 400, error: "invalid_clientDataJSON" };
  }

  const stored = await deps.challenges.consume(expectedChallenge, challengeType);
  if (!stored || stored.userId !== binding.passkeyUserId) {
    return { verified: false, status: 400, error: "challenge_expired_or_mismatched" };
  }

  const cred = await deps.credentials.byId(binding.passkeyUserId, String(credential["id"]));
  if (!cred) return { verified: false, status: 401, error: "credential_not_registered" };

  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    result = await verifyAuthenticationResponse({
      response: credential as unknown as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge,
      expectedOrigin: deps.origin,
      expectedRPID: deps.rpID,
      credential: {
        id: cred.credentialId,
        publicKey: Buffer.from(cred.publicKey, "base64url"),
        counter: cred.counter,
        transports: cred.transports ? (JSON.parse(cred.transports) as AuthenticatorTransportFuture[]) : undefined,
      },
    });
  } catch {
    return { verified: false, status: 401, error: "webauthn_failed" };
  }

  if (!result.verified) return { verified: false, status: 401, error: "webauthn_unverified" };

  const newCounter = typeof result.authenticationInfo?.newCounter === "number" ? result.authenticationInfo.newCounter : null;
  if (newCounter !== null) await deps.credentials.bumpCounter(cred.credentialId, newCounter);

  return { verified: true, credentialId: cred.credentialId, newCounter };
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  void (async () => {
    const wallet = ethers.Wallet.createRandom();
    const nonce = crypto.randomBytes(16).toString("hex");
    const issuedAt = new Date().toISOString();
    const message =
      `${SIWE_EXPECTED_DOMAIN} wants you to sign in with your Ethereum account:\n` +
      `${wallet.address}\n\n` +
      `Sign in.\n\n` +
      `URI: https://${SIWE_EXPECTED_DOMAIN}/login\n` +
      `Version: 1\n` +
      `Chain ID: ${SIWE_EXPECTED_CHAIN_ID}\n` +
      `Nonce: ${nonce}\n` +
      `Issued At: ${issuedAt}`;

    const signature = await wallet.signMessage(message);
    console.log("field validation:", validateSiweMessage(message, wallet.address, nonce) ?? "OK");

    let consumed = false;
    const deps: BindDeps = {
      nonces: { async issue() { return { nonce, expiresAt: new Date(Date.now() + NONCE_TTL_MS) }; },
                async consume(n) { if (consumed || n !== nonce) return false; consumed = true; return true; } },
      createSession: async () => "session-" + crypto.randomBytes(8).toString("hex"),
    };

    console.log("bind (good):", await verifySiweBind({ message, signature, wallet: wallet.address, clientId: "primary-web-v1", nonce }, deps));
    console.log("bind (nonce replay):", await verifySiweBind({ message, signature, wallet: wallet.address, clientId: "primary-web-v1", nonce }, deps));
    console.log("bind (bad client):", await verifySiweBind({ message, signature, wallet: wallet.address, clientId: "rogue", nonce }, deps));
  })();
}
