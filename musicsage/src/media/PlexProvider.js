import { MediaServerProvider } from "./MediaServerProvider.js";
import { LibraryScanner } from "../services/LibraryScanner.js";
import { HistoryService } from "../services/HistoryService.js";
import { MetricsService } from "../services/MetricsService.js";
import { PlexService } from "../services/PlexService.js";

/**
 * Adaptador do Plex Media Server.
 *
 * Não reimplementa nada: compõe os serviços que já falam a API do Plex e os
 * expõe pelos nomes do contrato. É aqui que "Plex" para de existir para o
 * resto do app.
 */
export class PlexProvider extends MediaServerProvider {
  static type = "plex";

  constructor({ axios, url, token, analysisCache } = {}) {
    super();
    const plexUrl   = url   || process.env.PLEX_URL   || "http://localhost:32400";
    const plexToken = token || process.env.PLEX_TOKEN || "";

    this._library  = new LibraryScanner({ axios, plexUrl, plexToken });
    this._history  = new HistoryService({ axios, plexUrl, plexToken });
    this._metrics  = new MetricsService({ axios, plexUrl, plexToken, analysisCache });
    this._plex     = new PlexService({ axios, plexUrl, plexToken });
  }

  get library()   { return this._library; }
  get history()   { return this._history; }
  get metrics()   { return this._metrics; }
  get playlists() { return this._plex; }

  get ratings() {
    return {
      supported: true,
      setTrackRating: (id, rating0to5) => this._plex.setRating(id, rating0to5),
    };
  }

  getUsers()        { return this._plex.getUsers(); }
  checkConnection() { return this._plex.checkConnection(); }

  describe() {
    const token = this._plex.plexToken || "";
    return {
      type: PlexProvider.type,
      url:  this._plex.plexUrl,
      tokenPresent: !!token,
      tokenMasked:  token.length > 4 ? `${token.slice(0, 4)}****` : (token ? "****" : "(vazio)"),
    };
  }

  /** O token vale para os quatro serviços — todos batem no mesmo servidor. */
  applyToken(token) {
    for (const svc of [this._library, this._history, this._metrics, this._plex]) {
      svc.plexToken = token;
    }
    process.env.PLEX_TOKEN = token;
    return this.describe();
  }
}
