// data/map-west.js — France, Low Countries, Switzerland. See data/map-seams.js.
//
// Seams consumed (referenced verbatim, never redefined):
//   pyrenees  spyr1..spyr4  — southern edge of `aqu`, facing iberia (cas, cat)
//   rhineAlps srha1..srha5  — eastern edge, north to south: ned, bel, bur, swi
//                             srha5 is the west|central|south alpine triple point.
//
// Interior vertices use the `w` prefix. Shared edges reuse the same ids on both
// sides — see 01-data-schema.md, "the single most important rule".

Object.assign(VERTS, {
  // --- North Sea / Channel coast, east to west ---
  w001: [278, 262], // Dutch north coast
  w002: [258, 272], // Scheldt — ned | bel on the coast
  w003: [238, 276], // Flanders
  w004: [218, 278], // Calais
  w005: [208, 290], // Somme
  w006: [198, 296], // nor | bri on the coast

  // --- Brittany ---
  w007: [186, 304], // north Breton coast
  w008: [178, 316], // Atlantic tip
  w009: [188, 330], // south Breton coast
  w010: [204, 336], // Loire mouth — bri | aqu on the coast

  // --- Bay of Biscay, north to south (meets spyr1) ---
  w011: [186, 352],
  w012: [172, 370],
  w013: [152, 386],

  // --- Mediterranean coast, west to east (from spyr4) ---
  w014: [238, 408], // Languedoc
  w015: [258, 400], // aqu | bur on the coast
  w016: [278, 388], // Provence
  w017: [292, 378], // bur | swi | (italy: pie) corner
  w018: [302, 372], // swi southern border, between pie and lom

  // --- Interior junctions ---
  w019: [275, 290], // ned | bel
  w020: [272, 312], // bel | idf | bur
  w021: [246, 306], // bel | nor | idf
  w022: [225, 295], // bel | nor
  w023: [238, 320], // nor | idf
  w024: [212, 318], // nor | bri | idf
  w025: [214, 330], // bri | idf | aqu
  w026: [262, 338], // idf | bur | aqu
  w027: [236, 342], // idf | aqu
  w028: [266, 366], // aqu | bur
  w029: [292, 352], // bur | swi
});

Object.assign(TERRITORIES, {
  ned: {
    id: 'ned', name: 'Netherlands',
    shape: ['w002', 'w001', 'srha1', 'srha2', 'w019'],
    label: [281, 277], terrain: 'plains',
    neighbors: ['bel', 'han'],
    coastal: true,
  },
  bel: {
    id: 'bel', name: 'Belgium',
    shape: ['w004', 'w003', 'w002', 'w019', 'srha2', 'srha3', 'w020', 'w021', 'w022'],
    label: [258, 293], terrain: 'plains',
    neighbors: ['ned', 'nor', 'idf', 'bur', 'rhi'],
    coastal: true,
  },
  nor: {
    id: 'nor', name: 'Normandy',
    shape: ['w006', 'w005', 'w004', 'w022', 'w021', 'w023', 'w024'],
    label: [220, 299], terrain: 'plains',
    neighbors: ['bel', 'idf', 'bri'],
    coastal: true,
  },
  bri: {
    id: 'bri', name: 'Brittany',
    shape: ['w006', 'w024', 'w025', 'w010', 'w009', 'w008', 'w007'],
    label: [195, 317], terrain: 'hills',
    neighbors: ['nor', 'idf', 'aqu'],
    coastal: true,
  },
  idf: {
    id: 'idf', name: 'Île-de-France',
    shape: ['w021', 'w020', 'w026', 'w027', 'w025', 'w024', 'w023'],
    label: [242, 324], terrain: 'plains',
    neighbors: ['bel', 'nor', 'bri', 'aqu', 'bur'],
    coastal: false,
  },
  aqu: {
    id: 'aqu', name: 'Aquitaine',
    shape: ['w010', 'w025', 'w027', 'w026', 'w028', 'w015', 'w014',
            'spyr4', 'spyr3', 'spyr2', 'spyr1', 'w013', 'w012', 'w011'],
    label: [205, 378], terrain: 'plains',
    neighbors: ['bri', 'idf', 'bur', 'cas', 'cat'],
    coastal: true,
  },
  bur: {
    id: 'bur', name: 'Burgundy',
    shape: ['w020', 'srha3', 'srha4', 'w029', 'w017', 'w016', 'w015', 'w028', 'w026'],
    label: [277, 352], terrain: 'hills',
    neighbors: ['bel', 'idf', 'aqu', 'swi', 'rhi'],
    coastal: true,
  },
  swi: {
    id: 'swi', name: 'Switzerland',
    shape: ['w029', 'srha4', 'srha5', 'w018', 'w017'],
    label: [301, 358], terrain: 'mountains',
    neighbors: ['bur', 'bav', 'pie'],
    coastal: false,
  },
});
