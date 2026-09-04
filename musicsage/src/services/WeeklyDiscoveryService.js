import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../../data");

const WEEK_MS  = 7 * 24 * 60 * 60 * 1000;
const CHECK_MS = 5 * 60 * 1000;   // resolução do agendador

/** Fração do pool (as menos ouvidas) que vira candidata à descoberta. */
const SEED_FRACTION = 0.4;

/**
 * WeeklyDiscoveryService — playlist de descobertas gerada sozinha uma vez por semana.
 *
 * A semente são as faixas MENOS ouvidas da biblioteca, excluindo as favoritas:
 * o objetivo é desenterrar o que já está no acervo e nunca toca, não repetir
 * o que o ouvinte já ama. O perfil de áudio do RecommendationEngine entra como
 * contexto para que o resgate ainda combine com o gosto dele.
 *
 * Estado em DATA_DIR/weekly.json:
 * { enabled, dayOfWeek, hour, lastRunAt, lastPlaylist, lastError }
 */
export class WeeklyDiscoveryService {
  constructor({
    playlistBuilder,
    analysisCache,
    libraryScanner,
    favoritesService,
    recommendationEngine,
    historyService,
    mediaPlaylists,
    embeddingService = null,
    clusteringService = null,
    dataDir,
    // Injetáveis para teste — o agendador é relógio puro, não deve depender do real
    now   = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {}) {
    this.playlistBuilder      = playlistBuilder;
    this.analysisCache        = analysisCache;
    this.libraryScanner       = libraryScanner;
    this.favoritesService     = favoritesService;
    this.recommendationEngine = recommendationEngine;
    this.historyService       = historyService;
    this.mediaPlaylists       = mediaPlaylists;
    this.embeddingService     = embeddingService;
    this.clusteringService    = clusteringService;

    this.file  = path.join(dataDir || _DATA_DIR, "weekly.json");
    this.now   = now;
    this.sleep = sleep;

    this._timer   = null;
    this._running = false;

    this.state = {
      enabled:   false,
      dayOfWeek: 1,   // segunda
      hour:      7,
      size:      25,
      clusterDiversity: false,  // feature flag: espalha candidatos pelos clusters vetoriais
      lastRunAt:    null,
      lastPlaylist: null,
      lastError:    null,
    };
  }

  // ── Persistência ────────────────────────────────────────────────────────

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.state = { ...this.state, ...raw };
      logger.info("WEEKLY", `Config carregada (enabled=${this.state.enabled}, dia=${this.state.dayOfWeek}, hora=${this.state.hour})`);
    } catch (err) {
      if (err.code !== "ENOENT") logger.warn("WEEKLY", `Falha ao carregar ${this.file}: ${err.message}`);
    }
    return this;
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      logger.warn("WEEKLY", `Falha ao salvar ${this.file}: ${err.message}`);
    }
  }

  /** @param {{enabled?: boolean, dayOfWeek?: number, hour?: number, size?: number, clusterDiversity?: boolean}} patch */
  updateSettings(patch = {}) {
    if (typeof patch.enabled === "boolean")          this.state.enabled = patch.enabled;
    if (Number.isInteger(patch.dayOfWeek) && patch.dayOfWeek >= 0 && patch.dayOfWeek <= 6) this.state.dayOfWeek = patch.dayOfWeek;
    if (Number.isInteger(patch.hour) && patch.hour >= 0 && patch.hour <= 23)               this.state.hour = patch.hour;
    if (Number.isInteger(patch.size) && patch.size >= 5 && patch.size <= 100)              this.state.size = patch.size;
    if (typeof patch.clusterDiversity === "boolean") this.state.clusterDiversity = patch.clusterDiversity;
    this._save();
    return this.status();
  }

  status() {
    return {
      ...this.state,
      running:   this._running,
      nextRunAt: this.state.enabled ? this._nextSlot(this.now()) : null,
    };
  }

  // ── Agendador ───────────────────────────────────────────────────────────

  /** Slot mais recente (dia/hora configurados) em ou antes de `ts`. */
  _lastSlot(ts) {
    const d = new Date(ts);
    d.setHours(this.state.hour, 0, 0, 0);
    // Volta até cair no dia da semana certo
    const diff = (d.getDay() - this.state.dayOfWeek + 7) % 7;
    d.setDate(d.getDate() - diff);
    if (d.getTime() > ts) d.setTime(d.getTime() - WEEK_MS);
    return d.getTime();
  }

  _nextSlot(ts) {
    return this._lastSlot(ts) + WEEK_MS;
  }

  /** Passou do horário desta semana e ainda não rodou nela? */
  isDue(ts = this.now()) {
    if (!this.state.enabled) return false;
    const slot = this._lastSlot(ts);
    return this.state.lastRunAt == null || this.state.lastRunAt < slot;
  }

  /** Liga o agendador. Idempotente. */
  start({ intervalMs = CHECK_MS } = {}) {
    if (this._timer) return this;
    this._timer = setInterval(() => {
      this.tick().catch((err) => logger.warn("WEEKLY", `tick falhou: ${err.message}`));
    }, intervalMs);
    // Não segura o processo vivo — o servidor é quem decide quando morrer
    this._timer.unref?.();
    logger.info("WEEKLY", `Agendador ligado (checa a cada ${Math.round(intervalMs / 1000)}s)`);
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    return this;
  }

  async tick() {
    if (this._running || !this.isDue()) return null;
    logger.info("WEEKLY", "Horário da descoberta semanal — gerando");
    return this.run();
  }

  // ── Geração ─────────────────────────────────────────────────────────────

  /**
   * Gera (com retry), publica no Plex e registra. Uma execução por vez.
   * @param {{ onProgress?: (stage: string, pct: number) => void, attempts?: number }} opts
   */
  async run({ onProgress = null, attempts = 3 } = {}) {
    if (this._running) throw new Error("Já existe uma descoberta semanal em andamento");
    this._running = true;
    const report = (stage, pct) => onProgress?.(stage, pct);

    try {
      let lastErr = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const result = await this._generateOnce(report);
          this.state.lastRunAt    = this.now();
          this.state.lastPlaylist = result;
          this.state.lastError    = null;
          this._save();
          logger.info("WEEKLY", `"${result.name}" pronta (${result.trackCount} faixas)`);
          return result;
        } catch (err) {
          lastErr = err;
          // Ollama fora do ar é a falha esperada aqui — vale esperar e tentar de novo
          if (attempt < attempts) {
            const backoff = 3000 * Math.pow(3, attempt - 1);
            logger.warn("WEEKLY", `Tentativa ${attempt}/${attempts} falhou (${err.message}) — nova tentativa em ${backoff}ms`);
            report(`Falhou — tentando de novo em ${Math.round(backoff / 1000)}s…`, 5);
            await this.sleep(backoff);
          }
        }
      }
      // Marca o slot como visto mesmo na falha: senão o agendador re-dispara a cada 5min
      this.state.lastRunAt = this.now();
      this.state.lastError = { message: lastErr?.message || String(lastErr), at: this.now() };
      this._save();
      logger.error("WEEKLY", `Descoberta semanal falhou após ${attempts} tentativas: ${lastErr?.message}`);
      throw lastErr;
    } finally {
      this._running = false;
    }
  }

  async _generateOnce(report) {
    report("Escolhendo faixas esquecidas…", 10);
    const candidates = await this.pickCandidates();
    if (!candidates.length) {
      throw new Error("Nenhuma faixa candidata: analise a biblioteca antes de gerar descobertas.");
    }

    report("Lendo seu perfil musical…", 25);
    const prompt = await this.buildPrompt();

    report("Montando a playlist…", 40);
    const playlist = await this.playlistBuilder.generateFromCacheWithPrompt(prompt, this.analysisCache, {
      size: this.state.size,
      maxPerArtist: 2,
      discoveryRatio: 0,
      candidateRatingKeys: new Set(candidates.map((e) => String(e.ratingKey))),
      onProgress: (stage, pct) => report(stage, 40 + (pct ?? 0) * 0.4),
    });

    playlist.name = this.playlistName();
    const saved = this.playlistBuilder.save(playlist);

    report("Publicando no Plex…", 90);
    let plexId = null;
    try {
      const keys = (saved.tracks || []).map((t) => t.ratingKey).filter(Boolean);
      if (this.mediaPlaylists && keys.length) {
        ({ plexId } = await this.mediaPlaylists.pushPlaylist(saved.name, keys));
        this.playlistBuilder.update(saved.id, { plexId });
      }
    } catch (err) {
      // Servidor fora não invalida a playlist — ela existe localmente e o card mostra o aviso
      logger.warn("WEEKLY", `Playlist criada mas o push pro servidor de mídia falhou: ${err.message}`);
    }

    report("Concluído", 100);
    return {
      id:         saved.id,
      name:       saved.name,
      plexId,
      trackCount: (saved.tracks || []).length,
      createdAt:  this.now(),
    };
  }

  playlistName(ts = this.now()) {
    const d  = new Date(ts);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `Descobertas da semana — ${dd}/${mm}`;
  }

  /**
   * Faixas analisadas menos ouvidas, tirando as favoritas.
   * @returns {Promise<object[]>} entradas do analysisCache com .viewCount
   */
  async pickCandidates() {
    const entries = this.analysisCache?.getAll() ?? [];
    if (!entries.length) return [];

    const starred = this.favoritesService?.starredKeys() ?? new Set();
    const FavoritesService = this.favoritesService?.constructor;
    const notFavorite = (e) => {
      if (!starred.size || !FavoritesService?.makeKey) return true;
      return !starred.has(FavoritesService.makeKey(e.artist, e.title, e.album));
    };

    const vcMap = await this._viewCounts();
    const pool = entries
      .filter(notFavorite)
      .map((e) => ({ ...e, viewCount: vcMap.get(String(e.ratingKey)) ?? 0 }))
      .sort((a, b) => a.viewCount - b.viewCount);

    const seed = pool.slice(0, Math.max(this.state.size, Math.ceil(pool.length * SEED_FRACTION)));
    return this.state.clusterDiversity ? this._spreadOverClusters(seed) : seed;
  }

  async _viewCounts() {
    try {
      const { tracks } = await this.libraryScanner.scan();
      return new Map(tracks.map((t) => [String(t.ratingKey), t.viewCount || 0]));
    } catch (err) {
      // Sem Plex não dá para saber o que é pouco ouvido — segue com o cache inteiro
      logger.warn("WEEKLY", `Sem viewCount do Plex (${err.message}) — pool sem ordenação por plays`);
      return new Map();
    }
  }

  /**
   * Feature flag: reordena o pool alternando entre clusters vetoriais, para a
   * semana não sair inteira do mesmo canto sonoro da biblioteca.
   * Sem embeddings suficientes, devolve o pool intacto.
   */
  _spreadOverClusters(pool) {
    if (!this.embeddingService || !this.clusteringService) return pool;
    try {
      const store   = this.embeddingService.getStored() ?? {};
      const allowed = new Set(pool.map((e) => String(e.ratingKey)));
      const subset  = Object.fromEntries(
        Object.entries(store).filter(([ratingKey]) => allowed.has(String(ratingKey)))
      );
      if (Object.keys(subset).length < 2) return pool;

      const { clusters } = this.clusteringService.cluster(subset, 8);
      const byKey  = new Map(pool.map((e) => [String(e.ratingKey), e]));
      const queues = clusters.map((c) => c.tracks.map((t) => String(t.ratingKey)));

      // Round-robin entre clusters
      const out  = [];
      const seen = new Set();
      for (let i = 0; queues.some((q) => i < q.length); i++) {
        for (const q of queues) {
          const key = q[i];
          if (!key || seen.has(key)) continue;
          const entry = byKey.get(key);
          if (entry) { out.push(entry); seen.add(key); }
        }
      }
      // Faixas sem embedding entram no fim, não somem
      for (const e of pool) if (!seen.has(String(e.ratingKey))) out.push(e);
      return out;
    } catch (err) {
      logger.warn("WEEKLY", `Diversificação por clusters falhou (${err.message}) — usando pool original`);
      return pool;
    }
  }

  /** Prompt de resgate, ancorado no perfil de áudio real do ouvinte. */
  async buildPrompt() {
    let profile = null;
    try {
      const recent = (await this.historyService?.getRecentlyPlayedFull(300)) ?? [];
      profile = this.recommendationEngine?._buildAudioProfile(recent) ?? null;
    } catch (err) {
      logger.warn("WEEKLY", `Perfil de áudio indisponível (${err.message}) — prompt genérico`);
    }

    const parts = [];
    if (profile?.topGenres?.length) parts.push(`gêneros favoritos: ${profile.topGenres.slice(0, 5).join(", ")}`);
    if (profile?.topMoods?.length)  parts.push(`moods típicos: ${profile.topMoods.slice(0, 4).join(", ")}`);
    if (profile?.avgEnergy != null) parts.push(`energia média ${profile.avgEnergy}/10`);
    if (profile?.avgBpm    != null) parts.push(`BPM médio ${profile.avgBpm}`);

    const perfil = parts.length ? ` O ouvinte costuma gostar de: ${parts.join(" | ")}.` : "";
    return `Playlist de redescoberta com faixas da biblioteca que quase nunca tocam.${perfil}` +
      ` Priorize variedade de artistas e um fluxo coeso do começo ao fim.`;
  }
}
