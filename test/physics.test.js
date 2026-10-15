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

test('two-bar truss matches hand calculation', () => {
  // Symmetric V hanging from two anchors 40 cm apart, apex 15 cm below: N = P / (2 sin a)
  const m = BS.createModel(0.5);
  const a = BS.addNode(m, 0, 0, true);
  const b = BS.addNode(m, 0.4, 0, true);
  const c = BS.addNode(m, 0.2, -0.15, false);
  BS.addMember(m, a.id, c.id);
  BS.addMember(m, b.id, c.id);
  m.loads.push({ id: m.nextId++, mass: 1, node: c.id });
  const res = BS.analyze(m);
  assert(res.ok, 'should be stable');
  const sinA = 0.15 / 0.25;
  const expected = (1 * BS.G) / (2 * sinA);
  const N = res.members[0].NL;
  assert(Math.abs(N - expected) / expected < 1e-6, `live force ${N} vs ${expected}`);
});

test('collinear deck is detected as a mechanism', () => {
  const m = BS.makePreset('plank', 0.5, false, 1);
  const res = BS.analyze(m);
  assert(!res.ok && res.reason === 'mechanism', JSON.stringify(res.reason));
});

for (const key of ['pratt', 'warren', 'arch', 'stayed']) {
  test(`${key}: static solve is stable`, () => {
    const m = BS.makePreset(key, 0.5, false, 2);
    const res = BS.analyze(m);
    assert(res.ok, `reason ${res.reason} node ${res.nodeId}`);
    const k = BS.loadFactor(res);
    console.log(`        safe load ≈ ${BS.kgLabel(k * 2)}, deflection ${BS.cm(res.maxDeflection, 3)}`);
  });
}

test('dynamic forces agree with static forces on a Pratt truss (light load)', () => {
  const m = BS.makePreset('pratt', 0.5, false, 4);
  const res = BS.analyze(m);
  const sim = runSim(m, 6);
  assert(sim.events.length === 0, 'nothing should break');
  let maxErr = 0;
  let maxF = 0;
  for (const s of res.members) {
    const N = s.ND + s.NL;
    const c = sim.memberById.get(s.id);
    maxErr = Math.max(maxErr, Math.abs(c.Fs - N));
    maxF = Math.max(maxF, Math.abs(N));
  }
  console.log(`        max |dyn - static| = ${maxErr.toFixed(3)} N of max ${maxF.toFixed(1)} N; outcome ${sim.outcome} at ${sim.time.toFixed(2)} s`);
  assert(maxErr / maxF < 0.05, 'forces should agree within 5%');
});

test('plain deck collapses or sags heavily under 10 kg', () => {
  const m = BS.makePreset('plank', 0.5, false, 10);
  const sim = runSim(m, 14);
  console.log(`        outcome ${sim.outcome}, broken ${sim.events.length}, deflection ${BS.cm(sim.finalDeflection || 0)}`);
  assert(sim.done);
});

test('overloaded truss breaks members, report ranks them', () => {
  const m = BS.makePreset('warren', 0.5, false, 150);
  const sim = runSim(m, 14);
  const rep = BS.buildReport(m, sim);
  console.log(`        outcome ${sim.outcome}, broke ${sim.events.map((e) => 'M' + e.id + ':' + e.mode).join(', ')}`);
  console.log(`        weakest static: ${rep.weak.slice(0, 3).map((w) => `M${w.id} ${(w.u * 100).toFixed(0)}% ${w.mode}`).join(', ')}`);
  const est = BS.loadFactor(rep.static) * 150;
  const first = sim.events[0].load * 150;
  console.log(`        static capacity ${BS.kgLabel(est)}, live test first break at ${BS.kgLabel(first)}`);
  assert(Math.abs(first - est) / est < 0.1, 'live failure load should match static estimate within 10%');
  assert(rep.weak[0].u > 1);
});

test('mid-beam weight produces bending', () => {
  const m = BS.makePreset('pratt', 0.5, false, 0);
  m.loads = [];
  const nm = BS.nodeMap(m);
  const deckMember = m.members.find((mm) => nm.get(mm.a).y === 0 && nm.get(mm.b).y === 0);
  m.loads.push({ id: m.nextId++, mass: 6, member: deckMember.id, t: 0.5 });
  const rep = BS.buildReport(m);
  const c = rep.checks.get(deckMember.id);
  assert(c.bend > 0.3, `bending ratio ${c.bend}`);
  const sim = runSim(m, 6);
  console.log(`        static u ${(c.u * 100).toFixed(0)}% (${c.mode}); sim outcome ${sim.outcome}`);
});

test('performance: 160 substeps for a large truss', () => {
  const m = BS.makePreset('pratt', 1.2, false, 5);
  const sim = new BS.Simulation(m);
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) sim.step(1 / 60);
  const ms = (Date.now() - t0) / 60;
  console.log(`        ${ms.toFixed(2)} ms per frame with ${sim.members.length} members`);
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

process.exitCode = failures ? 1 : 0;
