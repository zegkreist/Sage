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
Webserver Express.js de recomendações musicais com **frontend SPA** integrado. Roda na porta `3001`.

**O que faz:**
- Escaneia a biblioteca Plex via API → artistas, álbuns, faixas
- Analisa perfil musical com AllFather (Ollama) → gênero, mood, energia, timbre
- Lê histórico de plays do Plex para entender gostos do usuário
- **Recomenda artistas** fora da biblioteca que combinam com o perfil analisado
- **Constrói playlists** da biblioteca por critérios (mood, gênero, energia) ou via **prompt em linguagem natural**
- **Frontend SPA dark-theme** acessível em `http://localhost:3001`

**Seções do frontend:**
| Seção | Função |
|---|---|
| Dashboard | Cards com totais da biblioteca (artistas/álbuns/faixas), top gêneros e status do servidor |
| Recomendações | Grid de artistas recomendados com filtro por gênero + botão Atualizar |
| Playlists | Lista de playlists salvas — expande para ver faixas, renomear inline, remover faixas, excluir |
| Nova Playlist | Duas tabs: "Por Critérios" (mood + gênero + energia + tamanho) e "Por Prompt" (texto livre interpretado pelo Ollama) |

**Como iniciar:**
```bash
# Via CLI central
node plex-cli.js musicsage:start

# Ou direto
cd agents/MusicSage && node index.js

# Abrir Interface Web
xdg-open http://localhost:3001
```

**Variáveis de ambiente necessárias:**
```env
PLEX_URL=http://localhost:32400
PLEX_TOKEN=<token-do-plex>
OLLAMA_URL=http://localhost:11434
OLLAMA_DEFAULT_MODEL=deepseek-r1:14b-qwen-distill-q4_K_M
MUSICSAGE_PORT=3001             # opcional, padrão 3001
```

**API REST** (para uso programático):
```
GET  /api/health                         → status do servidor
GET  /api/library/stats                  → totais + top géneros
GET  /api/recommendations?limit=N        → artistas recomendados
POST /api/playlists/generate             → { name?, mood?, genre?, energy?, size? }
POST /api/playlists/from-prompt          → { prompt: "texto livre" }
GET  /api/playlists                      → lista playlists salvas
GET  /api/playlists/:id                  → playlist por id
PATCH /api/playlists/:id                 → { name?, tracks? } — editar
DELETE /api/playlists/:id                → remove
```

**Persistência:** playlists salvas em `mediasage/playlists/playlists.json`

**Arquitetura:** 5 serviços por DI — `LibraryScanner`, `HistoryService`, `MusicAnalyzer`, `RecommendationEngine`, `PlaylistBuilder`. 68 testes (unit + integração).

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
| `musicsage:start` | Inicia o servidor MusicSage (porta 3001) |
| `musicsage:test` | Suite de testes do MusicSage (68 testes) |

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
