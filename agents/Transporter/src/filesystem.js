import fs from "fs";
import path from "path";
import { parseFile } from "music-metadata";

/**
 * Permissões da biblioteca.
 *
 * O container roda como root sobre bind mounts, então tudo que ele cria sai
 * root:root — diretório 0755 e arquivo 0644 pelo umask 022 padrão. O Plex e
 * qualquer outro usuário do host ficam sem poder apagar, renomear ou reescrever
 * o que o Transporter moveu.
 *
 * Arquivo é 0666 e não 0777 de propósito: mídia não é executável, e marcar .flac
 * como executável só polui a listagem. Diretório PRECISA do bit x — sem ele não
 * dá para atravessar a pasta, mesmo com r e w.
 *
 * Isto é best-effort: em share CIFS/SMB o chmod é no-op (as permissões vêm das
 * opções de mount file_mode=/dir_mode=), e num filesystem onde não somos donos
 * ele lança. Nos dois casos o arquivo já está no lugar certo — falhar o move por
 * causa do chmod seria pior do que a permissão apertada.
 */
export const MEDIA_FILE_MODE = 0o666;
export const MEDIA_DIR_MODE  = 0o777;

function chmodBestEffort(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // CIFS (no-op), dono diferente, filesystem read-only — ver comentário acima.
  }
}

/**
 * Garante que um diretório existe (cria recursivamente se necessário) e que
 * ele é gravável por qualquer usuário.
 *
 * O chmod não pode ser trocado pelo `mode` do mkdirSync: aquele valor ainda
 * passa pelo umask do processo. E só as pastas que ESTA chamada criou são
 * ajustadas — reescrever a permissão de uma pasta que já existia seria mexer
 * em algo que não é nosso.
 */
export function ensureDir(dir) {
  const criados = [];
  for (let atual = path.resolve(dir); ; atual = path.dirname(atual)) {
    if (fs.existsSync(atual)) break;
    criados.push(atual);
    if (path.dirname(atual) === atual) break;
  }

  fs.mkdirSync(dir, { recursive: true });

  for (const novo of criados) chmodBestEffort(novo, MEDIA_DIR_MODE);
}

/**
 * Move um arquivo com fallback para copy+unlink em filesystems diferentes (EXDEV).
 * Cria o diretório destino automaticamente se não existir.
 */
export function moveFile(src, dest) {
  ensureDir(path.dirname(dest));
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code === "EXDEV") {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
  // Depois do move, nunca antes: o rename PRESERVA a permissão de origem (o que
  // o WebTorrent/streamrip criou) e o copyFileSync cria com 0666 & ~umask. Nos
  // dois caminhos o arquivo chega na biblioteca sem permissão de escrita para
  // ninguém além do root.
  chmodBestEffort(dest, MEDIA_FILE_MODE);
}

/**
 * Remove diretório se estiver vazio (bottom-up recursivo).
 * Silencioso se não existir.
 */
export function removeIfEmpty(dir) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    if (fs.statSync(full).isDirectory()) removeIfEmpty(full);
  }
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/**
 * Lê a cover art embutida no primeiro arquivo de áudio e salva como folder.jpg no álbum.
 * Silencioso se não houver cover ou ocorrer erro.
 */
export async function saveCoverArt(albumDir, audioFile) {
  const coverPath = path.join(albumDir, "folder.jpg");
  if (fs.existsSync(coverPath)) return;
  try {
    const metadata = await parseFile(audioFile, { skipCovers: false });
    const pictures = metadata.common.picture;
    if (!pictures || pictures.length === 0) return;
    ensureDir(albumDir);
    fs.writeFileSync(coverPath, pictures[0].data);
    chmodBestEffort(coverPath, MEDIA_FILE_MODE);
  } catch {
    // sem cover ou falha de leitura — ignorar silenciosamente
  }
}
