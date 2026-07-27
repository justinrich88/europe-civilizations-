// data/map-east.js — Russia and the western marches. See data/map-seams.js.
//
// Interior vertex prefix: `e`. Seams referenced verbatim, never redefined:
//   vistula     ['spol1','spol2','spol3','spol4','spol5','scso8'] — western
//               boundary vs central/south. epr spol1-spol2, pol spol2-spol4,
//               ukr spol4-scso8. scso8 is the Iron Gates triple point.
//   karelia     ['sfru1'..'sfru5'] — northern boundary vs fin (north). stp owns
//               the whole run.
//   lowerDanube ['scso8','sesu2','sesu3','sesu4'] — southern boundary vs rom
//               (balkans). ukr owns the whole run.
//
// This is the emptiest region by design (00-vision.md §2): eight very large
// polygons with few vertices each, so Russia reads as enormous and sparse.
//
// OUTER BOUNDARY, clockwise from the Vistula's Baltic terminus:
//   spol1 e001 e002 e003 sfru5   Baltic coast, Danzig to the Gulf of Finland
//   sfru5 .. sfru1               Karelia seam, Gulf of Finland to the Arctic
//   sfru1 e004 .. e009           Arctic / White Sea coast, west to east
//   e009 .. e014                 eastern map edge (x~790), the Urals
//   e014 .. e018 sesu4           Caspian steppe and Black Sea coast, east->west
//   sesu4 .. scso8               lower Danube seam
//   scso8 .. spol1               Vistula seam, south to north

Object.assign(VERTS, {
  // Baltic coast, Vistula mouth NE to the Gulf of Finland
  e001: [514, 230],
  e002: [526, 212],
  e003: [534, 196],

  // Arctic / White Sea coast, west to east
  e004: [578, 60],
  e005: [624, 66],
  e006: [668, 60],
  e007: [712, 68],
  e008: [756, 64],
  e009: [786, 74],

  // Eastern map edge, north to south
  e010: [790, 140],
  e011: [784, 210],
  e012: [790, 280],
  e013: [786, 340],
  e014: [780, 392],

  // Southern edge, east to west, meeting the Black Sea at sesu4
  e015: [736, 398],
  e016: [692, 394],
  e017: [648, 400],
  e018: [614, 398],

  // Interior junctions
  e019: [556, 244], // TRIPLE POINT epr | bal | blr
  e020: [548, 278], // TRIPLE POINT epr | pol | blr
  e021: [588, 206], // TRIPLE POINT stp | bal | mos
  e022: [596, 246], // TRIPLE POINT bal | blr | mos
  e023: [640, 120], // stp | mos
  e024: [624, 176], // stp | mos
  e025: [570, 318], // TRIPLE POINT pol | blr | ukr
  e026: [636, 332], // TRIPLE POINT blr | ukr | mos
  e027: [690, 350], // TRIPLE POINT ukr | mos | vol
  e028: [636, 268], // blr | mos
  e029: [740, 270], // mos | vol
});

Object.assign(TERRITORIES, {
  epr: {
    id: 'epr', name: 'East Prussia',
    shape: [
      'spol1', 'e001',            // Baltic coast
      'e019', 'e020',             // inland, vs bal then blr
      'spol2',                    // Vistula seam, back N to spol1
    ],
    label: [524, 254], terrain: 'plains',
    neighbors: ['pol', 'bal', 'blr', 'sil'],
    coastal: true,
  },

  pol: {
    id: 'pol', name: 'Poland',
    shape: [
      'spol2', 'e020',            // vs epr
      'e025',                     // vs blr
      'spol4', 'spol3',           // Vistula seam, S->N back to spol2
    ],
    label: [532, 298], terrain: 'plains',
    neighbors: ['epr', 'blr', 'ukr', 'sil'],
    coastal: false,
  },

  bal: {
    id: 'bal', name: 'Baltics',
    shape: [
      'e001', 'e002', 'e003', 'sfru5',  // Baltic coast up to the Gulf of Finland
      'e021',                            // vs stp
      'e022',                            // vs mos
      'e019',                            // vs blr, then closes to e001 vs epr
    ],
    label: [551, 218], terrain: 'forest',
    neighbors: ['epr', 'stp', 'mos', 'blr'],
    coastal: true,
  },

  stp: {
    id: 'stp', name: 'St Petersburg',
    shape: [
      'sfru5', 'sfru4', 'sfru3', 'sfru2', 'sfru1',  // Karelia seam, S->N
      'e004', 'e005',                                // Arctic coast, W->E
      'e023', 'e024',                                // vs mos, N->S
      'e021',                                        // vs bal, closes to sfru5
    ],
    label: [582, 124], terrain: 'forest',
    neighbors: ['bal', 'mos', 'fin'],
    coastal: true,
  },

  blr: {
    id: 'blr', name: 'Belarus',
    shape: [
      'e019', 'e022',             // vs bal, W->E
      'e028', 'e026',             // vs mos, N->S
      'e025',                     // vs ukr
      'e020',                     // vs pol, then closes to e019 vs epr
    ],
    label: [594, 284], terrain: 'forest',
    neighbors: ['pol', 'epr', 'bal', 'mos', 'ukr'],
    coastal: false,
  },

  ukr: {
    id: 'ukr', name: 'Ukraine',
    shape: [
      'spol4', 'e025',                          // vs pol
      'e026',                                   // vs blr
      'e027',                                   // vs mos
      'e017',                                   // vs vol
      'e018', 'sesu4',                          // Black Sea coast, E->W
      'sesu3', 'sesu2', 'scso8',                // lower Danube seam, E->W
      'spol5',                                  // Vistula seam, closes to spol4
    ],
    label: [586, 362], terrain: 'plains',
    neighbors: ['pol', 'blr', 'mos', 'vol', 'hun', 'rom'],
    coastal: true,
  },

  mos: {
    id: 'mos', name: 'Moscow',
    shape: [
      'e021', 'e024', 'e023', 'e005',           // vs stp, S->N
      'e006', 'e007', 'e008', 'e009',           // Arctic / White Sea coast, W->E
      'e010', 'e011',                           // eastern map edge
      'e029', 'e027',                           // vs vol, NE->SW
      'e026', 'e028',                           // vs ukr then blr, S->N
      'e022',                                   // vs blr, closes to e021 vs bal
    ],
    label: [700, 190], terrain: 'plains',
    neighbors: ['stp', 'bal', 'blr', 'ukr', 'vol'],
    coastal: true,
  },

  vol: {
    id: 'vol', name: 'Volga',
    shape: [
      'e011', 'e012', 'e013', 'e014',           // eastern map edge, N->S
      'e015', 'e016', 'e017',                   // southern steppe coast, E->W
      'e027', 'e029',                           // vs ukr then mos, closes to e011
    ],
    label: [738, 330], terrain: 'plains',
    neighbors: ['mos', 'ukr'],
    coastal: true,
  },
});
