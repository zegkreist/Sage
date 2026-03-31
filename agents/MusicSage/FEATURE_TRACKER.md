# MusicSage — Feature Tracker

> Arquivo de rastreamento vivo. Atualizado a cada etapa da implementação.
> Use este arquivo para retomar contexto se perdido.

---

## Visão Geral

Agente `MusicSage` — webserver Express.js dentro do monorepo `plex_server`.

**Dois módulos principais:**
1. **Recommender** — analisa biblioteca + histórico → sugere artistas/músicas que *não* estão na biblioteca, usando Ollama (AllFather) para análise de gênero, mood, energia e timbre.
2. **Playlist Builder** — constrói playlists inteligentes a partir da biblioteca existente com critérios de mood/gênero/energia.

---

## Arquitetura

```
agents/MusicSage/
├── FEATURE_TRACKER.md      ← este arquivo
├── package.json
├── jest.config.js
├── index.js                ← entry point (HTTP server + porta)
├── src/
│   ├── server.js           ← Express app factory (injetável para testes)
│   ├── services/
│   │   ├── LibraryScanner.js       ← Plex API → artistas, álbuns, faixas
│   │   ├── HistoryService.js       ← Plex playback history
│   │   ├── MusicAnalyzer.js        ← AllFather: análise musical (gênero, mood...)
│   │   ├── RecommendationEngine.js ← combina biblioteca + histórico → recomendações
│   │   └── PlaylistBuilder.js      ← gera e persiste playlists
│   └── routes/
│       ├── health.js
│       ├── library.js
│       ├── recommendations.js
│       └── playlists.js
└── tests/
    ├── unit/
    │   ├── LibraryScanner.test.js
    │   ├── HistoryService.test.js
    │   ├── MusicAnalyzer.test.js
    │   ├── RecommendationEngine.test.js
    │   └── PlaylistBuilder.test.js
    └── integration/
        └── server.test.js
```

---

## API Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/health` | Status do servidor e dependências |
| GET | `/api/library/stats` | Estatísticas da biblioteca (totais, top gêneros) |
| GET | `/api/recommendations` | Recomendações de artistas/músicas fora da biblioteca |
| GET | `/api/recommendations/artists` | Apenas recomendações de artistas |
| POST | `/api/playlists/generate` | Gera playlist criativa da biblioteca |
| POST | `/api/playlists/from-prompt` | Gera playlist a partir de texto livre (Ollama interpreta) |
| GET | `/api/playlists` | Lista playlists salvas |
| GET | `/api/playlists/:id` | Retorna playlist específica |
| PATCH | `/api/playlists/:id` | Atualiza nome e/ou faixas de uma playlist |
| DELETE | `/api/playlists/:id` | Remove playlist |

---

## Serviços e Responsabilidades

### LibraryScanner
- Conecta Plex API (`PLEX_URL` + `PLEX_TOKEN`)
- Plex types: `type=8` artistas, `type=9` álbuns, `type=10` faixas
- Método `scan()` → `{ artists[], albums[], tracks[] }`
- Método `getLibraryStats()` → totais + top gêneros

### HistoryService
- Endpoint Plex: `GET /status/sessions/history/all?sort=viewedAt:desc&type=10`
- Método `getRecentlyPlayed(limit)` → `[{title, artist, album, playedAt}]`
- Método `getFavoriteArtists(limit)` → artistas ordenados por play count

### MusicAnalyzer
- Usa **AllFather** (`askForJSON`) para análise de perfil musical
- Método `analyzeArtist(name, genres, sampleTracks)` → `{genre, mood, energy, timbre, characteristics[]}`
- Método `buildLibraryProfile(artists[])` → `{topGenres[], dominantMood, avgEnergy}`
- Método `analyzeListeningTaste(history[])` → `{preferredGenres[], patterns}`

### RecommendationEngine
- Combina perfil de biblioteca + histórico para prompt ao Ollama
- Filtra artistas já existentes na biblioteca
- Método `recommend({ limit })` → `[{artist, description, genre, whyRecommended}]`
- Método `recommendArtists({ limit })` → artist-only recommendations

### PlaylistBuilder
- Usa AllFather para selecionar faixas que atendam critério
- Armazena em `Map` in-memory (+ JSON file em `../../mediasage/playlists/`)
- Método `generate({ mood, genre, energy, size, name })` → `{ id, name, tracks[], createdAt }`
- Método `generateFromPrompt(text)` → extrai parâmetros via AllFather → chama `generate()` ✅ **NOVO**
- Método `update(id, { name?, tracks? })` → merge + redesalva em disco ✅ **NOVO**
- Métodos CRUD: `save`, `list`, `get(id)`, `delete(id)`

---

## Stack Técnica

- **Runtime**: Node.js ESM (`"type": "module"`)
- **Webserver**: Express.js
- **HTTP client**: axios (para Plex API)
- **IA**: AllFather → Ollama (`deepseek-r1:14b` ou `deepseek-r1:1.5b`)
- **Testes**: Jest + Supertest, padrão TDD (red → green → refactor)
- **Injeção de dependências**: Todos os serviços aceitam deps no construtor (facilita mocks)

---

## Variáveis de Ambiente

```env
PLEX_URL=http://localhost:32400
PLEX_TOKEN=<token>
OLLAMA_URL=http://localhost:11434
OLLAMA_DEFAULT_MODEL=deepseek-r1:14b-qwen-distill-q4_K_M
MUSICSAGE_PORT=3001
```

---

## TODO / Progresso

### Fase 1 — Scaffolding ✅
- [x] FEATURE_TRACKER.md criado
- [x] package.json
- [x] jest.config.js

### Fase 2 — Testes TDD (Red → Green) ✅
- [x] `tests/unit/LibraryScanner.test.js` — 9 testes ✅
- [x] `tests/unit/HistoryService.test.js` — 11 testes ✅
- [x] `tests/unit/MusicAnalyzer.test.js` — 9 testes ✅
- [x] `tests/unit/RecommendationEngine.test.js` — 9 testes ✅
- [x] `tests/unit/PlaylistBuilder.test.js` — 15 testes ✅
- [x] `tests/integration/server.test.js` — 15 testes ✅

**Total: 68 testes, 68 passando ✅**

### Fase 3 — Implementação (Green) ✅
- [x] `src/services/LibraryScanner.js`
- [x] `src/services/HistoryService.js`
- [x] `src/services/MusicAnalyzer.js`
- [x] `src/services/RecommendationEngine.js`
- [x] `src/services/PlaylistBuilder.js`
- [x] `src/routes/health.js`
- [x] `src/routes/library.js`
- [x] `src/routes/recommendations.js`
- [x] `src/routes/playlists.js`
- [x] `src/server.js`
- [x] `index.js`

### Fase 4 — Integração no Monorepo ✅
- [x] Adicionado ao `workspaces` no `package.json` raiz
- [x] Scripts `musicsage:start` e `musicsage:test` registados em `plex-cli.js`
- [x] `npm install` executado — dependências instaladas

### Fase 5 — Extensões do PlaylistBuilder ✅
- [x] `PlaylistBuilder.generateFromPrompt(text)` — LLM interpreta texto → extrai parâmetros → chama `generate()`
- [x] `PlaylistBuilder.update(id, fields)` — edita nome e/ou faixas de playlist existente

### Fase 6 — Frontend SPA ✅
- [x] `src/routes/playlists.js` — adicionados `POST /from-prompt` e `PATCH /:id`
- [x] `src/server.js` — `express.static('public')` + SPA catch-all `GET *`
- [x] `public/index.html` — SPA dark-theme completa:
  - [x] Sidebar: Dashboard | Recomendações | Playlists | Nova Playlist
  - [x] Dashboard: cards com stats da biblioteca (artistas, álbuns, faixas) + status online/offline
  - [x] Recomendações: grid de artistas com género, descrição e "por quê", filtros por género, botão Atualizar
  - [x] Playlists: lista → expande → edição inline de nome → remoção de faixas → delete
  - [x] Nova Playlist: tab "Por Critérios" (mood, género, energia, tamanho) + tab "Por Prompt" (textarea livre)
- [x] `claude.md` atualizado com instruções de uso do MusicSage

### Fase 7 — Lições aprendidas / Fix notáveis
- **PlaylistBuilder storage isolation**: `_loadFromDisk()` chamado no construtor causava
  contaminação entre testes (dados persistidos de runs anteriores). Solução: opção
  `storageFile: false` desabilita persistência em disco — passa nos construtor do teste.

### Fase 8 — Sistema de Logging ✅
- [x] `src/logger.js` — singleton logger criado
  - Sem dependências externas (usa só `fs`, `path`, `url`)
  - Logs diários em `mediasage/logs/musicsage-YYYY-MM-DD.log`
  - Suprime TUDO (arquivo + console) em `NODE_ENV=test`
  - Nível DEBUG só aparece no console se `MUSICSAGE_DEBUG=1`
  - Categorias: `SERVER | HTTP | LIBRARY | PLAYLIST | RECOMMEND | OLLAMA`
  - Método helper: `logger.http(method, path, status, ms)`
  - Formato: `2026-03-31 10:45:22.123 [INFO ] [PLAYLIST  ] Message — {extra}`
- [x] `src/server.js` — middleware HTTP logging (método, rota, status, latência)
- [x] `src/services/PlaylistBuilder.js` — logging em todos os métodos públicos
- [x] `src/services/RecommendationEngine.js` — logging em `recommend()`
- [x] `index.js` — console.log/warn/error substituídos por `logger.*`; import `HistoryService` adicionado (estava faltando)

**Variáveis de ambiente adicionais:**
```env
MUSICSAGE_DEBUG=1       # habilita logs DEBUG no console (opcional)
```

**Localização dos logs:**
```
plex_server/mediasage/logs/musicsage-YYYY-MM-DD.log
```
- **Padrão DI consistente**: Todos os serviços recebem `axios`, `allfather`, `libraryScanner`
  pelo construtor → zero `jest.mock()` com ESM, 100% DI.

---

## Decisões de Design

| Decisão | Justificativa |
|---------|---------------|
| Dependency injection em todos os serviços | Permite mocks nos testes sem `jest.mock()` com ESM |
| `createServer(deps)` factory no server.js | Server testável sem ligar à porta real |
| AllFather com `askForJSON()` para análise | Retorno estruturado e previsível |
| Playlists em memória + JSON file | Simples, sem DB extra; persiste entre reinícios |
| Serviço `MusicAnalyzer` separado | Permite testar análise AI de forma isolada |

---

## Contexto do Projeto

- Monorepo com npm workspaces em `/home/developer/workspace/plex_server/`
- Outros agentes: AllFather, MusicCurator, SeriesCurator, Stormbringer, Transporter
- `mediasage/` na raiz = pasta de dados (config, db, playlists JSON)
- Plex corre em Docker na rede host, porta 32400
- Ollama corre em Docker (ou local), porta 11434
