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

  onMount(() => { checkStatus(); });

  async function checkStatus() {
    loading = true;
    try {
      status = await api('GET', '/plex/status');
    } catch (e) {
      toast.error(`Erro ao verificar Plex: ${e.message}`);
    } finally {
      loading = false;
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
      <Button variant="accent" size="sm" onclick={reloadToken} disabled={reloading}>
        {#if reloading}<Spinner size="xs" />{/if}
        Recarregar Token
      </Button>
    </div>
  </div>

  {#if loading && !status}
    <div class="flex items-center justify-center py-16">
      <Spinner size="lg" />
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
        style="{status.valid ? 'background:#1db95422;' : 'background:#f8717122;'}"
      >
        {status.valid ? '✓' : '✕'}
      </div>
      <div class="flex-1 min-w-0">
        <div class="font-semibold text-sm" style="color:{status.valid ? '#1db954' : '#f87171'}">
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
          : 'background:#f8717118; color:#f87171; border:1px solid #f8717130;'}"
      >
        {status.tokenPresent ? 'Token presente' : 'Sem token'}
      </div>
    </div>

    <!-- Detalhes -->
    <div class="grid grid-cols-1 gap-4" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))">

      <!-- Configuração atual -->
      <Card title="Configuração">
        <div class="space-y-3">
          <Row label="URL do Plex" value={status.url} mono />
          <Row label="Token" value={status.tokenMasked} mono />
          <Row
            label="Token válido"
            value={status.valid ? 'Sim' : 'Não'}
            color={status.valid ? '#1db954' : '#f87171'}
          />
        </div>
      </Card>

      <!-- Informações do servidor (só se conectado) -->
      {#if status.valid && status.serverInfo}
        <Card title="Servidor Plex">
          <div class="space-y-3">
            <Row label="Nome"     value={status.serverInfo.name} />
            <Row label="Versão"   value={status.serverInfo.version} mono />
            <Row label="Platform" value={[status.serverInfo.platform, status.serverInfo.platformVersion].filter(Boolean).join(' ')} />
            <Row label="Machine ID" value={status.serverInfo.machineIdentifier} mono truncate />
          </div>
        </Card>
      {/if}

    </div>

    <!-- Dica quando sem PLEX_CONFIG_DIR -->
    {#if !status.valid || !status.tokenPresent}
      <div class="px-4 py-3 rounded-lg text-xs text-muted" style="background:#111118; border:1px solid #1a1a28;">
        <span class="text-soft font-medium">Dica: </span>
        O botão <strong>Recarregar Token</strong> relê o token diretamente do arquivo
        <code class="text-accent">Preferences.xml</code> do Plex (requer
        <code class="text-accent">PLEX_CONFIG_DIR</code> definido).
        Se estiver rodando fora do Docker, defina <code class="text-accent">PLEX_TOKEN</code> no
        arquivo <code class="text-accent">.env</code>.
      </div>
    {/if}

  {/if}
</div>

<!-- ── Helper component ─────────────────────────────────── -->
{#snippet Row({ label, value, mono = false, color = null, truncate = false })}
  <div class="flex items-start justify-between gap-3 text-xs">
    <span class="text-muted shrink-0">{label}</span>
    <span
      class="text-right font-medium {mono ? 'font-mono' : ''} {truncate ? 'truncate max-w-[160px]' : ''}"
      style="{color ? `color:${color}` : 'color:#c9c9e0'}"
      title={truncate ? value : undefined}
    >{value ?? '—'}</span>
  </div>
{/snippet}
