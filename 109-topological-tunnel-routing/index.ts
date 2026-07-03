// Guide 109 — Topological Tunneling Gain via Memory Graph Analysis
//
// Explains the multi-hop routing/masking mechanism (topological tunneling)
// used to bridge memory clusters, based on Betti numbers (β₀, β₁).
// This reference implementation simulates the memory graph and computes
// the tunneling gain and channel capacity coupling.

/**
 * THB Eq.4: Topological Tunneling Gain
 * G_topo = exp(−β₁ / (β₀ + 1))
 *
 * κ_topo = 1 + (β₀ − 1) × CLUSTER_BONUS − β₁ × LOOP_PENALTY
 */

const CLUSTER_BONUS = 0.05;
const LOOP_PENALTY = 0.08;

interface TopologicalState {
  beta0: number;
  beta1: number;
  tunnelGain: number;
  kappaTopological: number;
}

/**
 * Eq.4: G_topo = exp(−β₁ / (β₀ + 1))
 */
function computeTunnelGain(beta0: number, beta1: number): number {
  const b0 = Math.max(1, beta0);
  const b1 = Math.max(0, beta1);
  return Math.exp(-b1 / (b0 + 1));
}

/**
 * κ_topo for channel capacity (Eq.1 coupling factor).
 */
function computeKappaTopological(beta0: number, beta1: number): number {
  const b0 = Math.max(1, beta0);
  const b1 = Math.max(0, beta1);
  const raw = 1.0 + (b0 - 1) * CLUSTER_BONUS - b1 * LOOP_PENALTY;
  return Math.max(0.1, raw); // clamp: never negative
}

// ── Simulator ────────────────────────────────────────────────────────────────

interface MemoryNode {
  id: string;
  clusterId: string;
}

class MemoryGraphSimulator {
  nodes: MemoryNode[] = [];

  addNode(id: string, clusterId: string) {
    this.nodes.push({ id, clusterId });
  }

  /**
   * Proxied Betti number calculation matching the production implementation.
   * β₀ = count of distinct clusters.
   * β₁ = count of "sparse" clusters (members < 3) — a proxy for topological holes.
   */
  computeTopology(): { beta0: number; beta1: number } {
    const clusterCounts = new Map<string, number>();
    for (const node of this.nodes) {
      clusterCounts.set(node.clusterId, (clusterCounts.get(node.clusterId) || 0) + 1);
    }

    const beta0 = clusterCounts.size;
    let beta1 = 0;
    for (const count of clusterCounts.values()) {
      if (count < 3) {
        beta1++;
      }
    }

    return { beta0, beta1 };
  }

  getState(): TopologicalState {
    const { beta0, beta1 } = this.computeTopology();
    return {
      beta0,
      beta1,
      tunnelGain: computeTunnelGain(beta0, beta1),
      kappaTopological: computeKappaTopological(beta0, beta1),
    };
  }
}

// ── Demo ─────────────────────────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

if (process.argv.includes("--demo")) {
  console.log("Guide 109 — Topological Tunneling Demo\n");

  // Scenario 1: Healthy, well-populated clusters
  const sim1 = new MemoryGraphSimulator();
  sim1.addNode("n1", "c1"); sim1.addNode("n2", "c1"); sim1.addNode("n3", "c1");
  sim1.addNode("n4", "c2"); sim1.addNode("n5", "c2"); sim1.addNode("n6", "c2");

  const state1 = sim1.getState();
  console.log("[Scenario 1: Healthy Clusters]");
  console.log(`  β₀=${state1.beta0}, β₁=${state1.beta1}`);
  console.log(`  G_topo=${state1.tunnelGain.toFixed(3)} (Gain)`);
  console.log(`  κ_topo=${state1.kappaTopological.toFixed(3)} (Capacity Coupling)`);

  assert(state1.beta0 === 2, "Should have 2 clusters");
  assert(state1.beta1 === 0, "Should have 0 sparse clusters (holes)");
  assert(state1.tunnelGain === 1.0, "Gain should be max when β₁=0");
  assert(state1.kappaTopological > 1.0, "Capacity should be boosted by extra clusters");

  // Scenario 2: Fragmented clusters (simulated loops/holes)
  const sim2 = new MemoryGraphSimulator();
  sim2.addNode("n1", "c1"); sim2.addNode("n2", "c1"); sim2.addNode("n3", "c1"); // healthy
  sim2.addNode("n4", "c2"); // sparse cluster -> β₁ proxy
  sim2.addNode("n5", "c3"); // sparse cluster -> β₁ proxy

  const state2 = sim2.getState();
  console.log("\n[Scenario 2: Fragmented Clusters]");
  console.log(`  β₀=${state2.beta0}, β₁=${state2.beta1}`);
  console.log(`  G_topo=${state2.tunnelGain.toFixed(3)} (Gain suppressed)`);
  console.log(`  κ_topo=${state2.kappaTopological.toFixed(3)} (Capacity penalized)`);

  assert(state2.beta0 === 3, "Should have 3 clusters");
  assert(state2.beta1 === 2, "Should have 2 sparse clusters");
  assert(state2.tunnelGain < 1.0, "Gain should be suppressed by β₁");
  assert(state2.kappaTopological < state1.kappaTopological, "Capacity should be lower than Scenario 1");

  // Scenario 3: Extreme fragmentation
  const sim3 = new MemoryGraphSimulator();
  for (let i = 0; i < 10; i++) {
    sim3.addNode(`n${i}`, `c${i}`); // 1 node per cluster
  }
  const state3 = sim3.getState();
  console.log("\n[Scenario 3: Extreme Fragmentation]");
  console.log(`  β₀=${state3.beta0}, β₁=${state3.beta1}`);
  console.log(`  G_topo=${state3.tunnelGain.toFixed(3)}`);
  console.log(`  κ_topo=${state3.kappaTopological.toFixed(3)}`);

  assert(state3.beta1 === 10, "All clusters are sparse");
  assert(state3.tunnelGain < 0.5, "Gain should be significantly suppressed");

  console.log("\n[property checks] Betti-proxy calculation + tunneling gain + capacity coupling: PASS");
}
