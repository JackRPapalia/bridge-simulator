/* Real-time dynamic test using small-step XPBD (extended position based dynamics).
 * Each member is a compliant distance constraint with compliance L / (E A), so the
 * constraint impulse gives the true axial force. Members break when their utilisation
 * reaches 1 and the structure is free to collapse. */
(function (root) {
  'use strict';
  const BS = root.BS;

  const SUBSTEPS = 160;
  const SELF_RAMP = 0.4;      // s to bring self weight on
  const LOAD_START = 0.5;     // s when the weights start pressing down
  const LOAD_RAMP = 2.0;      // s to reach full weight
  const JOINT_MASS = 0.001;   // kg of glue per joint (feels gravity)
  const MIN_INERTIA = 0.02;   // kg; inertia floor that keeps the solver well conditioned (no extra weight)
  const FORCE_SMOOTH = 0.02;  // s time constant for the force read-out
  const AIR_DAMP = 1.2;       // 1/s global velocity damping
  const AXIAL_DAMP = 0.1;     // fraction of axial relative velocity removed per substep

  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

  class Simulation {
    constructor(model) {
      this.model = BS.cloneModel(model);
      this.terrain = BS.terrainOf(this.model);
      const nm = BS.nodeMap(this.model);

      const used = new Set();
      this.model.members.forEach((m) => { used.add(m.a); used.add(m.b); });
      const nodeLoads = this.model.loads.filter((l) => l.node != null);
      nodeLoads.forEach((l) => used.add(l.node));
      const memberLoads = this.model.loads.filter((l) => l.member != null && this.model.members.some((m) => m.id === l.member));

      const simNodes = this.model.nodes.filter((n) => used.has(n.id));
      const N = simNodes.length + memberLoads.length;
      this.count = N;
      this.x = new Float64Array(N); this.y = new Float64Array(N);
      this.px = new Float64Array(N); this.py = new Float64Array(N);
      this.vx = new Float64Array(N); this.vy = new Float64Array(N);
      this.inv = new Float64Array(N);
      this.selfMass = new Float64Array(N);
      this.loadMass = new Float64Array(N);
      this.x0 = new Float64Array(N); this.y0 = new Float64Array(N);
      this.nodeIndex = new Map();
      this.nodeIds = [];

      simNodes.forEach((n, i) => {
        this.nodeIndex.set(n.id, i);
        this.nodeIds.push(n.id);
        this.x[i] = n.x; this.y[i] = n.y;
      });

      const mat = BS.memberMat(this.model);
      this.members = this.model.members.map((m) => {
        const a = this.nodeIndex.get(m.a);
        const b = this.nodeIndex.get(m.b);
        const L0 = Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a]);
        const half = (BS.linearMass(mat) * L0) / 2;
        this.selfMass[a] += half; this.selfMass[b] += half;
        return {
          id: m.id, a, b, L0, mat, alpha: L0 / (mat.E * mat.A),
          broken: false, F: 0, Fs: 0, u: 0, mode: '', peakU: 0, peakMode: '', M: 0,
        };
      });
      this.memberById = new Map(this.members.map((c) => [c.id, c]));

      for (const l of nodeLoads) this.loadMass[this.nodeIndex.get(l.node)] += l.mass;

      // Weights resting between joints become their own particles, tied to the beam.
      this.attachments = [];
      this.weights = [];
      memberLoads.forEach((l, k) => {
        const p = simNodes.length + k;
        const c = this.memberById.get(l.member);
        this.x[p] = this.x[c.a] + (this.x[c.b] - this.x[c.a]) * l.t;
        this.y[p] = this.y[c.a] + (this.y[c.b] - this.y[c.a]) * l.t;
        this.loadMass[p] = l.mass;
        this.attachments.push({ load: l, p, member: c, t: l.t, active: true });
        this.weights.push({ load: l, p });
      });
      for (const l of nodeLoads) this.weights.push({ load: l, p: this.nodeIndex.get(l.node) });

      simNodes.forEach((n, i) => {
        this.selfMass[i] += JOINT_MASS;
        this.inv[i] = n.fixed ? 0 : 1 / (Math.max(this.selfMass[i], MIN_INERTIA) + this.loadMass[i]);
      });
      for (const a of this.attachments) this.inv[a.p] = 1 / this.loadMass[a.p];

      this.x0.set(this.x); this.y0.set(this.y);
      this.time = 0;
      this.events = [];
      this.debris = [];
      this.splashes = [];
      this.collapseTime = null;
      this.calmTime = 0;
      this.done = false;
      this.outcome = null;
      this.peakDeflection = 0;
      this.fallDrop = Math.max(0.05, 0.2 * this.model.gap);
      this.maxPeakU = 0;
    }

    get loadRamp() { return smooth((this.time - LOAD_START) / LOAD_RAMP); }
    get selfRamp() { return smooth(this.time / SELF_RAMP); }

    step(frameDt) {
      const h = frameDt / SUBSTEPS;
      for (let s = 0; s < SUBSTEPS; s++) this.substep(h);
      this.afterFrame(frameDt);
    }

    substep(h) {
      const { x, y, px, py, vx, vy, inv, selfMass, loadMass } = this;
      const N = this.count;
      const G = BS.G;
      const selfR = this.selfRamp;
      const loadR = this.loadRamp;
      const damp = Math.exp(-AIR_DAMP * h);
      for (let i = 0; i < N; i++) {
        px[i] = x[i]; py[i] = y[i];
        if (inv[i] === 0) continue;
        const fy = -G * (selfMass[i] * selfR + loadMass[i] * loadR);
        vy[i] += h * fy * inv[i];
        vx[i] *= damp; vy[i] *= damp;
        x[i] += h * vx[i];
        y[i] += h * vy[i];
      }

      const h2 = h * h;
      for (const c of this.members) {
        if (c.broken) continue;
        const a = c.a; const b = c.b;
        const dx = x[a] - x[b];
        const dy = y[a] - y[b];
        const d = Math.hypot(dx, dy);
        const C = d - c.L0;
        const w = inv[a] + inv[b];
        if (d < 1e-9 || w === 0 || (c.mat.tensionOnly && C <= 0)) { c.F = 0; continue; }
        const nx = dx / d; const ny = dy / d;
        const dl = -C / (w + c.alpha / h2);
        x[a] += inv[a] * dl * nx; y[a] += inv[a] * dl * ny;
        x[b] -= inv[b] * dl * nx; y[b] -= inv[b] * dl * ny;
        c.F = -dl / h2;
      }

      for (const at of this.attachments) {
        if (!at.active) continue;
        const { p, t } = at;
        const a = at.member.a; const b = at.member.b;
        const cx = x[p] - ((1 - t) * x[a] + t * x[b]);
        const cy = y[p] - ((1 - t) * y[a] + t * y[b]);
        const w = inv[p] + (1 - t) * (1 - t) * inv[a] + t * t * inv[b];
        if (w === 0) continue;
        x[p] -= (inv[p] * cx) / w; y[p] -= (inv[p] * cy) / w;
        x[a] += ((1 - t) * inv[a] * cx) / w; y[a] += ((1 - t) * inv[a] * cy) / w;
        x[b] += (t * inv[b] * cx) / w; y[b] += (t * inv[b] * cy) / w;
      }

      for (let i = 0; i < N; i++) if (inv[i] > 0) this.collide(i);

      for (let i = 0; i < N; i++) {
        vx[i] = (x[i] - px[i]) / h;
        vy[i] = (y[i] - py[i]) / h;
      }

      const sm = h / FORCE_SMOOTH;
      for (const c of this.members) {
        if (c.broken) continue;
        const a = c.a; const b = c.b;
        const w = inv[a] + inv[b];
        if (w > 0) {
          const dx = x[b] - x[a]; const dy = y[b] - y[a];
          const d = Math.hypot(dx, dy) || 1;
          const nx = dx / d; const ny = dy / d;
          const rv = (vx[b] - vx[a]) * nx + (vy[b] - vy[a]) * ny;
          if (!(c.mat.tensionOnly && d < c.L0)) {
            const j = (AXIAL_DAMP * rv) / w;
            vx[a] += inv[a] * j * nx; vy[a] += inv[a] * j * ny;
            vx[b] -= inv[b] * j * nx; vy[b] -= inv[b] * j * ny;
          }
        }
        c.Fs += (c.F - c.Fs) * sm;
      }
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

    /* Bending moment in member c from self weight and weights resting on it (current geometry). */
    momentOf(c) {
      const dx = this.x[c.b] - this.x[c.a];
      const dy = this.y[c.b] - this.y[c.a];
      const L = Math.hypot(dx, dy) || c.L0;
      const perp = Math.abs(dx) / L;
      let M = (BS.linearMass(c.mat) * BS.G * this.selfRamp * perp * L * L) / 8;
      for (const at of this.attachments) {
        if (at.active && at.member === c) M += at.load.mass * BS.G * this.loadRamp * perp * at.t * (1 - at.t) * L;
      }
      return M;
    }

    afterFrame(dt) {
      let worst = null;
      let worstCheck = null;
      for (const c of this.members) {
        if (c.broken) continue;
        c.M = this.momentOf(c);
        const chk = BS.checkMember(c.mat, c.L0, c.Fs, c.M);
        c.u = chk.u;
        c.mode = chk.mode;
        if (this.time > 0.15 && chk.u > c.peakU) { c.peakU = chk.u; c.peakMode = chk.mode; }
        if (this.time > 0.15 && chk.u >= 1 && (!worst || chk.u > worst.u)) { worst = c; worstCheck = chk; }
      }
      if (worst) this.breakMember(worst, worstCheck);
      this.maxPeakU = this.members.reduce((s, c) => Math.max(s, c.peakU), 0);

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

    breakMember(c, chk) {
      c.broken = true;
      c.peakU = Math.max(c.peakU, chk.u);
      c.peakMode = chk.mode;
      c.u = chk.u;
      this.events.push({ id: c.id, time: this.time, mode: chk.mode, force: chk.N, load: this.loadRamp });
      for (const at of this.attachments) if (at.member === c) at.active = false;

      const { x, y, vx, vy } = this;
      const mx = (x[c.a] + x[c.b]) / 2;
      const my = (y[c.a] + y[c.b]) / 2;
      [[c.a, mx, my], [c.b, mx, my]].forEach(([i, ex, ey], k) => {
        this.debris.push({
          x: (x[i] + ex) / 2, y: (y[i] + ey) / 2,
          vx: vx[i] * 0.5 + (k ? 0.15 : -0.15), vy: vy[i] * 0.5 + 0.2,
          ang: Math.atan2(y[c.b] - y[c.a], x[c.b] - x[c.a]),
          spin: (k ? 1 : -1) * (2 + Math.random() * 4),
          len: c.L0 / 2, mat: c.mat, id: c.id, life: 6,
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

    /* Current position of a model node (for rendering). */
    nodePos(id) {
      const i = this.nodeIndex.get(id);
      return i === undefined ? null : { x: this.x[i], y: this.y[i] };
    }
  }

  BS.Simulation = Simulation;
  BS.SIM_TIMING = { LOAD_START, LOAD_RAMP };
})(typeof window !== 'undefined' ? window : globalThis);
