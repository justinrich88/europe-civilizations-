// core/util.js — small shared helpers. Deliberately lean.

'use strict';

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Distance between two [x, y] points.
function dist(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// Ray-casting point-in-polygon. `poly` is an array of [x, y], closed implicitly.
function pointInPolygon(pt, poly) {
  const x = pt[0], y = pt[1];
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const hit = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

// Area-weighted centroid of a polygon. Falls back to the mean of the
// vertices for degenerate (zero-area) input.
function centroid(poly) {
  if (!poly || poly.length === 0) return [0, 0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const cross = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += cross;
    cx += (poly[j][0] + poly[i][0]) * cross;
    cy += (poly[j][1] + poly[i][1]) * cross;
  }
  if (a === 0) {
    let mx = 0, my = 0;
    for (const p of poly) { mx += p[0]; my += p[1]; }
    return [mx / poly.length, my / poly.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// Compact display number. Garrisons are floats in state; floor at render.
function formatNum(n) {
  if (!isFinite(n)) return '-';
  const v = Math.floor(n);
  if (Math.abs(v) >= 10000) return (v / 1000).toFixed(0) + 'k';
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}

function byId(id) {
  return document.getElementById(id);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'g', 'defs', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'use', 'pattern', 'clipPath', 'title', 'marker', 'ellipse',
]);

// el('circle', 'station-node', { r: 8 }) — picks the SVG namespace when the
// tag needs it. `attrs.text` sets textContent; everything else is an attribute.
function el(tag, cls, attrs) {
  const node = SVG_TAGS.has(tag)
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag);
  if (cls) node.setAttribute('class', cls);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null) continue;
      if (k === 'text') node.textContent = String(v);
      else node.setAttribute(k, String(v));
    }
  }
  return node;
}
