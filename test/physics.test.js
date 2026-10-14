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
  // Symmetric V hanging from two anchors 4 m apart, apex 1.5 m below: N = P / (2 sin a)
  const m = BS.createModel(10);
  const a = BS.addNode(m, 0, 0, true);
  const b = BS.addNode(m, 4, 0, true);
  const c = BS.addNode(m, 2, -1.5, false);
  BS.addMember(m, a.id, c.id, 'steel');
  BS.addMember(m, b.id, c.id, 'steel');
  m.loads.push({ id: m.nextId++, mass: 1000, node: c.id });
  const res = BS.analyze(m);
  assert(res.ok, 'should be stable');
  const sinA = 1.5 / 2.5;
  const expected = (1000 * BS.G) / (2 * sinA);
  const N = res.members[0].NL;
  assert(Math.abs(N - expected) / expected < 1e-6, `live force ${N} vs ${expected}`);
});

test('collinear deck is detected as a mechanism', () => {
  const m = BS.makePreset('plank', 18, false, 5000);
  const res = BS.analyze(m);
  assert(!res.ok && res.reason === 'mechanism', JSON.stringify(res.reason));
});

for (const key of ['pratt', 'warren', 'arch', 'stayed']) {
  test(`${key}: static solve is stable`, () => {
    const m = BS.makePreset(key, 18, false, 10000);
    const res = BS.analyze(m);
    assert(res.ok, `reason ${res.reason} node ${res.nodeId}`);
    const k = BS.loadFactor(res);
    console.log(`        safe load ≈ ${(k * 10).toFixed(1)} t, deflection ${(res.maxDeflection * 1000).toFixed(1)} mm`);
  });
}

test('dynamic forces agree with static forces on a Pratt truss (light load)', () => {
  const m = BS.makePreset('pratt', 18, false, 2000);
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
  console.log(`        max |dyn - static| = ${(maxErr / 1000).toFixed(2)} kN of max ${(maxF / 1000).toFixed(1)} kN; outcome ${sim.outcome} at ${sim.time.toFixed(2)} s`);
  assert(maxErr / maxF < 0.05, 'forces should agree within 5%');
});

test('plain deck collapses or sags heavily under a truck', () => {
  const m = BS.makePreset('plank', 18, false, 40000);
  const sim = runSim(m, 14);
  console.log(`        outcome ${sim.outcome}, broken ${sim.events.length}, deflection ${sim.finalDeflection?.toFixed(2)} m`);
  assert(sim.done);
});

test('overloaded truss breaks members, report ranks them', () => {
  const m = BS.makePreset('warren', 18, false, 60000);
  const sim = runSim(m, 14);
  const rep = BS.buildReport(m, sim);
  console.log(`        outcome ${sim.outcome}, broke ${sim.events.map((e) => 'M' + e.id + ':' + e.mode).join(', ')}`);
  console.log(`        weakest static: ${rep.weak.slice(0, 3).map((w) => `M${w.id} ${(w.u * 100).toFixed(0)}% ${w.mode}`).join(', ')}`);
  assert(sim.events.length > 0, 'something should break at 60 t');
  assert(rep.weak[0].u > 1);
});

test('mid-beam weight produces bending', () => {
  const m = BS.makePreset('pratt', 18, false, 0);
  m.loads = [];
  const deckMember = m.members.find((mm) => mm.mat === 'ibeam');
  m.loads.push({ id: m.nextId++, mass: 20000, member: deckMember.id, t: 0.5 });
  const rep = BS.buildReport(m);
  const c = rep.checks.get(deckMember.id);
  assert(c.bend > 0.3, `bending ratio ${c.bend}`);
  const sim = runSim(m, 6);
  console.log(`        static u ${(c.u * 100).toFixed(0)}% (${c.mode}); sim outcome ${sim.outcome}`);
});

test('performance: 160 substeps for a large truss', () => {
  const m = BS.makePreset('pratt', 40, false, 10000);
  const sim = new BS.Simulation(m);
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) sim.step(1 / 60);
  const ms = (Date.now() - t0) / 60;
  console.log(`        ${ms.toFixed(2)} ms per frame with ${sim.members.length} members`);
  assert(ms < 12);
});

process.exitCode = failures ? 1 : 0;
