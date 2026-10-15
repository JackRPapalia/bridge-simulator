/* Core data: the piece material, the bridge model, terrain and member capacity checks.
 *
 * The bridge is two identical side trusses (front at z = 0, back at z = width) drawn once in the
 * side view, plus "plan" pieces drawn in the top view that join a joint on one truss to a joint
 * on the other (cross pieces and lateral bracing).
 *
 * Every member is cut from the same piece: one material, one cross-section.
 * Internally everything is SI (metres, kilograms, newtons, seconds); the UI shows centimetres.
 * World y points up; the table tops are at y = 0. */
(function (root) {
  'use strict';
  const BS = (root.BS = root.BS || {});

  const G = 9.81;
  const FRONT = 0;
  const BACK = 1;

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

  /* The piece every member is cut from. On a side truss, width lies in the truss plane and
   * thick points across the bridge. Top-view pieces lie flat, so their thickness is vertical. */
  const DEFAULT_PIECE = { material: 'balsa', width: 0.01, thick: 0.01, maxLen: 0.3 };
  const DEFAULT_WIDTH = 0.08;

  let cacheKey = '';
  let cacheVal = null;
  function pieceProps(piece) {
    const p = piece || DEFAULT_PIECE;
    const key = `${p.material}|${p.width}|${p.thick}|${p.maxLen}`;
    if (key === cacheKey) return cacheVal;
    const m = MATERIALS[p.material] || MATERIALS.balsa;
    const w = p.width;
    const t = p.thick;
    cacheKey = key;
    cacheVal = {
      ...m,
      width: w, thick: t, maxLen: p.maxLen,
      A: w * t,
      Iin: (t * w ** 3) / 12,     // bending/buckling within the truss plane
      Iout: (w * t ** 3) / 12,    // buckling sideways, out of the truss plane
      S: (t * w * w) / 6,         // side-truss member bending in its plane
      Sflat: (w * t * t) / 6,     // top-view piece bending under a weight (laid flat)
      tensionOnly: false,
    };
    return cacheVal;
  }
  const memberMat = (model) => pieceProps(model.piece);

  const linearMass = (mat) => mat.density * mat.A;
  const tensionCapacity = (mat) => mat.ft * mat.A;
  const crushCapacity = (mat) => mat.fc * mat.A;
  const euler = (mat, I, L) => (I > 0 && L > 0 ? (Math.PI * Math.PI * mat.E * I) / (L * L) : Infinity);

  /* Compression limit and the way it fails. Lout is the length that can bow sideways
   * (between braced joints); it defaults to the member length. */
  function compression(mat, L, Lout) {
    const crush = crushCapacity(mat);
    const inPlane = euler(mat, mat.Iin, L);
    const sideways = euler(mat, mat.Iout, Lout || L);
    const cap = Math.min(crush, inPlane, sideways);
    const mode = cap === crush ? 'compression' : cap === sideways && sideways < inPlane ? 'sideways' : 'buckling';
    return { cap, mode };
  }
  const compressionCapacity = (mat, L, Lout) => compression(mat, L, Lout).cap;
  const buckles = (mat, L, Lout) => compression(mat, L, Lout).mode !== 'compression';
  const bendingCapacity = (mat, flat) => mat.fb * (flat ? mat.Sflat : mat.S);

  /* Utilisation of a member under axial force N (tension +) and bending moment M.
   * Linear interaction: u = |N|/N_cap + M/M_cap. u >= 1 means failure.
   * opts.Lout: sideways buckling length; opts.flat: a top-view piece (bends about its thin axis). */
  function checkMember(mat, L, N, M, opts) {
    const o = opts || {};
    let axial = 0;
    let mode;
    if (mat.tensionOnly && N < 0) {
      mode = 'slack';
    } else if (N >= 0) {
      axial = N / tensionCapacity(mat);
      mode = 'tension';
    } else {
      const c = compression(mat, L, o.Lout);
      axial = -N / c.cap;
      mode = c.mode;
    }
    const Mc = bendingCapacity(mat, o.flat);
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
  const sideName = (s) => (s === BACK ? 'back' : 'front');

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
      version: 3, nextId: 1, gap: gap || 0.5, width: DEFAULT_WIDTH, pier: false,
      piece: { ...DEFAULT_PIECE }, nodes: [], members: [], plan: [], loads: [],
    };
  }

  /* Bring older saved designs up to the current shape. */
  function upgradeModel(m) {
    if (!Array.isArray(m.plan)) m.plan = [];
    if (!(m.width > 0)) m.width = DEFAULT_WIDTH;
    m.version = 3;
    return m;
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

  const sameEnd = (p, q) => p.n === q.n && p.s === q.s;
  function findPlanBetween(model, a, b) {
    return model.plan.find((p) => (sameEnd(p.a, a) && sameEnd(p.b, b)) || (sameEnd(p.a, b) && sameEnd(p.b, a))) || null;
  }

  /* A top-view piece from joint a = {n, s} to joint b = {n, s} on the other truss. */
  function addPlan(model, a, b) {
    if (a.s === b.s || findPlanBetween(model, a, b)) return null;
    const p = { id: model.nextId++, a: { n: a.n, s: a.s }, b: { n: b.n, s: b.s } };
    model.plan.push(p);
    return p;
  }

  function memberLength(model, m, map) {
    const nm = map || nodeMap(model);
    const a = nm.get(m.a);
    const b = nm.get(m.b);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  const sideZ = (model, s) => (s === BACK ? model.width : 0);

  function planEnds(model, p, map) {
    const nm = map || nodeMap(model);
    const a = nm.get(p.a.n);
    const b = nm.get(p.b.n);
    if (!a || !b) return null;
    return {
      a: { x: a.x, y: a.y, z: sideZ(model, p.a.s) },
      b: { x: b.x, y: b.y, z: sideZ(model, p.b.s) },
    };
  }

  function planLength(model, p, map) {
    const e = planEnds(model, p, map);
    return e ? Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y, e.b.z - e.a.z) : 0;
  }

  function removeMember(model, id) {
    model.members = model.members.filter((m) => m.id !== id);
    model.loads = model.loads.filter((l) => l.member !== id);
  }

  function removePlan(model, id) {
    model.plan = model.plan.filter((p) => p.id !== id);
    model.loads = model.loads.filter((l) => l.plan !== id);
  }

  function removeNode(model, id) {
    model.members.filter((m) => m.a === id || m.b === id).forEach((m) => removeMember(model, m.id));
    model.plan.filter((p) => p.a.n === id || p.b.n === id).forEach((p) => removePlan(model, p.id));
    model.nodes = model.nodes.filter((n) => n.id !== id);
    model.loads = model.loads.filter((l) => l.node !== id);
  }

  function removeLoad(model, id) {
    model.loads = model.loads.filter((l) => l.id !== id);
  }

  function usedNodes(model) {
    const used = new Set();
    model.members.forEach((m) => { used.add(m.a); used.add(m.b); });
    return used;
  }

  /* Drop joints that no member uses and are not anchors (and anything hanging off them). */
  function pruneOrphans(model) {
    const used = usedNodes(model);
    model.nodes.filter((n) => !used.has(n.id) && !n.fixed).forEach((n) => removeNode(model, n.id));
  }

  /* How a weight is shared between joints.
   *   {node}            side view, centred across the deck: half on each truss
   *   {member, t}       side view, centred, resting between two joints of a side member
   *   {node, side}      top view, on one truss's joint
   *   {member, t, side} top view, on one truss's member
   *   {plan, t}         top view, on a cross piece or brace
   * Returns terms [{s, node, c}] (c sums to 1), what it rests on, and its 3D position. */
  function loadInfo(model, load, map) {
    const nm = map || nodeMap(model);
    const W = model.width;
    const sides = load.side == null ? [[FRONT, 0.5], [BACK, 0.5]] : [[load.side, 1]];
    const z = load.side == null ? W / 2 : sideZ(model, load.side);
    if (load.plan != null) {
      const p = model.plan.find((pp) => pp.id === load.plan);
      const e = p && planEnds(model, p, nm);
      if (!e) return null;
      const t = load.t;
      return {
        terms: [{ s: p.a.s, node: p.a.n, c: 1 - t }, { s: p.b.s, node: p.b.n, c: t }],
        rest: { kind: 'plan', id: p.id, t },
        pos: { x: e.a.x + (e.b.x - e.a.x) * t, y: e.a.y + (e.b.y - e.a.y) * t, z: e.a.z + (e.b.z - e.a.z) * t },
      };
    }
    if (load.member != null) {
      const m = model.members.find((mm) => mm.id === load.member);
      if (!m) return null;
      const a = nm.get(m.a);
      const b = nm.get(m.b);
      const t = load.t;
      const terms = [];
      for (const [s, f] of sides) terms.push({ s, node: m.a, c: f * (1 - t) }, { s, node: m.b, c: f * t });
      return {
        terms,
        rest: { kind: 'member', id: m.id, t, sides: sides.map(([s, f]) => ({ s, f })) },
        pos: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z },
      };
    }
    const n = nm.get(load.node);
    if (!n) return null;
    return {
      terms: sides.map(([s, f]) => ({ s, node: n.id, c: f })),
      rest: { kind: 'node', id: n.id },
      pos: { x: n.x, y: n.y, z },
    };
  }

  const loadPoint = (model, load, map) => loadInfo(model, load, map)?.pos || null;

  /* Distinct joint heights (top-view levels), highest first. */
  function levelsOf(model) {
    const used = usedNodes(model);
    const ys = [];
    for (const n of model.nodes) {
      if (!used.has(n.id)) continue;
      if (!ys.some((y) => Math.abs(y - n.y) < 1e-6)) ys.push(n.y);
    }
    return ys.sort((a, b) => b - a);
  }

  function designStats(model) {
    const map = nodeMap(model);
    const mat = memberMat(model);
    let length = 0;
    let overLong = 0;
    for (const m of model.members) {
      const L = memberLength(model, m, map);
      length += 2 * L;
      if (L > mat.maxLen + 1e-9) overLong += 2;
    }
    for (const p of model.plan) {
      const L = planLength(model, p, map);
      length += L;
      if (L > mat.maxLen + 1e-9) overLong++;
    }
    const used = usedNodes(model);
    const joints = model.nodes.filter((n) => used.has(n.id)).length * 2;
    const load = model.loads.reduce((s, l) => s + l.mass, 0);
    return {
      mass: linearMass(mat) * length, length, overLong, joints,
      members: model.members.length * 2 + model.plan.length, plan: model.plan.length, load,
    };
  }

  Object.assign(BS, {
    G, FRONT, BACK, MATERIALS, MATERIAL_ORDER, DEFAULT_PIECE, DEFAULT_WIDTH, pieceProps, memberMat,
    linearMass, tensionCapacity, crushCapacity, compression, compressionCapacity, bendingCapacity, buckles, checkMember,
    cm, newtons, kgLabel, sideName,
    terrainOf, onTerrain,
    createModel, upgradeModel, cloneModel, nodeMap, addNode, findNode, findMemberBetween, addMember,
    findPlanBetween, addPlan, memberLength, sideZ, planEnds, planLength,
    removeMember, removePlan, removeNode, removeLoad, usedNodes, pruneOrphans, loadInfo, loadPoint, levelsOf, designStats,
  });
})(typeof window !== 'undefined' ? window : globalThis);
