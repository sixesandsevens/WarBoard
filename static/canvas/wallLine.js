"use strict";

// ─── Tunables ─────────────────────────────────────────────────────────────────
const WALL_LINE_CLOSE_DISTANCE = 16;  // world-units; tune to grid scale

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _wlSnapPoint(v) {
  return ui.snap ? Math.round(v / ui.gridSize) * ui.gridSize : v;
}

function _wlDistSq(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function _wlCloseToFirst(wx, wy) {
  const pts = wallLine.points;
  if (pts.length < 2) return false;
  const d = WALL_LINE_CLOSE_DISTANCE;
  return _wlDistSq({ x: wx, y: wy }, pts[0]) <= d * d;
}

function _wlDedupeSequential(points) {
  if (!points.length) return [];
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    if (Math.abs(cur.x - prev.x) > 0.001 || Math.abs(cur.y - prev.y) > 0.001) out.push(cur);
  }
  return out;
}

function _wlPolylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
  return len;
}

function _wlSignedArea(pts) {
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return area / 2;
}

function _wlIsDegenerate(pts) {
  return pts.length < 3 || Math.abs(_wlSignedArea(pts)) < 1;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function beginWallLine(worldX, worldY) {
  const x = _wlSnapPoint(worldX);
  const y = _wlSnapPoint(worldY);
  wallLine.active = true;
  wallLine.points = [{ x, y }];
  wallLine.hoverWorldX = x;
  wallLine.hoverWorldY = y;
  wallLine.previewClosed = false;
}

function addWallLinePoint(worldX, worldY) {
  if (!wallLine.active) {
    beginWallLine(worldX, worldY);
    return;
  }
  const x = _wlSnapPoint(worldX);
  const y = _wlSnapPoint(worldY);
  if (_wlCloseToFirst(x, y)) {
    finishWallLine({ forceClosed: true });
    return;
  }
  wallLine.points.push({ x, y });
  wallLine.previewClosed = false;
}

function updateWallLineHover(worldX, worldY) {
  wallLine.hoverWorldX = worldX;
  wallLine.hoverWorldY = worldY;
  wallLine.previewClosed = wallLine.active && _wlCloseToFirst(worldX, worldY);
}

function finishWallLine({ forceClosed = false } = {}) {
  if (!wallLine.active) return;
  const rawPts = wallLine.points.slice();
  if (rawPts.length < 2) {
    cancelWallLine();
    return;
  }
  const pts = _wlDedupeSequential(rawPts);
  const wantClosed = forceClosed || (pts.length >= 3 && _wlCloseToFirst(wallLine.hoverWorldX, wallLine.hoverWorldY));

  if (wantClosed && pts.length >= 3) {
    if (_wlIsDegenerate(pts)) { cancelWallLine(); return; }
    const obj = createRoomGeometry(pts);
    obj.createdBy = typeof myId === "function" ? myId() : "";
    geometryAdd(obj);
    if (typeof selectedGeometryId !== "undefined") selectedGeometryId = obj.id;
  } else if (pts.length >= 2) {
    if (_wlPolylineLength(pts) < 1) { cancelWallLine(); return; }
    const obj = createWallPath(pts, false);
    obj.createdBy = typeof myId === "function" ? myId() : "";
    geometryAdd(obj);
    if (typeof selectedGeometryId !== "undefined") selectedGeometryId = obj.id;
  } else {
    cancelWallLine();
    return;
  }
  cancelWallLine();
  if (typeof requestRender === "function") requestRender();
}

function cancelWallLine() {
  wallLine.active = false;
  wallLine.points = [];
  wallLine.hoverWorldX = 0;
  wallLine.hoverWorldY = 0;
  wallLine.previewClosed = false;
}

function removeLastWallLinePoint() {
  if (!wallLine.active) return;
  if (wallLine.points.length <= 1) {
    cancelWallLine();
    return;
  }
  wallLine.points.pop();
}

// ─── Preview Rendering ────────────────────────────────────────────────────────

function drawWallLinePreview() {
  if (!wallLine.active || !wallLine.points.length) return;

  const pts = wallLine.points;
  const hover = { x: wallLine.hoverWorldX, y: wallLine.hoverWorldY };
  const willClose = wallLine.previewClosed && pts.length >= 2;

  ctx.save();

  // Committed segments
  if (pts.length >= 2) {
    ctx.beginPath();
    const p0 = worldToScreen(pts[0].x, pts[0].y);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) {
      const pi = worldToScreen(pts[i].x, pts[i].y);
      ctx.lineTo(pi.x, pi.y);
    }
    ctx.strokeStyle = "rgba(235, 205, 155, 0.93)";
    ctx.lineWidth = Math.max(2, cam.z * 2.2);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  // Preview segment from last point to cursor (dashed)
  const last = pts[pts.length - 1];
  const lastS = worldToScreen(last.x, last.y);
  const hoverS = worldToScreen(hover.x, hover.y);
  ctx.beginPath();
  ctx.moveTo(lastS.x, lastS.y);
  ctx.lineTo(hoverS.x, hoverS.y);
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = Math.max(1.5, cam.z * 1.8);
  ctx.lineCap = "round";
  ctx.strokeStyle = willClose ? "rgba(100, 225, 135, 0.92)" : "rgba(235, 205, 155, 0.52)";
  ctx.stroke();
  ctx.setLineDash([]);

  // Closing segment from cursor back to first point when near-close
  if (willClose) {
    const first = pts[0];
    const firstS = worldToScreen(first.x, first.y);
    ctx.beginPath();
    ctx.moveTo(hoverS.x, hoverS.y);
    ctx.lineTo(firstS.x, firstS.y);
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = "rgba(100, 225, 135, 0.52)";
    ctx.lineWidth = Math.max(1.5, cam.z * 1.8);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Vertex markers
  const dotR = Math.max(3, cam.z * 3.5);
  for (let i = 0; i < pts.length; i++) {
    const sp = worldToScreen(pts[i].x, pts[i].y);
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, dotR, 0, Math.PI * 2);
    if (i === 0 && willClose) ctx.fillStyle = "rgba(100, 225, 135, 0.98)";
    else if (i === 0)         ctx.fillStyle = "rgba(255, 230, 115, 0.93)";
    else                      ctx.fillStyle = "rgba(235, 205, 155, 0.85)";
    ctx.fill();
    if (i === 0) {
      ctx.lineWidth = Math.max(1, cam.z * 1.2);
      ctx.strokeStyle = willClose ? "rgba(60, 180, 90, 0.95)" : "rgba(200, 170, 80, 0.75)";
      ctx.stroke();
    }
  }

  ctx.restore();
}
