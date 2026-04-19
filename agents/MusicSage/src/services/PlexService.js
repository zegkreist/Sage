import { logger } from "../logger.js";

/**
 * PlexService — integração com a API REST do Plex Media Server.
 * Responsável por criar/remover playlists de áudio diretamente no Plex.
 */
export class PlexService {
  /**
   * @param {{ axios, plexUrl?: string, plexToken?: string }} config
   */
  constructor({ axios, plexUrl, plexToken } = {}) {
    this.axios = axios;
    this.plexUrl = plexUrl || process.env.PLEX_URL || "http://localhost:32400";
    this.plexToken = plexToken || process.env.PLEX_TOKEN || "";
    this._machineId = null;
  }

  get _headers() {
    return { "X-Plex-Token": this.plexToken, Accept: "application/json" };
  }

  /** Obtém o machineIdentifier do servidor Plex (cacheado). */
  async getMachineIdentifier() {
    if (this._machineId) return this._machineId;
    const res = await this.axios.get(`${this.plexUrl}/identity`, {
      headers: this._headers,
    });
    this._machineId = res.data?.MediaContainer?.machineIdentifier;
    if (!this._machineId) throw new Error("Plex não retornou o identificador do servidor");
    return this._machineId;
  }

  /**
   * Cria uma playlist de áudio no Plex com as faixas especificadas.
   * @param {string} name - Nome da playlist
   * @param {string[]} ratingKeys - ratingKey de cada faixa (do LibraryScanner)
   * @returns {Promise<{ plexId: string }>}
   */
  async pushPlaylist(name, ratingKeys) {
    if (!ratingKeys?.length) throw new Error("Nenhuma faixa com ratingKey para criar a playlist no Plex");
    const machineId = await this.getMachineIdentifier();
    const uri = `server://${machineId}/com.plexapp.plugins.library/library/metadata/${ratingKeys.join(",")}`;
    logger.info("SERVER", `Criando playlist "${name}" no Plex (${ratingKeys.length} faixas)`);

    const res = await this.axios.post(`${this.plexUrl}/playlists`, null, {
      headers: this._headers,
      params: { type: "audio", title: name, smart: 0, uri },
    });

    const pl = res.data?.MediaContainer?.Metadata?.[0];
    if (!pl) throw new Error("Plex não retornou dados da playlist criada");
    logger.info("SERVER", `Playlist criada no Plex: id=${pl.ratingKey}`);
    return { plexId: String(pl.ratingKey) };
  }

  /**
   * Remove uma playlist do Plex pelo ratingKey.
   * @param {string} plexRatingKey
   */
  async deletePlaylist(plexRatingKey) {
    await this.axios.delete(`${this.plexUrl}/playlists/${plexRatingKey}`, {
      headers: this._headers,
    });
    logger.info("SERVER", `Playlist removida do Plex: id=${plexRatingKey}`);
  }

  /**
   * Renomeia uma playlist existente no Plex.
   * @param {string} plexRatingKey
   * @param {string} newName
   */
  async renamePlaylist(plexRatingKey, newName) {
    await this.axios.put(`${this.plexUrl}/playlists/${plexRatingKey}`, null, {
      headers: this._headers,
      params: { title: newName },
    });
    logger.info("SERVER", `Playlist renomeada no Plex: id=${plexRatingKey} → "${newName}"`);
  }

  /**
   * Recria uma playlist no Plex com faixas atualizadas (delete + push).
   * Retorna o novo plexId.
   * @param {string} plexRatingKey  — id atual da playlist no Plex
   * @param {string} name           — nome a manter
   * @param {string[]} ratingKeys   — faixas novas
   * @returns {Promise<{ plexId: string }>}
   */
  async updatePlaylistTracks(plexRatingKey, name, ratingKeys) {
    await this.deletePlaylist(plexRatingKey);
    return this.pushPlaylist(name, ratingKeys);
  }

  /**
   * Retorna as contas (usuários) que têm acesso ao servidor Plex.
   * @returns {Promise<Array<{id: number, name: string, thumb: string|null}>>}
   */
  async getUsers() {
    const res = await this.axios.get(`${this.plexUrl}/accounts`, {
      headers: this._headers,
    });
    const accounts = res.data?.MediaContainer?.Account || [];
    return accounts.map((a) => ({
      id:    a.id,
      name:  a.name || a.title || 'Usuário',
      thumb: a.thumb || null,
    }));
  }
}
