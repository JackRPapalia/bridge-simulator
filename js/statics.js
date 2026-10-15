/* Linear static analysis of a pin-jointed truss (direct stiffness method),
 * plus the weak-point ranking, safe-load estimate and design advice built on it. */
(function (root) {
  'use strict';
  const BS = root.BS;

  /* Solve K x = f for several right-hand sides with partial pivoting.
   * Returns { ok, xs } or { ok:false, badDof } when K is singular (a mechanism). */
  function solve(K, rhs, n) {
    const r = rhs.length;
    const A = Float64Array.from(K);
    const B = rhs.map((f) => Float64Array.from(f));
    let maxDiag = 0;
    for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, Math.abs(A[i * n + i]));
    const tol = maxDiag * 1e-9;
    const perm = new Int32Array(n);
    for (let i = 0; i < n; i++) perm[i] = i;

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

  /* Analyse the intact design. Dead load = self weight, live load = the placed weights.
   * Forces are returned separately so the live load can be scaled for the capacity estimate. */
  function analyze(model) {
    const nm = BS.nodeMap(model);
    if (!model.members.length) return { ok: false, reason: 'empty' };

    const used = new Set();
    model.members.forEach((m) => { used.add(m.a); used.add(m.b); });
    if (!model.nodes.some((n) => n.fixed && used.has(n.id))) return { ok: false, reason: 'nosupport' };

    const dof = new Map();
    const dofNode = [];
    let n = 0;
    for (const nd of model.nodes) {
      if (used.has(nd.id) && !nd.fixed) { dof.set(nd.id, n); dofNode.push(nd.id, nd.id); n += 2; }
    }

    const mat = BS.memberMat(model);
    const geom = model.members.map((m) => {
      const a = nm.get(m.a);
      const b = nm.get(m.b);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const L = Math.hypot(dx, dy);
      return { id: m.id, m, a: m.a, b: m.b, L, c: dx / L, s: dy / L, mat };
    });
    const geomById = new Map(geom.map((g) => [g.id, g]));

    const fD = new Float64Array(n);
    const fL = new Float64Array(n);
    const addFy = (f, id, fy) => { const i = dof.get(id); if (i !== undefined) f[i + 1] += fy; };

    for (const g of geom) {
      const W = BS.linearMass(g.mat) * g.L * BS.G;
      addFy(fD, g.a, -W / 2);
      addFy(fD, g.b, -W / 2);
    }
    for (const l of model.loads) {
      const P = l.mass * BS.G;
      if (l.node != null) {
        const nd = nm.get(l.node);
        if (!nd) continue;
        if (!used.has(nd.id) && !nd.fixed) return { ok: false, reason: 'mechanism', nodeId: nd.id };
        addFy(fL, l.node, -P);
      } else {
        const g = geomById.get(l.member);
        if (!g) continue;
        addFy(fL, g.a, -(1 - l.t) * P);
        addFy(fL, g.b, -l.t * P);
      }
    }

    const active = geom.map(() => true);
    let uD = new Float64Array(n);
    let uL = new Float64Array(n);
    const dispOf = (u, id, k) => { const i = dof.get(id); return i === undefined ? 0 : u[i + k]; };
    const elong = (u, g) =>
      g.c * (dispOf(u, g.b, 0) - dispOf(u, g.a, 0)) + g.s * (dispOf(u, g.b, 1) - dispOf(u, g.a, 1));

    // Cables carry tension only: iterate the active set until it is consistent.
    for (let iter = 0; iter < 16; iter++) {
      if (n > 0) {
        const K = new Float64Array(n * n);
        geom.forEach((g, gi) => {
          if (!active[gi]) return;
          const k = (g.mat.E * g.mat.A) / g.L;
          const loc = [g.c * g.c, g.c * g.s, g.s * g.s];
          const ia = dof.get(g.a);
          const ib = dof.get(g.b);
          const idx = [ia, ia === undefined ? undefined : ia + 1, ib, ib === undefined ? undefined : ib + 1];
          const sign = [1, 1, -1, -1];
          for (let p = 0; p < 4; p++) {
            if (idx[p] === undefined) continue;
            for (let q = 0; q < 4; q++) {
              if (idx[q] === undefined) continue;
              const kk = (p % 2 === 0 ? (q % 2 === 0 ? loc[0] : loc[1]) : q % 2 === 0 ? loc[1] : loc[2]);
              K[idx[p] * n + idx[q]] += k * kk * sign[p] * sign[q];
            }
          }
        });
        const sol = solve(K, [fD, fL], n);
        if (!sol.ok) {
          const slackCables = geom.filter((g, gi) => !active[gi]).map((g) => g.id);
          return { ok: false, reason: 'mechanism', nodeId: dofNode[sol.badDof], slackCables };
        }
        uD = sol.xs[0];
        uL = sol.xs[1];
      }
      let changed = false;
      geom.forEach((g, gi) => {
        if (!g.mat.tensionOnly) return;
        const e = elong(uD, g) + elong(uL, g);
        if (active[gi] && e < -1e-12) { active[gi] = false; changed = true; }
        else if (!active[gi] && e > 1e-12) { active[gi] = true; changed = true; }
      });
      if (!changed) break;
    }

    const members = geom.map((g, gi) => {
      const k = (g.mat.E * g.mat.A) / g.L;
      const slack = !active[gi];
      const ND = slack ? 0 : k * elong(uD, g);
      const NL = slack ? 0 : k * elong(uL, g);
      // Bending: self weight as a UDL, placed weights as point loads (perpendicular components).
      const perp = Math.abs(g.c);
      const MD = (BS.linearMass(g.mat) * BS.G * perp * g.L * g.L) / 8;
      let ML = 0;
      for (const l of model.loads) {
        if (l.member === g.id) ML += l.mass * BS.G * perp * l.t * (1 - l.t) * g.L;
      }
      return { id: g.id, mat: g.mat, L: g.L, ND, NL, MD, ML, slack, a: g.a, b: g.b };
    });

    const disp = new Map();
    for (const nd of model.nodes) {
      disp.set(nd.id, {
        x: dispOf(uD, nd.id, 0) + dispOf(uL, nd.id, 0),
        y: dispOf(uD, nd.id, 1) + dispOf(uL, nd.id, 1),
      });
    }
    let maxDeflection = 0;
    for (const l of model.loads) {
      let dy;
      if (l.node != null) dy = disp.get(l.node)?.y || 0;
      else {
        const g = geomById.get(l.member);
        if (!g) continue;
        dy = (1 - l.t) * disp.get(g.a).y + l.t * disp.get(g.b).y;
      }
      maxDeflection = Math.max(maxDeflection, -dy);
    }

    return { ok: true, members, disp, maxDeflection };
  }

  /* Member checks with the live load scaled by k. */
  function utilisations(res, k) {
    return res.members.map((m) => ({
      id: m.id, mat: m.mat, L: m.L,
      ...BS.checkMember(m.mat, m.L, m.ND + k * m.NL, m.MD + k * m.ML),
    }));
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
    tension: 'Tension', compression: 'Crushing', buckling: 'Buckling', bending: 'Bending', slack: 'Slack',
  };

  function adviceFor(check, L) {
    switch (check.mode) {
      case 'buckling':
        return `Buckles at ${BS.cm(L)} long. Buckling strength falls with length squared, so split it with a joint and brace that joint.`;
      case 'compression':
        return 'Crushes under compression. Make the truss deeper so the chords carry less force, or add a member that shares the push.';
      case 'tension':
        return 'Pulled past its tensile strength. Make the truss deeper, or add a diagonal that shares the pull.';
      case 'bending':
        return 'The weight sits between joints and bends this piece. Put a joint under the weight or shorten this piece.';
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
      checks = sim.members.map((c) => ({
        id: c.id, mat: c.mat, L: c.L0, u: c.peakU, mode: c.peakMode || 'tension',
      }));
    } else {
      checks = [];
    }
    report.checks = new Map(checks.map((c) => [c.id, c]));
    report.peakU = checks.reduce((s, c) => Math.max(s, c.u), 0);

    const ranked = checks.filter((c) => c.mode !== 'slack').sort((a, b) => b.u - a.u);
    report.weak = ranked.slice(0, 6).map((c, i) => ({
      rank: i + 1, id: c.id, u: c.u, mode: c.mode, modeLabel: MODE_LABEL[c.mode] || c.mode,
      mat: c.mat, L: c.L, advice: adviceFor(c, c.L),
    }));

    // Design-level advice.
    if (!res.ok && res.reason === 'mechanism') {
      report.tips.push(`Joint J${res.nodeId} can move without stretching any member, so the bridge folds like a hinge. Add diagonals until every panel is a triangle.`);
    } else if (!res.ok && res.reason === 'nosupport') {
      report.tips.push('Nothing is anchored. Use the Anchor tool on the table edges to pin the bridge down.');
    }
    if (res.ok) {
      const slack = res.members.filter((m) => m.slack && m.mat.tensionOnly);
      if (slack.length) report.tips.push(`${slack.length} cable${slack.length > 1 ? 's go' : ' goes'} slack under this load. Cables only pull, so swap them for rigid members where they would be pushed.`);
      const bending = ranked.filter((c) => c.mode === 'bending' && c.u > 0.5);
      if (bending.length) report.tips.push('Weights placed between joints bend the beam under them. Trusses are strongest when loads land on joints.');
      const lazy = checks.filter((c) => c.u < 0.03).length;
      if (lazy >= 3 && report.peakU < 1) report.tips.push(`${lazy} members carry almost nothing at this load. Some may still be needed for stability, but they are candidates to remove.`);
      if (report.safeLoad != null && Number.isFinite(report.safeLoad)) {
        const ratio = report.safeLoad / totalLoad;
        if (ratio < 1) report.tips.push(`The first member gives way at about ${BS.kgLabel(report.safeLoad)}, ${((1 - ratio) * 100).toFixed(0)}% short of the ${BS.kgLabel(totalLoad)} you placed.`);
        else if (ratio < 1.5) report.tips.push(`Safety factor is ${ratio.toFixed(2)}. Engineers usually aim for 1.5 or more on bridges.`);
      }
      if (res.maxDeflection > 0) {
        const span = model.gap;
        const limit = span / 250;
        if (res.maxDeflection > limit) report.tips.push(`It sags ${BS.cm(res.maxDeflection, 2)}, more than the usual L/250 limit of ${BS.cm(limit, 2)} for this span. Make it deeper.`);
      }
    }
    const stats = BS.designStats(model);
    if (stats.overLong) report.tips.push(`${stats.overLong} member${stats.overLong > 1 ? 's are' : ' is'} longer than your ${BS.cm(BS.memberMat(model).maxLen)} piece. Add joints so each fits on one piece.`);
    if (sim && sim.events.length && res.ok) {
      const first = sim.events[0];
      if (!report.weak.some((w) => w.id === first.id)) {
        report.tips.push(`M${first.id} broke first in the live test because of dynamic shaking, even though the static check rates other members weaker.`);
      }
    }
    return report;
  }

  Object.assign(BS, { solveLinear: solve, analyze, utilisations, loadFactor, buildReport, MODE_LABEL });
})(typeof window !== 'undefined' ? window : globalThis);
