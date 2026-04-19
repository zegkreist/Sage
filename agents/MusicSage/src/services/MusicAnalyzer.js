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

  /**
   * Analisa um arquivo de áudio diretamente, enviando o conteúdo de áudio para o
   * Ollama (gemma4) via campo `images` com header RIFF/WAVE (WAV mono 16 kHz).
   *
   * Retorna as mesmas características de analyzeArtist, mas derivadas do áudio
   * real em vez de apenas metadados — capturando timbre, dinâmica e instrumentação
   * de forma nativa.
   *
   * Requer: ffmpeg instalado e modelo gemma4:e4b (ou compatível) no Ollama.
   *
   * @param {string} localPath           — caminho absoluto do arquivo de áudio
   * @param {object} [meta]              — metadados opcionais para enriquecer o prompt
   * @param {string} [meta.title]
   * @param {string} [meta.artist]
   * @param {string} [meta.album]
   * @param {string[]} [meta.genres]
   * @param {object} [options]
   * @param {number} [options.maxAudioSecs=30] — máximo de segundos de áudio enviados
   * @returns {Promise<AudioAnalysis>}
   *
   * @typedef {Object} AudioAnalysis
   * @property {string}   genre
   * @property {string}   subgenre
   * @property {string}   mood
   * @property {number}   energy          — 1-10
   * @property {string}   timbre
   * @property {string}   tempo           — "slow" | "mid-tempo" | "fast"
   * @property {number}   bpm             — estimated BPM (nullable)
   * @property {string}   key             — musical key, e.g. "C major"
   * @property {string}   rhythmPattern   — e.g. "straight", "syncopated", "swing", "polyrhythmic"
   * @property {string[]} characteristics
   * @property {string[]} instruments
   * @property {string}   dynamics        — "compressed" | "dynamic" | "very dynamic"
   * @property {string}   vocalStyle
   * @property {string}   productionStyle — e.g. "lo-fi", "polished studio", "raw live recording"
   * @property {string}   era             — estimated decade/period, e.g. "1970s", "early 2000s"
   * @property {number}   acousticness    — 1-10 (1=fully electronic, 10=fully acoustic)
   * @property {number}   complexity      — 1-10 musical complexity
   * @property {number}   valence         — 1-10 (1=dark/negative, 10=bright/joyful)
   * @property {number}   danceability    — 1-10
   * @property {string}   texture         — "sparse" | "moderate" | "dense"
   * @property {string[]} emotionalTags   — emotional descriptors, e.g. ["nostalgic","rebellious"]
   */
  async analyzeAudioFile(localPath, meta = {}, options = {}) {
    const FALLBACK = {
      genre:           meta.genres?.[0] || "Unknown",
      subgenre:        "unknown",
      mood:            "unknown",
      energy:          5,
      timbre:          "unknown",
      tempo:           "unknown",
      bpm:             null,
      key:             "unknown",
      rhythmPattern:   "unknown",
      characteristics: [],
      instruments:     [],
      dynamics:        "unknown",
      vocalStyle:      "unknown",
      productionStyle: "unknown",
      era:             "unknown",
      acousticness:    5,
      complexity:      5,
      valence:         5,
      danceability:    5,
      texture:         "moderate",
      emotionalTags:   [],
    };

    const metaHint = [
      meta.title  ? `Title: "${meta.title}"`   : null,
      meta.artist ? `Artist: "${meta.artist}"` : null,
      meta.album  ? `Album: "${meta.album}"`   : null,
      meta.genres?.length ? `Plex genre tags: ${meta.genres.join(", ")}` : null,
    ].filter(Boolean).join("\n");

    const prompt = `You are a music analysis expert. Listen to this audio track and provide a detailed structured characterization.
${metaHint ? metaHint + "\n" : ""}
Analyze the actual audio content you hear deeply — timbre, rhythm, mood, energy, instruments, production, era.

Return a JSON object with EXACTLY these fields (no extras, no omissions):
{
  "genre": "primary genre string (e.g. 'Rock', 'Jazz', 'Electronic')",
  "subgenre": "more specific subgenre (e.g. 'Progressive Rock', 'Bebop', 'Ambient Techno')",
  "mood": "one dominant mood word (e.g. introspective, energetic, melancholic, upbeat, aggressive, peaceful, tense, euphoric)",
  "energy": <integer 1-10>,
  "timbre": "short description of overall sound texture (e.g. 'warm acoustic', 'distorted electric', 'lush orchestral', 'cold synthetic')",
  "tempo": "slow|mid-tempo|fast",
  "bpm": <estimated integer BPM or null if unclear>,
  "key": "estimated musical key, e.g. 'C major', 'A minor', 'unknown'",
  "rhythmPattern": "straight|syncopated|swing|shuffle|polyrhythmic|rubato|irregular",
  "characteristics": ["3-6 key musical characteristics you hear"],
  "instruments": ["list of instruments you can detect in the audio"],
  "dynamics": "compressed|dynamic|very dynamic",
  "vocalStyle": "description of vocals (e.g. 'clean male baritone', 'processed female', 'choral', 'rap/spoken word') or 'none' if instrumental",
  "productionStyle": "lo-fi|polished studio|raw live|overproduced|organic|experimental",
  "era": "estimated decade or period (e.g. '1960s', '1980s', '1990s', '2010s', 'contemporary')",
  "acousticness": <integer 1-10, where 1=fully electronic/synthetic and 10=fully acoustic/organic>,
  "complexity": <integer 1-10, where 1=very simple/repetitive and 10=highly complex/progressive>,
  "valence": <integer 1-10, where 1=very dark/sad/negative and 10=very bright/happy/positive>,
  "danceability": <integer 1-10, where 1=not danceable and 10=extremely danceable>,
  "texture": "sparse|moderate|dense",
  "emotionalTags": ["2-5 emotional or atmospheric descriptors, e.g. 'nostalgic', 'rebellious', 'dreamy', 'intense', 'sensual'"]
}`;

    try {
      const result = await this.allfather.askForJSONWithAudio(prompt, localPath, {
        temperature:   0.3,
        maxAudioSecs:  options.maxAudioSecs ?? 30,
      });
      if (!result || typeof result !== "object") {
        console.error(`[MusicAnalyzer] Resposta inválida (não-objeto) para "${localPath}":`, result);
        return FALLBACK;
      }
      return { ...FALLBACK, ...result };
    } catch (err) {
      console.error(`[MusicAnalyzer] Falha na análise de áudio "${localPath}": ${err.message}`);
      return FALLBACK;
    }
  }
}
