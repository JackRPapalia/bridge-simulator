/* Core data: the piece material, the bridge model, terrain and member capacity checks.
 * Every member is cut from the same piece: one material, one cross-section.
 * Internally everything is SI (metres, kilograms, newtons, seconds); the UI shows centimetres.
 * World y points up; the table tops are at y = 0. */
(function (root) {
  'use strict';
  const BS = (root.BS = root.BS || {});

  const G = 9.81;

  // Approximate properties along the grain / for the solid material.
  // E: stiffness, ft/fc/fb: tension, compression and bending strength (Pa), density kg/m³.
  const MATERIALS = {
    balsa: { key: 'balsa', name: 'Balsa', E: 3.5e9, ft: 14e6, fc: 12e6, fb: 20e6, density: 160 },
    basswood: { key: 'basswood', name: 'Basswood', E: 10e9, ft: 40e6, fc: 30e6, fb: 50e6, density: 420 },
    birch: { key: 'birch', name: 'Birch (craft stick)', E: 12e9, ft: 50e6, fc: 40e6, fb: 70e6, density: 600 },
    pine: { key: 'pine', name: 'Pine', E: 9e9, ft: 40e6, fc: 30e6, fb: 60e6, density: 450 },
    spaghetti: { key: 'spaghetti', name: 'Dry spaghetti', E: 4e9, ft: 10e6, fc: 10e6, fb: 15e6, density: 1500 },
    aluminium: { key: 'aluminium', name: 'Aluminium', E: 69e9, ft: 150e6, fc: 150e6, fb: 150e6, density: 2700 },
    steel: { key: 'steel', name: 'Steel', E: 200e9, ft: 250e6, fc: 250e6, fb: 250e6, density: 7850 },
  };
  const MATERIAL_ORDER = ['balsa', 'basswood', 'birch', 'pine', 'spaghetti', 'aluminium', 'steel'];

  /* The piece every member is cut from. width lies in the bridge's plane, thick is out of plane. */
  const DEFAULT_PIECE = { material: 'balsa', width: 0.01, thick: 0.01, maxLen: 0.3 };

  /* Section and strength properties of the piece (solid rectangle). Cached per piece spec. */
  let cacheKey = '';
  let cacheVal = null;
  function pieceProps(piece) {
    const p = piece || DEFAULT_PIECE;
    const key = `${p.material}|${p.width}|${p.thick}|${p.maxLen}`;
    if (key === cacheKey) return cacheVal;
    const m = MATERIALS[p.material] || MATERIALS.balsa;
    const w = p.width;
    const t = p.thick;
    const big = Math.max(w, t);
    const small = Math.min(w, t);
    cacheKey = key;
    cacheVal = {
      ...m,
      width: w, thick: t, maxLen: p.maxLen,
      A: w * t,
      I: (big * small ** 3) / 12,   // weakest axis governs buckling
      S: (t * w * w) / 6,           // bending in the bridge's plane
      tensionOnly: false,
    };
    return cacheVal;
  }
  const memberMat = (model) => pieceProps(model.piece);

  const linearMass = (mat) => mat.density * mat.A;
  const tensionCapacity = (mat) => mat.ft * mat.A;
  const eulerLoad = (mat, L) => (mat.I > 0 ? (Math.PI * Math.PI * mat.E * mat.I) / (L * L) : 0);
  const crushCapacity = (mat) => mat.fc * mat.A;
  const compressionCapacity = (mat, L) =>
    mat.tensionOnly ? 0 : Math.min(crushCapacity(mat), eulerLoad(mat, L));
  const bendingCapacity = (mat) => mat.fb * mat.S;
  const buckles = (mat, L) => eulerLoad(mat, L) < crushCapacity(mat);

  /* Utilisation of a member under axial force N (tension +) and bending moment M.
   * Uses a linear interaction: u = |N|/N_cap + M/M_cap. u >= 1 means failure. */
  function checkMember(mat, L, N, M) {
    let axial = 0;
    let mode;
    if (mat.tensionOnly && N < 0) {
      mode = 'slack';
    } else if (N >= 0) {
      axial = N / tensionCapacity(mat);
      mode = 'tension';
    } else {
      axial = -N / compressionCapacity(mat, L);
      mode = buckles(mat, L) ? 'buckling' : 'compression';
    }
    const Mc = bendingCapacity(mat);
    const bend = M > 0 && Mc > 0 ? M / Mc : 0;
    return { u: axial + bend, axial, bend, mode: bend > axial ? 'bending' : mode, N, M };
  }

  /* ---------- Display helpers (centimetres) ---------- */
  const cm = (m, d = 1) => `${(m * 100).toFixed(d)} cm`;
  function newtons(N) {
    const a = Math.abs(N);
    return `${N.toFixed(a < 10 ? 2 : a < 1000 ? 1 : 0)} N`;
  }
  const kgLabel = (kg) => (kg < 1 ? `${Math.round(kg * 1000)} g` : `${+kg.toFixed(kg < 10 ? 2 : 1)} kg`);

  /* ---------- Terrain: two tables with a gap, floor below ---------- */
  function terrainOf(model) {
    const g = model.gap;
    const floorY = -Math.max(0.25, 0.6 * g);
    const rects = [
      { x0: -2, x1: 0, y0: floorY, y1: 0 },
      { x0: g, x1: g + 2, y0: floorY, y1: 0 },
      { x0: -2, x1: g + 2, y0: floorY - 2, y1: floorY, floor: true },
    ];
    if (model.pier) {
      const hw = Math.max(0.015, 0.04 * g);
      rects.push({ x0: g / 2 - hw, x1: g / 2 + hw, y0: floorY, y1: -0.15 * g, pier: true });
    }
    return { gap: g, rects, floorY };
  }

  function onTerrain(terrain, x, y) {
    const e = 0.001;
    return terrain.rects.some((r) => x >= r.x0 - e && x <= r.x1 + e && y <= r.y1 + e && y >= r.y0 - e);
  }

  /* ---------- Model ---------- */
  function createModel(gap) {
    return {
      version: 2, nextId: 1, gap: gap || 0.5, pier: false,
      piece: { ...DEFAULT_PIECE }, nodes: [], members: [], loads: [],
    };
  }

  const cloneModel = (m) => JSON.parse(JSON.stringify(m));

  function nodeMap(model) {
    const map = new Map();
    for (const n of model.nodes) map.set(n.id, n);
    return map;
  }

  function addNode(model, x, y, fixed) {
    const n = { id: model.nextId++, x, y, fixed: !!fixed };
    model.nodes.push(n);
    return n;
  }

  function findNode(model, x, y, tol) {
    let best = null;
    let bd = tol;
    for (const n of model.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= bd) { bd = d; best = n; }
    }
    return best;
  }

  function findMemberBetween(model, a, b) {
    return model.members.find((m) => (m.a === a && m.b === b) || (m.a === b && m.b === a)) || null;
  }

  function addMember(model, a, b) {
    if (a === b || findMemberBetween(model, a, b)) return null;
    const m = { id: model.nextId++, a, b };
    model.members.push(m);
    return m;
  }

  function memberLength(model, m, map) {
    const nm = map || nodeMap(model);
    const a = nm.get(m.a);
    const b = nm.get(m.b);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function removeMember(model, id) {
    model.members = model.members.filter((m) => m.id !== id);
    model.loads = model.loads.filter((l) => l.member !== id);
  }

  function removeNode(model, id) {
    const doomed = model.members.filter((m) => m.a === id || m.b === id).map((m) => m.id);
    doomed.forEach((mid) => removeMember(model, mid));
    model.nodes = model.nodes.filter((n) => n.id !== id);
    model.loads = model.loads.filter((l) => l.node !== id);
  }

  function removeLoad(model, id) {
    model.loads = model.loads.filter((l) => l.id !== id);
  }

  /* Drop joints that no member uses and are not anchors. */
  function pruneOrphans(model) {
    const used = new Set();
    model.members.forEach((m) => { used.add(m.a); used.add(m.b); });
    model.nodes = model.nodes.filter((n) => used.has(n.id) || n.fixed);
    const ids = new Set(model.nodes.map((n) => n.id));
    model.loads = model.loads.filter((l) => (l.node == null ? true : ids.has(l.node)));
  }

  /* World position of a load's attachment point. */
  function loadPoint(model, load, map) {
    const nm = map || nodeMap(model);
    if (load.node != null) {
      const n = nm.get(load.node);
      return n ? { x: n.x, y: n.y } : null;
    }
    const m = model.members.find((mm) => mm.id === load.member);
    if (!m) return null;
    const a = nm.get(m.a);
    const b = nm.get(m.b);
    return { x: a.x + (b.x - a.x) * load.t, y: a.y + (b.y - a.y) * load.t };
  }

  function designStats(model) {
    const map = nodeMap(model);
    const mat = memberMat(model);
    let length = 0;
    let overLong = 0;
    for (const m of model.members) {
      const L = memberLength(model, m, map);
      length += L;
      if (L > mat.maxLen + 1e-9) overLong++;
    }
    const used = new Set();
    model.members.forEach((m) => { used.add(m.a); used.add(m.b); });
    const joints = model.nodes.filter((n) => used.has(n.id)).length;
    const load = model.loads.reduce((s, l) => s + l.mass, 0);
    return { mass: linearMass(mat) * length, length, overLong, joints, members: model.members.length, load };
  }

  Object.assign(BS, {
    G, MATERIALS, MATERIAL_ORDER, DEFAULT_PIECE, pieceProps, memberMat,
    linearMass, tensionCapacity, eulerLoad, crushCapacity, compressionCapacity, bendingCapacity, buckles, checkMember,
    cm, newtons, kgLabel,
    terrainOf, onTerrain,
    createModel, cloneModel, nodeMap, addNode, findNode, findMemberBetween, addMember, memberLength,
    removeMember, removeNode, removeLoad, pruneOrphans, loadPoint, designStats,
  });
})(typeof window !== 'undefined' ? window : globalThis);
