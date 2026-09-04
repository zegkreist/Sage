/** GET /api/jobs/:id — status/estágio/resultado de um job em background */
export function jobsRouter(router, { jobRunner } = {}) {
  router.get("/jobs/:id", (req, res) => {
    const job = jobRunner?.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job não encontrado" });
    res.json(job);
  });
}
