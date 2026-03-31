/**
 * RecommendationEngine — gera recomendações de músicas/artistas
 * que NÃO estão na biblioteca do usuário.
 *
 * Combina:
 *  - Perfil da biblioteca (topGenres, mood, energia) via MusicAnalyzer
 *  - Histórico de favoritos via HistoryService
 *  - Pergunta ao Ollama por recomendações fora da biblioteca
 */
import { logger } from "../logger.js";
export class RecommendationEngine {
  /**
   * @param {{ allfather, libraryScanner, historyService, analyzer }} config
   */
  constructor({ allfather, libraryScanner, historyService, analyzer } = {}) {
    this.allfather = allfather;
    this.libraryScanner = libraryScanner;
    this.historyService = historyService;
    this.analyzer = analyzer;
  }

  /**
   * Retorna recomendações de artistas e músicas fora da biblioteca.
   * @param {{ limit?: number }} options
   * @returns {Promise<Array<{artist, genre, description, whyRecommended}>>}
   */
  async recommend({ limit = 10 } = {}) {
    logger.info("RECOMMEND", `recommend() chamado — limit=${limit}`);
    try {
      const [favorites, profile] = await Promise.all([
        this.historyService.getFavoriteArtists(10),
        this._buildProfile(),
      ]);

      logger.debug("RECOMMEND", `Perfil: topGenres=[${(profile.topGenres||[]).join(", ")}], mood=${profile.dominantMood}, energy=${profile.avgEnergy}`);

      const existingArtists = this.libraryScanner.getArtistNames();
      const favoriteText = favorites.map((f) => `${f.artist} (${f.playCount} plays)`).join(", ");

      const prompt = this._buildRecommendationPrompt({
        limit,
        profile,
        favoriteText,
        existingArtists: existingArtists.slice(0, 50),
      });

      const t0 = Date.now();
      const raw = await this.allfather.askForJSON(prompt, { temperature: 0.7, maxTokens: 1500 });
      logger.debug("OLLAMA", `askForJSON respondeu em ${Date.now() - t0}ms`);

      const items = Array.isArray(raw) ? raw : (raw?.recommendations ?? []);

      // Filtra artistas já na biblioteca (case-insensitive)
      const existingLower = new Set(existingArtists.map((a) => a.toLowerCase()));
      const filtered = items.filter(
        (r) => r?.artist && !existingLower.has(r.artist.toLowerCase())
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
   * @param {{ limit?: number }} options
   * @returns {Promise<Array<{artist, genre, whyRecommended}>>}
   */
  async recommendArtists({ limit = 10 } = {}) {
    const recs = await this.recommend({ limit: limit + 10 }); // pede extra para compensar filtro
    return recs.slice(0, limit);
  }

  // ── Internos ─────────────────────────────────────────────────────────────

  async _buildProfile() {
    const artists = this.libraryScanner.getArtistsWithGenres().slice(0, 50);
    return this.analyzer.buildLibraryProfile(artists);
  }

  _buildRecommendationPrompt({ limit, profile, favoriteText, existingArtists }) {
    const genreText = (profile.topGenres || []).slice(0, 5).join(", ") || "various";
    const libraryList = existingArtists.join(", ");

    return `You are a music recommendation expert. Based on the listener's taste profile below, 
recommend exactly ${limit} artists or musicians they would likely enjoy that are NOT already in their library.

LISTENER TASTE PROFILE:
- Top genres: ${genreText}
- Dominant mood: ${profile.dominantMood || "varied"}
- Average energy level: ${profile.avgEnergy || 5}/10
- Most played artists recently: ${favoriteText || "unknown"}

LIBRARY (do NOT recommend these artists — they are already owned):
${libraryList}

Return a JSON array of exactly ${limit} recommendations. Each item must have:
{
  "artist": "Artist Name",
  "genre": "Primary Genre",
  "description": "One sentence description of the artist",
  "whyRecommended": "One sentence explaining why this listener would enjoy them"
}

IMPORTANT: Return ONLY the JSON array, no extra text. Do not include any artist from the library list.`;
  }
}
