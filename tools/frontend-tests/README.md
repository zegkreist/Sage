# Toolkit de testes de frontend — MusicSage (Sage)

Testes de contrato da API REST usada pela SPA Svelte (MusicSage), rodando contra
o app real em `http://192.168.15.14:3002`.

Sem dependências externas — usa `fetch` nativo (Node ≥ 18).

## Como rodar

```bash
node tools/frontend-tests/contract-tests.js
```

Variáveis de ambiente opcionais:

| Variável   | Padrão                      | Descrição               |
|------------|-----------------------------|-------------------------|
| `BASE_URL` | `http://192.168.15.14:3002` | Base do app MusicSage   |
| `TIMEOUT_MS` | `15000`                   | Timeout por requisição  |

Exemplo apontando para instância local:

```bash
BASE_URL=http://localhost:3002 node tools/frontend-tests/contract-tests.js
```

## O que é validado

Endpoints testados (rotas verificadas em `musicsage/src/routes/`):

- `GET /api/health` — status ok
- `GET /api/library/stats` — totalArtists/totalAlbums/totalTracks/topGenres/totalPlaylists
- `GET /api/library/users` — lista de contas Plex
- `GET /api/playlists` e `GET /api/playlists/:id` (incluindo 404)
- `GET /api/favorites`
- `GET /api/library/metrics`
- `GET /api/logs/files`
- 404 para rota inexistente

Saída: uma linha `PASS`/`FAIL` por assert + resumo final. Exit code `0` se
tudo passar, `1` em falha de contrato, `2` se o app estiver inalcançável.

## Notas

- Testes são **somente leitura** (nenhum POST/PATCH/DELETE), seguros contra produção.
- Rotas nomes conferidos no código-fonte em `musicsage/src/routes/*.js`.
