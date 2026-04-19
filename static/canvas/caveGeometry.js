"use strict";

// ─── Tunables ─────────────────────────────────────────────────────────────────
const CAVE_MIN_REGION_AREA  = 400;  // world-unit² — smaller blobs are dropped
const CAVE_SIMPLIFY_TOLERANCE = 6;  // RDP tolerance in world units
const CAVE_SMOOTHING_ITERATIONS = 2; // Chaikin passes

// ─── Area ─────────────────────────────────────────────────────────────────────

function computePolygonArea(points) {
  let area = 0;
  const n = points.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += points[j].x * points[i].y - points[i].x * points[j].y;
  }
  return Math.abs(area) / 2;
}

// ─── Simplification — Ramer-Douglas-Peucker ──────────────────────────────────

function _rdp(pts, lo, hi, tol, keep) {
  if (hi <= lo + 1) return;
  let maxDist = 0, maxIdx = lo;
  for (let i = lo + 1; i < hi; i++) {
    const d = pointToSegmentDistance(
      pts[i].x, pts[i].y,
      pts[lo].x, pts[lo].y,
      pts[hi].x, pts[hi].y
    );
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > tol) {
    keep[maxIdx] = 1;
    _rdp(pts, lo, maxIdx, tol, keep);
    _rdp(pts, maxIdx, hi, tol, keep);
  }
}

// Simplify a closed polygon using RDP.
// Treats the polygon as an open path from [0..n-1] for the main pass,
// then checks the wrap-around segment separately.
function simplifyContour(points, tolerance) {
  const tol = tolerance != null ? tolerance : CAVE_SIMPLIFY_TOLERANCE;
  const n = points.length;
  if (n <= 4) return points;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  _rdp(points, 0, n - 1, tol, keep);

  return points.filter((_, i) => keep[i]);
}

// ─── Smoothing — Chaikin corner-cutting ──────────────────────────────────────

function smoothContour(points, iterations) {
  const iters = iterations != null ? iterations : CAVE_SMOOTHING_ITERATIONS;
  let pts = points;
  for (let it = 0; it < iters; it++) {
    const next = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      next.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    pts = next;
  }
  return pts;
}

// ─── Filtering ────────────────────────────────────────────────────────────────

function filterSmallContours(contours) {
  return contours.filter(pts =>
    pts.length >= 3 && computePolygonArea(pts) >= CAVE_MIN_REGION_AREA
  );
}

// ─── Query helpers ────────────────────────────────────────────────────────────

// Return all geometry objects that are kind=cave and whose bounds intersect
// the given world bounds.
function getIntersectingCaveGeometry(worldBounds) {
  const result = [];
  if (!state.geometry) return result;
  for (const [, obj] of state.geometry) {
    if (obj.kind !== GEOMETRY_KIND.CAVE) continue;
    const gb = geometryBoundsToWorldBounds(obj.bounds);
    if (boundsIntersect(gb, worldBounds)) result.push(obj);
  }
  return result;
}

// ─── Build geometry objects from contours ─────────────────────────────────────

function buildCaveGeometryObjectsFromContours(contours, createdBy) {
  const objs = [];
  for (const pts of contours) {
    if (pts.length < 3) continue;
    const obj = createCaveGeometry(pts);
    if (createdBy) obj.createdBy = String(createdBy);
    objs.push(obj);
  }
  return objs;
}
