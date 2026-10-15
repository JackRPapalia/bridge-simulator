/* Sanity tests for the solvers. Run with: node test/physics.test.js */
'use strict';
require('../js/core.js');
require('../js/statics.js');
require('../js/physics.js');
require('../js/presets.js');
const BS = globalThis.BS;
const assert = require('assert');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ', name); }
  catch (e) { failures++; console.log('FAIL ', name, '\n     ', e.message); }
}

function runSim(model, seconds) {
  const sim = new BS.Simulation(model);
  const frames = Math.round(seconds * 60);
  for (let f = 0; f < frames && !sim.done; f++) sim.step(1 / 60);
  return sim;
}
const item = (res, key) => res.items.find((it) => it.key === key);

test('two-bar truss matches hand calculation (weight shared by both trusses)', () => {
  // Symmetric V hanging from two anchors 40 cm apart, apex 15 cm below: N = P / (2 sin a) per truss
  const m = BS.createModel(0.5);
  const a = BS.addNode(m, 0, 0, true);
  const b = BS.addNode(m, 0.4, 0, true);
  const c = BS.addNode(m, 0.2, -0.15, false);
  const bar = BS.addMember(m, a.id, c.id);
  BS.addMember(m, b.id, c.id);
  m.loads.push({ id: m.nextId++, mass: 1, node: c.id });
  const res = BS.analyze(m);
  assert(res.ok, 'should be stable');
  const expected = (0.5 * BS.G) / (2 * (0.15 / 0.25));
  for (const s of [0, 1]) {
    const N = item(res, `${bar.id}:${s}`).NL;
    assert(Math.abs(N - expected) / expected < 1e-6, `side ${s}: live force ${N} vs ${expected}`);
  }
});

test('collinear deck is detected as a mechanism', () => {
  const res = BS.analyze(BS.makePreset('plank', 0.5, false, 1));
  assert(!res.ok && res.reason === 'mechanism', JSON.stringify(res.reason));
});

for (const key of ['pratt', 'warren', 'arch', 'stayed']) {
  test(`${key}: stable, and its top-view bracing holds every chord joint`, () => {
    const m = BS.makePreset(key, 0.5, false, 10);
    const res = BS.analyze(m);
    assert(res.ok, `reason ${res.reason} node ${res.nodeId}`);
    const loose = res.items.filter((it) => it.kind === 'member' && it.Lout > it.L + 1e-9);
    console.log(`        safe load ≈ ${BS.kgLabel(BS.loadFactor(res) * 10)}, ${m.plan.length} top-view pieces, ${loose.length} members free to bow sideways`);
    if (key === 'pratt' || key === 'warren') assert.strictEqual(loose.length, 0);
  });
}

test('removing the top-view bracing lets the top chord buckle sideways', () => {
  const m = BS.makePreset('pratt', 0.5, false, 10);
  const braced = BS.loadFactor(BS.analyze(m)) * 10;
  m.plan = [];
  const rep = BS.buildReport(m);
  const loose = rep.safeLoad;
  console.log(`        braced ${BS.kgLabel(braced)}, unbraced ${BS.kgLabel(loose)} (${rep.weak[0].name} ${rep.weak[0].mode})`);
  assert(loose < braced / 2, 'bracing should more than double capacity');
  assert.strictEqual(rep.weak[0].mode, 'sideways');
});

test('a ladder of cross pieces without diagonals does not brace', () => {
  const m = BS.makePreset('pratt', 0.5, false, 10);
  const nm = BS.nodeMap(m);
  m.plan = m.plan.filter((p) => p.a.n === p.b.n || nm.get(p.a.n).y === 0);
  const res = BS.analyze(m);
  const top = res.items.filter((it) => it.kind === 'member' && it.side === 0 && nm.get(m.members.find((mm) => mm.id === it.id).a).y > 0 && it.Lout > it.L + 1e-9);
  assert(top.length > 0, 'top chord should still be free to bow');
});

test('dynamic forces agree with static forces on a braced Pratt truss', () => {
  const m = BS.makePreset('pratt', 0.5, false, 20);
  const res = BS.analyze(m);
  const sim = runSim(m, 6);
  assert(sim.events.length === 0, 'nothing should break');
  let maxErr = 0;
  let maxF = 0;
  for (const it of res.items.filter((i) => i.kind === 'member')) {
    const N = it.ND + it.NL;
    maxErr = Math.max(maxErr, Math.abs(sim.memberByKey.get(it.key).Fs - N));
    maxF = Math.max(maxF, Math.abs(N));
  }
  console.log(`        max |dyn - static| = ${maxErr.toFixed(3)} N of max ${maxF.toFixed(1)} N; outcome ${sim.outcome} at ${sim.time.toFixed(2)} s`);
  assert(maxErr / maxF < 0.05, 'forces should agree within 5%');
});

test('weight near the front truss loads the front truss more', () => {
  const m = BS.makePreset('pratt', 0.5, false, 10);
  m.loads = [];
  const nm = BS.nodeMap(m);
  const cross = m.plan.find((p) => p.a.n === p.b.n && Math.abs(nm.get(p.a.n).x - 0.25) < 1e-6 && nm.get(p.a.n).y === 0);
  m.loads.push({ id: m.nextId++, mass: 10, plan: cross.id, t: cross.a.s === 0 ? 0.2 : 0.8 });
  const res = BS.analyze(m);
  const front = Math.max(...res.items.filter((i) => i.side === 0).map((i) => Math.abs(i.NL)));
  const back = Math.max(...res.items.filter((i) => i.side === 1).map((i) => Math.abs(i.NL)));
  console.log(`        biggest live force: front ${front.toFixed(1)} N, back ${back.toFixed(1)} N`);
  assert(Math.abs(front / back - 4) < 0.01, 'an 80/20 split should give a 4:1 force ratio');
});

test('cross piece bending: static capacity matches the live test', () => {
  const m = BS.makePreset('pratt', 0.5, false, 10);
  m.loads = [];
  const nm = BS.nodeMap(m);
  const cross = m.plan.find((p) => p.a.n === p.b.n && Math.abs(nm.get(p.a.n).x - 0.25) < 1e-6 && nm.get(p.a.n).y === 0);
  m.loads.push({ id: m.nextId++, mass: 30, plan: cross.id, t: 0.5 });
  const rep = BS.buildReport(m);
  const sim = runSim(m, 14);
  const first = sim.events[0];
  console.log(`        static ${BS.kgLabel(rep.safeLoad)} (${rep.weak[0].name} ${rep.weak[0].mode}); live: ${first.name} ${first.mode} at ${BS.kgLabel(first.load * 30)}, outcome ${sim.outcome}`);
  assert.strictEqual(first.key, `p${cross.id}`);
  assert(Math.abs(first.load * 30 - rep.safeLoad) / rep.safeLoad < 0.1);
  assert.strictEqual(sim.outcome, 'collapsed', 'the weight should drop through');
});

test('plain deck folds under 10 kg', () => {
  const sim = runSim(BS.makePreset('plank', 0.5, false, 10), 14);
  console.log(`        outcome ${sim.outcome}, broken ${sim.events.length}, deflection ${BS.cm(sim.finalDeflection || 0)}`);
  assert(sim.done);
});

test('overloaded truss breaks close to the static capacity estimate', () => {
  const m = BS.makePreset('warren', 0.5, false, 250);
  const sim = runSim(m, 14);
  const rep = BS.buildReport(m, sim);
  const est = BS.loadFactor(rep.static) * 250;
  const first = sim.events[0].load * 250;
  console.log(`        static ${BS.kgLabel(est)}, live first break ${sim.events[0].name} (${sim.events[0].where}) at ${BS.kgLabel(first)}`);
  assert(Math.abs(first - est) / est < 0.1, 'live failure load should match static estimate within 10%');
});

test('mid-beam weight produces bending', () => {
  const m = BS.makePreset('pratt', 0.5, false, 0);
  m.loads = [];
  const nm = BS.nodeMap(m);
  const deckMember = m.members.find((mm) => nm.get(mm.a).y === 0 && nm.get(mm.b).y === 0);
  m.loads.push({ id: m.nextId++, mass: 30, member: deckMember.id, t: 0.5 });
  const c = BS.buildReport(m).checks.get(`${deckMember.id}:0`);
  console.log(`        ${Math.round(c.u * 100)}% (${c.mode})`);
  assert(c.bend > 0.3, `bending ratio ${c.bend}`);
});

test('performance: 160 substeps for a large braced truss', () => {
  const m = BS.makePreset('pratt', 1.2, false, 5);
  const sim = new BS.Simulation(m);
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) sim.step(1 / 60);
  const ms = (Date.now() - t0) / 60;
  console.log(`        ${ms.toFixed(2)} ms per frame with ${sim.members.length} truss members and ${sim.plans.length} top-view pieces`);
  assert(ms < 12);
});

test('single piece: thicker piece carries more, all members share it', () => {
  const m = BS.makePreset('pratt', 0.5, false, 2);
  const k1 = BS.loadFactor(BS.analyze(m));
  m.piece = { ...m.piece, thick: m.piece.thick * 2 };
  const k2 = BS.loadFactor(BS.analyze(m));
  console.log(`        thickness x1: ${BS.kgLabel(k1 * 2)}, x2: ${BS.kgLabel(k2 * 2)}`);
  assert(k2 > k1 * 1.5);
});

test('older saved designs upgrade cleanly', () => {
  const m = BS.makePreset('pratt', 0.5, false, 5);
  delete m.plan; delete m.width;
  BS.upgradeModel(m);
  assert(Array.isArray(m.plan) && m.width > 0);
  assert(BS.analyze(m).ok);
});

process.exitCode = failures ? 1 : 0;
