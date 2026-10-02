#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sage Log Analyzer — toolkit de análise de logs do MusicSage.

Uso:
  ./analyze.py                    # resumo agregado de todos os dias encontrados
  ./analyze.py --day 2026-10-02   # resumo de um dia específico
  ./analyze.py --tail             # mostra só novidades desde a última execução
  ./analyze.py --top 10           # número de itens nos rankings (padrão 5)
  ./analyze.py --exceptions 10    # quantas exceptions recentes mostrar (padrão 5)
  ./analyze.py --json             # saída em JSON

Formato de linha esperado:
  2026-10-02 00:00:51.214 [INFO ] [HTTP     ] GET    /api/tools/queue → 200 (1ms)
  2026-10-01 01:55:28.186 [ERROR] [SERVER   ] Stormbringer media DL error: ...
"""
import argparse
import collections
import datetime
import json
import os
import re
import sys

LOG_DIR = "/sage/data/logs"
LOG_GLOB = "musicsage-*.log"
CURSOR_PATH = "/opt/data/sage-toolkit/.log-cursor"

LINE_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+"
    r"\[(?P<level>[A-Z]+)\s*\]\s+"
    r"\[(?P<module>[A-Z0-9_-]+)\s*\]\s+"
    r"(?P<msg>.*)$"
)
HTTP_RE = re.compile(
    r"^(?P<method>GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+"
    r"(?P<path>\S+)\s+→\s+(?P<status>\d{3})\s+\((?P<ms>[\d.]+)m?s?\)"
)

# Fragments de mensagem a normalizar (números, hashes, paths etc.)
NORM_RULES = [
    (re.compile(r"\b[0-9a-f]{40}\b"), "<hash40>"),      # infoHash torrent
    (re.compile(r"\b[0-9a-f]{8,}\b"), "<hash>"),
    (re.compile(r"\d+"), "<N>"),
    (re.compile(r"<N>\.ms"), "<N>ms"),
    (re.compile(r"\s+"), " "),
]


def parse_log_dir():
    """Retorna lista ordenada de arquivos de log disponíveis."""
    if not os.path.isdir(LOG_DIR):
        return []
    files = sorted(f for f in os.listdir(LOG_DIR) if re.match(r"musicsage-\d{4}-\d{2}-\d{2}\.log$", f))
    return [os.path.join(LOG_DIR, f) for f in files]


def parse_lines(path, start_offset=0):
    """Itera sobre linhas do arquivo a partir de start_offset (bytes).
    Yields (offset_antes_da_linha, dict)."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        if start_offset:
            fh.seek(start_offset)
        offset = start_offset
        for raw in fh:
            line_start = offset
            offset += len(raw.encode("utf-8", errors="replace"))
            line = raw.rstrip("\n")
            m = LINE_RE.match(line)
            if not m:
                continue
            d = m.groupdict()
            d["msg"] = d["msg"].strip()
            d["level"] = d["level"].strip()
            d["module"] = d["module"].strip()
            d["offset"] = line_start
            hm = HTTP_RE.match(d["msg"])
            if hm:
                d["http"] = hm.groupdict()
            yield d


def normalize(msg):
    s = msg
    for rx, repl in NORM_RULES:
        s = rx.sub(repl, s)
    return s.strip()


def extract_exception(entry, tail_lines, all_lines_iter):
    """Tenta montar um bloco de exception: mensagem ERROR + linhas seguintes
    que parecem stack trace (at ..., Caused by, ...Exception)."""
    block = [entry["msg"]]
    count = 0
    for nxt in all_lines_iter:
        if count >= 12:
            break
        if LINE_RE.match(nxt):
            break
        if nxt.strip():
            block.append(nxt.rstrip())
        count += 1
    return "\n    ".join(block)


def analyze(files, top_n=5, exceptions_n=5, last24h=True):
    now = datetime.datetime.now()
    cutoff = now - datetime.timedelta(hours=24) if last24h else None

    levels = collections.Counter()
    modules_errors = collections.Counter()
    error_patterns = collections.Counter()          # normalized -> (count, sample_raw, module)
    error_samples = {}
    error_modules = collections.defaultdict(collections.Counter)
    recent_exceptions = []                          # (ts, module, block)
    unique_errors_24h = collections.OrderedDict()   # normalized -> {ts, module, raw}
    http_status = collections.Counter()
    http_404_paths = collections.Counter()
    slow_requests = []                              # (ms, line)

    for path in files:
        pending = []
        pending_iter = iter([])
        lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
        for i, raw in enumerate(lines):
            m = LINE_RE.match(raw)
            if not m:
                continue
            d = m.groupdict()
            d["msg"] = d["msg"].strip()
            d["level"] = d["level"].strip()
            d["module"] = d["module"].strip()
            levels[d["level"]] += 1
            ts = datetime.datetime.strptime(d["ts"], "%Y-%m-%d %H:%M:%S.%f")

            hm = HTTP_RE.match(d["msg"])
            if hm:
                status = hm.group("status")
                http_status[status] += 1
                if status.startswith("4") or status.startswith("5"):
                    http_404_paths["%s %s → %s" % (hm.group("method"), hm.group("path"), status)] += 1
                ms = hm.group("ms")
                try:
                    msf = float(ms)
                    if msf >= 5000:
                        slow_requests.append((msf, d["ts"], d["msg"]))
                except ValueError:
                    pass
                continue

            if d["level"] in ("ERROR", "WARN"):
                norm = normalize(d["msg"])
                error_patterns[norm] += 1
                error_samples.setdefault(norm, d["msg"])
                error_modules[norm][d["module"]] += 1
                modules_errors[d["module"]] += 1
                if cutoff is None or ts >= cutoff:
                    unique_errors_24h.setdefault(norm, {"ts": d["ts"], "module": d["module"], "raw": d["msg"]})
                # coleta stack lines seguintes
                block = [d["msg"]]
                for nxt in lines[i + 1 : i + 13]:
                    if LINE_RE.match(nxt):
                        break
                    if nxt.strip():
                        block.append(nxt)
                if len(block) > 1 or "Exception" in d["msg"] or "error" in d["msg"].lower():
                    recent_exceptions.append({"ts": d["ts"], "module": d["module"], "level": d["level"], "block": block})

    recent_exceptions.sort(key=lambda x: x["ts"], reverse=True)

    def format_summary():
        out = []
        out.append("=" * 68)
        out.append("SAGE LOG ANALYZER — resumo de %s" % (", ".join(os.path.basename(f) for f in files)))
        out.append("=" * 68)
        out.append("")
        out.append("## Contagem por nível")
        for lvl in ("INFO", "HTTP", "WARN", "ERROR", "DEBUG"):
            if levels.get(lvl):
                out.append("  %-6s %d" % (lvl, levels[lvl]))
        out.append("")
        out.append("## Top módulos com ERROR/WARN")
        if modules_errors:
            for mod, c in modules_errors.most_common(top_n):
                out.append("  %-14s %d" % (mod, c))
        else:
            out.append("  (nenhum)")
        out.append("")
        out.append("## Padrões recorrentes de erro (mensagens normalizadas)")
        if error_patterns:
            for norm, c in error_patterns.most_common(top_n):
                mods = ", ".join("%s×%d" % (m, n) for m, n in error_modules[norm].most_common())
                out.append("  [%d×] (%s)" % (c, mods))
                out.append("        amostra: %s" % error_samples[norm][:110])
                out.append("        padrão : %s" % norm[:110])
        else:
            out.append("  (nenhum)")
        out.append("")
        out.append("## Últimas %d exceptions/erros (com stack, se houver)" % exceptions_n)
        if recent_exceptions:
            for e in recent_exceptions[:exceptions_n]:
                out.append("  %s [%s] [%s]" % (e["ts"], e["module"], e["level"]))
                for bl in e["block"]:
                    out.append("      %s" % bl[:120])
                out.append("")
        else:
            out.append("  (nenhuma)")
        out.append("")
        out.append("## Erros únicos das últimas 24h")
        if unique_errors_24h:
            for norm, info in unique_errors_24h.items():
                out.append("  %s [%s] %s" % (info["ts"], info["module"], info["raw"][:110]))
        else:
            out.append("  (nenhum)")
        out.append("")
        out.append("## HTTP — status codes")
        for st, c in sorted(http_status.items()):
            out.append("  %s: %d" % (st, c))
        if http_404_paths:
            out.append("  Rotas com 4xx/5xx mais frequentes:")
            for p, c in http_404_paths.most_common(top_n):
                out.append("    [%d×] %s" % (c, p))
        if slow_requests:
            slow_requests.sort(reverse=True)
            out.append("  Requisições lentas (≥5s):")
            for ms, ts, msg in slow_requests[:top_n]:
                out.append("    %s %sms  %s" % (ts, ms, msg[:90]))
        out.append("")
        return "\n".join(out)

    def as_json():
        return {
            "files": files,
            "levels": dict(levels),
            "top_modules_with_errors": modules_errors.most_common(top_n),
            "error_patterns": [
                {"count": c, "normalized": n, "sample": error_samples[n],
                 "modules": dict(error_modules[n])}
                for n, c in error_patterns.most_common(top_n)
            ],
            "recent_exceptions": recent_exceptions[:exceptions_n],
            "unique_errors_24h": list(unique_errors_24h.values()),
            "http_status": dict(http_status),
            "http_4xx5xx_paths": http_404_paths.most_common(top_n),
        }

    return (as_json if False else format_summary), as_json


def read_cursor():
    try:
        with open(CURSOR_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_cursor(data):
    os.makedirs(os.path.dirname(CURSOR_PATH), exist_ok=True)
    tmp = CURSOR_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, CURSOR_PATH)


def tail_mode(top_n=5):
    """Mostra apenas linhas novas (ERROR/WARN/exception/HTTP lento) desde a
    última execução. Cursor: {file: byte_offset}."""
    cursor = read_cursor()
    files = parse_log_dir()
    new_errors = []
    cur = dict(cursor)
    for path in files:
        off = int(cursor.get(path, 0))
        size = os.path.getsize(path)
        if size < off:            # arquivo truncado/recriado
            off = 0
        if size == off:
            continue
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            fh.seek(off)
            new_text = fh.read()
        cur[path] = off + len(new_text.encode("utf-8", errors="replace"))
        for raw in new_text.splitlines():
            m = LINE_RE.match(raw)
            if not m:
                continue
            d = m.groupdict()
            d["level"] = d["level"].strip()
            d["module"] = d["module"].strip()
            d["msg"] = d["msg"].strip()
            hm = HTTP_RE.match(d["msg"])
            if hm and hm.group("status").startswith(("4", "5")):
                new_errors.append("%s [%s] %s %s → %s" % (d["ts"], hm.group("status"), hm.group("method"), hm.group("path"), hm.group("status")))
            elif d["level"] in ("ERROR", "WARN"):
                new_errors.append("%s [%s] [%s] %s" % (d["ts"], d["level"], d["module"], d["msg"]))
    write_cursor(cur)
    if new_errors:
        print("NOVIDADES desde a última execução (%d):" % len(new_errors))
        for e in new_errors[-50:]:
            print("  " + e)
    else:
        print("Nenhuma novidade (ERROR/WARN/HTTP 4xx/5xx) desde a última execução.")


def main():
    ap = argparse.ArgumentParser(description="Analisador de logs do Sage (MusicSage)")
    ap.add_argument("--day", help="analisar apenas um dia (YYYY-MM-DD)")
    ap.add_argument("--tail", action="store_true", help="mostrar só novidades desde a última execução")
    ap.add_argument("--top", type=int, default=5, help="tamanho dos rankings (padrão 5)")
    ap.add_argument("--exceptions", type=int, default=5, help="nº de exceptions recentes (padrão 5)")
    ap.add_argument("--json", action="store_true", help="saída em JSON")
    ap.add_argument("--all-hours", action="store_true", help="não restringir 'erros únicos' a 24h")
    args = ap.parse_args()

    if args.tail:
        tail_mode(args.top)
        return

    files = parse_log_dir()
    if args.day:
        files = [f for f in files if args.day in f]
        if not files:
            sys.exit("Nenhum log encontrado para o dia %s" % args.day)
    if not files:
        sys.exit("Nenhum log encontrado em %s" % LOG_DIR)

    fmt, as_json = analyze(files, top_n=args.top, exceptions_n=args.exceptions,
                           last24h=not args.all_hours)
    if args.json:
        print(json.dumps(as_json(), indent=2, ensure_ascii=False))
    else:
        print(fmt())


if __name__ == "__main__":
    main()
