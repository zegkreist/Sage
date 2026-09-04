import { logger } from "../logger.js";
import { FavoritesService } from "../services/FavoritesService.js";

/** Espelhar a nota no servidor de mídia é o padrão; SYNC_RATINGS=false desliga. */
function syncEnabled() {
  return !["false", "0", "no"].includes(String(process.env.SYNC_RATINGS ?? "true").toLowerCase());
}

/**
 * GET    /api/favorites                       — lista todos os favoritos
 * PUT    /api/favorites                       — cria/atualiza { artist, title, album, ratingKey?, starred?, rating? }
 * DELETE /api/favorites?artist=&title=&album= — remove
 *
 * A nota (0-5) é espelhada no servidor de mídia quando ele suporta ratings.
 * O coração não tem equivalente lá — é curadoria só do MusicSage.
 */
export function favoritesRouter(router, { favoritesService, mediaServer, libraryScanner } = {}) {
  /**
   * Descobre o id da faixa no servidor: o que veio no body, o que já estava
   * guardado, ou uma busca na biblioteca por artista+título+álbum.
   */
  async function resolveRatingKey({ artist, title, album, ratingKey }) {
    if (ratingKey) return String(ratingKey);

    const known = favoritesService?.get(artist, title, album)?.ratingKey;
    if (known) return String(known);

    if (!libraryScanner) return null;
    try {
      // scan() tem TTL + inflight compartilhado, então isto não é um request novo
      const { tracks } = await libraryScanner.scan();
      const alvo = FavoritesService.makeKey(artist, title, album);
      const hit = tracks.find(
        (t) => FavoritesService.makeKey(t.grandparentTitle, t.title, t.parentTitle) === alvo
      );
      return hit ? String(hit.ratingKey) : null;
    } catch (err) {
      logger.warn("FAVORITES", `Não deu para resolver o id da faixa: ${err.message}`);
      return null;
    }
  }

  /**
   * Empurra a nota para o servidor. Nunca estoura: o favorito local já foi
   * gravado e não pode ser perdido porque o Plex está fora do ar.
   * @returns {Promise<{synced: boolean, reason?: string}>}
   */
  async function pushRating(track, rating) {
    if (!syncEnabled())                return { synced: false, reason: "sincronização desligada (SYNC_RATINGS)" };
    if (!mediaServer?.ratings?.supported) return { synced: false, reason: "servidor de mídia não suporta notas" };

    const id = await resolveRatingKey(track);
    if (!id) return { synced: false, reason: "faixa não encontrada no servidor de mídia" };

    try {
      await mediaServer.ratings.setTrackRating(id, rating);
      return { synced: true };
    } catch (err) {
      logger.warn("FAVORITES", `Nota não foi espelhada no servidor de mídia: ${err.message}`);
      return { synced: false, reason: err.message };
    }
  }

  router.get("/favorites", (_req, res) => {
    if (!favoritesService) return res.status(503).json({ error: "FavoritesService não disponível" });
    res.json({ favorites: favoritesService.list() });
  });

  router.put("/favorites", async (req, res) => {
    if (!favoritesService) return res.status(503).json({ error: "FavoritesService não disponível" });
    const { artist, title, album, ratingKey, starred, rating } = req.body || {};
    if (!title && !artist) return res.status(400).json({ error: "Informe ao menos 'title' ou 'artist'" });
    if (rating != null && (typeof rating !== "number" || rating < 0 || rating > 5)) {
      return res.status(400).json({ error: "'rating' deve ser número entre 0 e 5 (ou null)" });
    }

    const track = {
      artist: (artist || "").trim(),
      title:  (title  || "").trim(),
      album:  (album  || "").trim(),
      ratingKey: ratingKey ? String(ratingKey) : undefined,
    };
    const anterior = favoritesService.get(track.artist, track.title, track.album);
    const entry = favoritesService.setFavorite(track, {
      starred,
      rating: rating === undefined ? undefined : rating,
    });

    // Só chama o servidor quando a nota realmente mudou
    const notaNova    = entry ? entry.rating : null;
    const notaAntiga  = anterior ? anterior.rating : null;
    const mediaSync = notaNova === notaAntiga
      ? { synced: false, reason: "nota não mudou" }
      : await pushRating({ ...track, ratingKey: track.ratingKey ?? anterior?.ratingKey }, notaNova);

    res.json({ favorite: entry, mediaServer: mediaSync });
  });

  router.delete("/favorites", async (req, res) => {
    if (!favoritesService) return res.status(503).json({ error: "FavoritesService não disponível" });
    const { artist = "", title = "", album = "" } = req.query;
    const track = { artist: String(artist).trim(), title: String(title).trim(), album: String(album).trim() };

    const anterior = favoritesService.get(track.artist, track.title, track.album);
    const removed  = favoritesService.remove(track.artist, track.title, track.album);
    if (!removed) return res.status(404).json({ error: "Favorito não encontrado" });

    // Tirar o favorito também tira a nota lá — senão o servidor fica com uma
    // nota que o MusicSage não tem mais como explicar
    const mediaSync = anterior?.rating != null
      ? await pushRating({ ...track, ratingKey: anterior.ratingKey }, null)
      : { synced: false, reason: "não havia nota" };

    res.json({ ok: true, mediaServer: mediaSync });
  });
}
