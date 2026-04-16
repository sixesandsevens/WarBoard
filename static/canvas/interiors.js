"use strict";

let _interiorsResolvedDirty = true;
let _interiorsResolvedCache = null;

function markInteriorsDirty() {
  _interiorsResolvedDirty = true;
}

function getResolvedInteriors() {
  if (!_interiorsResolvedDirty && _interiorsResolvedCache) return _interiorsResolvedCache;
  _interiorsResolvedDirty = false;
  _interiorsResolvedCache = resolveInteriorGeometry();
  return _interiorsResolvedCache;
}

function roomEdges(room) {
  return [
    { roomId: room.id, side: "top", orientation: "h", line: room.y, start: room.x, end: room.x + room.w },
    { roomId: room.id, side: "bottom", orientation: "h", line: room.y + room.h, start: room.x, end: room.x + room.w },
    { roomId: room.id, side: "left", orientation: "v", line: room.x, start: room.y, end: room.y + room.h },
    { roomId: room.id, side: "right", orientation: "v", line: room.x + room.w, start: room.y, end: room.y + room.h },
  ];
}

function areOpposingSides(a, b) {
  return (
    (a.side === "left" && b.side === "right") ||
    (a.side === "right" && b.side === "left") ||
    (a.side === "top" && b.side === "bottom") ||
    (a.side === "bottom" && b.side === "top")
  );
}

function overlapRange(a1, a2, b1, b2) {
  const start = Math.max(a1, b1);
  const end = Math.min(a2, b2);
  return end > start ? { start, end } : null;
}

function canonicalInteriorEdgeKey(roomAId, roomBId, orientation, line, start, end) {
  const ids = [roomAId, roomBId || ""].sort();
  return `${ids[0]}|${ids[1]}|${orientation}|${line}|${start}|${end}`;
}

function carveDoorSegment(start, end, gridSize) {
  const width = Math.min(end - start, Math.max(gridSize * 0.8, 1));
  const mid = (start + end) / 2;
  return [
    { start, end: mid - width / 2 },
    { start: mid + width / 2, end },
  ].filter((segment) => segment.end > segment.start);
}

function subtractSharedSegments(start, end, ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return [{ start, end }];
  const sorted = [...ranges]
    .filter((range) => range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start);
  if (!sorted.length) return [{ start, end }];

  const merged = [];
  for (const range of sorted) {
    if (!merged.length || range.start > merged[merged.length - 1].end) {
      merged.push({ start: range.start, end: range.end });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, range.end);
    }
  }

  const out = [];
  let cursor = start;
  for (const range of merged) {
    if (range.start > cursor) out.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < end) out.push({ start: cursor, end });
  return out.filter((segment) => segment.end > segment.start);
}

function drawInteriorFloors(rooms) {
  for (const room of rooms) {
    const topLeft = worldToScreen(room.x, room.y);
    const widthPx = room.w * cam.z;
    const heightPx = room.h * cam.z;
    ctx.save();
    ctx.fillStyle = "#b99d79";
    ctx.fillRect(topLeft.x, topLeft.y, widthPx, heightPx);
    ctx.strokeStyle = "rgba(90, 60, 32, 0.16)";
    ctx.lineWidth = 1;
    const plankStep = Math.max(8, ui.gridSize * cam.z * 0.2);
    for (let y = topLeft.y + plankStep; y < topLeft.y + heightPx; y += plankStep) {
      ctx.beginPath();
      ctx.moveTo(topLeft.x, y);
      ctx.lineTo(topLeft.x + widthPx, y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawInteriorWalls(visibleWalls, doors) {
  ctx.save();
  ctx.strokeStyle = "#21170f";
  ctx.lineWidth = Math.max(3, ui.gridSize * cam.z * 0.08);
  ctx.lineCap = "square";
  for (const wall of visibleWalls) {
    ctx.beginPath();
    if (wall.orientation === "h") {
      const a = worldToScreen(wall.start, wall.line);
      const b = worldToScreen(wall.end, wall.line);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    } else {
      const a = worldToScreen(wall.line, wall.start);
      const b = worldToScreen(wall.line, wall.end);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawInteriorSelection() {
  if (selectedInteriorId) {
    const room = state.interiors.get(selectedInteriorId);
    if (room) {
      const topLeft = worldToScreen(room.x, room.y);
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = "#ffd54a";
      ctx.lineWidth = Math.max(2, cam.z * 3);
      ctx.strokeRect(topLeft.x, topLeft.y, room.w * cam.z, room.h * cam.z);
      ctx.restore();
    }
  }
  if (activeInteriorPreview) {
    const topLeft = worldToScreen(activeInteriorPreview.x, activeInteriorPreview.y);
    ctx.save();
    ctx.globalAlpha = 0.68;
    ctx.fillStyle = "#cbb08d";
    ctx.strokeStyle = "#2b2017";
    ctx.lineWidth = Math.max(2, cam.z * 2);
    ctx.fillRect(topLeft.x, topLeft.y, activeInteriorPreview.w * cam.z, activeInteriorPreview.h * cam.z);
    ctx.strokeRect(topLeft.x, topLeft.y, activeInteriorPreview.w * cam.z, activeInteriorPreview.h * cam.z);
    ctx.restore();
  }
}

function hitTestInteriorEdge(wx, wy, tolerance = 6 / cam.z) {
  const resolved = getResolvedInteriors();
  for (const edge of resolved.sharedEdges) {
    if (edge.orientation === "h") {
      if (Math.abs(wy - edge.line) <= tolerance && wx >= edge.start - tolerance && wx <= edge.end + tolerance) {
        return edge;
      }
    } else if (Math.abs(wx - edge.line) <= tolerance && wy >= edge.start - tolerance && wy <= edge.end + tolerance) {
      return edge;
    }
  }
  return null;
}

function hitTestInteriorResize(wx, wy, tolerance = 6 / cam.z) {
  const order = state.draw_order?.interiors || [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const room = state.interiors.get(order[i]);
    if (!room) continue;
    if (wy >= room.y - tolerance && wy <= room.y + room.h + tolerance) {
      if (Math.abs(wx - room.x) < tolerance) return { id: room.id, side: "left" };
      if (Math.abs(wx - (room.x + room.w)) < tolerance) return { id: room.id, side: "right" };
    }
    if (wx >= room.x - tolerance && wx <= room.x + room.w + tolerance) {
      if (Math.abs(wy - room.y) < tolerance) return { id: room.id, side: "top" };
      if (Math.abs(wy - (room.y + room.h)) < tolerance) return { id: room.id, side: "bottom" };
    }
  }
  return null;
}

function resolveInteriorGeometry() {
  const rooms = Array.from(state.interiors.values()).map((room) => ({
    ...room,
    x: Number(room.x || 0),
    y: Number(room.y || 0),
    w: Math.max(1, Number(room.w || 1)),
    h: Math.max(1, Number(room.h || 1)),
    style: "wood",
  }));
  const allEdges = rooms.flatMap(roomEdges);
  const sharedByRoomEdge = new Map();
  const sharedEdges = [];
  const edgeModeByKey = new Map();

  for (const edge of state.interior_edges.values()) {
    if (edge && edge.edge_key) edgeModeByKey.set(edge.edge_key, edge.mode || "auto");
  }

  for (let i = 0; i < allEdges.length; i += 1) {
    const a = allEdges[i];
    for (let j = i + 1; j < allEdges.length; j += 1) {
      const b = allEdges[j];
      if (a.orientation !== b.orientation) continue;
      if (a.line !== b.line) continue;
      if (!areOpposingSides(a, b)) continue;
      const overlap = overlapRange(a.start, a.end, b.start, b.end);
      if (!overlap) continue;
      const edgeKey = canonicalInteriorEdgeKey(a.roomId, b.roomId, a.orientation, a.line, overlap.start, overlap.end);
      const mode = edgeModeByKey.get(edgeKey) || "auto";
      sharedEdges.push({
        edge_key: edgeKey,
        room_a_id: a.roomId,
        room_b_id: b.roomId,
        orientation: a.orientation,
        line: a.line,
        start: overlap.start,
        end: overlap.end,
        mode,
      });
      const keyA = `${a.roomId}:${a.side}:${a.line}`;
      const keyB = `${b.roomId}:${b.side}:${b.line}`;
      if (!sharedByRoomEdge.has(keyA)) sharedByRoomEdge.set(keyA, []);
      if (!sharedByRoomEdge.has(keyB)) sharedByRoomEdge.set(keyB, []);
      if (mode === "auto" || mode === "open") {
        sharedByRoomEdge.get(keyA).push(overlap);
        sharedByRoomEdge.get(keyB).push(overlap);
      } else if (mode === "door") {
        const carvedSegments = carveDoorSegment(overlap.start, overlap.end, ui.gridSize);
        const gapStart = carvedSegments.length ? carvedSegments[0].end : overlap.start;
        const gapEnd = carvedSegments.length > 1 ? carvedSegments[1].start : overlap.end;
        if (gapEnd > gapStart) {
          sharedByRoomEdge.get(keyA).push({ start: gapStart, end: gapEnd });
          sharedByRoomEdge.get(keyB).push({ start: gapStart, end: gapEnd });
        }
      }
    }
  }

  const visibleWalls = [];

  for (const sharedEdge of sharedEdges) {
    if (sharedEdge.mode === "wall") {
      visibleWalls.push({
        roomId: sharedEdge.room_a_id,
        orientation: sharedEdge.orientation,
        line: sharedEdge.line,
        start: sharedEdge.start,
        end: sharedEdge.end,
        mode: "wall",
      });
    }
  }

  for (const room of rooms) {
    for (const edge of roomEdges(room)) {
      const edgeKey = `${edge.roomId}:${edge.side}:${edge.line}`;
      const sharedRanges = sharedByRoomEdge.get(edgeKey) || [];
      const visibleSegments = subtractSharedSegments(edge.start, edge.end, sharedRanges);
      for (const segment of visibleSegments) {
        visibleWalls.push({
          roomId: edge.roomId,
          orientation: edge.orientation,
          line: edge.line,
          start: segment.start,
          end: segment.end,
          mode: "wall",
        });
      }
    }
  }
  const dedupedWalls = new Map();
  for (const wall of visibleWalls) {
    const key = `${wall.orientation}|${wall.line}|${wall.start}|${wall.end}`;
    if (!dedupedWalls.has(key)) dedupedWalls.set(key, wall);
  }

  const doors = [];
  for (const sharedEdge of sharedEdges) {
    if (sharedEdge.mode === "door") {
      const carvedSegments = carveDoorSegment(sharedEdge.start, sharedEdge.end, ui.gridSize);
      const gapStart = carvedSegments.length ? carvedSegments[0].end : sharedEdge.start;
      const gapEnd = carvedSegments.length > 1 ? carvedSegments[1].start : sharedEdge.end;
      doors.push({
        ...sharedEdge,
        doorStart: gapStart,
        doorEnd: gapEnd,
      });
    }
  }

  return { rooms, visibleWalls: Array.from(dedupedWalls.values()), sharedEdges, doors };
}
