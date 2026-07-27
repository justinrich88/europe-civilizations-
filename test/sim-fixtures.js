// test/sim-fixtures.js — a synthetic map for exercising sim/ on its own.
//
// The point of this file is that the physics layer can be verified WITHOUT
// data/stations.js or data/map.js. The real map is generated, large, and
// changes underneath you; a nine-station chain with hand-picked capacities is
// something you can do the arithmetic for on paper, which is the only way to
// tell "the sim is wrong" apart from "the map is odd".
//
// makeFixture(seed) installs the synthetic STATIONS / TERRITORIES / LINKS /
// POWERS / SETUP as globals and returns a fresh state. It must be loaded
// INSTEAD OF the real data files, never alongside them -- those declare their
// tables with `const`, which shadows a global of the same name
// (known-issues.md #3).
//
// The map, four territories in a line:
//
//   ta ── tb ── tc ── td          (all plains, so fortLevel is 0 except at f1)
//
//   a1 ─ a2 ── b1 ── b2 ── c1 ── c2 ── d1
//   │           ├ f1  (defensive, defense 3.0)
//   m1          └ p1  (producer, artillery)
//
// ta holds three stations, which is what makes the control tiers testable:
// 3/3 is `full`, 2/3 is `majority`, 1/3 is `contested`.

'use strict';

function makeFixture(seed) {
  var TERR = {
    ta: { id: 'ta', name: 'Alpha', shape: [], label: [100, 100], terrain: 'plains',
          neighbors: ['tb'], coastal: false },
    tb: { id: 'tb', name: 'Beta', shape: [], label: [200, 100], terrain: 'plains',
          neighbors: ['ta', 'tc'], coastal: false },
    tc: { id: 'tc', name: 'Gamma', shape: [], label: [300, 100], terrain: 'plains',
          neighbors: ['tb', 'td'], coastal: false },
    td: { id: 'td', name: 'Delta', shape: [], label: [400, 100], terrain: 'plains',
          neighbors: ['tc'], coastal: false },
  };

  var ST = {
    a1: { id: 'a1', name: 'Aone', territory: 'ta', pos: [100, 100], type: 'holding',
          capacity: 60, rate: 1.0, produces: 'infantry', defense: 1.0, multiplier: null },
    a2: { id: 'a2', name: 'Atwo', territory: 'ta', pos: [120, 100], type: 'holding',
          capacity: 40, rate: 0.9, produces: 'infantry', defense: 1.0, multiplier: null },
    m1: { id: 'm1', name: 'Afarm', territory: 'ta', pos: [100, 120], type: 'multiplier',
          capacity: 10, rate: 0.3, produces: 'infantry', defense: 0.8, multiplier: 1.6 },

    b1: { id: 'b1', name: 'Bone', territory: 'tb', pos: [200, 100], type: 'holding',
          capacity: 50, rate: 1.0, produces: 'infantry', defense: 1.0, multiplier: null },
    b2: { id: 'b2', name: 'Btwo', territory: 'tb', pos: [220, 100], type: 'holding',
          capacity: 40, rate: 0.9, produces: 'infantry', defense: 1.0, multiplier: null },
    f1: { id: 'f1', name: 'Bfort', territory: 'tb', pos: [200, 130], type: 'defensive',
          capacity: 20, rate: 0.4, produces: 'infantry', defense: 3.0, multiplier: null },
    p1: { id: 'p1', name: 'Bworks', territory: 'tb', pos: [200, 70], type: 'producer',
          capacity: 30, rate: 0.5, produces: 'artillery', defense: 1.1, multiplier: null },

    c1: { id: 'c1', name: 'Cone', territory: 'tc', pos: [300, 100], type: 'holding',
          capacity: 50, rate: 1.0, produces: 'infantry', defense: 1.0, multiplier: null },
    c2: { id: 'c2', name: 'Ctwo', territory: 'tc', pos: [320, 100], type: 'holding',
          capacity: 30, rate: 0.9, produces: 'infantry', defense: 1.0, multiplier: null },

    d1: { id: 'd1', name: 'Done', territory: 'td', pos: [400, 100], type: 'holding',
          capacity: 40, rate: 0.9, produces: 'infantry', defense: 1.0, multiplier: null },
  };

  var LNK = [
    { a: 'a1', b: 'a2', dist: 40 },
    { a: 'a1', b: 'm1', dist: 30 },
    { a: 'a2', b: 'b1', dist: 50 },
    { a: 'b1', b: 'b2', dist: 30 },
    { a: 'b1', b: 'f1', dist: 30 },
    { a: 'b1', b: 'p1', dist: 30 },
    { a: 'b2', b: 'c1', dist: 50 },
    { a: 'c1', b: 'c2', dist: 30 },
    { a: 'c2', b: 'd1', dist: 50, sea: true },
  ];

  var POW = {
    pa: { id: 'pa', name: 'Power A', color: '#5b7fbd', capital: 'a1', ai: 'expansionist' },
    pb: { id: 'pb', name: 'Power B', color: '#bd5b5b', capital: 'c1', ai: 'turtle' },
    neutral: { id: 'neutral', name: 'Neutral', color: '#888', capital: null, ai: null },
  };

  var SET = {
    a1: { owner: 'pa', units: { infantry: 30, artillery: 0, armour: 0 } },
    a2: { owner: 'pa', units: { infantry: 20, artillery: 0, armour: 0 } },
    m1: { owner: 'pa', units: { infantry: 5, artillery: 0, armour: 0 } },
    b1: { owner: 'neutral', units: { infantry: 10, artillery: 0, armour: 0 } },
    b2: { owner: 'neutral', units: { infantry: 8, artillery: 0, armour: 0 } },
    f1: { owner: 'neutral', units: { infantry: 6, artillery: 0, armour: 0 } },
    p1: { owner: 'neutral', units: { infantry: 6, artillery: 0, armour: 0 } },
    c1: { owner: 'pb', units: { infantry: 30, artillery: 0, armour: 0 } },
    c2: { owner: 'pb', units: { infantry: 15, artillery: 0, armour: 0 } },
    d1: { owner: 'pb', units: { infantry: 12, artillery: 0, armour: 0 } },
  };

  var g = (typeof globalThis !== 'undefined') ? globalThis : this;
  g.TERRITORIES = TERR;
  g.STATIONS = ST;
  g.LINKS = LNK;
  g.POWERS = POW;
  g.SETUP = SET;

  // The sim caches adjacency, territory hops and routes off the static data,
  // so swapping the data out has to invalidate them.
  if (typeof resetSimCaches === 'function') resetSimCaches();

  return newGame(typeof seed === 'number' ? seed : 1);
}
