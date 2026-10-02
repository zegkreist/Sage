# IDEAS.md — Auditoria do Frontend Sage (MusicSage)

**Data:** 2026-10-02
**Escopo:** SPA Svelte (`musicsage/frontend`) + API Express (`musicsage/src/routes`, `src/services`)
**Verificação ao vivo:** `http://192.168.15.14:3002` respondeu **200** em `/` e em todos os endpoints testados via curl: `/api/health`, `/api/library/stats`, `/api/library/users`, `/api/recommendations`, `/api/playlists`, `/api/logs/today`, `/api/tools/queue`, `/api/weekly`, `/api/lyrics/stats`, `/api/plex/status`, `/api/hermes/inbox`.

> Marque `- [x]` para aprovar cada proposta. Nada foi implementado.

---

## 1. Mapeamento da auditoria

### 1.1 Tamanho do código (linhas)

| Área | Arquivo | LOC |
|---|---|---|
| FE page | `pages/Downloads.svelte` | 1265 |
| FE page | `pages/Dashboard.svelte` | 657 |
| FE page | `pages/AnalysisLibrary.svelte` | 446 |
| FE comp | `components/ui/ShareStoryModal.svelte` | 549 |
| BE route | `routes/tools.js` | 1153 |
| BE service | `services/PlaylistBuilder.js` | 1599 |
| BE service | `services/RecommendationEngine.js` | 759 |

### 1.2 Código morto — componentes Svelte não usados em nenhum arquivo

Confirmado por busca de imports em todo `frontend/src`:

- `components/data/DataTable.svelte` (48 linhas) — **0 usos**
- `components/ui/Alert.svelte` — **0 usos**
- `components/ui/EmptyState.svelte` — **0 usos**
- `components/layout/PageHeader.svelte` — **0 usos**

### 1.3 Endpoints backend sem consumo no frontend (órfãos para a SPA)

Verificado greppando cada path no `frontend/src`:

| Endpoint | Arquivo | Observação |
|---|---|---|
| `GET /library/history` | `routes/library.js:91` | sem uso no FE |
| `GET /library/curiosidades` | `routes/library.js:250` | sem uso no FE |
| `POST /audio/analyze`, `/audio/embed`, `/audio/playlist` | `routes/audio.js` | AnalysisLibrary usa só batch/cache |
| `POST /playlists/generate` | `routes/playlists.js:29` | FE usa `from-prompt` / `from-cache-*` |
| `GET /tools/stormbringer/feeds` | `routes/tools.js:697` | Downloads usa `/feeds/browse` |
| `POST /hermes/status` | `routes/hermes.js:75` | FE lê só `/hermes/inbox` |
| `POST /embeddings/start|stop|reset`, `GET /embeddings/status|similar` | `routes/embeddings.js` | FE usa só `clusters`/`clusters-by-analysis` |

### 1.4 Duplicações de endpoints (backend)

1. **`tools.js` — buscas Stormbringer triplicadas:** `POST /tools/stormbringer/search` (:603), `/search/movie` (:640) e `/search/series` (:668) têm corpo quase idêntico (mesma moldura `getTorrentSearch` → `withSearchTimeout` → `res.json(results.slice(0, limit).map(...))` → catch idêntico). Só muda o método do serviço chamado.
2. **`tools.js` — `POST /tools/tidecaller/download-url` (:1040) e `/tools/tidecaller/album/download-url` (:1042)** apontam para o **mesmo handler** `tidalDownloadByUrl` — alias puro.
3. **`playlists.js` — 4 endpoints de criação de playlist** (`/generate`, `/from-prompt`, `/from-cache-prompt`, `/from-cache-track`) repetem o padrão `gerar → playlistBuilder.save → _trySyncToMediaServer → 201/500`, incluindo o branch duplicado sync/async (`jobRunner`) em `/from-prompt` e `/by-prompt`.
4. **`logs.js` — `DELETE /logs` e `DELETE /logs/all`** coexistem com semântica sobreposta.
5. **`recommendations.js` — `/similar` vs `/similar-in-library`** differem só do método do engine; handlers idênticos.

### 1.5 Duplicações / inconsistências no frontend

1. **`App.svelte` repete o dispatch de rotas inteiro 2×** (bloco mobile e desktop): o mesmo `{#if $currentPage === 'dashboard'} … {/if}` duplicado (~9 rotas × 2). Rota nova exige 2 edições.
2. **Polling de progresso duplicado em `AnalysisLibrary.svelte`:** `GET /audio/batch-progress` chamado em 3 lugares (:58, :67, :101) e `/lyrics/batch-progress` em 3 (:157, :166, :196) — dois loops de polling quase iguais copiados para áudio e letras.
3. **`Sidebar.svelte:36` usa `fetch('/api/health')` cru** em vez do wrapper `api()` de `lib/api.js` (sem timeout, sem tratamento de erro padronizado).
4. **Cores hardcoded fora do design system** (`tailwind.config.js` já define tokens `bg/surface/accent/dim/danger`):

   | Cor encontrada | Vezes | Token correto |
   |---|---|---|
   | `#1a1a28` | 51 | `surface` #111118 ou `border` |
   | `#9d8eff` | 44 | `accent-hi` (ok, mas hardcoded em vez da classe) |
   | `#16161f` | 42 | `surface2` |
   | `#7c6af5` | 37 | `accent` |
   | `#8888a8` | 22 | `dim` |
   | `#f87171` | 19 | `danger` #ef4444 (tom divergente) |
   | `#ef4444` | 18 | `danger` |
   | `#f59e0b` | 15 | `warn` |
   | `#38bdf8` | 12 | `info` |
   | `#0a0a0f` hardcoded inline | 11 | `bg-bg` |
   | variantes one-off: `#1c1c28`, `#2e2e4a`, `#3a3a58`, `#08080f`, `#070710`, `#8b5cf6`, `#818cf8`, `#a78bfa`, `#c084fc`… | ~40 | n/a — ruído de paleta |

   ~65% das ocorrências de cor são literais hex em `<style>`/classes em vez dos tokens Tailwind; isso quebra a promessa do design system (bg `#0a0a0f`, accent `#7c6af5`).
5. **Duas cores de "vermelho de perigo"** (`#f87171` vs `#ef4444`) e **três tons de violeta-accent** (`#7c6af5`, `#8b5cf6`, `#818cf8`) competindo na UI.

---

## 2. Propostas

### [CONSOLIDAÇÃO]

- [ ] **C1 — Centralizar dispatch de rotas do App.svelte**
  - **Problema:** bloco `{#if $currentPage …}` duplicado para mobile e desktop em `App.svelte`; adicionar página exige 2 edições e pode divergir.
  - **Esforço:** S
  - **Onde:** `frontend/src/App.svelte` — extrair para `<RouteOutlet currentPage={$currentPage} />` usando um mapa `{ dashboard: Dashboard, … }` e `<svelte:component this={map[$currentPage]} />`.

- [ ] **C2 — Extrair helper reutilizável de polling de progresso**
  - **Problema:** 6 chamadas de polling quase idênticas em `AnalysisLibrary.svelte` (3× `/audio/batch-progress`, 3× `/lyrics/batch-progress`); cada mudança precisa ser feita em dobro.
  - **Esforço:** S
  - **Onde:** `frontend/src/pages/AnalysisLibrary.svelte` (:58–196) → novo `pollProgress(path, setState, {intervalMs})` em `lib/api.js` (ao lado de `pollJob`), reaproveitado para áudio e letras.

- [ ] **C3 — Unificar handlers de busca do Stormbringer**
  - **Problema:** 3 rotas ~idênticas em `routes/tools.js` (:603/:640/:668); qualquer correção (timeout, shape de resposta) tem de ser replicada 3×.
  - **Esforço:** S
  - **Onde:** `src/routes/tools.js` — fatorar `registerTorrentSearch(route, fetchFn, label)`; mantém os 3 paths públicos (backward-compatible) delegando a um único handler.

- [ ] **C4 — Consolidar criação de playlists em um único pipeline**
  - **Problema:** `/playlists/generate`, `/from-prompt`, `/from-cache-prompt`, `/from-cache-track` repetem gerar→save→sync→resposta (com branch sync/async duplicado); risco de divergência de comportamento.
  - **Esforço:** M
  - **Onde:** `src/routes/playlists.js` (:29–180) — extrair `createPlaylist(builderFn, req, res)` que encapsula `jobRunner` opcional + `save` + `_trySyncToMediaServer`; os 4 endpoints viram 4 builders.

- [ ] **C5 — Remover código morto (componentes e endpoints órfãos)**
  - **Problema:** `DataTable.svelte`, `Alert.svelte`, `EmptyState.svelte`, `PageHeader.svelte` nunca importados; endpoints sem consumo (`/library/history`, `/library/curiosidades`, `/tools/stormbringer/feeds`, `/hermes/status`, alias `/tidecaller/album/download-url`) aumentam superfície de manutenção.
  - **Esforço:** S
  - **Onde:** deletar os 4 componentes em `frontend/src/components/{data,ui,layout}/`; decidir (com o dono) se endpoints órfãos são de API pública — se sim, documentar; se não, remover de `src/routes/`.

- [ ] **C6 — Migrar cores hardcoded para os tokens do Tailwind**
  - **Problema:** ~65% das cores do FE são hex literais (`#1a1a28`×51, `#9d8eff`×44, `#7c6af5`×37, `#f87171`×19…), incluindo tons que competem com os tokens oficiais (bg `#0a0a0f`, accent `#7c6af5`); o design system não é garantido na prática.
  - **Esforço:** M
  - **Onde:** todos os blocos `<style>` de `frontend/src/pages/*.svelte` + `app.css` — substituir por `var(--accent)`, `bg-surface`, `text-dim` etc.; adicionar lint (`stylelint-declaration-strict-value` ou grep no CI) para bloquear hex fora de `tailwind.config.js`/`app.css`.

- [ ] **C7 — Padronizar chamadas HTTP no wrapper `api()`**
  - **Problema:** `Sidebar.svelte:36` usa `fetch('/api/health')` cru, sem timeout nem tratamento de erro do wrapper; padrão pode se espalhar.
  - **Esforço:** S
  - **Onde:** `frontend/src/components/layout/Sidebar.svelte` — trocar por `get('/health')` de `lib/api.js` com fallback do status dot.

### [FEATURE NOVA]

- [ ] **F1 — Player global (mini-player persistente na sidebar/bottom nav)**
  - **Problema:** hoje o play de prévia (quando existe) é local às páginas; não há continuidade de audição ao navegar entre Dashboard/Playlists/Recomendações.
  - **Esforço:** M
  - **Onde:** novo `frontend/src/components/layout/MiniPlayer.svelte` + store `lib/stores/player.js`; monta na barra inferior do layout em `App.svelte`; consome thumbnails via `GET /api/library/thumb?path=` (endpoint já existe e responde).

- [ ] **F2 — Página "Biblioteca" com busca e filtros (ativar endpoints órfãos)**
  - **Problema:** `GET /library/artists` e `GET /library/tracks` (com paginação) já existem em `routes/library.js` mas nenhuma view os expõe — não há como procurar uma faixa/artista da biblioteca pela UI.
  - **Esforço:** M
  - **Onde:** nova `frontend/src/pages/Library.svelte` + rota `library` em `App.svelte`/`Sidebar.svelte`/`BottomNav.svelte`; chamar `get('/library/tracks?q=…&page=…')`; reusar `TrackRow.svelte` (hoje usado em 2 arquivos).

- [ ] **F3 — Central "Retrospectiva" dedicada com seleção de usuário e período**
  - **Problema:** `/library/metrics?period=&userId=` e `/library/users` já suportam filtros, mas estão presos ao Dashboard (657 linhas); a retrospectiva não é explorável em tela cheia nem compartilhável.
  - **Esforço:** M
  - **Onde:** extrair seção de `frontend/src/pages/Dashboard.svelte` para `pages/Rewind.svelte`; parâmetros na URL (`#/rewind?period=2026&userId=…`) via `lib/stores/router.js`.

- [ ] **F4 — "For You" semanal: integrar Weekly Discovery + Hermes Inbox na UI**
  - **Problema:** existe `WeeklyDiscoveryService` + `GET/PUT /weekly`, `POST /weekly/run` e `POST /hermes/status`, mas o FE só lê `/hermes/inbox`; o usuário não vê nem dispara a descoberta semanal pela interface.
  - **Esforço:** M
  - **Onde:** nova seção em `pages/Recommendations.svelte` (ou página `Weekly.svelte`): botão "Rodar agora" → `post('/weekly/run', {async:true})` + `pollJob`; badge de novidades alimentado por `/hermes/inbox` já existente no FE.

- [ ] **F5 — Toast/notificação em tempo real para downloads (Stormbringer/TideCaller)**
  - **Problema:** progresso de torrents/jobs só aparece dentro de `Downloads.svelte` (1265 linhas); o usuário não sabe que um download terminou se estiver noutra página.
  - **Esforço:** S
  - **Onde:** polling global em `App.svelte` (ou store `lib/stores/downloads.js`) consumindo `GET /api/tools/queue` (já responde 200) e emitindo toasts via store existente `lib/stores/toast.js`/`ToastContainer.svelte`.

- [ ] **F6 — Comparador "similar-in-library": ponte entre descoberta e acervo**
  - **Problema:** `GET /recommendations/similar-in-library` existe e é quase-duplicado de `/similar`, mas nenhuma view cruza "artista recomendado → o que já tenho parecido" — o recurso mais valioso do engine está invisível.
  - **Esforço:** M
  - **Onde:** card expandido em `pages/Recommendations.svelte` ("Você já tem parecidos: …" chamando `get('/recommendations/similar-in-library?artist=…')`) + CTA para criar playlist via `post('/playlists/from-cache-prompt')`.

- [ ] **F7 — Command palette (⌘K) de navegação e ações**
  - **Problema:** 9 páginas e várias ações (sync Plex, rodar análise, gerar playlist por prompt) exigem navegação manual; power user perde tempo.
  - **Esforço:** L
  - **Onde:** novo `frontend/src/components/ui/CommandPalette.svelte`; lista de comandos = rotas do mapa do `App.svelte` + ações rápidas (`post('/plex/reload-token')`, `post('/weekly/run')`, navegação via `lib/stores/router.js`); atalho global registrado em `App.svelte`.

- [ ] **F8 — Página de Health/Status unificada com self-check da API**
  - **Problema:** `PlexStatus.svelte` (261 linhas) cobre só Plex; falhas de Ollama/Last.fm/Jackett só aparecem nos logs. `/api/health` e `/api/plex/status` existem e respondem, mas não há um painel único de dependências.
  - **Esforço:** M
  - **Onde:** estender `frontend/src/pages/PlexStatus.svelte` com grid de dependências (`/api/health`, `/api/tools/tidecaller/token/check`, `/api/lyrics/stats` para cache de letras) e semáforo por token (`positive`/`warn`/`danger` do Tailwind — já definidos).

---

## 3. Resumo

| Categoria | Itens | Esforço total |
|---|---|---|
| Consolidação | C1–C7 | 5×S, 2×M |
| Feature nova | F1–F8 | 2×S, 5×M, 1×L |

Achados principais: dispatch de rotas duplicado no `App.svelte`, polling triplicado no `AnalysisLibrary`, 3 handlers de busca torrent quase idênticos, 4 pipelines paralelos de criação de playlist, ~65% das cores fora dos tokens do design system, 4 componentes mortos e ~10 endpoints sem consumo no frontend (alguns são candidatos naturais a virar features — F2, F3, F4, F6).
