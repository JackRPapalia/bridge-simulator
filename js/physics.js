/* Real-time dynamic test.
 *
 * Both side trusses are simulated in their own planes with many small time steps. Each side member
 * is a spring that obeys Hooke's law exactly (F = EA·ΔL/L, from the current geometry), with a
 * dashpot to calm vibration; that keeps the force split right in structures with redundant
 * members. Weights hang on hard position constraints (XPBD ties). Joint inertia is raised where
 * needed so the stiff springs stay stable; gravity only ever acts on the real mass.
 *
 * A joint glued part-way along a beam is not a particle of its own: it is the point
 * (1 - t)·a + t·b on that beam, so members attached there push and pull on the beam's ends,
 * exactly as in the static solver. Weights are particles tied to the joints they rest on.
 * Top-view pieces are checked for bending under the weights they carry. Pieces break when their
 * utilisation reaches 1. */
(function (root) {
  'use strict';
  const BS = root.BS;

  const MIN_SUBSTEPS = 200;
  const MAX_SUBSTEPS = 800;
  const MAX_EXTRA_INERTIA = 0.05; // kg; substeps are raised until joints need no more than this
  const SELF_RAMP = 0.4;      // s to bring self weight on
  const LOAD_START = 0.5;     // s when the weights start pressing down
  const LOAD_RAMP = 2.0;      // s to reach full weight
  const JOINT_MASS = 0.001;   // kg of glue per joint (feels gravity)
  const MIN_INERTIA = 0.02;   // kg; inertia floor that keeps the solver well conditioned (no extra weight)
  const FORCE_SMOOTH = 0.02;  // s time constant for the force read-out
  const AIR_DAMP = 1.2;       // 1/s global velocity damping
  const DAMP_RATIO = 0.3;     // member dashpot as a fraction of critical damping

  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

  class Simulation {
    constructor(model) {
      this.model = BS.cloneModel(model);
      const M = this.model;
      BS.syncAttached(M);
      this.terrain = BS.terrainOf(M);
      const nm = BS.nodeMap(M);
      this.nm = nm;
      const mat = BS.memberMat(M);
      this.mat = mat;

      const used = BS.usedNodes(M);
      const infos = M.loads.map((l) => ({ load: l, info: BS.loadInfo(M, l, nm) })).filter((x) => x.info);
      infos.forEach(({ info }) => info.terms.forEach((t) => used.add(t.node)));
      // Joints glued onto beams have no particle; their beams' ends do.
      const simNodes = M.nodes.filter((n) => used.has(n.id) && !n.on);
      for (const n of M.nodes) {
        if (!n.on || !used.has(n.id)) continue;
        for (const { node } of BS.masters(M, n.id, nm)) if (!simNodes.some((x) => x.id === node)) simNodes.push(nm.get(node));
      }

      // A spare particle for every glued joint, used if its beam breaks and it comes loose.
      const gluedUsed = M.nodes.filter((n) => n.on && used.has(n.id));
      const N = simNodes.length * 2 + infos.length + gluedUsed.length * 2;
      this.count = N;
      this.x = new Float64Array(N); this.y = new Float64Array(N);
      this.px = new Float64Array(N); this.py = new Float64Array(N);
      this.vx = new Float64Array(N); this.vy = new Float64Array(N);
      this.inv = new Float64Array(N);
      this.selfMass = new Float64Array(N);
      this.loadMass = new Float64Array(N);
      this.x0 = new Float64Array(N); this.y0 = new Float64Array(N);
      this.nodeIndex = new Map();

      let i = 0;
      for (const s of [0, 1]) {
        for (const n of simNodes) {
          this.nodeIndex.set(`${n.id}:${s}`, i);
          this.x[i] = n.x; this.y[i] = n.y;
          i++;
        }
      }
      // Particles (with weights) a joint's position is made of on truss s. A glued joint is a point
      // on its beam, unless it has come loose and has its own particle.
      this.loose = new Map();
      this.tcache = new Map();
      const resolve = (id, s, depth) => {
        const key = `${id}:${s}`;
        if (this.loose.has(key)) return [{ p: this.loose.get(key), c: 1 }];
        const n = nm.get(id);
        const host = n.on && depth < 50 && M.members.find((mm) => mm.id === n.on.member);
        if (!host) return [{ p: this.nodeIndex.get(key), c: 1 }];
        return [
          ...resolve(host.a, s, depth + 1).map((t) => ({ p: t.p, c: t.c * (1 - n.on.t) })),
          ...resolve(host.b, s, depth + 1).map((t) => ({ p: t.p, c: t.c * n.on.t })),
        ];
      };
      this.terms = (id, s) => {
        const key = `${id}:${s}`;
        if (!this.tcache.has(key)) this.tcache.set(key, resolve(id, s, 0));
        return this.tcache.get(key);
      };
      const spread = (id, s, mass) => { for (const t of this.terms(id, s)) this.selfMass[t.p] += mass * t.c; };

      const braced = BS.lateralBracing(M, nm);
      const Lout = BS.sidewaysLengths(M, nm, braced);

      this.members = [];
      for (const s of [0, 1]) {
        for (const m of M.members) {
          const ta = this.terms(m.a, s);
          const tb = this.terms(m.b, s);
          const L0 = BS.memberLength(M, m, nm);
          const half = (BS.linearMass(mat) * L0) / 2;
          spread(m.a, s, half); spread(m.b, s, half);
          this.members.push({
            key: `${m.id}:${s}`, kind: 'member', id: m.id, side: s, na: m.a, nb: m.b, ta, tb, L0, Lout: Lout.get(`${m.id}:${s}`),
            alpha: L0 / (mat.E * mat.A), broken: false, F: 0, Fs: 0, u: 0, mode: '', peakU: 0, peakMode: '', M: 0,
            name: `M${m.id}`, where: `${BS.sideName(s)} truss`,
          });
        }
      }
      this.memberByKey = new Map(this.members.map((c) => [c.key, c]));

      this.plans = M.plan.map((p) => {
        const L0 = BS.planLength(M, p, nm);
        const half = (BS.linearMass(mat) * L0) / 2;
        spread(p.a.n, p.a.s, half); spread(p.b.n, p.b.s, half);
        return {
          key: `p${p.id}`, kind: 'plan', id: p.id, ta: this.terms(p.a.n, p.a.s), tb: this.terms(p.b.n, p.b.s), L0, Lout: L0,
          broken: false, u: 0, mode: '', peakU: 0, peakMode: '', name: `P${p.id}`, where: 'top-view piece',
        };
      });
      this.planById = new Map(this.plans.map((c) => [c.id, c]));

      // Every weight is a particle tied to the joints it rests on: p = sum(c_i * x_i).
      this.weights = infos.map(({ load, info }, k) => {
        const p = simNodes.length * 2 + k;
        const terms = [];
        for (const t of info.terms) for (const q of this.terms(t.node, t.s)) terms.push({ p: q.p, c: q.c * t.c });
        this.x[p] = terms.reduce((sum, t) => sum + t.c * this.x[t.p], 0);
        this.y[p] = terms.reduce((sum, t) => sum + t.c * this.y[t.p], 0);
        this.loadMass[p] = load.mass;
        this.inv[p] = 1 / load.mass;
        let rests = [];
        if (info.rest.kind === 'plan') rests = [`p${info.rest.id}`];
        else if (info.rest.kind === 'member') rests = info.rest.sides.map((x) => `${info.rest.id}:${x.s}`);
        return { load, p, terms, nodeTerms: info.terms, rest: info.rest, rests, z: info.pos.z, active: true };
      });

      let spare = simNodes.length * 2 + infos.length;
      this.spares = new Map();
      for (const n of gluedUsed) for (const sd of [0, 1]) this.spares.set(`${n.id}:${sd}`, spare++);

      // Glue mass at every joint; glued joints pass theirs to the beam ends they ride on.
      for (const n of M.nodes) if (used.has(n.id)) for (const s of [0, 1]) spread(n.id, s, JOINT_MASS);

      // Stability of the explicit springs needs h² · (sum of spring stiffness at a joint) / mass
      // to stay small. Pick the substep count, then raise joint inertia where still needed.
      const kSum = new Float64Array(N);
      for (const c of this.members) {
        c.k = 1 / c.alpha;
        for (const t of [...c.ta, ...c.tb]) kSum[t.p] += c.k * t.c;
      }
      let kMax = 0;
      for (let j = 0; j < N; j++) kMax = Math.max(kMax, kSum[j]);
      const hNeed = Math.sqrt(MAX_EXTRA_INERTIA / (2.5 * Math.max(kMax, 1)));
      this.substeps = Math.min(MAX_SUBSTEPS, Math.max(MIN_SUBSTEPS, Math.ceil(1 / 60 / hNeed)));
      const h = 1 / 60 / this.substeps;
      simNodes.forEach((n) => {
        for (const s of [0, 1]) {
          const j = this.nodeIndex.get(`${n.id}:${s}`);
          this.inv[j] = n.fixed ? 0 : 1 / Math.max(this.selfMass[j], MIN_INERTIA, 2.5 * h * h * kSum[j]);
        }
      });
      this.updateWeights = () => {
        for (const c of this.members) {
          c.w = c.ta.reduce((sum, t) => sum + t.c * t.c * this.inv[t.p], 0) + c.tb.reduce((sum, t) => sum + t.c * t.c * this.inv[t.p], 0);
          c.eta = c.w > 0 ? DAMP_RATIO * 2 * Math.sqrt(c.k / c.w) : 0;
        }
      };
      this.updateWeights();
      this.fx = new Float64Array(N);
      this.fy = new Float64Array(N);

      // Glued joints whose beams need checking for the force they pass in.
      this.glued = [];
      for (const n of M.nodes) {
        if (!n.on || !used.has(n.id)) continue;
        const host = M.members.find((mm) => mm.id === n.on.member);
        if (!host) continue;
        for (const s of [0, 1]) {
          const at = this.members.filter((c) => c.side === s && (c.na === n.id || c.nb === n.id));
          let selfM = JOINT_MASS;
          for (const c of at) selfM += (BS.linearMass(mat) * c.L0) / 2;
          for (const p of M.plan) {
            if ((p.a.n === n.id && p.a.s === s) || (p.b.n === n.id && p.b.s === s)) selfM += (BS.linearMass(mat) * BS.planLength(M, p, nm)) / 2;
          }
          this.glued.push({ node: n.id, side: s, t: n.on.t, hostKey: `${host.id}:${s}`, at, selfM });
        }
      }

      this.x0.set(this.x); this.y0.set(this.y);
      this.time = 0;
      this.events = [];
      this.debris = [];
      this.collapseTime = null;
      this.calmTime = 0;
      this.done = false;
      this.outcome = null;
      this.peakDeflection = 0;
      this.maxPeakU = 0;
      this.fallDrop = Math.max(0.05, 0.2 * M.gap);
    }

    get loadRamp() { return smooth((this.time - LOAD_START) / LOAD_RAMP); }
    get selfRamp() { return smooth(this.time / SELF_RAMP); }

    point(terms) {
      let px = 0; let py = 0;
      for (const t of terms) { px += t.c * this.x[t.p]; py += t.c * this.y[t.p]; }
      return [px, py];
    }

    /* Current end points of a member or top-view piece: [x0, y0, x1, y1]. */
    ends(c) { return [...this.point(c.ta), ...this.point(c.tb)]; }

    step(frameDt) {
      const n = Math.round((this.substeps * frameDt) * 60) || 1;
      const h = frameDt / n;
      for (let s = 0; s < n; s++) this.substep(h);
      this.afterFrame(frameDt);
    }

    substep(h) {
      const { x, y, px, py, vx, vy, inv, selfMass, loadMass, fx, fy } = this;
      const N = this.count;
      const G = BS.G;
      const selfR = this.selfRamp;
      const loadR = this.loadRamp;
      const damp = Math.exp(-AIR_DAMP * h);
      fx.fill(0);
      fy.fill(0);

      // Spring and dashpot forces from the current geometry.
      for (const c of this.members) {
        if (c.broken || c.w === 0) { c.F = 0; continue; }
        let ax = 0; let ay = 0; let avx = 0; let avy = 0;
        for (const t of c.ta) { ax += t.c * x[t.p]; ay += t.c * y[t.p]; avx += t.c * vx[t.p]; avy += t.c * vy[t.p]; }
        let bx = 0; let by = 0; let bvx = 0; let bvy = 0;
        for (const t of c.tb) { bx += t.c * x[t.p]; by += t.c * y[t.p]; bvx += t.c * vx[t.p]; bvy += t.c * vy[t.p]; }
        const dx = bx - ax; const dy = by - ay;
        const d = Math.hypot(dx, dy);
        if (d < 1e-12) { c.F = 0; continue; }
        const nx = dx / d; const ny = dy / d;
        const F = (d - c.L0) * c.k;
        c.F = F;
        const Ft = F + c.eta * ((bvx - avx) * nx + (bvy - avy) * ny);
        for (const t of c.ta) { fx[t.p] += t.c * Ft * nx; fy[t.p] += t.c * Ft * ny; }
        for (const t of c.tb) { fx[t.p] -= t.c * Ft * nx; fy[t.p] -= t.c * Ft * ny; }
      }

      for (let i = 0; i < N; i++) {
        px[i] = x[i]; py[i] = y[i];
        if (inv[i] === 0) continue;
        vx[i] = (vx[i] + h * fx[i] * inv[i]) * damp;
        vy[i] = (vy[i] + h * (fy[i] - G * (selfMass[i] * selfR + loadMass[i] * loadR)) * inv[i]) * damp;
        x[i] += h * vx[i];
        y[i] += h * vy[i];
      }

      for (const wt of this.weights) {
        if (!wt.active) continue;
        const p = wt.p;
        let cx = x[p];
        let cy = y[p];
        let w = inv[p];
        for (const t of wt.terms) { cx -= t.c * x[t.p]; cy -= t.c * y[t.p]; w += t.c * t.c * inv[t.p]; }
        if (w === 0) continue;
        x[p] -= (inv[p] * cx) / w; y[p] -= (inv[p] * cy) / w;
        for (const t of wt.terms) {
          x[t.p] += (t.c * inv[t.p] * cx) / w;
          y[t.p] += (t.c * inv[t.p] * cy) / w;
        }
      }

      for (let i = 0; i < N; i++) if (inv[i] > 0) this.collide(i);

      for (let i = 0; i < N; i++) {
        vx[i] = (x[i] - px[i]) / h;
        vy[i] = (y[i] - py[i]) / h;
      }

      const sm = h / FORCE_SMOOTH;
      for (const c of this.members) if (!c.broken) c.Fs += (c.F - c.Fs) * sm;
      this.time += h;
    }

    collide(i) {
      const { x, y, px } = this;
      for (const r of this.terrain.rects) {
        if (x[i] > r.x0 && x[i] < r.x1 && y[i] < r.y1 && y[i] > r.y0) {
          const up = r.y1 - y[i];
          const left = x[i] - r.x0;
          const right = r.x1 - x[i];
          if (up <= left && up <= right) {
            y[i] = r.y1;
            x[i] = px[i] + (x[i] - px[i]) * 0.3; // friction on the ground
          } else if (left < right) x[i] = r.x0;
          else x[i] = r.x1;
        }
      }
    }

    /* Bending moment in side member c from self weight and weights resting on it (current geometry). */
    memberMoment(c) {
      const [ax, ay, bx, by] = this.ends(c);
      const L = Math.hypot(bx - ax, by - ay) || c.L0;
      const perp = Math.abs(bx - ax) / L;
      let M = (BS.linearMass(this.mat) * BS.G * this.selfRamp * perp * L * L) / 8;
      for (const wt of this.weights) {
        if (!wt.active || wt.rest.kind !== 'member' || wt.rest.id !== c.id) continue;
        const share = wt.rest.sides.find((sd) => sd.s === c.side);
        if (share) M += wt.load.mass * BS.G * this.loadRamp * share.f * perp * wt.rest.t * (1 - wt.rest.t) * L;
      }
      return M;
    }

    /* Forces glued joints push into beam c, split along it and across it: the pull of the members
     * meeting at each joint plus the weight resting there (current geometry). */
    attachedLoads(c) {
      const out = [];
      for (const g of this.glued) {
        if (g.hostKey !== c.key) continue;
        const [jx, jy] = this.point(this.terms(g.node, g.side));
        let fx = 0;
        let fy = -g.selfM * BS.G * this.selfRamp;
        for (const m of g.at) {
          if (m.broken) continue;
          const [ax, ay, bx, by] = this.ends(m);
          const [ox, oy] = m.na === g.node ? [bx, by] : [ax, ay];
          const d = Math.hypot(ox - jx, oy - jy) || 1;
          fx += (m.Fs * (ox - jx)) / d;
          fy += (m.Fs * (oy - jy)) / d;
        }
        for (const wt of this.weights) {
          if (!wt.active) continue;
          for (const t of wt.nodeTerms) if (t.node === g.node && t.s === g.side) fy -= wt.load.mass * BS.G * this.loadRamp * t.c;
        }
        const [ax, ay, bx, by] = this.ends(c);
        const L = Math.hypot(bx - ax, by - ay) || 1;
        const ux = (bx - ax) / L; const uy = (by - ay) / L;
        out.push({ t: g.t, ax: fx * ux + fy * uy, perp: -fx * uy + fy * ux });
      }
      return out;
    }

    planMoment(c) {
      let M = (BS.linearMass(this.mat) * BS.G * this.selfRamp * c.L0 * c.L0) / 8;
      for (const wt of this.weights) {
        if (wt.active && wt.rest.kind === 'plan' && wt.rest.id === c.id) {
          M += wt.load.mass * BS.G * this.loadRamp * wt.rest.t * (1 - wt.rest.t) * c.L0;
        }
      }
      return M;
    }

    afterFrame(dt) {
      let worst = null;
      let worstCheck = null;
      const consider = (c, chk) => {
        c.u = chk.u;
        c.mode = chk.mode;
        if (this.time > 0.15 && chk.u > c.peakU) { c.peakU = chk.u; c.peakMode = chk.mode; }
        if (this.time > 0.15 && chk.u >= 1 && (!worst || chk.u > worstCheck.u)) { worst = c; worstCheck = chk; }
      };
      for (const c of this.members) {
        if (c.broken) continue;
        c.M = this.memberMoment(c);
        const att = this.glued.length ? this.attachedLoads(c) : [];
        consider(c, att.length
          ? BS.checkWithAttachments(this.mat, c.L0, c.Fs, c.M, att, { Lout: c.Lout })
          : BS.checkMember(this.mat, c.L0, c.Fs, c.M, { Lout: c.Lout }));
      }
      for (const c of this.plans) {
        if (c.broken) continue;
        consider(c, BS.checkMember(this.mat, c.L0, 0, this.planMoment(c), { flat: true }));
      }
      if (worst) this.breakPiece(worst, worstCheck);
      this.maxPeakU = [...this.members, ...this.plans].reduce((s, c) => Math.max(s, c.peakU), 0);

      // Track the weights: deflection and whether they fell.
      let fallen = false;
      for (const w of this.weights) {
        const drop = this.y0[w.p] - this.y[w.p];
        if (drop > this.fallDrop) fallen = true;
        else this.peakDeflection = Math.max(this.peakDeflection, drop);
      }
      if (fallen && this.collapseTime == null) this.collapseTime = this.time;

      this.updateDebris(dt);

      let maxV = 0;
      for (let i = 0; i < this.count; i++) {
        if (this.inv[i] === 0 || this.y[i] <= this.terrain.floorY + 0.002) continue;
        maxV = Math.max(maxV, Math.hypot(this.vx[i], this.vy[i]));
      }
      const loaded = this.time > LOAD_START + LOAD_RAMP + 0.3;
      this.calmTime = loaded && maxV < 0.005 ? this.calmTime + dt : 0;

      if (!this.done) {
        if ((this.collapseTime != null && this.time > this.collapseTime + 2.5) || this.calmTime > 0.6 || this.time > 14) {
          this.finish();
        }
      }
    }

    breakPiece(c, chk) {
      c.broken = true;
      c.peakU = Math.max(c.peakU, chk.u);
      c.peakMode = chk.mode;
      c.u = chk.u;
      this.events.push({
        key: c.key, kind: c.kind, id: c.id, side: c.side, name: c.name, where: c.where,
        time: this.time, mode: chk.mode, force: chk.N, load: this.loadRamp,
      });
      for (const wt of this.weights) if (wt.rests.includes(c.key)) wt.active = false;
      // Joints glued onto a broken beam come loose where they are and fall with what hangs off them.
      const freed = this.glued.filter((g) => g.hostKey === c.key);
      if (freed.length) {
        for (const g of freed) {
          const key = `${g.node}:${g.side}`;
          const sp = this.spares.get(key);
          const terms = this.terms(g.node, g.side);
          const [jx, jy] = this.point(terms);
          let vxs = 0; let vys = 0;
          for (const t of terms) { vxs += t.c * this.vx[t.p]; vys += t.c * this.vy[t.p]; }
          this.x[sp] = jx; this.y[sp] = jy; this.vx[sp] = vxs; this.vy[sp] = vys;
          this.selfMass[sp] = g.selfM;
          let kAt = 0;
          for (const m of g.at) kAt += m.k;
          this.inv[sp] = 1 / Math.max(g.selfM, MIN_INERTIA, 2.5 * (1 / 60 / this.substeps) ** 2 * kAt);
          // Its share of mass leaves the beam ends it rode on.
          for (const t of terms) this.selfMass[t.p] = Math.max(0, this.selfMass[t.p] - g.selfM * t.c);
          this.loose.set(key, sp);
        }
        this.tcache.clear();
        for (const m of this.members) {
          m.ta = this.terms(m.na, m.side);
          m.tb = this.terms(m.nb, m.side);
        }
        this.updateWeights();
        for (const wt of this.weights) {
          const terms = [];
          for (const t of wt.nodeTerms) for (const q of this.terms(t.node, t.s)) terms.push({ p: q.p, c: q.c * t.c });
          wt.terms = terms;
        }
        this.glued = this.glued.filter((g) => g.hostKey !== c.key);
      }

      if (c.kind !== 'member') return;
      const [ax, ay, bx, by] = this.ends(c);
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const ia = c.ta[0].p; const ib = c.tb[0].p;
      [[ax, ay, ia], [bx, by, ib]].forEach(([ex, ey, i], k) => {
        this.debris.push({
          x: (ex + mx) / 2, y: (ey + my) / 2,
          vx: this.vx[i] * 0.5 + (k ? 0.15 : -0.15), vy: this.vy[i] * 0.5 + 0.2,
          ang: Math.atan2(by - ay, bx - ax),
          spin: (k ? 1 : -1) * (2 + Math.random() * 4),
          len: c.L0 / 2, mat: this.mat, key: c.key, side: c.side, life: 6,
        });
      });
    }

    updateDebris(dt) {
      const floorY = this.terrain.floorY;
      for (const d of this.debris) {
        if (d.landed) { d.life -= dt; continue; }
        d.vy -= BS.G * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.ang += d.spin * dt;
        if (d.y - Math.abs(Math.sin(d.ang)) * d.len / 2 <= floorY) {
          d.landed = true;
          d.ang = 0;
          d.y = floorY + d.mat.width / 2;
        }
      }
      this.debris = this.debris.filter((d) => d.life > 0);
    }

    finish() {
      this.done = true;
      const broken = this.events.length;
      let finalDeflection = 0;
      for (const w of this.weights) finalDeflection = Math.max(finalDeflection, this.y0[w.p] - this.y[w.p]);
      this.finalDeflection = finalDeflection;
      if (this.collapseTime != null) this.outcome = 'collapsed';
      else if (broken > 0) this.outcome = 'damaged';
      else this.outcome = 'held';
    }

    /* Current position of a model joint on one truss (for rendering). */
    nodePos(id, side) {
      const s = side || 0;
      if (!this.nm.has(id)) return null;
      const terms = this.terms(id, s);
      if (terms.some((t) => t.p === undefined)) return null;
      const [x, y] = this.point(terms);
      return { x, y };
    }
  }

  BS.Simulation = Simulation;
  BS.SIM_TIMING = { LOAD_START, LOAD_RAMP };
})(typeof window !== 'undefined' ? window : globalThis);
