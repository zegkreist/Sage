/**
 * Canal de controle do Hermes — ver src/services/HermesInboxService.js.
 *
 *   GET  /api/hermes/inbox              — pedidos pendentes de requests.md
 *   POST /api/hermes/inbox/:id/resolve  — conclui/pula um pedido à mão
 *   POST /api/hermes/status             — reescreve status.md agora
 */
import { queueSnapshot } from "./tools.js";
import { logger } from "../logger.js";

/**
 * Reescreve status.md com biblioteca + fila + pendentes.
 * Usado no boot, num intervalo e sob demanda pela rota.
 */
export async function refreshHermesStatus({ hermesInbox, libraryScanner } = {}) {
  if (!hermesInbox) return false;

  let library = null;
  try {
    // scan() tem TTL de 1 min e nunca zera o snapshot anterior — barato de chamar
    const snap = await libraryScanner?.scan();
    if (snap) {
      library = {
        artists: snap.artists?.length ?? 0,
        albums:  snap.albums?.length  ?? 0,
        tracks:  snap.tracks?.length  ?? 0,
      };
    }
  } catch {
    // Servidor de mídia fora do ar — status.md registra "indisponível"
  }

  const queue = queueSnapshot();
  return hermesInbox.writeStatus({
    library,
    queue: queue.items,
    pending: hermesInbox.list(),
    recentErrors: queue.history.filter((h) => h.status === "error").slice(0, 5),
  });
}

export function hermesRouter(router, { hermesInbox, libraryScanner } = {}) {
  const guard = (res) =>
    !hermesInbox && res.status(503).json({ error: "Canal do Hermes não disponível" });

  router.get("/hermes/inbox", (_req, res) => {
    if (guard(res)) return;
    try {
      res.json({
        items: hermesInbox.list(),
        dir: hermesInbox.dir,
        updatedAt: Date.now(),
      });
    } catch (err) {
      logger.error("HERMES", `Falha ao ler a caixa de entrada: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/hermes/inbox/:id/resolve", async (req, res) => {
    if (guard(res)) return;
    const { status = "done", detail = "", source = "" } = req.body || {};
    if (!["done", "skipped"].includes(status)) {
      return res.status(400).json({ error: "'status' deve ser 'done' ou 'skipped'" });
    }

    const result = hermesInbox.resolve(req.params.id, { status, detail, source });
    if (!result.ok) return res.status(404).json({ error: result.reason });

    // status.md precisa refletir a mudança na hora — é o que o Hermes lê
    refreshHermesStatus({ hermesInbox, libraryScanner }).catch(() => {});
    res.json(result);
  });

  router.post("/hermes/status", async (_req, res) => {
    if (guard(res)) return;
    const ok = await refreshHermesStatus({ hermesInbox, libraryScanner });
    res.json({ ok, file: hermesInbox.status });
  });
}
