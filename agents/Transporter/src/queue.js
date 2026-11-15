import fs from "fs";
import path from "path";

/**
 * Fila de eventos do auto-Transporter (módulo puro, sem I/O além do manifest).
 *
 * Problema original: cada torrent concluído disparava um Transporter que
 * varria a pasta de downloads inteira — movendo arquivos parciais dos
 * torrents ainda baixando. Agora cada evento guarda o caminho do item
 * concluído e o Transporter processa SOMENTE esses caminhos.
 *
 * Com debounce: eventos que chegam em rajada (3 torrents terminam juntos)
 * viram UMA execução com 3 caminhos.
 */
export class TransportQueue {
  /**
   * @param {object} opts
   * @param {number}   opts.debounceMs   Janela de agregação de eventos
   * @param {string}   opts.manifestFile Arquivo onde a fila pendente persiste
   * @param {boolean}  opts.hasActiveDownloads()  true se algum torrent está baixando
   * @param {number}   opts.activeRetryMs Espera quando há downloads ativos
   * @param {(groups: Array<{type:string, paths:string[]}>) => void} opts.onDispatch
   *        Chamado com os grupos agrupados quando o drain despacha.
   * @param {(reason: string, data?: object) => void} opts.onLog
   */
  constructor({
    debounceMs = 30_000,
    manifestFile,
    hasActiveDownloads = () => false,
    activeRetryMs = 60_000,
    onDispatch = null,
    onLog = () => {},
  } = {}) {
    this.debounceMs = debounceMs;
    this.manifestFile = manifestFile;
    this.hasActiveDownloads = hasActiveDownloads;
    this.activeRetryMs = activeRetryMs;
    this.onDispatch = onDispatch;
    this.onLog = onLog;

    /** @type {Map<string, {type:string, path:string}>} key = caminho absoluto */
    this.pending = new Map();
    this._timer = null;
    this._activeRetryTimer = null;
    this._draining = false;
    this._restoreManifest();
  }

  /** Enfileira um item concluído. Aceita string (caminho) ou {type, path}. */
  enqueue(target) {
    const { type, p } =
      typeof target === "string"
        ? { type: "music", p: target }
        : { type: target.type || "music", p: target.path };
    if (!p) return;
    this.pending.set(path.resolve(p), { type, path: path.resolve(p) });
    this._persistManifest();
    this._schedule();
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.drain(), this.debounceMs);
  }

  /**
   * Executa a fila. Antes de despachar, verifica o guard de atividade:
   * se algum torrent ainda está baixando, adia — mover agora arriscaria
   * pegar arquivos parciais que porventura estejam nas pastas alvo.
   * @returns {Promise<{type:string, paths:string[]}[]>} grupos despachados
   */
  async drain() {
    if (this._draining || this.pending.size === 0) return [];
    if (this.hasActiveDownloads()) {
      this.onLog("download ativo em andamento — transporte adiado", {
        pending: this.pending.size,
      });
      this._scheduleActiveRetry();
      return [];
    }
    this._draining = true;
    clearTimeout(this._timer);
    try {
      // Agrupa por type: uma execução do run.js por tipo de mídia
      const groups = new Map();
      for (const item of this.pending.values()) {
        if (!groups.has(item.type)) groups.set(item.type, []);
        groups.get(item.type).push(item.path);
      }
      const dispatched = [];
      for (const [type, paths] of groups) {
        for (const p of paths) this.pending.delete(p);
        this._persistManifest();
        dispatched.push({ type, paths });
        this.onLog("despachando transporte", { type, paths });
      }
      if (dispatched.length && this.onDispatch) {
        try {
          this.onDispatch(dispatched);
        } catch (err) {
          this.onLog(`onDispatch falhou — reenfileirando: ${err.message}`);
          this.requeue(dispatched);
        }
      }
      return dispatched;
    } finally {
      this._draining = false;
    }
  }

  /** Chamado quando a execução despachada termina — se sobrou algo, reagenda. */
  notifyDispatched(groups) {
    if (this.pending.size > 0) this._schedule();
    void groups;
  }

  _scheduleActiveRetry() {
    clearTimeout(this._activeRetryTimer);
    this._activeRetryTimer = setTimeout(() => this.drain(), this.activeRetryMs);
  }

  /** Reinjeta itens que falharam no transporte (ex: processo morreu). */
  requeue(groups) {
    for (const g of groups) for (const p of g.paths) this.enqueue({ type: g.type, path: p });
  }

  _persistManifest() {
    if (!this.manifestFile) return;
    try {
      fs.mkdirSync(path.dirname(this.manifestFile), { recursive: true });
      fs.writeFileSync(
        this.manifestFile,
        JSON.stringify([...this.pending.values()], null, 2)
      );
    } catch (err) {
      this.onLog(`falha ao gravar manifest: ${err.message}`);
    }
  }

  _restoreManifest() {
    if (!this.manifestFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.manifestFile, "utf8"));
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item?.path) this.pending.set(path.resolve(item.path), { type: item.type || "music", path: path.resolve(item.path) });
        }
        if (this.pending.size > 0) {
          this.onLog(`fila restaurada do manifest (${this.pending.size} itens pendentes)`);
          this._schedule();
        }
      }
    } catch { /* sem manifest ou corrompido — começa vazia */ }
  }

  dispose() {
    clearTimeout(this._timer);
    clearTimeout(this._activeRetryTimer);
  }
}
