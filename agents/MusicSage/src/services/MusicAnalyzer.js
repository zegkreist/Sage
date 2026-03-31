/**
 * MusicAnalyzer — análise musical via AllFather (Ollama)
 *
 * Usa askForJSON para obter análises estruturadas sobre:
 *   - Gênero, mood, energia, timbre de um artista
 *   - Perfil agregado da biblioteca
 *   - Padrões de escuta com base no histórico
 */
export class MusicAnalyzer {
  /**
   * @param {{ allfather: object }} config
   *   allfather — instância AllFather (injetada para facilitar testes)
   */
  constructor({ allfather } = {}) {
    this.allfather = allfather;
  }

  /**
   * Analisa um artista e retorna características musicais.
   * @param {string} artistName
   * @param {string[]} genres — gêneros do Plex (tags)
   * @param {string[]} sampleTracks — títulos de faixas de exemplo
   * @returns {Promise<{genre, mood, energy, timbre, tempo, characteristics[]}>}
   */
  async analyzeArtist(artistName, genres = [], sampleTracks = []) {
    const FALLBACK = {
      genre: genres[0] || "Unknown",
      mood: "unknown",
      energy: 5,
      timbre: "unknown",
      tempo: "unknown",
      characteristics: [],
    };

    try {
      const prompt = `Analyze the musical artist "${artistName}" and provide a structured characterization.
Plex genre tags: ${genres.join(", ") || "none"}.
Sample tracks: ${sampleTracks.slice(0, 5).join(", ") || "unknown"}.

Return a JSON object with these exact fields:
{
  "genre": "primary genre string",
  "mood": "one word mood (e.g. introspective, energetic, melancholic, upbeat)",
  "energy": <number 1-10>,
  "timbre": "short description of timbre and sound texture",
  "tempo": "slow/mid-tempo/fast",
  "characteristics": ["array", "of", "key", "musical", "characteristics"]
}`;

      const result = await this.allfather.askForJSON(prompt, { temperature: 0.3 });
      return { ...FALLBACK, ...result };
    } catch (err) {
      console.warn(`[MusicAnalyzer] Falha ao analisar artista "${artistName}":`, err.message);
      return FALLBACK;
    }
  }

  /**
   * Constrói um perfil agregado da biblioteca.
   * @param {Array<{name: string, genres: string[]}>} artists
   * @returns {Promise<{topGenres[], dominantMood, avgEnergy, characteristics[]}>}
   */
  async buildLibraryProfile(artists = []) {
    const FALLBACK = { topGenres: [], dominantMood: "unknown", avgEnergy: 5, characteristics: [] };

    if (!artists.length) return FALLBACK;

    try {
      const artistSummary = artists
        .slice(0, 40) // limita para não explodir o prompt
        .map((a) => `${a.name} [${(a.genres || []).join(", ")}]`)
        .join("\n");

      const prompt = `Analyze this music library and create a listener taste profile.
Artists in the library (format: Name [genres]):
${artistSummary}

Return a JSON object with these exact fields:
{
  "topGenres": ["array of top genres, most common first"],
  "dominantMood": "overall mood of the library",
  "avgEnergy": <number 1-10>,
  "characteristics": ["key characteristics of this listener's taste"]
}`;

      const result = await this.allfather.askForJSON(prompt, { temperature: 0.3, maxTokens: 600 });
      return { ...FALLBACK, ...result };
    } catch (err) {
      console.warn("[MusicAnalyzer] Falha ao construir perfil da biblioteca:", err.message);
      return FALLBACK;
    }
  }

  /**
   * Analisa padrões de escuta a partir do histórico.
   * @param {Array<{title, artist, playedAt}>} history
   * @returns {Promise<{preferredGenres[], patterns[]}>}
   */
  async analyzeListeningTaste(history = []) {
    const FALLBACK = { preferredGenres: [], patterns: [] };

    if (!history.length) return FALLBACK;

    try {
      const recentArtists = [...new Set(history.slice(0, 30).map((h) => h.artist))].join(", ");

      const prompt = `Analyze this person's recent listening history and identify patterns.
Recently played artists: ${recentArtists}.

Return a JSON object with these exact fields:
{
  "preferredGenres": ["array of inferred preferred genres"],
  "patterns": ["array of listening pattern observations, e.g. prefers albums, listens late at night if detectable, etc."]
}`;

      const result = await this.allfather.askForJSON(prompt, { temperature: 0.4 });
      return { ...FALLBACK, ...result };
    } catch (err) {
      console.warn("[MusicAnalyzer] Falha ao analisar gosto musical:", err.message);
      return FALLBACK;
    }
  }
}
