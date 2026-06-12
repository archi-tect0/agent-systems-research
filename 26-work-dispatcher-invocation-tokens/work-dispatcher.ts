/**
 * Work Dispatcher with Scoped Invocation Tokens
 *
 * Async job orchestration where a third-party app can invoke a user-granted
 * capability, and the worker that executes it can read the user's context
 * (wallet + grant scope) via a short-lived, job-scoped invocation token —
 * without ever holding the user's raw session token.
 *
 * Two principals:
 *   - App  : authenticates with clientId + clientSecret (registered a manifest)
 *   - User : authenticates with a session token to GRANT a capability
 *
 * The invocation token is the ONLY bridge to user context. It is minted at
 * invoke time, bound to exactly one job, and:
 *   - read context  (/job/:id/context) → 410 once the job resolves
 *   - poll result   (/job/:id)         → stays valid through completion
 *
 * This is an in-memory model. A production deployment swaps the Maps for
 * database tables and enforces idempotency with a unique partial index on
 * (grantId, idempotencyKey).
 *
 * Dependencies: Node.js built-in "crypto" only.
 */

import { createHash, randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export interface Capability {
  key: string;
}

interface Manifest {
  clientId: string;
  clientSecret: string;
  capabilities: Capability[];
}

interface Grant {
  id: string;
  clientId: string;
  capabilityKey: string;
  wallet: string;            // the granting user — recorded so the worker can learn identity
  sessionTokenHash: string;  // SHA-256 fingerprint of the creating session — never the raw bearer
  scopeJson: Record<string, unknown>;
  expiresAt: number;
  revokedAt: number | null;
}

type JobStatus = "pending" | "completed" | "failed";

interface Job {
  id: string;
  grantId: string;
  payloadHash: string;
  idempotencyKey: string | null;
  invocationToken: string;
  status: JobStatus;
  resultJson: Record<string, unknown> | null;
  createdAt: number;
  completedAt: number | null;
}

export class DispatchError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "DispatchError";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export class WorkDispatcher {
  private manifests = new Map<string, Manifest>();
  private grants = new Map<string, Grant>();
  private jobs = new Map<string, Job>();

  // ── App: register a capability manifest ─────────────────────────────────────
  registerManifest(clientId: string, clientSecret: string, capabilities: Capability[]): void {
    this.manifests.set(clientId, { clientId, clientSecret, capabilities });
  }

  private resolveApp(clientId: string, clientSecret: string): Manifest {
    const m = this.manifests.get(clientId);
    if (!m || m.clientSecret !== clientSecret) {
      throw new DispatchError(401, "invalid_credentials");
    }
    return m;
  }

  // ── User: grant a declared capability to an app ─────────────────────────────
  grant(
    sessionToken: string,
    wallet: string,
    clientId: string,
    capabilityKey: string,
    scope: Record<string, unknown>,
    expiresInSeconds: number,
  ): { grantId: string; expiresAt: number } {
    const m = this.manifests.get(clientId);
    if (!m) throw new DispatchError(404, "manifest_not_found");

    // The capability must be declared in the app's manifest.
    const declared = m.capabilities.some((c) => c.key === capabilityKey);
    if (!declared) throw new DispatchError(400, "capability_not_declared");

    const grantId = randomUUID();
    const expiresAt = Date.now() + expiresInSeconds * 1000;

    this.grants.set(grantId, {
      id: grantId,
      clientId,
      capabilityKey,
      wallet: wallet.toLowerCase(),
      sessionTokenHash: sha256(sessionToken), // fingerprint only — raw bearer never stored
      scopeJson: scope,
      expiresAt,
      revokedAt: null,
    });

    return { grantId, expiresAt };
  }

  // ── User: revoke a grant — authorized by WALLET ownership, not session match ──
  revoke(callerWallet: string, grantId: string): { revoked: true } {
    const g = this.grants.get(grantId);
    if (!g) throw new DispatchError(404, "grant_not_found");
    if (g.wallet !== callerWallet.toLowerCase()) {
      throw new DispatchError(403, "not_grant_owner");
    }
    g.revokedAt = Date.now();
    return { revoked: true };
  }

  // ── App: invoke a granted capability ────────────────────────────────────────
  invoke(
    clientId: string,
    clientSecret: string,
    grantId: string,
    params: Record<string, unknown>,
    idempotencyKey?: string,
  ): { jobId: string; status: JobStatus; invocationToken: string } {
    this.resolveApp(clientId, clientSecret);

    const g = this.grants.get(grantId);
    const now = Date.now();
    const valid =
      g && g.clientId === clientId && g.revokedAt === null && g.expiresAt > now;
    if (!valid) throw new DispatchError(403, "grant_invalid");

    // Idempotency: a retry returns the existing job AND its original token, so the
    // caller can authenticate against the same job it would have created.
    if (idempotencyKey) {
      for (const job of this.jobs.values()) {
        if (job.grantId === grantId && job.idempotencyKey === idempotencyKey) {
          return { jobId: job.id, status: job.status, invocationToken: job.invocationToken };
        }
      }
    }

    const payloadHash = sha256(
      JSON.stringify({ grantId, capabilityKey: g!.capabilityKey, params: params ?? {} }),
    );

    // The single bridge to user context — opaque, unguessable, bound to one job.
    const invocationToken = randomUUID();
    const jobId = this.enqueueJob(grantId, payloadHash, idempotencyKey ?? null, invocationToken);

    // In production: fire a best-effort, SSRF-guarded webhook here carrying
    // { event, jobId, params, wallet: g.wallet, invocationToken }. The invoke
    // RESPONSE is the authoritative channel for the token; the webhook is a hint.

    return { jobId, status: "pending", invocationToken };
  }

  private enqueueJob(
    grantId: string,
    payloadHash: string,
    idempotencyKey: string | null,
    invocationToken: string,
  ): string {
    const id = randomUUID();
    this.jobs.set(id, {
      id,
      grantId,
      payloadHash,
      idempotencyKey,
      invocationToken,
      status: "pending",
      resultJson: null,
      createdAt: Date.now(),
      completedAt: null,
    });
    return id;
  }

  // ── Worker: read user context — token-gated, dies on resolution ─────────────
  jobContext(
    jobId: string,
    invocationToken: string,
  ): { jobId: string; capabilityKey: string; wallet: string; scopeJson: Record<string, unknown>; expiresAt: number } {
    const job = this.jobs.get(jobId);
    if (!job) throw new DispatchError(404, "job_not_found");
    if (job.invocationToken !== invocationToken) {
      throw new DispatchError(403, "invalid_invocation_token");
    }
    // Context window closes once the job resolves — the worker is done by then.
    if (job.status === "completed" || job.status === "failed") {
      throw new DispatchError(410, "invocation_token_expired");
    }
    const g = this.grants.get(job.grantId)!;
    return {
      jobId: job.id,
      capabilityKey: g.capabilityKey,
      wallet: g.wallet,
      scopeJson: g.scopeJson,
      expiresAt: g.expiresAt,
    };
  }

  // ── Worker: post a result — app-authenticated, must own the grant ───────────
  postResult(
    clientId: string,
    clientSecret: string,
    jobId: string,
    status: "completed" | "failed",
    result?: Record<string, unknown>,
  ): void {
    this.resolveApp(clientId, clientSecret);
    const job = this.jobs.get(jobId);
    if (!job) throw new DispatchError(404, "job_not_found");
    const g = this.grants.get(job.grantId);
    if (!g || g.clientId !== clientId) throw new DispatchError(404, "job_not_found");

    job.status = status;
    job.resultJson = status === "completed" ? (result ?? {}) : { error: "failed" };
    job.completedAt = Date.now();
  }

  // ── App: poll status + result — token-gated, valid THROUGH completion ───────
  pollJob(
    jobId: string,
    invocationToken: string,
  ): { jobId: string; status: JobStatus; result: Record<string, unknown> | null } {
    const job = this.jobs.get(jobId);
    if (!job) throw new DispatchError(404, "job_not_found");
    if (job.invocationToken !== invocationToken) {
      throw new DispatchError(403, "invalid_invocation_token");
    }
    return { jobId: job.id, status: job.status, result: job.resultJson };
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const wd = new WorkDispatcher();

  wd.registerManifest("app-123", "secret-abc", [{ key: "calendar.summarize" }]);
  console.log("manifest registered");

  const { grantId } = wd.grant("session-token-xyz", "0xWALLET", "app-123", "calendar.summarize", { readOnly: true }, 3600);
  console.log("grant:", grantId);

  const inv = wd.invoke("app-123", "secret-abc", grantId, { range: "this-week" }, "idem-1");
  console.log("invoke:", inv);

  const ctx = wd.jobContext(inv.jobId, inv.invocationToken);
  console.log("worker reads context:", ctx);

  // Idempotent retry returns the same job + same token
  const retry = wd.invoke("app-123", "secret-abc", grantId, { range: "this-week" }, "idem-1");
  console.log("idempotent retry same job:", retry.jobId === inv.jobId, "same token:", retry.invocationToken === inv.invocationToken);

  // The bare job id without the token is rejected
  try { wd.pollJob(inv.jobId, "guessed-token"); }
  catch (e) { console.log("bare-id poll rejected:", (e as DispatchError).code); }

  wd.postResult("app-123", "secret-abc", inv.jobId, "completed", { summary: "3 meetings this week" });
  console.log("poll after result:", wd.pollJob(inv.jobId, inv.invocationToken));

  // Context window is now closed
  try { wd.jobContext(inv.jobId, inv.invocationToken); }
  catch (e) { console.log("context after resolution:", (e as DispatchError).code, "(410 expected)"); }

  // Revocation by wallet ownership
  console.log("revoke:", wd.revoke("0xWALLET", grantId));
}
