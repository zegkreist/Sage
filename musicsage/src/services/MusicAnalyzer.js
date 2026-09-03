/**
 * MusicAnalyzer — análise musical via AllFather (Ollama)
 *
 * Usa askForJSON para obter análises estruturadas sobre:
 *   - Gênero, mood, energia, timbre de um artista
 *   - Perfil agregado da biblioteca
 *   - Padrões de escuta com base no histórico
 */
// Tags do Last.fm completamente irrelevantes (meta-tags pessoais)
const META_TAG_RE = /^(seen live|favorites?|loved?|best|all|under \d+|spotify)$/i;

// Tags que indicam era/década (usadas para preencher `era`, não gênero)
const ERA_TAG_RE = /^(\d{2}|\d{4})s$/i;

// Palavras que descrevem humor/emoção — enriquecem `emotionalTags`
const MOOD_WORDS = new Set([
  "melancholic", "melancholy", "dark", "sad", "happy", "upbeat", "energetic",
  "aggressive", "relaxing", "calm", "peaceful", "emotional", "romantic", "epic",
  "euphoric", "nostalgic", "dreamy", "atmospheric", "intense", "chill", "mellow",
  "haunting", "groovy", "psychedelic", "hypnotic", "rebellious", "sensual",
  "introspective", "trippy", "ethereal", "powerful", "raw", "bittersweet",
  "soulful", "angry", "joyful", "melancholy", "heavy", "feel-good",
]);

// Tags que descrevem instrumentação/voz — enriquecem `characteristics`
const DESCRIPTOR_WORDS = new Set([
  "instrumental", "acoustic", "electric", "orchestral", "vocal",
  "female vocalists", "male vocalists", "a cappella",
]);

function _isMetaTag(tag) {
  return !tag || tag.length < 3 || META_TAG_RE.test(tag.trim());
}

function _isEraTag(tag) {
  return ERA_TAG_RE.test(tag.trim());
}

/** Normaliza "80s" → "1980s", "10s" → "2010s", "2000s" → "2000s" */
function _normalizeEra(tag) {
  const m = tag.trim().match(/^(\d{2}|\d{4})s$/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  if (n >= 1900) return `${n}s`; // já é 4 dígitos
  return n >= 20 ? `19${String(n).padStart(2, "0")}s` : `20${String(n).padStart(2, "0")}s`;
}

function _isMoodTag(tag) {
  return MOOD_WORDS.has(tag.toLowerCase().trim());
}

function _isDescriptorTag(tag) {
  const t = tag.toLowerCase().trim();
  return [...DESCRIPTOR_WORDS].some(d => t.includes(d));
}

/**
 * Classifica uma tag do Last.fm em categorias mutuamente exclusivas.
 * @returns {"meta"|"era"|"mood"|"descriptor"|"genre"}
 */
function _classifyTag(tag) {
  if (_isMetaTag(tag))      return "meta";
  if (_isEraTag(tag))       return "era";
  if (_isMoodTag(tag))      return "mood";
  if (_isDescriptorTag(tag)) return "descriptor";
  return "genre";
}

/**
 * Mescla tags do Last.fm nos campos corretos da análise.
 * Prioridade: trackTags > artistTags (faixa é mais específica que artista).
 *
 * Campos afetados:
 *   genre       — 1ª tag de gênero (Last.fm > Ollama)
 *   subgenre    — 2ª tag de gênero (Last.fm > Ollama)
 *   era         — 1ª tag de era, se analysis.era === "unknown"
 *   emotionalTags — tags de humor do Last.fm + as do Ollama (deduplicadas)
 *   characteristics — descritores do Last.fm + extras de gênero (deduplicados)
 *   lastFm      — raw: { trackTags, artistTags, allClean } para referência futura
 */
function _applyLastFmTags(analysis, trackTags = [], artistTags = []) {
  // Deduplica mantendo ordem (track tem prioridade)
  const seen = new Set();
  const merged = [...trackTags, ...artistTags].filter(t => {
    const key = t.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const byKind = { genre: [], era: [], mood: [], descriptor: [] };
  for (const tag of merged) {
    const kind = _classifyTag(tag);
    if (kind !== "meta") byKind[kind]?.push(tag);
  }
  const allClean = [...byKind.genre, ...byKind.era, ...byKind.mood, ...byKind.descriptor];

  // ── genre / subgenre ────────────────────────────────────────────────────
  if (byKind.genre.length > 0) {
    analysis.genre = byKind.genre[0];
    if (byKind.genre.length > 1 &&
        byKind.genre[1].toLowerCase() !== byKind.genre[0].toLowerCase()) {
      analysis.subgenre = byKind.genre[1];
    }
  }

  // ── era (só preenche se Ollama não soube) ───────────────────────────────
  if (byKind.era.length > 0 && (!analysis.era || analysis.era === "unknown")) {
    analysis.era = _normalizeEra(byKind.era[0]) ?? analysis.era;
  }

  // ── emotionalTags (union das tags de humor Last.fm + Ollama) ────────────
  const existingEmotional = new Set((analysis.emotionalTags || []).map(t => t.toLowerCase()));
  const newMood = byKind.mood.filter(t => !existingEmotional.has(t.toLowerCase()));
  analysis.emotionalTags = [...(analysis.emotionalTags || []), ...newMood];

  // ── characteristics (descritores + gêneros extras) ──────────────────────
  const existingChars = new Set((analysis.characteristics || []).map(t => t.toLowerCase()));
  const extraGenres = byKind.genre.slice(2);  // 3ª tag de gênero em diante
  const extras = [...byKind.descriptor, ...extraGenres]
    .filter(t => !existingChars.has(t.toLowerCase()));
  analysis.characteristics = [...(analysis.characteristics || []), ...extras];

  // ── raw Last.fm — preservado no cache para uso futuro ───────────────────
  analysis.lastFm = { trackTags, artistTags, allClean };

  return analysis;
}

export class MusicAnalyzer {
  /**
   * @param {{ allfather: object, lastFmService?: object }} config
   *   allfather      — instância AllFather (injetada para facilitar testes)
   *   lastFmService  — instância LastFmService (opcional); se presente, enriquece genre/subgenre
   */
  constructor({ allfather, lastFmService = null } = {}) {
    this.allfather     = allfather;
    this.lastFmService = lastFmService;
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
   * Aceita artists com playCount opcional — quando presente, instrui o Ollama a ponderar
   * muito mais os artistas mais ouvidos (que refletem gosto real vs. mera posse).
   * @param {Array<{name: string, genres: string[], playCount?: number}>} artists
   * @returns {Promise<{topGenres[], dominantMood, avgEnergy, characteristics[]}>}
   */
  async buildLibraryProfile(artists = []) {
    const FALLBACK = { topGenres: [], dominantMood: "unknown", avgEnergy: 5, characteristics: [] };

    if (!artists.length) return FALLBACK;

    try {
      const hasPlayCounts = artists.some((a) => (a.playCount || 0) > 0);

      const artistSummary = artists
        .slice(0, 40)
        .map((a) => {
          const genres   = (a.genres || []).join(", ") || "unknown";
          const playStr  = hasPlayCounts && a.playCount > 0 ? ` — ${a.playCount} plays` : "";
          return `${a.name} [${genres}]${playStr}`;
        })
        .join("\n");

      const weightingNote = hasPlayCounts
        ? "Artists with more plays represent actual listening preferences — weight them MUCH more heavily than low or zero-play artists when determining taste."
        : "";

      const prompt = `Analyze this music library and create a listener taste profile.
Artists (format: Name [genres]${hasPlayCounts ? " — N plays" : ""}):
${artistSummary}

${weightingNote}

Return a JSON object with these exact fields:
{
  "topGenres": ["top genres ordered by how much the listener actually plays them, not just owns"],
  "dominantMood": "overall mood of the most-played music",
  "avgEnergy": <number 1-10, weighted toward most-played artists>,
  "characteristics": ["3-5 key characteristics of this listener's actual taste based on play counts"]
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
   * Requer: ffmpeg instalado e modelo gemma4-256k:latest (ou compatível) no Ollama.
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
      const maxAudioSecs = options.maxAudioSecs ?? 30;
      // Escala o timeout: overhead fixo de 60s + 2s por segundo de áudio (para inferência)
      const inferenceTimeout = Math.max(120_000, (maxAudioSecs * 2 + 60) * 1000);

      // Dispara Ollama + Last.fm (trackTags + artistTags) em paralelo — sem latência extra
      const lfm = this.lastFmService;
      const [result, trackTags, artistTags] = await Promise.all([
        this.allfather.askForJSONWithAudio(prompt, localPath, {
          temperature: 0.3,
          maxAudioSecs,
          timeout:     inferenceTimeout,
        }),
        lfm && meta.artist && meta.title
          ? lfm.getTrackTags(meta.artist, meta.title).catch(() => [])
          : Promise.resolve([]),
        lfm && meta.artist
          ? lfm.getArtistTags(meta.artist, 10).catch(() => [])
          : Promise.resolve([]),
      ]);

      if (!result || typeof result !== "object") {
        console.error(`[MusicAnalyzer] Resposta inválida (não-objeto) para "${localPath}":`, result);
        return FALLBACK;
      }

      const merged = { ...FALLBACK, ...result };

      // Aplica e persiste todas as tags Last.fm no objeto de análise
      if (trackTags.length || artistTags.length) {
        _applyLastFmTags(merged, trackTags, artistTags);
      }

      return merged;
    } catch (err) {
      console.error(`[MusicAnalyzer] Falha na análise de áudio "${localPath}": ${err.message}`);
      return FALLBACK;
    }
  }
}
