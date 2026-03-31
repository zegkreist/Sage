/**
 * kill-port.js <port>
 *
 * Encerra o processo que está escutando na porta especificada.
 * Funciona via /proc (Linux), sem precisar de lsof ou fuser.
 *
 * Uso: node scripts/kill-port.js 3001
 */

import fs from "fs";

const port = parseInt(process.argv[2], 10);
if (!port) {
  console.error("Uso: node scripts/kill-port.js <porta>");
  process.exit(1);
}

const hexPort = port.toString(16).toUpperCase().padStart(4, "0");

// Lê /proc/net/tcp e /proc/net/tcp6
function findInode(hexPort) {
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      const lines = fs.readFileSync(file, "utf8").split("\n").slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (!parts[1]) continue;
        const localPort = parts[1].split(":")[1];
        if (localPort === hexPort) return parts[9]; // inode
      }
    } catch {}
  }
  return null;
}

const inode = findInode(hexPort);
if (!inode) {
  console.log(`✅ Nenhum processo escutando na porta ${port}.`);
  process.exit(0);
}

// Busca o PID que tem esse socket aberto
function findPid(inode) {
  const token = `socket:[${inode}]`;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const fdDir = `/proc/${entry}/fd`;
    try {
      for (const fd of fs.readdirSync(fdDir)) {
        try {
          if (fs.readlinkSync(`${fdDir}/${fd}`) === token) return parseInt(entry);
        } catch {}
      }
    } catch {}
  }
  return null;
}

const pid = findPid(inode);
if (!pid) {
  console.log(`⚠️  Inode ${inode} encontrado mas sem PID acessível (pode ser namespace diferente).`);
  console.log(`   Tente: kill $(cat /proc/net/tcp | awk '/${hexPort}/ {print $10}')`);
  process.exit(1);
}

try {
  process.kill(pid, "SIGTERM");
  console.log(`✅ Processo PID ${pid} encerrado (porta ${port} liberada).`);
} catch (err) {
  console.error(`❌ Não foi possível encerrar PID ${pid}: ${err.message}`);
  process.exit(1);
}
