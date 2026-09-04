import { PlexProvider } from "./PlexProvider.js";
import { logger } from "../logger.js";

export { MediaServerProvider, NotImplementedError } from "./MediaServerProvider.js";
export { PlexProvider };

/**
 * Providers disponíveis. Para plugar um servidor novo, implemente
 * MediaServerProvider e adicione a classe aqui — mais nada muda.
 */
const PROVIDERS = {
  [PlexProvider.type]: PlexProvider,
};

export function supportedMediaServers() {
  return Object.keys(PROVIDERS);
}

/**
 * @param {{ type?: string, axios, url?: string, token?: string, analysisCache?: object }} config
 * @returns {import('./MediaServerProvider.js').MediaServerProvider}
 */
export function createMediaServer({ type, ...deps } = {}) {
  const wanted = (type || process.env.MEDIA_SERVER || PlexProvider.type).toLowerCase();
  const Provider = PROVIDERS[wanted];

  if (!Provider) {
    throw new Error(
      `Servidor de mídia "${wanted}" não suportado. Disponíveis: ${supportedMediaServers().join(", ")}. ` +
      `Implemente MediaServerProvider em src/media/ e registre em src/media/index.js.`
    );
  }

  logger.info("MEDIA", `Servidor de mídia: ${wanted}`);
  return new Provider(deps);
}
