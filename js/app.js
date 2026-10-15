/* Editor, simulation loop and panels.
 * Side view: draw the truss (used for both the front and back trusses), anchors and weights.
 * Top view: pick a height, then join the two trusses with cross pieces and bracing, and place
 * weights anywhere across the deck. */
(function () {
  'use strict';
  const BS = window.BS;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'bridge-load-lab:v3';
  const LEGACY_KEY = 'bridge-load-lab:v2';

  const S = {
    model: null,
    mode: 'build',          // build | sim | results
    proj: 'side',           // side | top
    level: 0,               // height (m) being edited in the top view
    tool: 'build',
    mass: 10,
    snap: true,
    live: false,
    liveChecks: null,
    mechanismNode: null,
    hover: null,
    selection: null,
    preview: null,
    highlight: null,
    tooltip: null,
    drag: null,
    sim: null,
    report: null,
    view: 'weak',
    paused: false,
    slow: false,
    undo: [],
    redo: [],
    pending: null,
    clock: 0,
    doneAt: null,
  };

  const app = $('app');
  const canvas = $('view');
  const R = new BS.Renderer(canvas);
  const sameY = (a, b) => Math.abs(a - b) < 1e-6;

  /* ---------------- Persistence & history ---------------- */
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S.model)); } catch (e) { /* storage unavailable */ }
  }
  function loadSaved() {
    try {
      let raw = localStorage.getItem(STORE_KEY);
      if (!raw) raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return null;
      const m = JSON.parse(raw);
      if (!validModel(m)) return null;
      // Designs saved with the earlier default piece (basswood 1 x 0.3 cm) move to the 1 x 1 cm balsa stick.
      const p = m.piece;
      if (p.material === 'basswood' && p.width === 0.01 && p.thick === 0.003 && p.maxLen === 0.3) m.piece = { ...BS.DEFAULT_PIECE };
      return BS.upgradeModel(m);
    } catch (e) { return null; }
  }
  function validModel(m) {
    return m && Array.isArray(m.nodes) && Array.isArray(m.members) && Array.isArray(m.loads) &&
      typeof m.gap === 'number' && m.piece && BS.MATERIALS[m.piece.material] &&
      [m.piece.width, m.piece.thick, m.piece.maxLen].every((v) => typeof v === 'number' && v > 0) &&
      (m.plan == null || Array.isArray(m.plan));
  }
  function snapshot() { return JSON.stringify(S.model); }
  function pushUndo(snap) {
    S.undo.push(snap || snapshot());
    if (S.undo.length > 120) S.undo.shift();
    S.redo.length = 0;
    updateHistoryButtons();
  }
  function undo() {
    if (!S.undo.length) return;
    S.redo.push(snapshot());
    S.model = JSON.parse(S.undo.pop());
    S.selection = null;
    changed();
  }
  function redo() {
    if (!S.redo.length) return;
    S.undo.push(snapshot());
    S.model = JSON.parse(S.redo.pop());
    S.selection = null;
    changed();
  }
  function updateHistoryButtons() {
    $('undo').disabled = !S.undo.length || S.mode === 'sim';
    $('redo').disabled = !S.redo.length || S.mode === 'sim';
  }

  /* Call after any edit to the model. */
  function changed() {
    save();
    if (S.selection && !selectionExists(S.selection)) S.selection = null;
    refreshLive();
    renderStats();
    renderSelection();
    renderLevels();
    updateHistoryButtons();
    syncSiteControls();
    syncPieceControls();
  }

  function selectionExists(sel) {
    const m = S.model;
    if (sel.type === 'node' || sel.type === 'joint') return m.nodes.some((o) => o.id === sel.id);
    const list = sel.type === 'member' ? m.members : sel.type === 'plan' ? m.plan : m.loads;
    return list.some((o) => o.id === sel.id);
  }

  function refreshLive() {
    S.liveChecks = null;
    S.mechanismNode = null;
    if (!S.live || S.mode !== 'build') { $('legend').hidden = S.mode !== 'results' || S.view !== 'weak'; return; }
    const rep = BS.buildReport(S.model);
    S.liveChecks = rep.checks;
    if (!rep.static.ok && rep.static.reason === 'mechanism') S.mechanismNode = rep.static.nodeId;
    $('legend').hidden = false;
  }

  /* ---------------- Toast & hint ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }

  const HINTS = {
    side: {
      build: 'Drag from point to point to add a piece. This truss is used for both the front and back of the bridge. Joints on the tables become anchors.',
      select: 'Drag joints or weights to move them. Click a member to see its length and limits. Drag empty space to pan.',
      weight: 'Click a joint or a beam. Weights placed here sit in the middle of the deck, shared by both trusses.',
      anchor: 'Click a joint on a table, the floor or the support block to pin it or release it. Click a surface to add an anchor.',
      erase: 'Click or drag across members, joints and weights to delete them.',
    },
    top: {
      build: 'Pick a height above, then drag from a joint on one truss to a joint on the other to add a cross piece or brace.',
      select: 'Click a top-view piece, joint or weight to inspect it. Drag weights to move them across the deck.',
      weight: 'Click a cross piece, brace or joint to place the weight exactly there across the deck.',
      anchor: 'Anchors are set in the side view.',
      erase: 'Click or drag across top-view pieces and weights to delete them.',
    },
    sim: 'Load test running. Colours show how close each member is to its limit. The back truss is drawn faintly behind the front.',
    results: 'Hover a member to see its force and limit. Numbered badges mark the weakest members.',
  };
  function updateHint() {
    $('hint').textContent = S.mode === 'build' ? HINTS[S.proj][S.tool] : HINTS[S.mode];
  }

  /* ---------------- Toolbar ---------------- */
  function setTool(tool) {
    if (S.mode !== 'build') enterBuild();
    S.tool = tool;
    S.preview = null;
    app.dataset.tool = tool;
    document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
    updateHint();
  }

  function setProj(proj) {
    S.proj = proj;
    R.proj = proj;
    S.preview = null;
    S.drag = null;
    S.hover = null;
    S.tooltip = null;
    document.querySelectorAll('#projSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.proj === proj)));
    renderLevels();
    updateHint();
  }

  function renderLevels() {
    const levels = BS.levelsOf(S.model);
    if (!levels.some((y) => sameY(y, S.level))) {
      S.level = levels.find((y) => sameY(y, 0)) ?? levels[levels.length - 1] ?? 0;
    }
    const bar = $('levelBar');
    bar.hidden = S.proj !== 'top' || S.mode === 'sim';
    if (bar.hidden) return;
    const nm = BS.nodeMap(S.model);
    const used = BS.usedNodes(S.model);
    $('levels').innerHTML = levels.map((y) => {
      const joints = S.model.nodes.filter((n) => used.has(n.id) && sameY(n.y, y)).length;
      const pieces = S.model.plan.filter((p) => sameY(nm.get(p.a.n).y, y) && sameY(nm.get(p.b.n).y, y)).length;
      const tag = sameY(y, 0) ? 'deck' : `${joints} joint${joints > 1 ? 's' : ''}`;
      return `<button type="button" data-y="${y}" aria-pressed="${sameY(y, S.level)}" title="${pieces} top-view piece${pieces === 1 ? '' : 's'} at this height">${(y * 100).toFixed(1)} cm<small>${tag}</small></button>`;
    }).join('');
  }
  $('levels').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-y]');
    if (!b) return;
    S.level = +b.dataset.y;
    renderLevels();
  });

  /* ---------------- Geometry helpers ---------------- */
  const NODE_PX = 11;
  const MEMBER_PX = 8;

  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax; const dy = by - ay;
    const L2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
  }

  function hitTest(px, py, opts = {}) {
    return S.proj === 'top' ? hitTop(px, py, opts) : hitSide(px, py, opts);
  }

  /* Side view hit-test in screen pixels. */
  function hitSide(px, py, opts) {
    const model = S.model;
    const nm = BS.nodeMap(model);
    if (!opts.noLoads) {
      for (let i = model.loads.length - 1; i >= 0; i--) {
        const l = model.loads[i];
        const p = BS.loadPoint(model, l, nm);
        if (!p) continue;
        const { w, h } = R.weightSize(l.mass);
        const x = R.sx(p.x); const y = R.sy(p.y) - 4;
        const pw = w * R.cam.scale; const ph = h * R.cam.scale;
        if (px >= x - pw / 2 && px <= x + pw / 2 && py >= y - ph && py <= y) return { type: 'load', id: l.id };
      }
    }
    let best = null; let bd = NODE_PX;
    for (const n of model.nodes) {
      if (opts.exclude === n.id) continue;
      const d = Math.hypot(R.sx(n.x) - px, R.sy(n.y) - py);
      if (d < bd) { bd = d; best = { type: 'node', id: n.id }; }
    }
    if (best) return best;
    bd = MEMBER_PX;
    for (const m of model.members) {
      const a = nm.get(m.a); const b = nm.get(m.b);
      const r = distToSeg(px, py, R.sx(a.x), R.sy(a.y), R.sx(b.x), R.sy(b.y));
      if (r.d < bd) { bd = r.d; best = { type: 'member', id: m.id, t: r.t }; }
    }
    return best;
  }

  /* Top view hit-test: weights, joints at the chosen height, top-view pieces and flat chords there. */
  function hitTop(px, py, opts) {
    const model = S.model;
    const nm = BS.nodeMap(model);
    const z = (s) => BS.sideZ(model, s);
    const at = (id) => sameY(nm.get(id).y, S.level);
    if (!opts.noLoads) {
      for (let i = model.loads.length - 1; i >= 0; i--) {
        const l = model.loads[i];
        const p = BS.loadPoint(model, l, nm);
        if (!p) continue;
        const size = Math.min(R.weightSize(l.mass).w, model.width * 0.7) * R.cam.scale;
        if (Math.abs(px - R.sx(p.x)) <= size / 2 && Math.abs(py - R.sy(p.z)) <= size / 2) return { type: 'load', id: l.id };
      }
    }
    const used = BS.usedNodes(model);
    let best = null; let bd = NODE_PX;
    for (const n of model.nodes) {
      if (!used.has(n.id) || !at(n.id)) continue;
      for (const s of [0, 1]) {
        if (opts.exclude && opts.exclude.n === n.id && opts.exclude.s === s) continue;
        const d = Math.hypot(R.sx(n.x) - px, R.sy(z(s)) - py);
        if (d < bd) { bd = d; best = { type: 'joint', id: n.id, side: s }; }
      }
    }
    if (best) return best;
    bd = MEMBER_PX;
    for (const p of model.plan) {
      if (!at(p.a.n) || !at(p.b.n)) continue;
      const a = nm.get(p.a.n); const b = nm.get(p.b.n);
      const r = distToSeg(px, py, R.sx(a.x), R.sy(z(p.a.s)), R.sx(b.x), R.sy(z(p.b.s)));
      if (r.d < bd) { bd = r.d; best = { type: 'plan', id: p.id, t: r.t }; }
    }
    if (best) return best;
    for (const m of model.members) {
      if (!at(m.a) || !at(m.b)) continue;
      const a = nm.get(m.a); const b = nm.get(m.b);
      for (const s of [0, 1]) {
        const r = distToSeg(px, py, R.sx(a.x), R.sy(z(s)), R.sx(b.x), R.sy(z(s)));
        if (r.d < bd) { bd = r.d; best = { type: 'member', id: m.id, side: s, t: r.t }; }
      }
    }
    return best;
  }

  function snapWorld(px, py) {
    let x = R.wx(px); let y = R.wy(py);
    if (S.snap) { x = Math.round(x * 100) / 100; y = Math.round(y * 100) / 100; }
    return { x: +x.toFixed(4), y: +y.toFixed(4) };
  }

  /* A point for building in the side view: an existing joint if close, otherwise a grid point. */
  function buildPoint(px, py, exclude) {
    const hit = hitSide(px, py, { noLoads: true, exclude });
    if (hit?.type === 'node') {
      const n = S.model.nodes.find((nn) => nn.id === hit.id);
      return { x: n.x, y: n.y, node: n };
    }
    const w = snapWorld(px, py);
    const existing = BS.findNode(S.model, w.x, w.y, 1e-6);
    return existing ? { x: existing.x, y: existing.y, node: existing } : w;
  }

  function validateMember(p0, p1) {
    const mat = BS.memberMat(S.model);
    const L = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const base = { x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y };
    if (L < 0.005) return { ...base, valid: false, reason: '' };
    if (L > mat.maxLen + 1e-9) return { ...base, valid: false, reason: `${BS.cm(L)} · longer than your ${BS.cm(mat.maxLen)} stick` };
    if (p0.node && p1.node && BS.findMemberBetween(S.model, p0.node.id, p1.node.id)) return { ...base, valid: false, reason: 'Already connected' };
    return { ...base, valid: true };
  }

  /* Top-view piece from joint a to joint b ({n, s, x, z}). */
  function validatePlan(a, b) {
    const mat = BS.memberMat(S.model);
    const base = { x0: a.x, y0: a.z, x1: b.x, y1: b.z, flat: true };
    if (!b.n) return { ...base, valid: false, reason: '' };
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (a.s === b.s) return { ...base, len, valid: false, reason: 'End on the other truss line' };
    if (len > mat.maxLen + 1e-9) return { ...base, len, valid: false, reason: `${BS.cm(len)} · longer than your ${BS.cm(mat.maxLen)} stick` };
    if (BS.findPlanBetween(S.model, { n: a.n, s: a.s }, { n: b.n, s: b.s })) return { ...base, len, valid: false, reason: 'Already connected' };
    return { ...base, len, valid: true };
  }

  function jointPoint(hit) {
    const n = S.model.nodes.find((nn) => nn.id === hit.id);
    return { n: n.id, s: hit.side, x: n.x, z: BS.sideZ(S.model, hit.side) };
  }

  function nodeFor(pt) {
    if (pt.node) return pt.node;
    const terrain = BS.terrainOf(S.model);
    return BS.addNode(S.model, pt.x, pt.y, BS.onTerrain(terrain, pt.x, pt.y));
  }

  /* ---------------- Pointer input ---------------- */
  const pointers = new Map();
  let pinch = null;
  let spaceDown = false;

  function localXY(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = localXY(e);
    pointers.set(e.pointerId, p);
    S.tooltip = null;

    if (pointers.size === 2) {
      // Abandon any single-finger gesture and start pinch-zoom.
      if (S.drag?.snap && S.drag.moved) { S.model = JSON.parse(S.drag.snap); changed(); }
      S.drag = null; S.preview = null;
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      return;
    }
    if (pointers.size > 2) return;

    if (e.button === 1 || e.button === 2 || spaceDown || S.mode === 'sim' || (S.mode === 'results' && e.pointerType !== 'mouse')) {
      S.drag = { kind: 'pan', last: p };
      return;
    }
    if (S.mode === 'results') {
      const key = hitKey(hitTest(p.x, p.y, { noLoads: true }));
      if (key) { S.highlight = key; markWeakItem(key); }
      else S.drag = { kind: 'pan', last: p };
      return;
    }
    toolDown(p);
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = localXY(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2; const cy = (a.y + b.y) / 2;
      zoomAt(cx, cy, d / pinch.d);
      R.cam.x -= (cx - pinch.cx) / R.cam.scale;
      R.cam.y += (cy - pinch.cy) / R.cam.scale;
      pinch = { d, cx, cy };
      return;
    }
    const drag = S.drag;
    if (drag?.kind === 'pan') {
      R.cam.x -= (p.x - drag.last.x) / R.cam.scale;
      R.cam.y += (p.y - drag.last.y) / R.cam.scale;
      drag.last = p;
      return;
    }
    if (drag) { toolMove(p); return; }
    updateHover(p);
  });

  function endPointer(e) {
    const p = localXY(e);
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (S.drag && S.drag.kind !== 'pan') toolUp(p);
    S.drag = null;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    pinch = null;
    S.drag = null;
    S.preview = null;
  });
  canvas.addEventListener('pointerleave', () => { if (!S.drag) { S.hover = null; S.tooltip = null; } });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = localXY(e);
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  function zoomAt(px, py, f) {
    const wx = R.wx(px); const wy = R.wy(py);
    R.cam.scale = Math.max(100, Math.min(20000, R.cam.scale * f));
    R.cam.x = wx - (px - R.w / 2) / R.cam.scale;
    R.cam.y = wy + (py - R.h / 2) / R.cam.scale;
  }

  /* The report key for a hit (worst truss for a side-view member). */
  function hitKey(hit) {
    if (!hit) return null;
    if (hit.type === 'plan') return `p${hit.id}`;
    if (hit.type !== 'member') return null;
    if (hit.side != null) return `${hit.id}:${hit.side}`;
    const checks = S.mode === 'results' ? S.report?.checks : S.liveChecks;
    const a = checks?.get(`${hit.id}:0`); const b = checks?.get(`${hit.id}:1`);
    return b && (!a || b.u > a.u) ? `${hit.id}:1` : `${hit.id}:0`;
  }

  function updateHover(p) {
    if (S.mode === 'sim' || (S.mode === 'results' && S.view === 'final')) { S.hover = null; S.tooltip = null; return; }
    const hit = hitTest(p.x, p.y, { noLoads: S.mode === 'results' });
    S.hover = hit;
    if (S.mode === 'build' && S.tool === 'build') S.hover = hit?.type === 'node' || hit?.type === 'joint' ? hit : null;
    S.tooltip = null;
    const showTips = S.mode === 'results' || S.tool === 'select' || S.live;
    if (showTips && hit?.type === 'member') S.tooltip = { x: p.x, y: p.y, lines: memberLines(hit.id, hit.side) };
    if (showTips && hit?.type === 'plan') S.tooltip = { x: p.x, y: p.y, lines: planLines(hit.id) };
    if (S.mode === 'results') {
      S.highlight = hitKey(hit);
      markWeakItem(S.highlight);
    }
  }

  const fmtN = BS.newtons;
  const fmtNcm = (M) => `${(M * 100).toFixed(1)} N·cm`;
  const currentChecks = () => (S.mode === 'results' ? S.report?.checks : S.liveChecks);

  function checkLines(chk) {
    const lines = [];
    if (chk.N != null) {
      const kind = chk.N >= 0 ? 'tension' : 'compression';
      if (chk.kind !== 'plan') lines.push(`Force   ${fmtN(chk.N)} ${kind}`);
      if (chk.M > 1e-4) lines.push(`Moment  ${fmtNcm(chk.M)}`);
      lines.push(`Used    ${Math.round(chk.u * 100)}%  (${BS.MODE_LABEL[chk.mode].toLowerCase()})`);
    } else {
      lines.push(`Peak    ${Math.round(chk.u * 100)}% in live test`);
    }
    return lines;
  }

  function brokeLine(key) {
    const i = S.mode === 'results' && S.sim ? S.sim.events.findIndex((e) => e.key === key) : -1;
    return i >= 0 ? [`Broke #${i + 1} at ${S.sim.events[i].time.toFixed(2)} s`] : [];
  }

  function memberLines(id, side) {
    const m = S.model.members.find((mm) => mm.id === id);
    if (!m) return [];
    const mat = BS.memberMat(S.model);
    const L = BS.memberLength(S.model, m);
    const sides = side == null ? [0, 1] : [side];
    const lines = [`M${m.id} · ${BS.cm(L)}${side == null ? '' : ` · ${BS.sideName(side)} truss`}`];
    const checks = currentChecks();
    if (checks) {
      for (const s of sides) {
        const chk = checks.get(`${id}:${s}`);
        if (!chk) continue;
        if (sides.length > 1) lines.push(`${BS.sideName(s).toUpperCase()} TRUSS`);
        lines.push(...checkLines(chk));
        if (chk.Lout > L + 1e-9) lines.push(`Can bow sideways over ${BS.cm(chk.Lout)}`);
        lines.push(...brokeLine(`${id}:${s}`));
      }
    } else {
      lines.push(`Tension limit  ${fmtN(BS.tensionCapacity(mat))}`);
      lines.push(`Push limit     ${fmtN(BS.compressionCapacity(mat, L))}`);
      if (L > mat.maxLen + 1e-9) lines.push(`Longer than your ${BS.cm(mat.maxLen)} stick`);
    }
    return lines;
  }

  function planLines(id) {
    const p = S.model.plan.find((pp) => pp.id === id);
    if (!p) return [];
    const mat = BS.memberMat(S.model);
    const L = BS.planLength(S.model, p);
    const lines = [`P${p.id} · ${BS.cm(L)} · top-view piece`];
    const chk = currentChecks()?.get(`p${id}`);
    if (chk) lines.push(...checkLines(chk), ...brokeLine(`p${id}`));
    else lines.push(`Bending limit  ${fmtNcm(BS.bendingCapacity(mat, true))}`);
    return lines;
  }

  /* ---------------- Tools ---------------- */
  function toolDown(p) {
    if (S.proj === 'top') { topToolDown(p); return; }
    const tool = S.tool;
    if (tool === 'build') {
      S.drag = { kind: 'build', start: buildPoint(p.x, p.y) };
      S.preview = null;
      return;
    }
    if (tool === 'select') {
      const hit = hitTest(p.x, p.y);
      if (hit?.type === 'node') {
        select(hit);
        const n = S.model.nodes.find((nn) => nn.id === hit.id);
        S.drag = { kind: 'moveNode', node: n, snap: snapshot(), moved: false };
      } else if (hit?.type === 'load') {
        select(hit);
        S.drag = { kind: 'moveLoad', load: S.model.loads.find((l) => l.id === hit.id), snap: snapshot(), moved: false };
      } else if (hit?.type === 'member') {
        select(hit);
      } else {
        select(null);
        S.drag = { kind: 'pan', last: p };
      }
      return;
    }
    if (tool === 'weight') {
      const hit = hitTest(p.x, p.y);
      if (hit?.type === 'load') {
        select(hit);
        S.drag = { kind: 'moveLoad', load: S.model.loads.find((l) => l.id === hit.id), snap: snapshot(), moved: false };
        return;
      }
      placeLoad(loadTarget(hit));
      return;
    }
    if (tool === 'anchor') {
      const hit = hitTest(p.x, p.y, { noLoads: true });
      const terrain = BS.terrainOf(S.model);
      if (hit?.type === 'node') {
        const n = S.model.nodes.find((nn) => nn.id === hit.id);
        if (!n.fixed && !BS.onTerrain(terrain, n.x, n.y)) { toast('Anchors must sit on a table, the floor or the support block.'); return; }
        pushUndo();
        n.fixed = !n.fixed;
        if (!n.fixed) BS.pruneOrphans(S.model);
        changed();
        return;
      }
      const w = snapWorld(p.x, p.y);
      if (!BS.onTerrain(terrain, w.x, w.y)) { toast('Anchors must sit on a table, the floor or the support block.'); return; }
      pushUndo();
      BS.addNode(S.model, w.x, w.y, true);
      changed();
      return;
    }
    if (tool === 'erase') {
      S.drag = { kind: 'erase', snap: snapshot(), moved: false };
      eraseAt(p);
    }
  }

  function topToolDown(p) {
    const tool = S.tool;
    if (tool === 'build') {
      const hit = hitTop(p.x, p.y, { noLoads: true });
      if (hit?.type !== 'joint') {
        if (!BS.levelsOf(S.model).length) toast('Build a truss in the side view first. Its joints appear here.');
        else toast('Start on a joint. Pick another height above to see its joints.');
        return;
      }
      S.drag = { kind: 'plan', start: jointPoint(hit) };
      S.preview = null;
      return;
    }
    if (tool === 'select' || tool === 'weight') {
      const hit = hitTop(p.x, p.y, {});
      if (hit?.type === 'load') {
        select(hit);
        S.drag = { kind: 'moveLoad', load: S.model.loads.find((l) => l.id === hit.id), snap: snapshot(), moved: false };
        return;
      }
      if (tool === 'weight') { placeLoad(loadTargetTop(hit)); return; }
      if (hit) select(hit);
      else { select(null); S.drag = { kind: 'pan', last: p }; }
      return;
    }
    if (tool === 'anchor') { toast('Anchors are set in the side view.'); return; }
    if (tool === 'erase') {
      S.drag = { kind: 'erase', snap: snapshot(), moved: false };
      eraseAt(p);
    }
  }

  function placeLoad(target) {
    if (!target) return;
    pushUndo();
    const load = { id: S.model.nextId++, mass: S.mass };
    applyTarget(load, target);
    S.model.loads.push(load);
    select({ type: 'load', id: load.id });
    changed();
  }

  /* Side view: weights sit in the middle of the deck (shared by both trusses). */
  function loadTarget(hit, quiet) {
    if (!hit || hit.type === 'load') { if (!quiet) toast('Click a joint or a beam to place the weight.'); return null; }
    if (hit.type === 'node') {
      const used = S.model.members.some((m) => m.a === hit.id || m.b === hit.id);
      if (!used) { if (!quiet) toast('That joint is not connected to anything yet.'); return null; }
      return { node: hit.id };
    }
    const m = S.model.members.find((mm) => mm.id === hit.id);
    if (hit.t < 0.08) return { node: m.a };
    if (hit.t > 0.92) return { node: m.b };
    return { member: m.id, t: Math.round(hit.t * 20) / 20 };
  }

  /* Top view: weights sit exactly where you click across the deck. */
  function loadTargetTop(hit, quiet) {
    if (!hit || hit.type === 'load') { if (!quiet) toast('Click a cross piece, brace or joint to place the weight.'); return null; }
    if (hit.type === 'joint') return { node: hit.id, side: hit.side };
    if (hit.type === 'plan') {
      const p = S.model.plan.find((pp) => pp.id === hit.id);
      if (hit.t < 0.08) return { node: p.a.n, side: p.a.s };
      if (hit.t > 0.92) return { node: p.b.n, side: p.b.s };
      return { plan: p.id, t: Math.round(hit.t * 20) / 20 };
    }
    const m = S.model.members.find((mm) => mm.id === hit.id);
    if (hit.t < 0.08) return { node: m.a, side: hit.side };
    if (hit.t > 0.92) return { node: m.b, side: hit.side };
    return { member: m.id, t: Math.round(hit.t * 20) / 20, side: hit.side };
  }

  function applyTarget(load, target) {
    for (const k of ['node', 'member', 't', 'side', 'plan']) delete load[k];
    Object.assign(load, target);
  }
  const sameTarget = (load, target) => ['node', 'member', 't', 'side', 'plan'].every((k) => load[k] === target[k]);

  let eraseWarned = false;
  function eraseAt(p) {
    const hit = hitTest(p.x, p.y);
    if (!hit) return;
    if (S.proj === 'top' && (hit.type === 'joint' || hit.type === 'member')) {
      if (!eraseWarned) toast('Truss joints and members are deleted in the side view.');
      eraseWarned = true;
      return;
    }
    if (!S.drag.moved) { pushUndo(S.drag.snap); S.drag.moved = true; }
    if (hit.type === 'load') BS.removeLoad(S.model, hit.id);
    else if (hit.type === 'node') BS.removeNode(S.model, hit.id);
    else if (hit.type === 'plan') BS.removePlan(S.model, hit.id);
    else { BS.removeMember(S.model, hit.id); BS.pruneOrphans(S.model); }
    changed();
  }

  function toolMove(p) {
    const d = S.drag;
    if (d.kind === 'build') {
      const end = buildPoint(p.x, p.y, d.start.node?.id);
      d.end = end;
      S.preview = validateMember(d.start, end);
      if (S.preview.x0 === S.preview.x1 && S.preview.y0 === S.preview.y1) S.preview = null;
      return;
    }
    if (d.kind === 'plan') {
      const hit = hitTop(p.x, p.y, { noLoads: true, exclude: { n: d.start.n, s: d.start.s } });
      d.end = hit?.type === 'joint' ? jointPoint(hit) : { x: R.wx(p.x), z: R.wy(p.y) };
      S.preview = validatePlan(d.start, d.end);
      return;
    }
    if (d.kind === 'moveNode') {
      const w = snapWorld(p.x, p.y);
      const n = d.node;
      if (w.x === n.x && w.y === n.y) return;
      const other = BS.findNode(S.model, w.x, w.y, 1e-6);
      if (other && other !== n) return;
      const ox = n.x; const oy = n.y;
      n.x = w.x; n.y = w.y;
      const nm = BS.nodeMap(S.model);
      const maxLen = BS.memberMat(S.model).maxLen + 1e-9;
      const tooLong = S.model.members.some((m) => (m.a === n.id || m.b === n.id) && BS.memberLength(S.model, m, nm) > maxLen) ||
        S.model.plan.some((pp) => (pp.a.n === n.id || pp.b.n === n.id) && BS.planLength(S.model, pp, nm) > maxLen);
      if (tooLong) { n.x = ox; n.y = oy; return; }
      if (n.fixed && !BS.onTerrain(BS.terrainOf(S.model), n.x, n.y)) n.fixed = false;
      if (!d.moved) { pushUndo(d.snap); d.moved = true; }
      changed();
      return;
    }
    if (d.kind === 'moveLoad') {
      const hit = hitTest(p.x, p.y, { noLoads: true });
      const target = S.proj === 'top' ? loadTargetTop(hit, true) : loadTarget(hit, true);
      if (!target || sameTarget(d.load, target)) return;
      if (!d.moved) { pushUndo(d.snap); d.moved = true; }
      applyTarget(d.load, target);
      changed();
      return;
    }
    if (d.kind === 'erase') eraseAt(p);
  }

  function toolUp() {
    const d = S.drag;
    eraseWarned = false;
    if (d.kind === 'build') {
      const pv = S.preview;
      S.preview = null;
      if (pv?.valid) {
        pushUndo();
        const a = nodeFor(d.start);
        const b = nodeFor(d.end);
        BS.addMember(S.model, a.id, b.id);
        changed();
      } else if (pv?.reason) {
        toast(pv.reason);
      } else if (d.start.node) {
        select({ type: 'node', id: d.start.node.id });
      }
    }
    if (d.kind === 'plan') {
      const pv = S.preview;
      S.preview = null;
      if (pv?.valid) {
        pushUndo();
        const p = BS.addPlan(S.model, { n: d.start.n, s: d.start.s }, { n: d.end.n, s: d.end.s });
        changed();
        if (p) select({ type: 'plan', id: p.id });
      } else if (pv?.reason) {
        toast(pv.reason);
      } else {
        select({ type: 'joint', id: d.start.n, side: d.start.s });
      }
    }
  }

  function select(sel) {
    S.selection = sel ? { type: sel.type, id: sel.id, side: sel.side } : null;
    renderSelection();
  }

  /* ---------------- Keyboard ---------------- */
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (S.mode === 'build') (e.shiftKey ? redo : undo)(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); if (S.mode === 'build') redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === ' ') { spaceDown = true; e.preventDefault(); return; }
    if (k === 'enter') { e.preventDefault(); if (S.mode === 'build') startSim(); return; }
    if (k === 't') { setProj(S.proj === 'side' ? 'top' : 'side'); return; }
    if (k === 'escape') {
      if (S.mode === 'sim') stopSim();
      else if (S.mode === 'results') enterBuild();
      else { S.drag = null; S.preview = null; select(null); }
      return;
    }
    if ((k === 'delete' || k === 'backspace') && S.selection && S.mode === 'build') { deleteSelection(); return; }
    const tools = { b: 'build', v: 'select', w: 'weight', a: 'anchor', e: 'erase' };
    if (tools[k]) setTool(tools[k]);
  });
  window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });

  function deleteSelection() {
    const sel = S.selection;
    if (!sel) return;
    if (sel.type === 'joint') { toast('Truss joints are deleted in the side view.'); return; }
    pushUndo();
    if (sel.type === 'node') BS.removeNode(S.model, sel.id);
    else if (sel.type === 'member') { BS.removeMember(S.model, sel.id); BS.pruneOrphans(S.model); }
    else if (sel.type === 'plan') BS.removePlan(S.model, sel.id);
    else BS.removeLoad(S.model, sel.id);
    S.selection = null;
    changed();
  }

  /* ---------------- Panels ---------------- */
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  const massLabel = BS.kgLabel;

  function renderStats() {
    const st = BS.designStats(S.model);
    const rows = [
      ['Sticks', `${st.members} (${st.plan} in top view)`],
      ['Joints', st.joints],
      ['Total length cut', BS.cm(st.length, 0)],
      ['Bridge mass', `${(st.mass * 1000).toFixed(1)} g`],
      ['Weight on bridge', st.load ? massLabel(st.load) : 'none yet'],
    ];
    if (st.overLong) rows.push(['Longer than one stick', `${st.overLong}`]);
    $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  function utilRow(key) {
    const chk = S.liveChecks?.get(key);
    return chk ? `<dt>Utilisation now</dt><dd>${Math.round(chk.u * 100)}%</dd>` : '';
  }

  function renderSelection() {
    const block = $('selBlock');
    const sel = S.selection;
    const body = $('selBody');
    syncMassField();
    if (!sel || S.mode !== 'build') { block.hidden = true; return; }
    block.hidden = false;
    const nm = BS.nodeMap(S.model);
    const mat = BS.memberMat(S.model);
    if (sel.type === 'member') {
      const m = S.model.members.find((mm) => mm.id === sel.id);
      const L = BS.memberLength(S.model, m, nm);
      const c = BS.compression(mat, L);
      $('selTitle').textContent = `Member M${m.id}`;
      body.innerHTML = `
        <p class="note">In both the front and back trusses.</p>
        <dl class="kv">
          <dt>Length</dt><dd>${BS.cm(L)}${L > mat.maxLen + 1e-9 ? ' (too long)' : ''}</dd>
          <dt>Mass (each)</dt><dd>${(BS.linearMass(mat) * L * 1000).toFixed(2)} g</dd>
          <dt>Tension limit</dt><dd>${fmtN(BS.tensionCapacity(mat))}</dd>
          <dt>Compression limit</dt><dd>${fmtN(c.cap)} (${BS.MODE_LABEL[c.mode].toLowerCase()})</dd>
          <dt>Bending limit</dt><dd>${fmtNcm(BS.bendingCapacity(mat))}</dd>
          ${utilRow(`${m.id}:0`).replace('Utilisation now', 'Front truss now')}
          ${utilRow(`${m.id}:1`).replace('Utilisation now', 'Back truss now')}
        </dl>
        <div class="sel-actions"><button type="button" class="ghost danger" id="selDel">Delete member</button></div>`;
    } else if (sel.type === 'plan') {
      const p = S.model.plan.find((pp) => pp.id === sel.id);
      const L = BS.planLength(S.model, p, nm);
      $('selTitle').textContent = `Top-view piece P${p.id}`;
      body.innerHTML = `
        <dl class="kv">
          <dt>Joins</dt><dd>J${p.a.n} ${BS.sideName(p.a.s)} → J${p.b.n} ${BS.sideName(p.b.s)}</dd>
          <dt>Height</dt><dd>${BS.cm(nm.get(p.a.n).y)}</dd>
          <dt>Length</dt><dd>${BS.cm(L)}${L > mat.maxLen + 1e-9 ? ' (too long)' : ''}</dd>
          <dt>Mass</dt><dd>${(BS.linearMass(mat) * L * 1000).toFixed(2)} g</dd>
          <dt>Bending limit</dt><dd>${fmtNcm(BS.bendingCapacity(mat, true))}</dd>
          ${utilRow(`p${p.id}`)}
        </dl>
        <div class="sel-actions"><button type="button" class="ghost danger" id="selDel">Delete piece</button></div>`;
    } else if (sel.type === 'node' || sel.type === 'joint') {
      const n = nm.get(sel.id);
      const ground = BS.onTerrain(BS.terrainOf(S.model), n.x, n.y);
      const deg = S.model.members.filter((m) => m.a === n.id || m.b === n.id).length;
      const plans = S.model.plan.filter((p) => (p.a.n === n.id && (sel.side == null || p.a.s === sel.side)) || (p.b.n === n.id && (sel.side == null || p.b.s === sel.side))).length;
      $('selTitle').textContent = `Joint J${n.id}${sel.side == null ? '' : ` · ${BS.sideName(sel.side)} truss`}`;
      body.innerHTML = `
        <dl class="kv">
          <dt>Position</dt><dd>${(n.x * 100).toFixed(1)}, ${(n.y * 100).toFixed(1)} cm</dd>
          <dt>Truss members</dt><dd>${deg}</dd>
          <dt>Top-view pieces</dt><dd>${plans}</dd>
          <dt>Support</dt><dd>${n.fixed ? 'Pinned anchor' : 'Free joint'}</dd>
        </dl>
        <div class="sel-actions">
          ${sel.type === 'node' && ground ? `<button type="button" class="ghost" id="selAnchor">${n.fixed ? 'Release anchor' : 'Make anchor'}</button>` : ''}
          ${sel.type === 'node' ? '<button type="button" class="ghost danger" id="selDel">Delete joint</button>' : ''}
        </div>`;
      $('selAnchor')?.addEventListener('click', () => { pushUndo(); n.fixed = !n.fixed; changed(); });
    } else {
      const l = S.model.loads.find((ll) => ll.id === sel.id);
      $('selTitle').textContent = 'Weight';
      let where;
      if (l.plan != null) where = `P${l.plan}, ${Math.round(l.t * 100)}% along`;
      else if (l.member != null) where = `M${l.member}, ${Math.round(l.t * 100)}% along`;
      else where = `Joint J${l.node}`;
      const z = BS.loadPoint(S.model, l, nm)?.z ?? 0;
      const across = l.side == null && l.plan == null ? `Centre, ${BS.cm(z)} from front truss` : `${BS.cm(z)} from front truss`;
      body.innerHTML = `
        <dl class="kv">
          <dt>Mass</dt><dd>${massLabel(l.mass)}</dd>
          <dt>Force</dt><dd>${fmtN(l.mass * BS.G)}</dd>
          <dt>Resting on</dt><dd>${where}</dd>
          <dt>Across the deck</dt><dd>${across}</dd>
        </dl>
        <p class="note">Change the mass in the Weight box above. Drag the weight to move it.</p>
        <div class="sel-actions"><button type="button" class="ghost danger" id="selDel">Delete weight</button></div>`;
    }
    $('selDel')?.addEventListener('click', deleteSelection);
  }

  function selectedLoad() {
    return S.selection?.type === 'load' ? S.model.loads.find((l) => l.id === S.selection.id) : null;
  }
  function syncMassField() {
    const l = selectedLoad();
    const input = $('mass');
    $('massLabel').textContent = l ? 'Mass of selected weight' : 'Mass for new weights';
    if (document.activeElement !== input) input.value = l ? l.mass : S.mass;
  }
  function setMass(v) {
    const mass = Math.max(0.01, Math.min(500, Math.round((+v || 0) * 1000) / 1000));
    const l = selectedLoad();
    if (l) {
      l.mass = mass;
      changed();
    } else {
      S.mass = mass;
    }
  }
  $('mass').addEventListener('focus', () => { S.pending = snapshot(); });
  $('mass').addEventListener('input', (e) => { if (e.target.value !== '') setMass(e.target.value); });
  $('mass').addEventListener('change', (e) => {
    setMass(e.target.value);
    if (S.pending && S.pending !== snapshot()) pushUndo(S.pending);
    S.pending = snapshot();
    syncMassField();
  });
  $('massPresets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mass]');
    if (!b) return;
    const before = snapshot();
    setMass(b.dataset.mass);
    if (before !== snapshot()) pushUndo(before);
    syncMassField();
    if (!selectedLoad()) { setTool('weight'); toast(`Click a joint or beam to place ${massLabel(S.mass)}.`); }
  });

  /* Piece controls: one material and cross-section for every member (inputs in cm). */
  function fillPieceMaterials() {
    $('pieceMat').innerHTML = BS.MATERIAL_ORDER.map((k) => `<option value="${k}">${BS.MATERIALS[k].name}</option>`).join('');
  }
  function syncPieceControls() {
    const p = S.model.piece;
    const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = +(v * 100).toFixed(3); };
    $('pieceMat').value = p.material;
    set('pieceW', p.width); set('pieceT', p.thick); set('pieceL', p.maxLen);
    const mat = BS.memberMat(S.model);
    const ref = Math.min(0.1, mat.maxLen);
    $('pieceInfo').innerHTML = [
      ['Tension limit', fmtN(BS.tensionCapacity(mat))],
      [`Push limit at ${BS.cm(ref, 0)}`, fmtN(BS.compressionCapacity(mat, ref))],
      ['Mass per cm', `${(BS.linearMass(mat) * 10).toFixed(3)} g`],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }
  function setPiece(field, value) {
    const p = { ...S.model.piece };
    if (field === 'material') p.material = value;
    else {
      const v = +value;
      if (!(v > 0)) { syncPieceControls(); return; }
      const lim = { width: [0.0005, 0.1], thick: [0.0005, 0.1], maxLen: [0.01, 2] }[field];
      p[field] = Math.max(lim[0], Math.min(lim[1], v / 100));
    }
    if (JSON.stringify(p) === JSON.stringify(S.model.piece)) return;
    pushUndo();
    S.model.piece = p;
    changed();
  }
  $('pieceMat').addEventListener('change', (e) => setPiece('material', e.target.value));
  [['pieceW', 'width'], ['pieceT', 'thick'], ['pieceL', 'maxLen']].forEach(([id, field]) => {
    $(id).addEventListener('change', (e) => { setPiece(field, e.target.value); syncPieceControls(); });
  });

  /* Site controls */
  function syncSiteControls() {
    $('gap').value = Math.round(S.model.gap * 100);
    $('gapOut').textContent = BS.cm(S.model.gap, 0);
    $('pier').checked = !!S.model.pier;
    if (document.activeElement !== $('deckW')) $('deckW').value = +(S.model.width * 100).toFixed(2);
  }
  function refixAnchors() {
    const terrain = BS.terrainOf(S.model);
    S.model.nodes.forEach((n) => { if (n.fixed && !BS.onTerrain(terrain, n.x, n.y)) n.fixed = false; });
  }
  $('gap').addEventListener('pointerdown', () => { S.pending = snapshot(); });
  $('gap').addEventListener('focus', () => { S.pending = snapshot(); });
  $('gap').addEventListener('input', (e) => {
    const g = +e.target.value / 100;
    const old = S.model.gap;
    if (Math.abs(g - old) < 1e-9) return;
    const f = g / old;
    S.model.nodes.forEach((n) => { n.x = +(n.x * f).toFixed(4); });
    S.model.gap = g;
    refixAnchors();
    changed();
    R.fit(g, S.model.width);
  });
  $('gap').addEventListener('change', () => {
    if (S.pending && S.pending !== snapshot()) pushUndo(S.pending);
    S.pending = snapshot();
  });
  $('deckW').addEventListener('change', (e) => {
    const v = +e.target.value;
    if (!(v > 0)) { syncSiteControls(); return; }
    const w = Math.max(0.02, Math.min(0.4, v / 100));
    if (Math.abs(w - S.model.width) < 1e-9) return;
    pushUndo();
    S.model.width = w;
    changed();
    R.fit(S.model.gap, w);
  });
  $('pier').addEventListener('change', (e) => {
    pushUndo();
    S.model.pier = e.target.checked;
    refixAnchors();
    changed();
  });

  function fillPresets() {
    $('preset').innerHTML = Object.entries(BS.PRESETS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('');
  }
  $('loadPreset').addEventListener('click', () => {
    pushUndo();
    S.model = BS.makePreset($('preset').value, S.model.gap, S.model.pier, S.mass, S.model.piece, S.model.width);
    S.selection = null;
    changed();
    toast(`Loaded ${BS.PRESETS[$('preset').value].name.toLowerCase()} with top-view bracing and a ${massLabel(S.mass)} weight at midspan.`);
  });
  $('clear').addEventListener('click', () => {
    pushUndo();
    const m = BS.createModel(S.model.gap);
    m.pier = S.model.pier;
    m.width = S.model.width;
    m.piece = { ...S.model.piece };
    BS.addNode(m, 0, 0, true);
    BS.addNode(m, m.gap, 0, true);
    S.model = m;
    S.selection = null;
    changed();
    setProj('side');
    setTool('build');
    toast('Cleared. Two anchors are ready on the table edges. Undo brings the old design back.');
  });

  $('live').addEventListener('change', (e) => { S.live = e.target.checked; refreshLive(); renderSelection(); });
  $('snap').addEventListener('change', (e) => { S.snap = e.target.checked; });

  $('codeBtn').addEventListener('click', () => {
    const box = $('codeBox');
    box.hidden = !box.hidden;
    if (!box.hidden) $('code').value = JSON.stringify(S.model);
  });
  $('copyCode').addEventListener('click', () => {
    const ta = $('code');
    ta.value = JSON.stringify(S.model);
    const fallback = () => { ta.focus(); ta.select(); toast('Selected. Press Ctrl+C to copy.'); };
    try {
      navigator.clipboard.writeText(ta.value).then(() => toast('Design code copied.'), fallback);
    } catch (e) { fallback(); }
  });
  $('applyCode').addEventListener('click', () => {
    try {
      const m = JSON.parse($('code').value);
      if (!validModel(m)) throw new Error('bad');
      BS.upgradeModel(m);
      m.nextId = Math.max(m.nextId || 1, ...[...m.nodes, ...m.members, ...m.loads, ...m.plan].map((x) => x.id + 1));
      pushUndo();
      S.model = m;
      S.selection = null;
      changed();
      R.fit(m.gap, m.width);
      toast('Design loaded.');
    } catch (e) {
      toast('That code is not a valid design. Paste the full text from Copy.');
    }
  });

  /* ---------------- Simulation ---------------- */
  function setMode(mode) {
    S.mode = mode;
    app.dataset.mode = mode;
    $('paneBuild').hidden = mode !== 'build';
    $('paneSim').hidden = mode !== 'sim';
    $('paneResults').hidden = mode !== 'results';
    $('simbar').hidden = mode !== 'sim';
    $('run').disabled = mode === 'sim';
    document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(mode === 'build' && b.dataset.tool === S.tool)));
    updateHistoryButtons();
    updateHint();
    refreshLive();
    renderLevels();
  }

  function startSim() {
    if (!S.model.members.length) { toast('Build something first. Drag between points with the Build tool.'); return; }
    if (!S.model.nodes.some((n) => n.fixed)) { toast('Nothing is anchored. Use the Anchor tool on a table edge.'); return; }
    if (!S.model.loads.length) toast('No weight placed, so this tests self weight only.');
    S.sim = new BS.Simulation(S.model);
    S.report = null;
    S.selection = null;
    S.hover = null;
    S.tooltip = null;
    S.highlight = null;
    S.paused = false;
    S.doneAt = null;
    $('pause').textContent = 'Pause';
    $('liveEvents').innerHTML = '';
    setMode('sim');
  }

  function stopSim() {
    if (!S.sim) return;
    if (!S.sim.done) S.sim.finish();
    enterResults();
  }

  function enterResults() {
    S.report = BS.buildReport(S.model, S.sim);
    S.view = 'weak';
    setMode('results');
    renderResults();
  }

  function enterBuild() {
    S.highlight = null;
    S.tooltip = null;
    setMode('build');
    renderSelection();
  }

  $('run').addEventListener('click', () => { if (S.mode !== 'sim') startSim(); });
  $('rerun').addEventListener('click', startSim);
  $('edit').addEventListener('click', enterBuild);
  $('stop').addEventListener('click', stopSim);
  $('pause').addEventListener('click', () => { S.paused = !S.paused; $('pause').textContent = S.paused ? 'Resume' : 'Pause'; });
  $('slow').addEventListener('click', () => { S.slow = !S.slow; $('slow').setAttribute('aria-pressed', String(S.slow)); });
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('projSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-proj]');
    if (b) setProj(b.dataset.proj);
  });
  $('viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    S.view = b.dataset.view;
    document.querySelectorAll('#viewSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    S.tooltip = null;
    $('legend').hidden = S.view !== 'weak';
  });

  const VERBS = {
    tension: 'snapped in tension', buckling: 'buckled', sideways: 'buckled sideways',
    compression: 'crushed', bending: 'bent and broke',
  };
  function describeEvent(ev) {
    return `<b>${ev.name}</b> (${ev.where}) ${VERBS[ev.mode] || 'failed'} at ${Math.round(ev.load * 100)}% load`;
  }

  let shownEvents = 0;
  function updateSimPanel() {
    const sim = S.sim;
    $('simTime').textContent = `${sim.time.toFixed(2)} s`;
    $('simLoad').textContent = `Load ${Math.round(sim.loadRamp * 100)}%`;
    $('simBroken').textContent = `${sim.events.length} broken`;
    $('loadBar').style.width = `${sim.loadRamp * 100}%`;
    const peak = [...sim.members, ...sim.plans].reduce((s, c) => (c.broken ? s : Math.max(s, c.u)), 0);
    const bar = $('peakBar');
    bar.style.width = `${Math.min(1, peak) * 100}%`;
    bar.style.background = BS.colorUtil.rgb(R.utilColor(peak));
    if (sim.events.length === 0) shownEvents = 0;
    if (sim.events.length !== shownEvents) {
      shownEvents = sim.events.length;
      $('liveEvents').innerHTML = sim.events.map((ev) => `<li><time>${ev.time.toFixed(2)} s</time><span>${describeEvent(ev)}</span></li>`).join('');
    }
  }

  function massHtml(kg) {
    if (kg < 1) return `${Math.round(kg * 1000)}<small>g</small>`;
    return `${+kg.toFixed(kg < 100 ? 1 : 0)}<small>kg</small>`;
  }

  function renderResults() {
    const rep = S.report;
    const sim = S.sim;
    let outcome = sim?.outcome || 'held';
    const mechanism = !rep.static.ok && rep.static.reason === 'mechanism';
    if (mechanism && outcome !== 'collapsed') outcome = 'unstable';
    const v = $('verdict');
    v.dataset.v = outcome;
    v.textContent = { held: 'Held', damaged: 'Damaged', collapsed: 'Collapsed', unstable: 'Unstable' }[outcome];
    const load = massLabel(rep.totalLoad);
    let text;
    if (outcome === 'held') {
      text = rep.totalLoad
        ? `The bridge carried ${load} without losing a piece. The most stressed piece reached ${Math.round(rep.peakU * 100)}% of its limit.`
        : 'The bridge stands under its own weight. Place a weight to put it to work.';
    } else if (outcome === 'unstable') {
      text = `Nothing snapped, but the structure cannot hold its shape. It caught the weight only by sagging ${BS.cm(sim?.peakDeflection || 0)} until its members pulled taut like a chain. Add diagonals to form triangles.`;
    } else if (outcome === 'damaged') {
      text = `${sim.events.length} piece${sim.events.length > 1 ? 's' : ''} gave way, but the rest of the structure still holds the ${load}.`;
    } else {
      const first = sim.events[0];
      text = first
        ? `The bridge failed. ${describeEvent(first).replace(/<[^>]+>/g, '')}, ${first.time.toFixed(2)} s into the test, and the rest followed.`
        : 'The bridge folded without any piece breaking. It has no triangles to hold its shape.';
    }
    $('verdictText').textContent = text;
    document.querySelectorAll('#viewSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === S.view)));

    const metrics = [];
    const peakPct = Math.round(rep.peakU * 100);
    metrics.push(['Peak utilisation', `${rep.static.ok ? peakPct : Math.round((sim?.maxPeakU || 0) * 100)}<small>%</small>`]);
    if (rep.safeLoad != null) {
      metrics.push(['Est. capacity', Number.isFinite(rep.safeLoad) ? massHtml(rep.safeLoad) : '&gt;5000<small>kg</small>']);
    } else {
      metrics.push(['Est. capacity', rep.static.ok ? '<small>add a weight</small>' : '0<small>kg</small>']);
    }
    const defl = rep.static.ok ? rep.maxDeflection : sim?.peakDeflection || 0;
    metrics.push([rep.static.ok ? 'Static sag' : 'Sag in test', `${((defl || 0) * 100).toFixed(2)}<small>cm</small>`]);
    const total = S.model.members.length * 2 + S.model.plan.length;
    metrics.push(['Pieces failed', `${sim ? sim.events.length : 0}<small>of ${total}</small>`]);
    $('metrics').innerHTML = metrics.map(([k, val]) => `<div><dt>${k}</dt><dd>${val}</dd></div>`).join('');

    const brokenOrder = new Map((sim?.events || []).map((e, i) => [e.key, i + 1]));
    $('weakList').innerHTML = rep.weak.length ? rep.weak.map((w) => {
      const col = BS.colorUtil.rgb(R.utilColor(w.u));
      const broke = brokenOrder.get(w.key);
      return `<li data-key="${w.key}" style="--c:${col}" title="Click to find it in the drawing">
        <span class="rank">${w.rank}</span>
        <span class="name">${w.name} <small>${w.where} · ${BS.cm(w.L)}${broke ? ` · broke #${broke}` : ''}</small></span>
        <span class="pct">${Math.round(w.u * 100)}%</span>
        <span class="ubar"><i style="width:${Math.min(100, w.u * 100)}%"></i></span>
        <span class="why"><span class="mode">${w.modeLabel}</span>${esc(w.advice)}</span>
      </li>`;
    }).join('') : '<li class="note">No members to rank.</li>';

    const seq = sim?.events || [];
    $('seqBlock').hidden = false;
    $('seqList').innerHTML = seq.length
      ? seq.map((ev) => `<li><time>${ev.time.toFixed(2)} s</time><span>${describeEvent(ev)}</span></li>`).join('')
      : '<li><time>—</time><span>No pieces failed.</span></li>';

    const tips = rep.tips.slice();
    if (rep.source === 'dynamic') tips.unshift('This design is not stable on its own, so the rankings come from peak forces in the live test instead of a static check.');
    $('tipsBlock').hidden = !tips.length;
    $('tips').innerHTML = tips.map((t) => `<li>${esc(t)}</li>`).join('');

    S.mechanismNode = mechanism ? rep.static.nodeId : null;
    $('legend').hidden = false;
  }

  function markWeakItem(key) {
    document.querySelectorAll('#weakList li[data-key]').forEach((li) => li.classList.toggle('hot', li.dataset.key === key));
  }
  $('weakList').addEventListener('pointerover', (e) => {
    const li = e.target.closest('li[data-key]');
    S.highlight = li ? li.dataset.key : null;
  });
  $('weakList').addEventListener('pointerleave', () => { S.highlight = null; });
  // Clicking a weak point shows it in the view where it can be seen.
  $('weakList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-key]');
    if (!li) return;
    const key = li.dataset.key;
    const nm = BS.nodeMap(S.model);
    if (key.startsWith('p')) {
      const p = S.model.plan.find((pp) => pp.id === +key.slice(1));
      if (p) { S.level = nm.get(p.a.n).y; setProj('top'); }
    } else if (S.proj === 'top') {
      const m = S.model.members.find((mm) => mm.id === +key.split(':')[0]);
      if (m && sameY(nm.get(m.a).y, nm.get(m.b).y)) { S.level = nm.get(m.a).y; renderLevels(); } else setProj('side');
    }
    if (S.view !== 'weak') $('viewSeg').querySelector('[data-view="weak"]').click();
    S.highlight = key;
  });

  /* ---------------- Main loop ---------------- */
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    S.clock += dt;
    if (S.mode === 'sim' && S.sim) {
      if (!S.paused) {
        S.sim.step((1 / 60) * (S.slow ? 0.25 : 1));
        updateSimPanel();
      }
      if (S.sim.done) {
        if (S.doneAt == null) S.doneAt = S.clock;
        else if (S.clock - S.doneAt > 0.9) enterResults();
      }
    }
    R.draw({
      model: S.model, mode: S.mode, view: S.view, proj: S.proj, level: S.level, sim: S.sim, report: S.report,
      live: S.live, liveChecks: S.liveChecks, mechanismNode: S.mechanismNode,
      hover: S.hover, selection: S.selection, preview: S.preview, highlight: S.highlight,
      tooltip: S.tooltip, clock: S.clock,
    });
    requestAnimationFrame(frame);
  }

  /* ---------------- Boot ---------------- */
  function boot() {
    fillPresets();
    fillPieceMaterials();
    S.model = loadSaved() || BS.makePreset('pratt', 0.5, false, S.mass);
    setTool('build');
    setMode('build');
    setProj('side');
    changed();

    const fitOnce = { done: false };
    const ro = new ResizeObserver(() => {
      R.resize();
      if (!fitOnce.done && R.w > 0) { R.fit(S.model.gap, S.model.width); fitOnce.done = true; }
    });
    ro.observe($('canvasWrap'));
    R.resize();
    R.fit(S.model.gap, S.model.width);

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const recolor = () => { R.readColors(); if (S.mode === 'results') renderResults(); };
    mq.addEventListener?.('change', recolor);
    new MutationObserver(recolor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    document.fonts?.ready.then(() => R.readColors());

    requestAnimationFrame(frame);
  }

  boot();
  window.__bridgeLab = { state: S, renderer: R }; // handy for debugging in the console
})();
