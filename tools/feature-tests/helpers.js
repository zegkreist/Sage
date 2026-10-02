// Helpers compartilhados dos testes de feature (filesystem real em tmp dirs).
import fs from "fs";
import os from "os";
import path from "path";

export function makeTmp(prefix = "sage-feature-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function touch(filePath, content = "x") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Cria uma "release" estilo streamrip/Tidal: Artista - Álbum (Ano) [FLAC] [...] */
export function makeStreamripRelease(base, artist, album, year, tracks = 2) {
  const folder = path.join(base, `${artist} - ${album} (${year}) [FLAC] [16B-44.1kHz]`);
  for (let i = 1; i <= tracks; i++) {
    touch(path.join(folder, `${String(i).padStart(2, "0")}. ${artist} - track${i}.flac`));
  }
  touch(path.join(folder, "cover.jpg"));
  return folder;
}

/** Cria uma release estilo torrent: Artist/Album/track (caso C) */
export function makeTorrentRelease(base, artist, album, tracks = 2) {
  const folder = path.join(base, artist, album);
  for (let i = 1; i <= tracks; i++) {
    touch(path.join(folder, `${String(i).padStart(2, "0")} - faixa.flac`));
  }
  return folder;
}

export function rmRf(p) {
  try {
    fs.chmodSync(p, 0o755);
  } catch { /* pode não existir */ }
  fs.rmSync(p, { recursive: true, force: true });
}

export const TP = "/opt/data/dev/Sage/agents/Transporter/src";
export const SB = "/opt/data/dev/Sage/agents/Stormbringer/src";
