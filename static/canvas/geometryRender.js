"use strict";

// ─── Top-level draw call ──────────────────────────────────────────────────────

// pass = "under": objects with zIndex < 0 (drawn before interiors)
// pass = "over":  objects with zIndex >= 0 (drawn after interiors, default)
function drawGeometry(pass) {
  if (!state.geometry || !state.geometry.size) return;
  const under = pass === "under";
  const sorted = getSortedGeometryObjects(); // ascending zIndex — also the correct input order for classifyRoomEdges
  const roomsSorted = sorted.filter(o => o.kind === GEOMETRY_KIND.ROOM);

  let edgeClasses = null;
  if (roomsSorted.length > 1) {
    const groups = buildStructureGroups(roomsSorted);
    edgeClasses = classifyRoomEdgesSegmented(roomsSorted, groups);
  }

  for (const obj of sorted) {
    const z = Number(obj.zIndex || 0);
    if (under ? z >= 0 : z < 0) continue;
    drawGeometryObject(obj, edgeClasses);
  }
}

// ─── Per-object rendering ─────────────────────────────────────────────────────

function drawGeometryObject(obj, edgeClasses) {
  if (!obj.outer || obj.outer.length < 2) return;
  const style = obj.style || {};

  // Project outer polygon into screen space
  const polygon = obj.outer.map((p) => worldToScreen(p.x, p.y));
  const edgeCount = getEdgeCount(obj);

  // Build opening mask keyed by edgeIndex
  const openingMask = {};
  for (const op of (obj.openings || [])) {
    if (!openingMask[op.edgeIndex]) openingMask[op.edgeIndex] = [];
    openingMask[op.edgeIndex].push({ t0: op.t0, t1: op.t1 });
  }

  ctx.save();

  // 1 — Fill
  if (obj.closed && obj.outer.length >= 3 && style.fillMode !== "none") {
    _renderGeometryFill(obj, polygon, style);
  }

  // 2 — Edges: exterior walls, seams, and suppressed duplicates
  _renderGeometryEdges(obj, polygon, edgeCount, style, openingMask, edgeClasses);

  // 3 — Opening overlays (always rendered regardless of edge classification)
  for (const op of (obj.openings || [])) {
    _renderOpeningOverlay(obj, op);
  }

  ctx.restore();
}

// ─── Fill ─────────────────────────────────────────────────────────────────────

function _renderGeometryFill(obj, polygon, style) {
  ctx.save();

  ctx.beginPath();
  ctx.moveTo(polygon[0].x, polygon[0].y);
  for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i].x, polygon[i].y);
  ctx.closePath();

  ctx.fillStyle = style.fillColor || "#b99d79";
  ctx.fill();

  // Decorative floor pattern for room and cave kinds
  if (obj.kind === GEOMETRY_KIND.ROOM) {
    _drawPolygonPlankPattern(polygon, style);
  } else if (obj.kind === GEOMETRY_KIND.CAVE) {
    _drawPolygonCavePattern(polygon, style);
  }

  ctx.restore();
}

function _drawPolygonPlankPattern(polygon, style) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(polygon[0].x, polygon[0].y);
  for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i].x, polygon[i].y);
  ctx.closePath();
  ctx.clip();

  ctx.strokeStyle = "rgba(90, 60, 32, 0.16)";
  ctx.lineWidth = 1;
  const step = Math.max(8, ui.gridSize * cam.z * 0.2);
  for (let y = minY + step; y < maxY; y += step) {
    ctx.beginPath();
    ctx.moveTo(minX, y);
    ctx.lineTo(maxX, y);
    ctx.stroke();
  }
  ctx.restore();
}

function _drawPolygonCavePattern(polygon, style) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(polygon[0].x, polygon[0].y);
  for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i].x, polygon[i].y);
  ctx.closePath();
  ctx.clip();

  // Subtle stipple-like cross-hatch for cave floors
  ctx.strokeStyle = "rgba(60, 44, 24, 0.12)";
  ctx.lineWidth = 1;
  const step = Math.max(12, ui.gridSize * cam.z * 0.28);
  for (let y = minY + step; y < maxY; y += step) {
    ctx.beginPath();
    ctx.moveTo(minX, y);
    ctx.lineTo(maxX, y);
    ctx.stroke();
  }
  for (let x = minX + step; x < maxX; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, minY);
    ctx.lineTo(x, maxY);
    ctx.stroke();
  }
  ctx.restore();
}

// ─── Edge strokes ─────────────────────────────────────────────────────────────

function _renderGeometryEdges(obj, polygon, edgeCount, style, openingMask, edgeClasses) {
  const edges = obj.edges || buildDefaultEdges(obj);
  const baseThickness = Math.max(1, (style.edgeThickness || 2) * cam.z);
  const baseRenderMode = style.edgeDefaultRenderMode || EDGE_RENDER_MODE.CLEAN_STROKE;

  for (let i = 0; i < edgeCount; i++) {
    const edge = edges[i] || { index: i, role: style.edgeDefaultRole || EDGE_ROLE.WALL, renderMode: baseRenderMode };
    if (edge.role === EDGE_ROLE.OPEN) continue;
    const mode = edge.renderMode || baseRenderMode;
    if (mode === EDGE_RENDER_MODE.HIDDEN) continue;

    const key = `${obj.id}:${i}`;
    const allGaps = openingMask[i] || [];
    const thickness = edge.thickness ? Math.max(1, edge.thickness * cam.z) : baseThickness;

    // Segment-based rendering for rooms in a joined structure
    const segments = edgeClasses ? edgeClasses.get(key) : null;
    if (segments) {
      for (const seg of segments) {
        if (seg.role === "suppressed") continue;
        _drawEdgeSubSegment(obj, i, edge, polygon, allGaps, style, thickness, seg.t0, seg.t1, seg.role === "seam");
      }
    } else {
      // Full-edge rendering for caves, wall-paths, and standalone rooms
      _drawEdgeSegmentWithGaps(obj, i, edge, polygon, allGaps, style, thickness, false);
    }
  }
}

function _edgeStrokeColor(obj, edge) {
  const role = edge.role || EDGE_ROLE.WALL;
  if (role === EDGE_ROLE.BOUNDARY || obj.kind === GEOMETRY_KIND.CAVE) return "#4a3a28";
  return "#3d2a14";
}

// Stroke p0→p1 skipping the gap ranges (each gap: { t0, t1 } in [0,1]).
function _strokeSegmentWithGaps(p0, p1, gaps) {
  if (!gaps.length) {
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
    return;
  }
  const sorted = [...gaps].sort((a, b) => a.t0 - b.t0);
  let cursor = 0;
  for (const gap of sorted) {
    if (gap.t0 > cursor) {
      const from = _lerpScreen(p0, p1, cursor);
      const to = _lerpScreen(p0, p1, gap.t0);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    cursor = gap.t1;
  }
  if (cursor < 1) {
    const from = _lerpScreen(p0, p1, cursor);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
}

// Draw a sub-segment [t0, t1] of source edge edgeIndex, clipping openings to that span.
function _drawEdgeSubSegment(obj, edgeIndex, edge, polygon, allGaps, style, thickness, t0, t1, isSeam) {
  const n = obj.outer.length;
  const pfull0 = polygon[edgeIndex];
  const pfull1 = polygon[(edgeIndex + 1) % n];

  const p0 = _lerpScreen(pfull0, pfull1, t0);
  const p1 = _lerpScreen(pfull0, pfull1, t1);

  // Clip openings to [t0, t1] and re-normalize to [0, 1] of this sub-segment
  const segLen = t1 - t0;
  const gaps = [];
  for (const gap of allGaps) {
    const gStart = Math.max(gap.t0, t0);
    const gEnd   = Math.min(gap.t1, t1);
    if (gEnd <= gStart + 1e-6) continue;
    gaps.push({ t0: (gStart - t0) / segLen, t1: (gEnd - t0) / segLen });
  }

  ctx.lineCap = "square";
  ctx.lineJoin = "miter";

  if (isSeam) {
    const dash = Math.max(4, cam.z * 7);
    const gap  = Math.max(3, cam.z * 4);
    ctx.setLineDash([dash, gap]);
    ctx.strokeStyle = "rgba(80, 52, 24, 0.50)";
    ctx.lineWidth = Math.max(1, cam.z * 1.5);
    _strokeSegmentWithGaps(p0, p1, gaps);
    ctx.setLineDash([]);
  } else if (obj.kind === GEOMETRY_KIND.ROOM) {
    ctx.setLineDash([]);
    ctx.strokeStyle = "#1a0d05";
    ctx.lineWidth = thickness * 2.2;
    _strokeSegmentWithGaps(p0, p1, gaps);
    ctx.strokeStyle = "#3d2a14";
    ctx.lineWidth = thickness;
    _strokeSegmentWithGaps(p0, p1, gaps);
  } else {
    ctx.setLineDash([]);
    ctx.strokeStyle = _edgeStrokeColor(obj, edge);
    ctx.lineWidth = thickness;
    _strokeSegmentWithGaps(p0, p1, gaps);
  }
}

function _drawEdgeSegmentWithGaps(obj, edgeIndex, edge, polygon, gaps, style, thickness, isSeam) {
  const n = obj.outer.length;
  const p0 = polygon[edgeIndex];
  const p1 = polygon[(edgeIndex + 1) % n];

  ctx.lineCap = "square";
  ctx.lineJoin = "miter";

  if (isSeam) {
    // Interior seam — thin dashed line showing the room boundary within the joined structure.
    // Dashes scale with zoom so they stay readable but never overpower the exterior walls.
    const dash = Math.max(4, cam.z * 7);
    const gap  = Math.max(3, cam.z * 4);
    ctx.setLineDash([dash, gap]);
    ctx.strokeStyle = "rgba(80, 52, 24, 0.50)";
    ctx.lineWidth = Math.max(1, cam.z * 1.5);
    _strokeSegmentWithGaps(p0, p1, gaps);
    ctx.setLineDash([]);
  } else if (obj.kind === GEOMETRY_KIND.ROOM) {
    // Exterior wall — dual-pass for wall mass + crisp definition
    ctx.setLineDash([]);
    ctx.strokeStyle = "#1a0d05";
    ctx.lineWidth = thickness * 2.2;
    _strokeSegmentWithGaps(p0, p1, gaps);
    ctx.strokeStyle = "#3d2a14";
    ctx.lineWidth = thickness;
    _strokeSegmentWithGaps(p0, p1, gaps);
  } else {
    ctx.setLineDash([]);
    ctx.strokeStyle = _edgeStrokeColor(obj, edge);
    ctx.lineWidth = thickness;
    _strokeSegmentWithGaps(p0, p1, gaps);
  }
}

function _lerpScreen(p0, p1, t) {
  return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
}

// ─── Opening overlays ─────────────────────────────────────────────────────────

function _renderOpeningOverlay(obj, opening) {
  if (opening.kind === OPENING_KIND.GAP) return;

  const span = openingWorldSpan(obj, opening);
  const center = openingCenterPoint(obj, opening);
  const rot = openingRotationRadians(obj, opening);
  const cs = worldToScreen(center.x, center.y);
  const ss = worldToScreen(span.start.x, span.start.y);
  const se = worldToScreen(span.end.x, span.end.y);
  const spanLen = Math.hypot(se.x - ss.x, se.y - ss.y);
  if (spanLen < 4) return;

  ctx.save();
  ctx.translate(cs.x, cs.y);
  ctx.rotate(rot);
  ctx.setLineDash([]);

  if (opening.kind === OPENING_KIND.DOOR) {
    // Hinge pivot dot at the pivot end of the slab
    const hingeR = Math.max(2.5, cam.z * 2.5);
    ctx.fillStyle = "rgba(70, 40, 10, 0.95)";
    ctx.beginPath();
    ctx.arc(spanLen / 2, 0, hingeR, 0, Math.PI * 2);
    ctx.fill();
    // Door slab
    ctx.strokeStyle = "rgba(80, 48, 14, 0.95)";
    ctx.lineWidth = Math.max(2, cam.z * 2.5);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-spanLen / 2, 0);
    ctx.lineTo(spanLen / 2, 0);
    ctx.stroke();
    // Swing arc — lighter so it reads as the sweep path, not a second wall
    ctx.strokeStyle = "rgba(100, 65, 20, 0.55)";
    ctx.lineWidth = Math.max(1.5, cam.z * 1.5);
    ctx.beginPath();
    ctx.arc(spanLen / 2, 0, spanLen, Math.PI * 0.5, Math.PI);
    ctx.stroke();
  } else if (opening.kind === OPENING_KIND.WINDOW) {
    ctx.strokeStyle = "rgba(160, 200, 240, 0.85)";
    ctx.lineWidth = Math.max(1, cam.z * 1.5);
    ctx.beginPath();
    ctx.moveTo(-spanLen / 2, 0);
    ctx.lineTo(spanLen / 2, 0);
    ctx.stroke();
    // Sill ticks
    const tick = Math.max(2, cam.z * 3);
    ctx.lineWidth = Math.max(1, cam.z);
    ctx.beginPath();
    ctx.moveTo(-spanLen / 2, -tick);
    ctx.lineTo(-spanLen / 2, tick);
    ctx.moveTo(spanLen / 2, -tick);
    ctx.lineTo(spanLen / 2, tick);
    ctx.stroke();
  } else if (opening.kind === OPENING_KIND.ARCH) {
    ctx.strokeStyle = "rgba(160, 140, 100, 0.85)";
    ctx.lineWidth = Math.max(1, cam.z);
    ctx.beginPath();
    ctx.arc(0, 0, spanLen / 2, Math.PI, 0, false);
    ctx.stroke();
  }

  ctx.restore();
}

// ─── Door tool hover feedback ─────────────────────────────────────────────────

// Highlights the opening the Door tool is hovering so the GM can see that
// clicking will remove it rather than add a new one.
function drawGeometryOpeningHoverFeedback() {
  if (!hoveredGeometryOpeningInfo) return;
  const { geometryId, openingId } = hoveredGeometryOpeningInfo;
  const obj = state.geometry && state.geometry.get(geometryId);
  if (!obj) return;
  const op = (obj.openings || []).find(o => o.id === openingId);
  if (!op) return;

  const span = openingWorldSpan(obj, op);
  const center = openingCenterPoint(obj, op);
  const rot = openingRotationRadians(obj, op);
  const cs = worldToScreen(center.x, center.y);
  const ss = worldToScreen(span.start.x, span.start.y);
  const se = worldToScreen(span.end.x, span.end.y);
  const spanLen = Math.hypot(se.x - ss.x, se.y - ss.y);
  if (spanLen < 4) return;

  ctx.save();
  ctx.translate(cs.x, cs.y);
  ctx.rotate(rot);
  ctx.setLineDash([]);

  // Bright highlight over the opening span
  ctx.strokeStyle = "rgba(220, 60, 40, 0.85)";
  ctx.lineWidth = Math.max(3, cam.z * 3.5);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-spanLen / 2, 0);
  ctx.lineTo(spanLen / 2, 0);
  ctx.stroke();

  // Small × at the center to signal "remove"
  const cx = Math.max(4, cam.z * 5);
  ctx.lineWidth = Math.max(1.5, cam.z * 1.5);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.beginPath();
  ctx.moveTo(-cx, -cx); ctx.lineTo(cx, cx);
  ctx.moveTo(cx, -cx);  ctx.lineTo(-cx, cx);
  ctx.stroke();

  ctx.restore();
}
