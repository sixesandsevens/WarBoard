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
