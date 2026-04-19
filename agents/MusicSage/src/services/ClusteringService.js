/**
 * ClusteringService
 *
 * Agrupa faixas por similaridade semântica usando:
 *   1. PCA para reduzir dimensões → 2D (para visualização)
 *   2. K-means 2D para agrupar (rápido, suficiente para visualização de mood)
 *
 * Toda a matemática é pura (sem dependências externas).
 *
 * Complexidade para 5000 faixas × 768 dimensões:
 *   - PCA (2 componentes, 40 iterações): ~2s
 *   - K-means 2D (k=8, 100 iterações):  ~2ms
 */

export class ClusteringService {
  /**
   * Paleta de cores para até 20 clusters.
   */
  static COLORS = [
    "#7c6af5", "#3ecf8e", "#f6ad55", "#63b3ed", "#f56565",
    "#b794f4", "#68d391", "#fbd38d", "#90cdf4", "#fc8181",
    "#d6bcfa", "#9ae6b4", "#fefcbf", "#bee3f8", "#fed7d7",
    "#805ad5", "#276749", "#975a16", "#2c5282", "#9b2335",
  ];

  /**
   * Processa embeddings → clusters com coordenadas 2D.
   *
   * @param {Record<string, import('./EmbeddingService.js').TrackEmbedding>} embeddings
   * @param {number} k — número de clusters (2–20)
   * @returns {{
   *   k: number,
   *   clusters: Array<{
   *     id:     number,
   *     color:  string,
   *     count:  number,
   *     tracks: Array<{ratingKey,title,artist,album,x,y,z}>
   *   }>
   * }}
   */
  cluster(embeddings, k = 8) {
    const ratingKeys = Object.keys(embeddings);
    if (ratingKeys.length < 2) {
      return { k, clusters: [] };
    }

    k = Math.min(k, ratingKeys.length);

    // 1. Extrai vetores como Float64Arrays
    const rawVectors = ratingKeys.map((key) => embeddings[key].embedding);

    // 2. L2-normaliza (vetores de norma 1 → cosine = euclidean)
    const normalized = rawVectors.map(this._normalizeL2.bind(this));

    // 3. Centra os dados (subtrai a média por dimensão)
    const mean    = this._meanVector(normalized);
    const centered = normalized.map((v) => v.map((x, i) => x - mean[i]));

    // 4. PCA: reduz para min(50, n/2, d) dimensões — preserva muito mais variância
    const PCA_DIMS = Math.min(50, Math.floor(ratingKeys.length / 2), rawVectors[0].length);
    const pcs = this._pcaNd(centered, PCA_DIMS, 40);

    // 5. Projeta para espaço PCA_DIMS (para clustering)
    const projectedNd = centered.map((v) => pcs.map((pc) => this._dot(v, pc)));

    // 6. K-means no espaço PCA_DIMS (melhor separação semântica por gênero)
    const { assignments } = this._kmeansNd(projectedNd, k);

    // Projeção 2D/3D para visualização (reutiliza os 3 primeiros PCs)
    const pc1 = pcs[0] ?? new Array(centered[0].length).fill(0);
    const pc2 = pcs[1] ?? new Array(centered[0].length).fill(0);
    const pc3 = pcs[2] ?? new Array(centered[0].length).fill(0);
    const projected = centered.map((v) => [this._dot(v, pc1), this._dot(v, pc2), this._dot(v, pc3)]);

    // 7. Normaliza coords para [0, 1] (more convenient para frontend)
    const xs  = projected.map((p) => p[0]);
    const ys  = projected.map((p) => p[1]);
    const zs  = projected.map((p) => p[2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const nx = (x) => maxX !== minX ? (x - minX) / (maxX - minX) : 0.5;
    const ny = (y) => maxY !== minY ? (y - minY) / (maxY - minY) : 0.5;
    const nz = (z) => maxZ !== minZ ? (z - minZ) / (maxZ - minZ) : 0.5;

    // 8. Monta resultado por cluster
    const clusters = Array.from({ length: k }, (_, i) => ({
      id:     i,
      color:  ClusteringService.COLORS[i % ClusteringService.COLORS.length],
      count:  0,
      tracks: [],
    }));

    ratingKeys.forEach((key, j) => {
      const cl  = assignments[j];
      const [px, py, pz] = projected[j];
      clusters[cl].tracks.push({
        ratingKey: key,
        title:     embeddings[key].title   || "",
        artist:    embeddings[key].artist  || "",
        album:     embeddings[key].album   || "",
        genres:    embeddings[key].genres  || [],
        x:         nx(px),
        y:         ny(py),
        z:         nz(pz),
      });
      clusters[cl].count++;
    });

    return { k, clusters };
  }

  /**
   * Agrupa faixas por similaridade de áudio usando os campos do analysis-cache.
   * Vetor por faixa: [energy, valence, danceability, acousticness, complexity, bpm] — normalizados.
   * Não requer embeddings vetoriais.
   *
   * @param {Array<{ratingKey,title,artist,analysis}>} entries — entradas do AnalysisCacheService
   * @param {number} k — número de clusters (2–20)
   * @returns {ReturnType<ClusteringService["cluster"]>}
   */
  clusterByAnalysis(entries, k = 8) {
    if (!entries?.length) return { k, clusters: [] };

    const valid = entries.filter((e) => e.analysis && typeof e.analysis.energy === "number");
    if (valid.length < 2) return { k, clusters: [] };

    k = Math.min(k, valid.length);

    // Vetor de características normalizadas por faixa
    const vectors = valid.map((e) => {
      const a = e.analysis;
      return [
        (a.energy       ?? 5) / 10,
        (a.valence      ?? 5) / 10,
        (a.danceability ?? 5) / 10,
        (a.acousticness ?? 5) / 10,
        (a.complexity   ?? 5) / 10,
        Math.min(a.bpm  ?? 120, 200) / 200,
      ];
    });

    // Centra os dados
    const mean    = this._meanVector(vectors);
    const centered = vectors.map((v) => v.map((x, i) => x - mean[i]));

    // PCA: até 6 dimensões (tamanho do vetor)
    const PCA_DIMS = Math.min(6, centered[0].length);
    const pcs = this._pcaNd(centered, PCA_DIMS, 40);

    // Projeta para espaço PCA_DIMS (para clustering)
    const projectedNd = centered.map((v) => pcs.map((pc) => this._dot(v, pc)));

    // K-means
    const { assignments } = this._kmeansNd(projectedNd, k);

    // Projeção 3D para visualização
    const pc1 = pcs[0] ?? new Array(centered[0].length).fill(0);
    const pc2 = pcs[1] ?? new Array(centered[0].length).fill(0);
    const pc3 = pcs[2] ?? new Array(centered[0].length).fill(0);
    const projected = centered.map((v) => [this._dot(v, pc1), this._dot(v, pc2), this._dot(v, pc3)]);

    // Normaliza coords para [0, 1]
    const xs = projected.map((p) => p[0]);
    const ys = projected.map((p) => p[1]);
    const zs = projected.map((p) => p[2]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const nx = (x) => maxX !== minX ? (x - minX) / (maxX - minX) : 0.5;
    const ny = (y) => maxY !== minY ? (y - minY) / (maxY - minY) : 0.5;
    const nz = (z) => maxZ !== minZ ? (z - minZ) / (maxZ - minZ) : 0.5;

    const clusters = Array.from({ length: k }, (_, i) => ({
      id:     i,
      color:  ClusteringService.COLORS[i % ClusteringService.COLORS.length],
      count:  0,
      tracks: [],
    }));

    valid.forEach((entry, j) => {
      const cl  = assignments[j];
      const [px, py, pz] = projected[j];
      const a   = entry.analysis;
      clusters[cl].tracks.push({
        ratingKey: entry.ratingKey,
        title:     entry.title   || "",
        artist:    entry.artist  || "",
        album:     entry.album   || "",
        genres:    a.genre ? [a.genre] : [],
        genre:     a.genre       || "",
        subgenre:  a.subgenre    || "",
        mood:      a.mood        || "",
        energy:    a.energy      ?? 0,
        valence:   a.valence     ?? 0,
        bpm:       a.bpm         ?? 0,
        x: nx(px),
        y: ny(py),
        z: nz(pz),
      });
      clusters[cl].count++;
    });

    return { k, clusters };
  }

  /**
   * Detecta automaticamente o k ideal para análise de áudio usando o Elbow Method.
   * Testa k em [kMin..kMax], computa inércia e escolhe o cotovelo da curva.
   *
   * @param {Array<{ratingKey,title,artist,analysis}>} entries — entradas do AnalysisCacheService
   * @param {number} kMin — k mínimo a testar (padrão 2)
   * @param {number} kMax — k máximo a testar (padrão 15)
   * @returns {ReturnType<ClusteringService["clusterByAnalysis"]>}
   */
  clusterByAnalysisAuto(entries, kMin = 2, kMax = 15) {
    const valid = (entries || []).filter((e) => e.analysis && typeof e.analysis.energy === "number");
    if (valid.length < 2) return { k: 1, clusters: [] };

    const cappedMax = Math.min(kMax, valid.length);
    const cappedMin = Math.min(kMin, cappedMax);
    if (cappedMin >= cappedMax) return this.clusterByAnalysis(entries, cappedMin);

    // Constrói vetores uma única vez
    const vectors = valid.map((e) => {
      const a = e.analysis;
      return [
        (a.energy       ?? 5) / 10,
        (a.valence      ?? 5) / 10,
        (a.danceability ?? 5) / 10,
        (a.acousticness ?? 5) / 10,
        (a.complexity   ?? 5) / 10,
        Math.min(a.bpm  ?? 120, 200) / 200,
      ];
    });

    const mean     = this._meanVector(vectors);
    const centered = vectors.map((v) => v.map((x, i) => x - mean[i]));
    const PCA_DIMS = Math.min(6, centered[0].length);
    const pcs      = this._pcaNd(centered, PCA_DIMS, 40);
    const projected = centered.map((v) => pcs.map((pc) => this._dot(v, pc)));

    // Calcula inércia para cada k candidato
    const kRange = [];
    for (let k = cappedMin; k <= cappedMax; k++) kRange.push(k);

    const inertias = kRange.map((k) => {
      const { assignments, centroids } = this._kmeansNd(projected, k);
      return this._inertia(projected, centroids, assignments);
    });

    // Elbow: maximiza a segunda derivada da curva de inércia
    let bestIdx = 0;
    let bestElbow = -Infinity;
    for (let i = 1; i < inertias.length - 1; i++) {
      const elbow = inertias[i - 1] + inertias[i + 1] - 2 * inertias[i];
      if (elbow > bestElbow) { bestElbow = elbow; bestIdx = i; }
    }
    const bestK = kRange[bestIdx];
    return this.clusterByAnalysis(entries, bestK);
  }

  // ─── PCA via Power Iteration ────────────────────────────────────────────────

  /**
   * Retorna os N primeiros componentes principais (unit vectors em R^d).
   * Usa Power Iteration com deflação ortogonal.
   *
   * @param {number[][]} centered — n×d, dados centrados
   * @param {number}     n        — número de componentes a extrair
   * @param {number}     iters    — iterações de Power Iteration por componente
   * @returns {number[][]} [pc1, ..., pcN] — N vetores de dimensão d
   */
  _pcaNd(centered, n = 2, iters = 40) {
    const pcs = [];
    for (let i = 0; i < n; i++) {
      pcs.push(this._powerIter(centered, pcs, iters));
    }
    return pcs;
  }

  /**
   * Power Iteration para encontrar o eigenvector dominante de X^T X,
   * ortogonal a todos os vetores em `prevPcs`.
   *
   * @param {number[][]} X       — n×d centrados
   * @param {number[][]} prevPcs — PCs já encontrados (para deflação)
   * @param {number}     iters
   * @returns {number[]} eigenvector normalizado (dimensão d)
   */
  _powerIter(X, prevPcs, iters) {
    const n = X.length;
    const d = X[0].length;

    // Inicialização pseudo-aleatória determinística (seed implícita)
    let v = new Float64Array(d);
    for (let i = 0; i < d; i++) v[i] = ((i * 2654435761) & 0xffffffff) / 0x100000000 - 0.5;
    this._normalizeInPlace(v);

    for (let iter = 0; iter < iters; iter++) {
      // Ortogonaliza em relação aos PCs anteriores (Gram-Schmidt)
      for (const pc of prevPcs) {
        const proj = this._dot(v, pc);
        for (let i = 0; i < d; i++) v[i] -= proj * pc[i];
      }
      this._normalizeInPlace(v);

      // w = X * v  (comprimento n)
      const w = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        let s = 0;
        const xj = X[j];
        for (let i = 0; i < d; i++) s += xj[i] * v[i];
        w[j] = s;
      }

      // v_new = X^T * w  (comprimento d)
      const vNew = new Float64Array(d);
      for (let j = 0; j < n; j++) {
        const wj = X[j];
        const wv = w[j];
        for (let i = 0; i < d; i++) vNew[i] += wv * wj[i];
      }
      this._normalizeInPlace(vNew);
      v = vNew;
    }
    return Array.from(v);
  }

  // ─── K-means 2D (k-means++ init) ────────────────────────────────────────────

  /**
   * K-means em espaço N-dimensional (funciona para qualquer dimensão).
   * @param {number[][]} points
   * @param {number} k
   * @param {number} maxIter
   * @returns {{ assignments: Int32Array, centroids: number[][] }}
   */
  _kmeansNd(points, k, maxIter = 100) {
    const d = points[0].length;
    const n = points.length;

    // ── K-means++ initialization ──────────────────────────────────────────
    const centroids = [];

    // 1º centroide: aleatório
    centroids.push([...points[Math.floor(this._rand(0, n))]]);

    while (centroids.length < k) {
      // Distância ao centroide mais próximo para cada ponto
      const dists = points.map((p) =>
        Math.min(...centroids.map((c) => this._distNd(p, c))) ** 2
      );
      const total = dists.reduce((a, b) => a + b, 0);
      let rnd = Math.random() * total;
      for (let i = 0; i < n; i++) {
        rnd -= dists[i];
        if (rnd <= 0) {
          centroids.push([...points[i]]);
          break;
        }
      }
      // fallback (rounding) — se não saiu do loop
      if (centroids.length < k) centroids.push([...points[n - 1]]);
    }

    // ── Iterações ─────────────────────────────────────────────────────────
    const assignments = new Int32Array(n);

    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;

      // Fase de atribuição
      for (let i = 0; i < n; i++) {
        let best = 0, bestDist = Infinity;
        for (let c = 0; c < k; c++) {
          const dd = this._distNd(points[i], centroids[c]);
          if (dd < bestDist) { bestDist = dd; best = c; }
        }
        if (assignments[i] !== best) { assignments[i] = best; changed = true; }
      }
      if (!changed) break;

      // Fase de atualização de centroides
      const sums   = Array.from({ length: k }, () => new Float64Array(d));
      const counts = new Int32Array(k);
      for (let i = 0; i < n; i++) {
        const cl = assignments[i];
        for (let j = 0; j < d; j++) sums[cl][j] += points[i][j];
        counts[cl]++;
      }
      for (let c = 0; c < k; c++) {
        if (counts[c] > 0) {
          for (let j = 0; j < d; j++) centroids[c][j] = sums[c][j] / counts[c];
        }
      }
    }

    return { assignments, centroids };
  }

  // ─── Helpers matemáticos ────────────────────────────────────────────────────

  _normalizeL2(v) {
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (norm === 0) return v.slice();
    return v.map((x) => x / norm);
  }

  _normalizeInPlace(v) {
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (norm === 0) return;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
  }

  _meanVector(vectors) {
    const d = vectors[0].length;
    const mean = new Array(d).fill(0);
    for (const v of vectors) for (let i = 0; i < d; i++) mean[i] += v[i];
    for (let i = 0; i < d; i++) mean[i] /= vectors.length;
    return mean;
  }

  _dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  _distNd(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum);
  }

  _inertia(points, centroids, assignments) {
    let total = 0;
    for (let i = 0; i < points.length; i++) {
      total += this._distNd(points[i], centroids[assignments[i]]) ** 2;
    }
    return total;
  }

  /**
   * Encontra o k ótimo automaticamente usando o Elbow Method.
   * Testa cada k em [kMin..kMax], computa inércia e escolhe o cotovelo.
   *
   * @param {Record<string, import('./EmbeddingService.js').TrackEmbedding>} embeddings
   * @param {number} kMin — k mínimo a testar (padrão 2)
   * @param {number} kMax — k máximo a testar (padrão 15)
   * @returns {ReturnType<ClusteringService["cluster"]>}
   */
  clusterAuto(embeddings, kMin = 2, kMax = 15) {
    const ratingKeys = Object.keys(embeddings);
    if (ratingKeys.length < 2) return { k: 1, clusters: [] };

    const cappedMax = Math.min(kMax, ratingKeys.length);
    const cappedMin = Math.min(kMin, cappedMax);
    if (cappedMin >= cappedMax) return this.cluster(embeddings, cappedMin);

    // Prepara projeção PCA uma única vez para todos os testes de k
    const rawVectors = ratingKeys.map((key) => embeddings[key].embedding);
    const normalized = rawVectors.map(this._normalizeL2.bind(this));
    const mean       = this._meanVector(normalized);
    const centered   = normalized.map((v) => v.map((x, i) => x - mean[i]));
    const PCA_DIMS   = Math.min(50, Math.floor(ratingKeys.length / 2), rawVectors[0].length);
    const pcs        = this._pcaNd(centered, PCA_DIMS, 40);
    const projected  = centered.map((v) => pcs.map((pc) => this._dot(v, pc)));

    // Calcula inércia para cada k
    const kRange = [];
    for (let k = cappedMin; k <= cappedMax; k++) kRange.push(k);

    const inertias = kRange.map((k) => {
      const { assignments, centroids } = this._kmeansNd(projected, k);
      return this._inertia(projected, centroids, assignments);
    });

    // Elbow: maximiza a segunda derivada da curva de inércia
    let bestIdx = 0;
    let bestElbow = -Infinity;
    for (let i = 1; i < inertias.length - 1; i++) {
      const elbow = inertias[i - 1] + inertias[i + 1] - 2 * inertias[i];
      if (elbow > bestElbow) { bestElbow = elbow; bestIdx = i; }
    }
    const bestK = kRange[bestIdx];
    return this.cluster(embeddings, bestK);
  }

  _rand(min, max) {
    return Math.floor(Math.random() * (max - min)) + min;
  }
}
