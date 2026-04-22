"use strict";

// ─── Edge Access ──────────────────────────────────────────────────────────────

function getEdgeCount(obj) {
  const n = (obj.outer || []).length;
  if (n < 2) return 0;
  return obj.closed ? n : n - 1;
}

function getEdgeStart(obj, edgeIndex) {
  return obj.outer[edgeIndex];
}

function getEdgeEnd(obj, edgeIndex) {
  const n = obj.outer.length;
  return obj.outer[(edgeIndex + 1) % n];
}

function getEdgeLength(obj, edgeIndex) {
  const a = getEdgeStart(obj, edgeIndex);
  const b = getEdgeEnd(obj, edgeIndex);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function pointAlongEdge(obj, edgeIndex, t) {
  const a = getEdgeStart(obj, edgeIndex);
  const b = getEdgeEnd(obj, edgeIndex);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// Perpendicular unit normal to the edge segment.
// Direction follows a left-hand rule relative to segment direction;
// not guaranteed to face outward unless the polygon uses a known winding order.
function getEdgeNormal(obj, edgeIndex) {
  const a = getEdgeStart(obj, edgeIndex);
  const b = getEdgeEnd(obj, edgeIndex);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: -1 };
  return { x: dy / len, y: -dx / len };
}

// Build a default edge array aligned to outer segments, using the kind's preset defaults.
function buildDefaultEdges(obj) {
  const count = getEdgeCount(obj);
  const preset = GEOMETRY_STYLE_PRESETS[obj.kind] || {};
  const role = preset.edgeDefaultRole || EDGE_ROLE.WALL;
  const renderMode = preset.edgeDefaultRenderMode || EDGE_RENDER_MODE.CLEAN_STROKE;
  const edges = [];
  for (let i = 0; i < count; i++) {
    edges.push({ index: i, role, renderMode });
  }
  return edges;
}

// ─── Bounds ───────────────────────────────────────────────────────────────────

function computeGeometryBounds(obj) {
  const pts = obj.outer || [];
  if (!pts.length) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateGeometryObject(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object") return { valid: false, errors: ["Not an object"] };
  if (!obj.id) errors.push("Missing id");
  if (obj.type !== "geometry") errors.push("type must be 'geometry'");
  if (!Object.values(GEOMETRY_KIND).includes(obj.kind)) errors.push(`Invalid kind: ${obj.kind}`);
  if (!Array.isArray(obj.outer)) {
    errors.push("outer must be an array");
  } else {
    const minLen = obj.closed ? 3 : 2;
    if (obj.outer.length < minLen) {
      errors.push(`outer needs at least ${minLen} points (closed=${obj.closed})`);
    }
    for (const p of obj.outer) {
      if (isNaN(p.x) || isNaN(p.y)) { errors.push("NaN coordinate in outer"); break; }
    }
  }
  if (Array.isArray(obj.openings)) {
    const count = getEdgeCount(obj);
    for (const op of obj.openings) {
      if (op.edgeIndex < 0 || op.edgeIndex >= count) {
        errors.push(`Opening edgeIndex ${op.edgeIndex} out of range (0..${count - 1})`);
      }
      if (!(op.t0 >= 0 && op.t0 < op.t1 && op.t1 <= 1)) {
        errors.push(`Opening t0/t1 invalid: ${op.t0}..${op.t1}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

// ─── Opening Helpers ──────────────────────────────────────────────────────────

function clampOpeningRange(t0, t1) {
  const a = clamp(Number(t0), 0, 1);
  const b = clamp(Number(t1), 0, 1);
  return { t0: Math.min(a, b), t1: Math.max(a, b) };
}

function openingWorldSpan(obj, opening) {
  return {
    start: pointAlongEdge(obj, opening.edgeIndex, opening.t0),
    end: pointAlongEdge(obj, opening.edgeIndex, opening.t1),
  };
}

function openingCenterPoint(obj, opening) {
  return pointAlongEdge(obj, opening.edgeIndex, (opening.t0 + opening.t1) / 2);
}

function openingRotationRadians(obj, opening) {
  const a = getEdgeStart(obj, opening.edgeIndex);
  const b = getEdgeEnd(obj, opening.edgeIndex);
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function addOpening(obj, opening) {
  return Object.assign({}, obj, {
    openings: [...(obj.openings || []), opening],
    updatedAt: Date.now(),
  });
}

function removeOpening(obj, openingId) {
  return Object.assign({}, obj, {
    openings: (obj.openings || []).filter((op) => op.id !== openingId),
    updatedAt: Date.now(),
  });
}

// Returns the opening id whose center is closest to the given world point, or null.
function openingHitTest(obj, worldX, worldY) {
  const tolWorld = Math.max(8, 12 / (typeof cam !== "undefined" ? cam.z : 1));
  for (const op of (obj.openings || [])) {
    const center = openingCenterPoint(obj, op);
    if (Math.hypot(worldX - center.x, worldY - center.y) <= tolWorld) return op.id;
  }
  return null;
}

// ─── Conversion ───────────────────────────────────────────────────────────────

function convertClosedWallPathToRoom(obj) {
  const next = Object.assign({}, obj, { kind: GEOMETRY_KIND.ROOM, closed: true });
  next.style = Object.assign({}, GEOMETRY_STYLE_PRESETS.room, obj.style || {});
  next.edges = buildDefaultEdges(next);
  next.updatedAt = Date.now();
  return next;
}

// ─── Shared Ordering ─────────────────────────────────────────────────────────

// Returns geometry objects sorted by ascending zIndex (render order).
// Pass { reverse: true } to get descending order for hit-testing (topmost first).
function getSortedGeometryObjects({ reverse = false } = {}) {
  const objs = [...state.geometry.values()].filter((obj) => obj.visible !== false);
  objs.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
  if (reverse) objs.reverse();
  return objs;
}

// ─── Hit Testing ─────────────────────────────────────────────────────────────

function _pointInPolygon(px, py, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function geometryContainsPoint(obj, wx, wy) {
  if (!obj.outer || obj.outer.length < 2) return false;
  if (obj.closed && obj.outer.length >= 3) {
    return _pointInPolygon(wx, wy, obj.outer);
  }
  // Open path: proximity to any segment
  const tol = Math.max(8, 8 / (typeof cam !== "undefined" ? cam.z : 1));
  const n = obj.outer.length;
  for (let i = 0; i < n - 1; i++) {
    const a = obj.outer[i], b = obj.outer[i + 1];
    if (pointToSegmentDistance(wx, wy, a.x, a.y, b.x, b.y) <= tol) return true;
  }
  return false;
}

// ─── Edge Hit-Testing ─────────────────────────────────────────────────────────

// Project a point onto a segment, returning t ∈ [0,1], the foot point, and distance.
function projectPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0) return { t: 0, x: ax, y: ay, distance: Math.hypot(px - ax, py - ay) };
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  const x = ax + t * dx, y = ay + t * dy;
  return { t, x, y, distance: Math.hypot(px - x, py - y) };
}

// Find nearest geometry edge to (worldX, worldY).
// Returns { geometryId, edgeIndex, distance, t, point, edgeStart, edgeEnd } or null.
// options.tolerance: world-unit snap distance (default: 24 / zoom, min 24).
function hitTestGeometryEdge(worldX, worldY, options = {}) {
  const z = typeof cam !== "undefined" ? cam.z : 1;
  const tolerance = options.tolerance != null ? options.tolerance : Math.max(24, 24 / z);
  const objs = getSortedGeometryObjects({ reverse: true });
  let best = null;
  for (const obj of objs) {
    if (obj.kind !== GEOMETRY_KIND.ROOM && obj.kind !== GEOMETRY_KIND.CAVE) continue;
    const edgeCount = getEdgeCount(obj);
    for (let i = 0; i < edgeCount; i++) {
      const a = getEdgeStart(obj, i);
      const b = getEdgeEnd(obj, i);
      const proj = projectPointToSegment(worldX, worldY, a.x, a.y, b.x, b.y);
      if (proj.distance > tolerance) continue;
      if (!best || proj.distance < best.distance) {
        best = {
          geometryId: obj.id,
          edgeIndex: i,
          distance: proj.distance,
          t: proj.t,
          point: { x: proj.x, y: proj.y },
          edgeStart: { x: a.x, y: a.y },
          edgeEnd: { x: b.x, y: b.y },
        };
      }
    }
  }
  return best;
}

// ─── Opening Span Helpers ─────────────────────────────────────────────────────

// Collect openings on a specific edge.
function getOpeningsForEdge(obj, edgeIndex) {
  return (obj.openings || []).filter((op) => op.edgeIndex === edgeIndex);
}

// Return true if [t0, t1) overlaps any existing opening on edgeIndex.
function openingOverlapsExisting(obj, edgeIndex, t0, t1, ignoreOpeningId = null) {
  for (const op of getOpeningsForEdge(obj, edgeIndex)) {
    if (ignoreOpeningId && op.id === ignoreOpeningId) continue;
    if (!(t1 <= op.t0 || t0 >= op.t1)) return true;
  }
  return false;
}

// Convert a desired world-unit width into a normalized [t0, t1] span centered on centerT.
// Returns { t0, t1 } or null if the edge is degenerate.
function openingSpanForWidth(obj, edgeIndex, centerT, widthWorld) {
  const len = getEdgeLength(obj, edgeIndex);
  if (len <= 0) return null;
  const half = widthWorld / 2 / len;
  const { t0, t1 } = clampOpeningRange(centerT - half, centerT + half);
  return t1 > t0 ? { t0, t1 } : null;
}

// Shrink [t0, t1] away from edge endpoints by marginWorld world units.
// Returns clamped { t0, t1 } or null if the edge is too short.
function clampOpeningToEdgeMargin(t0, t1, edgeLength, marginWorld) {
  if (edgeLength <= 0) return null;
  const m = marginWorld / edgeLength;
  const nt0 = Math.max(t0, m);
  const nt1 = Math.min(t1, 1 - m);
  return nt1 > nt0 ? { t0: nt0, t1: nt1 } : null;
}

// ─── Shared-Wall + Structure Detection ───────────────────────────────────────

// Returns true when two axis-aligned edges (one from each object) are collinear
// and their projected spans overlap. Only handles horizontal / vertical edges.
function edgesAreCollinearAndOverlap(objA, edgeI, objB, edgeJ, tolerance) {
  if (tolerance === undefined) tolerance = 4;
  const a0 = getEdgeStart(objA, edgeI);
  const a1 = getEdgeEnd(objA, edgeI);
  const b0 = getEdgeStart(objB, edgeJ);
  const b1 = getEdgeEnd(objB, edgeJ);

  const aHoriz = Math.abs(a1.y - a0.y) <= tolerance;
  const aVert  = Math.abs(a1.x - a0.x) <= tolerance;
  const bHoriz = Math.abs(b1.y - b0.y) <= tolerance;
  const bVert  = Math.abs(b1.x - b0.x) <= tolerance;

  if (aHoriz && bHoriz) {
    if (Math.abs(a0.y - b0.y) > tolerance) return false;
    const aMin = Math.min(a0.x, a1.x), aMax = Math.max(a0.x, a1.x);
    const bMin = Math.min(b0.x, b1.x), bMax = Math.max(b0.x, b1.x);
    return aMax > bMin + tolerance && bMax > aMin + tolerance;
  }
  if (aVert && bVert) {
    if (Math.abs(a0.x - b0.x) > tolerance) return false;
    const aMin = Math.min(a0.y, a1.y), aMax = Math.max(a0.y, a1.y);
    const bMin = Math.min(b0.y, b1.y), bMax = Math.max(b0.y, b1.y);
    return aMax > bMin + tolerance && bMax > aMin + tolerance;
  }
  return false;
}

// Strict segment intersection: returns true when the two segments properly cross
// (not counting endpoint-touches, which are handled by the collinear check above).
function segmentsIntersect(p0, p1, p2, p3) {
  const d1x = p1.x - p0.x, d1y = p1.y - p0.y;
  const d2x = p3.x - p2.x, d2y = p3.y - p2.y;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return false; // parallel / collinear
  const dx = p2.x - p0.x, dy = p2.y - p0.y;
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  const eps = 1e-8;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

// Returns true when two room polygons overlap or touch in a way that warrants
// joining them into the same structure. Handles area overlap, T/L-junctions,
// and collinear shared edges. minContactLen guards against snap fuzz.
const ROOM_JOIN_MIN_CONTACT = 8; // world units
function roomsMeaningfullyOverlap(objA, objB) {
  // Fast AABB pre-reject with contact threshold
  const ba = objA.bounds, bb = objB.bounds;
  if (ba && bb) {
    const pad = ROOM_JOIN_MIN_CONTACT * 0.5;
    if (ba.x + ba.width  < bb.x - pad || bb.x + bb.width  < ba.x - pad ||
        ba.y + ba.height < bb.y - pad || bb.y + bb.height < ba.y - pad) return false;
  }

  // Any vertex of A strictly inside B, or vice versa → area overlap
  for (const p of objA.outer) {
    if (_pointInPolygon(p.x, p.y, objB.outer)) return true;
  }
  for (const p of objB.outer) {
    if (_pointInPolygon(p.x, p.y, objA.outer)) return true;
  }

  // Edge-pair checks: strict crossing (T/L junctions) or collinear overlap
  const aCount = getEdgeCount(objA), bCount = getEdgeCount(objB);
  for (let i = 0; i < aCount; i++) {
    const a0 = getEdgeStart(objA, i), a1 = getEdgeEnd(objA, i);
    for (let j = 0; j < bCount; j++) {
      const b0 = getEdgeStart(objB, j), b1 = getEdgeEnd(objB, j);
      if (segmentsIntersect(a0, a1, b0, b1)) return true;
      if (edgesAreCollinearAndOverlap(objA, i, objB, j, ROOM_JOIN_MIN_CONTACT)) return true;
    }
  }
  return false;
}

// Union-Find: group rooms into connected "structure" components.
// Returns Map<roomId, structureRootId>.
function buildStructureGroups(roomObjects) {
  const parent = Object.create(null);
  function find(id) {
    if (parent[id] === undefined) parent[id] = id;
    if (parent[id] !== id) parent[id] = find(parent[id]); // path compression
    return parent[id];
  }
  function union(a, b) { parent[find(a)] = find(b); }

  for (const obj of roomObjects) find(obj.id);
  for (let i = 0; i < roomObjects.length; i++) {
    for (let j = i + 1; j < roomObjects.length; j++) {
      if (roomsMeaningfullyOverlap(roomObjects[i], roomObjects[j])) {
        union(roomObjects[i].id, roomObjects[j].id);
      }
    }
  }
  const groups = new Map();
  for (const obj of roomObjects) groups.set(obj.id, find(obj.id));
  return groups;
}

let _geometryDerivedDirty = true;
let _geometryDerivedCache = null;

function markGeometryDerivedDirty() {
  _geometryDerivedDirty = true;
}

// ─── Segment-level edge helpers ───────────────────────────────────────────────

// Returns t ∈ (0,1) on a0→a1 where b0→b1 crosses it, or null (no interior crossing).
function _segmentIntersectT(a0, a1, b0, b1) {
  const d1x = a1.x - a0.x, d1y = a1.y - a0.y;
  const d2x = b1.x - b0.x, d2y = b1.y - b0.y;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return null;
  const dx = b0.x - a0.x, dy = b0.y - a0.y;
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  const eps = 1e-6;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
  return t;
}

// Projects b0 and b1 onto the line a0→a1 and returns their t-values in (0,1)
// only when both endpoints of b lie within `tolerance` of that line (collinear pair).
function _collinearProjectTs(a0, a1, b0, b1, tolerance) {
  const dx = a1.x - a0.x, dy = a1.y - a0.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return [];
  const len = Math.sqrt(len2);
  const nx = -dy / len, ny = dx / len; // unit normal to a0→a1
  if (Math.abs((b0.x - a0.x) * nx + (b0.y - a0.y) * ny) > tolerance) return [];
  if (Math.abs((b1.x - a0.x) * nx + (b1.y - a0.y) * ny) > tolerance) return [];
  const eps = 1e-6;
  const ts = [];
  const tB0 = ((b0.x - a0.x) * dx + (b0.y - a0.y) * dy) / len2;
  const tB1 = ((b1.x - a0.x) * dx + (b1.y - a0.y) * dy) / len2;
  if (tB0 > eps && tB0 < 1 - eps) ts.push(tB0);
  if (tB1 > eps && tB1 < 1 - eps) ts.push(tB1);
  return ts;
}

// True when (px,py) lies on segment (ax,ay)→(bx,by) within `tolerance` world units.
function _pointOnSegmentTol(px, py, ax, ay, bx, by, tolerance) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-10) return Math.hypot(px - ax, py - ay) <= tolerance;
  const t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < -1e-6 || t > 1 + 1e-6) return false;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) <= tolerance;
}

function _normalizeEdgeSplitTs(values, edgeLength, mergeWorldTol, minSegmentWorld) {
  const safeEdgeLength = Math.max(1e-6, edgeLength);
  const mergeTolT = Math.max(1e-6, mergeWorldTol / safeEdgeLength);
  const minSpanT = Math.max(1e-6, minSegmentWorld / safeEdgeLength);
  const sorted = values
    .map((t) => clamp(Number(t), 0, 1))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  if (!sorted.length) return [0, 1];

  const merged = [];
  for (const t of sorted) {
    if (!merged.length) {
      merged.push(t);
      continue;
    }
    const last = merged[merged.length - 1];
    if (Math.abs(t - last) <= mergeTolT) {
      merged[merged.length - 1] = (last + t) * 0.5;
    } else {
      merged.push(t);
    }
  }

  merged[0] = 0;
  merged[merged.length - 1] = 1;

  const normalized = [0];
  for (let i = 1; i < merged.length - 1; i++) {
    const t = merged[i];
    if (t - normalized[normalized.length - 1] < minSpanT) continue;
    if (1 - t < minSpanT) continue;
    normalized.push(t);
  }
  normalized.push(1);
  return normalized;
}

function _sampleSegmentPoints(a0, a1, t0, t1) {
  const ts = [0.2, 0.5, 0.8].map((f) => t0 + (t1 - t0) * f);
  return ts.map((t) => ({
    t,
    x: a0.x + (a1.x - a0.x) * t,
    y: a0.y + (a1.y - a0.y) * t,
  }));
}

function _polygonSignedArea(polygon) {
  let area2 = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area2 += polygon[j].x * polygon[i].y - polygon[i].x * polygon[j].y;
  }
  return area2 * 0.5;
}

function _samplesCoincidentWithEdge(samples, b0, b1, tolerance) {
  let hits = 0;
  for (const sample of samples) {
    if (_pointOnSegmentTol(sample.x, sample.y, b0.x, b0.y, b1.x, b1.y, tolerance)) hits++;
  }
  return hits;
}

function _segmentSuppressedByEarlierPeer(samples, peers, sortedIdx, roomSortIndex, tolerance) {
  for (const peer of peers) {
    if (sortedIdx.get(peer.id) >= roomSortIndex) continue;
    const peerEdgeCount = getEdgeCount(peer);
    for (let j = 0; j < peerEdgeCount; j++) {
      const b0 = getEdgeStart(peer, j);
      const b1 = getEdgeEnd(peer, j);
      if (_samplesCoincidentWithEdge(samples, b0, b1, tolerance) >= 2) return true;
    }
  }
  return false;
}

function _segmentExteriorSamples(obj, samples, a0, a1, offsetWorld) {
  const dx = a1.x - a0.x;
  const dy = a1.y - a0.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return samples;

  const nx = -dy / len;
  const ny = dx / len;
  let leftInside = 0;
  let rightInside = 0;
  const leftSamples = [];
  const rightSamples = [];

  for (const sample of samples) {
    const left = { x: sample.x + nx * offsetWorld, y: sample.y + ny * offsetWorld };
    const right = { x: sample.x - nx * offsetWorld, y: sample.y - ny * offsetWorld };
    leftSamples.push(left);
    rightSamples.push(right);
    if (_pointInPolygon(left.x, left.y, obj.outer)) leftInside++;
    if (_pointInPolygon(right.x, right.y, obj.outer)) rightInside++;
  }

  if (leftInside > rightInside) return rightSamples;
  if (rightInside > leftInside) return leftSamples;

  // Fall back to polygon winding when near-boundary sampling is ambiguous.
  const signedArea = _polygonSignedArea(obj.outer);
  return signedArea >= 0 ? rightSamples : leftSamples;
}

function _samplesInsideAnyPeer(samples, peers) {
  let hits = 0;
  for (const sample of samples) {
    for (const peer of peers) {
      if (_pointInPolygon(sample.x, sample.y, peer.outer)) {
        hits++;
        break;
      }
    }
  }
  return hits;
}

function _collectEdgeSplitTs(obj, edgeIndex, peers, collinearTolerance) {
  const a0 = getEdgeStart(obj, edgeIndex);
  const a1 = getEdgeEnd(obj, edgeIndex);
  const splitTs = [0, 1];

  for (const peer of peers) {
    const peerEdgeCount = getEdgeCount(peer);
    for (let j = 0; j < peerEdgeCount; j++) {
      const b0 = getEdgeStart(peer, j);
      const b1 = getEdgeEnd(peer, j);

      const tInt = _segmentIntersectT(a0, a1, b0, b1);
      if (tInt !== null) splitTs.push(tInt);

      for (const t of _collinearProjectTs(a0, a1, b0, b1, collinearTolerance)) {
        splitTs.push(t);
      }
    }

    const adx = a1.x - a0.x;
    const ady = a1.y - a0.y;
    const alen2 = adx * adx + ady * ady;
    if (alen2 <= 1e-10) continue;
    for (const p of peer.outer) {
      const t = ((p.x - a0.x) * adx + (p.y - a0.y) * ady) / alen2;
      if (t <= 1e-6 || t >= 1 - 1e-6) continue;
      const fx = a0.x + t * adx;
      const fy = a0.y + t * ady;
      if (Math.hypot(p.x - fx, p.y - fy) <= collinearTolerance) splitTs.push(t);
    }
  }

  return splitTs;
}

function _classifyEdgeSubSegment(obj, peers, sortedIdx, roomSortIndex, a0, a1, t0, t1, opts) {
  const samples = _sampleSegmentPoints(a0, a1, t0, t1);
  if (_segmentSuppressedByEarlierPeer(samples, peers, sortedIdx, roomSortIndex, opts.suppressTolerance)) {
    return "suppressed";
  }

  const exteriorSamples = _segmentExteriorSamples(obj, samples, a0, a1, opts.classifyOffsetWorld);
  if (_samplesInsideAnyPeer(exteriorSamples, peers) >= 2) return "seam";

  const midT = (t0 + t1) * 0.5;
  const mid = { x: a0.x + (a1.x - a0.x) * midT, y: a0.y + (a1.y - a0.y) * midT };
  for (const peer of peers) {
    if (_pointInPolygon(mid.x, mid.y, peer.outer)) return "seam";
  }

  return "exterior";
}

// Classify every room edge at sub-segment resolution.
// Returns Map<"objId:edgeIdx", { splitTs, segments }> where role is
// "exterior" | "seam" | "suppressed".
// sortedRoomObjects must be sorted by ascending zIndex (that order is also the
// suppression priority: lower-index edges suppress coincident higher-index edges).
function classifyRoomEdgesSegmented(sortedRoomObjects, structureGroups) {
  const result = new Map();
  const COLLINEAR_TOL = 4;   // world units — same line test
  const SUPPRESS_TOL  = 6;   // world units — midpoint-on-edge suppression test
  const SPLIT_MERGE_TOL = 1.25; // world units — merge nearly identical split events
  const MIN_SEGMENT_LEN = 2.0;  // world units — drop noisy sliver segments
  const CLASSIFY_OFFSET = 3.0;  // world units — test the "outside" side of a boundary
  const n = sortedRoomObjects.length;

  // Build a sorted-position index for suppression tiebreaking
  const sortedIdx = new Map();
  for (let i = 0; i < n; i++) sortedIdx.set(sortedRoomObjects[i].id, i);

  for (let ri = 0; ri < n; ri++) {
    const obj = sortedRoomObjects[ri];
    const edgeCount = getEdgeCount(obj);
    const myRoot = structureGroups.get(obj.id);

    const peers = sortedRoomObjects.filter(
      o => o.id !== obj.id && structureGroups.get(o.id) === myRoot
    );

    for (let i = 0; i < edgeCount; i++) {
      const key = `${obj.id}:${i}`;
      const a0 = getEdgeStart(obj, i);
      const a1 = getEdgeEnd(obj, i);

      if (peers.length === 0) {
        result.set(key, { splitTs: [0, 1], segments: [{ t0: 0, t1: 1, role: "exterior" }] });
        continue;
      }

      const edgeLength = Math.hypot(a1.x - a0.x, a1.y - a0.y);
      const rawSplitTs = _collectEdgeSplitTs(obj, i, peers, COLLINEAR_TOL);
      const sortedTs = _normalizeEdgeSplitTs(rawSplitTs, edgeLength, SPLIT_MERGE_TOL, MIN_SEGMENT_LEN);

      // ── Classify each sub-segment ──────────────────────────────────────────
      const segments = [];
      for (let k = 0; k + 1 < sortedTs.length; k++) {
        const t0 = sortedTs[k], t1 = sortedTs[k + 1];
        if (t1 - t0 < 1e-6) continue;
        const role = _classifyEdgeSubSegment(obj, peers, sortedIdx, ri, a0, a1, t0, t1, {
          suppressTolerance: SUPPRESS_TOL,
          classifyOffsetWorld: Math.min(CLASSIFY_OFFSET, Math.max(1.5, edgeLength * 0.25)),
        });
        segments.push({ t0, t1, role });
      }

      result.set(key, {
        splitTs: sortedTs,
        segments: segments.length > 0 ? segments : [{ t0: 0, t1: 1, role: "exterior" }],
      });
    }
  }

  return result;
}

function _makeRegressionRoom(id, x, y, w, h, zIndex) {
  return {
    id,
    type: "geometry",
    kind: GEOMETRY_KIND.ROOM,
    closed: true,
    visible: true,
    zIndex: zIndex || 0,
    outer: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    bounds: { x, y, width: w, height: h },
  };
}

function _segmentRoles(edgeInfo) {
  return (edgeInfo && edgeInfo.segments) ? edgeInfo.segments.map((segment) => segment.role) : [];
}

function runRoomBoundarySegmentationRegressionFixtures() {
  const fixtures = [
    {
      name: "partial-overlap",
      rooms: [
        _makeRegressionRoom("a", 0, 0, 120, 120, 0),
        _makeRegressionRoom("b", 60, 20, 80, 80, 1),
      ],
      assert(classified) {
        const roles = _segmentRoles(classified.get("a:1"));
        if (!roles.includes("seam") || !roles.includes("exterior")) {
          throw new Error("expected mixed seam/exterior roles on partial overlap edge");
        }
      },
    },
    {
      name: "offset-t-junction",
      rooms: [
        _makeRegressionRoom("a", 0, 0, 160, 120, 0),
        _makeRegressionRoom("b", 60, -60, 40, 60, 1),
      ],
      assert(classified) {
        const splitCount = (classified.get("a:0")?.splitTs || []).length;
        if (splitCount < 3) throw new Error("expected T-junction to create a split on the host edge");
      },
    },
    {
      name: "contained-room",
      rooms: [
        _makeRegressionRoom("a", 0, 0, 180, 180, 0),
        _makeRegressionRoom("b", 50, 50, 60, 60, 1),
      ],
      assert(classified) {
        for (let edgeIndex = 0; edgeIndex < 4; edgeIndex++) {
          const roles = _segmentRoles(classified.get(`b:${edgeIndex}`));
          if (!roles.length || roles.some((role) => role !== "seam")) {
            throw new Error("expected contained room edges to resolve entirely as seams");
          }
        }
      },
    },
    {
      name: "corridor-join",
      rooms: [
        _makeRegressionRoom("a", 0, 0, 120, 120, 0),
        _makeRegressionRoom("b", 40, 120, 40, 100, 1),
      ],
      assert(classified) {
        const roles = _segmentRoles(classified.get("a:2"));
        if (!roles.includes("seam") || !roles.includes("exterior")) {
          throw new Error("expected corridor join to split the shared wall into seam and exterior spans");
        }
      },
    },
    {
      name: "multi-room-junction",
      rooms: [
        _makeRegressionRoom("a", 0, 0, 100, 100, 0),
        _makeRegressionRoom("b", 100, 20, 80, 60, 1),
        _makeRegressionRoom("c", 40, 100, 20, 80, 2),
      ],
      assert(classified) {
        const rightEdgeSplits = (classified.get("a:1")?.splitTs || []).length;
        const bottomEdgeSplits = (classified.get("a:2")?.splitTs || []).length;
        if (rightEdgeSplits < 3 || bottomEdgeSplits < 3) {
          throw new Error("expected multi-room junction to preserve multiple split events");
        }
      },
    },
  ];

  const results = [];
  for (const fixture of fixtures) {
    const sorted = [...fixture.rooms].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
    const groups = buildStructureGroups(sorted);
    const classified = classifyRoomEdgesSegmented(sorted, groups);
    fixture.assert(classified);
    results.push({ name: fixture.name, ok: true });
  }
  return results;
}

function _formatSeamCoord(value) {
  return Number(value.toFixed(3)).toString();
}

function _canonicalSegmentEndpointKey(p0, p1) {
  const a = `${_formatSeamCoord(p0.x)},${_formatSeamCoord(p0.y)}`;
  const b = `${_formatSeamCoord(p1.x)},${_formatSeamCoord(p1.y)}`;
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

function _segmentCoincidentPeerIds(samples, peers, tolerance) {
  const ids = [];
  for (const peer of peers) {
    const peerEdgeCount = getEdgeCount(peer);
    for (let j = 0; j < peerEdgeCount; j++) {
      const b0 = getEdgeStart(peer, j);
      const b1 = getEdgeEnd(peer, j);
      if (_samplesCoincidentWithEdge(samples, b0, b1, tolerance) >= 2) {
        ids.push(peer.id);
        break;
      }
    }
  }
  return ids;
}

function _segmentContainingPeerIds(exteriorSamples, peers) {
  const ids = [];
  for (const peer of peers) {
    let hits = 0;
    for (const sample of exteriorSamples) {
      if (_pointInPolygon(sample.x, sample.y, peer.outer)) hits++;
    }
    if (hits >= 2) ids.push(peer.id);
  }
  return ids;
}

function _makeStableSeamKey(obj, edgeIndex, a0, a1, t0, t1, peers, options) {
  const samples = _sampleSegmentPoints(a0, a1, t0, t1);
  const exteriorSamples = _segmentExteriorSamples(obj, samples, a0, a1, options.classifyOffsetWorld);
  const participantIds = new Set([obj.id]);
  for (const id of _segmentCoincidentPeerIds(samples, peers, options.suppressTolerance)) participantIds.add(id);
  for (const id of _segmentContainingPeerIds(exteriorSamples, peers)) participantIds.add(id);

  const p0 = pointAlongEdge(obj, edgeIndex, t0);
  const p1 = pointAlongEdge(obj, edgeIndex, t1);
  return `seam|${[...participantIds].sort().join(",")}|${_canonicalSegmentEndpointKey(p0, p1)}`;
}

function getResolvedGeometryStructures() {
  if (!_geometryDerivedDirty && _geometryDerivedCache) return _geometryDerivedCache;

  _geometryDerivedDirty = false;
  const roomsSorted = getSortedGeometryObjects().filter((obj) => obj.kind === GEOMETRY_KIND.ROOM);
  const groups = roomsSorted.length > 1 ? buildStructureGroups(roomsSorted) : new Map(roomsSorted.map((obj) => [obj.id, obj.id]));
  const rawEdgeClasses = roomsSorted.length > 1 ? classifyRoomEdgesSegmented(roomsSorted, groups) : new Map();
  const edgeClasses = new Map();
  const seamSegments = [];

  for (const obj of roomsSorted) {
    const myRoot = groups.get(obj.id);
    const peers = roomsSorted.filter((other) => other.id !== obj.id && groups.get(other.id) === myRoot);
    const edgeCount = getEdgeCount(obj);
    for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex++) {
      const key = `${obj.id}:${edgeIndex}`;
      const rawEdgeInfo = rawEdgeClasses.get(key) || { splitTs: [0, 1], segments: [{ t0: 0, t1: 1, role: "exterior" }] };
      const a0 = getEdgeStart(obj, edgeIndex);
      const a1 = getEdgeEnd(obj, edgeIndex);
      const edgeLength = Math.hypot(a1.x - a0.x, a1.y - a0.y);
      const segments = rawEdgeInfo.segments.map((segment) => {
        const next = { ...segment, renderRole: segment.role, seamKey: null, seamMode: null };
        if (segment.role === "seam") {
          const seamKey = _makeStableSeamKey(obj, edgeIndex, a0, a1, segment.t0, segment.t1, peers, {
            suppressTolerance: 6,
            classifyOffsetWorld: Math.min(3.0, Math.max(1.5, edgeLength * 0.25)),
          });
          const override = state.geometry_seams.get(seamKey);
          next.seamKey = seamKey;
          next.seamMode = override?.mode || GEOMETRY_SEAM_MODE.CLOSED;
          if (next.seamMode === GEOMETRY_SEAM_MODE.OPEN) next.renderRole = "open";
          else if (next.seamMode === GEOMETRY_SEAM_MODE.WALL) next.renderRole = "wall";
          else next.renderRole = "seam";
          seamSegments.push({
            seamKey,
            mode: next.seamMode,
            objId: obj.id,
            edgeIndex,
            t0: segment.t0,
            t1: segment.t1,
            start: pointAlongEdge(obj, edgeIndex, segment.t0),
            end: pointAlongEdge(obj, edgeIndex, segment.t1),
          });
        } else if (segment.role === "suppressed") {
          const seamKey = _makeStableSeamKey(obj, edgeIndex, a0, a1, segment.t0, segment.t1, peers, {
            suppressTolerance: 6,
            classifyOffsetWorld: Math.min(3.0, Math.max(1.5, edgeLength * 0.25)),
          });
          const override = state.geometry_seams.get(seamKey);
          if (override?.mode === GEOMETRY_SEAM_MODE.WALL) {
            next.seamKey = seamKey;
            next.seamMode = override.mode;
            next.renderRole = "wall";
          }
        }
        return next;
      });
      edgeClasses.set(key, { splitTs: rawEdgeInfo.splitTs, segments });
    }
  }

  _geometryDerivedCache = { roomsSorted, groups, edgeClasses, seamSegments };
  return _geometryDerivedCache;
}

function getGeometryEdgeResolvedSegment(geometryId, edgeIndex, t) {
  const edgeInfo = getResolvedGeometryStructures().edgeClasses.get(`${geometryId}:${edgeIndex}`);
  if (!edgeInfo || !edgeInfo.segments) return null;
  const targetT = clamp(Number(t), 0, 1);
  for (const segment of edgeInfo.segments) {
    if (targetT + 1e-6 >= segment.t0 && targetT - 1e-6 <= segment.t1) return segment;
  }
  return null;
}

function hitTestGeometrySeam(worldX, worldY, options = {}) {
  const resolved = getResolvedGeometryStructures();
  const tolerance = options.tolerance != null ? options.tolerance : Math.max(14, 18 / (cam?.z || 1));
  let best = null;

  for (const seam of resolved.seamSegments) {
    const proj = projectPointToSegment(worldX, worldY, seam.start.x, seam.start.y, seam.end.x, seam.end.y);
    if (proj.distance > tolerance) continue;
    const length = Math.hypot(seam.end.x - seam.start.x, seam.end.y - seam.start.y);
    if (
      !best ||
      proj.distance < best.distance ||
      (proj.distance === best.distance && length < best.length) ||
      (proj.distance === best.distance && length === best.length && seam.seamKey < best.seamKey)
    ) {
      best = { ...seam, distance: proj.distance, length, point: { x: proj.x, y: proj.y }, t: proj.t };
    }
  }

  return best;
}

// Returns the id of the topmost visible geometry object at (wx, wy),
// matching the object the user sees on top (reverse of render order).
function hitTestGeometryObjects(wx, wy) {
  if (!state.geometry) return null;
  const objs = getSortedGeometryObjects({ reverse: true });
  for (const obj of objs) {
    if (geometryContainsPoint(obj, wx, wy)) return obj.id;
  }
  return null;
}
