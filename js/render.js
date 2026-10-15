/* Canvas drawing: the site, the structure, weights, stress colouring and annotations.
 * Two projections: 'side' (x across the gap, y up) and 'top' (x across the gap, z across the deck,
 * front truss at z = 0 along the bottom of the screen, back truss at z = width above it). */
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
  const sameY = (a, b) => Math.abs(a - b) < 1e-6;

  const TOKENS = ['paper', 'sheet', 'ink', 'ink-soft', 'rule', 'accent', 'earth', 'earth-line',
    'ok', 'warn', 'bad', 'm-timber', 'm-steel'];

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cams = { side: { x: 0.25, y: 0, scale: 1200 }, top: { x: 0.25, y: 0.04, scale: 1200 } };
      this.proj = 'side';
      this.dpr = 1;
      this.readColors();
    }

    get cam() { return this.cams[this.proj]; }

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

    fit(gap, width) {
      const side = this.cams.side;
      side.scale = Math.max(100, Math.min(this.w / (gap * 1.7), this.h / (gap * 1.25)));
      side.x = gap / 2;
      side.y = -0.12 * gap;
      const top = this.cams.top;
      const W = width || BS.DEFAULT_WIDTH;
      top.scale = Math.max(100, Math.min(this.w / (gap * 1.5), this.h / (W + 0.12)));
      top.x = gap / 2;
      top.y = W / 2;
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

    matColor(mat) { return mat.E >= 50e9 ? this.c['m-steel'] : this.c['m-timber']; }

    memberWidth(mat, flat) {
      const size = flat ? mat.width : this.proj === 'top' ? mat.thick : mat.width;
      return Math.max(1.6, Math.min(14, size * this.cam.scale));
    }

    line(x0, y0, x1, y1) {
      const ctx = this.ctx;
      ctx.beginPath(); ctx.moveTo(this.sx(x0), this.sy(y0)); ctx.lineTo(this.sx(x1), this.sy(y1)); ctx.stroke();
    }

    /* ------------------------------------------------------------------ */
    draw(st) {
      this.proj = st.proj || 'side';
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.fillStyle = rgb(this.c.sheet);
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.lineCap = 'round';

      const terrain = BS.terrainOf(st.model);
      this.drawGrid();
      const live = st.mode === 'sim' || (st.mode === 'results' && st.view === 'final' && st.sim);
      if (this.proj === 'top') {
        this.drawPlanSite(st.model);
        this.drawPlan(st, live);
      } else {
        this.drawTerrain(terrain);
        this.drawSpan(terrain);
        if (live) this.drawSimScene(st);
        else this.drawDesign(st);
      }
      if (st.tooltip) this.drawTooltip(st.tooltip);
    }

    /* Centimetre grid with labelled major lines along the top and left edges. */
    drawGrid() {
      const ctx = this.ctx;
      const s = this.cam.scale;
      const steps = [0.01, 0.05, 0.1, 0.5, 1, 5];
      const minor = steps.find((st) => st * s >= 7) || 5;
      const major = minor === 0.01 ? 0.1 : minor * 10;
      const per = Math.round(major / minor);
      const i0 = Math.floor(this.wx(0) / minor);
      const i1 = Math.ceil(this.wx(this.w) / minor);
      const j0 = Math.floor(this.wy(this.h) / minor);
      const j1 = Math.ceil(this.wy(0) / minor);
      ctx.lineWidth = 1;
      const labels = [];
      for (let i = i0; i <= i1; i++) {
        const isMajor = i % per === 0;
        ctx.strokeStyle = rgb(this.c.rule, isMajor ? 0.95 : 0.4);
        const px = Math.round(this.sx(i * minor)) + 0.5;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, this.h); ctx.stroke();
        if (isMajor) labels.push(['x', px, i * minor]);
      }
      for (let j = j0; j <= j1; j++) {
        const isMajor = j % per === 0;
        ctx.strokeStyle = rgb(this.c.rule, isMajor ? 0.95 : 0.4);
        const py = Math.round(this.sy(j * minor)) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(this.w, py); ctx.stroke();
        if (isMajor) labels.push(['y', py, j * minor]);
      }
      ctx.font = `400 10px ${this.font.data}`;
      ctx.fillStyle = rgb(this.c['ink-soft'], 0.8);
      for (const [axis, pos, v] of labels) {
        const t = `${Math.round(v * 100)}`;
        ctx.textAlign = 'left';
        if (axis === 'x') { ctx.textBaseline = 'top'; ctx.fillText(t, pos + 3, 3); }
        else { ctx.textBaseline = 'bottom'; ctx.fillText(t, 3, pos - 2); }
      }
      ctx.textBaseline = 'top';
      ctx.fillText('cm', 3, 15);
    }

    hatchRect(x0, y0, x1, y1) {
      const ctx = this.ctx;
      ctx.fillStyle = rgb(this.c.earth);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
      ctx.strokeStyle = rgb(this.c['earth-line'], 0.7);
      ctx.lineWidth = 1;
      for (let k = x0 - (y1 - y0); k < x1; k += 9) {
        ctx.beginPath(); ctx.moveTo(k, y1); ctx.lineTo(k + (y1 - y0), y0); ctx.stroke();
      }
      ctx.restore();
    }

    drawTerrain(terrain) {
      const ctx = this.ctx;
      for (const r of terrain.rects) {
        const x0 = this.sx(r.x0); const x1 = this.sx(r.x1);
        const y0 = this.sy(r.y1); const y1 = this.sy(r.y0);
        this.hatchRect(x0, y0, x1, y1);
        ctx.strokeStyle = rgb(this.c.ink);
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (r.floor) {
          ctx.moveTo(x0, y0); ctx.lineTo(x1, y0);
        } else if (r.pier) {
          ctx.moveTo(x0, y1); ctx.lineTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1);
        } else if (r.x1 <= 0.001) {
          ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1);
        } else {
          ctx.moveTo(x1, y0); ctx.lineTo(x0, y0); ctx.lineTo(x0, y1);
        }
        ctx.stroke();
      }
    }

    dimension(a, b, y, label) {
      const ctx = this.ctx;
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
      ctx.font = `500 11px ${this.font.data}`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = rgb(this.c.sheet);
      ctx.fillRect((a + b) / 2 - tw / 2 - 5, y - 8, tw + 10, 16);
      ctx.fillStyle = rgb(this.c['ink-soft']);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, (a + b) / 2, y);
    }

    /* Engineering dimension line for the clear span. */
    drawSpan(terrain) {
      const y = this.sy(terrain.floorY + Math.min(0.06, terrain.gap * 0.08));
      this.dimension(this.sx(0), this.sx(terrain.gap), y, `CLEAR SPAN ${BS.cm(terrain.gap)}`);
    }

    /* Top view of the site: both table tops, the two truss lines and the deck width. */
    drawPlanSite(model) {
      const ctx = this.ctx;
      const g = model.gap;
      const W = model.width;
      const t = this.sy(10); const b = this.sy(-10);
      this.hatchRect(this.sx(-2), t, this.sx(0), b);
      this.hatchRect(this.sx(g), t, this.sx(g + 2), b);
      ctx.strokeStyle = rgb(this.c.ink);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(this.sx(0), 0); ctx.lineTo(this.sx(0), this.h);
      ctx.moveTo(this.sx(g), 0); ctx.lineTo(this.sx(g), this.h);
      ctx.stroke();
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = rgb(this.c['ink-soft'], 0.5);
      ctx.lineWidth = 1;
      this.line(-0.03, 0, g + 0.03, 0);
      this.line(-0.03, W, g + 0.03, W);
      ctx.setLineDash([]);
      ctx.font = `600 11px ${this.font.data}`;
      ctx.fillStyle = rgb(this.c['ink-soft']);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('FRONT TRUSS', this.sx(g / 2), this.sy(0) + 14);
      ctx.textBaseline = 'bottom';
      ctx.fillText('BACK TRUSS', this.sx(g / 2), this.sy(W) - 14);
      // Deck width, measured on the right table.
      const x = this.sx(g) + 34;
      ctx.strokeStyle = rgb(this.c['ink-soft'], 0.8);
      ctx.beginPath();
      ctx.moveTo(x, this.sy(0)); ctx.lineTo(x, this.sy(W));
      ctx.moveTo(x - 6, this.sy(0)); ctx.lineTo(x + 6, this.sy(0));
      ctx.moveTo(x - 6, this.sy(W)); ctx.lineTo(x + 6, this.sy(W));
      ctx.stroke();
      const label = `WIDTH ${BS.cm(W)}`;
      ctx.font = `500 11px ${this.font.data}`;
      const tw = ctx.measureText(label).width;
      // Beside the line when there is room, otherwise above it, kept inside the canvas.
      let lx = x + 6;
      let ly = (this.sy(0) + this.sy(W)) / 2;
      if (lx + tw + 12 > this.w) { lx = Math.max(4, Math.min(this.w - tw - 14, x - tw / 2 - 5)); ly = this.sy(W) - 18; }
      ctx.fillStyle = rgb(this.c.sheet);
      ctx.fillRect(lx, ly - 8, tw + 10, 16);
      ctx.fillStyle = rgb(this.c['ink-soft']);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + 5, ly);
    }

    /* ------------------------------------------------------------------ */
    /* Worst of the two trusses' checks for a side member. */
    sideCheck(checks, id) {
      if (!checks) return null;
      const a = checks.get(`${id}:0`); const b = checks.get(`${id}:1`);
      if (!a) return b || null;
      if (!b) return a;
      return b.u > a.u ? b : a;
    }

    static brokenOrder(sim) {
      const order = new Map();
      (sim?.events || []).forEach((e, i) => order.set(e.key, i + 1));
      return order;
    }

    isHot(st, kind, id, side) {
      const h = st.highlight;
      if (h) {
        if (kind === 'plan' && h === `p${id}`) return true;
        if (kind === 'member' && (h === `${id}:0` || h === `${id}:1`) && (side == null || h === `${id}:${side}`)) return true;
      }
      const sel = st.selection;
      if (sel && sel.type === kind && sel.id === id) return true;
      return st.mode === 'build' && st.hover?.type === kind && st.hover.id === id;
    }

    drawDesign(st) {
      const ctx = this.ctx;
      const model = st.model;
      const nm = BS.nodeMap(model);
      const mat = BS.memberMat(model);
      const checks = st.mode === 'results' ? st.report?.checks : st.live ? st.liveChecks : null;
      const order = Renderer.brokenOrder(st.mode === 'results' ? st.sim : null);

      for (const m of model.members) {
        if (!this.isHot(st, 'member', m.id)) continue;
        const a = nm.get(m.a); const b = nm.get(m.b);
        ctx.strokeStyle = rgb(this.c.accent, 0.35);
        ctx.lineWidth = this.memberWidth(mat) + 10;
        this.line(a.x, a.y, b.x, b.y);
      }

      for (const m of model.members) {
        const a = nm.get(m.a); const b = nm.get(m.b);
        const chk = this.sideCheck(checks, m.id);
        const tooLong = !checks && BS.memberLength(model, m, nm) > mat.maxLen + 1e-9;
        let col = tooLong ? this.c.bad : this.matColor(mat);
        if (chk) col = this.utilColor(chk.u);
        const broken = order.has(`${m.id}:0`) || order.has(`${m.id}:1`);
        ctx.strokeStyle = rgb(col);
        ctx.lineWidth = this.memberWidth(mat);
        if (broken || tooLong) ctx.setLineDash([ctx.lineWidth * 1.4, ctx.lineWidth * 1.4]);
        this.line(a.x, a.y, b.x, b.y);
        ctx.setLineDash([]);
      }

      if (st.angles && (st.mode === 'build' || st.view === 'weak')) {
        const used = BS.usedNodes(model);
        for (const n of model.nodes) {
          if (!used.has(n.id)) continue;
          this.drawAngles(this.sx(n.x), this.sy(n.y), BS.sideJointDirs(model, n.id, nm), this.sideMinLen(model, nm, n) * this.cam.scale);
        }
      }
      this.drawPreview(st);
      this.drawNodes(st, (n) => ({ x: n.x, y: n.y }));
      this.drawWeights(st, model.loads.map((l) => ({ load: l, pos: BS.loadPoint(model, l, nm) })));

      if (st.mode === 'results' && st.report) {
        const marked = new Set();
        for (const [key, n] of order) {
          if (key.startsWith('p')) continue;
          const id = +key.split(':')[0];
          if (marked.has(id)) continue;
          marked.add(id);
          const m = model.members.find((mm) => mm.id === id);
          if (!m) continue;
          const a = nm.get(m.a); const b = nm.get(m.b);
          this.drawBreakMark(this.sx((a.x + b.x) / 2), this.sy((a.y + b.y) / 2), n);
        }
        const seen = new Set();
        const shown = st.report.weak.filter((w) => w.kind === 'member' && w.u >= 0.25 && !seen.has(w.id) && seen.add(w.id)).slice(0, 4);
        for (const w of shown) {
          const m = model.members.find((mm) => mm.id === w.id);
          if (!m) continue;
          const a = nm.get(m.a); const b = nm.get(m.b);
          this.drawBadge(this.sx((a.x + b.x) / 2), this.sy((a.y + b.y) / 2), w, this.isHot(st, 'member', w.id), marked.has(w.id));
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
      const mat = BS.memberMat(st.model);
      ctx.strokeStyle = p.valid ? rgb(this.matColor(mat), 0.75) : rgb(this.c.bad, 0.8);
      ctx.lineWidth = this.memberWidth(mat, p.flat);
      ctx.setLineDash([6, 5]);
      this.line(p.x0, p.y0, p.x1, p.y1);
      ctx.setLineDash([]);
      for (const sp of p.snaps || []) this.diamond(this.sx(sp.x), this.sy(sp.y), 7, this.c.accent, this.c.sheet);
      const text = p.reason || p.label || BS.cm(p.len != null ? p.len : Math.hypot(p.x1 - p.x0, p.y1 - p.y0));
      ctx.font = `500 12px ${this.font.data}`;
      const tw = ctx.measureText(text).width;
      const mx = Math.max(tw / 2 + 8, Math.min(this.w - tw / 2 - 8, this.sx((p.x0 + p.x1) / 2)));
      const my = Math.max(14, Math.min(this.h - 14, this.sy((p.y0 + p.y1) / 2) - 14));
      ctx.fillStyle = rgb(p.valid ? this.c.ink : this.c.bad);
      ctx.fillRect(mx - tw / 2 - 5, my - 9, tw + 10, 18);
      ctx.fillStyle = rgb(this.c.sheet);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, mx, my);
    }

    /* A joint glued onto a beam is drawn as a diamond; a joint between pieces as a circle. */
    diamond(x, y, r, fill, stroke) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
      ctx.fillStyle = rgb(fill);
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = rgb(stroke);
      ctx.stroke();
    }

    /* Angle arcs between neighbouring members at a joint, with degree labels.
     * dirs: world directions (radians, counter-clockwise); minPx: shortest member there, in pixels. */
    drawAngles(px, py, dirs, minPx) {
      const gaps = BS.jointGaps(dirs);
      if (!gaps.length || minPx < 30) return;
      const ctx = this.ctx;
      const r = Math.max(11, Math.min(22, minPx * 0.28));
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = rgb(this.c.accent, 0.7);
      ctx.font = `500 10px ${this.font.data}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const g of gaps) {
        ctx.beginPath();
        ctx.arc(px, py, r, -(g.from + g.gap), -g.from);
        ctx.stroke();
        if (g.gap < 0.16) continue;
        const mid = g.from + g.gap / 2;
        const lr = r + (g.gap < 0.6 ? 14 : 10);
        const lx = px + Math.cos(mid) * lr; const ly = py - Math.sin(mid) * lr;
        const t = BS.deg(g.gap);
        ctx.lineWidth = 3;
        ctx.strokeStyle = rgb(this.c.sheet, 0.9);
        ctx.strokeText(t, lx, ly);
        ctx.fillStyle = rgb(this.c.ink);
        ctx.fillText(t, lx, ly);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = rgb(this.c.accent, 0.7);
      }
    }

    /* Shortest piece meeting a joint in the side view, in metres (glued joints count the beam on each side). */
    sideMinLen(model, nm, n) {
      let min = Infinity;
      for (const m of model.members) {
        if (m.a !== n.id && m.b !== n.id) continue;
        min = Math.min(min, BS.memberLength(model, m, nm));
      }
      const host = n.on && model.members.find((mm) => mm.id === n.on.member);
      if (host) min = Math.min(min, BS.memberLength(model, host, nm) * Math.min(n.on.t, 1 - n.on.t));
      return min;
    }

    nodeRadius() { return Math.max(3, Math.min(6, this.cam.scale * 0.005)); }

    drawNodes(st, posOf) {
      const ctx = this.ctx;
      const used = BS.usedNodes(st.model);
      const r = this.nodeRadius();
      for (const n of st.model.nodes) {
        const p = posOf(n);
        if (!p) continue;
        const x = this.sx(p.x); const y = this.sy(p.y);
        if (n.fixed) this.drawAnchor(x, y, r);
        const hot = (st.hover?.type === 'node' && st.hover.id === n.id) || (st.selection?.type === 'node' && st.selection.id === n.id);
        if (n.on) { this.diamond(x, y, (hot ? r + 2 : r) + 1.5, hot ? this.c.accent : this.c.sheet, this.c.ink); continue; }
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
      const w = 0.03 + 0.025 * Math.cbrt(mass);
      return { w, h: w * 0.62 };
    }

    /* Weight boxes. Side view: resting on the point. Top view: centred on it, seen from above. */
    drawWeights(st, items) {
      const ctx = this.ctx;
      const top = this.proj === 'top';
      for (const { load, pos } of items) {
        if (!pos) continue;
        const { w, h } = this.weightSize(load.mass);
        const pw = (top ? Math.min(w, st.model.width * 0.7) : w) * this.cam.scale;
        const ph = (top ? Math.min(w, st.model.width * 0.7) : h) * this.cam.scale;
        const x = this.sx(pos.x);
        const y = top ? this.sy(pos.z) + ph / 2 : this.sy(pos.y) - 4;
        const sel = st.selection?.type === 'load' && st.selection.id === load.id;
        const hov = st.hover?.type === 'load' && st.hover.id === load.id;
        ctx.fillStyle = rgb(this.c.ink, top ? 0.88 : 1);
        ctx.strokeStyle = rgb(sel || hov ? this.c.accent : this.c.ink);
        ctx.lineWidth = sel ? 3 : 1.5;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x - pw / 2, y - ph, pw, ph, 3); else ctx.rect(x - pw / 2, y - ph, pw, ph);
        ctx.fill(); ctx.stroke();
        const fs = Math.max(10, Math.min(16, ph * 0.38));
        ctx.font = `600 ${fs}px ${this.font.data}`;
        ctx.fillStyle = rgb(this.c.sheet);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(BS.kgLabel(load.mass), x, y - ph / 2);
        if (!top) {
          ctx.fillStyle = rgb(this.c.accent);
          ctx.beginPath(); ctx.moveTo(x, y + 4); ctx.lineTo(x - 4, y - 2); ctx.lineTo(x + 4, y - 2); ctx.closePath(); ctx.fill();
        } else {
          ctx.fillStyle = rgb(this.c.accent);
          ctx.beginPath(); ctx.arc(x, this.sy(pos.z), 3, 0, Math.PI * 2); ctx.fill();
        }
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
      const final = st.mode === 'results';
      for (const side of [1, 0]) {
        ctx.globalAlpha = side === 1 ? 0.4 : 1;
        for (const c of sim.members) {
          if (c.broken || c.side !== side) continue;
          ctx.strokeStyle = rgb(this.utilColor(final ? c.peakU : c.u));
          ctx.lineWidth = this.memberWidth(c.mat || sim.mat);
          if (st.highlight === c.key) {
            ctx.save();
            ctx.strokeStyle = rgb(this.c.accent, 0.35);
            ctx.lineWidth += 10;
            this.line(x[c.a], y[c.a], x[c.b], y[c.b]);
            ctx.restore();
          }
          this.line(x[c.a], y[c.a], x[c.b], y[c.b]);
        }
      }
      ctx.globalAlpha = 1;
      for (const d of sim.debris) {
        const hx = Math.cos(d.ang) * d.len / 2; const hy = Math.sin(d.ang) * d.len / 2;
        ctx.strokeStyle = rgb(this.c.bad, Math.min(1, d.life / 1.5) * (d.side === 1 ? 0.5 : 1));
        ctx.lineWidth = this.memberWidth(d.mat);
        this.line(d.x - hx, d.y - hy, d.x + hx, d.y + hy);
      }
      this.drawNodes(st, (n) => sim.nodePos(n.id, 0));
      this.drawWeights(st, sim.weights.map((w) => ({ load: w.load, pos: { x: x[w.p], y: y[w.p], z: w.z } })));
    }

    /* ------------------------------------------------------------------ */
    /* Top view. Truss members appear as lines along the two truss lines; the ones at the chosen
     * height (level) are drawn strongly, the rest faintly. Top-view pieces join the two lines. */
    drawPlan(st, live) {
      const ctx = this.ctx;
      const model = st.model;
      const nm = BS.nodeMap(model);
      const mat = BS.memberMat(model);
      const sim = live ? st.sim : null;
      const level = st.level;
      const atLevel = (id) => level != null && sameY(nm.get(id).y, level);
      const z = (s) => BS.sideZ(model, s);
      const X = (id, s) => (sim ? (sim.nodePos(id, s) || nm.get(id)).x : nm.get(id).x);
      const checks = st.mode === 'results' && !sim ? st.report?.checks : !sim && st.live ? st.liveChecks : null;
      const order = Renderer.brokenOrder(st.mode === 'results' ? st.sim : null);
      const simMember = sim ? sim.memberByKey : null;
      const colorFor = (key, base) => {
        if (sim) {
          const c = key.startsWith('p') ? sim.planById.get(+key.slice(1)) : simMember.get(key);
          return c ? this.utilColor(st.mode === 'results' ? c.peakU : c.u) : base;
        }
        const chk = checks?.get(key);
        return chk ? this.utilColor(chk.u) : base;
      };
      const isBroken = (key) => {
        if (sim) {
          const c = key.startsWith('p') ? sim.planById.get(+key.slice(1)) : simMember.get(key);
          return c?.broken;
        }
        return order.has(key);
      };

      // Faint: every truss member, both trusses.
      ctx.strokeStyle = rgb(this.c['ink-soft'], 0.35);
      ctx.lineWidth = 2;
      for (const m of model.members) {
        for (const s of [0, 1]) this.line(X(m.a, s), z(s), X(m.b, s), z(s));
      }
      // Faint: top-view pieces at other heights.
      ctx.setLineDash([5, 5]);
      for (const p of model.plan) {
        if (atLevel(p.a.n) && atLevel(p.b.n)) continue;
        ctx.strokeStyle = rgb(this.c['ink-soft'], 0.45);
        ctx.lineWidth = Math.max(1.5, this.memberWidth(mat, true) * 0.5);
        this.line(X(p.a.n, p.a.s), z(p.a.s), X(p.b.n, p.b.s), z(p.b.s));
      }
      ctx.setLineDash([]);

      // Strong: truss members lying flat at this height.
      const baseCol = this.matColor(mat);
      const hot = [];
      for (const m of model.members) {
        if (!atLevel(m.a) || !atLevel(m.b)) continue;
        for (const s of [0, 1]) {
          const key = `${m.id}:${s}`;
          const broken = isBroken(key);
          if (broken && sim) continue;
          if (this.isHot(st, 'member', m.id, s)) hot.push([X(m.a, s), z(s), X(m.b, s), z(s), this.memberWidth(mat)]);
          ctx.strokeStyle = rgb(colorFor(key, baseCol));
          ctx.lineWidth = this.memberWidth(mat);
          if (broken) ctx.setLineDash([ctx.lineWidth * 1.4, ctx.lineWidth * 1.4]);
          this.line(X(m.a, s), z(s), X(m.b, s), z(s));
          ctx.setLineDash([]);
        }
      }
      // Strong: top-view pieces at this height (all heights during the live test).
      for (const p of model.plan) {
        if (!sim && !(atLevel(p.a.n) && atLevel(p.b.n))) continue;
        const key = `p${p.id}`;
        const broken = isBroken(key);
        if (broken && sim) continue;
        const L = BS.planLength(model, p, nm);
        const tooLong = !checks && !sim && L > mat.maxLen + 1e-9;
        const coords = [X(p.a.n, p.a.s), z(p.a.s), X(p.b.n, p.b.s), z(p.b.s)];
        if (this.isHot(st, 'plan', p.id)) hot.push([...coords, this.memberWidth(mat, true)]);
        ctx.strokeStyle = rgb(tooLong ? this.c.bad : colorFor(key, baseCol));
        ctx.lineWidth = this.memberWidth(mat, true);
        if (broken || tooLong) ctx.setLineDash([ctx.lineWidth * 1.4, ctx.lineWidth * 1.4]);
        this.line(...coords);
        ctx.setLineDash([]);
      }
      for (const [x0, z0, x1, z1, w] of hot) {
        ctx.strokeStyle = rgb(this.c.accent, 0.4);
        ctx.lineWidth = w + 10;
        this.line(x0, z0, x1, z1);
      }

      this.drawPreview(st);

      // Joints: strong at this height, small dots elsewhere.
      const used = BS.usedNodes(model);
      const r = this.nodeRadius();
      for (const n of model.nodes) {
        if (!used.has(n.id)) continue;
        for (const s of [0, 1]) {
          const px = this.sx(X(n.id, s)); const py = this.sy(z(s));
          if (!atLevel(n.id) && !sim) {
            ctx.fillStyle = rgb(this.c['ink-soft'], 0.5);
            ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill();
            continue;
          }
          const hotJ = (st.hover?.type === 'joint' && st.hover.id === n.id && st.hover.side === s) ||
            (st.selection?.type === 'joint' && st.selection.id === n.id && st.selection.side === s);
          if (n.fixed) {
            ctx.fillStyle = rgb(this.c.ink);
            ctx.fillRect(px - r - 2, py - r - 2, 2 * r + 4, 2 * r + 4);
          }
          if (!sim && st.angles && (st.mode === 'build' || st.view === 'weak')) {
            const dirs = BS.planJointDirs(model, n.id, s, nm);
            let min = model.width;
            for (const m of model.members) {
              if ((m.a === n.id || m.b === n.id) && sameY(nm.get(m.a).y, nm.get(m.b).y)) min = Math.min(min, BS.memberLength(model, m, nm));
            }
            this.drawAngles(px, py, dirs, min * this.cam.scale);
          }
          if (n.on) { this.diamond(px, py, (hotJ ? r + 2 : r) + 1.5, hotJ ? this.c.accent : this.c.sheet, this.c.ink); continue; }
          ctx.beginPath();
          ctx.arc(px, py, hotJ ? r + 2 : r, 0, Math.PI * 2);
          ctx.fillStyle = rgb(hotJ ? this.c.accent : this.c.sheet);
          ctx.fill();
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = rgb(this.c.ink);
          ctx.stroke();
        }
      }

      if (sim) {
        this.drawWeights(st, sim.weights.map((w) => ({ load: w.load, pos: { x: sim.x[w.p], y: sim.y[w.p], z: w.z } })));
      } else {
        this.drawWeights(st, model.loads.map((l) => ({ load: l, pos: BS.loadPoint(model, l, nm) })));
      }

      if (st.mode === 'results' && st.report && !sim) {
        for (const [key, n] of order) {
          const pos = this.planKeyMid(model, nm, key, level);
          if (pos) this.drawBreakMark(this.sx(pos.x), this.sy(pos.z), n);
        }
        const shown = st.report.weak.filter((w) => w.u >= 0.25).slice(0, 6);
        for (const w of shown) {
          const pos = this.planKeyMid(model, nm, w.key, level);
          if (pos) this.drawBadge(this.sx(pos.x), this.sy(pos.z), w, st.highlight === w.key, order.has(w.key));
        }
      }
    }

    /* Midpoint (x, z) of an item drawn strongly in the top view at this level, else null. */
    planKeyMid(model, nm, key, level) {
      if (key.startsWith('p')) {
        const p = model.plan.find((pp) => pp.id === +key.slice(1));
        if (!p || !sameY(nm.get(p.a.n).y, level) || !sameY(nm.get(p.b.n).y, level)) return null;
        return { x: (nm.get(p.a.n).x + nm.get(p.b.n).x) / 2, z: (BS.sideZ(model, p.a.s) + BS.sideZ(model, p.b.s)) / 2 };
      }
      const [id, s] = key.split(':').map(Number);
      const m = model.members.find((mm) => mm.id === id);
      if (!m || !sameY(nm.get(m.a).y, level) || !sameY(nm.get(m.b).y, level)) return null;
      return { x: (nm.get(m.a).x + nm.get(m.b).x) / 2, z: BS.sideZ(model, s) };
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
