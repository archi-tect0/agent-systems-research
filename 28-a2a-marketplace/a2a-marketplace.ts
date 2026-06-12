/**
 * Agent-to-Agent Marketplace and Job Feed
 *
 * A marketplace where autonomous agents publish capabilities, get hired,
 * submit verifiable proof-of-work, and exchange value under escrow — with
 * strict tenant isolation: a job UUID is NEVER authorization. Every read is
 * scoped to the authenticated principal.
 *
 * Two principals, two credential types (never interchangeable):
 *   - Human (session token)  : register agents, hire, dispute, kill-switch
 *   - Agent (per-agent key)  : submit results for jobs assigned to it
 *
 * The agent API key is shown ONCE at generation; only its SHA-256 hash is
 * stored and verified by hashing the presented key.
 *
 * The SSRF-guarded outbound webhook is an injectable hook here; see guide 23
 * for the full DNS-pinning network implementation.
 *
 * Dependencies: Node.js built-in "crypto" only.
 */

import crypto from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentStatus = "active" | "paused";
export type JobStatus = "pending" | "in_progress" | "completed" | "disputed" | "refunded";

export interface Agent {
  id: string;
  ownerWallet: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  capabilities: string[];
  webhookUrl: string;
  ethPayoutAddress: string;
  status: AgentStatus;
  reputationScore: number;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  totalEarnedEth: number;
  apiKeyHash: string | null;
  createdAt: number;
}

export interface Job {
  id: string;
  agentId: string;
  agentName: string;
  buyerWallet: string;
  taskSpec: string;
  escrowAmountEth: number;
  platformFeeEth: number;
  deadlineAt: number;
  status: JobStatus;
  result: Record<string, unknown> | null;
  proofHash: string | null;
  disputeReason: string | null;
  createdAt: number;
  completedAt: number | null;
}

export type WebhookHook = (url: string, payload: Record<string, unknown>) => void;

export class MarketError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "MarketError";
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const PLATFORM_FEE_RATE = 0.015;     // 1.5%
const DISPUTE_REPUTATION_PENALTY = 5;

// ── Marketplace ──────────────────────────────────────────────────────────────

export class Marketplace {
  private agents = new Map<string, Agent>();
  private jobs = new Map<string, Job>();

  /**
   * @param webhook        injectable, SSRF-guarded webhook delivery (best-effort)
   * @param isScopedSession predicate: is this session a limited paired device?
   */
  private webhook: WebhookHook;
  private isScopedSession: (sessionToken: string) => boolean;
  constructor(
    webhook: WebhookHook = () => {},
    isScopedSession: (sessionToken: string) => boolean = () => false,
  ) {
    this.webhook = webhook;
    this.isScopedSession = isScopedSession;
  }

  private blockScoped(sessionToken: string): void {
    if (this.isScopedSession(sessionToken)) {
      throw new MarketError(403, "scoped_sessions_cannot_perform_marketplace_writes");
    }
  }

  private sha256(s: string): string {
    return crypto.createHash("sha256").update(s).digest("hex");
  }

  /** Public-safe view: never expose the API key hash. */
  private safeAgent(a: Agent): Omit<Agent, "apiKeyHash"> {
    const { apiKeyHash: _k, ...rest } = a;
    return rest;
  }

  // ── Register an agent (human session) ───────────────────────────────────────
  registerAgent(
    sessionToken: string,
    ownerWallet: string,
    spec: {
      name: string; slug: string; description?: string; category: string;
      capabilities?: string[]; webhookUrl: string; ethPayoutAddress: string;
    },
  ): Omit<Agent, "apiKeyHash"> {
    this.blockScoped(sessionToken);
    if (!spec.name || !spec.slug || !spec.category || !spec.webhookUrl || !spec.ethPayoutAddress) {
      throw new MarketError(400, "missing_required_fields");
    }
    if (!/^https:\/\//.test(spec.webhookUrl)) throw new MarketError(400, "webhook_must_be_https");
    for (const a of this.agents.values()) {
      if (a.slug === spec.slug) throw new MarketError(409, "slug_already_taken");
    }

    const agent: Agent = {
      id: crypto.randomUUID(),
      ownerWallet: ownerWallet.toLowerCase(),
      name: spec.name,
      slug: spec.slug,
      description: spec.description ?? "",
      category: spec.category,
      capabilities: spec.capabilities ?? [],
      webhookUrl: spec.webhookUrl,
      ethPayoutAddress: spec.ethPayoutAddress,
      status: "active",
      reputationScore: 50,
      totalJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
      totalEarnedEth: 0,
      apiKeyHash: null,
      createdAt: Date.now(),
    };
    this.agents.set(agent.id, agent);
    return this.safeAgent(agent);
  }

  // ── Browse (public) — ranked by reputation then volume ──────────────────────
  browse(opts: { category?: string; search?: string } = {}): Omit<Agent, "apiKeyHash">[] {
    let list = [...this.agents.values()].filter((a) => a.status === "active");
    if (opts.category) list = list.filter((a) => a.category === opts.category);
    if (opts.search) {
      const q = opts.search.toLowerCase();
      list = list.filter((a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
    }
    list.sort((a, b) => b.reputationScore - a.reputationScore || b.totalJobs - a.totalJobs);
    return list.map((a) => this.safeAgent(a));
  }

  // ── Generate API key (owner only) — returned ONCE ───────────────────────────
  generateApiKey(sessionToken: string, ownerWallet: string, agentId: string): { apiKey: string; agentId: string } {
    this.blockScoped(sessionToken);
    const agent = this.agents.get(agentId);
    if (!agent) throw new MarketError(404, "agent_not_found");
    if (agent.ownerWallet !== ownerWallet.toLowerCase()) throw new MarketError(403, "not_your_agent");

    const rawKey = `a2a_${crypto.randomBytes(32).toString("hex")}`;
    agent.apiKeyHash = this.sha256(rawKey); // store hash only
    return { apiKey: rawKey, agentId };
  }

  private resolveAgentByApiKey(apiKey: string): Agent {
    const hash = this.sha256(apiKey);
    for (const a of this.agents.values()) if (a.apiKeyHash === hash) return a;
    throw new MarketError(401, "invalid_api_key");
  }

  // ── Kill switches (owner only) ──────────────────────────────────────────────
  setStatus(sessionToken: string, ownerWallet: string, agentId: string, status: AgentStatus): void {
    this.blockScoped(sessionToken);
    const agent = this.agents.get(agentId);
    if (!agent) throw new MarketError(404, "agent_not_found");
    if (agent.ownerWallet !== ownerWallet.toLowerCase()) throw new MarketError(403, "not_your_agent");
    agent.status = status;
  }

  // ── Hire / post a job (human session) ───────────────────────────────────────
  postJob(
    sessionToken: string,
    buyerWallet: string,
    spec: { agentId: string; taskSpec: string; escrowAmountEth: string; deadlineHours: number },
  ): Job {
    this.blockScoped(sessionToken);
    const agent = this.agents.get(spec.agentId);
    if (!agent || agent.status !== "active") throw new MarketError(404, "agent_not_found_or_paused");

    const escrow = parseFloat(spec.escrowAmountEth);
    const fee = Number((escrow * PLATFORM_FEE_RATE).toFixed(18));
    const deadlineAt = Date.now() + spec.deadlineHours * 3600_000;

    const job: Job = {
      id: crypto.randomUUID(),
      agentId: agent.id,
      agentName: agent.name,
      buyerWallet: buyerWallet.toLowerCase(),
      taskSpec: spec.taskSpec,
      escrowAmountEth: escrow,
      platformFeeEth: fee,
      deadlineAt,
      status: "pending",
      result: null,
      proofHash: null,
      disputeReason: null,
      createdAt: Date.now(),
      completedAt: null,
    };
    this.jobs.set(job.id, job);
    agent.totalJobs += 1;

    // Best-effort, SSRF-guarded notification.
    this.webhook(agent.webhookUrl, {
      event: "job.created",
      jobId: job.id,
      agentId: agent.id,
      buyerWallet: job.buyerWallet,
      taskSpec: job.taskSpec,
      escrowAmountEth: escrow,
      platformFeeEth: fee,
      deadlineAt,
    });

    return job;
  }

  // ── Agent submits proof of work (agent API key) ─────────────────────────────
  submitProof(apiKey: string, jobId: string, result: Record<string, unknown>, proofHash: string): Job {
    const agent = this.resolveAgentByApiKey(apiKey);
    if (agent.status === "paused") throw new MarketError(403, "agent_paused");

    const job = this.jobs.get(jobId);
    if (!job) throw new MarketError(404, "job_not_found");
    if (job.agentId !== agent.id) throw new MarketError(403, "not_your_job");
    if (job.status !== "pending" && job.status !== "in_progress") throw new MarketError(409, "job_already_settled");
    if (Date.now() > job.deadlineAt) throw new MarketError(410, "deadline_passed");
    if (!result || !proofHash) throw new MarketError(400, "result_and_proof_required");

    job.result = result;
    job.proofHash = proofHash;
    job.status = "completed";
    job.completedAt = Date.now();

    agent.completedJobs += 1;
    agent.totalEarnedEth += job.escrowAmountEth - job.platformFeeEth;
    return job;
  }

  // ── Read job detail — buyer OR agent owner only (id is NOT authorization) ────
  getJob(callerWallet: string, jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new MarketError(404, "job_not_found");
    const w = callerWallet.toLowerCase();
    if (job.buyerWallet !== w) {
      const agent = this.agents.get(job.agentId);
      if (!agent || agent.ownerWallet !== w) throw new MarketError(403, "access_denied");
    }
    return job;
  }

  // ── Job feed — always scoped to the authenticated wallet ────────────────────
  jobFeed(callerWallet: string, role: "buyer" | "seller" = "buyer"): Job[] {
    const w = callerWallet.toLowerCase();
    if (role === "seller") {
      const myAgentIds = new Set([...this.agents.values()].filter((a) => a.ownerWallet === w).map((a) => a.id));
      return [...this.jobs.values()].filter((j) => myAgentIds.has(j.agentId)).sort((a, b) => b.createdAt - a.createdAt);
    }
    return [...this.jobs.values()].filter((j) => j.buyerWallet === w).sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── Raise a dispute (buyer, human session) ──────────────────────────────────
  dispute(sessionToken: string, buyerWallet: string, jobId: string, reason: string): Job {
    this.blockScoped(sessionToken);
    const job = this.jobs.get(jobId);
    if (!job) throw new MarketError(404, "job_not_found");
    if (job.buyerWallet !== buyerWallet.toLowerCase()) throw new MarketError(403, "not_your_job");
    if (job.status === "disputed" || job.status === "refunded") throw new MarketError(409, "already_disputed");
    if (!reason || reason.length < 10) throw new MarketError(400, "reason_too_short");

    job.status = "disputed";
    job.disputeReason = reason;

    const agent = this.agents.get(job.agentId);
    if (agent) {
      agent.failedJobs += 1;
      agent.reputationScore = Math.max(0, agent.reputationScore - DISPUTE_REPUTATION_PENALTY);
    }
    return job;
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const delivered: Array<{ url: string; event: unknown }> = [];
  const m = new Marketplace((url, payload) => delivered.push({ url, event: payload["event"] }));

  const agent = m.registerAgent("session-dev", "0xDEV", {
    name: "Summarizer", slug: "summarizer", category: "text",
    webhookUrl: "https://hooks.example.com/a2a", ethPayoutAddress: "0xDEV",
  });
  console.log("registered agent:", agent.id, "(apiKeyHash hidden:", !("apiKeyHash" in agent), ")");

  const { apiKey } = m.generateApiKey("session-dev", "0xDEV", agent.id);
  console.log("api key issued once:", apiKey.slice(0, 12) + "…");

  const job = m.postJob("session-buyer", "0xBUYER", {
    agentId: agent.id, taskSpec: "Summarize this report", escrowAmountEth: "1.0", deadlineHours: 24,
  });
  console.log("job posted:", job.id, "fee:", job.platformFeeEth, "webhook fired:", delivered.length === 1);

  m.submitProof(apiKey, job.id, { summary: "Three key findings…" }, "0xPROOF");
  console.log("after submit, status:", m.getJob("0xBUYER", job.id).status);

  // A stranger cannot read the job even with the id
  try { m.getJob("0xSTRANGER", job.id); }
  catch (e) { console.log("stranger read rejected:", (e as MarketError).code); }

  // Feed is principal-scoped
  console.log("buyer feed:", m.jobFeed("0xBUYER", "buyer").length, "seller feed:", m.jobFeed("0xDEV", "seller").length);
}
