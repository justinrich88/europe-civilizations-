// data/map-iberia.js — Iberian geometry. See data/map-seams.js.
//
// Seam consumed: SEAMS.pyrenees = spyr1..spyr4, the whole northern boundary,
// shared with region `west`. Split point between Castile and Catalonia is
// spyr3 [185,402]: cas runs spyr1->spyr3, cat runs spyr3->spyr4.
// Interior vertices are prefixed `b` and defined only here.

Object.assign(VERTS, {
  // Atlantic / Biscay coast, north-west round to the south-west.
  b001: [100, 400], // Galicia, north-west corner (Biscay coast, west of spyr1)
  b002: [78, 425],  // Atlantic coast, cas|por boundary reaches the sea
  b003: [70, 458],  // Portuguese Atlantic coast
  b004: [76, 492],  // Atlantic coast, por|and boundary reaches the sea
  b005: [90, 512],  // Cape St Vincent, south-west corner

  // South coast, west to east, then up the Mediterranean coast.
  b006: [130, 518],
  b007: [165, 514],
  b008: [196, 504], // Gibraltar / south-east corner
  b009: [220, 462], // Mediterranean coast
  b010: [222, 432], // Mediterranean coast, below spyr4

  // Interior — Portugal's landward frontier.
  b011: [106, 428],
  b012: [112, 458],
  b013: [110, 488], // TRIPLE POINT por | cas | and

  // Interior — Castile / Catalonia frontier, running south from spyr3.
  b014: [180, 432],
  b015: [172, 462],
  b016: [168, 482], // TRIPLE POINT cas | cat | and

  // Interior — the northern edge of Andalusia.
  b017: [140, 486],
  b018: [206, 484], // cat|and boundary reaches the Mediterranean
});

Object.assign(TERRITORIES, {
  por: {
    id: 'por', name: 'Portugal',
    shape: ['b002', 'b011', 'b012', 'b013', 'b004', 'b003'],
    label: [92, 458], terrain: 'hills',
    neighbors: ['cas', 'and'],
    coastal: true,
  },
  cas: {
    id: 'cas', name: 'Castile',
    shape: ['b001', 'spyr1', 'spyr2', 'spyr3', 'b014', 'b015', 'b016',
            'b017', 'b013', 'b012', 'b011', 'b002'],
    label: [140, 442], terrain: 'plains',
    neighbors: ['por', 'and', 'cat', 'aqu'],
    coastal: true,
  },
  cat: {
    id: 'cat', name: 'Catalonia',
    shape: ['spyr3', 'spyr4', 'b010', 'b009', 'b018', 'b016', 'b015', 'b014'],
    label: [196, 444], terrain: 'hills',
    neighbors: ['cas', 'and', 'aqu'],
    coastal: true,
  },
  and: {
    id: 'and', name: 'Andalusia',
    shape: ['b013', 'b017', 'b016', 'b018', 'b008', 'b007', 'b006', 'b005', 'b004'],
    label: [148, 498], terrain: 'hills',
    neighbors: ['por', 'cas', 'cat'],
    coastal: true,
  },
});
