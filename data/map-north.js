// data/map-north.js — Scandinavia. See data/map-seams.js.
//
// Three territories: Norway, Sweden, Finland.
// Interior vertex prefix: `n`. Seams referenced verbatim, never redefined:
//   danish  ['sbad1','sbad2','sbad3','sbad4'] — southern boundary vs den (central)
//   karelia ['sfru1'..'sfru5']                — eastern boundary vs stp (east)
//
// Shared runs (same ids on both sides, per 01-data-schema.md):
//   nrw|swe  n008 n009 n010 n011 n012 sbad3   (the Kjolen ridge, N to S)
//   nrw|fin  sfru1 n006 n007 n008             (Finnmark border, NE to SW)
//   swe|fin  n008 n020 n021                   (Lapland border down to the
//                                              head of the Gulf of Bothnia)
// n008 [452,118] is the Norway/Sweden/Finland triple point.
// The Gulf of Bothnia is open water between Sweden's east coast (n021 n022
// n023 n024) and Finland's west coast (n021 n028 n027) — they meet only at
// the gulf head, n021.

Object.assign(VERTS, {
  // Arctic coast, west to east (Lofoten -> North Cape -> Varanger)
  n001: [372, 62],
  n002: [400, 46],
  n003: [440, 40],
  n004: [480, 48],
  n005: [510, 58],

  // Norway | Finland border, sfru1 south-west to the triple point
  n006: [508, 92],
  n007: [478, 108],
  n008: [452, 118], // TRIPLE POINT nrw | swe | fin

  // Norway | Sweden border, triple point south to sbad3
  n009: [426, 140],
  n010: [412, 163],
  n011: [398, 184],
  n012: [386, 206],

  // Norwegian Atlantic coast, sbad1 north back to n001
  n013: [322, 210],
  n014: [332, 186],
  n015: [324, 162],
  n016: [334, 140],
  n017: [340, 116],
  n018: [352, 92],
  n019: [360, 74],

  // Sweden | Finland border, triple point south-east to the gulf head
  n020: [468, 140],
  n021: [480, 158], // head of the Gulf of Bothnia

  // Swedish Baltic coast, gulf head south to Scania (sbad4)
  n022: [466, 180],
  n023: [448, 200],
  n024: [428, 220],

  // Finnish coast: Gulf of Finland west from sfru5, then north up the
  // eastern shore of the Gulf of Bothnia to the gulf head
  n025: [520, 192],
  n026: [500, 198],
  n027: [478, 192],
  n028: [486, 178],
});

Object.assign(TERRITORIES, {
  nrw: {
    id: 'nrw', name: 'Norway',
    shape: [
      'n001', 'n002', 'n003', 'n004', 'n005',       // Arctic coast, W->E
      'sfru1',                                       // Karelia seam, far N end only
      'n006', 'n007', 'n008',                        // border with Finland
      'n009', 'n010', 'n011', 'n012',                // border with Sweden
      'sbad3', 'sbad2', 'sbad1',                     // Danish straits seam, E->W
      'n013', 'n014', 'n015', 'n016', 'n017', 'n018', 'n019', // Atlantic coast, S->N
    ],
    label: [370, 130], terrain: 'mountains',
    neighbors: ['swe', 'fin', 'den'],
    coastal: true,
  },

  swe: {
    id: 'swe', name: 'Sweden',
    shape: [
      'n008', 'n020', 'n021',                        // border with Finland, N->S
      'n022', 'n023', 'n024',                        // Baltic coast, N->S
      'sbad4', 'sbad3',                              // Danish straits seam, E->W
      'n012', 'n011', 'n010', 'n009',                // border with Norway, S->N
    ],
    label: [430, 180], terrain: 'forest',
    neighbors: ['nrw', 'fin', 'den'],
    coastal: true,
  },

  fin: {
    id: 'fin', name: 'Finland',
    shape: [
      'n008', 'n007', 'n006',                        // border with Norway, W->E
      'sfru1', 'sfru2', 'sfru3', 'sfru4', 'sfru5',   // Karelia seam, N->S
      'n025', 'n026', 'n027',                        // Gulf of Finland, E->W
      'n028', 'n021', 'n020',                        // Gulf of Bothnia shore, S->N
    ],
    label: [500, 140], terrain: 'forest',
    neighbors: ['swe', 'nrw', 'stp'],
    coastal: true,
  },
});
