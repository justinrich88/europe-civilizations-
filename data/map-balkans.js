// data/map-balkans.js — the Balkans and Anatolia. See data/map-seams.js.
//
// Seams consumed (referenced verbatim, never redefined):
//   alpsDrava  eastern run  scso4 scso5 scso6 scso7 scso8   — northern frontier, vs central/Hungary
//   lowerDanube             scso8 sesu2 sesu3 sesu4         — northeastern frontier, vs east/Ukraine
// scso4 is the head of the Adriatic: Italy ends there and the Balkans begin.
// Italy and the Balkans share no land edge beyond that single point.
//
// Interior vertex prefix: k.

Object.assign(VERTS, {
  // Adriatic / Ionian coast, north to south
  k001: [410, 400], // Istria
  k002: [422, 428], // Dalmatia
  k003: [436, 456], // cro | ser coastal terminus
  k004: [442, 474], // Montenegro
  k005: [456, 494], // ser | gre coastal terminus (Epirus)

  // cro | ser interior
  k010: [452, 412],

  // Danube plain: rom | bul frontier, west to east
  k033: [510, 404], // ser | rom | bul triple point
  k032: [538, 424],
  k031: [566, 434],
  k030: [594, 424], // Black Sea coast, rom | bul terminus

  // ser | bul frontier
  k040: [500, 434],
  k041: [488, 466], // ser | bul | gre triple point

  // Bulgarian Black Sea coast and the bul | thr frontier
  k060: [588, 440],
  k061: [576, 452], // bul | thr coastal terminus
  k062: [548, 448],
  k051: [518, 470], // gre | bul | thr triple point

  // Greek peninsula, Ionian coast round to the Aegean
  k006: [450, 516],
  k007: [468, 536],
  k008: [492, 540], // southern tip
  k009: [512, 514],
  k052: [524, 496], // gre | thr coastal terminus

  // Thrace: the Bosporus and the Sea of Marmara.
  // Constantinople sits at [565, 462], just inside this run.
  k063: [570, 466], // Bosporus, northern mouth
  k064: [564, 480], // Marmara
  k065: [546, 492], // Aegean

  // Anatolia. Separated from Thrace by the Bosporus — no land edge.
  k070: [588, 470], // Asian shore of the Bosporus
  k071: [620, 458],
  k072: [660, 452],
  k073: [700, 456],
  k074: [716, 480], // eastern terminus
  k075: [706, 508],
  k076: [668, 522],
  k077: [628, 516],
  k078: [598, 500],
  k079: [584, 484], // Dardanelles / Aegean shore
});

Object.assign(TERRITORIES, {
  cro: {
    id: 'cro', name: 'Croatia',
    shape: ['scso4', 'scso5', 'scso6', 'k010', 'k003', 'k002', 'k001'],
    label: [432, 410], terrain: 'hills',
    neighbors: ['ser', 'hun', 'aus'],
    coastal: true,
  },

  ser: {
    id: 'ser', name: 'Serbia',
    shape: ['scso6', 'scso7', 'scso8', 'k033', 'k040', 'k041', 'k005', 'k004', 'k003', 'k010'],
    label: [472, 432], terrain: 'mountains',
    neighbors: ['cro', 'rom', 'bul', 'gre', 'hun'],
    coastal: true,
  },

  rom: {
    id: 'rom', name: 'Romania',
    shape: ['scso8', 'sesu2', 'sesu3', 'sesu4', 'k030', 'k031', 'k032', 'k033'],
    label: [552, 404], terrain: 'plains',
    neighbors: ['ser', 'bul', 'ukr'],
    coastal: true,
  },

  bul: {
    id: 'bul', name: 'Bulgaria',
    shape: ['k033', 'k032', 'k031', 'k030', 'k060', 'k061', 'k062', 'k051', 'k041', 'k040'],
    label: [538, 442], terrain: 'mountains',
    neighbors: ['ser', 'rom', 'gre', 'thr'],
    coastal: true,
  },

  gre: {
    id: 'gre', name: 'Greece',
    shape: ['k041', 'k051', 'k052', 'k009', 'k008', 'k007', 'k006', 'k005'],
    label: [484, 506], terrain: 'mountains',
    neighbors: ['ser', 'bul', 'thr'],
    coastal: true,
  },

  thr: {
    id: 'thr', name: 'Thrace',
    shape: ['k051', 'k062', 'k061', 'k063', 'k064', 'k065', 'k052'],
    label: [548, 470], terrain: 'hills',
    // NOT a land neighbour of ana: the Bosporus is a sea LINK, the Ottoman
    // chokepoint of 00-vision.md §2.
    neighbors: ['bul', 'gre'],
    coastal: true,
  },

  ana: {
    id: 'ana', name: 'Anatolia',
    shape: ['k070', 'k071', 'k072', 'k073', 'k074', 'k075', 'k076', 'k077', 'k078', 'k079'],
    label: [648, 484], terrain: 'mountains',
    neighbors: [], // reached only by sea, across the Bosporus
    coastal: true,
  },
});
