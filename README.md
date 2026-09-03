# MusicSage

Dashboard de música com IA — analisa sua biblioteca, gera recomendações, constrói playlists por prompt em linguagem natural, busca torrents via Jackett e baixa em FLAC via Tidal.

Funciona tanto no seu servidor de desenvolvimento (usando o `docker-compose.yml` da raiz) quanto no NAS (ZimaOS, Synology, Unraid, TrueNAS) com a imagem pré-compilada `zegkreist/musicsage:latest`.

---

## O que é

| Módulo | Função |
|---|---|
| **Dashboard** | Interface web — biblioteca, recomendações, playlists, downloads, logs |
| **AllFather** | Camada de IA (Ollama) — análise, embeddings, chat com a biblioteca |
| **Stormbringer** | Busca e baixa torrents (músicas, filmes, séries) via Jackett |
| **TideCaller** | Baixa músicas em alta qualidade (FLAC 24-bit) via Tidal/streamrip |
| **Transporter** | Move downloads concluídos para as pastas corretas do Plex |

---

## Dependências externas

O Sage **não embarca** esses serviços — você os sobe separadamente:

| Serviço | Porta padrão | Para quê |
|---|---|---|
| **Plex** | 32400 | Servidor de mídia — o Sage lê a biblioteca e dispara rescans |
| **Ollama** | 11434 | LLM local — análise de faixas, recomendações, embeddings |
| **Jackett** | 9117 | Indexador de torrents — agrega múltiplos trackers numa API só |
| **FlareSolverr** | 8191 | Resolve Cloudflare para indexers protegidos do Jackett |

---

## Jackett — o que é e por que o Stormbringer precisa dele

Quando você pesquisa um torrent no Dashboard, quem executa a busca é o **Stormbringer**. O problema: cada site de torrent (1337x, TorrentGalaxy, RuTracker, Nyaa, etc.) tem HTML diferente e regras de anti-bot próprias. Rastrear cada um individualmente seria inviável.

O **Jackett** resolve isso sendo um **agregador de indexers**: você configura os trackers uma única vez na interface dele e ele expõe tudo numa API REST padronizada. O Stormbringer faz uma chamada só no Jackett e recebe resultados de todos os trackers configurados de uma vez.

```
Sage (Stormbringer)
       │
       │  GET /api?query=Pink+Floyd
       ▼
    Jackett :9117
    ├── 1337x
    ├── TorrentGalaxy
    ├── RuTracker
    └── Nyaa
```

O **FlareSolverr** entra em cena quando algum desses trackers usa proteção Cloudflare — ele simula um browser real para resolver o desafio JS antes de devolver o resultado ao Jackett.

**Sem Jackett:** o Stormbringer ainda funciona com scraping público direto, mas o resultado é menos confiável e cobre menos trackers.

---

## Configurando o Jackett

### 1. Suba o stack (Jackett + FlareSolverr)

Use o compose em `jackett/docker-compose.yml`. Ajuste o volume de config para o caminho do seu servidor:

```yaml
# jackett/docker-compose.yml
name: jackett-stack

services:

  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    container_name: flaresolverr
    environment:
      - LOG_LEVEL=info
      - TZ=America/Sao_Paulo
    ports:
      - "8191:8191"
    restart: unless-stopped

  jackett:
    image: lscr.io/linuxserver/jackett:latest
    container_name: jackett
    depends_on:
      - flaresolverr
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/Sao_Paulo
      - AUTO_UPDATE=true
    volumes:
      # Persiste config e API key — sem isso você perde tudo ao recriar o container
      - /seu/caminho/jackett-config:/config
    ports:
      - "9117:9117"
    restart: unless-stopped
```

```bash
cd jackett
docker compose up -d
```

### 2. Conecte o FlareSolverr ao Jackett

Acesse `http://<IP>:9117` → **Jackett Configuration** → campo **FlareSolverr API URL**:

```
http://flaresolverr:8191
```

> Use o nome do container (não o IP) — eles estão na mesma rede bridge do compose.

Salve e volte para a tela principal.

### 3. Adicione indexers

Clique em **+ Add Indexer** e adicione os trackers que preferir. Sugestões para música:

| Indexer | Foco |
|---|---|
| **1337x** | Geral — boa cobertura de álbuns |
| **TorrentGalaxy** | Geral — alternativa robusta |
| **RuTracker** | Música clássica, jazz, discografias completas |
| **Nyaa** | Anime, trilhas sonoras japonesas |

Após adicionar, clique em **Test** em cada indexer para confirmar que estão funcionando.

### 4. Copie a API Key

Na tela principal do Jackett, no topo da página, está a **API Key** — ela parece com:

```
a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
```

Você vai passar essa chave para o Sage de duas formas (escolha uma):

**Opção A — via variável de ambiente** (mais simples):
```yaml
environment:
  - JACKETT_URL=http://<IP>:9117
  - JACKETT_API_KEY=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
```

**Opção B — montando o volume de config** (automático, sem repetir a chave):
```yaml
environment:
  - JACKETT_URL=http://<IP>:9117
  # JACKETT_API_KEY não precisa ser definida

volumes:
  - /seu/caminho/jackett-config:/jackett-config:ro
  # O Sage lê a chave de /jackett-config/ServerConfig.json automaticamente
```

> A Opção B é preferível em NAS — se a chave do Jackett mudar (após reset), o Sage a lê atualizada sem precisar reiniciar.

---

## Variáveis de ambiente

Esta é a seção mais importante para subir o container corretamente.

### Referência completa

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `PLEX_URL` | **Sim** | — | URL do Plex na rede local. Ex: `http://192.168.1.10:32400` |
| `PLEX_TOKEN` | Condicional | — | Token de autenticação do Plex. Pode ser omitido se `PLEX_CONFIG_DIR` estiver montado (extraído do `Preferences.xml` automaticamente) |
| `PLEX_MEDIA_PATH` | **Sim** | `/media` | Raiz da mídia dentro do container. O Sage acessa `/media/music`, `/media/movies`, `/media/tv` a partir daqui |
| `PLEX_CONFIG_DIR` | Condicional | — | Pasta de config do Plex montada no container. Usada apenas para extrair `PLEX_TOKEN` automaticamente. Desnecessário se você passar `PLEX_TOKEN` diretamente |
| `OLLAMA_URL` | **Sim** | — | URL do Ollama. Pode ser em outra máquina. Ex: `http://192.168.1.10:11434` |
| `OLLAMA_DEFAULT_MODEL` | Não | `gemma4-256k:latest` | Modelo LLM para análise, recomendações e chat. Testados: `gemma4-256k:latest`, `deepseek-r1:1.5b`, `llama3.2:3b` |
| `EMBEDDING_MODEL` | Não | `nomic-embed-text` | Modelo de embeddings para clustering e playlist semântica. Instale com `ollama pull nomic-embed-text` |
| `JACKETT_URL` | Não | — | URL do Jackett. Necessário para a aba Downloads (Stormbringer). Ex: `http://192.168.1.10:9117` |
| `JACKETT_API_KEY` | Não | — | API Key do Jackett. Alternativa: monte `/jackett-config` para extração automática do `ServerConfig.json` |
| `LASTFM_API_KEY` | Não | — | API Key do Last.fm. **Fortemente recomendado** — sem ela, recomendações usam geração livre e podem incluir artistas fictícios. Chave gratuita em [last.fm/api](https://www.last.fm/api/account/create) |
| `MUSICSAGE_PORT` | Não | `3002` | Porta HTTP do servidor |
| `DATA_DIR` | Não | `/data` | Raiz dos dados persistentes: cache de análises, embeddings, playlists |
| `LOG_DIR` | Não | `/data/logs` | Diretório de logs (um arquivo por dia) |
| `STORMBRINGER_DIR` | Não | `/agents/Stormbringer` | Path do agente Stormbringer dentro do container |
| `TIDECALLER_DIR` | Não | `/agents/TideCaller` | Path do agente TideCaller dentro do container |
| `MUSICSAGE_DEBUG` | Não | — | Defina como `1` para ativar logs verbosos (DEBUG) |

### Como obter o PLEX_TOKEN

**Opção 1 — via URL (mais simples):**
No Plex Web, abra qualquer item → `···` → `Get Info` → `View XML`. O token aparece como `X-Plex-Token=` na URL.

**Opção 2 — montar a config do Plex:**
Monte a pasta de config do Plex no container como `/plex-config` e defina `PLEX_CONFIG_DIR=/plex-config`. O entrypoint extrai o token do `Preferences.xml` automaticamente.

### Como obter o PLEX_CLAIM

Acesse [plex.tv/claim](https://www.plex.tv/claim/) enquanto logado na sua conta Plex. O token gerado é válido por **4 minutos** e só é necessário na **primeira execução** do container Plex (para vincular ao servidor).

---

## Setup — servidor local (docker-compose)

Para rodar no servidor de desenvolvimento usando o `docker-compose.yml` da raiz do projeto:

### 1. Configure o `.env`

Copie o exemplo e preencha os valores:

```bash
cp .env.example .env   # ou edite o .env existente
```

Variáveis do `.env` para o Sage:

```dotenv
# ── Plex ──────────────────────────────────────────────────────────────────────
PLEX_URL=http://localhost:32400
PLEX_TOKEN=                        # cole o token obtido acima
PLEX_CLAIM=                        # só necessário na 1ª vez — obtenha em plex.tv/claim

# ── Identidade do processo ────────────────────────────────────────────────────
PUID=1000
PGID=1000
TZ=America/Sao_Paulo

# ── Paths das bibliotecas no host ─────────────────────────────────────────────
MUSIC_PATH=/caminho/absoluto/para/music
SERIES_PATH=/caminho/absoluto/para/tv
MOVIES_PATH=/caminho/absoluto/para/movies

# ── Ollama ────────────────────────────────────────────────────────────────────
OLLAMA_URL=http://localhost:11434
OLLAMA_DEFAULT_MODEL=gemma4-256k:latest

# ── MusicSage ─────────────────────────────────────────────────────────────────
MUSICSAGE_PORT=3002
PLEX_MEDIA_PATH=/media             # raiz de mídia dentro do container
LASTFM_API_KEY=                    # recomendado — chave gratuita em last.fm/api
```

### 2. Suba os containers

```bash
docker compose up -d               # Plex + Sage + Ollama
docker compose up -d musicsage     # apenas o Sage
docker compose ps                  # verifica status
```

### 3. Acesse o Dashboard

```
http://localhost:3002
```

---

## Setup — NAS (ZimaOS / CasaOS)

### 1. Suba o Jackett + FlareSolverr

O FlareSolverr é necessário para indexers com proteção Cloudflare. Eles rodam no mesmo compose:

```yaml
# jackett/docker-compose.yml
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
      - "8191:8191"

  jackett:
    image: lscr.io/linuxserver/jackett:latest
    container_name: jackett
    restart: unless-stopped
    depends_on:
      flaresolverr:
        condition: service_started
    environment:
      - AUTO_UPDATE=true
      - PUID=1000
      - PGID=1000
      - TZ=America/Sao_Paulo
    ports:
      - "9117:9117"
    volumes:
      - /DATA/AppData/flaresolverr/config:/config
```

Após subir, acesse `http://<IP-DO-NAS>:9117` → `Jackett Configuration` → FlareSolverr API URL:
```
http://flaresolverr:8191
```

Copie também a **Jackett API Key** exibida na mesma página — você vai precisar dela.

---

### 2. Suba o Plex (se ainda não tiver)

```yaml
services:
  plex:
    image: lscr.io/linuxserver/plex:latest
    container_name: plex
    restart: unless-stopped
    network_mode: host
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/Sao_Paulo
      - VERSION=docker
      - PLEX_CLAIM=claim-xxxxxxxxxxxx   # plex.tv/claim — válido 4 min, só 1ª vez
    volumes:
      - /DATA/AppData/plex/config:/config
      - /media/plex:/media
```

Após subir, acesse `http://<IP-DO-NAS>:32400/web` e adicione as bibliotecas:
- **Música** → `/media/music`
- **Filmes** → `/media/movies`
- **Séries** → `/media/series`

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
      # ── Plex ─────────────────────────────────────────────────────────────────
      - PLEX_URL=http://192.168.1.10:32400

      # Raiz da mídia dentro do container
      - PLEX_MEDIA_PATH=/media

      # Pasta de config do Plex — para extrair PLEX_TOKEN automaticamente
      # Remova se preferir passar PLEX_TOKEN diretamente
      - PLEX_CONFIG_DIR=/plex-config

      # Descomente se não usar PLEX_CONFIG_DIR
      # - PLEX_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx

      # ── Ollama ───────────────────────────────────────────────────────────────
      - OLLAMA_URL=http://192.168.1.10:11434
      - OLLAMA_DEFAULT_MODEL=gemma4-256k:latest
      - EMBEDDING_MODEL=nomic-embed-text

      # ── Jackett ──────────────────────────────────────────────────────────────
      - JACKETT_URL=http://192.168.1.10:9117
      # API key lida automaticamente de /jackett-config/ServerConfig.json
      # Descomente se preferir passar diretamente
      # - JACKETT_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxx

      # ── Last.fm (fortemente recomendado) ─────────────────────────────────────
      # Sem isso, recomendações usam LLM livre e podem conter artistas fictícios
      # Chave gratuita: https://www.last.fm/api/account/create
      - LASTFM_API_KEY=

    volumes:
      # Mídia do Plex (o Sage lê e o Transporter escreve aqui)
      - /media/plex:/media

      # Config do Plex — para extração automática do PLEX_TOKEN
      # Remova se usar PLEX_TOKEN nas env vars acima
      - /DATA/AppData/plex/config:/plex-config:ro

      # Dados persistentes: cache de análises, embeddings, playlists, logs
      # NUNCA apague — embeddings levam horas para regenerar
      - /DATA/sage/data:/data

      # Downloads do Stormbringer e TideCaller
      - /DATA/sage/downloads:/downloads

      # Config do Jackett — para leitura automática da API Key
      # Remova se usar JACKETT_API_KEY nas env vars acima
      - /DATA/AppData/flaresolverr/config:/jackett-config:ro

    privileged: true
    deploy:
      resources:
        limits:
          memory: 16508243968   # 16 GB — ajuste conforme disponível
```

---

## Volumes explicados

| Volume (host → container) | Descrição |
|---|---|
| `<mídia> → /media` | Toda a biblioteca de mídia. O Sage acessa `/media/music`, `/media/movies`, `/media/tv`. O Transporter move downloads concluídos para cá. |
| `<plex-config> → /plex-config` | Contém `Preferences.xml` com o `PLEX_TOKEN`. O entrypoint extrai o token automaticamente. Opcional se você passar `PLEX_TOKEN` diretamente. |
| `<sage-data> → /data` | Cache de análises de faixas, embeddings vetoriais, playlists e logs. **Crítico — nunca apague.** |
| `<downloads> → /downloads` | Destino dos downloads. Subpastas criadas automaticamente: `stormbringer/musicas`, `stormbringer/filmes`, `stormbringer/series`, `tidecaller`. |
| `<jackett-config> → /jackett-config` | Config do Jackett. O Sage lê a API Key do `ServerConfig.json` automaticamente. Opcional se você passar `JACKETT_API_KEY` diretamente. |

---

## Autenticação do Tidal (primeira vez)

O token OAuth do Tidal é salvo em `/agents/TideCaller/config/.config` dentro do container. Para persistir entre recriações do container, adicione o volume:

```yaml
volumes:
  - tidal-config:/agents/TideCaller/config
```

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

---

## Acessando o Sage

```
http://<IP>:3002           # Dashboard
http://<IP>:3002/api/health  # health check
```
