// data/map-central.js — Germany, Austria-Hungary, Bohemia, Denmark. See data/map-seams.js.
//
// Seams referenced verbatim (never redefined here):
//   Rhine–Alps  (west)  : srha1 srha2 srha3 srha4 srha5   — han, rhi, bav
//   Danish      (north) : sbad1 sbad2 sbad3 sbad4         — den
//   Vistula     (east)  : spol1 spol2 spol3 spol4 spol5 scso8 — sil, hun
//   Alps–Drava  (south) : srha5 scso2 … scso7 scso8       — bav, aus, hun
// Non-seam outer edges (North Sea / Baltic coast) use interior `c` vertices.

Object.assign(VERTS, {
  // North Sea coast + Denmark's southern chord
  c001: [310, 250], // North Sea coast — den | han
  c002: [330, 264],
  c003: [354, 270], // den | han | bra
  c004: [382, 262],

  // Baltic coast, east of sbad4
  c005: [432, 248],
  c006: [462, 250], // Baltic coast — bra | sil

  // North German interior
  c010: [358, 300], // han | bra | sax
  c011: [400, 304],
  c012: [436, 300], // bra | sax | sil
  c013: [448, 272],

  // Rhineland
  c020: [330, 300], // han | rhi | sax
  c021: [336, 330], // rhi | sax | bav

  // Bohemian ring
  c030: [388, 318], // sax | bav | boh
  c031: [430, 318], // sax | sil | boh
  c032: [438, 342], // sil | boh | aus
  c033: [404, 352],
  c034: [378, 336], // boh | bav | aus

  // Carpathian / Alpine interior
  c040: [470, 330], // sil | aus | hun
  c051: [358, 352],
  c060: [440, 358], // aus | hun
});

Object.assign(TERRITORIES, {
  den: {
    id: 'den', name: 'Denmark',
    shape: ['c001', 'sbad1', 'sbad2', 'sbad3', 'sbad4', 'c004', 'c003', 'c002'],
    label: [356, 248], terrain: 'plains',
    neighbors: ['han', 'bra', 'swe', 'nrw'],
    coastal: true,
  },

  han: {
    id: 'han', name: 'Hanover',
    shape: ['srha1', 'c001', 'c002', 'c003', 'c010', 'c020', 'srha2'],
    label: [330, 282], terrain: 'plains',
    neighbors: ['den', 'bra', 'sax', 'rhi', 'ned'],
    coastal: true,
  },

  bra: {
    id: 'bra', name: 'Brandenburg',
    shape: ['c003', 'c004', 'sbad4', 'c005', 'c006', 'c013', 'c012', 'c011', 'c010'],
    label: [396, 276], terrain: 'plains',
    neighbors: ['den', 'han', 'sax', 'sil'],
    coastal: true,
  },

  rhi: {
    id: 'rhi', name: 'Rhineland',
    shape: ['srha2', 'c020', 'c021', 'srha4', 'srha3'],
    label: [318, 312], terrain: 'hills',
    neighbors: ['han', 'sax', 'bav', 'bel', 'bur'],
    coastal: false,
  },

  sax: {
    id: 'sax', name: 'Saxony',
    shape: ['c020', 'c010', 'c011', 'c012', 'c031', 'c030', 'c021'],
    label: [372, 312], terrain: 'hills',
    neighbors: ['han', 'bra', 'sil', 'boh', 'bav', 'rhi'],
    coastal: false,
  },

  sil: {
    id: 'sil', name: 'Silesia',
    shape: ['c006', 'spol1', 'spol2', 'spol3', 'spol4', 'c040', 'c032', 'c031', 'c012', 'c013'],
    label: [468, 288], terrain: 'plains',
    neighbors: ['bra', 'sax', 'boh', 'aus', 'hun', 'epr', 'pol'],
    coastal: true,
  },

  bav: {
    id: 'bav', name: 'Bavaria',
    shape: ['c021', 'c030', 'c034', 'c051', 'scso2', 'srha5', 'srha4'],
    label: [348, 340], terrain: 'hills',
    neighbors: ['rhi', 'sax', 'boh', 'aus', 'swi', 'pie'],
    coastal: false,
  },

  boh: {
    id: 'boh', name: 'Bohemia',
    shape: ['c030', 'c031', 'c032', 'c033', 'c034'],
    label: [408, 334], terrain: 'forest',
    neighbors: ['sax', 'bav', 'sil', 'aus'],
    coastal: false,
  },

  aus: {
    id: 'aus', name: 'Austria',
    shape: ['scso2', 'c051', 'c034', 'c033', 'c032', 'c040', 'c060', 'scso5', 'scso4', 'scso3'],
    label: [400, 358], terrain: 'mountains',
    neighbors: ['bav', 'boh', 'sil', 'hun', 'ven', 'cro', 'lom'],
    coastal: false,
  },

  hun: {
    id: 'hun', name: 'Hungary',
    shape: ['c040', 'spol4', 'spol5', 'scso8', 'scso7', 'scso6', 'scso5', 'c060'],
    label: [468, 352], terrain: 'plains',
    neighbors: ['sil', 'aus', 'cro', 'ser', 'ukr'],
    coastal: false,
  },
});
