/**
 * Multi-Agent Coordination & Social Reasoning — reference implementation.
 *
 * An agent never acts alone: the agent shares custody with guardians, delegates work
 * to other agents, and answers to a human who holds the passkey floor. An agent
 * that models the world but not the agents in it will confidently act on a plan
 * everyone else has already abandoned. This is the social layer: model what other
 * minds believe, earn and spend trust by outcome, agree on a shared plan only on
 * authority + quorum, resolve contradictory claims by rank, and catch a peer
 * whose actions betray its words.
 *
 * The five things social reasoning has to do:
 *
 *   1. Model other minds        — for each peer, keep `beliefsAbout`: what *I*
 *                                think *they* believe. A divergence from my own
 *                                belief is a coordination gap to re-sync.
 *   2. Earn & spend trust       — a peer's claim that proves true raises its
 *                                trust; a false one lowers it; trust then becomes
 *                                the WEIGHT its claims carry into the belief state.
 *   3. Coordinate               — propose → vote → commit; a vote counts only if
 *                                the voter's authority band clears the bar, and an
 *                                irreversible action needs a human approver.
 *   4. Resolve conflict         — contradictory claims are decided by band, then
 *                                trust, then escalation — never a silent guess.
 *   5. Detect deception         — a peer that acts against its stated belief is
 *                                flagged, loses trust hard, and is escalated.
 *
 * This closes the Layer-3 triad: deliberation is time (guide 74), the belief
 * state is space (guide 75), coordination is society. It builds on quorum vault
 * groups (29), authority bands (37), and the A2A marketplace (28).
 *
 * Run it:
 *   node multi-agent-coordination.ts --demo    # Node 24+ strips TS types natively
 *   npx tsx multi-agent-coordination.ts --demo
 *
 * Node.js built-ins only. Deterministic: a logical clock, fixed trust constants,
 * no wall-time, no randomness.
 */

// ─────────────────────────────────────────────────────────────────────────
// Peers. Humans, agents, and tools share one structure: the human at the
// passkey floor is the highest-authority peer, not an exception outside the
// model. `authorityBand` mirrors guide 37; `trust` is earned by outcome.
// ─────────────────────────────────────────────────────────────────────────

type AgentKind = "human" | "agent" | "tool";

type Peer = {
  id: string;
  kind: AgentKind;
  authorityBand: number; // higher = more authority
  trust: number; // 0..1, earned by outcome
  beliefsAbout: Record<string, boolean>; // theory-of-mind: what I think they believe
};

// Trust update constants (deterministic).
const ALPHA = 0.4; // how fast a correct claim raises trust
const BETA = 0.5; // how fast a wrong claim lowers it
const DECEPTION_PENALTY = 0.7; // fraction of trust burned on a word/deed mismatch

type Claim = { peer: string; predicate: string; value: boolean };
type Proposal = {
  id: string;
  proposer: string;
  action: string;
  irreversible: boolean;
  requiredBand: number; // a vote counts only if the voter's band >= this
  requiredQuorum: number; // qualifying votes needed to commit
};
type Vote = { peer: string; accept: boolean };
type Decision = "COMMIT" | "REJECT" | "ESCALATE";

// ─────────────────────────────────────────────────────────────────────────
// The society model.
// ─────────────────────────────────────────────────────────────────────────

class Society {
  private peers: Record<string, Peer> = {};
  private myBeliefs: Record<string, boolean> = {};
  private clock = 0;

  addPeer(id: string, kind: AgentKind, authorityBand: number, trust = 0.5): Peer {
    const p: Peer = { id, kind, authorityBand, trust, beliefsAbout: {} };
    this.peers[id] = p;
    return p;
  }

  peer(id: string): Peer {
    const p = this.peers[id];
    if (!p) throw new Error(`no peer '${id}'`);
    return p;
  }

  /** My own view of the world (what coordination gaps are measured against). */
  setMyBelief(predicate: string, value: boolean) {
    this.myBeliefs[predicate] = value;
  }

  /** (1) Theory-of-mind: record what I think a peer believes. */
  modelBelief(peerId: string, predicate: string, value: boolean) {
    this.peer(peerId).beliefsAbout[predicate] = value;
    this.clock++;
  }

  /** (1) Surface every place my belief diverges from a peer's modeled belief. */
  coordinationGaps(): Array<{ peer: string; predicate: string; mine: boolean; theirs: boolean }> {
    const gaps: Array<{ peer: string; predicate: string; mine: boolean; theirs: boolean }> = [];
    for (const p of Object.values(this.peers)) {
      for (const [pred, theirs] of Object.entries(p.beliefsAbout)) {
        if (pred in this.myBeliefs && this.myBeliefs[pred] !== theirs) {
          gaps.push({ peer: p.id, predicate: pred, mine: this.myBeliefs[pred], theirs });
        }
      }
    }
    return gaps;
  }

  /** (2) Trust earned by outcome: a claim that proves true raises trust, a false
   *  one lowers it. Deterministic. */
  recordOutcome(peerId: string, claimed: boolean, actual: boolean): number {
    const p = this.peer(peerId);
    if (claimed === actual) p.trust = p.trust + (1 - p.trust) * ALPHA;
    else p.trust = p.trust - p.trust * BETA;
    p.trust = Math.max(0, Math.min(1, p.trust));
    this.clock++;
    return p.trust;
  }

  /** (2) The weight a peer's claim carries into the belief state (guide 75) is
   *  its trust. A trusted guardian moves a belief far more than an untested peer. */
  claimWeight(peerId: string): number {
    return this.peer(peerId).trust;
  }

  /** (3) Coordination + social governance: count qualifying votes, require a human
   *  for irreversible actions, commit only on quorum. */
  evaluateProposal(p: Proposal, votes: Vote[]): { decision: Decision; reason: string } {
    // Dedupe per peer first: one peer is one vote, so duplicate ballots can't fake a quorum.
    const qualifyingPeers = new Set<string>();
    for (const v of votes) {
      if (v.accept && this.peer(v.peer).authorityBand >= p.requiredBand) qualifyingPeers.add(v.peer);
    }
    const count = qualifyingPeers.size;
    const hasHuman = [...qualifyingPeers].some((id) => this.peer(id).kind === "human");
    if (p.irreversible && !hasHuman) {
      return { decision: "ESCALATE", reason: "irreversible action requires a human approver" };
    }
    if (count >= p.requiredQuorum) {
      return { decision: "COMMIT", reason: `${count}/${p.requiredQuorum} qualifying peers${p.irreversible ? " incl. human" : ""}` };
    }
    return { decision: "REJECT", reason: `only ${count}/${p.requiredQuorum} qualifying peers (band >= ${p.requiredBand})` };
  }

  /** (4) Resolve contradictory claims by authority band, then trust, then escalate. */
  resolveConflict(a: Claim, b: Claim): { winner?: Claim; by: string } {
    if (a.predicate !== b.predicate || a.value === b.value) return { by: "not-a-conflict" };
    const pa = this.peer(a.peer);
    const pb = this.peer(b.peer);
    if (pa.authorityBand !== pb.authorityBand) {
      return { winner: pa.authorityBand > pb.authorityBand ? a : b, by: "authority band" };
    }
    if (pa.trust !== pb.trust) {
      return { winner: pa.trust > pb.trust ? a : b, by: "trust" };
    }
    return { by: "escalate (deadlock — equal band and trust)" };
  }

  /** (5) Deception: a peer that acts against its own stated belief is flagged,
   *  loses trust hard, and is escalated. */
  detectDeception(peerId: string, stated: { predicate: string; value: boolean }, observedAction: { predicate: string; value: boolean }): { deceptive: boolean; trust: number } {
    const p = this.peer(peerId);
    const deceptive = stated.predicate === observedAction.predicate && stated.value !== observedAction.value;
    if (deceptive) {
      p.trust = Math.max(0, p.trust * (1 - DECEPTION_PENALTY));
      this.clock++;
    }
    return { deceptive, trust: p.trust };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Demo
// ─────────────────────────────────────────────────────────────────────────

function banner(t: string) {
  console.log("\n" + "─".repeat(74) + "\n" + t + "\n" + "─".repeat(74));
}

function buildSociety(): Society {
  const s = new Society();
  s.addPeer("executor", "agent", 1); // a delegated co-signing agent, low band
  s.addPeer("oracle_A", "agent", 1);
  s.addPeer("oracle_B", "agent", 1);
  s.addPeer("guardian_1", "agent", 2);
  s.addPeer("guardian_2", "agent", 2);
  s.addPeer("owner", "human", 3); // the human at the passkey floor — highest band
  return s;
}

function demo() {
  banner("Scenario 1 — theory of mind: surface a coordination gap before acting");
  {
    const s = buildSociety();
    s.setMyBelief("networkUp", false); // I have observed the network degrade
    s.modelBelief("executor", "networkUp", true); // but the delegated agent still thinks it's up
    s.modelBelief("executor", "recipientWhitelisted", true);
    const gaps = s.coordinationGaps();
    for (const g of gaps) console.log(`    gap with '${g.peer}' on '${g.predicate}': mine=${g.mine} theirs=${g.theirs}`);
    console.log(`  found ${gaps.length} coordination gap — re-sync the executor before it acts on a stale belief.`);
  }

  banner("Scenario 2 — trust by outcome: re-weight peers' claims by their track record");
  {
    const s = buildSociety();
    // oracle_A keeps being right; oracle_B keeps being wrong.
    for (let i = 0; i < 3; i++) s.recordOutcome("oracle_A", true, true);
    for (let i = 0; i < 3; i++) s.recordOutcome("oracle_B", true, false);
    console.log(`    oracle_A trust=${s.peer("oracle_A").trust.toFixed(3)}  oracle_B trust=${s.peer("oracle_B").trust.toFixed(3)}`);
    console.log(`    same new claim weighted by trust → from A: ${s.claimWeight("oracle_A").toFixed(3)}, from B: ${s.claimWeight("oracle_B").toFixed(3)}`);
    console.log("  (a claim from the proven oracle moves the belief state far more than the same claim from the unreliable one.)");
  }

  banner("Scenario 3 — coordination protocol: low-band agent can't commit; quorum + human can");
  {
    const s = buildSociety();
    const transfer: Proposal = {
      id: "cosigned_transfer",
      proposer: "executor",
      action: "move savings to hardware wallet",
      irreversible: true,
      requiredBand: 2, // guardians or higher
      requiredQuorum: 2,
    };
    const aloneOk = s.evaluateProposal(transfer, [{ peer: "executor", accept: true }]);
    console.log(`    executor alone → ${aloneOk.decision} (${aloneOk.reason})`);
    const withQuorum = s.evaluateProposal(transfer, [
      { peer: "executor", accept: true }, // band 1 — does not qualify
      { peer: "guardian_1", accept: true },
      { peer: "guardian_2", accept: true },
      { peer: "owner", accept: true }, // the human approver
    ]);
    console.log(`    guardians + human → ${withQuorum.decision} (${withQuorum.reason})`);
    console.log("  (no committee of low-band agents can authorize an irreversible action — the passkey floor, socially.)");
  }

  banner("Scenario 4 — conflict resolution & deception detection");
  {
    const s = buildSociety();
    s.recordOutcome("guardian_1", true, true); // give guardian_1 a track record
    const claimA: Claim = { peer: "oracle_A", predicate: "recipientSafe", value: true };
    const claimB: Claim = { peer: "guardian_1", predicate: "recipientSafe", value: false };
    const r = s.resolveConflict(claimA, claimB);
    console.log(`    '${claimA.peer}'(band ${s.peer(claimA.peer).authorityBand}) vs '${claimB.peer}'(band ${s.peer(claimB.peer).authorityBand}) on 'recipientSafe'`);
    console.log(`    → winner: ${r.winner ? `'${r.winner.peer}' says ${r.winner.value}` : "ESCALATE"} (by ${r.by})`);

    // guardian_2 says it believes the recipient is safe, but acts to block the transfer.
    const before = s.peer("guardian_2").trust;
    const d = s.detectDeception("guardian_2", { predicate: "recipientSafe", value: true }, { predicate: "recipientSafe", value: false });
    console.log(`    guardian_2 word/deed mismatch: deceptive=${d.deceptive}  trust ${before.toFixed(2)} → ${d.trust.toFixed(2)} — flagged & escalated`);
  }

  console.log("\nDone. The agent reasoned inside a society of minds: it caught a peer on a stale belief,");
  console.log("re-weighted claims by earned trust, refused an irreversible action without a human and a");
  console.log("quorum, resolved a contradiction by rank, and flagged a peer whose deeds betrayed its words.\n");
}

if (process.argv.includes("--demo")) {
  demo();
}

export { Society, ALPHA, BETA, DECEPTION_PENALTY };
export type { Peer, AgentKind, Claim, Proposal, Vote, Decision };
