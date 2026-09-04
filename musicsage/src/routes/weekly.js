/**
 * GET  /api/weekly       — estado da descoberta semanal (config, última run, erro)
 * PUT  /api/weekly       — atualiza { enabled, dayOfWeek, hour, size, clusterDiversity }
 * POST /api/weekly/run   — regenera agora; devolve { jobId } (progresso em /api/jobs/:id)
 */
export function weeklyRouter(router, { weeklyDiscoveryService, jobRunner } = {}) {
  const guard = (res) =>
    !weeklyDiscoveryService && res.status(503).json({ error: "WeeklyDiscoveryService não disponível" });

  router.get("/weekly", (_req, res) => {
    if (guard(res)) return;
    res.json(weeklyDiscoveryService.status());
  });

  router.put("/weekly", (req, res) => {
    if (guard(res)) return;
    const { enabled, dayOfWeek, hour, size, clusterDiversity } = req.body || {};
    if (dayOfWeek != null && (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)) {
      return res.status(400).json({ error: "'dayOfWeek' deve ser inteiro de 0 (domingo) a 6" });
    }
    if (hour != null && (!Number.isInteger(hour) || hour < 0 || hour > 23)) {
      return res.status(400).json({ error: "'hour' deve ser inteiro de 0 a 23" });
    }
    if (size != null && (!Number.isInteger(size) || size < 5 || size > 100)) {
      return res.status(400).json({ error: "'size' deve ser inteiro de 5 a 100" });
    }
    res.json(weeklyDiscoveryService.updateSettings({ enabled, dayOfWeek, hour, size, clusterDiversity }));
  });

  router.post("/weekly/run", (req, res) => {
    if (guard(res)) return;
    if (!jobRunner) return res.status(503).json({ error: "JobRunner não disponível" });
    if (weeklyDiscoveryService.status().running) {
      return res.status(409).json({ error: "Já existe uma descoberta semanal em andamento" });
    }
    const job = jobRunner.start("weekly", "descoberta semanal", ({ progress }) =>
      weeklyDiscoveryService.run({ onProgress: progress })
    );
    res.status(202).json({ jobId: job.id });
  });
}
