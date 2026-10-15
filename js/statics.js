/* Static analysis.
 *
 * Each side truss is solved as a pin-jointed plane truss (direct stiffness method). The two trusses
 * share their geometry but carry different loads when a weight sits off-centre in the top view.
 * Top-view pieces carry weights across the deck by bending, and they brace the trusses sideways:
 * a compression member can bow out of the truss plane over the length between braced joints. */
(function (root) {
  'use strict';
  const BS = root.BS;

  /* Solve K x = f for several right-hand sides with partial pivoting.
   * Returns { ok, xs } or { ok:false, badDof } when K is singular (a mechanism). */
  function solve(K, rhs, n, relTol) {
    const r = rhs.length;
    const A = Float64Array.from(K);
    const B = rhs.map((f) => Float64Array.from(f));
    let maxDiag = 0;
    for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, Math.abs(A[i * n + i]));
    const tol = maxDiag * (relTol || 1e-9);

    for (let col = 0; col < n; col++) {
      let piv = col;
      let best = Math.abs(A[col * n + col]);
      for (let row = col + 1; row < n; row++) {
        const v = Math.abs(A[row * n + col]);
        if (v > best) { best = v; piv = row; }
      }
      if (best <= tol) return { ok: false, badDof: col };
      if (piv !== col) {
        for (let k = 0; k < n; k++) {
          const t = A[col * n + k]; A[col * n + k] = A[piv * n + k]; A[piv * n + k] = t;
        }
        for (let j = 0; j < r; j++) { const t = B[j][col]; B[j][col] = B[j][piv]; B[j][piv] = t; }
      }
      const d = A[col * n + col];
      for (let row = col + 1; row < n; row++) {
        const f = A[row * n + col] / d;
        if (f === 0) continue;
        for (let k = col; k < n; k++) A[row * n + k] -= f * A[col * n + k];
        for (let j = 0; j < r; j++) B[j][row] -= f * B[j][col];
      }
    }
    const xs = B.map((b) => {
      const x = new Float64Array(n);
      for (let i = n - 1; i >= 0; i--) {
        let s = b[i];
        for (let k = i + 1; k < n; k++) s -= A[i * n + k] * x[k];
        x[i] = s / A[i * n + i];
      }
      return x;
    });
    return { ok: true, xs };
  }

  /* Assemble a 2D bar into K. idx = [ax, ay, bx, by] DOF numbers (undefined = fixed). */
  function addBar(K, n, idx, k, c, s) {
    const loc = [c * c, c * s, s * s];
    const sign = [1, 1, -1, -1];
    for (let p = 0; p < 4; p++) {
      if (idx[p] === undefined) continue;
      for (let q = 0; q < 4; q++) {
        if (idx[q] === undefined) continue;
        const kk = p % 2 === 0 ? (q % 2 === 0 ? loc[0] : loc[1]) : q % 2 === 0 ? loc[1] : loc[2];
        K[idx[p] * n + idx[q]] += k * kk * sign[p] * sign[q];
      }
    }
  }

  const levelKey = (y) => Math.round(y * 1e4);

  /* Which joints are held sideways (across the bridge), per truss.
   * For each height, the top-view pieces at that height plus the horizontal side members there form
   * a flat truss seen from above. A joint is braced if that flat truss stops it moving across.
   * Anchors are held; so are joints joined by a side member straight to an anchor, because the end
   * frames of a model bridge are glued stiff enough to carry the bracing forces into the supports. */
  function lateralBracing(model, nm) {
    const used = BS.usedNodes(model);
    const mat = BS.memberMat(model);
    const braced = new Set();
    const portal = new Set();
    for (const m of model.members) {
      const a = nm.get(m.a); const b = nm.get(m.b);
      if (a.fixed && !b.fixed) portal.add(b.id);
      if (b.fixed && !a.fixed) portal.add(a.id);
    }
    const levels = new Map();
    for (const nd of model.nodes) {
      if (!used.has(nd.id)) continue;
      const k = levelKey(nd.y);
      if (!levels.has(k)) levels.set(k, []);
      levels.get(k).push(nd);
    }
    for (const nodes of levels.values()) {
      const ids = new Set(nodes.map((nd) => nd.id));
      // A joint glued to a beam lying flat at this height follows that beam; others get their own DOFs.
      const follow = new Map();
      for (const nd of nodes) {
        if (!nd.on) continue;
        const ms = BS.masters(model, nd.id, nm);
        if (ms.every((x) => ids.has(x.node))) follow.set(nd.id, ms);
      }
      const dof = new Map();
      let n = 0;
      for (const nd of nodes) {
        if (follow.has(nd.id)) continue;
        for (const s of [0, 1]) {
          const key = `${nd.id}:${s}`;
          if (nd.fixed) { braced.add(key); continue; }
          if (portal.has(nd.id)) { braced.add(key); dof.set(key, [n, undefined]); n += 1; continue; }
          dof.set(key, [n, n + 1]); n += 2;
        }
      }
      // DOFs a joint's position is made of: [[xDof, zDof, weight], ...].
      const expand = (id, s) => (follow.get(id) || [{ node: id, w: 1 }])
        .map(({ node, w }) => [...(dof.get(`${node}:${s}`) || [undefined, undefined]), w]);
      const bars = [];
      for (const m of model.members) {
        if (!ids.has(m.a) || !ids.has(m.b)) continue;
        for (const s of [0, 1]) bars.push([[m.a, s], [m.b, s]]);
      }
      for (const p of model.plan) {
        if (!ids.has(p.a.n) || !ids.has(p.b.n)) continue;
        bars.push([[p.a.n, p.a.s], [p.b.n, p.b.s]]);
      }
      const free = [...dof.entries()].filter(([, d]) => d[1] !== undefined);
      if (!free.length || !bars.length) continue;
      const K = new Float64Array(n * n);
      let kmax = 0;
      for (const [[ia, sa], [ib, sb]] of bars) {
        const xa = nm.get(ia).x; const za = BS.sideZ(model, sa);
        const xb = nm.get(ib).x; const zb = BS.sideZ(model, sb);
        const L = Math.hypot(xb - xa, zb - za);
        if (L < 1e-9) continue;
        const k = (mat.E * mat.A) / L;
        kmax = Math.max(kmax, k);
        const c = (xb - xa) / L; const sn = (zb - za) / L;
        // Elongation = sum over terms of coef * (c*ux + s*uz).
        const terms = [];
        for (const [dx, dz, w] of expand(ib, sb)) terms.push([dx, dz, w]);
        for (const [dx, dz, w] of expand(ia, sa)) terms.push([dx, dz, -w]);
        for (const [ix, iz, wi] of terms) {
          for (const [jx, jz, wj] of terms) {
            const kw = k * wi * wj;
            const rows = [[ix, c], [iz, sn]];
            const cols = [[jx, c], [jz, sn]];
            for (const [r, cr] of rows) {
              if (r === undefined) continue;
              for (const [q, cq] of cols) if (q !== undefined) K[r * n + q] += kw * cr * cq;
            }
          }
        }
      }
      // A faint spring to ground on every DOF keeps the matrix solvable; a joint that only that
      // spring holds moves enormously under a unit push, so it counts as unbraced.
      const reg = kmax * 1e-9;
      for (let i = 0; i < n; i++) K[i * n + i] += reg;
      const rhs = free.map(([, d]) => { const f = new Float64Array(n); f[d[1]] = 1; return f; });
      const sol = solve(K, rhs, n, 1e-15);
      if (!sol.ok) continue;
      free.forEach(([key, d], i) => { if (sol.xs[i][d[1]] * kmax < 1e5) braced.add(key); });
      // A glued joint is braced when the beam ends it follows are.
      for (const [id, ms] of follow) {
        for (const s of [0, 1]) if (ms.every((x) => braced.has(`${x.node}:${s}`))) braced.add(`${id}:${s}`);
      }
    }
    return braced;
  }

  /* Length that can bow sideways: follow the straight line of members through unbraced joints. */
  function sidewaysLengths(model, nm, braced) {
    const out = new Map();
    const byNode = new Map();
    for (const m of model.members) {
      for (const id of [m.a, m.b]) {
        if (!byNode.has(id)) byNode.set(id, []);
        byNode.get(id).push(m);
      }
    }
    // Unit direction of member m leaving joint `from`, its length and the joint at the far end.
    const dir = (m, from) => {
      const a = nm.get(from); const b = nm.get(m.a === from ? m.b : m.a);
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      return [(b.x - a.x) / L, (b.y - a.y) / L, L, b.id];
    };
    for (const s of [0, 1]) {
      for (const m of model.members) {
        let total = BS.memberLength(model, m, nm);
        for (const [start, away] of [[m.b, m.a], [m.a, m.b]]) {
          const [ux, uy] = dir(m, away);
          let cur = start;
          let prev = m;
          for (let guard = 0; guard < 200 && !braced.has(`${cur}:${s}`); guard++) {
            const next = (byNode.get(cur) || []).find((h) => {
              if (h === prev) return false;
              const [hx, hy] = dir(h, cur);
              return hx * ux + hy * uy > 0.9999;
            });
            if (!next) break;
            const [, , L, far] = dir(next, cur);
            total += L;
            prev = next;
            cur = far;
          }
        }
        out.set(`${m.id}:${s}`, total);
      }
    }
    return out;
  }

  /* Analyse the intact design. Dead load = self weight, live load = the placed weights.
   * Forces are kept separate so the live load can be scaled for the capacity estimate.
   * Joints glued part-way along a beam have no freedom of their own: they follow the beam's ends,
   * and the force they pass into the beam is kept so the beam can be checked for it. */
  function analyze(model) {
    BS.syncAttached(model);
    const nm = BS.nodeMap(model);
    if (!model.members.length) return { ok: false, reason: 'empty' };
    const used = BS.usedNodes(model);
    if (!model.nodes.some((n) => n.fixed && used.has(n.id))) return { ok: false, reason: 'nosupport' };
    const mat = BS.memberMat(model);

    const dof = new Map();
    const dofNode = [];
    let n = 0;
    for (const nd of model.nodes) {
      if (used.has(nd.id) && !nd.fixed && !nd.on) { dof.set(nd.id, n); dofNode.push(nd.id, nd.id); n += 2; }
    }
    const mcache = new Map();
    const mastersOf = (id) => {
      if (!mcache.has(id)) mcache.set(id, BS.masters(model, id, nm));
      return mcache.get(id);
    };

    const geom = model.members.map((m) => {
      const a = nm.get(m.a);
      const b = nm.get(m.b);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy);
      return { id: m.id, a: m.a, b: m.b, L, c: dx / L, s: dy / L };
    });

    // Point loads per truss and joint (before they are passed to independent joints).
    const pl = [0, 1].map(() => new Map());
    const addP = (s, id, kind, fy) => {
      if (!pl[s].has(id)) pl[s].set(id, { D: 0, L: 0 });
      pl[s].get(id)[kind] += fy;
    };
    for (const g of geom) {
      const W = BS.linearMass(mat) * g.L * BS.G;
      for (const s of [0, 1]) { addP(s, g.a, 'D', -W / 2); addP(s, g.b, 'D', -W / 2); }
    }
    const planGeom = model.plan.map((p) => ({ p, L: BS.planLength(model, p, nm) }));
    for (const { p, L } of planGeom) {
      const W = BS.linearMass(mat) * L * BS.G;
      addP(p.a.s, p.a.n, 'D', -W / 2);
      addP(p.b.s, p.b.n, 'D', -W / 2);
    }
    const infos = [];
    for (const l of model.loads) {
      const info = BS.loadInfo(model, l, nm);
      if (!info) continue;
      for (const tm of info.terms) {
        if (!used.has(tm.node) && !nm.get(tm.node)?.fixed) return { ok: false, reason: 'mechanism', nodeId: tm.node, side: tm.s };
        addP(tm.s, tm.node, 'L', -l.mass * BS.G * tm.c);
      }
      infos.push({ load: l, info });
    }

    const f = [0, 1].map(() => ({ D: new Float64Array(n), L: new Float64Array(n) }));
    for (const s of [0, 1]) {
      for (const [id, P] of pl[s]) {
        for (const { node, w } of mastersOf(id)) {
          const i = dof.get(node);
          if (i === undefined) continue;
          f[s].D[i + 1] += P.D * w;
          f[s].L[i + 1] += P.L * w;
        }
      }
    }

    // Elongation of a bar as weights on the independent DOFs: e = sum(coef * (c ux + s uy)).
    const barTerms = (g) => {
      const t = [];
      for (const { node, w } of mastersOf(g.b)) if (dof.has(node)) t.push([dof.get(node), w]);
      for (const { node, w } of mastersOf(g.a)) if (dof.has(node)) t.push([dof.get(node), -w]);
      return t;
    };
    geom.forEach((g) => { g.terms = barTerms(g); });

    let u = [[new Float64Array(n), new Float64Array(n)], [new Float64Array(n), new Float64Array(n)]];
    if (n > 0) {
      const K = new Float64Array(n * n);
      for (const g of geom) {
        const k = (mat.E * mat.A) / g.L;
        const cc = g.c * g.c; const cs = g.c * g.s; const ss = g.s * g.s;
        for (const [i, wi] of g.terms) {
          for (const [j, wj] of g.terms) {
            const kw = k * wi * wj;
            K[i * n + j] += kw * cc; K[i * n + j + 1] += kw * cs;
            K[(i + 1) * n + j] += kw * cs; K[(i + 1) * n + j + 1] += kw * ss;
          }
        }
      }
      const sol = solve(K, [f[0].D, f[0].L, f[1].D, f[1].L], n);
      if (!sol.ok) return { ok: false, reason: 'mechanism', nodeId: dofNode[sol.badDof], side: 0 };
      u = [[sol.xs[0], sol.xs[1]], [sol.xs[2], sol.xs[3]]];
    }
    const elong = (vec, g) => g.terms.reduce((sum, [i, w]) => sum + w * (g.c * vec[i] + g.s * vec[i + 1]), 0);
    const dispY = (vec, id) => mastersOf(id).reduce((sum, { node, w }) => {
      const i = dof.get(node);
      return i === undefined ? sum : sum + w * vec[i + 1];
    }, 0);

    // Axial forces per truss, dead and live.
    const N = [0, 1].map((s) => new Map(geom.map((g) => {
      const k = (mat.E * mat.A) / g.L;
      return [g.id, { D: k * elong(u[s][0], g), L: k * elong(u[s][1], g) }];
    })));

    // What each attached joint pushes into its beam: the pull of its members plus loads on it.
    const hostLoads = [0, 1].map(() => new Map());
    for (const nd of model.nodes) {
      if (!nd.on || !used.has(nd.id)) continue;
      const host = geom.find((g) => g.id === nd.on.member);
      if (!host) continue;
      for (const s of [0, 1]) {
        const F = { D: [0, 0], L: [0, 0] };
        for (const g of geom) {
          if (g.a !== nd.id && g.b !== nd.id) continue;
          const sign = g.a === nd.id ? 1 : -1; // unit vector from this joint toward the far end
          const f2 = N[s].get(g.id);
          F.D[0] += f2.D * g.c * sign; F.D[1] += f2.D * g.s * sign;
          F.L[0] += f2.L * g.c * sign; F.L[1] += f2.L * g.s * sign;
        }
        const P = pl[s].get(nd.id);
        if (P) { F.D[1] += P.D; F.L[1] += P.L; }
        if (!hostLoads[s].has(host.id)) hostLoads[s].set(host.id, []);
        hostLoads[s].get(host.id).push({
          t: nd.on.t,
          aD: F.D[0] * host.c + F.D[1] * host.s, aL: F.L[0] * host.c + F.L[1] * host.s,
          pD: -F.D[0] * host.s + F.D[1] * host.c, pL: -F.L[0] * host.s + F.L[1] * host.c,
        });
      }
    }

    const braced = lateralBracing(model, nm);
    const Lout = sidewaysLengths(model, nm, braced);

    const items = [];
    for (const s of [0, 1]) {
      for (const g of geom) {
        const perp = Math.abs(g.c);
        const MD = (BS.linearMass(mat) * BS.G * perp * g.L * g.L) / 8;
        let ML = 0;
        for (const { load, info } of infos) {
          if (info.rest.kind !== 'member' || info.rest.id !== g.id) continue;
          const share = info.rest.sides.find((x) => x.s === s);
          if (share) ML += load.mass * BS.G * share.f * perp * info.rest.t * (1 - info.rest.t) * g.L;
        }
        items.push({
          key: `${g.id}:${s}`, kind: 'member', id: g.id, side: s, L: g.L, Lout: Lout.get(`${g.id}:${s}`),
          ND: N[s].get(g.id).D, NL: N[s].get(g.id).L, MD, ML, att: hostLoads[s].get(g.id) || null,
        });
      }
    }
    for (const { p, L } of planGeom) {
      const MD = (BS.linearMass(mat) * BS.G * L * L) / 8;
      let ML = 0;
      for (const { load, info } of infos) {
        if (info.rest.kind === 'plan' && info.rest.id === p.id) ML += load.mass * BS.G * info.rest.t * (1 - info.rest.t) * L;
      }
      items.push({ key: `p${p.id}`, kind: 'plan', id: p.id, L, Lout: L, ND: 0, NL: 0, MD, ML, flat: true });
    }

    let maxDeflection = 0;
    for (const { info } of infos) {
      let dy = 0;
      for (const tm of info.terms) dy += tm.c * (dispY(u[tm.s][0], tm.node) + dispY(u[tm.s][1], tm.node));
      maxDeflection = Math.max(maxDeflection, -dy);
    }

    return { ok: true, items, mat, maxDeflection, braced, Lout };
  }

  /* Check a beam that has joints glued part-way along it. att: [{t, ax, perp}] forces the joints
   * push into the beam (along it, and across it). The push/pull changes at each joint, so every
   * stretch of the beam is checked; the sideways forces bend it like weights would. */
  function checkWithAttachments(mat, L, N0, M0, att, opts) {
    let M = M0;
    for (const a of att) M += Math.abs(a.perp) * a.t * (1 - a.t) * L;
    const cuts = [0, ...att.map((a) => a.t).sort((p, q) => p - q), 1];
    let worst = null;
    for (let i = 0; i < cuts.length - 1; i++) {
      const x = (cuts[i] + cuts[i + 1]) / 2;
      let Ns = N0;
      for (const a of att) Ns += x < a.t ? a.ax * (1 - a.t) : -a.ax * a.t;
      const chk = BS.checkMember(mat, L, Ns, M, opts);
      if (!worst || chk.u > worst.u) worst = chk;
    }
    return worst;
  }

  /* Member checks with the live load scaled by k. */
  function utilisations(res, k) {
    return res.items.map((it) => {
      const opts = { Lout: it.Lout, flat: it.flat };
      const N0 = it.ND + k * it.NL;
      const M0 = it.MD + k * it.ML;
      const chk = it.att
        ? checkWithAttachments(res.mat, it.L, N0, M0, it.att.map((a) => ({ t: a.t, ax: a.aD + k * a.aL, perp: a.pD + k * a.pL })), opts)
        : BS.checkMember(res.mat, it.L, N0, M0, opts);
      return { ...it, ...chk };
    });
  }

  /* Largest live-load factor k such that no member exceeds u = 1 (linear, by bisection). */
  function loadFactor(res) {
    const maxU = (k) => utilisations(res, k).reduce((s, c) => Math.max(s, c.u), 0);
    if (maxU(0) >= 1) return 0;
    let lo = 0;
    let hi = 1;
    while (maxU(hi) < 1 && hi < 1e4) { lo = hi; hi *= 2; }
    if (hi >= 1e4) return Infinity;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (maxU(mid) < 1) lo = mid; else hi = mid;
    }
    return lo;
  }

  const MODE_LABEL = {
    tension: 'Tension', compression: 'Crushing', buckling: 'Buckling', sideways: 'Sideways buckling',
    bending: 'Bending', slack: 'Slack',
  };

  const itemName = (it) => (it.kind === 'plan' ? `P${it.id}` : `M${it.id}`);
  const itemWhere = (it) => (it.kind === 'plan' ? 'top-view piece' : `${BS.sideName(it.side)} truss`);

  function adviceFor(c) {
    switch (c.mode) {
      case 'sideways':
        return `Bows out sideways over ${BS.cm(c.Lout)} because the joints along it are not braced. In the top view, join the two trusses at this height with cross pieces and diagonals.`;
      case 'buckling':
        return `Buckles at ${BS.cm(c.L)} long. Buckling strength falls with length squared, so split it with a joint and brace that joint.`;
      case 'compression':
        return 'Crushes under compression. Make the truss deeper so the chords carry less force, or add a member that shares the push.';
      case 'tension':
        return 'Pulled past its tensile strength. Make the truss deeper, or add a diagonal that shares the pull.';
      case 'bending':
        if (c.att && c.att.length) return 'A piece glued part-way along this beam bends it. Move the glued joint to a proper joint, or brace the beam right under it.';
        return c.kind === 'plan'
          ? 'Bends under the weight resting on it. Move the weight nearer a truss, add a piece under it, or shorten this span.'
          : 'The weight sits between joints and bends this piece. Put a joint under the weight or shorten this piece.';
      default:
        return 'Carries little force at this load.';
    }
  }

  /* Full report for the results panel. `sim` (optional) supplies what happened in the dynamic test. */
  function buildReport(model, sim) {
    const res = analyze(model);
    const totalLoad = model.loads.reduce((s, l) => s + l.mass, 0);
    const report = { static: res, totalLoad, weak: [], tips: [], source: 'static' };

    let checks;
    if (res.ok) {
      checks = utilisations(res, 1);
      const k = totalLoad > 0 ? loadFactor(res) : Infinity;
      report.loadFactor = k;
      report.safeLoad = totalLoad > 0 ? k * totalLoad : null;
      report.maxDeflection = res.maxDeflection;
    } else if (sim) {
      report.source = 'dynamic';
      checks = [...sim.members, ...sim.plans].map((c) => ({
        key: c.key, kind: c.kind, id: c.id, side: c.side, L: c.L0, Lout: c.Lout, u: c.peakU, mode: c.peakMode || 'tension',
      }));
    } else {
      checks = [];
    }
    report.checks = new Map(checks.map((c) => [c.key, c]));
    report.peakU = checks.reduce((s, c) => Math.max(s, c.u), 0);

    const ranked = checks.filter((c) => c.mode !== 'slack').sort((a, b) => b.u - a.u);
    report.weak = ranked.slice(0, 6).map((c, i) => ({
      rank: i + 1, key: c.key, kind: c.kind, id: c.id, side: c.side, u: c.u, mode: c.mode,
      modeLabel: MODE_LABEL[c.mode] || c.mode, L: c.L, name: itemName(c), where: itemWhere(c), advice: adviceFor(c),
    }));

    if (!res.ok && res.reason === 'mechanism') {
      report.tips.push(`Joint J${res.nodeId} can move without stretching any member, so the trusses fold like a hinge. Add diagonals in the side view until every panel is a triangle.`);
    } else if (!res.ok && res.reason === 'nosupport') {
      report.tips.push('Nothing is anchored. Use the Anchor tool on the table edges to pin the bridge down.');
    }
    if (res.ok) {
      if (ranked.some((c) => c.mode === 'sideways' && c.u > 0.3)) {
        report.tips.push('Compression chords are bowing out sideways. In the top view, pick the chord\'s height and add cross pieces plus diagonals so the bracing forms triangles. A ladder of cross pieces alone can still shift sideways.');
      }
      if (!model.plan.length) report.tips.push('The two trusses are not joined. Use the Top view to add cross pieces under the deck and bracing between the top chords.');
      const bending = ranked.filter((c) => c.mode === 'bending' && c.u > 0.5);
      if (bending.length) report.tips.push('Weights placed between joints bend the piece under them. Trusses are strongest when weights land on joints.');
      const lazy = checks.filter((c) => c.kind === 'member' && c.u < 0.03).length;
      if (lazy >= 4 && report.peakU < 1) report.tips.push(`${lazy} truss members carry almost nothing at this load. Some may still be needed for stability, but they are candidates to remove.`);
      if (report.safeLoad != null && Number.isFinite(report.safeLoad)) {
        const ratio = report.safeLoad / totalLoad;
        if (ratio < 1) report.tips.push(`The first member gives way at about ${BS.kgLabel(report.safeLoad)}, ${((1 - ratio) * 100).toFixed(0)}% short of the ${BS.kgLabel(totalLoad)} you placed.`);
        else if (ratio < 1.5) report.tips.push(`Safety factor is ${ratio.toFixed(2)}. Engineers usually aim for 1.5 or more on bridges.`);
      }
      const limit = model.gap / 250;
      if (res.maxDeflection > limit) report.tips.push(`It sags ${BS.cm(res.maxDeflection, 2)}, more than the usual L/250 limit of ${BS.cm(limit, 2)} for this span. Make it deeper.`);
    }
    const stats = BS.designStats(model);
    if (stats.overLong) report.tips.push(`${stats.overLong} piece${stats.overLong > 1 ? 's are' : ' is'} longer than your ${BS.cm(BS.memberMat(model).maxLen)} stick. Add joints so each fits on one stick.`);
    if (sim && sim.events.length && res.ok) {
      const first = sim.events[0];
      if (!report.weak.some((w) => w.key === first.key)) {
        report.tips.push(`${first.name} broke first in the live test because of dynamic shaking, even though the static check rates other members weaker.`);
      }
    }
    return report;
  }

  Object.assign(BS, {
    solveLinear: solve, analyze, checkWithAttachments, lateralBracing, sidewaysLengths, utilisations, loadFactor, buildReport,
    MODE_LABEL, itemName, itemWhere,
  });
})(typeof window !== 'undefined' ? window : globalThis);
