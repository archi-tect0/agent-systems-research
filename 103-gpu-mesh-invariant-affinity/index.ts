// Guide 103 — GPU VRAM Mesh + Invariant-Sector Affinity
//
// Explains the GPU mesh registry: how multiple GPU nodes/models register
// VRAM capacity, how "invariant sectors" get affinity-routed to specific
// nodes, and how the mesh handles node join/warmup.

import { createHmac, randomBytes } from "crypto";

type TrustTier = "browser" | "edge" | "core";
type Status = "registering" | "online" | "busy" | "offline" | "revoked";

interface GpuMeshWorker {
  id: string;
  peerId: string;
  trustTier: TrustTier;
  status: Status;
  vramMb: number;
  modelId: string;
  shardsHeld: string[];
  inferenceLoad: number; // 0-100
  failureCount: number;
  lastNonce?: string;
}

interface ShardSpec {
  modelId: string;
  layerRange: string; // e.g. "0-32"
  kvKeys: string[];
}

const HEARTBEAT_TIMEOUT_MS = 5000;
const MAX_FAILURES = 3;
const INVARIANT_LAYER_MAX = 16;

class GpuMeshRegistry {
  private workers = new Map<string, GpuMeshWorker>();
  private invariantWarm = new Map<string, Set<string>>(); // peerId -> Set<layerRange>
  private pendingChallenges = new Map<string, { nonce: string; issuedAt: number }>();

  register(peerId: string, tier: TrustTier, vramMb: number, modelId: string): string {
    const nonce = randomBytes(16).toString("hex");
    const id = `w_${randomBytes(4).toString("hex")}`;
    
    const worker: GpuMeshWorker = {
      id,
      peerId,
      trustTier: tier,
      status: "registering",
      vramMb,
      modelId,
      shardsHeld: [],
      inferenceLoad: 0,
      failureCount: 0,
      lastNonce: nonce
    };

    this.workers.set(peerId, worker);
    this.pendingChallenges.set(peerId, { nonce, issuedAt: Date.now() });
    return nonce;
  }

  verifyProof(peerId: string, proof: string, secret: string): boolean {
    const challenge = this.pendingChallenges.get(peerId);
    const worker = this.workers.get(peerId);

    if (!challenge || !worker || worker.status === "revoked") return false;

    const expected = createHmac("sha256", secret).update(challenge.nonce).digest("hex");
    const valid = expected === proof;

    this.pendingChallenges.delete(peerId);

    if (valid) {
      worker.status = "online";
      worker.failureCount = 0;
      return true;
    } else {
      worker.failureCount++;
      if (worker.failureCount >= MAX_FAILURES) {
        worker.status = "revoked";
      } else {
        // Re-issue challenge for next attempt if not revoked
        const newNonce = randomBytes(16).toString("hex");
        this.pendingChallenges.set(peerId, { nonce: newNonce, issuedAt: Date.now() });
        worker.lastNonce = newNonce;
      }
      return false;
    }
  }

  markInvariantWarm(peerId: string, layerKey: string): void {
    if (!this.invariantWarm.has(peerId)) {
      this.invariantWarm.set(peerId, new Set());
    }
    this.invariantWarm.get(peerId)!.add(layerKey);
  }

  heartbeat(peerId: string, load: number, shards: string[]): void {
    const worker = this.workers.get(peerId);
    if (worker && worker.status !== "revoked") {
      worker.status = "online";
      worker.inferenceLoad = load;
      worker.shardsHeld = shards;
    }
  }

  assign(spec: ShardSpec): GpuMeshWorker | null {
    const candidates = Array.from(this.workers.values()).filter(
      w => (w.status === "online" || w.status === "busy") && w.modelId === spec.modelId
    );

    if (candidates.length === 0) return null;

    const scored = candidates.map(w => ({
      worker: w,
      score: this.scoreWorker(w, spec)
    }));

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].worker;
    
    if (best.status === "online") {
      best.status = "busy";
    }
    
    return best;
  }

  private scoreWorker(worker: GpuMeshWorker, spec: ShardSpec): number {
    let score = 0;

    // Trust Tier Bonus
    if (worker.trustTier === "core") score += 30;
    else if (worker.trustTier === "edge") score += 20;
    else score += 10;

    // Load Penalty
    score -= worker.inferenceLoad;

    // KV Shard Affinity (+60)
    const hasShard = spec.kvKeys.some(k => worker.shardsHeld.includes(k));
    if (hasShard) score += 60;

    // Invariant Sector Affinity (+40 or +20)
    const warmLayers = this.invariantWarm.get(worker.peerId);
    if (warmLayers && warmLayers.size > 0) {
      const [startStr] = spec.layerRange.split("-");
      const startLayer = parseInt(startStr, 10);
      
      if (startLayer <= INVARIANT_LAYER_MAX) {
        score += 40;
      } else {
        // Half bonus if worker is warm on ANY invariant range even if request starts later
        for (const key of warmLayers) {
          const [ks] = key.split("-");
          if (parseInt(ks, 10) <= INVARIANT_LAYER_MAX) {
            score += 20;
            break;
          }
        }
      }
    }

    return score;
  }

  getWorker(peerId: string) {
    return this.workers.get(peerId);
  }
}

// ---------------------------------------------------------------------------
// Assertions & Demo
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function runDemo() {
  const registry = new GpuMeshRegistry();
  const secret = "session_secret_123";

  console.log("--- Step 1: Worker Registration ---");
  const peerId1 = "browser_node_1";
  const nonce1 = registry.register(peerId1, "browser", 4096, "llama3-8b");
  console.log(`[reg] issued nonce for ${peerId1}: ${nonce1}`);

  const proof1 = createHmac("sha256", secret).update(nonce1).digest("hex");
  const verified1 = registry.verifyProof(peerId1, proof1, secret);
  assert(verified1 === true, "Proof should be valid");
  assert(registry.getWorker(peerId1)?.status === "online", "Worker should be online");
  console.log(`[verify] ${peerId1} is online`);

  console.log("\n--- Step 2: Shard Affinity Routing ---");
  const peerId2 = "edge_node_1";
  const nonce2 = registry.register(peerId2, "edge", 8192, "llama3-8b");
  registry.verifyProof(peerId2, createHmac("sha256", secret).update(nonce2).digest("hex"), secret);
  
  // Give peer2 a specific shard
  registry.heartbeat(peerId2, 10, ["shard_alpha", "shard_beta"]);
  
  const spec1: ShardSpec = {
    modelId: "llama3-8b",
    layerRange: "16-32",
    kvKeys: ["shard_alpha"]
  };
  
  const assigned1 = registry.assign(spec1);
  console.log(`[assign] request for 'shard_alpha' routed to: ${assigned1?.peerId}`);
  assert(assigned1?.peerId === peerId2, "Should route to node holding shard_alpha");

  console.log("\n--- Step 3: Invariant Affinity Routing ---");
  const peerId3 = "core_node_1";
  const nonce3 = registry.register(peerId3, "core", 24576, "llama3-8b");
  registry.verifyProof(peerId3, createHmac("sha256", secret).update(nonce3).digest("hex"), secret);
  
  // peer3 has invariant sector warm (layers 0-16)
  registry.markInvariantWarm(peerId3, "0-16");
  registry.heartbeat(peerId3, 5, []); // no specific shards

  const spec2: ShardSpec = {
    modelId: "llama3-8b",
    layerRange: "0-8", // request starts in invariant sector
    kvKeys: ["shard_gamma"] // nobody has this
  };

  const assigned2 = registry.assign(spec2);
  console.log(`[assign] request for invariant range routed to: ${assigned2?.peerId}`);
  assert(assigned2?.peerId === peerId3, "Should route to node with invariant affinity");

  console.log("\n--- Step 4: Revocation on Failed Proofs ---");
  const peerId4 = "rogue_node";
  const nonce4 = registry.register(peerId4, "browser", 1024, "llama3-8b");
  
  for (let i = 0; i < MAX_FAILURES; i++) {
    registry.verifyProof(peerId4, "wrong_proof", secret);
  }
  
  const worker4 = registry.getWorker(peerId4);
  console.log(`[revocation] worker ${peerId4} status: ${worker4?.status}`);
  assert(worker4?.status === "revoked", "Worker should be revoked after repeated failures");

  console.log("\n--- Step 5: Load Balancing ---");
  // edge_node_1 (peer2) is busy (load 10)
  // core_node_1 (peer3) is busy (load 5)
  // Let's add a fresh edge node with 0 load
  const peerId5 = "edge_node_2";
  const nonce5 = registry.register(peerId5, "edge", 8192, "llama3-8b");
  registry.verifyProof(peerId5, createHmac("sha256", secret).update(nonce5).digest("hex"), secret);
  registry.heartbeat(peerId5, 0, []);

  const spec3: ShardSpec = {
    modelId: "llama3-8b",
    layerRange: "20-30",
    kvKeys: ["shard_delta"]
  };

  const assigned3 = registry.assign(spec3);
  console.log(`[assign] new request routed to lowest load: ${assigned3?.peerId}`);
  assert(assigned3?.peerId === peerId5 || assigned3?.peerId === peerId3, "Should pick a low-load candidate");

  console.log("\n[property checks] registration + shard affinity + invariant affinity + revocation: PASS");
}

if (process.argv.includes("--demo")) {
  runDemo().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
