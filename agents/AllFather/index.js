import axios from "axios";
import fs from "fs/promises";
import { PromptTemplates } from "./src/templates.js";
import { WebSearch } from "./src/web-search.js";

/**
 * AllFather - Camada de comunicação com Ollama para todos os agents
 * O pai de todos os agents, provendo acesso à inteligência do LLM
 */
export class AllFather {
  constructor(config = {}) {
    const hostIp = process.env.HOST_IP || "localhost";
    const defaultBase = `http://${hostIp}:11434`;
    const ollamaBase = config.ollamaUrl || process.env.OLLAMA_URL || defaultBase;
    this.ollamaUrl = ollamaBase;
    this.model = config.model || process.env.OLLAMA_DEFAULT_MODEL || "deepseek-r1:14b-qwen-distill-q4_K_M";
    this.temperature = config.temperature ?? 0.7;
    this.timeout = config.timeout || 30000; // 30 segundos
    this.maxRetries = config.maxRetries ?? 3;
    this.disableReasoning = config.disableReasoning ?? true; // Desabilita reasoning por padrão
    this.templates = new PromptTemplates();
    this.webSearch = new WebSearch(); // Inicializa o sistema de busca web

    this.axiosInstance = axios.create({
      baseURL: this.ollamaUrl,
      timeout: this.timeout,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  /**
   * Verifica se o Ollama está rodando
   */
  async checkConnection() {
    try {
      console.log(`[AllFather] Testando conexão com Ollama em: ${this.ollamaUrl}`);
      const response = await this.axiosInstance.get("/");
      console.log(`[AllFather] Output Ollama:`, response.data);
      return response.status === 200;
    } catch (error) {
      console.log(`[AllFather] Falha na conexão com Ollama em: ${this.ollamaUrl}`);
      if (error.response) {
        console.log(`[AllFather] Output de erro Ollama:`, error.response.data);
      } else {
        console.log(`[AllFather] Erro:`, error.message);
      }
      return false;
    }
  }

  /**
   * Obtém informações do servidor Ollama
   */
  async getServerInfo() {
    try {
      const response = await this.axiosInstance.get("/api/tags");
      return response.data;
    } catch (error) {
      throw new Error(`Falha ao obter informações do servidor: ${error.message}`);
    }
  }

  /**
   * Lista modelos disponíveis
   */
  async listModels() {
    try {
      const response = await this.axiosInstance.get("/api/tags");
      return response.data.models || [];
    } catch (error) {
      throw new Error(`Falha ao listar modelos: ${error.message}`);
    }
  }

  /**
   * Verifica se um modelo específico está disponível
   */
  async hasModel(modelName) {
    try {
      const models = await this.listModels();
      return models.some((m) => m.name === modelName || m.name.startsWith(modelName));
    } catch (error) {
      return false;
    }
  }

  /**
   * Método principal: faz uma pergunta ao LLM
   */
  async ask(question, options = {}) {
    // Prepara o prompt, adicionando instrução para desabilitar reasoning se necessário
    let finalPrompt = question;
    const disableReasoning = options.disableReasoning ?? this.disableReasoning;

    // Se reasoning está desabilitado, adiciona instrução para evitar thinking tokens
    if (disableReasoning) {
      finalPrompt = `You must respond directly without showing your thinking process. Do not use <think> tags or show reasoning. Just provide the final answer immediately.\n\n${question}`;
    }

    const params = {
      model: options.model || this.model,
      prompt: finalPrompt,
      stream: false,
      options: {
        temperature: options.temperature ?? this.temperature,
        num_predict: options.maxTokens || 500,
      },
    };

    let lastError;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.axiosInstance.post("/api/generate", params);

        if (response.data && response.data.response) {
          return response.data.response.trim();
        }

        throw new Error("Resposta inválida do Ollama");
      } catch (error) {
        lastError = error;

        if (attempt < this.maxRetries - 1) {
          // Aguarda antes de tentar novamente (exponential backoff)
          await this._sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }

    throw new Error(`Falha ao comunicar com Ollama após ${this.maxRetries} tentativas: ${lastError.message}`);
  }

  /**
   * Pergunta com contexto adicional
   */
  async askWithContext(question, context, options = {}) {
    let contextString = "";

    if (typeof context === "object") {
      contextString = Object.entries(context)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
    } else {
      contextString = String(context);
    }

    const fullPrompt = `Contexto:\n${contextString}\n\nPergunta: ${question}`;

    return this.ask(fullPrompt, options);
  }

  /**
   * Cria um prompt usando templates predefinidos
   */
  createPrompt(templateName, data) {
    return this.templates.render(templateName, data);
  }

  /**
   * Pergunta usando template de prompt
   */
  async askWithPrompt(prompt, options = {}) {
    if (typeof prompt === "string") {
      return this.ask(prompt, options);
    }

    // Se for um objeto de template
    if (prompt.template && prompt.data) {
      const renderedPrompt = this.templates.render(prompt.template, prompt.data);
      return this.ask(renderedPrompt, options);
    }

    throw new Error("Prompt inválido");
  }

  /**
   * Obtém templates disponíveis
   */
  getAvailableTemplates() {
    return this.templates.list();
  }

  /**
   * Pede resposta em formato JSON
   */
  async askForJSON(question, options = {}) {
    const jsonPrompt = `${question}\n\nIMPORTANTE: Responda APENAS com JSON válido, sem texto adicional antes ou depois.`;

    const response = await this.ask(jsonPrompt, {
      ...options,
      temperature: options.temperature ?? 0.3, // Temperatura mais baixa para JSON
    });

    try {
      // Remove thinking tokens (<think>...</think>) de modelos como qwen3, deepseek-r1
      let cleaned = response.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

      // Remove markdown code fences (```json ... ``` ou ``` ... ```)
      const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (fenceMatch) cleaned = fenceMatch[1].trim();

      // Tenta extrair array JSON primeiro (resposta mais comum para listas)
      const arrayMatch = cleaned.match(/(\[[\s\S]*\])/);
      if (arrayMatch) {
        try { return JSON.parse(arrayMatch[1]); } catch {}
      }

      // Tenta extrair objeto JSON
      const objMatch = cleaned.match(/(\{[\s\S]*\})/);
      if (objMatch) {
        return JSON.parse(objMatch[1]);
      }

      // Tenta parsear a resposta limpa diretamente
      return JSON.parse(cleaned);
    } catch (error) {
      throw new Error(`Falha ao parsear JSON da resposta: ${response}`);
    }
  }

  /**
   * Processa várias perguntas em lote
   */
  async askBatch(questions, options = {}) {
    const promises = questions.map((q) => this.ask(q, options));
    return Promise.all(promises);
  }

  /**
   * Faz uma pergunta com busca automática na Wikipedia se necessário
   * O modelo decide se precisa buscar informações e gera a query apropriada
   * @param {string} question - A pergunta a ser feita
   * @param {Object} options - Opções de consulta
   * @param {string} options.language - Idioma da Wikipedia (padrão: 'en')
   * @returns {Promise<string>} Resposta (com ou sem contexto web)
   */
  async askWithAutoWebSearch(question, options = {}) {
    const { language = "en", ...askOptions } = options;

    try {
      // Primeira tentativa: pede ao modelo para avaliar se precisa de mais informações
      const evaluationPrompt = `Analyze this question and decide if you need Wikipedia to answer accurately:

"${question}"

DECISION RULES:
- SEARCH if: Question is about specific people, bands, albums, movies, dates, or facts you're uncertain about
- ANSWER if: Question is about general concepts, math, or common knowledge you're certain about

SEARCH QUERY RULES:
- Use ONLY the main subject name (band name, person name, album title, movie title)
- DO NOT add extra words like "lead vocalist", "release date", "information about"
- Examples: "Radiohead" (not "Radiohead's lead vocalist"), "OK Computer" (not "OK Computer release"), "David Bowie" (not "David Bowie albums")

FORMAT (you MUST follow exactly):
SEARCH: [simple name only]  OR  ANSWER: [your direct answer]

Respond NOW:`;

      const evaluation = await this.ask(evaluationPrompt, { ...askOptions, temperature: 0.1 }); // Baixa temperatura para seguir formato

      // Verifica se o modelo quer fazer uma busca (múltiplos formatos)
      const lowerEval = evaluation.toLowerCase();
      let searchQuery = null;

      if (evaluation.includes("SEARCH:")) {
        searchQuery = evaluation.split("SEARCH:")[1].trim().split("\n")[0];
      } else if (lowerEval.includes("search for")) {
        // Captura padrões como "Search for 'Radiohead'" ou "search for Radiohead"
        const match = evaluation.match(/search for\s+['"]?([^'".\n]+)['"]?/i);
        if (match) {
          searchQuery = match[1].trim();
        }
      }

      if (searchQuery) {
        console.log(`🔍 Modelo solicitou busca: "${searchQuery}"`);

        // Busca na Wikipedia
        const wikiResult = await this.webSearch.searchWikipedia(searchQuery, language);

        if (wikiResult) {
          console.log(`✅ Informação encontrada na Wikipedia: ${wikiResult.title}`);

          const enrichedPrompt = `Based on this Wikipedia information:

Title: ${wikiResult.title}
${wikiResult.summary}
Source: ${wikiResult.url}

Now answer the original question: ${question}

Provide a concise and direct answer.`;

          return this.ask(enrichedPrompt, askOptions);
        } else {
          console.warn(`⚠️  Busca "${searchQuery}" não retornou resultados na Wikipedia, respondendo sem contexto`);
          return this.ask(question, askOptions);
        }
      } else if (evaluation.includes("ANSWER:")) {
        // Modelo está confiante, retorna a resposta direta
        return evaluation.split("ANSWER:")[1].trim();
      } else {
        // Formato inesperado, mas pode ser uma resposta direta
        console.log("ℹ️  Resposta direta do modelo (sem busca)");
        return this.ask(question, askOptions);
      }
    } catch (error) {
      console.warn("⚠️  Erro no processo de busca automática:", error.message);
      return this.ask(question, askOptions);
    }
  }

  /**
   * Faz uma pergunta ao LLM enriquecida com busca na Wikipedia (busca sempre)
   * @param {string} question - A pergunta a ser feita
   * @param {Object} options - Opções de busca e consulta
   * @param {string} options.language - Idioma para Wikipedia (padrão: 'en')
   * @returns {Promise<string>} Resposta enriquecida com dados da Wikipedia
   */
  async askWithWebSearch(question, options = {}) {
    const { language = "en", ...askOptions } = options;

    try {
      // Busca na Wikipedia
      const wikiResult = await this.webSearch.searchWikipedia(question, language);

      if (wikiResult) {
        // Formata o resultado
        const formattedResults = this.webSearch.formatSearchResults(wikiResult);

        // Cria contexto enriquecido com resultado da Wikipedia
        const enrichedContext = `Informações da Wikipedia sobre "${question}":

${formattedResults}

Com base nas informações acima, responda à seguinte pergunta:
${question}`;

        // Envia para o LLM com contexto enriquecido
        return this.ask(enrichedContext, askOptions);
      } else {
        console.warn("⚠️  Wikipedia não retornou resultados, respondendo sem contexto");
        return this.ask(question, askOptions);
      }
    } catch (error) {
      console.warn("⚠️  Erro na busca Wikipedia, respondendo sem contexto externo:", error.message);
      // Se falhar a busca, responde sem contexto externo
      return this.ask(question, askOptions);
    }
  }

  /**
   * Busca na Wikipedia (retorna resultado bruto para uso por agentes)
   * @param {string} query - Termo de busca
   * @param {string} language - Idioma (padrão: 'en')
   * @returns {Promise<Object|null>} Objeto com {title, summary, url, source, language}
   */
  async searchWikipedia(query, language = "en") {
    return this.webSearch.searchWikipedia(query, language);
  }

  /**   * Busca no IMDB (retorna resultado bruto para uso por agentes)
   * @param {string} title - Título do filme ou série
   * @returns {Promise<Object|null>} Objeto com {title, year, type, url, source}
   */
  async searchIMDB(title) {
    return this.webSearch.searchIMDB(title);
  }

  /**
   * Busca informações de filme/série usando apenas IMDB
   * @param {string} title - Título do filme ou série
   * @returns {Promise<Object>} Objeto com {query, imdb, timestamp}
   */
  async searchMovieOrSeries(title) {
    return this.webSearch.searchMovieOrSeries(title);
  }

  /**
   * Busca metadados de música via MusicBrainz
   * @param {string} songTitle - Título da música
   * @param {string} artist - Nome do artista (opcional)
   * @returns {Promise<Object|null>} Metadados da música
   */
  async searchMusicMetadata(songTitle, artist = null) {
    return this.webSearch.searchMusicMetadata(songTitle, artist);
  }

  /**
   * Busca candidatos de música para desambiguação por LLM
   * @param {string} songTitle - Título da música
   * @param {string} artist - Nome do artista
   * @param {number} limit - Quantidade máxima de candidatos
   * @returns {Promise<Array>} Lista de candidatos
   */
  async searchMusicCandidates(songTitle, artist = null, limit = 8) {
    return this.webSearch.searchMusicCandidates(songTitle, artist, limit);
  }

  /**
   * Obtém metadata completo de uma música (LLM + MusicBrainz quando houver dúvida)
   * Pode usar imagem de capa como sinal adicional de desambiguação.
   * @param {string} songTitle - Título da música
   * @param {string} artist - Nome do artista
   * @param {Object} options - Opções extras
   * @param {string} options.coverImageUrl - URL da capa do arquivo local/plex
   * @returns {Promise<Object>} Metadata da música
   */
  async getMusicMetadata(songTitle, artist, options = {}) {
    const { coverImageUrl = null } = options;
    const draft = await this.askForJSON(
      `You are cleaning messy music metadata.
    Input song title: "${songTitle || ""}"
    Input artist: "${artist || ""}"
    Has cover image URL: ${Boolean(coverImageUrl)}

Return JSON with exactly this shape:
{
  "needsExternalData": true|false,
  "confidence": 0.0,
  "searchQuery": "best query for MusicBrainz",
  "metadata": {
    "title": "clean title or null",
    "artist": "clean artist or null",
    "album": "album or null",
    "year": "year or null",
    "genre": "genre or null",
    "duration": "m:ss or null"
  }
}

Set needsExternalData=true when confidence < 0.8 or if any key field is uncertain.`,
      { temperature: 0.1 },
    ).catch(() => null);

    const metadataDraft = draft?.metadata || {
      title: songTitle || null,
      artist: artist || null,
      album: null,
      year: null,
      genre: null,
      duration: null,
    };

    const sparseMusicDraft = !metadataDraft.album || !metadataDraft.year || !metadataDraft.genre;
    const shouldSearch = !draft || draft.needsExternalData === true || Number(draft.confidence || 0) < 0.8 || sparseMusicDraft;

    if (!shouldSearch) {
      return {
        ...metadataDraft,
        musicBrainzId: null,
        releaseId: null,
        score: null,
        source: "LLM",
      };
    }

    const query = draft?.searchQuery || metadataDraft.title || songTitle;
    let candidates = await this.searchMusicCandidates(query, metadataDraft.artist || artist || null, 8);

    if ((!candidates || candidates.length === 0) && (songTitle || artist)) {
      candidates = await this.searchMusicCandidates(songTitle || query, artist || metadataDraft.artist || null, 8);
    }

    if (coverImageUrl && candidates.length > 0) {
      candidates = await this.webSearch.rankCandidatesByCoverImage(coverImageUrl, candidates);
    }

    if (!candidates || candidates.length === 0) {
      const fallbackMusicData = await this.searchMusicMetadata(query, metadataDraft.artist || artist || null);
      if (fallbackMusicData) {
        return {
          ...metadataDraft,
          ...fallbackMusicData,
          source: "LLM+MusicBrainz",
        };
      }

      return {
        ...metadataDraft,
        musicBrainzId: null,
        releaseId: null,
        score: null,
        source: "LLM (no web match)",
      };
    }

    const merged = await this.askForJSON(
      `You are resolving ambiguous music metadata.

Original messy input:
- title: ${songTitle || ""}
- artist: ${artist || ""}

LLM cleaned draft:
${JSON.stringify(metadataDraft)}

MusicBrainz candidates:
${JSON.stringify(candidates)}

  Input cover image URL:
  ${coverImageUrl || "none"}

Task:
1) Analyze output + context.
2) Choose the best candidate OR decide none is reliable.
3) Return final normalized metadata.

Return ONLY JSON with this exact shape:
{
  "title": "...",
  "artist": "...",
  "album": "...",
  "year": "...",
  "genre": "...",
  "duration": "...",
  "musicBrainzId": "...",
  "releaseId": "...",
        "coverArtUrl": "...",
  "score": 0,
  "source": "LLM+MusicBrainz"
}

If candidates are unreliable, keep draft values and set musicBrainzId/releaseId null.
Never invent artist/title unrelated to input context.`,
      { temperature: 0.1 },
    ).catch(() => null);

    return (
      merged || {
        ...metadataDraft,
        ...candidates[0],
        source: "LLM+MusicBrainz",
      }
    );
  }

  /**
   * Obtém metadata completo de um filme com IA
   * @param {string} movieTitle - Título do filme
   * @returns {Promise<Object>} Metadata do filme
   */
  async getMovieMetadata(movieTitle) {
    const draft = await this.askForJSON(
      `Provide movie metadata for "${movieTitle}" using your current knowledge.
Return JSON exactly as:
{
  "needsExternalData": true|false,
  "confidence": 0.0,
  "searchQuery": "best imdb search query",
  "metadata": {
    "title": "exact movie title",
    "year": "release year",
    "director": "director name",
    "genre": "genre(s)",
    "rating": "imdb rating if known",
    "plot": "brief plot summary",
    "cast": ["main actors"]
  }
}
Set needsExternalData=true when confidence < 0.8 or factual uncertainty exists.
If you are not certain about year/director/rating/cast, set needsExternalData=true.
For movie metadata tasks, prefer needsExternalData=true unless you are extremely certain.`,
      { temperature: 0.1 },
    ).catch(() => null);

    const metadataDraft = draft?.metadata || {
      title: movieTitle || null,
      year: null,
      director: null,
      genre: null,
      rating: null,
      plot: null,
      cast: [],
    };

    const sparseMovieDraft = !metadataDraft.year || !metadataDraft.director || !metadataDraft.rating;
    const shouldSearch = !draft || draft.needsExternalData === true || Number(draft.confidence || 0) < 0.9 || sparseMovieDraft;
    if (!shouldSearch) {
      return metadataDraft;
    }

    const searchTitle = draft?.searchQuery || movieTitle;
    const movieData = await this.searchMovieOrSeries(searchTitle);

    if (!movieData?.imdb) {
      return metadataDraft;
    }

    return this.askForJSON(
      `Merge LLM draft metadata with IMDb data and return final JSON.

LLM draft:
${JSON.stringify(metadataDraft)}

IMDb data:
${JSON.stringify(movieData.imdb)}

Return only:
{
  "title": "exact movie title",
  "year": "release year",
  "director": "director name",
  "genre": "genre(s)",
  "rating": "imdb or best available",
  "plot": "brief plot summary (max 200 chars)",
  "cast": ["main actors if mentioned"]
}`,
      { temperature: 0.1 },
    ).catch(() => metadataDraft);
  }

  /**
   * Obtém metadata completo de uma série com IA
   * @param {string} seriesTitle - Título da série
   * @returns {Promise<Object>} Metadata da série
   */
  async getSeriesMetadata(seriesTitle) {
    const draft = await this.askForJSON(
      `Provide TV series metadata for "${seriesTitle}" using your current knowledge.
Return JSON exactly as:
{
  "needsExternalData": true|false,
  "confidence": 0.0,
  "searchQuery": "best imdb search query",
  "metadata": {
    "title": "exact series title",
    "year": "start year or range",
    "seasons": "number of seasons",
    "genre": "genre(s)",
    "creator": "creator(s)",
    "rating": "rating if known",
    "plot": "brief plot",
    "cast": ["main actors"]
  }
}
Set needsExternalData=true when confidence < 0.8 or factual uncertainty exists.
If you are not certain about year/seasons/creator/rating/cast, set needsExternalData=true.
For TV metadata tasks, prefer needsExternalData=true unless you are extremely certain.`,
      { temperature: 0.1 },
    ).catch(() => null);

    const metadataDraft = draft?.metadata || {
      title: seriesTitle || null,
      year: null,
      seasons: null,
      genre: null,
      creator: null,
      rating: null,
      plot: null,
      cast: [],
    };

    const sparseSeriesDraft = !metadataDraft.year || !metadataDraft.seasons || !metadataDraft.creator;
    const shouldSearch = !draft || draft.needsExternalData === true || Number(draft.confidence || 0) < 0.9 || sparseSeriesDraft;
    if (!shouldSearch) {
      return metadataDraft;
    }

    const searchTitle = draft?.searchQuery || seriesTitle;
    const seriesData = await this.searchMovieOrSeries(searchTitle);
    if (!seriesData?.imdb) {
      return metadataDraft;
    }

    return this.askForJSON(
      `Merge LLM draft metadata with IMDb data and return final JSON.

LLM draft:
${JSON.stringify(metadataDraft)}

IMDb data:
${JSON.stringify(seriesData.imdb)}

Return only:
{
  "title": "exact series title",
  "year": "start year or year range",
  "seasons": "number of seasons if mentioned",
  "genre": "genre(s)",
  "creator": "creator name(s)",
  "rating": "rating if mentioned",
  "plot": "brief plot summary (max 200 chars)",
  "cast": ["main actors if mentioned"]
}`,
      { temperature: 0.1 },
    ).catch(() => metadataDraft);
  }

  /**   * Formata resultados de busca para texto legível
   * @param {Object|Array} searchResults - Resultados da busca (de searchWeb, searchGoogle ou searchWikipedia)
   * @returns {string} Texto formatado
   */
  formatSearchResults(searchResults) {
    return this.webSearch.formatSearchResults(searchResults);
  }

  /**
   * Altera a temperatura (criatividade)
   */
  setTemperature(temperature) {
    if (temperature < 0 || temperature > 2) {
      throw new Error("Temperatura deve estar entre 0 e 2");
    }
    this.temperature = temperature;
  }

  /**
   * Altera o modelo
   */
  setModel(model) {
    this.model = model;
  }

  /**
   * ==================================================================
   * FUNCIONALIDADES DE VISÃO (MULTIMODAL)
   * ==================================================================
   */

  /**
   * Carrega uma imagem e converte para base64
   * @param {string} imagePath - Caminho para a imagem (suporta file:// ou path direto)
   * @returns {Promise<string>} Imagem em base64
   */
  async _loadImageAsBase64(imagePath) {
    try {
      // Remove file:// se presente
      const cleanPath = imagePath.replace(/^file:\/\//, "");

      const imageBuffer = await fs.readFile(cleanPath);
      return imageBuffer.toString("base64");
    } catch (error) {
      throw new Error(`Falha ao carregar imagem ${imagePath}: ${error.message}`);
    }
  }

  /**
   * Faz uma pergunta ao LLM com uma imagem
   * @param {string} question - Pergunta sobre a imagem
   * @param {string} imagePath - Caminho da imagem
   * @param {Object} options - Opções adicionais
   * @returns {Promise<string>} Resposta do LLM
   */
  async askWithImage(question, imagePath, options = {}) {
    const { visionModel = "llama3.2-vision", ...askOptions } = options;

    // Carrega a imagem
    const imageBase64 = await this._loadImageAsBase64(imagePath);

    // Prepara o prompt com suporte a multimodal
    let finalPrompt = question;
    const disableReasoning = options.disableReasoning ?? this.disableReasoning;

    if (disableReasoning && visionModel.includes("deepseek")) {
      finalPrompt = `You must respond directly without showing your thinking process. Do not use <think> tags or show reasoning. Just provide the final answer immediately.\n\n${question}`;
    }

    const params = {
      model: visionModel,
      prompt: finalPrompt,
      stream: false,
      images: [imageBase64],
      options: {
        temperature: askOptions.temperature ?? this.temperature,
        num_predict: askOptions.maxTokens || 500,
      },
    };

    let lastError;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.axiosInstance.post("/api/generate", params);

        if (response.data && response.data.response) {
          return response.data.response.trim();
        }

        throw new Error("Resposta inválida do Ollama");
      } catch (error) {
        lastError = error;

        if (attempt < this.maxRetries - 1) {
          await this._sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }

    throw new Error(`Falha ao comunicar com Ollama (visão) após ${this.maxRetries} tentativas: ${lastError.message}`);
  }

  /**
   * Faz uma pergunta ao LLM com múltiplas imagens
   * @param {string} question - Pergunta sobre as imagens
   * @param {string[]} imagePaths - Array de caminhos das imagens
   * @param {Object} options - Opções adicionais
   * @returns {Promise<string>} Resposta do LLM
   */
  async askWithImages(question, imagePaths, options = {}) {
    const { visionModel = "llama3.2-vision", ...askOptions } = options;

    // Carrega todas as imagens
    const imagePromises = imagePaths.map((path) => this._loadImageAsBase64(path));
    const imagesBase64 = await Promise.all(imagePromises);

    // Prepara o prompt
    let finalPrompt = question;
    const disableReasoning = options.disableReasoning ?? this.disableReasoning;

    if (disableReasoning && visionModel.includes("deepseek")) {
      finalPrompt = `You must respond directly without showing your thinking process. Do not use <think> tags or show reasoning. Just provide the final answer immediately.\n\n${question}`;
    }

    const params = {
      model: visionModel,
      prompt: finalPrompt,
      stream: false,
      images: imagesBase64,
      options: {
        temperature: askOptions.temperature ?? this.temperature,
        num_predict: askOptions.maxTokens || 500,
      },
    };

    let lastError;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.axiosInstance.post("/api/generate", params);

        if (response.data && response.data.response) {
          return response.data.response.trim();
        }

        throw new Error("Resposta inválida do Ollama");
      } catch (error) {
        lastError = error;

        if (attempt < this.maxRetries - 1) {
          await this._sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }

    throw new Error(`Falha ao comunicar com Ollama (visão) após ${this.maxRetries} tentativas: ${lastError.message}`);
  }

  /**
   * Compara duas imagens e retorna uma similaridade (0-1)
   * Usa hashing perceptual (Jimp) para comparação rápida e precisa
   * @param {string} imagePath1 - Caminho da primeira imagem
   * @param {string} imagePath2 - Caminho da segunda imagem
   * @param {Object} options - Opções adicionais
   * @returns {Promise<number|null>} Similaridade de 0 a 1, ou null se falhar
   */
  async compareImagesByContent(imagePath1, imagePath2, options = {}) {
    try {
      console.log(`🔍 Comparando imagens via hashing perceptual (Jimp)...`);

      // Importa Jimp dinamicamente (compatibilidade CommonJS/ESM)
      const jimp = await import("jimp");
      const Jimp = jimp.default;

      // Carrega as imagens
      const [image1, image2] = await Promise.all([Jimp.read(imagePath1), Jimp.read(imagePath2)]);

      // Calcula hash perceptual de cada imagem
      const hash1 = image1.hash();
      const hash2 = image2.hash();

      // Compara os hashes (retorna distância de Hamming normalizada)
      const distance = Jimp.compareHashes(hash1, hash2);

      // Converte distância em similaridade (0 = idêntico, 1 = completamente diferente)
      const similarity = Math.max(0, 1 - distance);

      console.log(`✅ Similaridade detectada: ${(similarity * 100).toFixed(1)}%`);
      return Number(similarity.toFixed(4));
    } catch (error) {
      console.error(`❌ Erro ao comparar imagens: ${error.message}`);
      return null;
    }
  }

  /**
   * Compara duas imagens usando análise de LLM com visão (método alternativo, mais lento)
   * NOTA: llama3.2-vision suporta apenas 1 imagem por vez, então fazemos 2 análises separadas
   * @param {string} imagePath1 - Caminho da primeira imagem
   * @param {string} imagePath2 - Caminho da segunda imagem
   * @param {Object} options - Opções adicionais
   * @returns {Promise<number|null>} Similaridade de 0 a 1, ou null se falhar
   */
  async compareImagesByLLM(imagePath1, imagePath2, options = {}) {
    const { visionModel = "llama3.2-vision" } = options;

    try {
      console.log(`🔍 Comparando imagens via LLM (${visionModel})...`);

      // Prompt para extrair características estruturadas de um cover
      const analysisPrompt = `Analyze this album cover image and describe it structurally.

Focus on:
1. Main subject/artwork (what is depicted)
2. Color palette (dominant colors)
3. Text/typography (band name, album title if visible)
4. Style/mood (abstract, realistic, dark, colorful, etc)
5. Layout composition (centered, full bleed, bordered, etc)

Respond ONLY with JSON in this format:
{
  "subject": "brief description",
  "colors": ["color1", "color2", "color3"],
  "text": "visible text or null",
  "style": "style description",
  "layout": "layout description"
}`;

      // Analisa ambas as imagens separadamente
      console.log("📊 Analisando imagem 1...");
      const analysis1Response = await this.askWithImage(analysisPrompt, imagePath1, {
        visionModel,
        temperature: 0.1,
        maxTokens: 300,
      });

      console.log("📊 Analisando imagem 2...");
      const analysis2Response = await this.askWithImage(analysisPrompt, imagePath2, {
        visionModel,
        temperature: 0.1,
        maxTokens: 300,
      });

      // Extrai JSONs das respostas
      const json1Match = analysis1Response.match(/\{[\s\S]*\}/);
      const json2Match = analysis2Response.match(/\{[\s\S]*\}/);

      if (!json1Match || !json2Match) {
        console.warn("⚠️  Falha ao extrair análises estruturadas");
        return null;
      }

      const analysis1 = JSON.parse(json1Match[0]);
      const analysis2 = JSON.parse(json2Match[0]);

      // Agora compara as análises usando LLM
      const comparisonPrompt = `Compare these two album cover analyses and determine similarity:

Analysis 1:
${JSON.stringify(analysis1, null, 2)}

Analysis 2:
${JSON.stringify(analysis2, null, 2)}

Determine if these are the SAME album cover (possibly different scans/resolutions) or DIFFERENT albums.

Consider:
- Same album if: same subject, same colors, same text, same overall composition
- Different albums if: different artwork, different color schemes, different themes

Respond with a similarity score from 0.0 to 1.0 where:
- 1.0 = Identical album covers (same album)
- 0.9-0.99 = Very similar, likely same album
- 0.7-0.89 = Similar elements but different albums
- 0.5-0.69 = Some similarities, probably different
- 0.0-0.49 = Completely different

IMPORTANT: Respond ONLY with the numeric score (e.g., "0.95"), nothing else.`;

      const comparisonResponse = await this.ask(comparisonPrompt, {
        temperature: 0.1,
        maxTokens: 50,
      });

      // Extrai o número da resposta
      const scoreMatch = comparisonResponse.match(/[0-1]?\.?\d+/);
      if (scoreMatch) {
        const score = parseFloat(scoreMatch[0]);
        if (score >= 0 && score <= 1) {
          console.log(`✅ Similaridade detectada: ${(score * 100).toFixed(1)}%`);
          return score;
        }
      }

      console.warn(`⚠️  Não foi possível extrair score da resposta: "${comparisonResponse}"`);
      return null;
    } catch (error) {
      console.error(`❌ Erro ao comparar imagens: ${error.message}`);
      return null;
    }
  }

  /**
   * Analisa uma imagem de capa de álbum e extrai informações
   * @param {string} imagePath - Caminho da imagem
   * @param {Object} options - Opções adicionais
   * @returns {Promise<Object>} Metadados extraídos da imagem
   */
  async analyzeAlbumCover(imagePath, options = {}) {
    const { visionModel = "llama3.2-vision" } = options;

    try {
      const prompt = `Analyze this album cover image and extract information:

1. Album title (if visible)
2. Artist name (if visible)
3. Visual style/genre indicators
4. Color palette description
5. Notable design elements

IMPORTANT: Respond ONLY with JSON in this exact format:
{
  "albumTitle": "title or null",
  "artistName": "artist or null",
  "visualStyle": "description",
  "colorPalette": "description",
  "designElements": ["element1", "element2"]
}`;

      const response = await this.askWithImage(prompt, imagePath, {
        visionModel,
        temperature: 0.2,
        maxTokens: 300,
      });

      // Tenta extrair JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }

      return null;
    } catch (error) {
      console.error(`❌ Erro ao analisar capa: ${error.message}`);
      return null;
    }
  }

  /**
   * Função auxiliar para aguardar
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Exporta também como default
export default AllFather;
