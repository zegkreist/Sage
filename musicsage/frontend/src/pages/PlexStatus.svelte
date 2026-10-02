<script>
  import { onMount } from 'svelte';
  import { api } from '$lib/api.js';
  import { toast } from '$lib/stores/toast.js';
  import Button from '../components/ui/Button.svelte';
  import Card from '../components/ui/Card.svelte';
  import Spinner from '../components/ui/Spinner.svelte';

  let status     = $state(null);   // resultado de GET /api/plex/status
  let loading    = $state(true);
  let reloading  = $state(false);

  let fetchError = $state(null);

  // ─── Saúde dos Serviços (F8) ──────────────────────────────────────────────
  let health = $state([]);

  const HEALTH_TARGETS = [
    { name: 'API MusicSage',   desc: 'Servidor backend',               path: '/health' },
    { name: 'TideCaller',      desc: 'Token Tidal',                    path: '/tools/tidecaller/token/check' },
    { name: 'Letras',          desc: 'Cobertura da biblioteca',        path: '/lyrics/stats' },
    { name: 'Servidor de Mídia', desc: 'Conectividade (Plex/provider)', path: '/plex/status' },
  ];

  async function checkHealth() {
    health = HEALTH_TARGETS.map(t => ({ ...t, state: 'checking', detail: 'Verificando…' }));
    await Promise.all(HEALTH_TARGETS.map(async (t, i) => {
      try {
        const r = await api('GET', t.path);
        let state = 'green', detail = 'OK';
        if (t.path === '/tools/tidecaller/token/check') {
          state = r.valid ? 'green' : 'red';
          detail = r.valid ? 'Token válido' : (r.message || 'Token inválido');
        } else if (t.path === '/lyrics/stats') {
          state = 'green';
          detail = `${r.withLyrics ?? 0}/${r.total ?? 0} com letras`;
        } else if (t.path === '/plex/status') {
          state = r.valid ? 'green' : 'red';
          detail = r.valid ? `Conectado (${r.type ?? 'plex'})` : (r.error || 'Falha na conexão');
        } else if (r.status !== 'ok') {
          state = 'yellow';
          detail = `status: ${r.status}`;
        }
        health[i] = { ...health[i], state, detail };
      } catch (e) {
        // 503 = dependência indisponível (amarelo); resto = vermelho
        health[i] = { ...health[i], state: /503|unavailable|não disponível/i.test(e.message) ? 'yellow' : 'red', detail: e.message };
      }
    }));
  }

  const HEALTH_STYLE = {
    green:    { color: '#1db954', bg: '#1db95418', icon: '✓', label: 'Operacional' },
    yellow:   { color: 'var(--warn)',    bg: '#f59e0b18', icon: '!', label: 'Instável' },
    red:      { color: 'var(--danger)',  bg: '#ef444418', icon: '✕', label: 'Indisponível' },
    checking: { color: 'var(--muted)',   bg: '#5a5a7818', icon: '…', label: 'Verificando' },
  };

  onMount(() => {
    console.log('[PlexStatus] onMount — chamando checkStatus()');
    checkStatus();
    checkHealth();
  });

  async function checkStatus() {
    loading = true;
    fetchError = null;
    console.log('[PlexStatus] checkStatus() iniciado');
    try {
      const data = await api('GET', '/plex/status');
      console.log('[PlexStatus] resposta recebida:', data);
      status = data;
    } catch (e) {
      console.error('[PlexStatus] erro na chamada:', e);
      fetchError = e.message;
      toast.error(`Erro ao verificar Plex: ${e.message}`);
    } finally {
      loading = false;
      console.log('[PlexStatus] checkStatus() finalizado — loading=false, status=', status);
    }
  }

  async function reloadToken() {
    reloading = true;
    try {
      const result = await api('POST', '/plex/reload-token');
      if (result.valid) {
        toast.success('Token recarregado com sucesso!');
      } else {
        toast.error(`Token recarregado porém inválido: ${result.error}`);
      }
      // Atualiza o painel com os dados retornados
      status = {
        url:          status?.url,
        tokenPresent: true,
        tokenMasked:  result.tokenMasked,
        valid:        result.valid,
        serverInfo:   result.serverInfo,
        error:        result.error,
      };
    } catch (e) {
      toast.error(e.message);
    } finally {
      reloading = false;
    }
  }

  let remapping   = $state(false);
  let remapResult = $state(null);

  async function remapCacheIds() {
    remapping   = true;
    remapResult = null;
    try {
      const r = await api('POST', '/audio/analysis-cache/remap-ids');
      remapResult = r;
      if (r.remapped > 0) {
        toast.success(`${r.remapped} IDs corrigidos no cache!`);
      } else {
        toast.success('Cache já está sincronizado — nenhum ID precisou ser corrigido.');
      }
    } catch (e) {
      toast.error(`Erro ao corrigir IDs: ${e.message}`);
    } finally {
      remapping = false;
    }
  }
</script>

<div class="p-6 space-y-6 w-full">

  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold text-white tracking-tight">Conexão com o Plex</h1>
      <p class="text-xs text-muted mt-0.5">Diagnóstico e recarregamento de credenciais</p>
    </div>
    <div class="flex gap-2">
      <Button variant="secondary" size="sm" onclick={checkStatus} disabled={loading}>
        {#if loading}<Spinner size="xs" />{/if}
        Verificar Conexão
      </Button>
      <Button variant="secondary" size="sm" onclick={remapCacheIds} disabled={remapping}>
        {#if remapping}<Spinner size="xs" />{/if}
        🔧 Corrigir IDs do Cache
      </Button>
      <Button variant="accent" size="sm" onclick={reloadToken} disabled={reloading}>
        {#if reloading}<Spinner size="xs" />{/if}
        Recarregar Token
      </Button>
    </div>
  </div>

  <!-- ── Saúde dos Serviços (F8) ───────────────────────────────────────── -->
  <section>
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-sm font-semibold text-white tracking-tight">Saúde dos Serviços</h2>
      <Button variant="secondary" size="sm" onclick={checkHealth}>
        Verificar
      </Button>
    </div>
    <div class="grid grid-cols-1 gap-3" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr))">
      {#each health as h (h.path)}
        {@const st = HEALTH_STYLE[h.state] ?? HEALTH_STYLE.checking}
        <div class="rounded-xl p-4 flex items-start gap-3" style="background:var(--surface2); border:1px solid var(--border);">
          <div
            class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
            style="background:{st.bg}; color:{st.color};"
            aria-label={st.label}
          >{st.icon}</div>
          <div class="min-w-0">
            <div class="text-xs font-semibold text-white truncate">{h.name}</div>
            <div class="text-2xs text-muted mt-0.5">{h.desc}</div>
            <div class="text-2xs mt-1.5 font-medium truncate" style="color:{st.color}" title={h.detail}>
              {h.detail}
            </div>
          </div>
        </div>
      {/each}
    </div>
  </section>

  {#if loading && !status}
    <div class="flex items-center justify-center py-16 flex-col gap-3">
      <Spinner size="lg" />
      <p class="text-xs text-muted">Verificando conexão com o Plex...</p>
    </div>

  {:else if fetchError && !status}
    <div class="px-4 py-5 rounded-xl text-sm" style="background:#1f0d0d; border:1px solid #4a1a1a;">
      <div class="font-semibold" style="color:var(--danger)">Erro ao carregar</div>
      <div class="text-muted text-xs mt-1">{fetchError}</div>
      <div class="mt-3">
        <Button variant="danger" size="sm" onclick={checkStatus}>Tentar novamente</Button>
      </div>
    </div>

  {:else if status}

    <!-- Status banner -->
    <div
      class="flex items-center gap-4 px-5 py-4 rounded-xl border"
      style="{status.valid
        ? 'background:#0d2918; border-color:#1a4a2e;'
        : 'background:#1f0d0d; border-color:#4a1a1a;'}"
    >
      <!-- Indicador -->
      <div
        class="w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0"
        style="{status.valid ? 'background:#1db95422;' : 'background:var(--danger)22;'}"
      >
        {status.valid ? '✓' : '✕'}
      </div>
      <div class="flex-1 min-w-0">
        <div class="font-semibold text-sm" style="color:{status.valid ? '#1db954' : 'var(--danger)'}">
          {status.valid ? 'Conexão estabelecida' : 'Falha na conexão'}
        </div>
        <div class="text-xs text-muted mt-0.5 truncate">
          {status.valid
            ? `Servidor "${status.serverInfo?.name}" respondendo em ${status.url}`
            : (status.error ?? 'Erro desconhecido')}
        </div>
      </div>
      <!-- Badge de token -->
      <div
        class="shrink-0 px-3 py-1 rounded-full text-2xs font-medium"
        style="{status.tokenPresent
          ? 'background:#1db95418; color:#1db954; border:1px solid #1db95430;'
          : 'background:var(--danger)18; color:var(--danger); border:1px solid var(--danger)30;'}"
      >
        {status.tokenPresent ? 'Token presente' : 'Sem token'}
      </div>
    </div>

    <!-- Detalhes -->
    <div class="grid grid-cols-1 gap-4" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))">

      <!-- Configuração atual -->
      <Card title="Configuração">
        <div class="space-y-3">
          {@render InfoRow('URL do Plex', status.url, true)}
          {@render InfoRow('Token', status.tokenMasked, true)}
          {@render InfoRow('Token válido', status.valid ? 'Sim' : 'Não', false, status.valid ? '#1db954' : 'var(--danger)')}
        </div>
      </Card>

      <!-- Informações do servidor (só se conectado) -->
      {#if status.valid && status.serverInfo}
        <Card title="Servidor Plex">
          <div class="space-y-3">
            {@render InfoRow('Nome', status.serverInfo.name)}
            {@render InfoRow('Versão', status.serverInfo.version, true)}
            {@render InfoRow('Platform', [status.serverInfo.platform, status.serverInfo.platformVersion].filter(Boolean).join(' '))}
            {@render InfoRow('Machine ID', status.serverInfo.machineIdentifier, true, null, true)}
          </div>
        </Card>
      {/if}

    </div>

    <!-- Dica quando sem PLEX_CONFIG_DIR -->
    {#if !status.valid || !status.tokenPresent}
      <div class="px-4 py-3 rounded-lg text-xs text-muted" style="background:#111118; border:1px solid var(--border);">
        <span class="text-soft font-medium">Dica: </span>
        O botão <strong>Recarregar Token</strong> relê o token diretamente do arquivo
        <code class="text-accent">Preferences.xml</code> do Plex (requer
        <code class="text-accent">PLEX_CONFIG_DIR</code> definido).
        Se estiver rodando fora do Docker, defina <code class="text-accent">PLEX_TOKEN</code> no
        arquivo <code class="text-accent">.env</code>.
      </div>
    {/if}

    <!-- Resultado do remap de IDs -->
    {#if remapResult}
      <div class="px-4 py-3 rounded-xl border text-sm space-y-1" style="background:#111118; border-color:#1e1e2e;">
        <div class="font-semibold text-white mb-2">Resultado da correção de IDs</div>
        <div class="grid grid-cols-3 gap-3 text-center">
          <div class="rounded-lg py-2" style="background:var(--surface2)">
            <div class="text-lg font-bold" style="color:#1db954">{remapResult.remapped}</div>
            <div class="text-2xs text-muted">Corrigidos</div>
          </div>
          <div class="rounded-lg py-2" style="background:var(--surface2)">
            <div class="text-lg font-bold" style="color:var(--accent-hi)">{remapResult.unchanged}</div>
            <div class="text-2xs text-muted">Inalterados</div>
          </div>
          <div class="rounded-lg py-2" style="background:var(--surface2)">
            <div class="text-lg font-bold" style="color:var(--warn)">{remapResult.notFound}</div>
            <div class="text-2xs text-muted">Deletados</div>
          </div>
        </div>
        {#if remapResult.details?.filter(d => d.status === 'remapped').length > 0}
          <details class="mt-2">
            <summary class="text-2xs text-muted cursor-pointer">Ver faixas corrigidas</summary>
            <div class="mt-2 space-y-1 max-h-48 overflow-y-auto">
              {#each remapResult.details.filter(d => d.status === 'remapped') as d}
                <div class="text-2xs px-2 py-1 rounded" style="background:var(--surface)">
                  <span class="text-white">{d.title}</span>
                  <span class="text-muted ml-1">— {d.artist}</span>
                  <span class="ml-1 font-mono" style="color:#5a5a78">{d.oldKey} → {d.newKey}</span>
                </div>
              {/each}
            </div>
          </details>
        {/if}
        {#if remapResult.details?.filter(d => d.status === 'deleted').length > 0}
          <details class="mt-1">
            <summary class="text-2xs text-muted cursor-pointer">Ver faixas deletadas do cache</summary>
            <div class="mt-2 space-y-1 max-h-48 overflow-y-auto">
              {#each remapResult.details.filter(d => d.status === 'deleted') as d}
                <div class="text-2xs px-2 py-1 rounded" style="background:var(--surface)">
                  <span class="text-white">{d.title}</span>
                  <span class="text-muted ml-1">— {d.artist}</span>
                  <span class="ml-1 font-mono" style="color:var(--warn)">{d.oldKey}</span>
                </div>
              {/each}
            </div>
          </details>
        {/if}
      </div>
    {/if}

  {/if}
</div>

<!-- ── Helper snippet ─────────────────────────────────── -->
{#snippet InfoRow(label, value, mono = false, color = null, truncate = false)}
  <div class="flex items-start justify-between gap-3 text-xs">
    <span class="text-muted shrink-0">{label}</span>
    <span
      class="text-right font-medium {mono ? 'font-mono' : ''} {truncate ? 'truncate max-w-[160px]' : ''}"
      style="{color ? `color:${color}` : 'color:#c9c9e0'}"
      title={truncate ? value : undefined}
    >{value ?? '—'}</span>
  </div>
{/snippet}
