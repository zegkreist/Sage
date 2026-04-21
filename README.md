# MusicSage

Dashboard de música com IA — busca torrents via Jackett, baixa com WebTorrent, integra ao Tidal via streamrip e conversa com sua biblioteca musical em linguagem natural.

Roda no seu NAS (ZimaOS, Synology, Unraid, TrueNAS). Conecta a um Plex, Ollama e Jackett que podem estar em qualquer máquina da rede.

---

## O que é

| Módulo | Função |
|---|---|
| **Dashboard** | Interface web — biblioteca, recomendações, playlists, downloads |
| **Stormbringer** | Busca e baixa torrents (músicas, filmes, séries) via Jackett |
| **TideCaller** | Baixa músicas em alta qualidade (FLAC 24-bit) via Tidal/streamrip |
| **Transporter** | Move downloads concluídos para as pastas corretas do Plex |
| **AllFather** | Camada de IA (Ollama) — análise, embeddings, chat com a biblioteca |

---

## Dependências externas

O Sage **não embarca** esses serviços — você os sobe separadamente no NAS:

| Serviço | Porta | Para quê |
|---|---|---|
| **Plex** | 32400 | Servidor de mídia — o Sage lê a biblioteca e dispara rescans |
| **Ollama** | 11434 | LLM local — análise de faixas, recomendações, embeddings |
| **Jackett** | 9117 | Indexador de torrents — agrega múltiplos trackers numa API só |
| **FlareSolverr** | 8191 | Resolve Cloudflare para indexers protegidos do Jackett |

---

## Setup no ZimaOS / CasaOS

### 1. Suba o Jackett + FlareSolverr

O Jackett depende do FlareSolverr para acessar indexers que usam Cloudflare. Eles rodam no mesmo compose.

```yaml
# docker-compose — Jackett + FlareSolverr
name: flaresolverr
services:

  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    container_name: flaresolverr
    restart: unless-stopped
    environment:
      - LOG_LEVEL=info
      - TZ=America/Sao_Paulo
    ports:
      - "8191:8191"   # API usada internamente pelo Jackett
    # Sem volumes — FlareSolverr é stateless (só processa requests)

  jackett:
    image: lscr.io/linuxserver/jackett:latest
    container_name: jackett
    restart: unless-stopped
    depends_on:
      flaresolverr:
        condition: service_started
    environment:
      - AUTO_UPDATE=true    # atualiza o Jackett automaticamente (recomendado)
      - PUID=1000            # UID do usuário dono dos arquivos de config
      - PGID=1000
      - TZ=America/Sao_Paulo
    ports:
      - "9117:9117"
    volumes:
      # Persiste a config do Jackett (API key, indexers configurados)
      # Sem esse volume você perderia toda a config ao recriar o container
      - /DATA/AppData/flaresolverr/config:/config
```

**Por que dois serviços no mesmo compose?**
O `depends_on` garante que o FlareSolverr já está de pé quando o Jackett inicia. Se o Jackett tentar resolver um indexer com Cloudflare antes do FlareSolverr estar pronto, a requisição falha.

**Configurando o Jackett para usar o FlareSolverr:**
Acesse `http://<IP-DO-NAS>:9117` → `Jackett Configuration` → `FlareSolverr API URL`:
```
http://flaresolverr:8191   ← nome do container, já que estão na mesma rede bridge
```

---

### 2. Configure os indexers no Jackett

`+ Add Indexer` → adicione os indexers que preferir (1337x, TorrentGalaxy, RuTracker, etc.).

> **Importante:** depois de adicionar, copie a **Jackett API Key** (`http://<NAS>:9117` → API Key no topo da página). Você vai precisar dela como variável de ambiente do Sage.

---

### 3. Suba o Sage

```yaml
# docker-compose — MusicSage
name: picturesque_alan
services:
  main_app:
    image: zegkreist/musicsage:latest
    container_name: Sage
    restart: unless-stopped
    ports:
      - "3002:3002"

    environment:
      # ── Plex ───────────────────────────────────────────────────────────────
      # URL do servidor Plex na sua rede local
      - PLEX_URL=http://192.168.15.14:32400

      # Onde a mídia do Plex está montada DENTRO deste container
      # /media será o equivalente à raiz — o Sage acessa /media/music, /media/movies etc.
      - PLEX_MEDIA_PATH=/media

      # Pasta de config do Plex — necessária para extrair o PLEX_TOKEN automaticamente
      # do arquivo Preferences.xml (evita passar o token via env)
      - PLEX_CONFIG_DIR=/plex-config

      # ── Ollama ─────────────────────────────────────────────────────────────
      # LLM local para análise, recomendações e embeddings
      - OLLAMA_URL=http://192.168.15.94:11434
      - OLLAMA_DEFAULT_MODEL=gemma4:e4b

      # Modelo de embeddings para busca semântica na biblioteca
      - EMBEDDING_MODEL=nomic-embed-text

      # ── Jackett ────────────────────────────────────────────────────────────
      # URL do Jackett — usada pelo Stormbringer para buscar torrents
      - JACKETT_URL=http://192.168.15.14:9117
      # A API key do Jackett é lida automaticamente do volume /jackett-config
      # (arquivo ServerConfig.json dentro da pasta de config do Jackett/FlareSolverr)

      # ── Extras ─────────────────────────────────────────────────────────────
      # Last.fm: enriquece metadados (bio de artistas, tags, similares)
      - LASTFM_API_KEY=

    volumes:
      # Mídia do Plex — montada a partir do NAS
      # O Sage lê daqui para analisar a biblioteca e o Transporter move arquivos para cá
      - /media/firstBlood/plex:/media

      # Config do Plex — necessária apenas para ler o Preferences.xml e extrair o token
      # Não é necessário se você passar PLEX_TOKEN diretamente nas env vars
      - /media/ZimaOS-HD/AppData/plex/config:/plex-config

      # Dados persistentes do Sage: cache de análises, embeddings, playlists, logs
      # NUNCA apague esse volume — embeddings levam horas para regenerar
      - /media/firstBlood/sage/data:/data

      # Downloads do Stormbringer e TideCaller
      # Subpastas: stormbringer/musicas, stormbringer/filmes, stormbringer/series, tidecaller
      - /media/firstBlood/sage/downloads:/downloads

      # Config do Jackett montada para leitura da API key
      # O Sage lê ServerConfig.json daqui automaticamente
      - /media/ZimaOS-HD/AppData/flaresolverr/config:/jackett-config

    # O container precisa de privilégios para montar/acessar os shares de rede do NAS
    privileged: true

    # Limite de RAM: 16 GB — ajuste conforme disponível no seu NAS
    deploy:
      resources:
        limits:
          memory: 16508243968
```

---

## Volumes explicados

| Volume (host → container) | Por quê |
|---|---|
| `/media/firstBlood/plex → /media` | Toda a biblioteca de mídia. O Sage acessa `/media/music`, `/media/movies`, `/media/series`. O Transporter move arquivos concluídos para cá. |
| `/media/ZimaOS-HD/AppData/plex/config → /plex-config` | Contém `Preferences.xml` com o `PLEX_TOKEN`. O entrypoint extrai o token automaticamente — sem isso você precisaria passar o token manualmente. |
| `/media/firstBlood/sage/data → /data` | Cache de análises de faixas, embeddings vetoriais, playlists geradas por IA e logs. **Crítico** — nunca apague. |
| `/media/firstBlood/sage/downloads → /downloads` | Destino dos downloads. Subpastas são criadas automaticamente. Pode ser um disco separado com mais espaço. |
| `/media/ZimaOS-HD/AppData/flaresolverr/config → /jackett-config` | Config do Jackett — o Sage lê a API key do `ServerConfig.json` automaticamente (sem precisar passar como env var). |

---

## Variáveis de ambiente

### Plex

| Variável | Descrição |
|---|---|
| `PLEX_URL` | URL do Plex na rede local (`http://IP:32400`) |
| `PLEX_TOKEN` | Token de autenticação. **Opcional** se `PLEX_CONFIG_DIR` estiver montado — o token é extraído automaticamente do `Preferences.xml`. |
| `PLEX_MEDIA_PATH` | Caminho de mídia dentro do container (default: `/media`) |
| `PLEX_CONFIG_DIR` | Pasta de config do Plex — usada para extrair `PLEX_TOKEN` automaticamente |

### Ollama

| Variável | Descrição |
|---|---|
| `OLLAMA_URL` | URL do servidor Ollama. Pode ser em outra máquina da rede. |
| `OLLAMA_DEFAULT_MODEL` | Modelo para análise e chat (ex: `gemma4:e4b`, `llama3.2:3b`) |
| `EMBEDDING_MODEL` | Modelo para embeddings de busca semântica (ex: `nomic-embed-text`) |

### Stormbringer (torrents)

| Variável | Descrição |
|---|---|
| `JACKETT_URL` | URL do Jackett (`http://IP:9117`). Sem isso, o Stormbringer busca só via scraping público. |

### Extras

| Variável | Descrição |
|---|---|
| `LASTFM_API_KEY` | API Key do Last.fm — enriquece bio de artistas e tags. Opcional. |
| `MUSICSAGE_PORT` | Porta HTTP do Sage (default: `3002`) |

---

## Fluxo de download (Stormbringer)

```
Usuário pesquisa no Dashboard
        ↓
Stormbringer chama Jackett API
        ↓
Jackett consulta os indexers configurados
(FlareSolverr resolve Cloudflare quando necessário)
        ↓
Resultados voltam ao Dashboard (nome, tamanho, seeders, indexer)
        ↓
Usuário clica em baixar
        ↓
Sage resolve o link (.torrent ou redirect → magnet)
        ↓
WebTorrent baixa para /downloads/stormbringer/<tipo>
        ↓
Download aparece no Dashboard com progresso em tempo real
        ↓
(Futuro) Transporter move para /media/<tipo> e aciona rescan do Plex
```

---

## Fluxo de download (TideCaller / Tidal)

```
Usuário cola URL do Tidal (álbum, faixa, playlist)
        ↓
TideCaller chama streamrip (Python) no venv isolado
        ↓
streamrip autentica no Tidal e baixa em FLAC / MQA
        ↓
Arquivos vão para /downloads/tidecaller
        ↓
Progresso visível no Dashboard
```

**Autenticação do Tidal (primeira vez):**
O token OAuth é salvo dentro do container em `/agents/TideCaller/config/.config`. Para persistir entre recriações, monte esse diretório:
```yaml
- tidal-config:/agents/TideCaller/config
```

---

## Acessando o Sage

Após subir o container, acesse:
```
http://<IP-DO-NAS>:3002
```

API de saúde:
```
http://<IP-DO-NAS>:3002/api/health
```

---

## Plex

O Sage foi desenvolvido pensando no Plex como servidor de mídia, mas **não embarca o Plex** — você o hospeda separadamente.

### Recomendação: hospede o Plex no mesmo NAS

Hostar o Plex no NAS tem vantagens claras:
- A mídia já está no NAS — sem transferência de rede para transcodagem
- NAS fica ligado 24/7 — Plex disponível sempre
- ZimaOS, Synology, QNAP e Unraid têm imagens oficiais do Plex

**docker-compose para o Plex no ZimaOS / CasaOS:**

```yaml
services:
  plex:
    image: lscr.io/linuxserver/plex:latest
    container_name: plex
    restart: unless-stopped
    network_mode: host   # necessário para descoberta automática na rede local
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/Sao_Paulo
      - VERSION=docker
      - PLEX_CLAIM=claim-xxxxxxxxxxxx   # https://plex.tv/claim (válido 4 min, só 1ª vez)
    volumes:
      # Config e metadados do Plex — inclui banco de dados, transcodagem e Preferences.xml
      # O Sage monta essa mesma pasta para extrair o PLEX_TOKEN automaticamente
      - /media/ZimaOS-HD/AppData/plex/config:/config

      # Mídia — as mesmas pastas montadas no Sage
      - /media/firstBlood/plex:/media
```

**Configuração inicial:**
1. Suba o container e acesse `http://<IP-DO-NAS>:32400/web`
2. Faça login com conta Plex
3. Adicione bibliotecas:
   - **Música** → `/media/music`
   - **Filmes** → `/media/movies`
   - **Séries** → `/media/series`

**Obtendo o PLEX_TOKEN** (se não usar `PLEX_CONFIG_DIR`):
No Plex Web, abra qualquer item → `...` → `Get Info` → `View XML`. O token aparece como `X-Plex-Token=` na URL.

---

## Diagrama geral

```
NAS (ZimaOS)
├── Sage :3002          → dashboard, downloads, IA
├── Plex :32400         → servidor de mídia
├── Jackett :9117       → indexador de torrents
└── FlareSolverr :8191  → bypass Cloudflare (usado pelo Jackett)

Outra máquina (ou mesmo NAS)
└── Ollama :11434       → LLM local (análise, embeddings, chat)

Storage (volumes compartilhados)
├── /media/music        → biblioteca de músicas (Plex lê, Transporter escreve)
├── /media/movies       → filmes
├── /media/series       → séries
├── /data               → cache do Sage (embeddings, análises, logs)
└── /downloads          → área de trabalho dos downloads
```

