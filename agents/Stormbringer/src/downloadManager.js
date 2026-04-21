import WebTorrent from "webtorrent";
import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import MetadataEnricher from "./metadataEnricher.js";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class DownloadManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    // natUpnp/natPmp desabilitados: em ambiente Docker/servidor o UPnP não está
    // disponível e cada torrent adicionado chamaria ssdp.search() concorrentemente,
    // acumulando listeners na mesma instância Ssdp e disparando MaxListenersExceededWarning.
    this.client = new WebTorrent({ natUpnp: false, natPmp: false });
    this.activeTorrents = new Map();
    this.metadataEnricher = new MetadataEnricher(config);
    this.stateFile = config.downloads?.stateFile || path.join(__dirname, "../.download-state.json");

    // Criar diretórios se não existirem
    this.ensureDirectories();

    // Auto-save estado a cada 10 segundos
    this.saveInterval = setInterval(() => this.saveState(), 10000);
  }

  ensureDirectories() {
    const dirs = [this.config.downloads.baseDir, this.config.downloads.movies, this.config.downloads.series, this.config.downloads.music];

    dirs.forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * Salva estado atual dos downloads
   */
  saveState() {
    try {
      const state = {
        torrents: Array.from(this.activeTorrents.values()).map((t) => ({
          infoHash: t.infoHash,
          name: t.name,
          type: t.type,
          status: t.status,
          progress: t.progress,
          downloaded: t.downloaded,
          total: t.total,
          downloadSpeed: t.downloadSpeed,
          uploadSpeed: t.uploadSpeed,
          peers: t.peers,
          startTime: t.startTime,
        })),
        lastUpdate: Date.now(),
      };

      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error("Erro ao salvar estado:", err.message);
    }
  }

  /**
   * Adiciona um torrent para download
   */
  addTorrent(torrentId, type, metadata = {}) {
    return new Promise((resolve, reject) => {
      const downloadPath = this.getDownloadPath(type);

      const torrent = this.client.add(torrentId, {
        path: downloadPath,
      });

      const torrentInfo = {
        infoHash: null,
        name: null,
        type,
        metadata,
        status: "downloading",
        progress: 0,
        downloaded: 0,
        total: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        peers: 0,
        ratio: 0,
        startTime: Date.now(),
        torrent,
      };

      torrent.on("infoHash", () => {
        torrentInfo.infoHash = torrent.infoHash;
        this.activeTorrents.set(torrent.infoHash, torrentInfo);
        this.emit("added", torrentInfo);
        this.saveState();
      });

      torrent.on("metadata", () => {
        torrentInfo.name = torrent.name;
        torrentInfo.total = torrent.length;
        console.log(`\n📦 Metadados recebidos: ${torrent.name}`);
        console.log(`📏 Tamanho: ${this.formatBytes(torrent.length)}`);
        this.saveState();
        resolve(torrentInfo);
      });

      torrent.on("download", () => {
        torrentInfo.progress = Math.round(torrent.progress * 100 * 100) / 100;
        torrentInfo.downloaded = torrent.downloaded;
        torrentInfo.downloadSpeed = torrent.downloadSpeed;
        torrentInfo.uploadSpeed = torrent.uploadSpeed;
        torrentInfo.peers = torrent.numPeers;
        torrentInfo.ratio = torrent.uploaded / torrent.downloaded || 0;

        this.emit("progress", torrentInfo);
      });

      torrent.on("done", async () => {
        torrentInfo.status = "completed";
        torrentInfo.progress = 100;
        console.log(`\n✅ Download completo: ${torrent.name}`);
        console.log(`📁 Salvo em: ${downloadPath}`);

        // Processar metadados e organizar arquivos
        if (this.config.metadata?.enabled) {
          await this.processDownloadedFiles(torrent, type, metadata);
        }

        // Organizar arquivos se for música (sem metadados TMDB)
        if (type === "music" && metadata.artist) {
          this.organizeMusicFiles(torrent, metadata);
        }

        this.saveState();
        this.emit("completed", torrentInfo);
      });

      torrent.on("error", (err) => {
        torrentInfo.status = "error";
        console.error(`❌ Erro no download: ${err.message}`);
        this.emit("error", { torrentInfo, error: err });
        reject(err);
      });

      // Aviso se metadados demoram (não cancela — continua esperando peers)
      const warnTimer = setTimeout(() => {
        if (!torrentInfo.name) {
          console.log("\n⏳ Ainda buscando peers para obter metadados do torrent...");
          console.log("   O download continuará automaticamente quando encontrar peers.");
        }
      }, 30000);

      // Timeout definitivo: 5 minutos sem metadados
      const hardTimer = setTimeout(() => {
        if (!torrentInfo.name) {
          clearTimeout(warnTimer);
          torrent.destroy();
          reject(new Error("Não foi possível obter metadados do torrent após 5 minutos. Verifique se o torrent tem seeders ativos."));
        }
      }, 300000);

      // Limpar timers quando metadados chegarem
      torrent.on("metadata", () => {
        clearTimeout(warnTimer);
        clearTimeout(hardTimer);
      });
    });
  }

  /**
   * Organiza arquivos de música
   */
  organizeMusicFiles(torrent, metadata) {
    const { artist, album } = metadata;
    const musicBasePath = this.config.downloads.music;

    // Criar estrutura: artista/album/
    const artistPath = path.join(musicBasePath, this.sanitizeFilename(artist));
    const albumPath = album ? path.join(artistPath, this.sanitizeFilename(album)) : artistPath;

    if (!fs.existsSync(albumPath)) {
      fs.mkdirSync(albumPath, { recursive: true });
    }

    // Mover arquivos
    torrent.files.forEach((file) => {
      const oldPath = file.path;
      const fileName = path.basename(oldPath);
      const newPath = path.join(albumPath, fileName);

      try {
        if (fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, newPath);
          console.log(`📂 Movido: ${fileName} -> ${albumPath}`);
        }
      } catch (err) {
        console.error(`Erro ao mover arquivo ${fileName}:`, err.message);
      }
    });
  }

  /**
   * Obtém o caminho de download baseado no tipo
   */
  getDownloadPath(type) {
    switch (type) {
      case "movie":
        return this.config.downloads.movies;
      case "series":
        return this.config.downloads.series;
      case "music":
        return this.config.downloads.music;
      default:
        return this.config.downloads.baseDir;
    }
  }

  /**
   * Lista torrents ativos
   */
  getActiveTorrents() {
    return Array.from(this.activeTorrents.values());
  }

  /**
   * Obtém informações de um torrent específico
   */
  getTorrentInfo(infoHash) {
    return this.activeTorrents.get(infoHash);
  }

  /**
   * Pausa um torrent
   */
  pauseTorrent(infoHash) {
    const torrentInfo = this.activeTorrents.get(infoHash);
    if (torrentInfo && torrentInfo.torrent) {
      torrentInfo.torrent.pause();
      torrentInfo.status = "paused";
      this.emit("paused", torrentInfo);
    }
  }

  /**
   * Resume um torrent
   */
  resumeTorrent(infoHash) {
    const torrentInfo = this.activeTorrents.get(infoHash);
    if (torrentInfo && torrentInfo.torrent) {
      torrentInfo.torrent.resume();
      torrentInfo.status = "downloading";
      this.emit("resumed", torrentInfo);
    }
  }

  /**
   * Remove um torrent
   */
  removeTorrent(infoHash, deleteFiles = false) {
    const torrentInfo = this.activeTorrents.get(infoHash);
    if (torrentInfo && torrentInfo.torrent) {
      torrentInfo.torrent.destroy({ destroyStore: deleteFiles }, (err) => {
        if (err) {
          console.error("Erro ao remover torrent:", err);
        } else {
          this.activeTorrents.delete(infoHash);
          this.emit("removed", infoHash);
          console.log(`🗑️ Torrent removido: ${torrentInfo.name}`);
        }
      });
    }
  }

  /**
   * Formata bytes para formato legível
   */
  formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return "0 Bytes";

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
  }

  /**
   * Formata velocidade
   */
  formatSpeed(bytesPerSecond) {
    return this.formatBytes(bytesPerSecond) + "/s";
  }

  /**
   * Sanitiza nome de arquivo
   */
  sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, "_").trim();
  }

  /**
   * Processa arquivos baixados: renomeia, baixa posters, cria NFO
   */
  async processDownloadedFiles(torrent, type, metadata) {
    try {
      console.log("\n🎨 Processando metadados...");

      if (type === "movie" && metadata.movieMetadata) {
        await this.processMovieFiles(torrent, metadata.movieMetadata);
      } else if (type === "series" && metadata.seriesMetadata) {
        await this.processSeriesFiles(torrent, metadata);
      }
    } catch (err) {
      console.error("Erro ao processar metadados:", err.message);
    }
  }

  /**
   * Processa arquivos de filme
   */
  async processMovieFiles(torrent, movieMetadata) {
    const downloadPath = this.config.downloads.movies;

    // Criar pasta para o filme
    const movieFolder = path.join(downloadPath, this.metadataEnricher.getMovieFilename(movieMetadata));
    if (!fs.existsSync(movieFolder)) {
      fs.mkdirSync(movieFolder, { recursive: true });
    }

    // Mover e renomear arquivos
    if (this.config.metadata.renameFiles) {
      const videoFile = this.findMainVideoFile(torrent.files);
      if (videoFile) {
        const ext = path.extname(videoFile.name);
        const newName = this.metadataEnricher.getMovieFilename(movieMetadata) + ext;
        const newPath = path.join(movieFolder, newName);

        try {
          if (fs.existsSync(videoFile.path)) {
            fs.renameSync(videoFile.path, newPath);
            console.log(`📝 Renomeado: ${newName}`);
          }
        } catch (err) {
          console.error("Erro ao renomear arquivo:", err.message);
        }
      }

      // Mover arquivos extras (legendas, etc)
      torrent.files.forEach((file) => {
        if (file !== videoFile && fs.existsSync(file.path)) {
          const newPath = path.join(movieFolder, path.basename(file.name));
          try {
            fs.renameSync(file.path, newPath);
          } catch (err) {
            // Ignorar erros em arquivos extras
          }
        }
      });
    }

    // Baixar poster
    if (this.config.metadata.downloadPosters && movieMetadata.posterUrl) {
      await this.metadataEnricher.downloadPoster(movieMetadata.posterUrl, movieFolder);
    }

    // Baixar fanart
    if (this.config.metadata.downloadFanart && movieMetadata.backdropUrl) {
      await this.metadataEnricher.downloadBackdrop(movieMetadata.backdropUrl, movieFolder);
    }

    // Criar NFO
    if (this.config.metadata.createNFO) {
      this.metadataEnricher.saveNFO(movieMetadata, movieFolder, "movie");
    }
  }

  /**
   * Processa arquivos de série/episódio
   */
  async processSeriesFiles(torrent, metadata) {
    const { seriesMetadata, season, episode } = metadata;
    const downloadPath = this.config.downloads.series;

    // Criar pasta para a série
    const seriesFolder = path.join(downloadPath, this.sanitizeFilename(seriesMetadata.name));
    if (!fs.existsSync(seriesFolder)) {
      fs.mkdirSync(seriesFolder, { recursive: true });
    }

    // Criar pasta para a temporada
    const seasonFolder = path.join(seriesFolder, `Season ${String(season).padStart(2, "0")}`);
    if (!fs.existsSync(seasonFolder)) {
      fs.mkdirSync(seasonFolder, { recursive: true });
    }

    // Buscar metadados do episódio se disponível
    let episodeMetadata = null;
    if (seriesMetadata.id) {
      episodeMetadata = await this.metadataEnricher.getEpisodeMetadata(seriesMetadata.id, season, episode);
    }

    // Mover e renomear arquivo
    if (this.config.metadata.renameFiles) {
      const videoFile = this.findMainVideoFile(torrent.files);
      if (videoFile) {
        const ext = path.extname(videoFile.name);
        const episodeName = episodeMetadata?.name || null;
        const newName = this.metadataEnricher.getEpisodeFilename(seriesMetadata, season, episode, episodeName) + ext;
        const newPath = path.join(seasonFolder, newName);

        try {
          if (fs.existsSync(videoFile.path)) {
            fs.renameSync(videoFile.path, newPath);
            console.log(`📝 Renomeado: ${newName}`);
          }
        } catch (err) {
          console.error("Erro ao renomear arquivo:", err.message);
        }
      }

      // Mover arquivos extras (legendas, etc)
      torrent.files.forEach((file) => {
        if (file !== videoFile && fs.existsSync(file.path)) {
          const newPath = path.join(seasonFolder, path.basename(file.name));
          try {
            fs.renameSync(file.path, newPath);
          } catch (err) {
            // Ignorar erros em arquivos extras
          }
        }
      });
    }

    // Baixar poster da série (apenas uma vez)
    const posterPath = path.join(seriesFolder, "poster.jpg");
    if (this.config.metadata.downloadPosters && seriesMetadata.posterUrl && !fs.existsSync(posterPath)) {
      await this.metadataEnricher.downloadPoster(seriesMetadata.posterUrl, seriesFolder);
    }

    // Baixar fanart da série (apenas uma vez)
    const fanartPath = path.join(seriesFolder, "fanart.jpg");
    if (this.config.metadata.downloadFanart && seriesMetadata.backdropUrl && !fs.existsSync(fanartPath)) {
      await this.metadataEnricher.downloadBackdrop(seriesMetadata.backdropUrl, seriesFolder);
    }

    // Criar NFO da série (apenas uma vez)
    const nfoPath = path.join(seriesFolder, "tvshow.nfo");
    if (this.config.metadata.createNFO && !fs.existsSync(nfoPath)) {
      this.metadataEnricher.saveNFO(seriesMetadata, seriesFolder, "tvshow");
    }

    // Criar NFO do episódio
    if (this.config.metadata.createNFO && episodeMetadata) {
      const episodeNFOPath = path.join(seasonFolder, this.metadataEnricher.getEpisodeFilename(seriesMetadata, season, episode) + ".nfo");
      this.metadataEnricher.saveNFO(episodeMetadata, seasonFolder, "episode");
    }
  }

  /**
   * Encontra o arquivo de vídeo principal
   */
  findMainVideoFile(files) {
    const videoExtensions = [".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm"];

    const videoFiles = files.filter((file) => {
      const ext = path.extname(file.name).toLowerCase();
      return videoExtensions.includes(ext);
    });

    if (videoFiles.length === 0) return null;

    // Retorna o maior arquivo de vídeo
    return videoFiles.reduce((largest, file) => {
      return file.length > largest.length ? file : largest;
    });
  }

  /**
   * Fecha o cliente e todos os torrents
   */
  destroy() {
    // Limpar intervalo de auto-save
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
    }

    // Salvar estado final
    this.saveState();

    return new Promise((resolve) => {
      this.client.destroy((err) => {
        if (err) console.error("Erro ao fechar cliente:", err);
        resolve();
      });
    });
  }
}

export default DownloadManager;
