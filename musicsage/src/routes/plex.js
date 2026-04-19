import { readFileSync } from "fs";
import { join } from "path";

/**
 * GET  /api/plex/status       — verifica conectividade com o Plex usando o token atual
 * POST /api/plex/reload-token — relê o token do Preferences.xml e testa
 */
export function plexRouter(router, { plexService }) {
  /** GET /api/plex/status */
  router.get("/plex/status", async (_req, res) => {
    const url          = plexService.plexUrl;
    const token        = plexService.plexToken;
    const tokenPresent = !!token;
    const tokenMasked  = token.length > 4
      ? token.slice(0, 4) + "****"
      : token ? "****" : "(vazio)";

    try {
      const serverInfo = await plexService.checkConnection();
      res.json({ url, tokenPresent, tokenMasked, valid: true, serverInfo });
    } catch (err) {
      const errorMsg = err.response?.status
        ? `HTTP ${err.response.status} — token inválido ou servidor não encontrado`
        : err.message;
      res.json({ url, tokenPresent, tokenMasked, valid: false, error: errorMsg });
    }
  });

  /** POST /api/plex/reload-token */
  router.post("/plex/reload-token", async (_req, res) => {
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

    const newToken = match[1];
    plexService.plexToken = newToken;
    process.env.PLEX_TOKEN = newToken;

    const tokenMasked = newToken.slice(0, 4) + "****";

    try {
      const serverInfo = await plexService.checkConnection();
      res.json({ reloaded: true, tokenMasked, valid: true, serverInfo });
    } catch (err) {
      const errorMsg = err.response?.status ? `HTTP ${err.response.status}` : err.message;
      res.json({ reloaded: true, tokenMasked, valid: false, error: errorMsg });
    }
  });

  return router;
}
