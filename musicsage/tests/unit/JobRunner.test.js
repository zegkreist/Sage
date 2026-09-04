import { jest } from "@jest/globals";
import { JobRunner } from "../../src/services/JobRunner.js";

describe("JobRunner", () => {
  let runner;

  beforeEach(() => {
    runner = new JobRunner();
  });

  it("job começa como running e termina done com resultado", async () => {
    const started = runner.start("playlist", "teste", async () => ({ id: "p1" }));

    const running = runner.get(started.id);
    expect(running.status).toBe("running");

    await new Promise((r) => setTimeout(r, 10));
    const done = runner.get(started.id);
    expect(done.status).toBe("done");
    expect(done.pct).toBe(100);
    expect(done.result).toEqual({ id: "p1" });
  });

  it("progress() atualiza stage e pct consultáveis durante a execução", async () => {
    let report;
    let resolveFn;
    const started = runner.start("playlist", "teste", ({ progress }) => {
      report = progress;
      report("Selecionando…", 40);
      return new Promise((res) => { resolveFn = res; });
    });

    await new Promise((r) => setTimeout(r, 5));
    const running = runner.get(started.id);
    expect(running.status).toBe("running");
    expect(running.stage).toBe("Selecionando…");
    expect(running.pct).toBe(40);

    resolveFn();
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.get(started.id).status).toBe("done");
  });

  it("rejeição da função vira status error com mensagem", async () => {
    const started = runner.start("playlist", "teste", async () => {
      throw new Error("Ollama fora do ar");
    });

    await new Promise((r) => setTimeout(r, 10));
    const job = runner.get(started.id);
    expect(job.status).toBe("error");
    expect(job.error).toBe("Ollama fora do ar");
  });

  it("pct informado é limitado a 0–100", async () => {
    const started = runner.start("playlist", "teste", ({ progress }) => {
      progress("x", 250);
      return null;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(runner.get(started.id).pct).toBe(100);
  });

  it("job não encontrado retorna null", () => {
    expect(runner.get("id-inexistente")).toBeNull();
  });

  it("jobs terminados além do limite são podados", async () => {
    // Cria 45 jobs que terminam imediatamente (limite interno = 40)
    for (let i = 0; i < 45; i++) {
      runner.start("playlist", `job ${i}`, async () => i);
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 20));

    const remaining = [...runner._jobs.values()];
    expect(remaining.length).toBeLessThanOrEqual(40);
    expect(remaining.every((j) => j.status !== "running")).toBe(true);
  });
});
