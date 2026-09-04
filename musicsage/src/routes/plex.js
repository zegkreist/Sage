import { readFileSync } from "fs";
import { join } from "path";

/**
 * GET  /api/plex/status       — conectividade com o servidor de mídia atual
 * POST /api/plex/reload-token — relê o token do Preferences.xml e testa (só Plex)
 *
 * As rotas mantêm o prefixo /plex por compatibilidade com o frontend, mas o
 * status já é servido pelo provider — trocar de servidor não quebra a tela.
 * O reload de token é específico do Plex e se recusa a rodar em outro provider.
 */
export function plexRouter(router, { mediaServer }) {
  /** GET /api/plex/status */
  router.get("/plex/status", async (_req, res) => {
    if (!mediaServer) return res.status(503).json({ error: "Servidor de mídia não configurado" });
    const { type, url, tokenPresent, tokenMasked } = mediaServer.describe();

    try {
      const serverInfo = await mediaServer.checkConnection();
      res.json({ type, url, tokenPresent, tokenMasked, valid: true, serverInfo });
    } catch (err) {
      const errorMsg = err.response?.status
        ? `HTTP ${err.response.status} — token inválido ou servidor não encontrado`
        : err.message;
      res.json({ type, url, tokenPresent, tokenMasked, valid: false, error: errorMsg });
    }
  });

  /** POST /api/plex/reload-token */
  router.post("/plex/reload-token", async (_req, res) => {
    if (!mediaServer) return res.status(503).json({ error: "Servidor de mídia não configurado" });
    if (mediaServer.type !== "plex") {
      return res.status(400).json({
        error: `Recarregar token do Preferences.xml só existe no Plex — servidor atual: ${mediaServer.type}`,
      });
    }

    const configDir = process.env.PLEX_CONFIG_DIR;
    if (!configDir) {
      return res.status(400).json({
        error: "PLEX_CONFIG_DIR não definido — não é possível recarregar o token automaticamente",
      });
    }

    const prefsPath = join(
      configDir,
      "Library/Application Support/Plex Media Server/Preferences.xml"
    );

    let rawXml;
    try {
      rawXml = readFileSync(prefsPath, "utf8");
    } catch {
      return res.status(404).json({ error: `Arquivo não encontrado: ${prefsPath}` });
    }

    const match = rawXml.match(/PlexOnlineToken="([^"]+)"/);
    if (!match) {
      return res.status(404).json({ error: "PlexOnlineToken não encontrado no Preferences.xml" });
    }

    const { tokenMasked } = mediaServer.applyToken(match[1]);

    try {
      const serverInfo = await mediaServer.checkConnection();
      res.json({ reloaded: true, tokenMasked, valid: true, serverInfo });
    } catch (err) {
      const errorMsg = err.response?.status ? `HTTP ${err.response.status}` : err.message;
      res.json({ reloaded: true, tokenMasked, valid: false, error: errorMsg });
    }
  });

  return router;
}
