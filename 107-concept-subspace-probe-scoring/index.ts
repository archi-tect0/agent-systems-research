// Guide 107 — Concept Subspace Probe and Cross-Model Agreement Scoring
//
// A standalone implementation of the concept-subspace-probe pipeline (PCA + Ridge)
// and the Cross-Model Agreement Score (Eq.13) for compact-state transfer decisions.

// ── Numeric helpers ───────────────────────────────────────────────────────────

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(v: number[]): number {
  return Math.sqrt(dot(v, v));
}

function normalize(v: number[]): number {
  const n = norm(v);
  if (n < 1e-12) return 0; // return magnitude for tracking
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return n;
}

function meanCol(matrix: number[][]): number[] {
  const D = matrix[0].length;
  const mean = new Array<number>(D).fill(0);
  for (const row of matrix) for (let j = 0; j < D; j++) mean[j] += row[j];
  const N = matrix.length;
  return mean.map((x) => x / N);
}

function center(matrix: number[][], mean: number[]): number[][] {
  return matrix.map((row) => row.map((x, j) => x - mean[j]));
}

// ── Power-iteration PCA ───────────────────────────────────────────────────────
// Extracts top-k principal components using pure-JS power iteration.

async function svdPCA(matrix: number[][], k: number, iters = 80): Promise<number[][]> {
  const N = matrix.length;
  const D = matrix[0].length;
  const components: number[][] = [];
  let deflated = matrix.map((row) => [...row]);

  for (let comp = 0; comp < k; comp++) {
    let v = Array.from({ length: D }, () => Math.random() - 0.5);
    normalize(v);

    for (let iter = 0; iter < iters; iter++) {
      const Xv = deflated.map((row) => dot(row, v));
      const XtXv = new Array<number>(D).fill(0);
      for (let i = 0; i < N; i++) {
        const coef = Xv[i];
        for (let j = 0; j < D; j++) XtXv[j] += deflated[i][j] * coef;
      }
      normalize(XtXv);
      v = XtXv;
    }

    components.push(v);

    // Deflate
    for (let i = 0; i < N; i++) {
      const proj = dot(deflated[i], v);
      for (let j = 0; j < D; j++) deflated[i][j] -= proj * v[j];
    }
  }

  return components;
}

// ── Ridge Regression ─────────────────────────────────────────────────────────
// Solves (ZᵀZ + λI) w = Zᵀy using Gaussian elimination.

function ridgeRegression(Z: number[][], y: number[], lambda = 1e-4): number[] {
  const k = Z[0].length;
  const N = Z.length;

  const gram = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < N; i++) {
    for (let a = 0; a < k; a++) {
      for (let b = 0; b <= a; b++) {
        const v = Z[i][a] * Z[i][b];
        gram[a][b] += v;
        if (a !== b) gram[b][a] += v;
      }
    }
  }
  for (let a = 0; a < k; a++) gram[a][a] += lambda;

  const rhs = new Array<number>(k).fill(0);
  for (let i = 0; i < N; i++) {
    for (let a = 0; a < k; a++) rhs[a] += Z[i][a] * y[i];
  }

  const aug = gram.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < k; col++) {
    let maxRow = col;
    for (let row = col + 1; row < k; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-14) continue;
    for (let row = 0; row < k; row++) {
      if (row === col) continue;
      const factor = aug[row][col] / pivot;
      for (let c = col; c <= k; c++) aug[row][c] -= factor * aug[col][c];
    }
    for (let c = col; c <= k; c++) aug[col][c] /= pivot;
  }
  return aug.map((row) => row[k]);
}

// ── Cross-Model Agreement Score (Eq.13) ───────────────────────────────────────

interface ModelSignalState {
  omega: number;
  tauD: number;
  phase: number;
}

const OMEGA_REF = 0.50;
const TAU_REF = 5.00;

function computeAgreementScore(
  server: ModelSignalState,
  local: ModelSignalState,
): number {
  const omegaDiff = Math.abs(server.omega - local.omega);
  const tauDiff = Math.abs(server.tauD - local.tauD);
  const phaseDiff = server.phase - local.phase;

  return Math.exp(-omegaDiff / OMEGA_REF) *
         Math.exp(-tauDiff / TAU_REF) *
         Math.cos(phaseDiff);
}

// ── Demo ─────────────────────────────────────────────────────────────────────

async function runDemo() {
  console.log("--- Concept Subspace Probe Demo ---");

  // 1. Simulate embedding data (N=10 samples, D=16 dims)
  // Positives (samples that match the concept) vs Negatives
  const D = 16;
  const positives = Array.from({ length: 6 }, () => 
    Array.from({ length: D }, (_, i) => (i < 4 ? 1 : 0) + Math.random() * 0.1)
  );
  const negatives = Array.from({ length: 4 }, () => 
    Array.from({ length: D }, (_, i) => (i < 4 ? -1 : 0) + Math.random() * 0.1)
  );
  
  const allEmbs = [...positives, ...negatives];
  const labels = [...positives.map(() => 1), ...negatives.map(() => -1)];

  // 2. Locate concept subspace
  const mean = meanCol(allEmbs);
  const centrd = center(allEmbs, mean);
  const components = await svdPCA(centrd, 4);
  const Z = allEmbs.map(emb => components.map(comp => dot(emb, comp)));
  const w = ridgeRegression(Z, labels);

  // 3. Compute Bias Vector (Direction in embedding space)
  const biasVector = new Array<number>(D).fill(0);
  for (let comp = 0; comp < components.length; comp++) {
    for (let j = 0; j < D; j++) biasVector[j] += w[comp] * components[comp][j];
  }
  normalize(biasVector);

  console.log("Subspace located. Bias vector magnitude normalized.");

  // 4. Verification: Check if bias vector aligns with positives
  let posScore = 0;
  for (const p of positives) posScore += dot(p, biasVector);
  posScore /= positives.length;

  let negScore = 0;
  for (const n of negatives) negScore += dot(n, biasVector);
  negScore /= negatives.length;

  console.log(`Average Positive Alignment: ${posScore.toFixed(3)}`);
  console.log(`Average Negative Alignment: ${negScore.toFixed(3)}`);

  if (posScore <= negScore) throw new Error("Bias vector failed to separate classes!");

  console.log("\n--- Cross-Model Agreement Score (Eq.13) Demo ---");

  const server: ModelSignalState = { omega: 0.12, tauD: 12.0, phase: 0.5 };
  const localMatched: ModelSignalState = { omega: 0.125, tauD: 11.5, phase: 0.52 };
  const localOut: ModelSignalState = { omega: 0.90, tauD: 2.0, phase: 3.14 };

  const kresHigh = computeAgreementScore(server, localMatched);
  const kresLow = computeAgreementScore(server, localOut);

  console.log(`Matched Agreement (Kres): ${kresHigh.toFixed(4)}`);
  console.log(`Out-of-Sync Agreement (Kres): ${kresLow.toFixed(4)}`);

  if (kresHigh < 0.8) throw new Error("Expected high Kres for matched signals");
  if (kresLow > 0.2) throw new Error("Expected low Kres for out-of-sync signals");

  console.log("\n[assertions] PCA convergence + Ridge separation + Eq.13 agreement score: PASS");
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

if (process.argv.includes("--demo")) {
  runDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
