// data/map-seams.js — the inter-regional seam vertices.
//
// WHY THIS FILE EXISTS
// --------------------
// `01-data-schema.md` states the single most important rule in the project:
// two territories that border each other must reference the SAME vertex ids
// along their shared edge. Never two vertices at nearly the same coordinate.
//
// That rule is cheap to honour inside one region and expensive to honour
// across regions authored independently. So the cross-region boundaries — the
// "seams" — are authored here, once, up front. Regional map files then treat
// these ids as a fixed vocabulary: they may REFERENCE a seam vertex, and they
// may add their own interior vertices, but they may never redefine a seam.
//
// This is what makes the regions safely parallelisable.
//
// LOAD ORDER: this file declares VERTS and TERRITORIES. Every data/map-<region>.js
// file Object.assign()s into them. Seams first, regions after, in index.html.
//
// COORDINATE FRAME (from 01-data-schema.md): 1000 x 700 viewBox, x east, y south.
// Ireland x~60, Moscow x~700, north Norway y~40, north Africa y~690.

const VERTS = {
  // ---------------------------------------------------------------------
  // PYRENEES — iberia | west
  // Bay of Biscay in the west to the Mediterranean in the east.
  // ---------------------------------------------------------------------
  spyr1: [128, 398], // Biscay coast, western terminus
  spyr2: [155, 405],
  spyr3: [185, 402],
  spyr4: [215, 412], // Mediterranean coast, eastern terminus

  // ---------------------------------------------------------------------
  // RHINE–ALPS — west | central
  // North Sea south to the Alpine triple point. Roughly the Rhine, then the
  // Jura and the western Alps.
  // ---------------------------------------------------------------------
  srha1: [297, 268], // North Sea, Dutch coast, northern terminus
  srha2: [303, 292],
  srha3: [299, 315],
  srha4: [306, 335],
  srha5: [312, 356], // ALPINE TRIPLE POINT — west | central | south.
  //                    Also the western terminus of the central|south seam.

  // ---------------------------------------------------------------------
  // DANISH STRAITS — central | north
  // Jutland's North Sea coast east into the Baltic.
  // ---------------------------------------------------------------------
  sbad1: [328, 232], // North Sea, western terminus
  sbad2: [352, 224],
  sbad3: [378, 230],
  sbad4: [402, 240], // Baltic, eastern terminus

  // ---------------------------------------------------------------------
  // VISTULA LINE — central | east
  // Baltic coast south to the Iron Gates triple point. The German/Austrian
  // frontier with Russian Poland.
  // ---------------------------------------------------------------------
  spol1: [498, 248], // Baltic coast, northern terminus
  spol2: [508, 272],
  spol3: [502, 296],
  spol4: [512, 320],
  spol5: [506, 346],
  // southern terminus is scso8 (the Iron Gates triple point) — see below.

  // ---------------------------------------------------------------------
  // ALPS–ADRIATIC–DRAVA — central | south
  // Western terminus is srha5 (the Alpine triple point). Runs east over the
  // Alps, past the head of the Adriatic, along the Croatian frontier.
  // ---------------------------------------------------------------------
  scso2: [342, 364],
  scso3: [372, 360],
  scso4: [400, 370], // head of the Adriatic
  scso5: [428, 378],
  scso6: [458, 380],
  scso7: [486, 376],
  scso8: [510, 372], // IRON GATES TRIPLE POINT — central | south | east.
  //                    Southern terminus of the Vistula line, western
  //                    terminus of the lower Danube seam.

  // ---------------------------------------------------------------------
  // LOWER DANUBE — east | south
  // Iron Gates east to the Black Sea. Romania's southern frontier.
  // ---------------------------------------------------------------------
  sesu2: [534, 382],
  sesu3: [560, 390],
  sesu4: [586, 396], // Black Sea coast, eastern terminus

  // ---------------------------------------------------------------------
  // KARELIA — north | east
  // Arctic coast south to the Gulf of Finland.
  // ---------------------------------------------------------------------
  sfru1: [536, 68], // Arctic coast, northern terminus
  sfru2: [545, 100],
  sfru3: [538, 132],
  sfru4: [548, 160],
  sfru5: [540, 182], // Gulf of Finland, southern terminus
};

// Territories are contributed by the regional files. Declared here so load
// order is unambiguous and a missing region file fails loudly rather than
// silently producing a half-map.
const TERRITORIES = {};

// The seam chains, in order, west-to-east or north-to-south. Regional files
// consume these so that a shared edge is written as a contiguous run of ids
// rather than re-derived. `test/asserts.js` uses this to verify that both
// sides of a seam used the same run.
const SEAMS = {
  pyrenees:   ['spyr1', 'spyr2', 'spyr3', 'spyr4'],
  rhineAlps:  ['srha1', 'srha2', 'srha3', 'srha4', 'srha5'],
  danish:     ['sbad1', 'sbad2', 'sbad3', 'sbad4'],
  vistula:    ['spol1', 'spol2', 'spol3', 'spol4', 'spol5', 'scso8'],
  alpsDrava:  ['srha5', 'scso2', 'scso3', 'scso4', 'scso5', 'scso6', 'scso7', 'scso8'],
  lowerDanube:['scso8', 'sesu2', 'sesu3', 'sesu4'],
  karelia:    ['sfru1', 'sfru2', 'sfru3', 'sfru4', 'sfru5'],
};

// Which regions meet along each seam. Both named regions must reference the
// seam's vertex run along that edge.
const SEAM_REGIONS = {
  pyrenees:    ['iberia', 'west'],
  rhineAlps:   ['west', 'central'],
  danish:      ['central', 'north'],
  vistula:     ['central', 'east'],
  alpsDrava:   ['central', 'south'],
  lowerDanube: ['east', 'south'],
  karelia:     ['north', 'east'],
};
