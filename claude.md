# plex_server — Instruções para Claude

## Visão Geral

Servidor Plex pessoal com Docker, agentes Node.js de automação de mídia e IA local via Ollama. O projeto é um **monorepo npm workspaces** onde a raiz controla todos os agentes e o `plex-cli.js` é o ponto único de entrada.

---

## Regra de Ouro

> **O código que existe hoje funciona. Não altere nada que não foi explicitamente pedido.** Tarefas novas consistem em adicionar funcionalidade sem quebrar o que já existe.

Sempre proponha um plano antes de implementar.

---

## Estrutura de Pastas

```
plex_server/
├── docker-compose.yml        # Plex (lscr.io/linuxserver/plex) + Ollama — network_mode: host, runtime: nvidia
├── .env                      # PLEX_CLAIM, PLEX_TOKEN, PUID, PGID, TZ, *_PATH (não commitar)
├── plex-cli.js               # CLI central — entry point de todos os comandos
├── plex-cli-menu.js          # Menu interativo numerado
├── plex-cli-run.js           # Execução de comandos individuais
├── plex-cli-stdin.js         # Passagem de stdin para subprocessos
├── package.json              # npm workspaces raiz + scripts atalho
├── jest.setup.js             # Setup global dos testes Jest
├── tsconfig.json             # Config TypeScript (projetos que usam TS)
├── ollama-setup.sh           # Gerenciamento de modelos Ollama (pull/list/rm)
├── ollama-install.sh         # Instalação do Ollama sem Docker
├── setup-nvidia-docker.sh    # Setup do NVIDIA Container Toolkit
├── upstart.sh                # Script de inicialização do servidor
├── mediasage/                # (em desenvolvimento) serviço de recomendação de mídia
├── config/                   # Dados persistentes do Plex (mapeado para /config no container)
├── tv/                       # Séries (mapeado para /tv no container)
├── movies/                   # Filmes (mapeado para /movies no container)
├── music/                    # Músicas (mapeado para /music no container)
├── tests/                    # Testes de integração da raiz
└── agents/
    ├── AllFather/             # Biblioteca de IA — wrapper para Ollama
    ├── MusicCurator/          # Agente de curadoria e normalização da biblioteca musical
    ├── SeriesCurator/         # Agente de curadoria e renomeação de séries de TV
    ├── Stormbringer/          # Agente de torrent — busca, download e organização no Plex
    ├── TideCaller/            # Download de alta qualidade via Tidal (streamrip, Dockerizado)
    └── Transporter/           # Utilitários compartilhados de filesystem, strings e áudio
    └── MusicSage/             # Webserver de recomendações musicais + construtor de playlists
```

---

## Agentes

### AllFather (`@plex-agents/allfather`)
Biblioteca compartilhada de IA. Encapsula comunicação com o Ollama.
- Métodos: `ask()`, `askWithContext()`, `askForJSON()`
- Suporta: temperatura, reasoning on/off (flag `disableReasoning`), retorno JSON estruturado
- Ollama padrão: `deepseek-r1:1.5b` (1 GB, reasoning)

### MusicCurator (`@plex-agents/musiccurator`)
Organiza e normaliza a biblioteca de músicas em `music/`.
- Normaliza nomes de pasta → `Artista — Álbum (Ano)`
- Corrige tags `ALBUM` nos arquivos via `ffmpeg` quando divergem da pasta
- Consolida faixas duplicadas e remove pastas vazias
- Todos os comandos têm modo `--dry-run`

### MusicSage (`@plex-agents/musicsage`)
Webserver Express.js de recomendações musicais com **frontend SPA** integrado. Roda na porta `3002`.

**O que faz:**
- Escaneia a biblioteca Plex via API → artistas, álbuns, faixas
- Analisa perfil musical com AllFather (Ollama) → gênero, mood, energia, timbre
- Lê histórico de plays do Plex (viewCount) para entender gostos do usuário
- **Recomenda artistas** fora da biblioteca que combinam com o perfil analisado
- Busca **artistas semelhantes** via Last.fm + re-rank por Ollama
- **Constrói playlists** da biblioteca por critérios (mood, gênero, energia) ou via **prompt em linguagem natural**
- **Sincroniza playlists bidireccionalmente com o Plex** (rename, update faixas, delete)
- **Frontend SPA dark-theme** acessível em `http://localhost:3002`

**Seções do frontend (redesenhadas — design system Spotify/Vercel):**
| Seção | Função |
|---|---|
| Dashboard | Hero stats grid (artistas/álbuns/faixas/playlists), curiosidades cards, retrospectiva com thumbnails + play counts + horas, seletor de usuário Plex, mood do dia/mês |
| Recomendações | Cards com `whyRecommended` como descrição, gênero como badge, busca de artistas similares (Last.fm + Ollama), botões ∿ TideCaller / ↯ Stormbringer |
| Playlists | Layout 2 painéis (lista / detalhe), faixas editáveis, sync com Plex |
| Nova Playlist | 2 tabs: "✨ Por Prompt" e "🎵 Por Música" (Radio) usando analysis-cache |
| Clusters | Toggle 2D/3D, visualização vetorial da biblioteca |
| Análise de Áudio | Progress bar, badges inline, análise em batch |
| Downloads | Tab pill switcher, Stormbringer + TideCaller + Transporter |
| Logs | Viewer de logs em tempo real com filtros por nível (INFO/WARN/ERROR/DEBUG/HTTP), auto-refresh, ação de zerar log do dia ou todos |

**Design System aplicado:**
- Paleta: `bg:#0a0a0f`, `surface:#111118`, `accent:#7c6af5`, `positive:#1db954`
- Componentes: `.text-gradient`, `.glass`, `.card`, `.nav-active`, `.rank-chip` (.top1/.top2/.top3), `.list-row`, `.stat-value`, `.progress-bar`
- Layout: `w-full` em todas as páginas (sem `max-w-screen-xl`), sidebar fixa com `var(--sidebar-w)`
- Tipografia: `text-2xs` customizado, `stat-value`, `text-gradient` via CSS classes

**Retrospectiva (Dashboard):**
- Resumo acima da tabela: Reproduções / Horas ouvidas / Faixas únicas / Artistas únicos
- Thumbnails de artistas e álbuns via `/api/library/thumb?path=`
- Campo correto: `playCount` (não `plays`/`count`)
- Gêneros: play count + contagem de faixas

**Usuário Plex:**
- Seletor no header do Dashboard: filtra métricas por conta do Plex
- `GET /api/library/users` → lista de contas via `PlexService.getUsers()`
- `GET /api/library/metrics?period=&userId=` → aceita filtro por `accountID`

**Caminho dos logs:** `mediasage/logs/musicsage-YYYY-MM-DD.log` — um arquivo por dia. Controle via tela Logs ou `DELETE /api/logs`.

**Como iniciar:**
```bash
# Via CLI central
node plex-cli.js musicsage:start

# Ou direto
cd agents/MusicSage && node index.js

# Build Docker
./build-docker.sh              # tag musicsage:latest
./build-docker.sh --tag v1.0   # tag customizada
./build-docker.sh --no-cache   # sem cache

# Abrir Interface Web
xdg-open http://localhost:3002
```

**Variáveis de ambiente necessárias (veja `agents/MusicSage/.env.example`):**
```env
PLEX_URL=http://localhost:32400       # URL do servidor Plex
PLEX_TOKEN=<token-do-plex>            # Token API do Plex
OLLAMA_URL=http://localhost:11434     # LLM local
OLLAMA_DEFAULT_MODEL=gemma4:e4b       # Modelo de geração
EMBEDDING_MODEL=nomic-embed-text      # Modelo de embeddings (Ollama)
PLEX_MEDIA_ROOT=/path/to/music        # Caminho host para os arquivos de música
PLEX_PATH_PREFIX=/music               # Prefixo de path do Plex (mapeado para PLEX_MEDIA_ROOT)
MUSICSAGE_PORT=3002                   # Porta HTTP (padrão 3002)
LASTFM_API_KEY=<chave>                # Opcional — artistas semelhantes via Last.fm
MUSICSAGE_DEBUG=1                     # Opcional — logs verbosos
```

**API REST** (para uso programático):
```
GET  /api/health                                   → status do servidor
GET  /api/library/stats                            → totais + top géneros + totalPlaylists
GET  /api/library/users                            → lista de contas/usuários Plex
GET  /api/library/history                          → top artistas e faixas (Plex viewCount)
GET  /api/library/metrics?period=&userId=          → retrospectiva com thumbnails e playCounts
GET  /api/library/thumb?path=                      → proxy de artwork do Plex
GET  /api/library/curiosidades                     → fatos curiosos da biblioteca (analysis-cache)
GET  /api/library/mood?period=day|month            → mood calculado via analysis
GET  /api/library/recently-played?limit=N          → histórico recente com ratingKey
GET  /api/recommendations?limit=N&genre=X          → artistas recomendados (com whyRecommended)
GET  /api/recommendations/similar?artist=X&limit=N → artistas semelhantes (Last.fm + Ollama)
POST /api/playlists/generate                       → { name?, mood?, genre?, energy?, size? }
POST /api/playlists/from-prompt                    → { prompt: "texto livre" }
POST /api/playlists/from-cache-prompt              → { prompt } — monta playlist com perfis do analysis-cache
POST /api/playlists/from-cache-track               → { ratingKey, size?, name? } — Radio [Título]
GET  /api/playlists                                → lista playlists salvas
PATCH /api/playlists/:id                           → { name?, tracks? } — edita e sincroniza Plex
DELETE /api/playlists/:id                          → remove (e do Plex se sincronizado)
GET  /api/logs                                     → resumo de logs + últimas 200 linhas
GET  /api/logs/today                               → conteúdo completo do log de hoje
GET  /api/logs/files                               → lista de arquivos de log
DELETE /api/logs                                   → zera o log de hoje
DELETE /api/logs/all                               → remove todos os arquivos de log
DELETE /api/audio/analysis-cache                   → limpa o cache de análises (409 se batch rodando)
```

**Sincronização Plex:** PATCH rename → `PUT /playlists/:plexId?title=...`; PATCH tracks → delete+push; DELETE → limpa do Plex; push-to-plex → overwrite idempotente. Auto-healing: se `plexId` estiver obsoleto, recria automaticamente.

**Persistência:** playlists (incluindo `plexId`) salvas em `mediasage/playlists/playlists.json`

**Arquitetura:** 8 serviços por DI — `LibraryScanner`, `HistoryService`, `MusicAnalyzer`, `AnalysisCacheService`, `RecommendationEngine`, `PlaylistBuilder`, `PlexService`, `LastFmService`. **82 testes** (unit + integração).

**Analysis cache** (`mediasage/analysis-cache.json`): armazena perfil completo de cada faixa analisada. Cada entrada inclui: `genre`, `subgenre`, `mood`, `energy`, `valence`, `danceability`, `acousticness`, `complexity`, `bpm`, `key`, `tempo`, `rhythmPattern`, `timbre`, `dynamics`, `texture`, `vocalStyle`, `productionStyle`, `era`, `characteristics[]`, `instruments[]`, `emotionalTags[]`. O `PlaylistBuilder` envia esses perfis em lotes de 50 para o LLM (torneio de seleção) com pré-filtro de similaridade (70% gênero/mood/energia + 30% aleatório).

### SeriesCurator (`@plex-agents/seriescurator`)
Organiza e renomeia séries de TV em `tv/`.
- Renomeia pastas e arquivos → `Nome da Série (Ano)/Season XX/S01E01 - Título.ext`
- Agrupa variantes do mesmo nome (`Game.of.Thrones` / `Game_of_Thrones`)
- Corrige tags de vídeo (`title`, `season_number`, `episode_sort`) via `ffmpeg`
- Requer `sudo` (diretório `tv/` criado como root pelo Docker)
- Usa AllFather para identificar nomes canônicos em casos ambíguos

### Stormbringer (`@plex-agents/stormbringer`)
Agente de torrent — busca, baixa e organiza mídia nas pastas do Plex.
- Monitora qBittorrent via daemon
- Organiza downloads em `movies/`, `tv/` e `music/` no formato correto para o Plex
- Fuzzy dedup de álbuns (similaridade ≥ 0.85 + detecção de gravações ao vivo)
- Extrai cover art a partir dos metadados de áudio (`music-metadata`)

### TideCaller
Download de alta qualidade via **Tidal** usando [streamrip](https://github.com/nathom/streamrip).
- Baixa em até 24-bit/192kHz (MQA/FLAC)
- Dockerizado (Python + streamrip em container isolado)
- Token auto-refresh para manter credenciais Tidal válidas
- **Uso direto**: `cd agents/TideCaller && bash scripts/rip.sh url https://tidal.com/browse/album/...`
- OS outros comandos passam pelo `plex-cli`

### Transporter (`@plex-agents/transporter`)
Biblioteca de utilitários compartilhados. Não tem comandos CLI próprios.

| Módulo       | Funções principais                                                          |
|--------------|-----------------------------------------------------------------------------|
| `strings`    | `sanitizeName`, `cleanAlbumName`, `normalizeForComparison`, `calculateSimilarity` |
| `live`       | `isLiveRecording`                                                           |
| `audio`      | `AUDIO_EXTENSIONS`, `isAudioFile`, `isDiscFolder`, `isReleaseFolder`, `findAudioFiles`, `parseAlbumFolderName` |
| `filesystem` | `ensureDir`, `moveFile`, `removeIfEmpty`, `saveCoverArt`                   |
| `dedup`      | `findExistingAlbumDir`                                                      |

---

## Como rodar

```bash
# Setup único
npm install                   # instala todos os workspaces de uma vez

# Entry point principal
node plex-cli.js              # menu interativo
node plex-cli.js --help       # lista todos os comandos
node plex-cli.js <comando>    # executa diretamente

# Atalhos npm equivalentes
npm run cli
npm run <comando>
```

---

## Comandos por categoria

### Música
| Comando | Descrição |
|---|---|
| `music:consolidate` | Consolida biblioteca (normaliza pastas + corrige tags) |
| `music:fix-all-tags` / `:dry` | Corrige tags ALBUM em toda a biblioteca |
| `music:fix-tags` / `:dry` | Corrige tags apenas nos álbuns já marcados `[CURATED]` |
| `music:test` | Suite de testes do MusicCurator |

### MusicSage
| Comando | Descrição |
|---|---|
| `musicsage:start` | Inicia o servidor MusicSage (porta 3002) |
| `musicsage:test` | Suite de testes do MusicSage (82 testes) |

### Séries
| Comando | Descrição |
|---|---|
| `series:curate` / `:dry` | Cura biblioteca de séries (requer sudo) |
| `series:fix-tags` / `:dry` | Corrige tags de vídeo |
| `series:test` | Suite de testes do SeriesCurator |

### Stormbringer (torrents)
| Comando | Descrição |
|---|---|
| `stormbringer:start` | Inicia daemon de downloads |
| `stormbringer:search` | Busca torrent interativamente |
| `stormbringer:downloads` | Lista status dos downloads |
| `stormbringer:plex-organize` / `:dry` | Move downloads para as pastas do Plex |
| `stormbringer:test` | Suite de testes do Stormbringer |

### TideCaller (Tidal)
| Comando | Descrição |
|---|---|
| `tidecaller:rip` | Baixa uma URL do Tidal |
| `tidecaller:download-artists` | Baixa artistas listados em `artist_urls.txt` |
| `tidecaller:organize` | Organiza downloads na biblioteca |
| `tidecaller:enrich` | Enriquece metadados via MusicBrainz |
| `tidecaller:refresh-token` | Re-autentica no Tidal (device auth interativo) |
| `tidecaller:download-artist` | Busca artista e baixa discografia/álbuns escolhidos |

### Docker / Plex
| Comando | Descrição |
|---|---|
| `plex:status` | `docker compose ps` |
| `plex:start` | Sobe todos os containers |
| `plex:stop` | Para todos os containers |
| `plex:restart` | Reinicia container do Plex |
| `plex:logs` | Logs do Plex (últimas 50 linhas, follow) |
| `plex:scan` | Força rescan das bibliotecas via API do Plex |

### Testes
| Comando | Descrição |
|---|---|
| `test:all` | Todos os testes (MusicCurator + SeriesCurator + Stormbringer) |
| `test:music` | Apenas MusicCurator |
| `test:series` | Apenas SeriesCurator |
| `test:stormbringer` | Apenas Stormbringer |

---

## Infraestrutura Docker

- **Plex**: `lscr.io/linuxserver/plex:latest` — `network_mode: host`, `runtime: nvidia`
- **Ollama**: container separado para LLMs locais, exposto em `localhost:11434`
- **TideCaller**: container Python/streamrip isolado (sem poluir sistema host)
- Volumes persistentes: `./config:/config`, `./tv:/tv`, `./movies:/movies`, `./music:/music`

```bash
docker compose up -d          # sobe Plex + Ollama
docker compose up -d ollama   # sobe só o Ollama
curl http://localhost:11434   # verifica se Ollama está rodando
```

---

## Ollama — Modelos usados pelos agentes

| Modelo | Tamanho | Uso |
|---|---|---|
| `deepseek-r1:1.5b` | ~1 GB | **Padrão dos agentes** (reasoning) |
| `llama3.2:1b` | ~1 GB | Testes e tarefas simples |
| `llama3.2:3b` | ~3 GB | Uso geral |
| `deepseek-r1:7b` | ~4 GB | Alta qualidade (requer mais RAM/GPU) |

```bash
./ollama-setup.sh pull deepseek-r1:1.5b   # baixa o modelo padrão
./ollama-setup.sh list                     # lista modelos instalados
```

---

## Variáveis de Ambiente (`.env`)

```dotenv
PLEX_CLAIM=claim-xxxxxxxxxx   # https://www.plex.tv/claim/ (válido 4 min, só 1ª execução)
PLEX_TOKEN=xxxxxxxxxxxx        # Token para API do Plex (usado pelo plex:scan)
PUID=1000
PGID=1000
TZ=America/Sao_Paulo
MUSIC_PATH=/caminho/absoluto/para/music
SERIES_PATH=/caminho/absoluto/para/tv
MOVIES_PATH=/caminho/absoluto/para/movies
```

---

## Convenções de Código

- **Módulos ES**: `"type": "module"` na raiz, todos os arquivos usam `import/export`
- **Node.js 18+** para os agentes JS, exceto TideCaller (Python via Docker)
- **Jest** para testes — `jest.config.js` em cada agente + `jest.setup.js` na raiz
- **TypeScript** disponível via `tsconfig.json` (mas maioria dos arquivos é `.js`)
- Logs com emoji: `🔄 processando`, `✅ sucesso`, `❌ erro` — padrão já estabelecido nos agentes
