/* Starter designs, generated to fit the current gap. */
(function (root) {
  'use strict';
  const BS = root.BS;

  const panels = (gap) => Math.max(2, Math.round(gap / 3));

  function deck(model, gap, n, mat) {
    const dx = gap / n;
    const B = [];
    for (let i = 0; i <= n; i++) B.push(BS.addNode(model, i * dx, 0, i === 0 || i === n));
    for (let i = 0; i < n; i++) BS.addMember(model, B[i].id, B[i + 1].id, mat || 'ibeam');
    return B;
  }

  function centreLoad(model, B, mass) {
    const mid = B[Math.floor(B.length / 2)];
    model.loads.push({ id: model.nextId++, mass, node: mid.id });
  }

  const PRESETS = {
    pratt: {
      name: 'Pratt truss',
      build(model, gap, mass) {
        const n = panels(gap);
        const dx = gap / n;
        const h = 3;
        const B = deck(model, gap, n);
        const T = [];
        for (let i = 1; i < n; i++) T[i] = BS.addNode(model, i * dx, h, false);
        for (let i = 1; i < n - 1; i++) BS.addMember(model, T[i].id, T[i + 1].id, 'steel');
        BS.addMember(model, B[0].id, T[1].id, 'steel');
        BS.addMember(model, B[n].id, T[n - 1].id, 'steel');
        for (let i = 1; i < n; i++) BS.addMember(model, B[i].id, T[i].id, 'steel');
        for (let i = 1; i < n - 1; i++) {
          if (i + 0.5 < n / 2) BS.addMember(model, T[i].id, B[i + 1].id, 'steel');
          else BS.addMember(model, T[i + 1].id, B[i].id, 'steel');
        }
        centreLoad(model, B, mass);
      },
    },
    warren: {
      name: 'Warren truss',
      build(model, gap, mass) {
        const n = panels(gap);
        const dx = gap / n;
        const h = 2.6;
        const B = deck(model, gap, n);
        const T = [];
        for (let i = 0; i < n; i++) T[i] = BS.addNode(model, (i + 0.5) * dx, h, false);
        for (let i = 0; i < n - 1; i++) BS.addMember(model, T[i].id, T[i + 1].id, 'steel');
        for (let i = 0; i < n; i++) {
          BS.addMember(model, B[i].id, T[i].id, 'timber');
          BS.addMember(model, T[i].id, B[i + 1].id, 'timber');
        }
        centreLoad(model, B, mass);
      },
    },
    arch: {
      name: 'Deck arch',
      build(model, gap, mass) {
        const n = panels(gap);
        const dx = gap / n;
        const rise = Math.min(6, gap * 0.3);
        const B = deck(model, gap, n);
        const A = [];
        for (let i = 0; i <= n; i++) {
          const x = i * dx;
          const y = -rise + (rise - 0.8) * (4 * x * (gap - x)) / (gap * gap);
          A.push(i === 0 || i === n ? BS.addNode(model, x, -rise, true) : BS.addNode(model, x, y, false));
        }
        for (let i = 0; i < n; i++) BS.addMember(model, A[i].id, A[i + 1].id, 'ibeam');
        for (let i = 1; i < n; i++) BS.addMember(model, B[i].id, A[i].id, 'steel');
        for (let i = 0; i < n; i++) {
          if (i < n / 2) BS.addMember(model, B[i].id, A[i + 1].id, 'steel');
          else BS.addMember(model, A[i].id, B[i + 1].id, 'steel');
        }
        centreLoad(model, B, mass);
      },
    },
    stayed: {
      name: 'Cable-stayed',
      build(model, gap, mass) {
        const n = panels(gap);
        const H = Math.min(9, Math.max(5, gap * 0.4));
        const B = deck(model, gap, n);
        const tower = (x0, dir) => {
          const foot = BS.addNode(model, x0 - dir * 2, 0, true);
          const top = BS.addNode(model, x0 - dir * 1, H, false);
          const back = BS.addNode(model, x0 - dir * Math.min(10, gap / 2), 0, true);
          const base = B[dir > 0 ? 0 : n];
          BS.addMember(model, foot.id, top.id, 'ibeam');
          BS.addMember(model, base.id, top.id, 'ibeam');
          BS.addMember(model, back.id, top.id, 'cable');
          return top;
        };
        const L = tower(0, 1);
        const R = tower(gap, -1);
        for (let i = 1; i < n; i++) {
          if (i <= n / 2) BS.addMember(model, L.id, B[i].id, 'cable');
          if (i >= n / 2) BS.addMember(model, R.id, B[i].id, 'cable');
        }
        centreLoad(model, B, mass);
      },
    },
    plank: {
      name: 'Plain deck (no truss)',
      build(model, gap, mass) {
        const B = deck(model, gap, panels(gap), 'ibeam');
        centreLoad(model, B, mass);
      },
    },
  };

  function makePreset(key, gap, pier, mass) {
    const model = BS.createModel(gap);
    model.pier = !!pier;
    PRESETS[key].build(model, gap, mass == null ? 10000 : mass);
    return model;
  }

  BS.PRESETS = PRESETS;
  BS.makePreset = makePreset;
})(typeof window !== 'undefined' ? window : globalThis);
