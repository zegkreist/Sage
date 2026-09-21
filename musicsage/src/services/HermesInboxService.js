import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { logger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../../data");

/**
 * HermesInboxService — canal de controle em markdown entre o Hermes e o Sage.
 *
 * Vive em DATA_DIR/hermes/, que no deploy é um bind mount (./musicsage/data →
 * /data), então os arquivos aparecem direto na pasta de deploy — é assim que o
 * Hermes enxerga e controla o Sage sem precisar de API.
 *
 *   README.md    — contrato (escrito pelo Sage, regerado a cada boot)
 *   requests.md  — caixa de entrada (escrita pelo HERMES; o Sage só remove linhas prontas)
 *   done.md      — histórico append-only (escrito pelo Sage)
 *   status.md    — estado atual (escrito pelo Sage)
 *
 * Regra de ouro: requests.md pertence ao Hermes. Ao concluir um item o Sage
 * remove EXATAMENTE aquela linha e não toca em mais nada — cabeçalhos,
 * comentários e o texto que o Hermes escreveu em volta sobrevivem intactos.
 */

/**
 * Permissões do canal.
 *
 * O container do Sage roda como **root** e /data é um bind mount, então tudo
 * que ele cria sai como root:root 0644 no host — e o Hermes, rodando como
 * outro usuário, não conseguiria escrever nada.
 *
 * `requests.md` pertence ao Hermes: precisa ser gravável por qualquer um.
 * O diretório também, porque escrever um arquivo por tmp+rename (o que a
 * maioria dos editores e agentes faz) exige permissão de escrita na PASTA,
 * não só no arquivo.
 *
 * Os arquivos que só o Sage escreve (README/done/status) ficam 0644: o Hermes
 * só precisa lê-los.
 *
 * Mundo-gravável é aceitável aqui de propósito: é um NAS doméstico e o objetivo
 * declarado do diretório é a troca entre processos de donos diferentes.
 */
const DIR_MODE    = 0o777;  // rwx para todos — necessário para tmp+rename
const SHARED_MODE = 0o666;  // rw para todos — requests.md

/** Linha de tarefa markdown: "- [ ] conteúdo" ou "* [x] conteúdo". */
const TASK_LINE = /^(\s*[-*]\s*\[)( |x|X)(\]\s*)(.+?)(\s*)$/;

/** Tags reconhecidas no fim do texto: #album, #track, #tidal, #torrent, (album)… */
const TAG = /(?:^|\s)(?:#(album|track|tidal|torrent)\b|\((album|track|tidal|torrent)\))/gi;

/**
 * Separadores aceitos entre artista e título — um agente escreve qualquer um.
 * Testados em ordem: travessão/hífen/pipe primeiro, dois-pontos só como último
 * recurso. "Use Your Illusion II: The Return" tem dois-pontos no próprio nome,
 * então só cortamos ali quando não existe separador melhor na linha.
 */
const ARTIST_SEPS = [/\s+(?:—|–|-{1,2}|\|)\s+/, /\s*:\s+/];

export class HermesInboxService {
  constructor({ dataDir } = {}) {
    this.dir      = path.join(dataDir || _DATA_DIR, "hermes");
    this.requests = path.join(this.dir, "requests.md");
    this.done     = path.join(this.dir, "done.md");
    this.status   = path.join(this.dir, "status.md");
    this.readme   = path.join(this.dir, "README.md");
    this._lastListFingerprint = null;   // evita repetir o log a cada polling
  }

  // ── Parsing ───────────────────────────────────────────────────────────────

  /**
   * ID estável de um pedido: hash do texto normalizado.
   * Sobrevive a reordenação do arquivo e a edições em volta da linha — o que
   * um índice de linha não faria.
   */
  static makeId(text) {
    const norm = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
    return crypto.createHash("sha1").update(norm).digest("hex").slice(0, 12);
  }

  /**
   * Interpreta o conteúdo de uma linha de pedido.
   * Aceita: "Artista — Música", "Artista - Álbum #album",
   * um link do Tidal cru, ou texto livre (vira query de busca).
   */
  static parseRequest(raw) {
    let text = String(raw || "").trim();

    // Link do Tidal em qualquer posição da linha
    const urlMatch = text.match(/https?:\/\/\S*tidal\.com\/\S+/i);
    const tidalUrl = urlMatch ? urlMatch[0].replace(/[.,;)]+$/, "") : null;

    // Tags explícitas (#album, #tidal…) — removidas do texto exibido
    const tags = new Set();
    for (const m of text.matchAll(TAG)) {
      tags.add((m[1] || m[2]).toLowerCase());
    }
    text = text.replace(TAG, " ").replace(/\s{2,}/g, " ").trim();

    // O link não faz parte do nome
    let label = tidalUrl ? text.replace(tidalUrl, "").trim() : text;
    label = label.replace(/^[-–—|:,\s]+|[-–—|:,\s]+$/g, "").trim();

    // markdown link: [Nome](url) → fica só o nome
    const mdLink = label.match(/^\[([^\]]+)\]\([^)]*\)$/);
    if (mdLink) label = mdLink[1].trim();

    // ── Tipo ──────────────────────────────────────────────────────────────
    // "unknown" é um valor legítimo: "Artista — Título" não diz se é faixa ou
    // álbum, e fingir que diz foi o que mandou música para o torrent errado.
    let kind, kindReason;
    if (tags.has("track")) {
      kind = "track"; kindReason = "tag #track";
    } else if (tags.has("album")) {
      kind = "album"; kindReason = "tag #album";
    } else if (tidalUrl) {
      const isTrack = /\/track\/\d+/i.test(tidalUrl);
      kind = isTrack ? "track" : "album";
      kindReason = `link do Tidal (/${isTrack ? "track" : "album"}/)`;
    } else {
      kind = "unknown"; kindReason = "sem tag e sem link — não dá para saber pelo texto";
    }

    let artist = null;
    let title  = label || null;
    for (const sep of ARTIST_SEPS) {
      const parts = label ? label.split(sep) : [];
      if (parts.length >= 2) {
        artist = parts[0].trim();
        title  = parts.slice(1).join(" - ").trim();
        break;
      }
    }

    // ── Origem ────────────────────────────────────────────────────────────
    // Tidal é o padrão porque cobre OS DOIS casos (faixa e álbum), é lossless
    // e não tem ambiguidade de versão. Torrent é o fallback para o que não
    // está no Tidal, e por isso precisa ser pedido explicitamente com #torrent.
    //
    // O padrão anterior era torrent, o que mandava toda linha "Artista — Música"
    // sem tag para o Stormbringer — exatamente o contrário do que se quer de
    // uma lista de músicas.
    let source, sourceReason;
    if (tags.has("torrent")) {
      source = "torrent"; sourceReason = "tag #torrent";
    } else if (tidalUrl) {
      source = "tidal";   sourceReason = "link do Tidal no pedido";
    } else if (tags.has("tidal")) {
      source = "tidal";   sourceReason = "tag #tidal";
    } else if (kind === "track") {
      source = "tidal";   sourceReason = "faixa avulsa só existe no Tidal (torrent é álbum)";
    } else {
      source = "tidal";   sourceReason = "padrão — Tidal cobre faixa e álbum; use #torrent para forçar torrent";
    }

    // Torrent não distribui faixa avulsa — se a origem é torrent, é álbum.
    if (source === "torrent" && kind === "unknown") {
      kind = "album";
      kindReason = "torrent só distribui álbum";
    }

    return {
      text: label || (tidalUrl ?? ""),
      artist,
      title,
      kind,
      source,
      tidalUrl,
      tags: [...tags],
      // Por que caiu nessa rota — vai para o log e para a interface, para a
      // decisão nunca mais ser invisível.
      reason: `${source} (${sourceReason}); tipo ${kind} (${kindReason})`,
    };
  }

  // ── Leitura ───────────────────────────────────────────────────────────────

  _read(file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") {
        logger.warn("HERMES", `Falha ao ler ${file}: ${err.message}`);
      }
      return null;
    }
  }

  /**
   * Pedidos pendentes de requests.md.
   *
   * Efeito colateral deliberado: linhas já marcadas "- [x]" (o usuário ou o
   * próprio Hermes marcou à mão) são arquivadas em done.md e somem do
   * requests.md — é o mesmo contrato de um item concluído pela UI.
   */
  list() {
    const content = this._read(this.requests);
    if (content == null) return [];

    const items = [];
    const checkedOffline = [];
    const unparsed = [];   // linha de tarefa que não virou pedido — vale avisar

    for (const line of content.split("\n")) {
      const m = line.match(TASK_LINE);
      if (!m) continue;
      const [, , mark, , body] = m;
      const parsed = HermesInboxService.parseRequest(body);
      if (!parsed.text) { unparsed.push(body); continue; }

      if (mark.toLowerCase() === "x") {
        checkedOffline.push({ id: HermesInboxService.makeId(body), ...parsed });
        continue;
      }
      items.push({ id: HermesInboxService.makeId(body), raw: body, ...parsed });
    }

    for (const item of checkedOffline) {
      this.resolve(item.id, { status: "done", detail: "marcado à mão no requests.md" });
    }

    // Só loga quando a leitura MUDA — este método roda no polling de 5s da
    // interface e, sem isso, afogaria o log com a mesma lista repetida.
    const fingerprint = items.map(i => `${i.id}:${i.source}`).join(",");
    if (fingerprint !== this._lastListFingerprint) {
      this._lastListFingerprint = fingerprint;
      logger.info("HERMES", `${items.length} pedido(s) pendente(s) em ${this.requests}`);
      for (const i of items) {
        logger.info("HERMES", `  • "${i.text}" → ${i.reason}`);
      }
      if (unparsed.length) {
        logger.warn("HERMES", `${unparsed.length} linha(s) de tarefa ignorada(s) por estarem vazias após o parse — confira o formato em README.md`);
        for (const u of unparsed) logger.warn("HERMES", `  ✗ linha ignorada: ${u}`);
      }
    }

    return items;
  }

  // ── Escrita ───────────────────────────────────────────────────────────────

  /**
   * Conclui um pedido: remove a linha de requests.md e registra em done.md.
   * @param {string} id
   * @param {{status?: "done"|"skipped", detail?: string, source?: string}} info
   * @returns {{ok: boolean, item?: object, reason?: string}}
   */
  resolve(id, { status = "done", detail = "", source = "" } = {}) {
    const content = this._read(this.requests);
    if (content == null) return { ok: false, reason: "requests.md não existe" };

    const lines = content.split("\n");
    let removed = null;
    const kept = [];

    for (const line of lines) {
      const m = line.match(TASK_LINE);
      if (!removed && m && HermesInboxService.makeId(m[4]) === id) {
        removed = HermesInboxService.parseRequest(m[4]);
        continue; // some da caixa de entrada
      }
      kept.push(line);
    }

    if (!removed) {
      const reason = `pedido ${id} não encontrado em ${path.basename(this.requests)} — `
        + "a linha pode ter sido editada ou removida à mão depois que a interface a carregou";
      logger.warn("HERMES", reason);
      return { ok: false, reason };
    }

    this._writeAtomic(this.requests, kept.join("\n"));
    this._appendDone(removed, { status, detail, source });
    this._lastListFingerprint = null;   // a lista mudou — deixa o próximo list() logar
    const verb = status === "done" ? "concluído" : "dispensado";
    logger.info(
      "HERMES",
      `Pedido ${verb}: "${removed.text}"${source ? ` via ${source}` : ""}${detail ? ` — ${detail}` : ""}`
      + ` | saiu de ${path.basename(this.requests)}, registrado em ${path.basename(this.done)}`,
    );
    return { ok: true, item: { id, ...removed } };
  }

  _appendDone(item, { status, detail, source }) {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    const icon  = status === "done" ? "x" : " ";
    // Só registra a origem quando ela é FATO (veio do download que concluiu).
    // item.source é apenas a sugestão do parser — num item marcado à mão nada
    // foi baixado, e escrever "via torrent" ali seria mentira no histórico.
    const via   = source || "";
    const bits  = [
      `- [${icon}] ${stamp} — ${item.text}`,
      via    ? `via ${via}`    : null,
      status !== "done" ? `(${status})` : null,
      detail ? detail          : null,
    ].filter(Boolean);
    const line = bits.join(" — ") + "\n";

    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(this.done)) {
        fs.writeFileSync(
          this.done,
          "# Concluídos\n\n"
          + "Histórico append-only escrito pelo Sage. Cada linha saiu do `requests.md`.\n\n",
        );
      }
      fs.appendFileSync(this.done, line);
    } catch (err) {
      logger.warn("HERMES", `Falha ao registrar em done.md: ${err.message}`);
    }
  }

  /**
   * chmod tolerante a falha — em CIFS/exFAT/9p o chmod não existe e lança.
   * Perder a permissão ideal não pode derrubar o canal de controle.
   */
  _chmod(target, mode) {
    try {
      fs.chmodSync(target, mode);
      return true;
    } catch (err) {
      logger.debug("HERMES", `chmod ${mode.toString(8)} falhou em ${target}: ${err.message}`);
      return false;
    }
  }

  /**
   * Grava por tmp+rename (nunca deixa o arquivo pela metade).
   *
   * O rename troca o INODE, então a permissão do arquivo antigo se perderia:
   * um requests.md deixado 0666 voltaria a 0644 na primeira conclusão e o
   * Hermes perderia a escrita silenciosamente. Por isso a permissão atual é
   * lida antes e reaplicada depois.
   *
   * Nota: o `mode` de writeFileSync/mkdirSync é mascarado pelo umask (0022 no
   * container), mas chmod NÃO é — daí a chamada explícita.
   */
  _writeAtomic(file, content, defaultMode = null) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });

      let mode = defaultMode;
      try {
        mode = fs.statSync(file).mode & 0o777;
      } catch { /* ainda não existe — vale o defaultMode */ }

      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, file);
      if (mode != null) this._chmod(file, mode);
      return true;
    } catch (err) {
      logger.warn("HERMES", `Falha ao gravar ${file}: ${err.message}`);
      return false;
    }
  }

  // ── status.md ─────────────────────────────────────────────────────────────

  /**
   * Reescreve status.md com o estado atual — é o canal de volta do Sage
   * para o Hermes (ele escreve pedido, lê aqui se deu certo).
   */
  writeStatus({ library = null, queue = [], pending = [], recentErrors = [] } = {}) {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const L = [];
    L.push("# Status do Sage");
    L.push("");
    L.push(`_Gerado automaticamente pelo Sage em ${now} UTC. Não edite — é sobrescrito._`);
    L.push("");

    L.push("## Biblioteca");
    L.push("");
    if (library) {
      L.push(`- Artistas: ${library.artists ?? "?"}`);
      L.push(`- Álbuns: ${library.albums ?? "?"}`);
      L.push(`- Faixas: ${library.tracks ?? "?"}`);
    } else {
      L.push("- Indisponível (servidor de mídia fora do ar ou scan ainda não rodou)");
    }
    L.push("");

    L.push("## Pedidos pendentes");
    L.push("");
    if (pending.length) {
      for (const p of pending) L.push(`- ${p.text}${p.kind ? ` _(${p.kind}, via ${p.source})_` : ""}`);
    } else {
      L.push("_Nenhum. `requests.md` está vazio._");
    }
    L.push("");

    L.push("## Fila agora");
    L.push("");
    if (queue.length) {
      for (const q of queue) {
        const pct = typeof q.pct === "number" ? ` ${q.pct}%` : "";
        L.push(`- \`${q.source}\` ${q.title ?? q.id} — **${q.status}**${pct}`);
      }
    } else {
      L.push("_Vazia._");
    }
    L.push("");

    if (recentErrors.length) {
      L.push("## Erros recentes");
      L.push("");
      for (const e of recentErrors) {
        L.push(`- \`${e.source}\` ${e.title ?? e.id} — ${String(e.error ?? "erro").slice(0, 160)}`);
      }
      L.push("");
    }

    return this._writeAtomic(this.status, L.join("\n"));
  }

  // ── Scaffold ──────────────────────────────────────────────────────────────

  /**
   * Garante a pasta, os arquivos e as permissões.
   *
   * README.md é regerado sempre (documentação do Sage, precisa acompanhar a
   * versão); requests.md só é criado se faltar, porque o dono dele é o Hermes.
   *
   * As permissões são reaplicadas a CADA boot, e não só na criação: conserta
   * uma instalação que já existia de antes e desfaz um aperto acidental que
   * deixaria o Hermes mudo.
   */
  ensureScaffold() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this._chmod(this.dir, DIR_MODE);

      this._writeAtomic(this.readme, HERMES_README);
      if (!fs.existsSync(this.requests)) {
        this._writeAtomic(this.requests, REQUESTS_TEMPLATE, SHARED_MODE);
      }
      this._chmod(this.requests, SHARED_MODE);

      const mode = this._modeOf(this.requests);
      logger.info("HERMES", `Canal de controle em ${this.dir} (requests.md ${mode}, pasta ${this._modeOf(this.dir)})`);
      if (mode && !mode.endsWith("6")) {
        logger.warn("HERMES", `requests.md está ${mode} — o Hermes pode não conseguir escrever nele`);
      }
    } catch (err) {
      // Nunca derrubar o boot por causa do canal do Hermes
      logger.warn("HERMES", `Falha ao preparar ${this.dir}: ${err.message}`);
    }
    return this;
  }

  /** Permissão atual em octal ("0666") — null se o caminho não existe. */
  _modeOf(target) {
    try {
      return "0" + (fs.statSync(target).mode & 0o777).toString(8);
    } catch {
      return null;
    }
  }
}

const REQUESTS_TEMPLATE = `# Pedidos de download

Escreva aqui o que você quer que o Sage baixe, uma linha por item.
O Sage lê este arquivo, mostra os pendentes na aba **Downloads** da interface,
e remove a linha quando o download conclui (o registro vai para \`done.md\`).

Formato: \`- [ ] Artista — Título\`. Veja \`README.md\` para todas as opções.

- [ ] Radiohead — OK Computer
- [ ] Miles Davis — So What #track
- [ ] https://tidal.com/browse/album/77654321
`;

const HERMES_README = `# Canal de controle do Sage

Este diretório é a interface entre um agente (Hermes) e o **Sage**, o servidor
de curadoria e download de música. Não há API a chamar: tudo acontece por
arquivos markdown nesta pasta, que é um bind mount do container do Sage
(\`./musicsage/data\` no host → \`/data\` no container).

## O que o Sage faz

O Sage é um servidor Node que junta quatro peças:

| Peça | Papel |
|---|---|
| **Plex** (servidor de mídia) | biblioteca de origem: artistas, álbuns, faixas, histórico de play |
| **Stormbringer** | busca e baixa **torrents** (música, filme, série) via Jackett + WebTorrent |
| **TideCaller** | baixa do **Tidal** em FLAC via streamrip (álbum inteiro ou faixa avulsa) |
| **Transporter** | move o que foi baixado para a biblioteca do Plex, já organizado em \`Artista/Álbum (Ano)/\` |

Fluxo de um download: **busca → fila → download → Transporter → biblioteca**.
O Transporter roda automaticamente quando um download conclui (toggle
\`autoTransporter\` na interface).

## Os arquivos

| Arquivo | Quem escreve | Permissão | Para quê |
|---|---|---|---|
| \`README.md\` | Sage | 0644 | este contrato (regerado a cada boot — não edite) |
| \`requests.md\` | **Hermes** | **0666** | a fila de pedidos |
| \`done.md\` | Sage | 0644 | histórico append-only do que concluiu |
| \`status.md\` | Sage | 0644 | estado atual: biblioteca, fila, pendentes, erros |

O diretório é \`0777\` e o \`requests.md\` é \`0666\` de propósito: o Sage roda
como root dentro do container, então sem isso os arquivos nasceriam
\`root:root 0644\` no host e você não conseguiria escrever. A pasta precisa ser
gravável (não só o arquivo) porque gravar por tmp+rename — o que a maioria dos
editores e agentes faz — exige permissão de escrita no **diretório**.

O Sage reaplica essas permissões a cada boot e as preserva ao reescrever o
\`requests.md\`, então você não perde a escrita quando um pedido é concluído.
Se mesmo assim der "permission denied", veja se a pasta no host não está num
filesystem que ignora chmod (CIFS/exFAT) — nesse caso ajuste no \`mount\`.

## Como pedir um download

Adicione linhas em \`requests.md\` como itens de lista de tarefa:

\`\`\`markdown
- [ ] Radiohead — Creep
- [ ] Miles Davis — So What #track
- [ ] Radiohead — OK Computer #album
- [ ] Pink Floyd — Wish You Were Here #torrent
- [ ] https://tidal.com/browse/track/12345678
- [ ] https://tidal.com/browse/album/77654321
\`\`\`

**Separador artista/título**: \`—\`, \`–\`, \`-\`, \`|\` ou \`:\` — qualquer um serve.
Sem separador, a linha inteira vira uma busca livre.

**Origem padrão: Tidal.** Um pedido sem tag vai para o Tidal, porque o Tidal
cobre os dois casos (faixa e álbum), é lossless e não tem ambiguidade de versão.
O torrent é o fallback para o que não está no Tidal — e por isso precisa ser
pedido de propósito com \`#torrent\`.

**Tags opcionais** (no fim da linha, \`#tag\` ou \`(tag)\`):

| Tag | Efeito |
|---|---|
| \`#track\` | é uma faixa só — sempre Tidal, porque torrent não distribui faixa avulsa |
| \`#album\` | é um álbum inteiro (continua no Tidal, salvo \`#torrent\`) |
| \`#tidal\` | explicita a origem Tidal (já é o padrão) |
| \`#torrent\` | **muda a origem para torrent** (Jackett) — use quando não está no Tidal |

Sem \`#track\` nem \`#album\`, o tipo fica "não informado" e a interface oferece
as duas buscas. Tagear ajuda, mas nada trava por falta de tag: cada pedido tem
os botões 🌊 Tidal e ⚡ Torrent, e a interface mostra **por que** ele caiu na
rota que caiu.

**Link do Tidal** colado direto funciona e é o caminho mais preciso: não há
ambiguidade sobre qual versão baixar. Link de faixa
(\`/track/ID\`) baixa uma música só, e ela cai na mesma estrutura de pastas de
um álbum, que é o que o Transporter sabe organizar.

## O que acontece depois

1. O pedido aparece no card **"Pedidos do Hermes"**, aba Downloads da interface.
2. Um humano clica para disparar — a busca já vem preenchida. Downloads de
   torrent **não** são automáticos de propósito: a escolha entre versões
   (FLAC vs 320, edição, remaster) precisa de julgamento.
3. Quando o download conclui, o Sage **remove a linha** de \`requests.md\` e
   grava o registro em \`done.md\` com data e origem.
4. \`status.md\` é reescrito periodicamente — é lá que você confere o resultado.

Marcar uma linha como \`- [x]\` à mão também a arquiva: na próxima leitura ela
sai do \`requests.md\` e vai para o \`done.md\` como "marcado à mão".

## Limites que valem saber

- **Faixa avulsa por torrent não funciona.** Torrents são álbuns. Faixa só sai
  pelo Tidal — é por isso que \`#track\` nunca vai para o torrent.
- **O Tidal não tem tudo.** Se a busca voltar vazia, o log diz
  \`"<query>" → nenhuma faixa\` e o caminho é marcar \`#torrent\` no pedido (ou
  clicar em ⚡ Torrent na interface).
- **Tidal precisa de token OAuth válido.** Se expirou, o download falha com
  "Token Tidal inválido" e o erro aparece em \`status.md\`; um humano precisa
  refazer o login na interface.
- **Torrent depende do Jackett** estar de pé e com indexers configurados.
- O Sage **não apaga nada** da biblioteca nem do \`requests.md\` além da linha
  exata que concluiu.
`;
