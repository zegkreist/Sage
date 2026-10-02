# Sage Log Analysis

Toolkit de análise dos logs do MusicSage (`/sage/data/logs/musicsage-YYYY-MM-DD.log`). Python 3 stdlib, sem dependências.

## Uso

```bash
# Resumo completo (todos os dias disponíveis)
./analyze.py

# Resumo de um dia específico
./analyze.py --day 2026-10-02

# Só as novidades desde a última execução (modo monitor)
./analyze.py --tail

# Ajustar rankings / saída JSON
./analyze.py --top 10 --exceptions 10
./analyze.py --json
```

## O que o resumo mostra

- **Contagem por nível** (INFO/HTTP/WARN/ERROR/DEBUG)
- **Top módulos com erro** (ERROR/WARN por módulo: SERVER, STORMBRINGER, …)
- **Padrões recorrentes de erro** — mensagens agrupadas após normalização (números/hashes viram `<N>`/`<hash>`)
- **Últimas N exceptions** com stack trace (linhas seguintes não-formatadas)
- **Erros únicos das últimas 24h**
- Bônus: status codes HTTP, rotas 4xx/5xx mais frequentes, requisições lentas (≥5s)

## Modo --tail

Compara o tamanho (offset em bytes) de cada arquivo com o cursor salvo em `/opt/data/sage-toolkit/.log-cursor` e imprime apenas linhas novas de nível ERROR/WARN ou HTTP 4xx/5xx desde a última execução. Arquivo truncado/recriado (menor que o cursor) é relido do zero. Ideal para cron:

```
*/5 * * * * /opt/data/dev/Sage/tools/log-analysis/analyze.py --tail
```

## Formato de log suportado

```
2026-10-02 00:00:51.214 [INFO ] [HTTP     ] GET    /api/tools/queue → 200 (1ms)
2026-10-01 01:55:28.186 [ERROR] [SERVER   ] Stormbringer media DL error: ...
```
