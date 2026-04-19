"use strict";

// ─── Top-level draw call ──────────────────────────────────────────────────────

// pass = "under": objects with zIndex < 0 (drawn before interiors)
// pass = "over":  objects with zIndex >= 0 (drawn after interiors, default)
function drawGeometry(pass) {
  if (!state.geometry || !state.geometry.size) return;
  const under = pass === "under";
  for (const obj of getSortedGeometryObjects()) {
    const z = Number(obj.zIndex || 0);
    if (under ? z >= 0 : z < 0) continue;
    drawGeometryObject(obj);
  }
}

// ─── Per-object rendering ─────────────────────────────────────────────────────

function drawGeometryObject(obj) {
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

  // 2 — Edges
  _renderGeometryEdges(obj, polygon, edgeCount, style, openingMask);

  // 3 — Opening overlays
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

function _renderGeometryEdges(obj, polygon, edgeCount, style, openingMask) {
  const edges = obj.edges || buildDefaultEdges(obj);
  const baseThickness = Math.max(1, (style.edgeThickness || 2) * cam.z);
  const baseRenderMode = style.edgeDefaultRenderMode || EDGE_RENDER_MODE.CLEAN_STROKE;

  for (let i = 0; i < edgeCount; i++) {
    const edge = edges[i] || { index: i, role: style.edgeDefaultRole || EDGE_ROLE.WALL, renderMode: baseRenderMode };
    if (edge.role === EDGE_ROLE.OPEN) continue;
    const mode = edge.renderMode || baseRenderMode;
    if (mode === EDGE_RENDER_MODE.HIDDEN) continue;

    const gaps = openingMask[i] || [];
    const thickness = edge.thickness ? Math.max(1, edge.thickness * cam.z) : baseThickness;
    _drawEdgeSegmentWithGaps(obj, i, edge, polygon, gaps, style, thickness);
  }
}

function _edgeStrokeColor(obj, edge) {
  const role = edge.role || EDGE_ROLE.WALL;
  if (role === EDGE_ROLE.BOUNDARY || obj.kind === GEOMETRY_KIND.CAVE) return "#4a3a28";
  return "#3d2a14";
}

function _drawEdgeSegmentWithGaps(obj, edgeIndex, edge, polygon, gaps, style, thickness) {
  const n = obj.outer.length;
  const p0 = polygon[edgeIndex];
  const p1 = polygon[(edgeIndex + 1) % n];

  ctx.strokeStyle = _edgeStrokeColor(obj, edge);
  ctx.lineWidth = thickness;
  ctx.lineCap = "square";
  ctx.lineJoin = "miter";
  ctx.setLineDash([]);

  if (!gaps.length) {
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
    return;
  }

  // Draw wall segments around openings
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
    ctx.strokeStyle = "rgba(140, 100, 60, 0.9)";
    ctx.lineWidth = Math.max(1, cam.z);
    // Door slab
    ctx.beginPath();
    ctx.moveTo(-spanLen / 2, 0);
    ctx.lineTo(spanLen / 2, 0);
    ctx.stroke();
    // Swing arc
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
