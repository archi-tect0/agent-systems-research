/**
 * Time-of-Flight Proximity Payment Broker (relay-resistant "tap to pay")
 *
 * Server-side session machine that defeats relay (wormhole) attacks on
 * short-range radio payments (Web Bluetooth GATT / Web NFC). Short range does
 * NOT imply proximity once an Internet relay is in the loop; the only reliable
 * defence is round-trip-time distance bounding.
 *
 * Trust model:
 *   - The SERVER issues a fresh nonce and stamps issue + answer times. Clients
 *     never self-report timing — they only prove they saw the live nonce and
 *     could answer quickly: answer = sha256(nonce ‖ wallet).
 *   - If RTT > threshold (default 50 ms) or the answer is wrong, the session is
 *     burned to a terminal `relay_rejected` state (fail-closed).
 *   - Both parties are timed independently; settlement requires BOTH passed.
 *
 * The browser radio transports (BLE GATT characteristic read/write, NFC NDEF)
 * are intentionally NOT modelled here: they are dumb byte-movers that exchange
 * sessionIds + nonces and carry no security logic. All decisions are server-side.
 *
 * Dependencies: Node.js built-in "crypto" only.
 */

import crypto from "crypto";

// ── Helper exported for callers to compute the expected answer ────────────────
export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// ── Types ────────────────────────────────────────────────────────────────────

export type SessionStatus =
  | "initiated"
  | "joined"
  | "relay_rejected"
  | "settled";

interface PartyToF {
  nonce: string;
  issuedAt: number;       // monotonic ms when the nonce was issued
  passed: boolean;
  rttMs: number | null;
}

interface Session {
  id: string;
  status: SessionStatus;
  initiatorWallet: string;
  responderWallet: string | null;
  initiator: PartyToF;
  responder: PartyToF | null;
  expiresAt: number;
}

export interface TofConfig {
  maxRttMs?: number;      // relay-attack threshold (default 50 ms)
  ttlMs?: number;         // session lifetime (default 5 min)
}

// ── Broker ───────────────────────────────────────────────────────────────────

export class TofBroker {
  private readonly maxRttMs: number;
  private readonly ttlMs: number;
  private readonly sessions = new Map<string, Session>();

  constructor(cfg: TofConfig = {}) {
    this.maxRttMs = cfg.maxRttMs ?? 50;
    this.ttlMs    = cfg.ttlMs    ?? 5 * 60 * 1000;
  }

  /** Monotonic time source — never wall-clock (which can jump backwards). */
  private now(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }

  private freshNonce(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  /** Initiator opens a session; server issues + stamps the initiator nonce. */
  init(initiatorWallet: string): { sessionId: string; nonce: string } {
    const id    = crypto.randomUUID();
    const nonce = this.freshNonce();
    const t     = this.now();
    this.sessions.set(id, {
      id,
      status: "initiated",
      initiatorWallet,
      responderWallet: null,
      initiator: { nonce, issuedAt: t, passed: false, rttMs: null },
      responder: null,
      expiresAt: t + this.ttlMs,
    });
    return { sessionId: id, nonce };
  }

  /** Responder joins; server issues + stamps a SEPARATE responder nonce. */
  join(sessionId: string, responderWallet: string): { nonce: string } {
    const s = this.get(sessionId);
    if (s.status !== "initiated") throw new Error(`session_not_joinable:${s.status}`);
    if (s.initiatorWallet === responderWallet) throw new Error("cannot_join_own_session");

    const nonce = this.freshNonce();
    s.responderWallet = responderWallet;
    s.responder = { nonce, issuedAt: this.now(), passed: false, rttMs: null };
    s.status = "joined";
    return { nonce };
  }

  /**
   * A party answers its OWN live nonce. The server times the round trip and
   * verifies the answer. Wrong answer or over-threshold RTT burns the session.
   */
  answer(sessionId: string, wallet: string, tofAnswer: string): { rttMs: number; passed: true } {
    const s = this.get(sessionId);

    let party: PartyToF;
    if (wallet === s.initiatorWallet)         party = s.initiator;
    else if (wallet === s.responderWallet && s.responder) party = s.responder;
    else throw new Error("not_a_participant");

    const expected = sha256(party.nonce + wallet);
    if (tofAnswer !== expected) {
      s.status = "relay_rejected";
      throw new Error("tof_answer_invalid");
    }

    const rttMs = this.now() - party.issuedAt;
    if (rttMs > this.maxRttMs) {
      party.rttMs = rttMs;
      s.status = "relay_rejected";
      throw new Error(`relay_attack_detected:rtt=${rttMs}ms`);
    }

    party.rttMs = rttMs;
    party.passed = true;
    return { rttMs, passed: true };
  }

  /**
   * Settle the payment. Succeeds only if BOTH parties independently passed
   * their ToF check under the threshold. Otherwise the relay defence trips.
   */
  confirm(sessionId: string): SessionStatus {
    const s = this.get(sessionId);
    if (s.status === "relay_rejected") throw new Error("relay_defense_required");
    const bothPassed = s.initiator.passed && !!s.responder?.passed;
    if (!bothPassed) throw new Error("relay_defense_required");
    s.status = "settled";
    return s.status;
  }

  /** Read-only view of a session (timing + state). */
  inspect(sessionId: string): Readonly<Session> {
    return this.get(sessionId);
  }

  private get(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("session_not_found");
    if (this.now() > s.expiresAt) {
      this.sessions.delete(sessionId);
      throw new Error("session_expired");
    }
    return s;
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--demo") {
  const broker = new TofBroker({ maxRttMs: 50 });

  // ── Honest same-room flow ────────────────────────────────────────────────
  const { sessionId, nonce: nonceI } = broker.init("wallet-A");
  const { nonce: nonceR }            = broker.join(sessionId, "wallet-B");

  const aOk = broker.answer(sessionId, "wallet-A", sha256(nonceI + "wallet-A"));
  const bOk = broker.answer(sessionId, "wallet-B", sha256(nonceR + "wallet-B"));
  console.log("Honest RTTs:", aOk.rttMs, "ms /", bOk.rttMs, "ms");
  console.log("Settlement:", broker.confirm(sessionId));

  // ── Relayed flow: a wrong answer (relay forwarded a stale/foreign nonce) ──
  const relay = new TofBroker({ maxRttMs: 50 });
  const s2 = relay.init("wallet-A");
  relay.join(s2.sessionId, "wallet-B");
  try {
    relay.answer(s2.sessionId, "wallet-A", sha256("attacker-supplied-nonce" + "wallet-A"));
  } catch (e) {
    console.log("\nRelay rejected at answer:", (e as Error).message);
  }
  try {
    relay.confirm(s2.sessionId);
  } catch (e) {
    console.log("Confirm blocked:", (e as Error).message);
  }
}
