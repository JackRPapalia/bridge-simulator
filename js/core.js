/* Core data: materials, the bridge model, terrain and member capacity checks.
 * Units: metres, kilograms, newtons, seconds. World y points up; the deck level is y = 0. */
(function (root) {
  'use strict';
  const BS = (root.BS = root.BS || {});

  const G = 9.81;

  // Section properties are for one representative member of each kind.
  // I is the weak-axis second moment (governs buckling); S is the section modulus for bending.
  const MATERIALS = {
    timber: {
      key: 'timber', name: 'Timber', note: '100 mm square glulam',
      E: 11e9, A: 0.01, I: 8.33e-6, S: 1.667e-4, fy: 30e6, density: 600,
      costPerM: 40, maxLen: 10, tensionOnly: false, width: 0.16,
    },
    steel: {
      key: 'steel', name: 'Steel tube', note: '100 mm tube, 6.5 mm wall',
      E: 200e9, A: 0.002, I: 2.5e-6, S: 5e-5, fy: 250e6, density: 7850,
      costPerM: 120, maxLen: 12, tensionOnly: false, width: 0.12,
    },
    ibeam: {
      key: 'ibeam', name: 'Steel I-beam', note: '300 mm deep, best for decks',
      E: 200e9, A: 0.006, I: 4e-6, S: 5e-4, fy: 250e6, density: 7850,
      costPerM: 300, maxLen: 12, tensionOnly: false, width: 0.22,
    },
    cable: {
      key: 'cable', name: 'Steel cable', note: '25 mm strand, tension only',
      E: 160e9, A: 5e-4, I: 0, S: 0, fy: 1000e6, density: 7850,
      costPerM: 60, maxLen: 40, tensionOnly: true, width: 0.05,
    },
  };
  const MATERIAL_ORDER = ['timber', 'steel', 'ibeam', 'cable'];

  const linearMass = (mat) => mat.density * mat.A;
  const tensionCapacity = (mat) => mat.fy * mat.A;
  const eulerLoad = (mat, L) => (mat.I > 0 ? (Math.PI * Math.PI * mat.E * mat.I) / (L * L) : 0);
  const compressionCapacity = (mat, L) =>
    mat.tensionOnly ? 0 : Math.min(mat.fy * mat.A, eulerLoad(mat, L));
  const bendingCapacity = (mat) => mat.fy * mat.S;

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
      const yieldCap = mat.fy * mat.A;
      const euler = eulerLoad(mat, L);
      axial = -N / Math.min(yieldCap, euler);
      mode = euler < yieldCap ? 'buckling' : 'compression';
    }
    const Mc = bendingCapacity(mat);
    const bend = M > 0 && Mc > 0 ? M / Mc : 0;
    return { u: axial + bend, axial, bend, mode: bend > axial ? 'bending' : mode, N, M };
  }

  /* ---------- Terrain ---------- */
  function terrainOf(model) {
    const g = model.gap;
    const rects = [
      { x0: -40, x1: 0, y0: -40, y1: 0 },
      { x0: g, x1: g + 40, y0: -40, y1: 0 },
    ];
    if (model.pier) rects.push({ x0: g / 2 - 1, x1: g / 2 + 1, y0: -40, y1: -3, pier: true });
    return { gap: g, rects, waterY: -10 };
  }

  function onTerrain(terrain, x, y) {
    const e = 0.05;
    return terrain.rects.some((r) => x >= r.x0 - e && x <= r.x1 + e && y <= r.y1 + e && y >= r.y0 - e);
  }

  /* ---------- Model ---------- */
  function createModel(gap) {
    return { version: 1, nextId: 1, gap: gap || 18, pier: false, nodes: [], members: [], loads: [] };
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

  function addMember(model, a, b, mat) {
    if (a === b || findMemberBetween(model, a, b)) return null;
    const m = { id: model.nextId++, a, b, mat };
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
    let mass = 0;
    let cost = 0;
    for (const m of model.members) {
      const mat = MATERIALS[m.mat];
      const L = memberLength(model, m, map);
      mass += linearMass(mat) * L;
      cost += mat.costPerM * L;
    }
    const used = new Set();
    model.members.forEach((m) => { used.add(m.a); used.add(m.b); });
    const joints = model.nodes.filter((n) => used.has(n.id)).length;
    cost += joints * 150;
    const load = model.loads.reduce((s, l) => s + l.mass, 0);
    return { mass, cost, joints, members: model.members.length, load };
  }

  Object.assign(BS, {
    G, MATERIALS, MATERIAL_ORDER,
    linearMass, tensionCapacity, eulerLoad, compressionCapacity, bendingCapacity, checkMember,
    terrainOf, onTerrain,
    createModel, cloneModel, nodeMap, addNode, findNode, findMemberBetween, addMember, memberLength,
    removeMember, removeNode, removeLoad, pruneOrphans, loadPoint, designStats,
  });
})(typeof window !== 'undefined' ? window : globalThis);
