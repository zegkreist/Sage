<script>
  /**
   * ShareStoryModal
   * Gera cards 1080×1920 (Instagram Stories) para:
   *   • Top 10 Artistas
   *   • Top 10 Faixas
   *   • Curiosidades (estilo Spotify Wrapped)
   */
  let {
    show         = $bindable(false),
    artists      = [],
    tracks       = [],
    curiosidades = [],
    summary      = null,
    period       = 'month',
    initTab      = 'artists',
  } = $props();

  const CARD_W        = 1080;
  const CARD_H        = 1920;
  const PREVIEW_SCALE = 1 / 3;
  const PREVIEW_W     = Math.round(CARD_W * PREVIEW_SCALE);
  const PREVIEW_H     = Math.round(CARD_H * PREVIEW_SCALE);

  const PERIOD_LABEL = { week: '7 dias', month: '30 dias', year: '12 meses' };
  const RANK_BG = ['#FFD700','#C0C0C0','#CD7F32','#252538','#252538','#252538','#1e1e2e','#1e1e2e','#1e1e2e','#1e1e2e'];
  const RANK_FG = ['#0a0a0f','#0a0a0f','#ffffff','#9999bb','#9999bb','#9999bb','#5a5a78','#5a5a78','#5a5a78','#5a5a78'];

  let tab     = $state(initTab);
  let canvas  = $state(null);

  // plain vars — NOT $state, para não disparar reatividade dentro de funções async
  let drawing      = false;
  let renderToken  = 0;
  let renderTimer  = null;

  $effect(() => {
    const _show = show;
    const _tab  = tab;
    const _canvas = canvas;
    // Agenda fora do ciclo reativo para não bloquear o Svelte
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      if (_show && _canvas) scheduleRender(_tab);
    }, 0);
  });

  function scheduleRender(currentTab) {
    const token = ++renderToken;
    if (drawing) return;   // já tem render em curso — o token garante que o próximo rode
    runRender(currentTab, token);
  }

  // Carrega imagem com timeout de 3s — previne Promise pendurada que trava a event loop
  function loadImg(src) {
    return new Promise(resolve => {
      const img = new Image();
      const timer = setTimeout(() => resolve(null), 3000);
      img.onload  = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = src;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }

  function shortFmt(n) {
    if (n == null) return '?';
    if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'k';
    return String(n);
  }

  function truncate(ctx, text, maxW) {
    if (!text) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function drawBg(ctx, W, H, accent1 = '#7c6af5', accent2 = '#1db954') {
    const bgGrad = ctx.createLinearGradient(0, 0, W * 0.6, H);
    bgGrad.addColorStop(0,   '#08080f');
    bgGrad.addColorStop(0.5, '#0b0d1c');
    bgGrad.addColorStop(1,   '#070710');
    ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);
    const g1 = ctx.createRadialGradient(W, 0, 0, W, 0, 750);
    g1.addColorStop(0, accent1 + '20'); g1.addColorStop(1, 'transparent');
    ctx.fillStyle = g1; ctx.fillRect(0, 0, W, H);
    const g2 = ctx.createRadialGradient(0, H, 0, 0, H, 650);
    g2.addColorStop(0, accent2 + '12'); g2.addColorStop(1, 'transparent');
    ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
  }

  function drawLogo(ctx, cx, cy, radius) {
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#7c6af5'; ctx.fill();
    for (let r = radius * 0.62; r > radius * 0.32; r -= radius * 0.11) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(cx, cy, radius * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = '#08080f'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx + radius * 0.72, cy - radius * 0.72, radius * 0.23, 0, Math.PI * 2);
    ctx.fillStyle = '#1db954'; ctx.fill();
  }

  function drawHeader(ctx, W, label) {
    drawLogo(ctx, W / 2, 155, 70);
    ctx.textAlign = 'center';
    ctx.font = 'bold 84px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#ffffff'; ctx.fillText('MusicSage', W / 2, 298);
    ctx.font = '500 42px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#7c6af5'; ctx.fillText(label, W / 2, 358);
  }

  function drawSep(ctx, W, y, PAD) {
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y);
    const sg = ctx.createLinearGradient(PAD, 0, W - PAD, 0);
    sg.addColorStop(0, 'rgba(124,106,245,0)');
    sg.addColorStop(0.5, 'rgba(124,106,245,0.35)');
    sg.addColorStop(1, 'rgba(124,106,245,0)');
    ctx.strokeStyle = sg; ctx.lineWidth = 2; ctx.stroke();
  }

  function drawFooter(ctx, W, y) {
    ctx.textAlign = 'center';
    ctx.font = '500 33px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#2e2e48';
    ctx.fillText('◈  MusicSage  ◈', W / 2, y);
  }

  // ── Top 10 Artistas / Faixas ─────────────────────────────
  async function renderTopCard(isArtists) {
    const ctx = canvas.getContext('2d');
    const W = CARD_W, H = CARD_H, PAD = 64;
    const items = (isArtists ? artists : tracks).slice(0, 10);

    const thumbs = await Promise.allSettled(
      items.map(item => item.thumb
        ? loadImg(`/api/library/thumb?path=${encodeURIComponent(item.thumb)}`)
        : Promise.resolve(null))
    ).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

    drawBg(ctx, W, H);
    drawHeader(ctx, W, PERIOD_LABEL[period] ?? period);

    const secY = 428;
    ctx.textAlign = 'center';
    ctx.font = '800 52px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#1db954';
    ctx.fillText(isArtists ? '◈  TOP ARTISTAS' : '♪  TOP FAIXAS', W / 2, secY);
    drawSep(ctx, W, secY + 26, PAD);

    // Calcula ITEM_H dinamicamente para caber todos os itens sem corte
    const ITEM_Y0   = secY + 52;
    const FOOTER_H  = 90;
    const ITEM_GAP  = 8;
    const ITEM_H    = Math.floor((H - ITEM_Y0 - FOOTER_H) / items.length) - ITEM_GAP;
    const THUMB_S   = Math.min(88, Math.round(ITEM_H * 0.68));
    const RANK_R    = Math.round(ITEM_H * 0.22);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const ry = ITEM_Y0 + i * (ITEM_H + ITEM_GAP);
      const midY = ry + ITEM_H / 2;

      roundRect(ctx, PAD, ry, W - PAD * 2, ITEM_H, 20);
      const rg = ctx.createLinearGradient(PAD, ry, W - PAD, ry + ITEM_H);
      rg.addColorStop(0, i % 2 === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.03)');
      rg.addColorStop(1, 'rgba(255,255,255,0.015)');
      ctx.fillStyle = rg; ctx.fill();
      roundRect(ctx, PAD, ry, W - PAD * 2, ITEM_H, 20);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1; ctx.stroke();

      const rankX = PAD + 46;
      ctx.beginPath(); ctx.arc(rankX, midY, RANK_R + 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();
      ctx.beginPath(); ctx.arc(rankX, midY, RANK_R, 0, Math.PI * 2);
      ctx.fillStyle = RANK_BG[i] ?? '#1e1e2e'; ctx.fill();
      ctx.font = `bold ${i < 3 ? 32 : 27}px Inter, sans-serif`;
      ctx.fillStyle = RANK_FG[i] ?? '#5a5a78';
      ctx.textAlign = 'center'; ctx.fillText(String(i + 1), rankX, midY + 11);

      const tx = PAD + 88, ty = ry + (ITEM_H - THUMB_S) / 2;
      ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 12;
      ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 3;
      roundRect(ctx, tx, ty, THUMB_S, THUMB_S, 12);
      ctx.fillStyle = '#1e1e2e'; ctx.fill();
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      if (thumbs[i]) {
        ctx.save(); roundRect(ctx, tx, ty, THUMB_S, THUMB_S, 12); ctx.clip();
        ctx.drawImage(thumbs[i], tx, ty, THUMB_S, THUMB_S); ctx.restore();
      } else {
        ctx.font = '44px sans-serif'; ctx.fillStyle = '#2e2e48';
        ctx.textAlign = 'center';
        ctx.fillText(isArtists ? '◈' : '♪', tx + THUMB_S / 2, ty + THUMB_S / 2 + 14);
      }

      const textX = tx + THUMB_S + 22;
      const playsW = 150;
      const textMaxW = W - PAD - textX - playsW - 24;
      const name = isArtists ? (item.artist ?? item.name ?? '?') : (item.title ?? item.track ?? '?');
      const sub  = isArtists ? (item.analysisGenre ?? item.genres?.[0] ?? '') : (item.artist ?? '');

      ctx.textAlign = 'left';
      ctx.font = 'bold 44px Inter, system-ui, sans-serif'; ctx.fillStyle = '#ffffff';
      ctx.fillText(truncate(ctx, name, textMaxW), textX, midY - 6);
      if (sub) {
        ctx.font = '400 30px Inter, system-ui, sans-serif'; ctx.fillStyle = '#7777aa';
        ctx.fillText(truncate(ctx, sub, textMaxW), textX, midY + 36);
      }

      const pc = item.playCount ?? 0;
      ctx.textAlign = 'right';
      ctx.font = '800 46px Inter, system-ui, sans-serif';
      ctx.fillStyle = pc >= 50 ? '#1db954' : '#7c6af5';
      ctx.fillText(shortFmt(pc), W - PAD - 18, midY - 2);
      ctx.font = '400 26px Inter, system-ui, sans-serif'; ctx.fillStyle = '#4a4a68';
      ctx.fillText('plays', W - PAD - 18, midY + 34);
    }

    const footY = ITEM_Y0 + items.length * (ITEM_H + ITEM_GAP) + 50;
    drawSep(ctx, W, footY - 16, PAD * 2);
    drawFooter(ctx, W, footY + 42);
  }

  // Título do card de curiosidades varia com o período
  const PERIOD_TITLE = { week: '◈  SUA SEMANA EM MUSICA', month: '◈  SEU MES EM MUSICA', year: '◈  SEU ANO EM MUSICA' };

  // ── Curiosidades (Spotify Wrapped) ───────────────────────
  async function renderCuriosidadesCard() {
    const ctx = canvas.getContext('2d');
    const W = CARD_W, H = CARD_H, PAD = 72;
    drawBg(ctx, W, H, '#1db954', '#7c6af5');
    drawHeader(ctx, W, PERIOD_LABEL[period] ?? period);

    const secY = 428;
    ctx.textAlign = 'center';
    ctx.font = '800 52px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#1db954';
    ctx.fillText(PERIOD_TITLE[period] ?? '◈  EM MUSICA', W / 2, secY);
    drawSep(ctx, W, secY + 26, PAD);

    const stats = buildWrappedStats();
    let curY = secY + 80;

    // Bloco hero (1º stat)
    if (stats.length > 0) {
      curY = drawWrappedHero(ctx, W, curY, PAD, stats[0]);
      curY += 24;
    }

    // Grid 2×2 (stats 1-4)
    const midStats = stats.slice(1, 5);
    if (midStats.length > 0) {
      curY = drawWrappedGrid(ctx, W, curY, PAD, midStats);
      curY += 24;
    }

    // Rows adicionais — só desenha se ainda couber no canvas (evita alloc fora do bounds)
    const FOOTER_RESERVE = 160;
    for (const s of stats.slice(5)) {
      if (curY + 130 > H - FOOTER_RESERVE) break;
      curY = drawWrappedRow(ctx, W, curY, PAD, s);
      curY += 12;
    }

    drawSep(ctx, W, H - 100, PAD * 2);
    drawFooter(ctx, W, H - 52);
  }

  function buildWrappedStats() {
    const result = [];
    if (summary) {
      if (summary.totalPlays)
        result.push({ icon: '◆', label: 'reproduções no período', value: shortFmt(summary.totalPlays), big: true, color: '#1db954' });
      if (summary.totalHours)
        result.push({ icon: '◉', label: 'horas ouvidas', value: (+(summary.totalHours ?? 0)).toFixed(0) + 'h', color: '#7c6af5' });
      if (summary.uniqueArtists)
        result.push({ icon: '◈', label: 'artistas diferentes', value: shortFmt(summary.uniqueArtists), color: '#f59e0b' });
      if (summary.uniqueTracks)
        result.push({ icon: '♪', label: 'faixas únicas', value: shortFmt(summary.uniqueTracks), color: '#38bdf8' });
    }
    for (const f of (curiosidades ?? [])) {
      if (f.type === 'pct' || f.type === 'stat') {
        result.push({ icon: '✦', label: f.label ?? '', value: String(f.value ?? ''), sub: f.sub, color: '#1db954' });
      } else if (f.type === 'track') {
        result.push({ icon: '♫', label: f.label ?? '', value: String(f.value ?? ''), sub: f.sub, color: '#7c6af5', isTrack: true });
      } else if (f.type === 'list' && f.items?.length) {
        result.push({ icon: '≡', label: f.label ?? '', value: null, items: f.items.slice(0, 5), color: '#f59e0b', isList: true });
      } else if (f.value || f.text) {
        result.push({ icon: '✦', label: f.label ?? '', value: String(f.value ?? f.text ?? ''), sub: f.sub, color: '#38bdf8' });
      }
    }
    // Fallback se não tiver dados
    if (result.length === 0) {
      result.push({ icon: '◈', label: 'Ouça mais músicas para ver estatísticas', value: '—', color: '#5a5a78' });
    }
    return result;
  }

  function drawWrappedHero(ctx, W, y, PAD, s) {
    const BH = 310, bx = PAD, bw = W - PAD * 2;
    roundRect(ctx, bx, y, bw, BH, 32);
    const bg = ctx.createLinearGradient(bx, y, bx + bw, y + BH);
    bg.addColorStop(0, s.color + 'cc'); bg.addColorStop(1, s.color + '44');
    ctx.fillStyle = bg; ctx.fill();
    ctx.save(); roundRect(ctx, bx, y, bw, BH, 32); ctx.clip();
    ctx.beginPath(); ctx.arc(bx + bw - 80, y + 60, 180, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
    ctx.beginPath(); ctx.arc(bx + bw - 20, y + BH + 40, 220, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fill();
    ctx.restore();
    ctx.font = '76px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(s.icon, bx + 52, y + 104);
    ctx.font = 'bold 140px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left';
    ctx.fillText(String(s.value ?? ''), bx + 52, y + 248);
    ctx.font = '500 40px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(s.label, bx + 52, y + BH - 28);
    return y + BH;
  }

  function drawWrappedGrid(ctx, W, y, PAD, stats) {
    const COLS = 2, GAP = 16, bw = (W - PAD * 2 - GAP) / 2, bh = 228;
    for (let i = 0; i < Math.min(stats.length, 4); i++) {
      const s = stats[i], col = i % COLS, row = Math.floor(i / COLS);
      const bx = PAD + col * (bw + GAP), by = y + row * (bh + GAP);
      roundRect(ctx, bx, by, bw, bh, 24);
      const bg = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
      bg.addColorStop(0, s.color + '30'); bg.addColorStop(1, 'rgba(255,255,255,0.04)');
      ctx.fillStyle = bg; ctx.fill();
      roundRect(ctx, bx, by, bw, bh, 24);
      ctx.strokeStyle = s.color + '55'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.font = '50px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(s.icon, bx + 26, by + 68);
      if (s.isTrack && s.value) {
        ctx.font = 'bold 34px Inter, system-ui, sans-serif'; ctx.fillStyle = '#ffffff';
        ctx.fillText(truncate(ctx, s.value, bw - 36), bx + 26, by + 130);
        if (s.sub) {
          ctx.font = '400 26px Inter, system-ui, sans-serif'; ctx.fillStyle = '#8888aa';
          ctx.fillText(truncate(ctx, s.sub, bw - 36), bx + 26, by + 168);
        }
      } else {
        ctx.font = 'bold 60px Inter, system-ui, sans-serif'; ctx.fillStyle = s.color;
        ctx.fillText(String(s.value ?? ''), bx + 26, by + 154);
      }
      ctx.font = '400 27px Inter, system-ui, sans-serif'; ctx.fillStyle = '#5a5a78';
      ctx.fillText(truncate(ctx, s.label, bw - 36), bx + 26, by + 202);
    }
    const rows = Math.ceil(Math.min(stats.length, 4) / COLS);
    return y + rows * (bh + GAP);
  }

  function drawWrappedRow(ctx, W, y, PAD, s) {
    if (s.isList && s.items?.length) {
      const bh = 56 + s.items.length * 72;
      roundRect(ctx, PAD, y, W - PAD * 2, bh, 24);
      ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fill();
      roundRect(ctx, PAD, y, W - PAD * 2, bh, 24);
      ctx.strokeStyle = s.color + '33'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.font = '42px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(s.icon, PAD + 26, y + 48);
      ctx.font = 'bold 32px Inter, sans-serif'; ctx.fillStyle = '#ffffff';
      ctx.fillText(s.label, PAD + 90, y + 44);
      const maxCount = s.items[0]?.count || 1;
      const barW = W - PAD * 2 - 52;
      for (let i = 0; i < s.items.length; i++) {
        const item = s.items[i], iy = y + 62 + i * 72;
        const pct = item.count / maxCount;
        const color = i === 0 ? s.color : i < 3 ? s.color + 'bb' : '#3a3a58';
        roundRect(ctx, PAD + 26, iy + 28, barW, 20, 10);
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
        roundRect(ctx, PAD + 26, iy + 28, Math.max(barW * pct, 20), 20, 10);
        ctx.fillStyle = color; ctx.fill();
        ctx.font = `${i < 3 ? 'bold' : '500'} 30px Inter, sans-serif`;
        ctx.fillStyle = i < 3 ? '#ffffff' : '#8888aa'; ctx.textAlign = 'left';
        ctx.fillText(`${i + 1}. ${item.name}`, PAD + 26, iy + 22);
        ctx.font = '400 24px Inter, sans-serif'; ctx.fillStyle = '#4a4a68';
        ctx.textAlign = 'right';
        ctx.fillText(shortFmt(item.count), W - PAD - 26, iy + 22);
      }
      return y + bh;
    }
    const bh = 108;
    roundRect(ctx, PAD, y, W - PAD * 2, bh, 18);
    ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fill();
    roundRect(ctx, PAD, y, W - PAD * 2, bh, 18);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = '42px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(s.icon, PAD + 26, y + 72);
    ctx.font = 'bold 38px Inter, sans-serif'; ctx.fillStyle = s.color;
    ctx.fillText(String(s.value ?? ''), PAD + 98, y + 68);
    ctx.font = '400 28px Inter, sans-serif'; ctx.fillStyle = '#5a5a78';
    ctx.fillText(s.label, PAD + 98, y + 100);
    return y + bh;
  }

  async function runRender(currentTab, token) {
    if (!canvas) return;
    drawing = true;
    try {
      if (currentTab === 'artists' || currentTab === 'tracks') {
        await renderTopCard(currentTab === 'artists');
      } else {
        await renderCuriosidadesCard();
      }
    } catch (err) {
      console.error('[ShareStoryModal] render error:', err);
      try {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0a0a0f'; ctx.fillRect(0, 0, CARD_W, CARD_H);
        ctx.font = '500 48px Inter, sans-serif'; ctx.fillStyle = '#5a5a78';
        ctx.textAlign = 'center';
        ctx.fillText('Erro ao gerar o card', CARD_W / 2, CARD_H / 2);
        ctx.font = '400 34px Inter, sans-serif'; ctx.fillStyle = '#3a3a58';
        ctx.fillText(String(err?.message ?? ''), CARD_W / 2, CARD_H / 2 + 60);
      } catch { /* ignore */ }
    } finally {
      drawing = false;
      // Se mudou de aba enquanto renderizava, renderiza a aba atual
      if (token !== renderToken) {
        runRender(tab, renderToken);
      }
    }
  }

  function download() {
    if (!canvas) return;
    const names = { artists: 'top-artistas', tracks: 'top-faixas', curiosidades: 'curiosidades' };
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `musicsage-${names[tab] ?? tab}-${Date.now()}.png`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    }, 'image/png');
  }

  function backdropClick(e) { if (e.target === e.currentTarget) show = false; }
</script>

{#if show}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center p-4"
    style="background:rgba(0,0,0,0.9);backdrop-filter:blur(10px)"
    onclick={backdropClick}
  >
    <div class="flex flex-col items-center gap-4" style="max-height:95vh;overflow-y:auto;padding:4px">

      <div class="flex items-center justify-between w-full" style="max-width:{PREVIEW_W}px">
        <div class="text-sm font-semibold" style="color:#ffffff">Compartilhar nos Stories</div>
        <button
          onclick={() => (show = false)}
          style="background:none;border:none;cursor:pointer;color:#5a5a78;font-size:18px;line-height:1;padding:4px 8px"
        >✕</button>
      </div>

      <div class="flex gap-1" style="background:#1a1a28;border-radius:14px;padding:4px">
        {#each [['artists','Top Artistas'],['tracks','Top Faixas'],['curiosidades','Curiosidades']] as [t, label]}
          <button
            onclick={() => { tab = t; clearTimeout(renderTimer); renderTimer = setTimeout(() => scheduleRender(t), 0); }}
            style="padding:7px 14px;border-radius:10px;font-size:12px;font-weight:700;border:none;cursor:pointer;
                   transition:all .15s;white-space:nowrap;
                   background:{tab === t ? '#7c6af5' : 'transparent'};
                   color:{tab === t ? '#fff' : '#5a5a78'}"
          >{label}</button>
        {/each}
      </div>

      <div style="border-radius:16px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,0.95)">
        <canvas
          bind:this={canvas}
          width={CARD_W}
          height={CARD_H}
          style="width:{PREVIEW_W}px;height:{PREVIEW_H}px;display:block"
        ></canvas>
      </div>

      <div class="flex gap-3">
        <button
          onclick={download}
          style="padding:11px 28px;border-radius:13px;background:#1db954;color:#fff;font-size:14px;font-weight:700;border:none;cursor:pointer"
        >↓ Baixar PNG</button>
        <button
          onclick={() => (show = false)}
          style="padding:11px 18px;border-radius:13px;background:#1e1e2e;color:#8888aa;font-size:14px;border:none;cursor:pointer"
        >Fechar</button>
      </div>

      <div style="font-size:11px;color:#3a3a58;padding-bottom:4px;text-align:center">
        Salve o PNG e publique nos Stories do Instagram (9:16)
      </div>

    </div>
  </div>
{/if}
