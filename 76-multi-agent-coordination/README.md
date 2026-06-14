# Multi-Agent Coordination & Social Reasoning

*Reasoning in a society of minds — modeling what other agents and humans believe, earning and spending trust by outcome, agreeing on a shared plan only when authority and quorum are met, resolving contradictory claims by rank rather than by guess, and catching a peer whose actions betray its words.*

The whole research set so far has built a single agent that reasons about the world ([guide 75](../75-world-model-belief-state/)) and about itself (the Layer-2 set) over time ([guide 74](../74-multi-turn-deliberation/)). But Kylum never acts alone: it shares custody with guardians ([guide 29](../29-quorum-vault-groups/)), delegates work to other agents over the A2A marketplace ([guide 28](../28-a2a-marketplace/)), and answers to a human who holds the passkey floor. This guide is the social layer — what the agent needs to reason *with* and *about* other minds.

This is the third guide in the Layer-3 set, and the one that closes the triad: deliberation is *time*, the belief state is *space*, and coordination is *society*. An agent that models the world but not the agents in it will confidently act on a plan everyone else has already abandoned.

## Problem

An agent that treats every other party as either an oracle to obey or noise to ignore fails socially in four ways:

1. **Solipsism — no model of other minds.** The agent assumes every peer shares its view of the world. When a delegated agent is still acting on a stale belief (the network is up; the recipient is safe), nothing surfaces that the two have diverged, so they work at cross purposes.
2. **No calibrated trust.** A peer that has been right ten times and a peer that has been wrong ten times move the agent's beliefs equally. Without trust earned by outcome, the agent is equally credulous toward a reliable guardian and a compromised one.
3. **No coordination protocol.** A multi-party action — a quorum recovery, a co-signed transfer — has no notion of *propose → vote → commit*. The agent either acts unilaterally or stalls, with no rule for when enough of the right parties have agreed.
4. **No conflict resolution or governance.** When two peers assert contradictory facts, the agent has no principled way to choose. And without social governance, a single low-authority agent can drive an irreversible action that should require a human and a quorum.

This guide builds a society model: peers (agents, tools, and humans) carrying an authority band and an outcome-earned trust; a theory-of-mind store of what the agent believes each peer believes; a deterministic trust update that re-weights peers' claims; a coordination protocol that commits only on authority + quorum; conflict resolution by rank; and deception detection when a peer's action contradicts its stated belief.

## Design decisions

**Every party is a peer with an authority band and a trust score — humans, agents, and tools alike.** Modeling humans in the same structure as agents is deliberate: the human who holds the passkey is the highest-authority peer, not an exception outside the model. This is how the passkey floor and the authority bands ([guide 37](../37-agent-authority-bands/)) generalize from "the agent vs. the user" to "a society of cooperating minds."

**Theory-of-mind is a belief about a belief, and divergence is a first-class signal.** For each peer the agent keeps `beliefsAbout` — *what I think they think*. When the agent's own world-belief differs from what it models a peer believing, that's a *coordination gap*: a concrete, queryable reason to re-sync before acting, not a surprise discovered after the two collide.

**Trust is earned by outcome and spent as evidence weight.** When a peer's claim later proves true, its trust rises; when it proves false, trust falls — a deterministic update, no randomness. Crucially, trust is not decorative: it becomes the `weight` a peer's claim carries when it feeds the belief state ([guide 75](../75-world-model-belief-state/)). A claim from a trusted guardian moves a belief far more than the same claim from an untested one.

**Coordination commits only on authority *and* quorum, and irreversibility demands a human.** A proposal counts a vote only if the voter's authority band clears the bar, commits only when enough qualifying votes are in, and — for an irreversible action — refuses to commit without at least one human-band approver, escalating instead. This is the architectural passkey-floor constant expressed socially: no committee of low-band agents can authorize what only a human should.

**Conflict is resolved by rank, never by silent guess.** Contradictory claims are decided by authority band first, then by trust, and if those tie, the agent *escalates* rather than picking arbitrarily. The resolution order is explicit and auditable, and a genuine deadlock surfaces to a human instead of being resolved by coin-flip.

**Deception is an action that betrays a stated belief.** When a peer says it believes one thing but acts as if it believes the opposite, the agent flags it, drops its trust hard, and escalates. Words are cheap; the model trusts the *consistency of word and deed*, which is what makes a compromised or misaligned peer detectable.

**Deterministic by construction.** A logical clock, fixed trust-update constants, and no wall-time or randomness — the same interactions in the same order always produce the same trust scores and decisions. Read it for the mechanism, not as a production consensus engine.

## Algorithm

```
modelBelief(peer, predicate, value):              # theory-of-mind update
  peer.beliefsAbout[predicate] = value

coordinationGaps():
  for peer, for predicate in peer.beliefsAbout:
    if myBeliefs[predicate] != peer.beliefsAbout[predicate]:
      gap(peer, predicate, mine, theirs)

recordOutcome(peer, claimed, actual):             # trust earned by outcome
  if claimed == actual: peer.trust += (1 - peer.trust) * ALPHA
  else:                 peer.trust -= peer.trust * BETA

evaluateProposal(p, votes):                        # coordination + governance
  qualifying = votes where accept and peer.band >= p.requiredBand
  hasHuman   = any qualifying voter is a human
  if p.irreversible and not hasHuman: return ESCALATE      # human required
  if count(qualifying) >= p.requiredQuorum:        return COMMIT
  return REJECT

resolveConflict(claimA, claimB):                   # by rank, then escalate
  if band differs:  winner = higher band
  elif trust differs: winner = higher trust
  else:               ESCALATE

detectDeception(peer, statedBelief, observedAction):
  if statedBelief.value != observedAction.value:
    drop peer.trust; flag; ESCALATE
```

## Reference implementation

[`multi-agent-coordination.ts`](./multi-agent-coordination.ts) — a standalone, dependency-free `Society`. Peers (agents, tools, humans) carry an authority band and a trust score, the agent keeps a theory-of-mind store per peer, and trust updates and decisions are pure arithmetic on a logical clock. Run it:

```bash
# Node 24+ runs it directly (native TS type-strip):
node multi-agent-coordination.ts --demo

# or with tsx:
npx tsx multi-agent-coordination.ts --demo
```

The demo puts Kylum in a small society — a co-signing agent, two oracles, two guardians, and a human — and exercises four scenarios:

1. **Theory of mind** — the agent's world-belief (the network has degraded) diverges from what it models a delegated executor still believing, and the coordination gap is surfaced so the two can re-sync before acting.
2. **Trust by outcome** — one oracle's claims keep proving true and another's keep proving false; their trust scores move apart, and the same new claim from each then carries very different weight into the belief state.
3. **Coordination protocol** — a low-band agent alone cannot commit an irreversible co-signed transfer (escalates for a human); the same proposal commits once a guardian quorum *and* the human approve.
4. **Conflict resolution & deception** — two peers assert contradictory facts and the agent resolves by authority then trust; then a guardian whose action contradicts its stated belief is flagged, loses trust, and is escalated.

## How this maps to the production system

| Society concept | Production mechanism |
|-----------------|----------------------|
| peers (agent / tool / human) | the A2A marketplace's other agents ([guide 28](../28-a2a-marketplace/)) and the human at the passkey floor |
| `authorityBand` | agent authority bands ([guide 37](../37-agent-authority-bands/)) |
| theory-of-mind `beliefsAbout` | the relational-intelligence model of counterparties ([guide 31](../31-relational-intelligence-model/)) |
| trust as evidence weight | the `weight` fed into the belief state ([guide 75](../75-world-model-belief-state/)) and uncertainty engine ([guide 68](../68-calibrated-uncertainty-engine/)) |
| propose → vote → commit | quorum vault groups for shared custody ([guide 29](../29-quorum-vault-groups/)) |
| irreversible needs a human | the batched approval ceremony / passkey floor ([guide 49](../49-batched-approval-ceremony/)) |
| conflict resolution + escalation | the incident playbook engine's adjudication ([guide 44](../44-incident-playbook-engine/)) |
| deception detection | the autonomous threat-response surface ([guide 22](../22-autonomous-threat-response/)) |

## Limitations and extensions

- **Trust is one global scalar per peer.** A guardian may be reliable about device health and useless about market prices. Make trust *topical* — a vector keyed by domain — so a peer's weight depends on what it's claiming.
- **Theory-of-mind is shallow (one level).** The model tracks what a peer believes, not what a peer believes *the agent* believes. Recursive ToM matters for negotiation and bluff; add depth only where the interaction actually requires it.
- **Voting assumes honest, independent votes.** Collusion among low-band agents to manufacture a quorum is not modeled. Weight quorum by authority *and* independence, and require diversity (e.g., distinct guardians, not one guardian's sock-puppets).
- **Conflict resolution is pairwise and static.** Three-way disagreements and shifting coalitions need a proper voting/aggregation rule (Condorcet, weighted median) rather than band-then-trust.
- **Deception detection is single-shot.** One word–deed mismatch flags a peer; a sophisticated adversary stays consistent until it matters. Track a *history* of consistency and compose with the threat-response surface ([guide 22](../22-autonomous-threat-response/)) for a graded response instead of a binary flag.
