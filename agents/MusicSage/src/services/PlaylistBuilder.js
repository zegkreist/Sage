import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logger } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Pasta de dados: ../../mediasage/playlists/ (relativa ao agent)
const PLAYLISTS_DIR = join(__dirname, "../../../../mediasage/playlists");
const PLAYLISTS_FILE = join(PLAYLISTS_DIR, "playlists.json");

/**
 * PlaylistBuilder — gera e persiste playlists a partir da biblioteca.
 *
 * As playlists são guardadas em memória (Map) e também em disco
 * (mediasage/playlists/playlists.json) para sobreviver a reinícios.
 */
export class PlaylistBuilder {
  /**
   * @param {{
   *   allfather: object,
   *   libraryScanner: object,
   *   embeddingService?: object,
   *   storageFile?: string|false
   * }} config
   *   embeddingService — instância de EmbeddingService (opcional).
   *     Quando presente, generateFromPrompt() usa busca por similaridade de
   *     embedding para pré-filtrar candidatos semanticamente relevantes antes
   *     de enviar ao LLM. Quando ausente (ou store vazio), usa filtro por metadados.
   *   storageFile — caminho do ficheiro JSON de persistência; `false` desabilita o disco (usado em testes)
   */
  constructor({ allfather, libraryScanner, embeddingService, storageFile } = {}) {
    this.allfather = allfather;
    this.libraryScanner = libraryScanner;
    this._embeddingService = embeddingService || null;
    // storageFile=false desabilita persistência em disco (útil em testes)
    this._storageFile = storageFile === undefined ? PLAYLISTS_FILE : storageFile;
    this._store = new Map();
    if (this._storageFile) this._loadFromDisk();
  }

  /**
   * Gera uma playlist baseada em critérios com ajuda do Ollama.
   * @param {{ name?, mood?, genre?, energy?, size? }} options
   * @returns {Promise<{id, name, mood, genre, tracks[], createdAt}>}
   */
  async generate({ name, mood, genre, energy, size = 10, region } = {}) {
    const playlistName = name || this._autoName({ mood, genre });
    logger.info("PLAYLIST", `generate() iniciado — "${playlistName}"`, { mood, genre, energy, size, region });

    try {
      // Garante que a biblioteca está carregada
      const { tracks } = await this.libraryScanner.scan();

      if (!tracks.length) {
        logger.warn("PLAYLIST", "Biblioteca vazia — retornando playlist vazia");
        return this._emptyPlaylist(playlistName, { mood, genre });
      }

      // Pré-filtro por idioma: filtra a BIBLIOTECA COMPLETA antes de limitar os
      // candidatos — garante que o pool disponível seja adequado à região pedida.
      // (Se aplicado depois de _preFilterTracks, apenas ~40 tracks aleatórios seriam
      // avaliados, e a maioria poderia não ter o idioma desejado.)
      const langFiltered = region ? this._filterByLanguage(tracks, region, size) : tracks;
      // Pré-filtro por metadados: reduz o corpus (já filtrado por idioma) antes de enviar ao Ollama
      const candidates = this._preFilterTracks(langFiltered, { genre, size });
      logger.debug("PLAYLIST", `Pré-filtro: ${tracks.length} → ${langFiltered.length} (lang) → ${candidates.length} (meta) candidatos`);

      const t0 = Date.now();
      const criteria = [
        mood   && `mood: ${mood}`,
        genre  && `genre: ${genre}`,
        energy && `energy level: ${energy}/10`,
        region && `region: ${region}`,
      ].filter(Boolean).join(', ') || 'general mix';

      const BATCH_SIZE = 50;
      let selectedTracks;
      if (candidates.length <= BATCH_SIZE) {
        logger.debug("PLAYLIST", `Seleção direta: ${candidates.length} candidatos → Ollama`);
        selectedTracks = await this._selectTracksOllama(candidates, criteria, size, region);
      } else {
        selectedTracks = await this._selectTracksTournament(candidates, criteria, size, BATCH_SIZE, region);
      }
      logger.debug("OLLAMA", `Seleção concluída em ${Date.now() - t0}ms`);

      const playlist = {
        id: randomUUID(),
        name: playlistName,
        mood: mood || null,
        genre: genre || null,
        energy: energy || null,
        tracks: this._ensureDiscovery(
          this._diversifyArtists(selectedTracks, candidates, size),
          candidates,
          size,
        ),
        createdAt: new Date().toISOString(),
      };

      logger.info("PLAYLIST", `Playlist gerada: "${playlist.name}" — ${playlist.tracks.length} faixas`);
      return playlist;
    } catch (err) {
      logger.error("PLAYLIST", `Erro ao gerar playlist: ${err.message}`);
      return this._emptyPlaylist(playlistName, { mood, genre });
    }
  }

  /**
   * Pré-filtra tracks por metadados antes de enviar ao Ollama.
   * Estratégia:
   *   1. Se genre foi especificado, mantém apenas artistas cujo nome de álbum ou
   *      genre hint coincidem (heurística conservadora — passa tudo se não combinar nada).
   *   2. Limita a 3 faixas por artista para garantir diversidade.
   *   3. Shuffle leve (determinístico pelo hash) para variar a seleção entre chamadas.
   *   4. Retorna no máximo Math.max(size * 4, 40) candidatos para o Ollama.
   *
   * @param {object[]} tracks   — lista completa da biblioteca
   * @param {{ genre?: string, size?: number }} opts
   * @returns {object[]}
   */
  _preFilterTracks(tracks, { genre, size = 10 } = {}) {
    const MAX_CANDIDATES = Math.max(size * 4, 40);
    // Pool pode ter mais por artista que o limite final (_diversifyArtists),
    // mas não muito: evita que o torneio veja apenas poucos artistas repetidos.
    const MAX_PER_ARTIST = Math.max(3, Math.ceil(size / 10));

    // Shuffle determinístico leve (não criptográfico mas suficiente para variar)
    const shuffled = [...tracks].sort(() => Math.random() - 0.5);

    // Filtro por genre: tenta match no parentTitle (album) ou grandparentTitle (artista)
    let pool = shuffled;
    if (genre?.trim()) {
      const genreLow = genre.trim().toLowerCase();
      const genreFiltered = shuffled.filter((t) => {
        const hay = `${t.title} ${t.grandparentTitle} ${t.parentTitle}`.toLowerCase();
        return hay.includes(genreLow);
      });
      // Só aplica filtro se tiver candidatos suficientes, senão usa pool completo
      if (genreFiltered.length >= size) pool = genreFiltered;
    }

    // Limitar por artista (diversidade)
    const perArtist = new Map();
    const result = [];
    for (const t of pool) {
      const artist = (t.grandparentTitle || "Unknown").toLowerCase();
      const count = perArtist.get(artist) || 0;
      if (count < MAX_PER_ARTIST) {
        result.push(t);
        perArtist.set(artist, count + 1);
      }
      if (result.length >= MAX_CANDIDATES) break;
    }

    return result;
  }

  /**
   * Salva uma playlist no store em memória e em disco.
   * @param {{ name: string, tracks: any[], [key: string]: any }} playlist
   * @returns {{ id: string, createdAt: string, ...playlist }}
   */
  save(playlist) {
    const saved = {
      ...playlist,
      id: playlist.id || randomUUID(),
      createdAt: playlist.createdAt || new Date().toISOString(),
    };
    this._store.set(saved.id, saved);
    this._saveToDisk();
    logger.debug("PLAYLIST", `save() — "${saved.name}" (id=${saved.id})`);
    return saved;
  }

  /**
   * Lista todas as playlists salvas.
   * @returns {any[]}
   */
  list() {
    return [...this._store.values()];
  }

  /**
   * Retorna playlist pelo id.
   * @param {string} id
   * @returns {any|null}
   */
  get(id) {
    return this._store.get(id) ?? null;
  }

  /**
   * Remove playlist pelo id.
   * @param {string} id
   * @returns {boolean}
   */
  delete(id) {
    if (!this._store.has(id)) return false;
    const name = this._store.get(id)?.name;
    this._store.delete(id);
    this._saveToDisk();
    logger.info("PLAYLIST", `Playlist excluída: "${name}" (id=${id})`);
    return true;
  }

  /**
   * Atualiza campos de uma playlist existente (nome, faixas, etc.).
   * @param {string} id
   * @param {{ name?: string, tracks?: any[] }} fields
   * @returns {any|null} playlist atualizada ou null se não encontrada
   */
  update(id, fields = {}) {
    const existing = this._store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...fields, id, updatedAt: new Date().toISOString() };
    this._store.set(id, updated);
    this._saveToDisk();
    logger.info("PLAYLIST", `Playlist atualizada: "${updated.name}" (id=${id})`, { fields: Object.keys(fields) });
    return updated;
  }

  /**
   * Gera uma playlist a partir de um prompt em linguagem natural.
   *
   * Fluxo híbrido (LLM + embedding):
   *   1. Em paralelo: extrai parâmetros via LLM, embedda o prompt e busca
   *      faixas similares no store de embeddings, e faz scan da biblioteca.
   *   2. Se o store de embeddings tiver dados, usa os top-N candidatos
   *      semanticamente similares como corpus para a seleção do LLM.
   *   3. Caso contrário (store vazio ou EmbeddingService não configurado),
   *      faz fallback para o filtro por metadados (genre + diversidade).
   *   4. O LLM curadoria final recebe o prompt original como critério temático.
   *
   * @param {string} prompt — texto livre do usuário
   * @returns {Promise<{id, name, mood, genre, tracks[], createdAt, prompt}>}
   */
  async generateFromPrompt(prompt) {
    logger.info("PLAYLIST", `generateFromPrompt() chamado`, { prompt });

    // Busca um número generoso de candidatos por similaridade; é barato (O(n) no store).
    // O valor final é recortado para max(size*4, 200) após conhecermos o size real.
    const SEMANTIC_PREFETCH = 2000;
    const defaults = { name: null, mood: null, genre: null, energy: null, size: 10, region: null };

    // ── 1. Extração de parâmetros, busca semântica e scan em paralelo ─────────
    const [paramsResult, semanticResult, scanResult] = await Promise.allSettled([
      this.allfather.askForJSON(
        `You are a music assistant. Extract playlist parameters from this user request:
"${prompt}"

Return a JSON object with these exact fields (use null for fields not mentioned):
{
  "name": "playlist name based on the request, or null to auto-generate",
  "mood": "one word mood (e.g. relaxed, energetic, melancholic, happy, dark, upbeat) or null",
  "genre": "primary genre string or null",
  "energy": <integer 1-10 or null>,
  "size": <integer number of tracks, default 10 if not specified>,
  "region": "country or region name in English when the request implies a specific geographic origin (e.g. Brazil, United States, United Kingdom, Japan, France) or null"
}`,
        { temperature: 0.2 }
      ),
      this._embeddingService
        ? this._embeddingService.searchByText(prompt, SEMANTIC_PREFETCH)
        : Promise.resolve(null),
      this.libraryScanner.scan(),
    ]);

    if (paramsResult.status === "rejected") {
      logger.warn("PLAYLIST", `Falha ao interpretar prompt — usando parâmetros padrão: ${paramsResult.reason?.message}`);
    }
    const params = { ...defaults, ...(paramsResult.value ?? {}) };
    const size = (typeof params.size === "number" && params.size > 0) ? params.size : 10;
    logger.info("PLAYLIST", `Parâmetros do prompt`, params);

    // ── 2. Biblioteca ──────────────────────────────────────────────────────────
    const { tracks: allTracks } = scanResult.status === "fulfilled"
      ? scanResult.value
      : { tracks: [] };

    if (!allTracks.length) {
      logger.warn("PLAYLIST", "Biblioteca vazia — retornando playlist vazia");
      return this._emptyPlaylist(params.name || this._autoName(params), params);
    }

    // ── 3. Pré-filtro: semântico (embedding) ou metadados (fallback) ──────────
    let candidates;
    const semanticHits = semanticResult.status === "fulfilled" ? semanticResult.value : null;

    // Extrair region antes de usar no filtro de idioma
    const region = params.region || null;
    if (region) logger.info("PLAYLIST", `Filtro de região ativo: ${region}`);

    if (semanticHits?.length > 0) {
      const trackByKey = new Map(allTracks.map(t => [String(t.ratingKey), t]));
      const semanticLimit = Math.max(size * 4, 200);
      candidates = semanticHits.slice(0, semanticLimit).map(r => trackByKey.get(r.ratingKey)).filter(Boolean);
      logger.info("PLAYLIST", `Semantic pre-filter: ${candidates.length} candidatos via embedding similarity (top ${semanticLimit} de ${semanticHits.length} disponíveis)`);
      // Aplica filtro de idioma nos resultados semânticos (semantic search pode não saber de região)
      if (region) {
        const langFiltered = this._filterByLanguage(candidates, region, size);
        logger.debug("PLAYLIST", `Lang filter on semantic: ${candidates.length} → ${langFiltered.length} candidatos`);
        candidates = langFiltered;
      }
    } else {
      if (this._embeddingService && semanticHits?.length === 0) {
        logger.debug("PLAYLIST", "Embedding store vazio — usando metadata pre-filter");
      }
      // Aplica filtro de idioma na BIBLIOTECA COMPLETA antes de limitar os candidatos.
      // Crítico: sem isso, _preFilterTracks pegaria ~40 tracks aleatórios e poucos
      // seriam do idioma correto, causando fallback sem filtro.
      const langFiltered = region ? this._filterByLanguage(allTracks, region, size) : allTracks;
      candidates = this._preFilterTracks(langFiltered, { genre: params.genre, size });
      logger.debug("PLAYLIST", `Metadata pre-filter: ${allTracks.length} → ${langFiltered.length} (lang) → ${candidates.length} candidatos`);
    }

    // ── 4. Seleção final via LLM ───────────────────────────────────────────────
    // O prompt original é incluído como contexto temático para o LLM.
    const criteria = [
      `theme: "${prompt}"`,
      params.mood   && `mood: ${params.mood}`,
      params.genre  && `genre: ${params.genre}`,
      params.energy && `energy level: ${params.energy}/10`,
      region        && `region: ${region}`,
    ].filter(Boolean).join(", ");

    try {
      const t0 = Date.now();
      const BATCH_SIZE = 50;
      const selectedTracks = candidates.length <= BATCH_SIZE
        ? await this._selectTracksOllama(candidates, criteria, size, region)
        : await this._selectTracksTournament(candidates, criteria, size, BATCH_SIZE, region);
      logger.debug("OLLAMA", `Seleção concluída em ${Date.now() - t0}ms`);

      const playlist = {
        id:        randomUUID(),
        name:      params.name || this._autoName(params),
        mood:      params.mood   || null,
        genre:     params.genre  || null,
        energy:    params.energy || null,
        tracks:    this._ensureDiscovery(
          this._diversifyArtists(selectedTracks, candidates, size),
          candidates,
          size,
        ),
        createdAt: new Date().toISOString(),
        prompt,
      };
      logger.info("PLAYLIST", `Playlist gerada: "${playlist.name}" — ${playlist.tracks.length} faixas`);
      return playlist;
    } catch (err) {
      logger.error("PLAYLIST", `Erro ao gerar playlist: ${err.message}`);
      return { ...this._emptyPlaylist(params.name || this._autoName(params), params), prompt };
    }
  }

  /**
   * Gera uma playlist baseada na análise direta do áudio de uma faixa de referência.
   *
   * Pipeline:
   *   1. analyzer.analyzeAudioFile() → perfil musical completo (via gemma4 + Ollama)
   *   2. O perfil (gênero, mood, energia, timbre, instrumentos, dinâmica, vocal) é
   *      usado diretamente como critério de seleção — sem passar por embeddings.
   *   3. Os candidatos da biblioteca são filtrados por gênero (se disponível) e
   *      depois o Ollama seleciona os mais compatíveis com o perfil sonoro.
   *
   * @param {string}           audioPath  caminho absoluto do arquivo de referência
   * @param {object}           [options]
   * @param {number}           [options.size=10]        número de faixas
   * @param {string}           [options.name]           nome da playlist
   * @param {number}           [options.maxAudioSecs=30] duração máxima analisada
   * @param {object}           [options.metaHint]       { title, artist, album, genres } opcionais
   * @param {object}           analyzer   instância MusicAnalyzer
   * @returns {Promise<object>} playlist com `id, name, tracks[], analysis, createdAt`
   */
  async generateFromAudio(audioPath, options = {}, analyzer) {
    const { size = 10, name, maxAudioSecs = 30, metaHint = {} } = options;

    if (!analyzer) throw new Error("generateFromAudio requer uma instância MusicAnalyzer");

    logger.info("PLAYLIST", `generateFromAudio() — ${audioPath}`, { size });

    // ── 1. Analisa o áudio da faixa de referência ─────────────────────────
    const analysis = await analyzer.analyzeAudioFile(audioPath, metaHint, { maxAudioSecs });
    logger.info("PLAYLIST", `Perfil de áudio obtido`, {
      genre: analysis.genre, mood: analysis.mood, energy: analysis.energy,
    });

    // ── 2. Carrega biblioteca ─────────────────────────────────────────────
    const { tracks: allTracks } = await this.libraryScanner.scan();
    if (!allTracks.length) {
      logger.warn("PLAYLIST", "Biblioteca vazia");
      return this._emptyPlaylist(name || this._autoNameFromAnalysis(analysis), {});
    }

    // ── 3. Pré-filtro por gênero (aumenta relevância dos candidatos) ──────
    const candidates = this._preFilterTracks(allTracks, {
      genre: analysis.genre !== "Unknown" ? analysis.genre : null,
      size,
    });
    logger.debug("PLAYLIST", `Pré-filtro: ${allTracks.length} → ${candidates.length} candidatos`);

    // ── 4. Monta critério de seleção rico a partir do perfil musical ──────
    const criteriaLines = [
      `genre: ${analysis.genre}`,
      analysis.subgenre && analysis.subgenre !== "unknown"
                         ? `subgenre: ${analysis.subgenre}` : null,
      `mood: ${analysis.mood}`,
      `energy: ${analysis.energy}/10`,
      analysis.tempo     ? `tempo: ${analysis.tempo}${analysis.bpm ? ` (~${analysis.bpm} BPM)` : ""}` : null,
      analysis.key && analysis.key !== "unknown"
                         ? `musical key: ${analysis.key}` : null,
      analysis.rhythmPattern && analysis.rhythmPattern !== "unknown"
                         ? `rhythm pattern: ${analysis.rhythmPattern}` : null,
      analysis.timbre    ? `timbre/sound texture: ${analysis.timbre}` : null,
      analysis.dynamics  ? `dynamics: ${analysis.dynamics}` : null,
      analysis.productionStyle && analysis.productionStyle !== "unknown"
                         ? `production style: ${analysis.productionStyle}` : null,
      analysis.era && analysis.era !== "unknown"
                         ? `era/decade: ${analysis.era}` : null,
      analysis.acousticness != null
                         ? `acousticness: ${analysis.acousticness}/10` : null,
      analysis.texture && analysis.texture !== "moderate"
                         ? `texture: ${analysis.texture}` : null,
      analysis.vocalStyle && analysis.vocalStyle !== "unknown" && analysis.vocalStyle !== "none"
                         ? `vocal style: ${analysis.vocalStyle}` : null,
      analysis.instruments?.length
                         ? `instruments: ${analysis.instruments.join(", ")}` : null,
      analysis.emotionalTags?.length
                         ? `emotional feel: ${analysis.emotionalTags.join(", ")}` : null,
      analysis.characteristics?.length
                         ? `key characteristics: ${analysis.characteristics.join(", ")}` : null,
    ].filter(Boolean);

    const criteria = criteriaLines.join(", ");

    // Contexto extra para o LLM sobre o que "similar" significa aqui
    const referenceHint = metaHint.title
      ? `The user is looking for tracks sonically similar to "${metaHint.title}"${metaHint.artist ? ` by ${metaHint.artist}` : ""}.`
      : "The user wants tracks that sound sonically similar to the reference audio analyzed above.";

    // ── 5. Seleção final via Ollama ────────────────────────────────────────
    const BATCH_SIZE = 50;
    let selectedTracks;
    try {
      // Injeta contexto da análise de áudio diretamente no prompt de seleção
      const enhancedCriteria = `${referenceHint}\nAudio profile of the reference track: ${criteria}.\nSelect tracks with the most similar sonic signature and feel.`;

      const t0 = Date.now();
      selectedTracks = candidates.length <= BATCH_SIZE
        ? await this._selectTracksOllama(candidates, enhancedCriteria, size)
        : await this._selectTracksTournament(candidates, enhancedCriteria, size, BATCH_SIZE);
      logger.debug("OLLAMA", `Seleção por áudio concluída em ${Date.now() - t0}ms`);
    } catch (err) {
      logger.error("PLAYLIST", `Erro na seleção: ${err.message}`);
      selectedTracks = candidates.slice(0, size);
    }

    const playlist = {
      id:        randomUUID(),
      name:      name || this._autoNameFromAnalysis(analysis),
      mood:      analysis.mood   || null,
      genre:     analysis.genre  || null,
      energy:    analysis.energy || null,
      tracks:    this._ensureDiscovery(
        this._diversifyArtists(selectedTracks, candidates, size),
        candidates,
        size,
      ),
      analysis,          // perfil musical completo como metadado da playlist
      createdAt: new Date().toISOString(),
    };

    logger.info("PLAYLIST", `Playlist de áudio gerada: "${playlist.name}" — ${playlist.tracks.length} faixas`);
    return playlist;
  }

  /** Gera nome automático a partir de um perfil de análise de áudio. */
  _autoNameFromAnalysis({ genre, mood, energy } = {}) {
    const date = new Date().toLocaleDateString("pt-BR");
    const parts = [genre && genre !== "Unknown" ? genre : null, mood || null]
      .filter(Boolean);
    return parts.length ? `${parts.join(" ")} Mix — ${date}` : `Audio Mix — ${date}`;
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  /**
   * Maximiza a diversidade de artistas na playlist selecionada.
   *
   * Algoritmo:
   *   1. Percorre `selected` (ordem=preferência do Ollama) e aceita até
   *      `maxPerArtist` faixas de cada artista.
   *   2. Se o resultado tiver menos que `count`, preenche com faixas do `pool`
   *      não-selecionadas, respeitando a mesma restrição.
   *   3. Se ainda faltar, relaxa a restrição e preenche com qualquer faixa.
   *
   * @param {object[]} selected  — faixas escolhidas pelo Ollama
   * @param {object[]} pool      — conjunto de candidatos completo
   * @param {number}   count     — tamanho desejado da playlist
   * @returns {object[]}
   */
  _diversifyArtists(selected, pool, count) {
    // Limite por artista: cresce muito lentamente, teto de 5.
    // count=10→2, count=50→2, count=100→4, count=200→5
    const maxPerArtist = Math.min(5, Math.max(2, Math.ceil(count / 25)));

    const perArtist   = new Map();
    const keptKeys    = new Set();
    const kept        = [];

    const mayAdd = (t) => {
      const key    = String(t.ratingKey);
      if (keptKeys.has(key)) return false;
      const artist = (t.grandparentTitle || '?').toLowerCase();
      const n      = perArtist.get(artist) || 0;
      if (n >= maxPerArtist) return false;
      kept.push(t);
      keptKeys.add(key);
      perArtist.set(artist, n + 1);
      return true;
    };

    // Pass 1: preferência do Ollama, com limite por artista
    for (const t of selected) mayAdd(t);

    // Pass 2: preenche gaps com o restante do pool (mesma restrição)
    if (kept.length < count) {
      const selectedKeys = new Set(selected.map(t => String(t.ratingKey)));
      for (const t of pool) {
        if (kept.length >= count) break;
        if (!selectedKeys.has(String(t.ratingKey))) mayAdd(t);
      }
    }

    // Pass 3: relaxa restrição se ainda faltar
    if (kept.length < count) {
      for (const t of pool) {
        if (kept.length >= count) break;
        if (!keptKeys.has(String(t.ratingKey))) {
          kept.push(t);
          keptKeys.add(String(t.ratingKey));
        }
      }
    }

    logger.debug('PLAYLIST', `_diversifyArtists: ${selected.length} → ${kept.length} (max ${maxPerArtist}/artista)`);
    return kept.slice(0, count);
  }

  /**
   * Garante que pelo menos DISCOVERY_RATIO (30%) das faixas da playlist sejam
   * faixas pouco ouvidas da biblioteca.
   *
   * Definição de "discovery": faixas no quartil inferior de viewCount do pool
   * (bottom 40% por contagem de reproduções — garante reservoir suficiente).
   * Se a maioria das faixas nunca foi ouvida (viewCount=0), essas dominam o
   * conjunto de discovery naturalmente.
   *
   * Algoritmo:
   *   1. Calcula a cota mínima de discovery (ceil(count * DISCOVERY_RATIO)).
   *   2. Conta quantas faixas já selecionadas satisfazem o critério.
   *   3. Se suficiente, retorna sem alterações.
   *   4. Caso contrário, substitui as faixas mais ouvidas não-discovery por
   *      candidatos discovery ainda não presentes, preservando a ordem.
   *
   * @param {object[]} selected  — faixas já processadas por _diversifyArtists
   * @param {object[]} pool      — candidatos completos (com viewCount do Plex)
   * @param {number}   count     — tamanho desejado
   * @param {number}   [ratio]   — fração mínima de discovery (padrão 0.30)
   * @returns {object[]}
   */
  _ensureDiscovery(selected, pool, count, ratio = PlaylistBuilder.DISCOVERY_RATIO) {
    const needed = Math.ceil(count * ratio);
    if (needed <= 0 || !pool.length) return selected;

    // Constrói conjunto de discovery: bottom 40% do pool por viewCount
    const sorted = [...pool].sort((a, b) => (a.viewCount || 0) - (b.viewCount || 0));
    const discoverySize = Math.ceil(sorted.length * 0.4);
    const discoveryKeys = new Set(sorted.slice(0, discoverySize).map((t) => String(t.ratingKey)));
    const isDiscovery = (t) => discoveryKeys.has(String(t.ratingKey));

    const currentDiscovery = selected.filter(isDiscovery).length;
    if (currentDiscovery >= needed) {
      logger.debug('PLAYLIST', `_ensureDiscovery: ${currentDiscovery}/${selected.length} discovery — OK`);
      return selected;
    }

    // Faixas discovery disponíveis que ainda não estão na seleção
    const selectedKeys = new Set(selected.map((t) => String(t.ratingKey)));
    const availableDiscovery = sorted
      .slice(0, discoverySize)
      .filter((t) => !selectedKeys.has(String(t.ratingKey)));

    if (!availableDiscovery.length) return selected; // não há mais para trocar

    const toReplace = Math.min(needed - currentDiscovery, availableDiscovery.length);

    // Identifica índices a substituir: faixas mais ouvidas que não são discovery
    const swapCandidates = selected
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => !isDiscovery(t))
      .sort((a, b) => (b.t.viewCount || 0) - (a.t.viewCount || 0)) // mais ouvidas primeiro
      .slice(0, toReplace)
      .map(({ i }) => i);

    const result = [...selected];
    for (let j = 0; j < swapCandidates.length; j++) {
      result[swapCandidates[j]] = availableDiscovery[j];
    }

    logger.debug(
      'PLAYLIST',
      `_ensureDiscovery: ${swapCandidates.length} substituída(s) → ${currentDiscovery + swapCandidates.length}/${result.length} discovery`,
    );
    return result;
  }

  /**
   * Limita N faixas por artista em entradas do cache.
   * @param {object[]} entries      — saída do torneio/seleção
   * @param {number}   maxPerArtist — máximo de faixas por artista
   * @param {object[]} pool         — candidatos completos para preencher gaps
   * @returns {object[]}
   * @private
   */
  _applyMaxPerArtistCache(entries, maxPerArtist, pool) {
    const perArtist = new Map();
    const keptKeys  = new Set();
    const kept      = [];

    const mayAdd = (e) => {
      const key    = String(e.ratingKey);
      if (keptKeys.has(key)) return false;
      const artist = (e.artist || '?').toLowerCase();
      const n      = perArtist.get(artist) || 0;
      if (n >= maxPerArtist) return false;
      kept.push(e);
      keptKeys.add(key);
      perArtist.set(artist, n + 1);
      return true;
    };

    // Pass 1: preferência do torneio
    for (const e of entries) mayAdd(e);

    // Pass 2: preenche gaps com o pool (mesma restrição)
    if (kept.length < entries.length) {
      const entryKeys = new Set(entries.map(e => String(e.ratingKey)));
      for (const e of pool) {
        if (kept.length >= entries.length) break;
        if (!entryKeys.has(String(e.ratingKey))) mayAdd(e);
      }
    }

    // Pass 3: relaxa restrição se ainda faltar
    if (kept.length < entries.length) {
      for (const e of pool) {
        if (kept.length >= entries.length) break;
        if (!keptKeys.has(String(e.ratingKey))) {
          kept.push(e);
          keptKeys.add(String(e.ratingKey));
        }
      }
    }

    logger.debug('PLAYLIST', `_applyMaxPerArtistCache: ${entries.length} → ${kept.length} (max ${maxPerArtist}/artista)`);
    return kept;
  }

  /**
   * Decora entradas do cache com viewCount do Plex.
   * Usa libraryScanner (cached em memória) — sem custo extra de rede.
   * @param {object[]} entries — entradas do analysis cache
   * @returns {Promise<object[]>} mesmas entradas com .viewCount adicionado
   * @private
   */
  async _enrichWithViewCount(entries) {
    try {
      const { tracks } = await this.libraryScanner.scan();
      const vcMap = new Map(tracks.map(t => [String(t.ratingKey), t.viewCount || 0]));
      return entries.map(e => ({ ...e, viewCount: vcMap.get(String(e.ratingKey)) ?? 0 }));
    } catch {
      return entries.map(e => ({ ...e, viewCount: 0 }));
    }
  }

  /**
   * Garante que pelo menos `ratio` das faixas selecionadas sejam pouco ouvidas.
   * Discovery = bottom 40% do pool por viewCount.
   * @param {object[]} selected — entradas enriquecidas com .viewCount
   * @param {object[]} pool     — candidatos completos enriquecidos com .viewCount
   * @param {number}   size     — tamanho alvo
   * @param {number}   ratio    — fração mínima de discovery (ex: 0.30)
   * @returns {object[]}
   * @private
   */
  _ensureDiscoveryCacheEntries(selected, pool, size, ratio = 0.30) {
    const needed = Math.ceil(size * ratio);
    if (needed <= 0 || !pool.length) return selected;

    const sorted       = [...pool].sort((a, b) => (a.viewCount || 0) - (b.viewCount || 0));
    const discoverySize = Math.ceil(sorted.length * 0.4);
    const discoveryKeys = new Set(sorted.slice(0, discoverySize).map(e => String(e.ratingKey)));
    const isDiscovery   = (e) => discoveryKeys.has(String(e.ratingKey));

    const currentDiscovery = selected.filter(isDiscovery).length;
    if (currentDiscovery >= needed) {
      logger.debug('PLAYLIST', `_ensureDiscoveryCacheEntries: ${currentDiscovery}/${selected.length} discovery — OK`);
      return selected;
    }

    const selectedKeys       = new Set(selected.map(e => String(e.ratingKey)));
    const availableDiscovery = sorted.slice(0, discoverySize).filter(e => !selectedKeys.has(String(e.ratingKey)));
    if (!availableDiscovery.length) return selected;

    const toReplace      = Math.min(needed - currentDiscovery, availableDiscovery.length);
    const swapCandidates = selected
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => !isDiscovery(e))
      .sort((a, b) => (b.e.viewCount || 0) - (a.e.viewCount || 0))
      .slice(0, toReplace)
      .map(({ i }) => i);

    const result = [...selected];
    for (let j = 0; j < swapCandidates.length; j++) {
      result[swapCandidates[j]] = availableDiscovery[j];
    }

    logger.debug('PLAYLIST', `_ensureDiscoveryCacheEntries: ${swapCandidates.length} trocada(s) → ${currentDiscovery + swapCandidates.length}/${result.length} discovery (ratio=${ratio})`);
    return result;
  }

  _autoName({ mood, genre }) {
    const date = new Date().toLocaleDateString("pt-BR");
    if (mood && genre) return `${genre} ${mood} — ${date}`;
    if (mood) return `Playlist ${mood} — ${date}`;
    if (genre) return `${genre} Mix — ${date}`;
    return `Mix — ${date}`;
  }

  _emptyPlaylist(name, { mood, genre } = {}) {
    return {
      id: randomUUID(),
      name,
      mood: mood || null,
      genre: genre || null,
      tracks: [],
      createdAt: new Date().toISOString(),
    };
  }

  // ── Detecção de região por idioma ──────────────────────────────────────────

  /**
   * Tabela de perfis linguísticos por região.
   * Cada entrada define:
   *   - patterns: regexes que fortemente indicam o idioma (presença = score positivo)
   *   - negPatterns: regexes que indicam outro idioma (presença = penalidade)
   * O score final é a proporção de padrões que batem, com peso 1 por pattern.
   */
  static _REGION_PROFILES = {
    Brazil:         { patterns: [/[àáâãäçéêíóôõúü]/i, /\b(de|do|da|das|dos|que|uma?|não|com|por|para)\b/i], negPatterns: [] },
    Portugal:       { patterns: [/[àáâãäçéêíóôõúü]/i, /\b(de|do|da|das|dos|que|uma?|não|com|por|para)\b/i], negPatterns: [] },
    Spain:          { patterns: [/[áéíóúüñ¡¿]/i,      /\b(de|la|el|los|las|que|una?|es|con|por)\b/i],        negPatterns: [] },
    Mexico:         { patterns: [/[áéíóúüñ¡¿]/i,      /\b(de|la|el|los|las|que|una?|es|con|por)\b/i],        negPatterns: [] },
    France:         { patterns: [/[àâæçéèêëîïôœùûüÿ]/, /\b(de|la|le|les|du|un|une|et|en|au)\b/i],            negPatterns: [] },
    Japan:          { patterns: [/[\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/],                                  negPatterns: [] },
    Korea:          { patterns: [/[\uAC00-\uD7A3\u1100-\u11FF]/],                                              negPatterns: [] },
    China:          { patterns: [/[\u4e00-\u9fff\u3400-\u4DBF]/],                                              negPatterns: [] },
    Italy:          { patterns: [/[àèéìíîóòùú]/i,     /\b(di|la|il|le|gli|del|dell|delle|dei|degli|una?|e|è|con|per)\b/i], negPatterns: [] },
    Germany:        { patterns: [/[äöüÄÖÜß]/,         /\b(der|die|das|und|ist|ich|du|ein|eine|nicht)\b/i],   negPatterns: [] },
    "United States":{ patterns: [/^[a-z0-9 ',.\-!?&]+$/i], negPatterns: [/[àáâãäçéêíóôõúüñäöüÄÖÜß\u3040-\uffef]/] },
    "United Kingdom":{ patterns: [/^[a-z0-9 ',.\-!?&]+$/i], negPatterns: [/[àáâãäçéêíóôõúüñäöüÄÖÜß\u3040-\uffef]/] },
  };

  /**
   * Calcula um score linguístico [0..1] para um texto em relação a um perfil de região.
   * Verifica patterns no texto (title + artist + album concatenados).
   */
  _languageScore(text, regionName) {
    const profile = PlaylistBuilder._REGION_PROFILES[regionName];
    if (!profile) return 0;

    const { patterns, negPatterns } = profile;
    const positiveHits = patterns.filter(rx => rx.test(text)).length;
    const negHits      = negPatterns.filter(rx => rx.test(text)).length;

    const score = patterns.length > 0 ? positiveHits / patterns.length : 0;
    const penalty = negPatterns.length > 0 ? negHits / negPatterns.length : 0;
    return Math.max(0, score - penalty);
  }

  /**
   * Pré-filtra candidatos por idioma/região.
   *
   * Estratégia:
   *  1. Calcula score linguístico para cada faixa (title + artist + album).
   *  2. Separa em dois grupos: `matched` (score > 0) e `unmatched` (score = 0).
   *  3. Se matched >= size, retorna apenas matched (ordenados por score desc).
   *  4. Se matched < size mas razoável (>= 30% de size), retorna matched +
   *     suficiente de unmatched para compor `size * 3` candidatos.
   *  5. Se matched for muito pequeno (<30% de size) ou região desconhecida,
   *     retorna o pool original (sem filtrar — fallback seguro).
   *
   * O filtro é intencionalm aplicado ANTES do envio ao LLM, que continua
   * recebendo a instrução "Select ONLY tracks from [region]" como segunda barreira.
   *
   * @param {object[]} candidates  — pool já pré-filtrado por gênero/diversidade
   * @param {string}   region      — nome da região em inglês
   * @param {number}   size        — tamanho desejado da playlist
   * @returns {object[]}
   */
  _filterByLanguage(candidates, region, size) {
    if (!region || !PlaylistBuilder._REGION_PROFILES[region]) return candidates;

    const scored = candidates.map(t => {
      const text = `${t.title} ${t.grandparentTitle} ${t.parentTitle}`;
      return { t, score: this._languageScore(text, region) };
    });

    const matched   = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => s.t);
    const unmatched = scored.filter(s => s.score === 0).map(s => s.t);

    logger.debug('PLAYLIST', `_filterByLanguage(${region}): ${matched.length} matched / ${candidates.length} total`);

    if (matched.length >= size) {
      return matched; // pool puramente regional
    }
    if (matched.length >= Math.ceil(size * 0.3)) {
      // Inclui apenas o mínimo de não-regionais para completar `size` candidatos.
      // Os matched ficam na frente e dominam o pool — o gap-fill do torneio e de
      // _diversifyArtists também será majoritariamente regional.
      // (Não usar `size * 3` pois isso inunda o pool com não-regionais e o LLM
      // e o gap-fill acabam selecionando músicas do idioma errado.)
      const fill = unmatched.slice(0, Math.max(0, size - matched.length));
      return [...matched, ...fill];
    }
    // Biblioteca sem marcadores linguísticos suficientes — não filtra
    logger.debug('PLAYLIST', `_filterByLanguage(${region}): poucos matches — sem filtro`);
    return candidates;
  }

  /** Converte uma faixa para linha compacta ID|Título|Artista|Álbum */
  _toTrackLine(t) {
    const clean = (s) => String(s ?? '').replace(/\|/g, '-');
    return `${t.ratingKey}|${clean(t.title)}|${clean(t.grandparentTitle)}|${clean(t.parentTitle)}`;
  }

  /** Prompt compacto que pede apenas os IDs das faixas selecionadas */
  _buildCompactPrompt({ criteria, trackLines, size, region = null }) {
    const regionConstraint = region
      ? `\nIMPORTANT: Select ONLY tracks from ${region}. Exclude any track from other countries or regions.`
      : '';
    return `You are a DJ. Select exactly ${size} tracks that best match: ${criteria}.${regionConstraint}
Tracks (ID|Title|Artist|Album):
${trackLines.join('\n')}

Return ONLY a JSON array of the numeric track IDs of the ${size} selected tracks.
Example: [1234, 5678, 9012]`;
  }

  /**
   * Seleciona `count` faixas de `pool` via Ollama (formato compacto).
   * Mapeia os IDs retornados de volta para os objetos de faixa originais.
   * Se Ollama retornar poucos IDs válidos, completa com faixas aleatórias do pool.
   */
  async _selectTracksOllama(pool, criteria, count, region = null) {
    const lines = pool.map(t => this._toTrackLine(t));
    const prompt = this._buildCompactPrompt({ criteria, trackLines: lines, size: count, region });

    // ~8 tokens per numeric ID (digits + comma + space); minimum 300
    const maxTokens = Math.max(300, count * 8);
    const raw = await this.allfather.askForJSON(prompt, { temperature: 0.6, maxTokens });
    const keys = Array.isArray(raw) ? raw : [];

    if (!keys.length) return pool.slice(0, count);

    const byKey = new Map(pool.map(t => [String(t.ratingKey), t]));
    const seenKeys = new Set();
    const selected = keys.map(k => {
      // Ollama às vezes ignora a instrução e retorna objetos em vez de IDs
      const id = typeof k === 'object' && k !== null
        ? String(k.ratingKey ?? k.id ?? '')
        : String(k);
      return byKey.get(id);
    }).filter(t => {
      if (!t) return false;
      const key = String(t.ratingKey);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    // Completa se Ollama retornou menos IDs válidos do que o pedido
    if (selected.length < count) {
      const selectedSet = new Set(selected.map(t => String(t.ratingKey)));
      const extra = pool.filter(t => !selectedSet.has(String(t.ratingKey)));
      selected.push(...extra.slice(0, count - selected.length));
    }

    return selected.slice(0, count);
  }

  /**
   * Torneio de seleção em lotes para bibliotecas grandes.
   * Divide candidatos em batches de `batchSize`, elege semifinalistas de cada um,
   * depois faz um passe final para escolher as melhores `size` faixas.
   * Isso evita prompts gigantes e timeouts no Ollama.
   */
  async _selectTracksTournament(candidates, criteria, size, batchSize, region = null) {
    const batches = [];
    for (let i = 0; i < candidates.length; i += batchSize) {
      batches.push(candidates.slice(i, i + batchSize));
    }

    // Cada lote contribui com semifinalistas proporcionais ao tamanho do lote
    const nPerBatch = Math.max(8, Math.ceil(size * batchSize / candidates.length * 2));
    logger.debug("PLAYLIST", `Torneio: ${batches.length} lotes × ${batchSize} faixas → ${nPerBatch} semifinalistas/lote`);

    const semifinalists = [];
    const seen = new Set();
    for (const [i, batch] of batches.entries()) {
      logger.debug("PLAYLIST", `Lote ${i + 1}/${batches.length}: ${batch.length} faixas`);
      const picks = await this._selectTracksOllama(batch, criteria, nPerBatch, region);
      for (const t of picks) {
        const key = String(t.ratingKey);
        if (!seen.has(key)) { seen.add(key); semifinalists.push(t); }
      }
    }

    logger.debug("PLAYLIST", `Semifinalistas: ${semifinalists.length} → seleção final de ${size}`);

    if (semifinalists.length <= size) return semifinalists;

    // Passe final: escolhe os melhores `size` do pool de semifinalistas.
    // Usa max(batchSize, size) entradas para que quando o tamanho pedido seja
    // maior que batchSize (e.g. 150 > 50), o Ollama receba tracks suficientes
    // para cumprir o pedido sem forçar gap-fill com faixas não-regionais.
    const finalPoolSize = Math.min(semifinalists.length, Math.max(batchSize, size));
    const finalPool = semifinalists.slice(0, finalPoolSize);
    logger.debug("PLAYLIST", `Passe final: ${finalPool.length} semifinalistas → seleção de ${size}`);
    return this._selectTracksOllama(finalPool, criteria, size, region);
  }

  // ── Cache-based playlist generation ──────────────────────────────────────

  /**
   * Converte uma entrada do AnalysisCacheService para linha compacta de perfil de áudio.
   * Formato: ID|Título|Artista|Gênero/Subgênero|Mood|E:{energy}|V:{valence}|D:{danceability}|A:{acousticness}|{tempo}|{era}|{emotionalTags}
   * @private
   */
  _toCachedTrackLine(entry) {
    const a = entry.analysis || {};
    const clean = (s) => String(s ?? '').replace(/\|/g, '-');
    const cleanArr = (arr, max = 4) =>
      Array.isArray(arr) ? arr.slice(0, max).map(s => clean(s)).join(',') : '';
    const genre = [
      a.genre && a.genre !== 'Unknown' ? a.genre : null,
      a.subgenre && a.subgenre !== 'unknown' ? a.subgenre : null,
    ].filter(Boolean).join('/') || 'Unknown';
    return [
      entry.ratingKey,
      clean(entry.title),
      clean(entry.artist),
      clean(genre),
      clean(a.mood      || '?'),
      `E:${a.energy        ?? '?'}`,
      `V:${a.valence       ?? '?'}`,
      `D:${a.danceability  ?? '?'}`,
      `A:${a.acousticness  ?? '?'}`,
      `C:${a.complexity    ?? '?'}`,
      a.bpm                        ? `${a.bpm}bpm`    : '?',
      clean(a.key          || '?'),
      clean(a.tempo        || '?'),
      clean(a.rhythmPattern|| '?'),
      clean(a.timbre       || '?'),
      clean(a.dynamics     || '?'),
      clean(a.texture      || '?'),
      clean(a.vocalStyle   || '?'),
      clean(a.productionStyle || '?'),
      clean(a.era          || '?'),
      cleanArr(a.characteristics),
      cleanArr(a.instruments),
      cleanArr(a.emotionalTags, 3),
    ].join('|');
  }

  /** @private */
  _buildCacheSelectionPrompt({ criteria, trackLines, size }) {
    return `You are a DJ. Select exactly ${size} tracks that best match: ${criteria}.

Tracks (ID|Title|Artist|Genre|Mood|E:Energy/10|V:Valence/10|D:Danceability/10|A:Acousticness/10|C:Complexity/10|BPM|Key|Tempo|RhythmPattern|Timbre|Dynamics|Texture|VocalStyle|ProductionStyle|Era|Characteristics|Instruments|EmotionalTags):
${trackLines.join('\n')}

Return ONLY a JSON array of the numeric track IDs of the ${size} selected tracks. Example: [1234, 5678]`;
  }

  /**
   * Seleciona `count` entradas do cache via Ollama usando perfis de áudio.
   * @private
   */
  async _selectCachedTracksOllama(entries, criteria, count) {
    const lines  = entries.map(e => this._toCachedTrackLine(e));
    const prompt = this._buildCacheSelectionPrompt({ criteria, trackLines: lines, size: count });
    const maxTokens = Math.max(2048, count * 64);
    const raw  = await this.allfather.askForJSON(prompt, { temperature: 0.6, maxTokens, disableReasoning: true });
    const keys = Array.isArray(raw) ? raw : [];

    if (!keys.length) return entries.slice(0, count);

    const byKey   = new Map(entries.map(e => [String(e.ratingKey), e]));
    const seenKeys = new Set();
    const selected = keys.map(k => {
      const id = typeof k === 'object' && k !== null
        ? String(k.ratingKey ?? k.id ?? '')
        : String(k);
      return byKey.get(id);
    }).filter(e => {
      if (!e) return false;
      const key = String(e.ratingKey);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    if (selected.length < count) {
      const selectedSet = new Set(selected.map(e => String(e.ratingKey)));
      selected.push(...entries.filter(e => !selectedSet.has(String(e.ratingKey))).slice(0, count - selected.length));
    }

    return selected.slice(0, count);
  }

  /**
   * Torneio de seleção em lotes sobre entradas do cache.
   * @private
   */
  async _selectCachedTracksTournament(entries, criteria, size, batchSize = 25) {
    const batches = [];
    for (let i = 0; i < entries.length; i += batchSize) {
      batches.push(entries.slice(i, i + batchSize));
    }

    const nPerBatch = Math.max(8, Math.ceil(size * batchSize / entries.length * 2));
    logger.debug('PLAYLIST', `Cache torneio: ${batches.length} lotes × ${batchSize} → ${nPerBatch} semifinalistas/lote`);

    const semifinalists = [];
    const seen = new Set();
    for (const [i, batch] of batches.entries()) {
      logger.debug('PLAYLIST', `Cache lote ${i + 1}/${batches.length}: ${batch.length} faixas`);
      const picks = await this._selectCachedTracksOllama(batch, criteria, nPerBatch);
      for (const e of picks) {
        const key = String(e.ratingKey);
        if (!seen.has(key)) { seen.add(key); semifinalists.push(e); }
      }
    }

    logger.debug('PLAYLIST', `Cache semifinalistas: ${semifinalists.length} → final ${size}`);
    if (semifinalists.length <= size) return semifinalists;

    const finalPool = semifinalists.slice(0, Math.min(semifinalists.length, Math.max(batchSize, size)));
    return this._selectCachedTracksOllama(finalPool, criteria, size);
  }

  /**
   * Pré-filtra entradas do cache por similaridade de gênero/mood para reduzir
   * o pool antes do torneio. Mantém diversidade misturando correspondências + aleatórios.
   * @private
   */
  _preFilterCacheEntries(entries, { genre, mood, energy, size = 15 } = {}) {
    const MAX = Math.max(size * 10, 150);
    if (!genre && !mood && energy == null) {
      return [...entries].sort(() => Math.random() - 0.5).slice(0, MAX);
    }

    const genreLow = genre?.toLowerCase();
    const moodLow  = mood?.toLowerCase();

    const scored = entries.map(e => {
      const a = e.analysis || {};
      let score = 0;
      if (genreLow) {
        const g = `${a.genre || ''} ${a.subgenre || ''}`.toLowerCase();
        if (g.includes(genreLow)) score += 2;
      }
      if (moodLow && (a.mood || '').toLowerCase().includes(moodLow)) score += 2;
      if (energy != null && a.energy != null) {
        score += Math.max(0, 2 - Math.abs(energy - a.energy) / 2);
      }
      return { e, score };
    }).sort((a, b) => b.score - a.score);

    const topSplit  = Math.ceil(MAX * 0.7);
    const topMatch  = scored.slice(0, topSplit);
    const fillPool  = scored.slice(topSplit).sort(() => Math.random() - 0.5).slice(0, MAX - topMatch.length);
    return [...topMatch, ...fillPool].slice(0, MAX).map(s => s.e);
  }

  /** Converte uma entrada do cache para objeto de faixa no formato das playlists. @private */
  _cachedEntryToTrack(entry) {
    return {
      ratingKey:        entry.ratingKey,
      title:            entry.title,
      grandparentTitle: entry.artist,
      parentTitle:      entry.album,
    };
  }

  /**
   * Gera uma playlist baseada nas análises do cache usando um prompt em linguagem natural.
   * O LLM recebe os perfis de áudio (gênero, mood, energia, etc.) de todas as faixas
   * analisadas e seleciona as mais adequadas ao pedido.
   *
   * @param {string} prompt           — texto livre do usuário
   * @param {object} analysisCache    — instância de AnalysisCacheService
   * @returns {Promise<object>}        playlist com id, name, tracks[], createdAt, prompt
   */
  async generateFromCacheWithPrompt(prompt, analysisCache, { maxPerArtist = 3, discoveryRatio = 0 } = {}) {
    logger.info('PLAYLIST', `generateFromCacheWithPrompt()`, { prompt, maxPerArtist, discoveryRatio });

    const allEntries = analysisCache.getAll();
    if (!allEntries.length) {
      throw new Error('Nenhuma faixa analisada no cache. Execute a análise da biblioteca primeiro.');
    }

    // Extrai parâmetros do prompt para pré-filtro e nome
    let params = { name: null, genre: null, mood: null, energy: null, size: 10 };
    try {
      params = { ...params, ...(await this.allfather.askForJSON(
        `Extract playlist parameters from this user request: "${prompt}"
Return JSON with: name (string or null), genre (string or null), mood (string or null), energy (integer 1-10 or null), size (integer, default 10)`,
        { temperature: 0.2 }
      )) };
    } catch { /* usa defaults */ }
    const size = typeof params.size === 'number' && params.size > 0 ? params.size : 10;
    logger.info('PLAYLIST', `Parâmetros extraídos do prompt`, params);

    // Pré-filtra para reduzir pool antes do torneio
    const candidates = this._preFilterCacheEntries(allEntries, {
      genre: params.genre, mood: params.mood, energy: params.energy, size,
    });
    logger.info('PLAYLIST', `Cache pré-filtro: ${allEntries.length} → ${candidates.length} candidatos`);

    const criteria  = `user request: "${prompt}"${params.genre ? `, genre: ${params.genre}` : ''}${params.mood ? `, mood: ${params.mood}` : ''}${params.energy ? `, energy: ${params.energy}/10` : ''}`;
    const BATCH     = 25;
    const t0        = Date.now();
    let selected    = candidates.length <= BATCH
      ? await this._selectCachedTracksOllama(candidates, criteria, size)
      : await this._selectCachedTracksTournament(candidates, criteria, size, BATCH);
    logger.debug('OLLAMA', `Cache prompt seleção em ${Date.now() - t0}ms`);

    // Pós-processamento: max por artista
    if (maxPerArtist > 0) {
      selected = this._applyMaxPerArtistCache(selected, maxPerArtist, candidates);
    }

    // Pós-processamento: discover (faixas pouco ouvidas)
    if (discoveryRatio > 0) {
      const enrichedSelected   = await this._enrichWithViewCount(selected);
      const enrichedCandidates = await this._enrichWithViewCount(candidates);
      selected = this._ensureDiscoveryCacheEntries(enrichedSelected, enrichedCandidates, size, discoveryRatio);
    }

    const playlist = {
      id:        randomUUID(),
      name:      params.name || this._autoName({ mood: params.mood, genre: params.genre }),
      mood:      params.mood   || null,
      genre:     params.genre  || null,
      energy:    params.energy || null,
      tracks:    selected.map(e => this._cachedEntryToTrack(e)),
      createdAt: new Date().toISOString(),
      prompt,
      source:    'cache-prompt',
    };
    logger.info('PLAYLIST', `Playlist por prompt (cache): "${playlist.name}" — ${playlist.tracks.length} faixas`);
    return playlist;
  }

  /**
   * Gera uma playlist "Radio" baseada numa faixa de referência usando o cache.
   * O LLM recebe o perfil de áudio da faixa de referência como critério e
   * seleciona as faixas do cache com sonoridade mais similar.
   * A playlist é nomeada "Radio [título da faixa]".
   *
   * @param {object} referenceAnalysis  — análise retornada por MusicAnalyzer.analyzeAudioFile()
   * @param {string} referenceTitle     — título da faixa de referência
   * @param {string} referenceRatingKey — ratingKey da faixa (excluída dos candidatos)
   * @param {object} analysisCache      — instância de AnalysisCacheService
   * @param {{ size?: number, name?: string }} options
   * @returns {Promise<object>}
   */
  async generateFromCacheWithTrack(referenceAnalysis, referenceTitle, referenceRatingKey, analysisCache, { size = 15, name, maxPerArtist = 3, discoveryRatio = 0 } = {}) {
    logger.info('PLAYLIST', `generateFromCacheWithTrack()`, { referenceTitle, size, maxPerArtist, discoveryRatio });

    const allEntries = analysisCache.getAll();
    if (!allEntries.length) {
      throw new Error('Nenhuma faixa analisada no cache. Execute a análise da biblioteca primeiro.');
    }

    // Exclui a faixa de referência dos candidatos
    const allCandidates = allEntries.filter(e => String(e.ratingKey) !== String(referenceRatingKey));

    // Pré-filtra por gênero similar
    const candidates = this._preFilterCacheEntries(allCandidates, {
      genre:  referenceAnalysis.genre !== 'Unknown' ? referenceAnalysis.genre : null,
      mood:   referenceAnalysis.mood  !== 'unknown' ? referenceAnalysis.mood  : null,
      energy: referenceAnalysis.energy,
      size,
    });
    logger.info('PLAYLIST', `Radio pré-filtro: ${allCandidates.length} → ${candidates.length} candidatos`);

    // Monta critério rico a partir do perfil da faixa de referência
    const a = referenceAnalysis;
    const criteriaLines = [
      `Find tracks sonically similar to "${referenceTitle}".`,
      `Reference audio profile: genre=${a.genre}${a.subgenre && a.subgenre !== 'unknown' ? '/' + a.subgenre : ''}`,
      `mood=${a.mood}, energy=${a.energy}/10`,
      a.valence    != null ? `valence=${a.valence}/10`       : null,
      a.danceability != null ? `danceability=${a.danceability}/10` : null,
      a.acousticness != null ? `acousticness=${a.acousticness}/10` : null,
      a.tempo  && a.tempo  !== 'unknown' ? `tempo=${a.tempo}${a.bpm ? ` ~${a.bpm}BPM` : ''}` : null,
      a.era    && a.era    !== 'unknown' ? `era=${a.era}` : null,
      a.timbre && a.timbre !== 'unknown' ? `timbre=${a.timbre}` : null,
      a.emotionalTags?.length ? `emotional feel: ${a.emotionalTags.join(', ')}` : null,
    ].filter(Boolean).join(', ');

    const BATCH    = 25;
    const t0       = Date.now();
    let selected   = candidates.length <= BATCH
      ? await this._selectCachedTracksOllama(candidates, criteriaLines, size)
      : await this._selectCachedTracksTournament(candidates, criteriaLines, size, BATCH);
    logger.debug('OLLAMA', `Radio cache seleção em ${Date.now() - t0}ms`);

    // Pós-processamento: max por artista
    if (maxPerArtist > 0) {
      selected = this._applyMaxPerArtistCache(selected, maxPerArtist, candidates);
    }

    // Pós-processamento: discovery (faixas pouco ouvidas)
    if (discoveryRatio > 0) {
      const enrichedSelected   = await this._enrichWithViewCount(selected);
      const enrichedCandidates = await this._enrichWithViewCount(candidates);
      selected = this._ensureDiscoveryCacheEntries(enrichedSelected, enrichedCandidates, size, discoveryRatio);
    }

    const playlist = {
      id:             randomUUID(),
      name:           name || `Radio ${referenceTitle}`,
      mood:           a.mood   || null,
      genre:          a.genre  || null,
      energy:         a.energy || null,
      tracks:         [
        // A música de referência é sempre a primeira faixa
        this._cachedEntryToTrack(analysisCache.get(String(referenceRatingKey))),
        ...selected.map(e => this._cachedEntryToTrack(e)),
      ],
      analysis:       referenceAnalysis,
      createdAt:      new Date().toISOString(),
      source:         'cache-track',
      referenceTitle,
    };
    logger.info('PLAYLIST', `Playlist Radio (cache): "${playlist.name}" — ${playlist.tracks.length} faixas`);
    return playlist;
  }

  _saveToDisk() {
    if (!this._storageFile) return;
    try {
      const dir = dirname(this._storageFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this._storageFile, JSON.stringify(this.list(), null, 2), "utf8");
      logger.debug("PLAYLIST", `Playlists salvas em disco (${this._store.size} total)`);
    } catch (err) {
      logger.warn("PLAYLIST", `Não foi possível salvar playlists em disco: ${err.message}`);
    }
  }

  _loadFromDisk() {
    try {
      if (existsSync(this._storageFile)) {
        const data = JSON.parse(readFileSync(this._storageFile, "utf8"));
        if (Array.isArray(data)) {
          data.forEach((p) => this._store.set(p.id, p));
        }
      }
    } catch (err) {
      // Silencia erros de leitura — store começa vazio
    }
  }
}

/** Fração mínima de faixas "discovery" (menos ouvidas) em cada playlist gerada. */
PlaylistBuilder.DISCOVERY_RATIO = 0.30;
