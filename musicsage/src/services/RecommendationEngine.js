/**
 * RecommendationEngine — gera recomendações de músicas/artistas
 * que NÃO estão na biblioteca do usuário.
 *
 * Estratégia anti-alucinação:
 *   Quando Last.fm está disponível, o Ollama SELECIONA de uma lista de artistas reais
 *   em vez de gerar nomes livremente. Isso elimina o risco de bandas fictícias.
 *   Fallback para geração livre (sem Last.fm) usa instruções restritivas.
 *
 * Qualidade do perfil:
 *   - Histórico ponderado por playCount + recência (90 dias = 1.5×)
 *   - analysisCache cruzado com ratingKey das faixas mais tocadas
 *   - buildLibraryProfile recebe artistas ordenados por plays
 */
import { logger } from "../logger.js";

const NINETY_DAYS_SEC = 90 * 24 * 3600;

export class RecommendationEngine {
  /**
   * @param {{ allfather, libraryScanner, historyService, analyzer, lastFmService, analysisCache }} config
   */
  constructor({ allfather, libraryScanner, historyService, analyzer, lastFmService, analysisCache } = {}) {
    this.allfather      = allfather;
    this.libraryScanner = libraryScanner;
    this.historyService = historyService;
    this.analyzer       = analyzer;
    this.lastFmService  = lastFmService;
    this.analysisCache  = analysisCache || null;
  }

  /**
   * Retorna recomendações de artistas fora da biblioteca.
   * @param {{ limit?: number, genre?: string }} options
   * @returns {Promise<Array<{artist, genre, whyRecommended}>>}
   */
  async recommend({ limit = 10, genre = null } = {}) {
    logger.info("RECOMMEND", `recommend() chamado — limit=${limit}${genre ? `, genre=${genre}` : ''}`);
    try {
      // 1. Busca paralela de dados Plex
      const [favorites, recentFull] = await Promise.all([
        this.historyService.getFavoriteArtists(20),
        this.historyService.getRecentlyPlayedFull(300),
      ]);

      const existingArtists = this.libraryScanner.getArtistNames();
      const existingLower   = new Set(existingArtists.map((a) => a.toLowerCase()));

      // 2. Pool de candidatos reais via Last.fm (paralelo, top 5 artistas favoritos)
      const topSeeds         = favorites.slice(0, 5).map((f) => f.artist);
      const lastFmCandidates = await this._poolLastFmCandidates(topSeeds, existingLower);

      // 3. Perfil de biblioteca ponderado por playCount (chama Ollama)
      const profile = await this._buildProfile(favorites);
      logger.debug("RECOMMEND", `Perfil: topGenres=[${(profile.topGenres || []).join(", ")}], mood=${profile.dominantMood}, energy=${profile.avgEnergy}`);

      // 4. Contexto enriquecido a partir do analysisCache × histórico
      const topByPlayCount       = [...recentFull].sort((a, b) => b.playCount - a.playCount);
      const audioProfile         = this._buildAudioProfile(recentFull);
      const enrichedTrackContext = this._buildEnrichedFavoriteTracksContext(topByPlayCount);
      const topAnchorArtists     = favorites.slice(0, 3).map((f) => f.artist).join(", ");
      const favoriteArtistText   = favorites
        .map((f, i) => `${i + 1}. ${f.artist} (${f.playCount}×)`).join("\n");

      let raw;

      if (lastFmCandidates.length >= limit) {
        // CAMINHO PRINCIPAL: Ollama seleciona de lista real → sem alucinação
        logger.debug("RECOMMEND", `Usando ${lastFmCandidates.length} candidatos Last.fm reais como pool`);
        raw = await this._selectFromRealCandidates({
          candidates: lastFmCandidates,
          limit,
          genre,
          profile,
          favoriteArtistText,
          enrichedTrackContext,
          audioProfile,
          topAnchorArtists,
        });
      } else {
        // FALLBACK: geração livre com instruções anti-alucinação
        logger.debug("RECOMMEND", `Last.fm insuficiente (${lastFmCandidates.length} candidatos) — usando geração livre com grounding`);
        const favoriteTrackText = topByPlayCount
          .slice(0, 12)
          .map((t, i) => `${i + 1}. "${t.title}" — ${t.artist} (${t.playCount}×)`)
          .join("\n");
        raw = await this.allfather.askForJSON(
          this._buildGroundedFreePrompt({
            limit, profile, favoriteArtistText, favoriteTrackText,
            enrichedTrackContext, topAnchorArtists,
            existingArtists: existingArtists.slice(0, 50),
            genre, audioProfile,
          }),
          { temperature: 0.6, maxTokens: 2000 }
        );
      }

      const items = Array.isArray(raw) ? raw : (raw?.recommendations ?? []);

      const normalized = items.map((r) => ({
        artist:         r.artist ?? r.name ?? "",
        genre:          r.genre  ?? r.g    ?? "",
        whyRecommended: r.why    ?? r.whyRecommended ?? "",
      }));

      const filtered = normalized.filter(
        (r) => r.artist && !existingLower.has(r.artist.toLowerCase())
      );

      logger.info("RECOMMEND", `${filtered.length} recomendações geradas (${items.length - filtered.length} filtradas por já estarem na biblioteca)`);
      return filtered.slice(0, limit);
    } catch (err) {
      logger.error("RECOMMEND", `Erro ao gerar recomendações: ${err.message}`);
      return [];
    }
  }

  /**
   * Retorna recomendações focadas em artistas.
   */
  async recommendArtists({ limit = 10, genre = null } = {}) {
    const recs = await this.recommend({ limit: limit + 10, genre });
    return recs.slice(0, limit);
  }

  /**
   * Retorna artistas semelhantes a um artista dado.
   * Combina Last.fm (candidatos reais) + Ollama (curadoria + explicação).
   */
  async similarTo(seedArtist, { limit = 10 } = {}) {
    logger.info("RECOMMEND", `similarTo() chamado — seed="${seedArtist}", limit=${limit}`);
    try {
      const existingArtists = this.libraryScanner.getArtistNames();
      const existingLower   = new Set(existingArtists.map((a) => a.toLowerCase()));

      const [lastFmCandidates, seedTags] = this.lastFmService
        ? await Promise.all([
            this.lastFmService.getSimilarArtists(seedArtist, 30),
            this.lastFmService.getArtistTags(seedArtist),
          ])
        : [[], []];

      const filtered = lastFmCandidates.filter(
        (c) => !existingLower.has(c.artist.toLowerCase())
      );

      const prompt = this._buildSimilarPrompt({
        seedArtist,
        seedTags,
        candidates: filtered.slice(0, 20),
        limit,
        existingArtists: existingArtists.slice(0, 30),
      });

      const t0  = Date.now();
      const raw = await this.allfather.askForJSON(prompt, { temperature: 0.6, maxTokens: 1500 });
      logger.debug("OLLAMA", `similarTo askForJSON respondeu em ${Date.now() - t0}ms`);

      const items  = Array.isArray(raw) ? raw : [];
      const source = filtered.length > 0 ? "lastfm+ollama" : "ollama";

      const normalized = items
        .map((r) => ({
          artist:         r.artist ?? "",
          genre:          r.genre  ?? "",
          whyRecommended: r.why    ?? r.whyRecommended ?? "",
          similarity:     r.similarity ?? null,
          source,
        }))
        .filter((r) => r.artist && !existingLower.has(r.artist.toLowerCase()));

      logger.info("RECOMMEND", `similarTo("${seedArtist}"): ${normalized.length} resultados`);
      return normalized.slice(0, limit);
    } catch (err) {
      logger.error("RECOMMEND", `Erro em similarTo: ${err.message}`);
      return [];
    }
  }

  _buildSimilarPrompt({ seedArtist, seedTags, candidates, limit, existingArtists }) {
    const tagsText = seedTags.length ? seedTags.join(", ") : "unknown";
    const libList  = existingArtists.join(", ");
    const candidateSection = candidates.length
      ? `Last.fm similar artists (use as inspiration): ${candidates.map((c) => `${c.artist} (similarity: ${c.similarity.toFixed(2)})`).join(", ")}`
      : `No Last.fm data available — use your knowledge of artists similar to "${seedArtist}".`;

    return `You are a music expert. The listener enjoys "${seedArtist}" (tags: ${tagsText}).
${candidateSection}

LIBRARY (do NOT recommend these): ${libList}

Recommend exactly ${limit} artists similar to "${seedArtist}" that are NOT in the library.
Only recommend real artists with an established discography — do not invent names.
Return a JSON array:
[{"artist":"...", "genre":"...", "why":"one sentence why a fan of ${seedArtist} would enjoy them"}]
Return ONLY the JSON array.`;
  }

  /**
   * Retorna artistas DENTRO da biblioteca similares a um artista dado.
   */
  async similarInLibrary(seedArtist, { limit = 10 } = {}) {
    logger.info("RECOMMEND", `similarInLibrary() chamado — seed="${seedArtist}", limit=${limit}`);
    try {
      const existingArtists = this.libraryScanner.getArtistNames();
      const existingLower   = new Set(existingArtists.map((a) => a.toLowerCase()));

      const [lastFmCandidates, seedTags] = this.lastFmService
        ? await Promise.all([
            this.lastFmService.getSimilarArtists(seedArtist, 50),
            this.lastFmService.getArtistTags(seedArtist),
          ])
        : [[], []];

      const inLibrary  = lastFmCandidates.filter((c) => existingLower.has(c.artist.toLowerCase()));
      const tagsText   = seedTags.length ? seedTags.join(", ") : "unknown";
      const libList    = existingArtists.slice(0, 60).join(", ");
      const lastFmHint = inLibrary.length
        ? `Last.fm confirmed these library artists are similar: ${inLibrary.map((c) => c.artist).join(", ")}.`
        : `Last.fm found no direct library matches — use your musical knowledge.`;

      const prompt = `You are a music expert. The listener wants artists already in their library that are similar to "${seedArtist}" (tags: ${tagsText}).
${lastFmHint}
LIBRARY — choose artists ONLY from this list: ${libList}

Select exactly ${limit} artists from the library that are most similar to "${seedArtist}" in sound, style, or mood.
Return a JSON array:
[{"artist":"...", "genre":"...", "why":"one sentence why a fan of ${seedArtist} would enjoy them"}]
Return ONLY the JSON array.`;

      const t0  = Date.now();
      const raw = await this.allfather.askForJSON(prompt, { temperature: 0.6, maxTokens: 1000 });
      logger.debug("OLLAMA", `similarInLibrary askForJSON respondeu em ${Date.now() - t0}ms`);

      const items  = Array.isArray(raw) ? raw : [];
      const source = inLibrary.length > 0 ? "lastfm+ollama" : "ollama";

      const normalized = items
        .map((r) => ({
          artist:         r.artist ?? "",
          genre:          r.genre  ?? "",
          whyRecommended: r.why    ?? r.whyRecommended ?? "",
          similarity:     r.similarity ?? null,
          source,
          inLibrary: true,
        }))
        .filter((r) => r.artist && existingLower.has(r.artist.toLowerCase()));

      logger.info("RECOMMEND", `similarInLibrary("${seedArtist}"): ${normalized.length} resultados na biblioteca`);
      return normalized.slice(0, limit);
    } catch (err) {
      logger.error("RECOMMEND", `Erro em similarInLibrary: ${err.message}`);
      return [];
    }
  }

  /**
   * Gera recomendações a partir de um prompt em linguagem natural.
   *
   * Fluxo anti-alucinação:
   *   1. LLM recebe contexto do perfil + pedido do usuário → gera lista de candidatos
   *   2. Cada candidato é verificado no Last.fm (artist.getInfo)
   *   3. Artistas não encontrados no Last.fm são descartados com warning
   *   4. Artistas já na biblioteca são filtrados
   *
   * @param {string} userPrompt — pedido em linguagem natural
   * @param {{ limit?: number }} options
   * @returns {Promise<Array<{artist, genre, whyRecommended}>>}
   */
  async recommendByPrompt(userPrompt, { limit = 10, onProgress = null } = {}) {
    logger.info("RECOMMEND", `recommendByPrompt() — prompt="${userPrompt.slice(0, 80)}"`);
    const report = (stage, pct) => onProgress?.(stage, pct);
    report('Analisando seu perfil musical…', 10);
    try {
      const [favorites, recentFull] = await Promise.all([
        this.historyService.getFavoriteArtists(20),
        this.historyService.getRecentlyPlayedFull(300),
      ]);

      const existingArtists = this.libraryScanner.getArtistNames();
      const existingLower   = new Set(existingArtists.map((a) => a.toLowerCase()));

      const topByPlayCount     = [...recentFull].sort((a, b) => b.playCount - a.playCount);
      const audioProfile       = this._buildAudioProfile(recentFull);
      const enrichedContext    = this._buildEnrichedFavoriteTracksContext(topByPlayCount);
      const favoriteArtistText = favorites
        .slice(0, 12)
        .map((f, i) => `${i + 1}. ${f.artist} (${f.playCount}×)`)
        .join("\n");

      // Pede 3× o limite para ter buffer após validação Last.fm
      const candidateCount = Math.min(limit * 3, 30);
      const prompt = this._buildPromptRecommendationPrompt({
        userPrompt,
        candidateCount,
        favoriteArtistText,
        audioProfile,
        enrichedContext,
        existingArtists: existingArtists.slice(0, 60),
      });

      report('Pedindo sugestões à IA…', 35);
      const raw   = await this.allfather.askForJSON(prompt, { temperature: 0.65, maxTokens: 2000 });
      const items = Array.isArray(raw) ? raw : (raw?.recommendations ?? raw?.artists ?? []);
      logger.debug("RECOMMEND", `recommendByPrompt: LLM retornou ${items.length} candidatos`);

      // Validação Last.fm em lotes de 5 (paralela dentro do lote, sequencial entre lotes)
      report('Validando artistas no Last.fm…', 70);
      const validated = [];
      for (let i = 0; i < items.length; i += 5) {
        if (validated.length >= limit * 1.5) break;
        const batch  = items.slice(i, i + 5);
        const checks = await Promise.all(
          batch.map(async (item) => {
            const name = (item.artist ?? item.name ?? "").trim();
            if (!name || existingLower.has(name.toLowerCase())) return null;
            const exists = this.lastFmService
              ? await this.lastFmService.verifyArtistExists(name)
              : true;
            if (!exists) {
              logger.warn("RECOMMEND", `recommendByPrompt: "${name}" não encontrado no Last.fm — descartado`);
              return null;
            }
            return item;
          })
        );
        for (const c of checks) if (c) validated.push(c);
      }

      const normalized = validated
        .filter((r) => {
          const name = (r.artist ?? r.name ?? "").toLowerCase();
          return name && !existingLower.has(name);
        })
        .map((r) => ({
          artist:         r.artist ?? r.name ?? "",
          genre:          r.genre  ?? "",
          whyRecommended: r.why    ?? r.whyRecommended ?? "",
        }));

      logger.info("RECOMMEND", `recommendByPrompt: ${normalized.length} validados de ${items.length} gerados`);
      return normalized.slice(0, limit);
    } catch (err) {
      logger.error("RECOMMEND", `Erro em recommendByPrompt: ${err.message}`);
      return [];
    }
  }

  /**
   * Prompt afiado para recomendações por pedido livre.
   * O LLM gera candidatos; Last.fm depois valida a existência real de cada um.
   */
  _buildPromptRecommendationPrompt({
    userPrompt, candidateCount, favoriteArtistText, audioProfile, enrichedContext, existingArtists,
  }) {
    const libraryList = existingArtists.join(", ");

    let audioSection = "";
    if (audioProfile) {
      const parts = [];
      if (audioProfile.topGenres?.length)  parts.push(`genres: ${audioProfile.topGenres.join(", ")}`);
      if (audioProfile.topMoods?.length)   parts.push(`moods: ${audioProfile.topMoods.join(", ")}`);
      if (audioProfile.avgEnergy  != null) parts.push(`avg energy: ${audioProfile.avgEnergy}/10`);
      if (audioProfile.avgBpm     != null) parts.push(`avg BPM: ${audioProfile.avgBpm}`);
      if (parts.length) audioSection = `\nLISTENER AUDIO PROFILE: ${parts.join(" | ")}\n`;
    }

    let enrichedSection = "";
    if (enrichedContext) {
      enrichedSection = `\nMOST PLAYED TRACKS (use as sonic reference):\n${enrichedContext}\n`;
    }

    return `You are a music expert with encyclopedic knowledge of real, verified artists across all genres and eras.

LISTENER'S FAVORITE ARTISTS (ordered by play count):
${favoriteArtistText || "(no listening data yet)"}
${audioSection}${enrichedSection}
THE LISTENER'S REQUEST: "${userPrompt}"

YOUR TASK: Suggest exactly ${candidateCount} artists that best answer this specific request.
Use the listener's profile as contextual background — their taste informs the style, but the request takes priority.

ANTI-HALLUCINATION RULES — MANDATORY, no exceptions:
1. ONLY suggest artists that ACTUALLY EXIST with a real, released discography.
2. Every suggested artist must be findable on Last.fm, Spotify, or Wikipedia right now.
3. Do NOT invent artist names, combine words to sound like a band name, or use genre descriptors as names.
4. Do NOT suggest artists already in the listener's library: ${libraryList}
5. If you're uncertain whether an artist is real, EXCLUDE them — err on the side of fewer, real results.
6. Prefer artists with multiple studio albums, but verified niche/underground acts are acceptable.
7. If you can only find ${Math.ceil(candidateCount * 0.6)} artists that truly match, return only those.

Return a JSON array:
[{"artist": "Exact name as on Last.fm/Spotify", "genre": "Primary genre", "why": "One sentence explaining how this artist answers the listener's specific request, referencing their existing taste"}]
Return ONLY the JSON array, no preamble.`;
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  /**
   * Busca artistas similares no Last.fm para cada seed em paralelo e agrupa num pool
   * deduplicado. Artistas referenciados por mais seeds ficam no topo.
   *
   * @param {string[]} seedArtists — artistas pivot (top favoritos)
   * @param {Set<string>} existingLower — nomes da biblioteca em lowercase para filtrar
   * @returns {Promise<Array<{artist, similarity, seeds}>>}
   */
  async _poolLastFmCandidates(seedArtists, existingLower) {
    if (!this.lastFmService || !seedArtists.length) return [];

    const results = await Promise.all(
      seedArtists.map((artist) =>
        this.lastFmService
          .getSimilarArtists(artist, 25)
          .catch(() => [])
          .then((items) => items.map((c) => ({ ...c, seed: artist })))
      )
    );

    // Agrupa por artista: mantém maior similarity, acumula seeds
    const pool = new Map();
    for (const batch of results) {
      for (const c of batch) {
        if (existingLower.has(c.artist.toLowerCase())) continue;
        const key = c.artist.toLowerCase();
        if (!pool.has(key)) {
          pool.set(key, { artist: c.artist, similarity: c.similarity, seeds: [c.seed] });
        } else {
          const entry = pool.get(key);
          entry.seeds.push(c.seed);
          entry.similarity = Math.max(entry.similarity, c.similarity);
        }
      }
    }

    // Prioriza candidatos referenciados por mais artistas favoritos, depois por similarity
    return [...pool.values()].sort(
      (a, b) => b.seeds.length - a.seeds.length || b.similarity - a.similarity
    );
  }

  /**
   * Pede ao Ollama que SELECIONE de uma lista de artistas reais vindos do Last.fm.
   * O Ollama não gera nomes — apenas escolhe, ranqueia e explica.
   * Elimina o risco de alucinação de bandas fictícias.
   */
  async _selectFromRealCandidates({
    candidates, limit, genre, profile,
    favoriteArtistText, enrichedTrackContext, audioProfile, topAnchorArtists,
  }) {
    // Envia até 50 candidatos reais para o Ollama escolher
    const pool = candidates.slice(0, 50);

    const candidateList = pool
      .map((c, i) => {
        const seedsStr = c.seeds.length > 1
          ? `similar to: ${c.seeds.join(", ")}`
          : `similar to: ${c.seeds[0]}`;
        return `${i + 1}. ${c.artist} (${seedsStr} — Last.fm match: ${c.similarity.toFixed(2)})`;
      })
      .join("\n");

    // Nomes exatos para validação no prompt
    const candidateNames = pool.map((c) => c.artist);

    const genreClause  = genre ? `Prefer ${genre} genre artists from the list.` : "";
    const anchorClause = topAnchorArtists
      ? `Listener's absolute favorites: ${topAnchorArtists}.`
      : "";

    let enrichedSection = "";
    if (enrichedTrackContext) {
      enrichedSection = `
AUDIO PROFILE OF MOST PLAYED TRACKS (match these sonically when choosing):
${enrichedTrackContext}
(★recent = played in last 90 days — prioritize matching those)
`;
    }

    let audioSection = "";
    if (audioProfile) {
      const parts = [];
      if (audioProfile.topGenres?.length)  parts.push(`genres: ${audioProfile.topGenres.join(", ")}`);
      if (audioProfile.topMoods?.length)   parts.push(`moods: ${audioProfile.topMoods.join(", ")}`);
      if (audioProfile.avgEnergy != null)  parts.push(`avg energy: ${audioProfile.avgEnergy}/10`);
      if (audioProfile.avgBpm    != null)  parts.push(`avg BPM: ${audioProfile.avgBpm}`);
      if (parts.length) {
        audioSection = `\nLISTENER AUDIO PROFILE (weighted by play counts): ${parts.join(" | ")}\n`;
      }
    }

    const prompt = `You are a music curator. Select the best matches for this listener from the verified artist list below.

LISTENER'S MOST PLAYED ARTISTS:
${favoriteArtistText || "(no data)"}
${enrichedSection}${audioSection}
${anchorClause}

VERIFIED CANDIDATES — real artists confirmed by Last.fm (select ONLY from this list):
${candidateList}

${genreClause}

Rules:
- Select exactly ${limit} artists from the CANDIDATES list
- Do NOT add any artist whose name does not appear in the list above
- Prioritize candidates referenced by multiple favorite artists
- Match the sonic characteristics of the most played tracks when possible

Return a JSON array of exactly ${limit} items using ONLY the exact artist names from the list:
[{"artist":"<exact name from list>", "genre":"...", "why":"one sentence referencing which of the listener's favorites they sound like and why"}]
Return ONLY the JSON array.`;

    const t0  = Date.now();
    const raw = await this.allfather.askForJSON(prompt, { temperature: 0.5, maxTokens: 1500 });
    logger.debug("OLLAMA", `_selectFromRealCandidates respondeu em ${Date.now() - t0}ms`);

    const items = Array.isArray(raw) ? raw : (raw?.recommendations ?? []);

    // Valida: mantém apenas artistas que estavam na lista real
    const candidateSet = new Set(candidateNames.map((n) => n.toLowerCase()));
    const validated    = items.filter((r) => {
      const name = (r.artist ?? "").toLowerCase();
      const ok   = candidateSet.has(name);
      if (!ok) logger.warn("RECOMMEND", `Ollama retornou artista fora do pool: "${r.artist}" — descartado`);
      return ok;
    });

    // Se validação descartou muitos, completa com os melhores candidatos do pool
    if (validated.length < limit) {
      const usedNames    = new Set(validated.map((r) => r.artist.toLowerCase()));
      const supplement   = pool
        .filter((c) => !usedNames.has(c.artist.toLowerCase()))
        .slice(0, limit - validated.length)
        .map((c) => ({
          artist: c.artist,
          genre:  "",
          why:    `Similar to ${c.seeds[0]} (Last.fm)`,
        }));
      logger.debug("RECOMMEND", `Supplementing ${supplement.length} itens do pool Last.fm após validação`);
      validated.push(...supplement);
    }

    return validated;
  }

  /**
   * Prompt de geração livre usado como fallback quando Last.fm não está disponível.
   * Inclui instruções restritivas para minimizar alucinações.
   */
  _buildGroundedFreePrompt({
    limit, profile, favoriteArtistText, favoriteTrackText,
    enrichedTrackContext, topAnchorArtists, existingArtists, genre, audioProfile,
  }) {
    const genreText   = genre ? genre : (profile.topGenres || []).slice(0, 5).join(", ") || "various";
    const libraryList = existingArtists.join(", ");
    const genreClause = genre
      ? `Focus specifically on ${genre} genre artists.`
      : `Prioritize artists whose style matches: ${genreText}.`;
    const anchorClause = topAnchorArtists
      ? `The listener's absolute favorites: ${topAnchorArtists}. Recommendations MUST appeal to fans of these.`
      : "";
    const moodClause = profile.dominantMood
      ? `Library mood: ${profile.dominantMood}, energy: ${profile.avgEnergy || 5}/10.`
      : "";

    let enrichedSection = "";
    if (enrichedTrackContext) {
      enrichedSection = `
AUDIO PROFILE OF MOST PLAYED TRACKS (highest priority signal):
${enrichedTrackContext}
(★recent = played in last 90 days — match these especially)
`;
    }

    let audioSection = "";
    if (audioProfile) {
      const parts = [];
      if (audioProfile.avgEnergy        != null) parts.push(`• Weighted avg energy: ${audioProfile.avgEnergy}/10`);
      if (audioProfile.avgValence       != null) parts.push(`• Weighted avg valence: ${audioProfile.avgValence}/10`);
      if (audioProfile.avgDanceability  != null) parts.push(`• Weighted avg danceability: ${audioProfile.avgDanceability}/10`);
      if (audioProfile.avgBpm           != null) parts.push(`• Weighted avg BPM: ${audioProfile.avgBpm}`);
      if (audioProfile.topGenres?.length)        parts.push(`• Top genres (by plays): ${audioProfile.topGenres.join(", ")}`);
      if (audioProfile.topSubgenres?.length)     parts.push(`• Top subgenres: ${audioProfile.topSubgenres.join(", ")}`);
      if (audioProfile.topMoods?.length)         parts.push(`• Top moods (by plays): ${audioProfile.topMoods.join(", ")}`);
      if (audioProfile.topEras?.length)          parts.push(`• Dominant eras: ${audioProfile.topEras.join(", ")}`);
      if (parts.length) audioSection = `\nWEIGHTED AUDIO PROFILE (${audioProfile.totalTracks} tracks, weighted by plays):\n${parts.join("\n")}\n`;
    }

    return `You are a music recommendation expert.

The listener's MOST PLAYED ARTISTS (ordered by play count):
${favoriteArtistText || "(no data)"}

The listener's MOST PLAYED TRACKS:
${favoriteTrackText || "(no data)"}
${enrichedSection}${audioSection}
${anchorClause}
${moodClause}
${genreClause}

Recommend exactly ${limit} NEW artists that match the listener's sonic profile above.

STRICT RULES — read carefully:
1. Only recommend artists that ACTUALLY EXIST with a real, released discography.
2. Do NOT invent artist names or combine words to sound like a band name.
3. Only include artists you are confident about — if uncertain, skip them.
4. Prefer well-documented artists: multiple studio albums, verifiable Wikipedia/Discogs presence.
5. Do NOT recommend any of these (already in library): ${libraryList}

Return a JSON array of exactly ${limit} items:
[{"artist":"...", "genre":"...", "why":"one sentence referencing specific tracks or characteristics from the listener's profile"}]
Return ONLY the JSON array.`;
  }

  /**
   * Constrói o perfil da biblioteca usando artistas ponderados por playCount.
   */
  async _buildProfile(favorites = []) {
    if (favorites.length > 0) {
      const artistsWithGenres = this.libraryScanner.getArtistsWithGenres();
      const genreMap = new Map(artistsWithGenres.map((a) => [a.name.toLowerCase(), a.genres || []]));

      const enriched = favorites.slice(0, 30).map((f) => ({
        name:      f.artist,
        genres:    genreMap.get(f.artist.toLowerCase()) || [],
        playCount: f.playCount,
      }));

      if (enriched.length < 40) {
        const favNames = new Set(enriched.map((a) => a.name.toLowerCase()));
        const rest     = artistsWithGenres
          .filter((a) => !favNames.has(a.name.toLowerCase()))
          .slice(0, 40 - enriched.length)
          .map((a) => ({ name: a.name, genres: a.genres || [], playCount: 0 }));
        enriched.push(...rest);
      }

      return this.analyzer.buildLibraryProfile(enriched);
    }

    const artists = this.libraryScanner.getArtistsWithGenres().slice(0, 50);
    return this.analyzer.buildLibraryProfile(artists);
  }

  /**
   * Perfil de áudio ponderado por playCount + recência (90 dias = 1.5×).
   */
  _buildAudioProfile(recentFull = []) {
    if (!this.analysisCache) return null;
    const entries = this.analysisCache.getAll();
    if (!entries?.length) return null;

    const nowSec       = Date.now() / 1000;
    const recentCutoff = nowSec - NINETY_DAYS_SEC;

    const playMap = new Map(
      (recentFull || []).map((t) => [
        String(t.ratingKey),
        { playCount: t.playCount || 1, isRecent: (t.playedAt || 0) >= recentCutoff },
      ])
    );

    const numerics = ["energy", "valence", "danceability", "acousticness", "bpm"];
    const sums     = Object.fromEntries(numerics.map((k) => [k, 0]));
    const wts      = Object.fromEntries(numerics.map((k) => [k, 0]));
    const genreFreq = {}, subgenreFreq = {}, moodFreq = {}, eraFreq = {};

    for (const e of entries) {
      const a = e.analysis;
      if (!a) continue;
      const hist   = playMap.get(String(e.ratingKey));
      const weight = hist ? hist.playCount * (hist.isRecent ? 1.5 : 1.0) : 1;
      for (const k of numerics) {
        if (typeof a[k] === "number") { sums[k] += a[k] * weight; wts[k] += weight; }
      }
      if (a.genre)    genreFreq[a.genre]       = (genreFreq[a.genre]       || 0) + weight;
      if (a.subgenre) subgenreFreq[a.subgenre] = (subgenreFreq[a.subgenre] || 0) + weight;
      if (a.mood)     moodFreq[a.mood]         = (moodFreq[a.mood]         || 0) + weight;
      if (a.era)      eraFreq[a.era]           = (eraFreq[a.era]           || 0) + weight;
    }

    const topN = (freq, n = 5) =>
      Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
    const wavg = (k) => (wts[k] ? +(sums[k] / wts[k]).toFixed(1) : null);

    return {
      totalTracks:     entries.length,
      avgEnergy:       wavg("energy"),
      avgValence:      wavg("valence"),
      avgDanceability: wavg("danceability"),
      avgAcousticness: wavg("acousticness"),
      avgBpm:          wts.bpm ? +(sums.bpm / wts.bpm).toFixed(0) : null,
      topGenres:       topN(genreFreq),
      topSubgenres:    topN(subgenreFreq),
      topMoods:        topN(moodFreq),
      topEras:         topN(eraFreq),
    };
  }

  /**
   * Cruza as faixas mais tocadas com o analysisCache para produzir contexto sonoro real.
   * Marca com ★recent faixas tocadas nos últimos 90 dias.
   */
  _buildEnrichedFavoriteTracksContext(topByPlayCount, limit = 12) {
    if (!this.analysisCache || !topByPlayCount?.length) return null;

    const nowSec       = Date.now() / 1000;
    const recentCutoff = nowSec - NINETY_DAYS_SEC;

    const enriched = topByPlayCount
      .slice(0, Math.min(limit * 3, 60))
      .map((track) => ({ ...track, analysis: this.analysisCache.getAnalysis(track.ratingKey) }))
      .filter((t) => t.analysis)
      .slice(0, limit);

    if (!enriched.length) return null;

    return enriched
      .map((t, i) => {
        const a          = t.analysis;
        const isRecent   = (t.playedAt || 0) >= recentCutoff;
        const genreStr   = [a.genre, a.subgenre].filter(Boolean).join("/");
        const tags       = a.emotionalTags?.slice(0, 3).join(", ");
        const recentMark = isRecent ? " ★recent" : "";
        const bpmStr     = a.bpm ? `, BPM~${a.bpm}` : "";
        const tagsStr    = tags ? ` [${tags}]` : "";
        return `${i + 1}. "${t.title}" — ${t.artist} (${t.playCount}×${recentMark}): ${genreStr}, energy=${a.energy}, mood=${a.mood}${bpmStr}, timbre="${a.timbre}"${tagsStr}`;
      })
      .join("\n");
  }
}
