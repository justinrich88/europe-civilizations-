// data/map-isles.js — British Isles geometry. See data/map-seams.js.
//
// The Isles are entirely coastal: no land edge leaves this file, so no seam
// vertex (`s`-prefixed) is referenced anywhere below. All vertices are
// interior to this region and use the `i` prefix.
//
// Two landmasses:
//   Ireland        — an island, no land neighbours at all.
//   Great Britain  — Scotland / Northern England / Wales / Southern England,
//                    sharing runs of vertices along every internal border.
//
// Shared runs (written once, referenced by both sides):
//   sco | nen : i020 i021 i022 i023   (Cheviots, west coast to east coast)
//   nen | sen : i032 i040 i041        (east coast west to the triple point)
//   nen | wal : i041 i042 i043        (triple point west to the Irish Sea)
//   wal | sen : i041 i050 i051        (triple point south to the Severn)
// i041 is the nen | wal | sen triple point.

Object.assign(VERTS, {
  // --- Ireland (island) -------------------------------------------------
  i080: [70, 176],  // Malin Head
  i081: [92, 184],
  i082: [98, 202],  // Irish Sea coast
  i083: [96, 222],
  i084: [82, 240],  // Cork
  i085: [62, 242],
  i086: [50, 224],  // Atlantic coast
  i087: [48, 200],
  i088: [56, 184],

  // --- Scotland: outer coast --------------------------------------------
  i001: [148, 120], // northern tip
  i002: [172, 128],
  i003: [180, 146], // North Sea coast
  i004: [178, 164],
  i005: [118, 166], // west coast
  i006: [128, 148],
  i007: [122, 132],

  // --- sco | nen border, west to east -----------------------------------
  i020: [122, 184], // Solway Firth, west terminus
  i021: [140, 177],
  i022: [158, 182],
  i023: [176, 178], // Tweed mouth, east terminus

  // --- Northern England: outer coast ------------------------------------
  i030: [186, 192], // North Sea coast
  i031: [190, 208],
  i032: [186, 224], // Wash — also east terminus of the nen | sen border
  i033: [116, 208], // Irish Sea coast
  i034: [120, 194],

  // --- nen | sen border, east to west; ends at the triple point ---------
  i040: [168, 229],
  i041: [150, 232], // TRIPLE POINT nen | wal | sen

  // --- nen | wal border, triple point west to the coast -----------------
  i042: [134, 228],
  i043: [122, 224], // Irish Sea, west terminus

  // --- wal | sen border, triple point south to the Severn ---------------
  i050: [152, 246],
  i051: [146, 258], // Severn mouth, south terminus

  // --- Wales: outer coast -----------------------------------------------
  i052: [130, 262],
  i053: [114, 252],
  i054: [110, 238],

  // --- Southern England: outer coast ------------------------------------
  i060: [196, 240],
  i061: [204, 258],
  i062: [206, 275], // Dover
  i063: [190, 284], // Channel coast
  i064: [168, 288],
  i065: [148, 282],
  i066: [136, 266], // north shore of the Cornish peninsula
  i067: [124, 274], // Land's End
});

Object.assign(TERRITORIES, {
  irl: {
    id: 'irl', name: 'Ireland',
    shape: ['i080', 'i081', 'i082', 'i083', 'i084', 'i085', 'i086', 'i087', 'i088'],
    label: [72, 210], terrain: 'plains',
    neighbors: [],               // an island — every crossing is a sea LINK
    coastal: true,
  },

  sco: {
    id: 'sco', name: 'Scotland',
    shape: ['i001', 'i002', 'i003', 'i004',
            'i023', 'i022', 'i021', 'i020',
            'i005', 'i006', 'i007'],
    label: [148, 150], terrain: 'mountains',
    neighbors: ['nen'],
    coastal: true,
  },

  nen: {
    id: 'nen', name: 'Northern England',
    shape: ['i020', 'i021', 'i022', 'i023',
            'i030', 'i031', 'i032',
            'i040', 'i041', 'i042', 'i043',
            'i033', 'i034'],
    label: [152, 202], terrain: 'hills',
    neighbors: ['sco', 'wal', 'sen'],
    coastal: true,
  },

  wal: {
    id: 'wal', name: 'Wales',
    shape: ['i043', 'i042', 'i041',
            'i050', 'i051',
            'i052', 'i053', 'i054'],
    label: [130, 243], terrain: 'mountains',
    neighbors: ['nen', 'sen'],
    coastal: true,
  },

  sen: {
    id: 'sen', name: 'Southern England',
    shape: ['i032', 'i060', 'i061', 'i062',
            'i063', 'i064', 'i065', 'i067', 'i066',
            'i051', 'i050', 'i041', 'i040'],
    label: [176, 258], terrain: 'plains',
    neighbors: ['nen', 'wal'],
    coastal: true,
  },
});
