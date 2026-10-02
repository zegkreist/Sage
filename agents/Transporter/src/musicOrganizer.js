/**
 * Transporter — Music Organizer
 *
 * Lê de uma ou mais pastas de origem (TideCaller ou Stormbringer),
 * detecta e normaliza a estrutura de pastas e move para a library do Plex.
 *
 * Formatos de origem suportados:
 *   A) (Artist - Album)/track             → release na raiz, artista embutido no nome
 *   B) (Artist - Year - Album)/track      → release na raiz com ano
 *   C) Artist/Album/track                 → artista como pasta pai
 *   D) Artist/Album/CD 1/track            → artista → álbum → disco → faixas
 *   E) Artist - Album (Year) [quality]/t  → formato streamrip/Tidal
 *
 * Destino padrão: plex_server/music/Artist/Album (Year)/tracks
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  sanitizeName,
  isAudioFile,
  isDiscFolder,
  hasDirectAudio,
  isReleaseFolder,
  findAudioFiles,
  parseAlbumFolderName,
  moveFile,
  removeIfEmpty,
  saveCoverArt,
  findExistingAlbumDir,
  isLiveRecording,
  cleanAlbumName,
} from "./index.js";

export class MusicOrganizer {
  /**
   * @param {string}   destDir  - Pasta destino (ex: plex_server/music)
   * @param {object}   opts
   * @param {boolean}  opts.dryRun   - Apenas simula, não move nada
   * @param {boolean}  opts.verbose  - Log detalhado de cada faixa
   */
  constructor(destDir, { dryRun = false, verbose = false } = {}) {
    this.destDir = destDir;
    this.dryRun = dryRun;
    this.verbose = verbose;
    this.processedAlbums = new Map();
    this.stats = { moved: 0, skipped: 0, errors: 0, albums: 0 };
  }

  /**
   * Processa uma pasta de origem (pode ser TideCaller/downloads ou downloads/musicas).
   * @param {string} sourceDir
   * @param {string} [label]   - Nome da fonte para o log
   */
  async processSource(sourceDir, label = "") {
    if (!fs.existsSync(sourceDir)) {
      console.log(`⚠️  Pasta não encontrada: ${sourceDir}`);
      return;
    }

    const prefix = label ? `[${label}] ` : "";
    console.log(`\n📁 ${prefix}Escaneando ${sourceDir}...`);

    for (const item of fs.readdirSync(sourceDir)) {
      const itemPath = path.join(sourceDir, item);

      // Faixas avulsas soltas na raiz da fonte (TideCaller sem add_singles_to_folder):
      // vão para music/Singles/ em vez de ficarem presas para sempre.
      if (fs.statSync(itemPath).isFile()) {
        if (isAudioFile(itemPath)) {
          await this._moveLooseTrack(itemPath, prefix);
        }
        continue;
      }

      if (!fs.statSync(itemPath).isDirectory()) continue;

      if (isReleaseFolder(itemPath)) {
        // Caso A/B/E: a pasta raiz já é uma release (contém áudio diretamente)
        const info = parseAlbumFolderName(item);
        await this._moveRelease(itemPath, info.artist, info.album, info.year, prefix);
      } else {
        // Caso C/D/F: artista com subpastas de álbum OU pasta residual sem áudio
        // F inclui estruturas de 3 níveis: Artist/Year/Album/tracks
        let hasRelease = false;
        for (const sub of fs.readdirSync(itemPath)) {
          const subPath = path.join(itemPath, sub);
          if (!fs.statSync(subPath).isDirectory()) continue;

          if (isReleaseFolder(subPath)) {
            // Caso C/D: Artist/Album/tracks  ou  Artist/Year - Album/tracks
            hasRelease = true;
            const info = parseAlbumFolderName(sub);
            // Se o parse retornou um artista que é um número de 4 dígitos (ano),
            // o nome real do artista é o da pasta pai (item).
            // Além disso, nesse caso o "artista" extraído é na verdade o ano.
            const subArtistIsYear = /^\d{4}$/.test(info.artist);
            const resolvedArtist = (info.artist !== "Unknown Artist" && !subArtistIsYear)
              ? info.artist
              : item;
            const resolvedYear = info.year || (subArtistIsYear ? info.artist : null);
            await this._moveRelease(subPath, resolvedArtist, info.album, resolvedYear, prefix);
          } else {
            // Caso F: Artist/Year/Album/tracks — pasta intermediária (ex: ano como subdir)
            for (const subsub of fs.readdirSync(subPath)) {
              const subsubPath = path.join(subPath, subsub);
              if (!fs.statSync(subsubPath).isDirectory()) continue;
              if (!isReleaseFolder(subsubPath)) continue;

              hasRelease = true;
              const info = parseAlbumFolderName(subsub);
              // Artista sempre é a pasta raiz (item); sub pode ser o ano (ex: "1970")
              const yearFromSub = /^\d{4}$/.test(sub) ? sub : null;
              const subArtistIsYear = /^\d{4}$/.test(info.artist);
              const resolvedArtist = (info.artist !== "Unknown Artist" && !subArtistIsYear)
                ? info.artist
                : item;
              const resolvedYear = info.year || yearFromSub || (subArtistIsYear ? info.artist : null);
              await this._moveRelease(subsubPath, resolvedArtist, info.album, resolvedYear, prefix);
            }
            if (!this.dryRun) fs.rmSync(subPath, { recursive: true, force: true });
          }
        }
        if (!this.dryRun) {
          // Ainda existe e só tem imagens? Pasta residual de execução anterior
          if (fs.existsSync(itemPath)) {
            this._cleanResidualFolder(itemPath, item, prefix);
          }
          // Forçar remoção se não sobrou nenhum áudio
          if (fs.existsSync(itemPath) && !this._hasAnyAudio(itemPath)) {
            fs.rmSync(itemPath, { recursive: true, force: true });
            console.log(`${prefix}🗑️  ${item}  (pasta limpa após organização)`);
          }
        }
      }
    }
  }

  /**
   * Move todas as faixas de uma release para o destino Plex.
   * @private
   */
  async _moveRelease(releaseDir, artist, album, year, logPrefix = "") {
    const live = isLiveRecording(path.basename(releaseDir)) || isLiveRecording(album);
    const albumLabel = year ? `${album} (${year})` : album;
    const albumFolderName = live && !isLiveRecording(album) ? `${albumLabel} (Live)` : albumLabel;
    const cleanArtist = sanitizeName(artist);
    const artistDir = path.join(this.destDir, cleanArtist);

    // Deduplicação: reusar pasta existente com nome similar
    let albumDir = findExistingAlbumDir(artist, album, artistDir, this.processedAlbums);
    const isMerge = !!albumDir;

    if (!albumDir) {
      albumDir = path.join(artistDir, sanitizeName(albumFolderName));
      this.processedAlbums.set(`${cleanArtist}/${sanitizeName(albumFolderName)}`, {
        artist,
        albumName: album,
        albumFolderName,
        path: albumDir,
      });
      this.stats.albums++;
    }

    const icon = live ? "🎤" : "🎵";
    const mergeNote = isMerge ? "  (mesclando)" : "";
    console.log(`${logPrefix}${icon} ${artist} — ${albumFolderName}${mergeNote}`);

    const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
    const audioFiles = findAudioFiles(releaseDir);
    let count = 0;

    for (const audioFile of audioFiles) {
      const relPath = path.relative(releaseDir, audioFile);
      const parts = relPath.split(path.sep);

      // Preservar sub-pasta de disco (CD 1, Disc 2…)
      let destDir = albumDir;
      if (parts.length > 1 && isDiscFolder(parts[0])) {
        destDir = path.join(albumDir, sanitizeName(parts[0]));
      }

      const destFile = path.join(destDir, path.basename(audioFile));

      if (fs.existsSync(destFile)) {
        // Colisão: idêntico → skip (duplicata); diferente → renomear destino com sufixo
        if (this._filesIdentical(audioFile, destFile)) {
          if (this.verbose) console.log(`   ⏭️  ${path.basename(audioFile)}`);
          this.stats.skipped++;
          if (!this.dryRun) {
            try { fs.unlinkSync(audioFile); } catch { /* ignorar */ }
          }
          continue;
        }
        const ext = path.extname(path.basename(audioFile));
        const stem = path.basename(path.basename(audioFile), ext);
        let n = 2;
        let renamed = path.join(destDir, `${stem} (${n})${ext}`);
        while (fs.existsSync(renamed)) {
          n++;
          renamed = path.join(destDir, `${stem} (${n})${ext}`);
        }
        console.log(`   ⚠️  ${path.basename(audioFile)} existe com conteúdo diferente → ${path.basename(renamed)}`);
        if (this.dryRun) {
          console.log(`   → ${renamed}`);
          count++;
          this.stats.moved++;
          continue;
        }
        try {
          moveFile(audioFile, renamed);
          count++;
          this.stats.moved++;
        } catch (err) {
          console.error(`   ✗ ${path.basename(audioFile)}: ${err.message}`);
          this.stats.errors++;
        }
        continue;
      }

      if (this.dryRun) {
        console.log(`   → ${destFile}`);
        count++;
        this.stats.moved++;
        continue;
      }

      try {
        moveFile(audioFile, destFile);
        if (this.verbose) console.log(`   ✓ ${path.basename(audioFile)}`);
        count++;
        this.stats.moved++;
      } catch (err) {
        console.error(`   ✗ ${path.basename(audioFile)}: ${err.message}`);
        this.stats.errors++;
      }
    }

    if (!this.dryRun) {
      // Mover imagens de capa existentes na pasta de origem
      this._moveImages(releaseDir, albumDir, IMAGE_EXTENSIONS);

      // Se não havia imagem, extrair cover art embutida no áudio
      if (audioFiles.length > 0) {
        await saveCoverArt(albumDir, audioFiles[0]);
      }

      // Remover arquivos residuais (nfo, log, cue, txt…)
      this._removeLitterFiles(releaseDir);
      // Subpastas de disco também podem ter litter
      for (const sub of fs.readdirSync(releaseDir)) {
        const subp = path.join(releaseDir, sub);
        if (fs.statSync(subp).isDirectory()) this._removeLitterFiles(subp);
      }

      // Remover pasta de origem — APENAS se não sobrou nenhum áudio
      // (defensivo: uma falha de move nunca pode causar perda de faixa)
      if (this._hasAnyAudio(releaseDir)) {
        console.error(`   ⚠️  ${path.basename(releaseDir)}: ainda contém áudio — pasta de origem preservada`);
        this.stats.errors++;
      } else {
        fs.rmSync(releaseDir, { recursive: true, force: true });
      }
    }

    if (count > 0) {
      console.log(`   ✅ ${count} faixa(s) ${this.dryRun ? "a mover" : "movidas"}`);
    }

    return count;
  }

  /**
   * Move uma faixa avulsa solta na raiz da fonte para a biblioteca.
   * Tenta extrair "Artista - Título" do nome do arquivo; sem artista,
   * cai em music/Singles/.
   * @private
   */
  async _moveLooseTrack(filePath, logPrefix = "") {
    const base = path.basename(filePath, path.extname(filePath));
    // Padrão comum do streamrip: "Artist - Title"
    const m = base.match(/^(.+?)\s+-\s+(.+)$/);
    const artist = m ? m[1].trim() : null;
    const destDir = artist
      ? path.join(this.destDir, sanitizeName(artist), "Singles")
      : path.join(this.destDir, "Singles");

    console.log(`${logPrefix}🎶 Faixa avulsa: ${path.basename(filePath)}`);

    const moved = this._moveTrackWithCollisionCheck(filePath, destDir);
    if (moved) {
      this.stats.moved++;
      if (this.verbose) console.log(`   → ${path.join(destDir, path.basename(filePath))}`);
    } else {
      this.stats.skipped++;
    }
    // Limpar a fonte se ficou vazia
    if (!this.dryRun) {
      const sourceDir = path.dirname(filePath);
      try {
        if (fs.readdirSync(sourceDir).length === 0) fs.rmdirSync(sourceDir);
      } catch { /* ignorar */ }
    }
  }

  /**
   * Move um arquivo de áudio tratando colisão de basename no destino:
   *  - conteúdo idêntico (tamanho + hash) → skip (duplicata)
   *  - conteúdo diferente → destino renomeado com sufixo " (2)", " (3)"…
   * @private
   * @returns {boolean} true se movido, false se skipado como duplicata
   */
  _moveTrackWithCollisionCheck(srcFile, destDir) {
    const base = path.basename(srcFile);
    let destFile = path.join(destDir, base);

    if (fs.existsSync(destFile)) {
      if (this._filesIdentical(srcFile, destFile)) {
        if (this.verbose) console.log(`   ⏭️  ${base} (duplicata idêntica)`);
        // Não move, mas não deixa órfão: apagar origem é seguro (idêntico)
        if (!this.dryRun) {
          try { fs.unlinkSync(srcFile); } catch { /* ignorar */ }
        }
        return false;
      }
      // Conteúdo diferente: achar sufixo livre " (2)", " (3)"…
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      let n = 2;
      destFile = path.join(destDir, `${stem} (${n})${ext}`);
      while (fs.existsSync(destFile)) {
        n++;
        destFile = path.join(destDir, `${stem} (${n})${ext}`);
      }
      console.log(`   ⚠️  colisão de nome, conteúdo diferente → ${path.basename(destFile)}`);
    }

    if (this.dryRun) return true;

    moveFile(srcFile, destFile);
    return true;
  }

  /**
   * Compara dois arquivos: tamanho + hash SHA-1 (rápido para faixas de música).
   * @private
   */
  _filesIdentical(a, b) {
    try {
      const sa = fs.statSync(a);
      const sb = fs.statSync(b);
      if (sa.size !== sb.size) return false;
      const ha = crypto.createHash("sha1").update(fs.readFileSync(a)).digest("hex");
      const hb = crypto.createHash("sha1").update(fs.readFileSync(b)).digest("hex");
      return ha === hb;
    } catch {
      return false;
    }
  }

  /**
   * Trata pasta residual de release (áudio já movido, só reste cover/imagens).
   * Move o cover para o destino correto e apaga a pasta.
   * @private
   */
  _cleanResidualFolder(folderPath, folderName, logPrefix = "") {
    const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
    const files = fs.readdirSync(folderPath);
    // Considera apenas arquivos (não diretórios) para decidir se é pasta residual
    const nonDirFiles = files.filter(f => fs.statSync(path.join(folderPath, f)).isFile());
    const hasOnlyImages = nonDirFiles.length > 0 && nonDirFiles.every((f) => IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()));

    if (!hasOnlyImages) return; // Tem outros arquivos, não mexer

    const info = parseAlbumFolderName(folderName);
    const albumLabel = info.year ? `${info.album} (${info.year})` : info.album;
    const artistDir = path.join(this.destDir, sanitizeName(info.artist !== "Unknown Artist" ? info.artist : folderName));
    const albumDir = findExistingAlbumDir(info.artist, info.album, artistDir, this.processedAlbums) ||
                     path.join(artistDir, sanitizeName(albumLabel));

    if (fs.existsSync(albumDir)) {
      this._moveImages(folderPath, albumDir, IMAGE_EXTENSIONS);
      console.log(`${logPrefix}🧹 ${folderName}  (pasta residual limpa)`);
    }

    removeIfEmpty(folderPath);
  }

  /**
   * Move TODAS as imagens da pasta de origem (e subpastas de disco) para o destino.
   * Mantém os nomes originais. Não sobrescreve arquivos existentes.
   * @private
   */
  _moveImages(sourceDir, destDir, extensions) {
    this._moveImagesFromDir(sourceDir, destDir, extensions);
    // Também processar subpastas de disco (CD 1, Disc 2, etc.)
    if (fs.existsSync(sourceDir)) {
      for (const sub of fs.readdirSync(sourceDir)) {
        const subp = path.join(sourceDir, sub);
        try {
          if (fs.statSync(subp).isDirectory() && isDiscFolder(sub)) {
            this._moveImagesFromDir(subp, destDir, extensions);
          }
        } catch { /* ignorar */ }
      }
    }
  }

  /**
   * Move todas as imagens de um único diretório para o destino.
   * @private
   */
  _moveImagesFromDir(sourceDir, destDir, extensions) {
    if (!fs.existsSync(sourceDir)) return;
    const files = fs.readdirSync(sourceDir).filter((f) => extensions.includes(path.extname(f).toLowerCase()));
    if (files.length === 0) return;

    for (const f of files) {
      const src = path.join(sourceDir, f);
      const dest = path.join(destDir, f);
      if (fs.existsSync(dest)) {
        // Já existe no destino — apenas remove da origem
        try { fs.unlinkSync(src); } catch { /* ignorar */ }
        continue;
      }
      try {
        moveFile(src, dest);
        if (this.verbose) console.log(`   🖼️  ${f}`);
      } catch (err) {
        console.error(`   ✗ imagem ${f}: ${err.message}`);
      }
    }
  }

  /**
   * Remove arquivos residuais não-áudio/imagem (metadata, logs, cue sheets, etc.)
   * que ficam quando o torrent ou streamrip inclui arquivos extras.
   * @private
   */
  /**
   * Verifica se existe algum arquivo de áudio em qualquer nível da pasta.
   * @private
   */
  _hasAnyAudio(dir) {
    const AUDIO_EXT = new Set([".mp3", ".flac", ".opus", ".m4a", ".ogg", ".wav", ".aac", ".wma"]);
    if (!fs.existsSync(dir)) return false;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && this._hasAnyAudio(path.join(dir, entry.name))) return true;
      if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) return true;
    }
    return false;
  }

  _removeLitterFiles(dir) {
    const LITTER_EXT = new Set([".nfo", ".log", ".cue", ".m3u", ".m3u8", ".sfv",
                                  ".txt", ".pdf", ".accurip", ".md5"]);
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const ext = path.extname(f).toLowerCase();
      if (LITTER_EXT.has(ext)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignorar */ }
      }
    }
  }

  printStats() {
    console.log(`\n📊 Resumo:`);
    console.log(`   💿 Álbuns: ${this.stats.albums}`);
    console.log(`   ✅ Faixas movidas: ${this.stats.moved}`);
    console.log(`   ⏭️  Já existiam: ${this.stats.skipped}`);
    if (this.stats.errors > 0) {
      console.log(`   ❌ Erros: ${this.stats.errors}`);
    }
  }
}
