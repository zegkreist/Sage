import { randomUUID } from "crypto";

const MAX_FINISHED_JOBS = 40;

/**
 * JobRunner — executor de tarefas longas em background com progresso.
 *
 * start() roda a função em background e devolve um job consultável via
 * get(id): { status: running|done|error, stage, pct, result, error }.
 * A função recebe { progress(stage, pct) } para reportar estágios.
 * Estado em memória (jobs terminados podados ao passar de MAX_FINISHED_JOBS).
 */
export class JobRunner {
  constructor() {
    this._jobs = new Map();
  }

  /**
   * @param {string} type   — ex: "playlist"
   * @param {string} label  — descrição curta pro log
   * @param {({progress: (stage: string, pct?: number|null) => void}) => Promise<any>} fn
   * @returns {{ id: string }} snapshot inicial do job
   */
  start(type, label, fn) {
    const id = randomUUID();
    const job = {
      id, type, label,
      status: "running",
      stage: "Iniciando…",
      pct: 0,
      result: null,
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
    };
    this._jobs.set(id, job);

    Promise.resolve()
      .then(() =>
        fn({
          progress: (stage, pct = null) => {
            if (job.status !== "running") return;
            if (stage) job.stage = stage;
            if (pct != null) job.pct = Math.max(0, Math.min(100, Math.round(pct)));
          },
        })
      )
      .then((result) => {
        job.status = "done";
        job.result = result;
        job.pct = 100;
        job.stage = "Concluído";
        job.finishedAt = Date.now();
        this._gc();
      })
      .catch((err) => {
        job.status = "error";
        job.error = err?.message || String(err);
        job.stage = "Falhou";
        job.finishedAt = Date.now();
        this._gc();
      });

    return { id: job.id, status: job.status };
  }

  get(id) {
    const j = this._jobs.get(id);
    return j ? { ...j } : null;
  }

  _gc() {
    const finished = [...this._jobs.values()]
      .filter((j) => j.status !== "running")
      .sort((a, b) => a.finishedAt - b.finishedAt);
    while (finished.length > MAX_FINISHED_JOBS) {
      const oldest = finished.shift();
      this._jobs.delete(oldest.id);
    }
  }
}
