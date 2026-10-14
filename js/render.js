/* Canvas drawing: the site, the structure, weights, stress colouring and annotations. */
(function (root) {
  'use strict';
  const BS = root.BS;

  function parseColor(str) {
    const s = str.trim();
    if (s.startsWith('#')) {
      const h = s.length === 4 ? s.slice(1).split('').map((c) => c + c).join('') : s.slice(1);
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    const m = s.match(/\d+(\.\d+)?/g);
    return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
  }
  const rgb = (c, a) => (a == null ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`);
  const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

  const TOKENS = ['paper', 'sheet', 'ink', 'ink-soft', 'rule', 'accent', 'earth', 'earth-line', 'water',
    'water-deep', 'ok', 'warn', 'bad', 'tension', 'compression', 'm-timber', 'm-steel', 'm-ibeam', 'm-cable'];

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cam = { x: 9, y: 0, scale: 30 };
      this.dpr = 1;
      this.readColors();
    }

    readColors() {
      const cs = getComputedStyle(document.documentElement);
      this.c = {};
      for (const t of TOKENS) this.c[t] = parseColor(cs.getPropertyValue('--' + t) || '#000');
      this.font = {
        data: cs.getPropertyValue('--font-data').trim() || 'monospace',
        display: cs.getPropertyValue('--font-display').trim() || 'sans-serif',
        body: cs.getPropertyValue('--font-body').trim() || 'sans-serif',
      };
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = r.width;
      this.h = r.height;
      this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    }

    fit(gap) {
      const span = gap + 14;
      const sx = this.w / span;
      const sy = this.h / 22;
      this.cam.scale = Math.max(6, Math.min(sx, sy));
      this.cam.x = gap / 2;
      this.cam.y = this.h / this.cam.scale > 24 ? -1 : 0.5;
    }

    sx(x) { return (x - this.cam.x) * this.cam.scale + this.w / 2; }
    sy(y) { return (this.cam.y - y) * this.cam.scale + this.h / 2; }
    wx(px) { return (px - this.w / 2) / this.cam.scale + this.cam.x; }
    wy(py) { return this.cam.y - (py - this.h / 2) / this.cam.scale; }

    utilColor(u) {
      const { ok, warn, bad } = this.c;
      if (u <= 0.6) return mix(ok, warn, Math.max(0, u) / 0.6);
      if (u <= 1) return mix(warn, bad, (u - 0.6) / 0.4);
      return bad;
    }

    matColor(key) { return this.c['m-' + key]; }

    memberWidth(mat) { return Math.max(1.6, Math.min(12, mat.width * this.cam.scale * 0.9)); }

    /* ------------------------------------------------------------------ */
    draw(st) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.fillStyle = rgb(this.c.sheet);
      ctx.fillRect(0, 0, this.w, this.h);

      const terrain = BS.terrainOf(st.model);
      this.drawGrid();
      this.drawWater(terrain, st.clock);
      this.drawTerrain(terrain);
      this.drawSpan(terrain);

      if (st.mode === 'sim' || (st.mode === 'results' && st.view === 'final' && st.sim)) {
        this.drawSimScene(st);
      } else {
        this.drawDesign(st);
      }
      if (st.tooltip) this.drawTooltip(st.tooltip);
    }

    drawGrid() {
      const ctx = this.ctx;
      const s = this.cam.scale;
      const x0 = Math.floor(this.wx(0));
      const x1 = Math.ceil(this.wx(this.w));
      const y0 = Math.floor(this.wy(this.h));
      const y1 = Math.ceil(this.wy(0));
      const minor = s >= 14;
      ctx.lineWidth = 1;
      for (let x = x0; x <= x1; x++) {
        const major = x % 5 === 0;
        if (!major && !minor) continue;
        ctx.strokeStyle = rgb(this.c.rule, major ? 0.9 : 0.45);
        const px = Math.round(this.sx(x)) + 0.5;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, this.h); ctx.stroke();
      }
      for (let y = y0; y <= y1; y++) {
        const major = y % 5 === 0;
        if (!major && !minor) continue;
        ctx.strokeStyle = rgb(this.c.rule, major ? 0.9 : 0.45);
        const py = Math.round(this.sy(y)) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(this.w, py); ctx.stroke();
      }
    }

    drawWater(terrain, clock) {
      const ctx = this.ctx;
      const top = this.sy(terrain.waterY);
      if (top > this.h) return;
      const grad = ctx.createLinearGradient(0, top, 0, this.h);
      grad.addColorStop(0, rgb(this.c.water, 0.85));
      grad.addColorStop(1, rgb(this.c['water-deep'], 0.95));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, this.h);
      const t = clock || 0;
      for (let px = 0; px <= this.w + 8; px += 8) {
        const wx = this.wx(px);
        ctx.lineTo(px, top + Math.sin(wx * 1.3 + t * 1.6) * 2 + Math.sin(wx * 0.37 - t) * 1.5);
      }
      ctx.lineTo(this.w, this.h);
      ctx.closePath();
      ctx.fill();
    }

    drawTerrain(terrain) {
      const ctx = this.ctx;
      for (const r of terrain.rects) {
        const x0 = this.sx(r.x0); const x1 = this.sx(r.x1);
        const y0 = this.sy(r.y1); const y1 = this.sy(r.y0);
        ctx.fillStyle = rgb(this.c.earth);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.save();
        ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
        ctx.strokeStyle = rgb(this.c['earth-line'], 0.7);
        ctx.lineWidth = 1;
        const step = 9;
        for (let k = x0 - (y1 - y0); k < x1; k += step) {
          ctx.beginPath(); ctx.moveTo(k, y1); ctx.lineTo(k + (y1 - y0), y0); ctx.stroke();
        }
        ctx.restore();
        ctx.strokeStyle = rgb(this.c.ink);
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (r.pier) {
          ctx.moveTo(x0, y1); ctx.lineTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1);
        } else if (r.x1 <= 0.001) {
          ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1);
        } else {
          ctx.moveTo(x1, y0); ctx.lineTo(x0, y0); ctx.lineTo(x0, y1);
        }
        ctx.stroke();
      }
    }

    /* Engineering dimension line for the clear span. */
    drawSpan(terrain) {
      const ctx = this.ctx;
      const y = this.sy(terrain.waterY + 1.4);
      const a = this.sx(0); const b = this.sx(terrain.gap);
      ctx.strokeStyle = rgb(this.c['ink-soft'], 0.8);
      ctx.fillStyle = rgb(this.c['ink-soft']);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a, y); ctx.lineTo(b, y);
      ctx.moveTo(a, y - 6); ctx.lineTo(a, y + 6);
      ctx.moveTo(b, y - 6); ctx.lineTo(b, y + 6);
      ctx.stroke();
      const tick = (x, d) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + d * 8, y - 3); ctx.lineTo(x + d * 8, y + 3); ctx.closePath(); ctx.fill(); };
      tick(a, 1); tick(b, -1);
      const label = `CLEAR SPAN ${terrain.gap.toFixed(1)} m`;
      ctx.font = `500 11px ${this.font.data}`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = rgb(this.c.sheet);
      ctx.fillRect((a + b) / 2 - tw / 2 - 5, y - 8, tw + 10, 16);
      ctx.fillStyle = rgb(this.c['ink-soft']);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, (a + b) / 2, y);
    }

    /* ------------------------------------------------------------------ */
    drawDesign(st) {
      const ctx = this.ctx;
      const model = st.model;
      const nm = BS.nodeMap(model);
      const checks = st.mode === 'results' ? st.report?.checks : st.live ? st.liveChecks : null;
      const brokenOrder = new Map();
      if (st.mode === 'results' && st.sim) st.sim.events.forEach((e, i) => brokenOrder.set(e.id, i + 1));

      ctx.lineCap = 'round';
      // highlight halo
      for (const m of model.members) {
        const hl = st.highlight === m.id || (st.selection?.type === 'member' && st.selection.id === m.id) ||
          (st.hover?.type === 'member' && st.hover.id === m.id && st.mode === 'build');
        if (!hl) continue;
        const a = nm.get(m.a); const b = nm.get(m.b);
        ctx.strokeStyle = rgb(this.c.accent, 0.35);
        ctx.lineWidth = this.memberWidth(BS.MATERIALS[m.mat]) + 10;
        ctx.beginPath(); ctx.moveTo(this.sx(a.x), this.sy(a.y)); ctx.lineTo(this.sx(b.x), this.sy(b.y)); ctx.stroke();
      }

      for (const m of model.members) {
        const a = nm.get(m.a); const b = nm.get(m.b);
        const mat = BS.MATERIALS[m.mat];
        const chk = checks?.get(m.id);
        let col = this.matColor(m.mat);
        if (chk) col = chk.mode === 'slack' ? this.c['ink-soft'] : this.utilColor(chk.u);
        const broken = brokenOrder.has(m.id);
        ctx.strokeStyle = rgb(col);
        ctx.lineWidth = this.memberWidth(mat);
        if (broken || chk?.mode === 'slack') ctx.setLineDash([ctx.lineWidth * 1.4, ctx.lineWidth * 1.4]);
        ctx.beginPath(); ctx.moveTo(this.sx(a.x), this.sy(a.y)); ctx.lineTo(this.sx(b.x), this.sy(b.y)); ctx.stroke();
        ctx.setLineDash([]);
        if (m.mat === 'ibeam' && !chk) {
          ctx.strokeStyle = rgb(this.c.sheet, 0.5);
          ctx.lineWidth = Math.max(1, this.memberWidth(mat) * 0.25);
          ctx.beginPath(); ctx.moveTo(this.sx(a.x), this.sy(a.y)); ctx.lineTo(this.sx(b.x), this.sy(b.y)); ctx.stroke();
        }
      }

      this.drawPreview(st);
      this.drawNodes(st, (n) => ({ x: n.x, y: n.y }));
      this.drawWeights(st, model.loads.map((l) => ({ load: l, pos: BS.loadPoint(model, l, nm) })));

      if (st.mode === 'results' && st.report) {
        // Break markers
        for (const [id, order] of brokenOrder) {
          const m = model.members.find((mm) => mm.id === id);
          if (!m) continue;
          const a = nm.get(m.a); const b = nm.get(m.b);
          this.drawBreakMark(this.sx((a.x + b.x) / 2), this.sy((a.y + b.y) / 2), order);
        }
        // Weak point badges
        const shown = st.report.weak.filter((w) => w.u >= 0.25).slice(0, 4);
        for (const w of shown) {
          const m = model.members.find((mm) => mm.id === w.id);
          if (!m) continue;
          const a = nm.get(m.a); const b = nm.get(m.b);
          this.drawBadge(this.sx((a.x + b.x) / 2), this.sy((a.y + b.y) / 2), w, st.highlight === w.id, brokenOrder.has(w.id));
        }
      }
      if (st.mechanismNode != null) {
        const n = nm.get(st.mechanismNode);
        if (n) this.drawMechanism(this.sx(n.x), this.sy(n.y), st.clock);
      }
    }

    drawPreview(st) {
      const p = st.preview;
      if (!p) return;
      const ctx = this.ctx;
      const mat = BS.MATERIALS[st.material];
      ctx.strokeStyle = p.valid ? rgb(this.matColor(st.material), 0.75) : rgb(this.c.bad, 0.8);
      ctx.lineWidth = this.memberWidth(mat);
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(this.sx(p.x0), this.sy(p.y0)); ctx.lineTo(this.sx(p.x1), this.sy(p.y1)); ctx.stroke();
      ctx.setLineDash([]);
      const L = Math.hypot(p.x1 - p.x0, p.y1 - p.y0);
      const text = p.reason || `${L.toFixed(2)} m`;
      ctx.font = `500 12px ${this.font.data}`;
      const mx = this.sx((p.x0 + p.x1) / 2); const my = this.sy((p.y0 + p.y1) / 2) - 14;
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = rgb(p.valid ? this.c.ink : this.c.bad);
      ctx.fillRect(mx - tw / 2 - 5, my - 9, tw + 10, 18);
      ctx.fillStyle = rgb(this.c.sheet);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, mx, my);
    }

    drawNodes(st, posOf) {
      const ctx = this.ctx;
      const used = new Set();
      st.model.members.forEach((m) => { used.add(m.a); used.add(m.b); });
      const r = Math.max(3, Math.min(6, this.cam.scale * 0.12));
      for (const n of st.model.nodes) {
        const p = posOf(n);
        if (!p) continue;
        const x = this.sx(p.x); const y = this.sy(p.y);
        if (n.fixed) this.drawAnchor(x, y, r);
        const hot = (st.hover?.type === 'node' && st.hover.id === n.id) || (st.selection?.type === 'node' && st.selection.id === n.id);
        ctx.beginPath();
        ctx.arc(x, y, hot ? r + 2 : r, 0, Math.PI * 2);
        ctx.fillStyle = rgb(hot ? this.c.accent : this.c.sheet);
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = rgb(used.has(n.id) || n.fixed ? this.c.ink : this.c['ink-soft']);
        ctx.stroke();
      }
    }

    /* Pinned support symbol: triangle on a hatched ground line. */
    drawAnchor(x, y, r) {
      const ctx = this.ctx;
      const s = r * 2.6;
      ctx.fillStyle = rgb(this.c.ink);
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x - s * 0.7, y + s); ctx.lineTo(x + s * 0.7, y + s); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgb(this.c.ink);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x - s, y + s); ctx.lineTo(x + s, y + s); ctx.stroke();
      ctx.lineWidth = 1;
      for (let k = -s; k < s; k += 4) {
        ctx.beginPath(); ctx.moveTo(x + k + 4, y + s); ctx.lineTo(x + k, y + s + 4); ctx.stroke();
      }
    }

    weightSize(mass) {
      const w = 0.9 + 0.38 * Math.cbrt(mass / 1000);
      return { w, h: w * 0.62 };
    }

    drawWeights(st, items) {
      const ctx = this.ctx;
      for (const { load, pos } of items) {
        if (!pos) continue;
        const { w, h } = this.weightSize(load.mass);
        const pw = w * this.cam.scale; const ph = h * this.cam.scale;
        const x = this.sx(pos.x); const y = this.sy(pos.y) - 4;
        const sel = st.selection?.type === 'load' && st.selection.id === load.id;
        const hov = st.hover?.type === 'load' && st.hover.id === load.id;
        ctx.fillStyle = rgb(this.c.ink);
        ctx.strokeStyle = rgb(sel || hov ? this.c.accent : this.c.ink);
        ctx.lineWidth = sel ? 3 : 1.5;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x - pw / 2, y - ph, pw, ph, 3); else ctx.rect(x - pw / 2, y - ph, pw, ph);
        ctx.fill(); ctx.stroke();
        // load arrow
        ctx.strokeStyle = rgb(this.c.sheet);
        ctx.lineWidth = 1.5;
        const fs = Math.max(10, Math.min(16, ph * 0.38));
        ctx.font = `600 ${fs}px ${this.font.data}`;
        ctx.fillStyle = rgb(this.c.sheet);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const label = load.mass >= 1000 ? `${+(load.mass / 1000).toFixed(load.mass % 1000 ? 1 : 0)} t` : `${load.mass} kg`;
        ctx.fillText(label, x, y - ph / 2);
        ctx.fillStyle = rgb(this.c.accent);
        ctx.beginPath(); ctx.moveTo(x, y + 4); ctx.lineTo(x - 4, y - 2); ctx.lineTo(x + 4, y - 2); ctx.closePath(); ctx.fill();
      }
    }

    drawBadge(x, y, w, hot, broken) {
      const ctx = this.ctx;
      const text = `${w.rank} · ${Math.round(w.u * 100)}%`;
      ctx.font = `600 11px ${this.font.data}`;
      const tw = ctx.measureText(text).width;
      const bx = x + 8; const by = y - 26 - (broken ? 10 : 0);
      const col = this.utilColor(w.u);
      ctx.strokeStyle = rgb(col);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(bx, by + 9); ctx.stroke();
      ctx.fillStyle = rgb(hot ? this.c.accent : col);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, tw + 12, 18, 9); else ctx.rect(bx, by, tw + 12, 18);
      ctx.fill();
      ctx.fillStyle = rgb(this.c.sheet);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(text, bx + 6, by + 9.5);
    }

    drawBreakMark(x, y, order) {
      const ctx = this.ctx;
      ctx.fillStyle = rgb(this.c.bad);
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgb(this.c.sheet);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4);
      ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4);
      ctx.stroke();
      ctx.font = `600 10px ${this.font.data}`;
      ctx.fillStyle = rgb(this.c.bad);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(`#${order}`, x, y + 11);
    }

    drawMechanism(x, y, clock) {
      const ctx = this.ctx;
      const pulse = 10 + 4 * Math.sin((clock || 0) * 5);
      ctx.strokeStyle = rgb(this.c.bad);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, pulse, 0, Math.PI * 2); ctx.stroke();
      ctx.font = `600 11px ${this.font.data}`;
      ctx.fillStyle = rgb(this.c.bad);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('free to move', x, y + 18);
    }

    /* ------------------------------------------------------------------ */
    drawSimScene(st) {
      const ctx = this.ctx;
      const sim = st.sim;
      const { x, y } = sim;
      ctx.lineCap = 'round';
      for (const c of sim.members) {
        if (c.broken) continue;
        const slack = c.mat.tensionOnly && Math.hypot(x[c.b] - x[c.a], y[c.b] - y[c.a]) < c.L0;
        const u = st.mode === 'results' ? c.peakU : c.u;
        ctx.strokeStyle = rgb(slack ? this.c['ink-soft'] : this.utilColor(u));
        ctx.lineWidth = this.memberWidth(c.mat);
        if (st.highlight === c.id) {
          ctx.save();
          ctx.strokeStyle = rgb(this.c.accent, 0.35);
          ctx.lineWidth += 10;
          ctx.beginPath(); ctx.moveTo(this.sx(x[c.a]), this.sy(y[c.a])); ctx.lineTo(this.sx(x[c.b]), this.sy(y[c.b])); ctx.stroke();
          ctx.restore();
        }
        ctx.beginPath(); ctx.moveTo(this.sx(x[c.a]), this.sy(y[c.a])); ctx.lineTo(this.sx(x[c.b]), this.sy(y[c.b])); ctx.stroke();
      }
      for (const d of sim.debris) {
        const hx = Math.cos(d.ang) * d.len / 2; const hy = Math.sin(d.ang) * d.len / 2;
        ctx.strokeStyle = rgb(this.c.bad, Math.min(1, d.life / 1.5));
        ctx.lineWidth = this.memberWidth(d.mat);
        ctx.beginPath(); ctx.moveTo(this.sx(d.x - hx), this.sy(d.y - hy)); ctx.lineTo(this.sx(d.x + hx), this.sy(d.y + hy)); ctx.stroke();
      }
      for (const s of sim.splashes) {
        const r = (0.4 + s.t * 2.5) * this.cam.scale;
        ctx.strokeStyle = rgb(this.c.sheet, Math.max(0, 1 - s.t / 1.2));
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(this.sx(s.x), this.sy(sim.terrain.waterY), r, r * 0.25, 0, Math.PI, Math.PI * 2); ctx.stroke();
      }
      this.drawNodes(st, (n) => sim.nodePos(n.id));
      this.drawWeights(st, sim.weights.map((w) => ({ load: w.load, pos: { x: x[w.p], y: y[w.p] } })));
    }

    drawTooltip(tip) {
      const ctx = this.ctx;
      ctx.font = `500 12px ${this.font.data}`;
      const lines = tip.lines;
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
      const h = lines.length * 17 + 10;
      let x = tip.x + 14; let y = tip.y + 14;
      if (x + w > this.w - 6) x = tip.x - w - 14;
      if (y + h > this.h - 6) y = tip.y - h - 14;
      ctx.fillStyle = rgb(this.c.ink, 0.94);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6); else ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.fillStyle = rgb(this.c.sheet);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      lines.forEach((l, i) => {
        ctx.font = i === 0 ? `600 12px ${this.font.data}` : `400 12px ${this.font.data}`;
        ctx.fillText(l, x + 8, y + 7 + i * 17);
      });
    }
  }

  BS.Renderer = Renderer;
  BS.colorUtil = { parseColor, mix, rgb };
})(typeof window !== 'undefined' ? window : globalThis);
