/**
 * Pure-Canvas 3D scatter renderer (no WebGL, no external deps).
 * Ported from the original monolithic index.html.
 *
 * Usage:
 *   const renderer = startRenderer3D(canvas, clusters, { onSelectCluster });
 *   renderer.setSelected(id);  // highlight a cluster
 *   renderer.stop();           // cleanup
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Array}  clusters   — array of { id, color, tracks:[{x,y,z,title,artist}] }
 * @param {object} [opts]
 * @param {HTMLElement} [opts.tooltip]
 * @param {Function}    [opts.onSelectCluster]  — called with cluster id (or null)
 */
export function startRenderer3D(canvas, clusters, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.parentElement?.clientWidth || 600;
  const H = 480;
  canvas.width  = W;
  canvas.height = H;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  const points = [];
  for (const cl of clusters) {
    for (const tr of cl.tracks ?? []) {
      points.push({
        x: (tr.x ?? 0) * 2 - 1,
        y: (tr.y ?? 0) * 2 - 1,
        z: (tr.z ?? 0) * 2 - 1,
        color: cl.color,
        cid:   cl.id,
        title:  tr.title  ?? '',
        artist: tr.artist ?? '',
      });
    }
  }

  let theta       = 0.4;
  let phi         = 0.5;
  let scaleZ      = Math.min(W, H) * 0.38;
  let isDragging  = false;
  let lastX       = 0;
  let lastY       = 0;
  let autoRotate  = true;
  let selectedId  = null;
  let rafId       = null;
  let stopped     = false;
  let proj2D      = [];

  function rotPt(px, py, pz) {
    const rx  =  px * Math.cos(theta) + pz * Math.sin(theta);
    const rz0 = -px * Math.sin(theta) + pz * Math.cos(theta);
    const ry2 =  py * Math.cos(phi)   - rz0 * Math.sin(phi);
    const rz2 =  py * Math.sin(phi)   + rz0 * Math.cos(phi);
    return [rx, ry2, rz2];
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const near = 2.5;
    const projected = points.map((pt, i) => {
      const [rx, ry, rz] = rotPt(pt.x, pt.y, pt.z);
      const d = near / (near + rz);
      return { pt, sx: W / 2 + rx * scaleZ * d, sy: H / 2 - ry * scaleZ * d, rz, d, i };
    });
    projected.sort((a, b) => a.rz - b.rz);

    proj2D = new Array(points.length);
    projected.forEach(({ sx, sy, i }) => { proj2D[i] = { sx, sy }; });

    for (const { pt, sx, sy, d } of projected) {
      const active = selectedId === null || pt.cid === selectedId;
      ctx.globalAlpha = active ? 0.82 : 0.07;
      ctx.fillStyle   = pt.color;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(2, 5 * d), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function loop() {
    if (stopped) return;
    if (autoRotate) theta += 0.005;
    draw();
    rafId = requestAnimationFrame(loop);
  }

  // ── Mouse ──
  const onDown = (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    autoRotate = false;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
  };
  canvas.addEventListener('mousedown', onDown);

  const { tooltip } = opts;
  const onMove = (e) => {
    if (isDragging) {
      theta -= (e.clientX - lastX) * 0.008;
      phi    = Math.max(0.05, Math.min(Math.PI - 0.05, phi + (e.clientY - lastY) * 0.008));
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }
    if (!tooltip) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = null, bestD2 = 144;
    proj2D.forEach(({ sx, sy }, i) => {
      const d2 = (sx - mx) ** 2 + (sy - my) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    });
    if (best !== null) {
      const pt = points[best];
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX + 14) + 'px';
      tooltip.style.top  = (e.clientY - 10) + 'px';
      tooltip.textContent = `${pt.title} — ${pt.artist}`;
      canvas.style.cursor = 'pointer';
    } else {
      tooltip.style.display = 'none';
      canvas.style.cursor = 'grab';
    }
  };
  window.addEventListener('mousemove', onMove);

  const onUp = () => {
    isDragging = false;
    canvas.style.cursor = 'grab';
  };
  window.addEventListener('mouseup', onUp);

  canvas.addEventListener('mouseleave', () => {
    if (tooltip) tooltip.style.display = 'none';
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    scaleZ = Math.max(80, Math.min(800, scaleZ * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  }, { passive: false });

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = null, bestD2 = 144;
    proj2D.forEach(({ sx, sy }, i) => {
      const d2 = (sx - mx) ** 2 + (sy - my) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    });
    const cid = best !== null ? points[best].cid : null;
    selectedId = cid;
    opts.onSelectCluster?.(cid);
  });

  loop();

  return {
    setSelected(id) { selectedId = id; },
    stop() {
      stopped = true;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    },
  };
}

/**
 * SVG scatter plot renderer with pan + zoom.
 *
 * @param {SVGSVGElement} svg
 * @param {SVGGElement}   group         — dots layer
 * @param {Array}         clusters
 * @param {object}        [opts]
 * @param {HTMLElement}   [opts.tooltip]
 * @param {Function}      [opts.onSelectCluster]
 * @returns {{ setSelected(id), resetView(), destroy() }}
 */
export function startRendererSVG(svg, group, clusters, opts = {}) {
  const pad  = 30;
  const svgW = svg.getBoundingClientRect().width || 600;
  const svgH = 480;

  let panX = 0, panY = 0, zoom = 1;
  let isDragging = false, dragStart = null, panAtDrag = null;
  let selectedId = null;

  const zoomGroup = svg.querySelector('.cl-zoom-group') ?? svg;

  function applyTransform() {
    zoomGroup.setAttribute('transform', `translate(${panX},${panY}) scale(${zoom})`);
  }

  // Draw dots
  group.innerHTML = '';
  const circles = [];
  const { tooltip } = opts;

  for (const cl of clusters) {
    for (const tr of cl.tracks ?? []) {
      const cx = pad + tr.x * (svgW - pad * 2);
      const cy = pad + (1 - tr.y) * (svgH - pad * 2);

      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', cx.toFixed(1));
      c.setAttribute('cy', cy.toFixed(1));
      c.setAttribute('r', '4');
      c.setAttribute('fill', cl.color);
      c.setAttribute('opacity', '0.75');
      c.setAttribute('data-cid', String(cl.id));
      c.style.cursor = 'pointer';
      c.style.transition = 'r .15s, opacity .15s';

      c.addEventListener('mouseenter', (e) => {
        c.setAttribute('r', '7');
        c.setAttribute('opacity', '1');
        if (tooltip) {
          tooltip.style.display = 'block';
          tooltip.textContent = `${tr.title ?? ''} — ${tr.artist ?? ''}`;
        }
      });
      c.addEventListener('mousemove', (e) => {
        if (tooltip) {
          tooltip.style.left = (e.clientX + 14) + 'px';
          tooltip.style.top  = (e.clientY - 10) + 'px';
        }
      });
      c.addEventListener('mouseleave', () => {
        c.setAttribute('r', '4');
        c.setAttribute('opacity', selectedId == null || selectedId === cl.id ? '0.75' : '0.12');
        if (tooltip) tooltip.style.display = 'none';
      });
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedId = cl.id;
        applyOpacity();
        opts.onSelectCluster?.(cl.id);
      });

      group.appendChild(c);
      circles.push({ el: c, cid: cl.id });
    }
  }

  svg.addEventListener('click', () => {
    selectedId = null;
    applyOpacity();
    opts.onSelectCluster?.(null);
  });

  function applyOpacity() {
    circles.forEach(({ el, cid }) => {
      el.setAttribute('opacity', selectedId == null || selectedId === cid ? '0.75' : '0.12');
    });
  }

  // Pan + zoom
  const onWheel = (e) => {
    e.preventDefault();
    const rect  = svg.getBoundingClientRect();
    const mx    = e.clientX - rect.left;
    const my    = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newZ   = Math.max(0.5, Math.min(20, zoom * factor));
    panX = mx - (mx - panX) * (newZ / zoom);
    panY = my - (my - panY) * (newZ / zoom);
    zoom = newZ;
    applyTransform();
  };
  svg.addEventListener('wheel', onWheel, { passive: false });

  const onDown = (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    dragStart  = { x: e.clientX, y: e.clientY };
    panAtDrag  = { x: panX, y: panY };
    svg.style.cursor = 'grabbing';
  };
  svg.addEventListener('mousedown', onDown);

  const onMove = (e) => {
    if (!isDragging) return;
    panX = panAtDrag.x + (e.clientX - dragStart.x);
    panY = panAtDrag.y + (e.clientY - dragStart.y);
    applyTransform();
  };
  window.addEventListener('mousemove', onMove);

  const onUp = () => {
    if (!isDragging) return;
    isDragging = false;
    svg.style.cursor = 'grab';
  };
  window.addEventListener('mouseup', onUp);

  return {
    setSelected(id) {
      selectedId = id;
      applyOpacity();
    },
    resetView() {
      panX = 0; panY = 0; zoom = 1;
      applyTransform();
    },
    destroy() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      group.innerHTML = '';
    },
  };
}
