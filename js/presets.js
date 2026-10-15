/* Starter designs, generated to fit the current gap (model scale, roughly 8 cm panels). */
(function (root) {
  'use strict';
  const BS = root.BS;

  const panels = (gap) => Math.max(2, Math.round(gap / 0.08));
  const r3 = (v) => Math.round(v * 1000) / 1000; // keep coordinates on a 1 mm grid

  function deck(model, gap, n) {
    const dx = gap / n;
    const B = [];
    for (let i = 0; i <= n; i++) B.push(BS.addNode(model, r3(i * dx), 0, i === 0 || i === n));
    for (let i = 0; i < n; i++) BS.addMember(model, B[i].id, B[i + 1].id);
    return B;
  }

  function centreLoad(model, B, mass) {
    const mid = B[Math.floor(B.length / 2)];
    model.loads.push({ id: model.nextId++, mass, node: mid.id });
  }

  const depth = (gap) => r3(Math.min(0.1, Math.max(0.05, gap * 0.16)));

  const PRESETS = {
    pratt: {
      name: 'Pratt truss',
      build(model, gap, mass) {
        const n = panels(gap);
        const dx = gap / n;
        const h = depth(gap);
        const B = deck(model, gap, n);
        const T = [];
        for (let i = 1; i < n; i++) T[i] = BS.addNode(model, r3(i * dx), h, false);
        for (let i = 1; i < n - 1; i++) BS.addMember(model, T[i].id, T[i + 1].id);
        BS.addMember(model, B[0].id, T[1].id);
        BS.addMember(model, B[n].id, T[n - 1].id);
        for (let i = 1; i < n; i++) BS.addMember(model, B[i].id, T[i].id);
        for (let i = 1; i < n - 1; i++) {
          if (i + 0.5 < n / 2) BS.addMember(model, T[i].id, B[i + 1].id);
          else BS.addMember(model, T[i + 1].id, B[i].id);
        }
        centreLoad(model, B, mass);
      },
    },
    warren: {
      name: 'Warren truss',
      build(model, gap, mass) {
        const n = panels(gap);
        const dx = gap / n;
        const h = depth(gap);
        const B = deck(model, gap, n);
        const T = [];
        for (let i = 0; i < n; i++) T[i] = BS.addNode(model, r3((i + 0.5) * dx), h, false);
        for (let i = 0; i < n - 1; i++) BS.addMember(model, T[i].id, T[i + 1].id);
        for (let i = 0; i < n; i++) {
          BS.addMember(model, B[i].id, T[i].id);
          BS.addMember(model, T[i].id, B[i + 1].id);
        }
        centreLoad(model, B, mass);
      },
    },
    arch: {
      name: 'Deck arch',
      build(model, gap, mass) {
        const n = panels(gap);
        const dx = gap / n;
        const rise = r3(gap * 0.25);
        const B = deck(model, gap, n);
        const A = [];
        for (let i = 0; i <= n; i++) {
          const x = i * dx;
          const y = -rise + rise * 0.85 * (4 * x * (gap - x)) / (gap * gap);
          A.push(BS.addNode(model, r3(x), r3(i === 0 || i === n ? -rise : y), i === 0 || i === n));
        }
        for (let i = 0; i < n; i++) BS.addMember(model, A[i].id, A[i + 1].id);
        for (let i = 1; i < n; i++) BS.addMember(model, B[i].id, A[i].id);
        for (let i = 0; i < n; i++) {
          if (i < n / 2) BS.addMember(model, B[i].id, A[i + 1].id);
          else BS.addMember(model, A[i].id, B[i + 1].id);
        }
        centreLoad(model, B, mass);
      },
    },
    stayed: {
      name: 'Towers and stays',
      build(model, gap, mass) {
        const n = panels(gap);
        const H = r3(gap * 0.35);
        const B = deck(model, gap, n);
        const tower = (x0, dir) => {
          const foot = BS.addNode(model, r3(x0 - dir * gap * 0.06), 0, true);
          const top = BS.addNode(model, r3(x0 - dir * gap * 0.03), H, false);
          const back = BS.addNode(model, r3(x0 - dir * gap * 0.25), 0, true);
          BS.addMember(model, foot.id, top.id);
          BS.addMember(model, B[dir > 0 ? 0 : n].id, top.id);
          BS.addMember(model, back.id, top.id);
          return top;
        };
        const L = tower(0, 1);
        const R = tower(gap, -1);
        for (let i = 1; i < n; i++) {
          if (i <= n / 2) BS.addMember(model, L.id, B[i].id);
          if (i >= n / 2) BS.addMember(model, R.id, B[i].id);
        }
        centreLoad(model, B, mass);
      },
    },
    plank: {
      name: 'Plain deck (no truss)',
      build(model, gap, mass) {
        const B = deck(model, gap, panels(gap));
        centreLoad(model, B, mass);
      },
    },
  };

  function makePreset(key, gap, pier, mass, piece) {
    const model = BS.createModel(gap);
    model.pier = !!pier;
    if (piece) model.piece = { ...piece };
    PRESETS[key].build(model, gap, mass == null ? 2 : mass);
    return model;
  }

  BS.PRESETS = PRESETS;
  BS.makePreset = makePreset;
})(typeof window !== 'undefined' ? window : globalThis);
