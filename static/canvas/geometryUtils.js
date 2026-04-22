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

// Classify every room edge at sub-segment resolution.
// Returns Map<"objId:edgeIdx", Array<{t0, t1, role}>> where role is
// "exterior" | "seam" | "suppressed".
// sortedRoomObjects must be sorted by ascending zIndex (that order is also the
// suppression priority: lower-index edges suppress coincident higher-index edges).
function classifyRoomEdgesSegmented(sortedRoomObjects, structureGroups) {
  const result = new Map();
  const COLLINEAR_TOL = 4;   // world units — same line test
  const SUPPRESS_TOL  = 6;   // world units — midpoint-on-edge suppression test
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
        result.set(key, [{ t0: 0, t1: 1, role: "exterior" }]);
        continue;
      }

      // ── Collect split t-values from peer geometry ──────────────────────────
      const splitTs = new Set([0, 1]);

      for (const peer of peers) {
        const peerEdgeCount = getEdgeCount(peer);
        for (let j = 0; j < peerEdgeCount; j++) {
          const b0 = getEdgeStart(peer, j);
          const b1 = getEdgeEnd(peer, j);

          // Strict edge-edge crossing (T/L junctions)
          const tInt = _segmentIntersectT(a0, a1, b0, b1);
          if (tInt !== null) splitTs.add(tInt);

          // Collinear overlap boundaries
          for (const t of _collinearProjectTs(a0, a1, b0, b1, COLLINEAR_TOL)) {
            splitTs.add(t);
          }
        }

        // Peer corners that land (nearly) on our edge — catches touching T tips
        const adx = a1.x - a0.x, ady = a1.y - a0.y;
        const alen2 = adx * adx + ady * ady;
        if (alen2 > 1e-10) {
          for (const p of peer.outer) {
            const t = ((p.x - a0.x) * adx + (p.y - a0.y) * ady) / alen2;
            if (t <= 1e-6 || t >= 1 - 1e-6) continue;
            const fx = a0.x + t * adx, fy = a0.y + t * ady;
            if (Math.hypot(p.x - fx, p.y - fy) <= COLLINEAR_TOL) splitTs.add(t);
          }
        }
      }

      const sortedTs = [...splitTs].sort((a, b) => a - b);

      // ── Classify each sub-segment ──────────────────────────────────────────
      const segments = [];
      for (let k = 0; k + 1 < sortedTs.length; k++) {
        const t0 = sortedTs[k], t1 = sortedTs[k + 1];
        if (t1 - t0 < 1e-6) continue;

        const midT = (t0 + t1) / 2;
        const mid = { x: a0.x + (a1.x - a0.x) * midT, y: a0.y + (a1.y - a0.y) * midT };

        let role = "exterior";

        // Suppressed: midpoint lies on a lower-sorted-index peer's edge
        outer: for (const peer of peers) {
          if (sortedIdx.get(peer.id) >= ri) continue; // only earlier (lower-z) peers suppress
          const peerEdgeCount = getEdgeCount(peer);
          for (let j = 0; j < peerEdgeCount; j++) {
            const b0 = getEdgeStart(peer, j);
            const b1 = getEdgeEnd(peer, j);
            if (_pointOnSegmentTol(mid.x, mid.y, b0.x, b0.y, b1.x, b1.y, SUPPRESS_TOL)) {
              role = "suppressed";
              break outer;
            }
          }
        }

        // Seam: midpoint is inside another room in the same structure
        if (role === "exterior") {
          for (const peer of peers) {
            if (_pointInPolygon(mid.x, mid.y, peer.outer)) {
              role = "seam";
              break;
            }
          }
        }

        segments.push({ t0, t1, role });
      }

      result.set(key, segments.length > 0 ? segments : [{ t0: 0, t1: 1, role: "exterior" }]);
    }
  }

  return result;
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
