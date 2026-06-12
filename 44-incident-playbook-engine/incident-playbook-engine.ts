export type StepKind = "detect" | "contain" | "communicate" | "archive" | "recover";

export type Severity = 1 | 2 | 3 | 4 | 5;

export interface PlaybookStep {
  order: number;
  kind: StepKind;
  description: string;
  toolHint?: string;
  autoExecutable: boolean;
  requiresApproval: boolean;
}

export interface Playbook {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  detectionTerms: RegExp;
  steps: PlaybookStep[];
}

export interface StepPlan {
  autoSteps: PlaybookStep[];
  approvalSteps: PlaybookStep[];
  ordered: PlaybookStep[];
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: "wallet_compromise",
    title: "Wallet Compromise Response",
    description: "Unauthorized account access detected — funds at risk. Immediate containment required.",
    severity: 5,
    detectionTerms: /\b(wallet.*hack|unauthorized.*transact|funds.*drained|drained|drain|stolen.*coins|compromised.*wallet|private.*key.*exposed)\b/i,
    steps: [
      { order: 1, kind: "detect", description: "Retrieve last 24h transaction history across all chains", toolHint: "spend_monitor", autoExecutable: true, requiresApproval: false },
      { order: 2, kind: "detect", description: "Identify unauthorized or anomalous outbound transactions", autoExecutable: true, requiresApproval: false },
      { order: 3, kind: "contain", description: "Freeze account — block all outbound transfers above zero", toolHint: "spend_monitor", autoExecutable: false, requiresApproval: true },
      { order: 4, kind: "contain", description: "Revoke all active token approvals on each affected chain", toolHint: "explain_contract", autoExecutable: false, requiresApproval: true },
      { order: 5, kind: "archive", description: "Export full transaction log with decoded calldata as encrypted evidence bundle", toolHint: "remember", autoExecutable: true, requiresApproval: false },
      { order: 6, kind: "communicate", description: "Notify recovery guardians of incident via secure channel", toolHint: "notify", autoExecutable: true, requiresApproval: false },
      { order: 7, kind: "recover", description: "Generate new account, transfer remaining funds with explicit confirmation", autoExecutable: false, requiresApproval: true },
    ],
  },
  {
    id: "phishing_message",
    title: "Phishing Message Containment",
    description: "Phishing or suspicious message detected. Likely social engineering attempt.",
    severity: 3,
    detectionTerms: /\b(phish|suspicious.*email|suspicious.*mail|fake.*link|malicious.*link|urgent.*action.*required|verify.*wallet|confirm.*seed|account.*suspended)\b/i,
    steps: [
      { order: 1, kind: "detect", description: "Extract all URLs from the message body and headers", autoExecutable: true, requiresApproval: false },
      { order: 2, kind: "detect", description: "Cross-reference sender against known contacts and trusted domains", toolHint: "lookup_contact", autoExecutable: true, requiresApproval: false },
      { order: 3, kind: "detect", description: "Scan for urgency language and seed-phrase requests", autoExecutable: true, requiresApproval: false },
      { order: 4, kind: "contain", description: "Quarantine the message — move to blocked/flagged folder", autoExecutable: true, requiresApproval: false },
      { order: 5, kind: "archive", description: "Archive message headers, body and extracted URLs to evidence store", toolHint: "remember", autoExecutable: true, requiresApproval: false },
      { order: 6, kind: "communicate", description: "Notify user with analysis summary and recommendation", autoExecutable: true, requiresApproval: false },
      { order: 7, kind: "recover", description: "If user clicked any link: escalate to wallet compromise playbook", autoExecutable: false, requiresApproval: true },
    ],
  },
  {
    id: "account_takeover",
    title: "Account Takeover Response",
    description: "Signs of takeover: unexpected device pairing, unknown session, login from new location.",
    severity: 5,
    detectionTerms: /\b(account.*taken.*over|unauthorized.*login|unknown.*device.*paired|strange.*session|someone.*else.*access|unknown.*access)\b/i,
    steps: [
      { order: 1, kind: "detect", description: "Pull full session list — flag sessions from unknown devices", autoExecutable: true, requiresApproval: false },
      { order: 2, kind: "detect", description: "Pull device pairing list — flag unrecognized devices", autoExecutable: true, requiresApproval: false },
      { order: 3, kind: "contain", description: "Revoke all sessions except the current authenticated session", autoExecutable: false, requiresApproval: true },
      { order: 4, kind: "contain", description: "Unpair all unrecognized devices", autoExecutable: false, requiresApproval: true },
      { order: 5, kind: "archive", description: "Export session log and device list with IP/UA data to evidence store", toolHint: "remember", autoExecutable: true, requiresApproval: false },
      { order: 6, kind: "communicate", description: "Notify guardians of potential takeover attempt", autoExecutable: true, requiresApproval: false },
      { order: 7, kind: "recover", description: "Initiate credential rotation — issue new authenticator, retire old", autoExecutable: false, requiresApproval: true },
    ],
  },
  {
    id: "key_leakage",
    title: "Key Leakage Containment",
    description: "Private key, seed phrase or secret share may have been exposed.",
    severity: 5,
    detectionTerms: /\b(private.*key.*exposed|seed.*phrase.*leaked|mnemonic.*shared|key.*in.*log|key.*in.*history|accidentally.*shared.*key)\b/i,
    steps: [
      { order: 1, kind: "detect", description: "Identify what key material was exposed and to which surface", autoExecutable: true, requiresApproval: false },
      { order: 2, kind: "contain", description: "Purge key material from agent memory — do not retain in any recall layer", toolHint: "remember", autoExecutable: true, requiresApproval: false },
      { order: 3, kind: "contain", description: "Freeze affected account immediately", toolHint: "spend_monitor", autoExecutable: false, requiresApproval: true },
      { order: 4, kind: "archive", description: "Log incident: what was exposed, when, how, with what blast radius", toolHint: "project_log", autoExecutable: true, requiresApproval: false },
      { order: 5, kind: "recover", description: "Generate new account with fresh key material", autoExecutable: false, requiresApproval: true },
      { order: 6, kind: "recover", description: "Transfer all remaining funds from old account to new account", autoExecutable: false, requiresApproval: true },
    ],
  },
  {
    id: "credential_exposure",
    title: "Credential Exposure Response",
    description: "API key, OAuth token or session token may have been exposed in logs or context.",
    severity: 4,
    detectionTerms: /\b(credential.*exposed|api.*key.*leaked|token.*in.*log|oauth.*exposed|session.*token.*visible|secret.*in.*url|secret.*in.*header)\b/i,
    steps: [
      { order: 1, kind: "detect", description: "Identify credential type (API key / OAuth / session / webhook secret)", autoExecutable: true, requiresApproval: false },
      { order: 2, kind: "detect", description: "Identify the exposure surface: URL, log, context, clipboard, network", autoExecutable: true, requiresApproval: false },
      { order: 3, kind: "contain", description: "Revoke the exposed credential at the source", autoExecutable: false, requiresApproval: true },
      { order: 4, kind: "contain", description: "Purge credential from agent memory and all stored blobs", toolHint: "remember", autoExecutable: true, requiresApproval: false },
      { order: 5, kind: "archive", description: "Log incident: credential type, exposure vector, blast radius estimate", toolHint: "project_log", autoExecutable: true, requiresApproval: false },
      { order: 6, kind: "recover", description: "Generate replacement credential and update dependent systems", autoExecutable: false, requiresApproval: true },
    ],
  },
];

const PLAYBOOK_BY_ID = new Map<string, Playbook>(PLAYBOOKS.map((p) => [p.id, p]));

export function getPlaybook(id: string): Playbook | undefined {
  return PLAYBOOK_BY_ID.get(id);
}

/** Detect which playbook is triggered by a free-text incident description. */
export function detectPlaybook(text: string): Playbook | null {
  for (const p of PLAYBOOKS) {
    if (p.detectionTerms.test(text)) return p;
  }
  return null;
}

/** Build an ordered execution plan partitioned by auto vs approval-gated. */
export function buildStepPlan(playbook: Playbook): StepPlan {
  const ordered = [...playbook.steps].sort((a, b) => a.order - b.order);
  return {
    ordered,
    autoSteps: ordered.filter((s) => s.autoExecutable),
    approvalSteps: ordered.filter((s) => s.requiresApproval),
  };
}

if (process.argv.includes("--demo")) {
  const alerts = [
    "Help! my wallet got drained overnight, funds are gone",
    "got a suspicious email saying my account is suspended, verify wallet now",
    "an unknown device paired with my account from another country",
    "I think my api key leaked, it showed up in a public log",
    "the weather looks nice today",
  ];

  console.log("=== Deterministic Incident Response Playbook Engine ===\n");

  for (const alert of alerts) {
    console.log(`ALERT: "${alert}"`);
    const pb = detectPlaybook(alert);
    if (!pb) {
      console.log("  -> no playbook matched\n");
      continue;
    }
    const plan = buildStepPlan(pb);
    console.log(`  -> matched: ${pb.title} [${pb.id}] severity ${pb.severity}/5`);
    console.log(`  -> ${plan.ordered.length} steps (${plan.autoSteps.length} auto, ${plan.approvalSteps.length} approval-gated)`);
    for (const s of plan.ordered) {
      const tag = s.autoExecutable ? "AUTO    " : "APPROVAL";
      const tool = s.toolHint ? ` {${s.toolHint}}` : "";
      console.log(`     ${s.order}. [${tag}] (${s.kind}) ${s.description}${tool}`);
    }
    console.log("");
  }

  const matched = alerts.map(detectPlaybook).filter((p) => p !== null);
  if (matched.length !== 4) process.exit(1);
}
