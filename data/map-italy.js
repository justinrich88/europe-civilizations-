// data/map-italy.js — the Italian peninsula. See data/map-seams.js.
//
// Seam consumed: alpsDrava, western run only —
//   ['srha5','scso2','scso3','scso4'] = [312,356] [342,364] [372,360] [400,370]
// srha5 is the Alpine triple point (west | central | south); scso4 is the head
// of the Adriatic, where Italy stops and the Balkans begin. scso5+ belong to
// data/map-balkans.js. Italy and the Balkans share no land edge — only scso4.
//
// Interior vertices are prefixed `t`. Bounding box x 305-430, y 355-545.

Object.assign(VERTS, {
  // --- Ligurian / Tyrrhenian coast, north-west to the toe ---
  t001: [308, 382], // Ligurian coast at the French frontier
  t002: [332, 400], // Genoa
  t003: [352, 420],
  t004: [372, 442], // Tuscan coast
  t005: [388, 466], // Tyrrhenian coast below Rome
  t006: [398, 490], // Bay of Naples
  t007: [392, 512], // Calabrian west coast
  t008: [402, 518], // the toe

  // --- Adriatic coast, head of the gulf south to the heel ---
  t009: [404, 392], // Venetian lagoon
  t010: [410, 416],
  t011: [418, 442], // Ancona
  t012: [426, 468], // Gargano
  t013: [430, 486], // Otranto, the heel
  t014: [414, 502], // Gulf of Taranto

  // --- interior junctions ---
  t015: [338, 394], // Apennine junction: pie | lom | tus
  t016: [376, 400], // lower Po junction: lom | ven | tus

  // --- Sicily, an island off the toe. No land edge with anything. ---
  t017: [348, 520],
  t018: [382, 526], // Messina, facing the toe across the strait
  t019: [374, 544],
  t020: [346, 536],
});

Object.assign(TERRITORIES, {
  pie: {
    id: 'pie', name: 'Piedmont',
    // w017/w018 are Switzerland's southern run, authored in map-west.js. The
    // seam file declared srha5 a triple point but never gave the Swiss-Italian
    // border its own run, so each side invented one and left a hole. Piedmont
    // adopts the western vertices to close it. See known-issues.md #7.
    shape: ['srha5', 'scso2', 't015', 't002', 't001', 'w017', 'w018'],
    label: [325, 377], terrain: 'mountains',
    neighbors: ['lom', 'tus', 'swi', 'bav'],
    coastal: true,
  },

  lom: {
    id: 'lom', name: 'Lombardy',
    shape: ['scso2', 'scso3', 't016', 't015'],
    label: [356, 380], terrain: 'plains',
    neighbors: ['pie', 'ven', 'tus', 'aus'],
    coastal: false,
  },

  ven: {
    id: 'ven', name: 'Venetia',
    shape: ['scso3', 'scso4', 't009', 't010', 't016'],
    label: [390, 386], terrain: 'plains',
    neighbors: ['lom', 'tus', 'aus'],
    coastal: true,
  },

  tus: {
    id: 'tus', name: 'Tuscany',
    shape: ['t002', 't015', 't016', 't010', 't011', 't005', 't004', 't003'],
    label: [374, 424], terrain: 'hills',
    neighbors: ['pie', 'lom', 'ven', 'nap'],
    coastal: true,
  },

  nap: {
    id: 'nap', name: 'Naples',
    shape: ['t005', 't011', 't012', 't013', 't014', 't008', 't007', 't006'],
    label: [408, 482], terrain: 'hills',
    neighbors: ['tus'],
    coastal: true,
  },

  sic: {
    id: 'sic', name: 'Sicily',
    // Island. Sicily reaches the mainland only by sea, so it has no
    // neighbours at all — the Strait of Messina becomes a LINK with sea:true.
    shape: ['t017', 't018', 't019', 't020'],
    label: [364, 532], terrain: 'hills',
    neighbors: [],
    coastal: true,
  },
});
