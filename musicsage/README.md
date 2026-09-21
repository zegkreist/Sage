# MusicSage — Docker

Dashboard de músicas para Plex com análise de IA, downloads (Stormbringer) e integração Tidal (TideCaller).

---

## Início rápido

```bash
# 1. Copie o arquivo de variáveis de exemplo
cp musicsage/.env.example musicsage/.env
# edite conforme necessário

# 2. Suba o container
docker compose -f musicsage/docker-compose.yml up -d
```

Ou com `docker run` diretamente:

```bash
docker run -d \
  --name musicsage \
  --restart unless-stopped \
  -p 3002:3002 \
  --env-file musicsage/.env \
  -v /mnt/nas/musicsage-data:/data \
  -v /mnt/nas/media:/media:ro \
  -v /mnt/nas/downloads:/downloads \
  seu-usuario/musicsage:latest
```

---

## Buildando a imagem

O contexto de build deve ser a pasta `plex_server/` (raiz do monorepo):

```bash
cd plex_server/

# Build local:
docker build -f musicsage/Dockerfile -t musicsage:latest .

# Build + push para o DockerHub:
./musicsage/build-and-push.sh --user seu-usuario --tag v1.0.0
```

---

## Variáveis de ambiente

### Plex

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `PLEX_URL` | ✓ | `http://localhost:32400` | URL base do servidor Plex |
| `PLEX_TOKEN` | ✓ | — | Token de autenticação Plex (X-Plex-Token) |
| `PLEX_MEDIA_PATH` | — | `/media` | Raiz local onde toda a mídia está montada. Paths do Plex (`/music/...`, `/movies/...`) são concatenados diretamente. |

### Ollama / IA

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `OLLAMA_URL` | — | `http://localhost:11434` | URL do servidor Ollama |
| `OLLAMA_DEFAULT_MODEL` | — | `gemma4-256k:latest` | Modelo LLM para análise e chat |
| `EMBEDDING_MODEL` | — | `nomic-embed-text` | Modelo para geração de embeddings |

### Persistência

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `DATA_DIR` | — | `/data` | Diretório raiz de dados persistentes |
| `LOG_DIR` | — | `/data/logs` | Diretório de logs |

### Agents

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `STORMBRINGER_DIR` | — | `/agents/Stormbringer` | Localização do agent Stormbringer (já embarcado na imagem) |
| `TIDECALLER_DIR` | — | `/agents/TideCaller` | Localização do agent TideCaller (já embarcado na imagem) |
| `TRANSPORTER_DIR` | — | `/agents/Transporter` | Localização do agent Transporter (já embarcado na imagem) |

### Integrações opcionais

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `LASTFM_API_KEY` | — | — | API Key do Last.fm para metadados|
| `MUSICSAGE_PORT` | — | `3002` | Porta do servidor HTTP |
| `NODE_ENV` | — | `production` | Ambiente Node.js |

---

## Volumes

| Ponto de montagem | Obrigatório | Descrição |
|---|---|---|
| `/data` | ✓ | Cache de análises, embeddings vetoriais, playlists geradas, logs. **Deve persistir entre restarts.** |
| `/media` | ✓ | Raiz de mídia. Subpastas: `music/`, `movies/`, `series/`. Recomendado montar como **read-only** (`:ro`). |
| `/downloads` | — | Pasta de downloads dos agents. Veja subdiretórios abaixo. |

### Subdiretórios de `/downloads`

| Caminho | Agent | Conteúdo |
|---|---|---|
| `/downloads/stormbringer/musicas` | Stormbringer | Músicas baixadas |
| `/downloads/stormbringer/filmes` | Stormbringer | Filmes baixados |
| `/downloads/stormbringer/series` | Stormbringer | Séries baixadas |
| `/downloads/tidecaller` | TideCaller | Downloads do Tidal |

> **Dica:** Monte `/downloads` num disco com espaço generoso. Em NAS Synology/QNAP, uma pasta dedicada em `/volume1/downloads` é suficiente.

### Subdiretórios de `/data`

| Caminho | Conteúdo |
|---|---|
| `/data/hermes` | Canal de controle em markdown (veja abaixo) |
| `/data/logs` | Logs diários (`musicsage-YYYY-MM-DD.log`) |
| `/data/playlists` | Playlists geradas |
| `/data/embeddings` | Vetores de embedding |
| `/data/stormbringer` | Estado dos torrents e trackers |

---

## Canal de controle para agentes (`/data/hermes`)

`/data` é um bind mount, então qualquer agente com acesso à pasta de deploy
(no host: `./musicsage/data/hermes/`) controla o Sage **por arquivos markdown**,
sem precisar chamar a API.

| Arquivo | Quem escreve | Permissão | Para quê |
|---|---|---|---|
| `README.md` | Sage | 0644 | Contrato completo, regerado a cada boot |
| `requests.md` | **o agente** | **0666** | Fila de pedidos de download |
| `done.md` | Sage | 0644 | Histórico append-only do que concluiu |
| `status.md` | Sage | 0644 | Biblioteca, fila e erros — reescrito a cada 2 min |

> **Permissões:** o container roda como root, então tudo que ele cria sai
> `root:root 0644` no bind mount e um agente rodando como outro usuário não
> conseguiria escrever. O Sage força `0777` na pasta e `0666` no `requests.md`
> a cada boot — e **preserva** essa permissão ao reescrever o arquivo, já que o
> `rename` da escrita atômica troca o inode e devolveria `0644` na primeira
> conclusão. A pasta precisa ser gravável, e não só o arquivo, porque gravar por
> tmp+rename exige permissão no diretório.

O agente adiciona linhas em `requests.md`:

```markdown
- [ ] Radiohead — Creep
- [ ] Miles Davis — So What #track
- [ ] Pink Floyd — Animals #torrent
- [ ] https://tidal.com/browse/track/12345678
```

Os pendentes aparecem no card **"Pedidos do Hermes"** na aba Downloads. Um
humano dispara cada um — a busca já vem preenchida — porque escolher entre
versões de um torrent (FLAC vs 320, remaster, edição) precisa de julgamento.
Quando o download conclui, o Sage **remove a linha** de `requests.md` e registra
em `done.md`.

**Origem padrão: Tidal** — cobre faixa e álbum, é lossless e não tem
ambiguidade de versão. O torrent é o fallback e precisa ser pedido com
`#torrent`. Tags aceitas no fim da linha (`#tag` ou `(tag)`): `#track`,
`#album`, `#tidal`, `#torrent`.

Cada pedido expõe os dois botões (🌊 Tidal / ⚡ Torrent) e mostra **por que**
caiu na rota sugerida — a mesma explicação vai para o log, em `[HERMES]`. O
contrato completo, com os limites conhecidos, está no `README.md` gerado dentro
da pasta.

### Rotas

| Rota | Efeito |
|---|---|
| `GET /api/hermes/inbox` | Pedidos pendentes |
| `POST /api/hermes/inbox/:id/resolve` | Conclui (`done`) ou dispensa (`skipped`) um pedido |
| `POST /api/hermes/status` | Reescreve `status.md` agora |

---

## docker-compose.yml de exemplo

```yaml
services:
  musicsage:
    image: seu-usuario/musicsage:latest
    container_name: musicsage
    restart: unless-stopped
    ports:
      - "3002:3002"
    environment:
      PLEX_URL: "http://192.168.1.100:32400"
      PLEX_TOKEN: "seu-token-aqui"
      PLEX_MEDIA_PATH: /media
      OLLAMA_URL: "http://192.168.1.100:11434"
      OLLAMA_DEFAULT_MODEL: gemma4-256k:latest
      EMBEDDING_MODEL: nomic-embed-text
      LASTFM_API_KEY: "opcional"
    volumes:
      - musicsage-data:/data
      - /mnt/nas/media:/media:ro
      - musicsage-downloads:/downloads

volumes:
  musicsage-data:
  musicsage-downloads:
```

---

## Motor de recomendações

### Como funciona

O `RecommendationEngine` combina três fontes de dados para gerar recomendações precisas e sem alucinações:

**1. Pool de candidatos reais (Last.fm)**
Quando `LASTFM_API_KEY` está configurado, o sistema busca artistas similares aos 5 favoritos do usuário em paralelo via Last.fm. O Ollama recebe a lista real e apenas *seleciona e explica* — não gera nomes livremente. Artistas inventados pelo LLM são descartados automaticamente.

Sem Last.fm, o sistema usa geração livre com instruções restritivas ("só artistas com discografia verificável").

**2. Perfil ponderado por escuta real**
- Artistas e faixas mais tocados têm peso proporcional ao `playCount` no perfil enviado ao LLM
- Faixas ouvidas nos últimos 90 dias recebem peso 1.5× (sinal de mood atual)
- O perfil reflete o que o usuário *realmente ouve*, não o que tem na biblioteca

**3. Análise sonora das faixas mais tocadas**
As faixas mais tocadas são cruzadas com o `analysis-cache` pelo `ratingKey`. O prompt do LLM recebe os atributos sonoros reais de cada faixa:
```
1. "Black Dog" — Led Zeppelin (47× ★recent): Hard Rock/Blues Rock, energy=9, mood=aggressive, BPM~148, timbre="distorted electric guitar" [rebellious, intense, driving]
```
Isso permite recomendações baseadas em som real, não apenas em nome de artista.

### Importância do Last.fm

`LASTFM_API_KEY` é **fortemente recomendado** — sem ele, o sistema recorre a geração livre de nomes pelo LLM, que pode sugerir artistas que não existem. Com Last.fm, todas as recomendações vêm de artistas verificados.

Obtenha sua chave gratuita em: https://www.last.fm/api/account/create

---

## Agents embarcados

Todos os agents estão **dentro da imagem** — não é necessário montar volumes extras para eles.

| Agent | Tipo | Localização na imagem | Função |
|---|---|---|---|
| **AllFather** | Node.js | `/agents/AllFather` | Orquestrador central de agentes |
| **Stormbringer** | Node.js | `/agents/Stormbringer` | Downloads (músicas, filmes, séries) |
| **TideCaller** | Python 3 | `/agents/TideCaller` | Busca e download no Tidal |
| **Transporter** | Node.js | `/agents/Transporter` | Transferência e organização de arquivos |

### Autenticação do Tidal (TideCaller)

Na primeira execução, o TideCaller precisará autenticar com o Tidal. O token OAuth é salvo em `/agents/TideCaller/config/.config`. Para persistir a autenticação entre recriações do container, monte a pasta de config:

```bash
-v tidal-config:/agents/TideCaller/config
```

Ou via `docker-compose.yml`:

```yaml
volumes:
  - tidal-config:/agents/TideCaller/config
```

---

## Health check

A imagem inclui health check automático:

```
GET http://localhost:3002/api/health
```

---

## Exemplo completo — NAS Synology

```bash
docker run -d \
  --name musicsage \
  --restart unless-stopped \
  -p 3002:3002 \
  -e PLEX_URL="http://192.168.1.100:32400" \
  -e PLEX_TOKEN="xxxxxxxxxxxxxxxxxx" \
  -e PLEX_MEDIA_PATH="/media" \
  -e OLLAMA_URL="http://192.168.1.100:11434" \
  -e OLLAMA_DEFAULT_MODEL="gemma4-256k:latest" \
  -e EMBEDDING_MODEL="nomic-embed-text" \
  -v /volume1/docker/musicsage/data:/data \
  -v /volume1/media:/media:ro \
  -v /volume1/downloads/musicsage:/downloads \
  seu-usuario/musicsage:latest
```
