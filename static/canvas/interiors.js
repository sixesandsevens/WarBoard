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

function roomOverlapRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const w = right - x;
  const h = bottom - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function roomsOverlapArea(a, b) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function roomContainsRoom(a, b) {
  return (
    b.x >= a.x &&
    b.y >= a.y &&
    b.x + b.w <= a.x + a.w &&
    b.y + b.h <= a.y + a.h
  );
}

function findSharedBoundarySegments(a, b) {
  const segments = [];
  for (const edgeA of roomEdges(a)) {
    for (const edgeB of roomEdges(b)) {
      if (edgeA.orientation !== edgeB.orientation) continue;
      if (edgeA.line !== edgeB.line) continue;
      if (!areOpposingSides(edgeA, edgeB)) continue;
      const overlap = overlapRange(edgeA.start, edgeA.end, edgeB.start, edgeB.end);
      if (!overlap) continue;
      segments.push({
        room_a_id: edgeA.roomId,
        room_b_id: edgeB.roomId,
        side_a: edgeA.side,
        side_b: edgeB.side,
        orientation: edgeA.orientation,
        line: edgeA.line,
        start: overlap.start,
        end: overlap.end,
      });
    }
  }
  return segments;
}

function classifyRoomRelationship(a, b) {
  const shared = findSharedBoundarySegments(a, b);
  if (shared.length) return { type: "adjacent", shared };
  if (roomContainsRoom(a, b) || roomContainsRoom(b, a)) return { type: "contained", shared: [] };
  if (roomsOverlapArea(a, b)) return { type: "overlap", shared: [], overlap_rect: roomOverlapRect(a, b) };
  return { type: "separate", shared: [] };
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

function hitTestInterior(wx, wy) {
  const order = state.draw_order?.interiors || [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i];
    const room = state.interiors.get(id);
    if (!room) continue;
    if (wx >= room.x && wx <= room.x + room.w && wy >= room.y && wy <= room.y + room.h) return id;
  }
  return null;
}

function hitTestInteriorEdge(wx, wy, tolerance = 10 / cam.z) {
  const resolved = getResolvedInteriors();
  let best = null;
  for (const edge of resolved.sharedEdges) {
    let within = false;
    let distance = Infinity;
    if (edge.orientation === "h") {
      if (wx >= edge.start && wx <= edge.end) {
        distance = Math.abs(wy - edge.line);
        within = distance <= tolerance;
      } else if (wx >= edge.start - tolerance && wx <= edge.end + tolerance) {
        const dx = wx < edge.start ? edge.start - wx : wx - edge.end;
        const dy = Math.abs(wy - edge.line);
        distance = Math.hypot(dx, dy);
        within = distance <= tolerance;
      }
    } else if (wy >= edge.start && wy <= edge.end) {
      distance = Math.abs(wx - edge.line);
      within = distance <= tolerance;
    } else if (wy >= edge.start - tolerance && wy <= edge.end + tolerance) {
      const dy = wy < edge.start ? edge.start - wy : wy - edge.end;
      const dx = Math.abs(wx - edge.line);
      distance = Math.hypot(dx, dy);
      within = distance <= tolerance;
    }
    if (!within) continue;
    const relatedToSelection = selectedInteriorId && (edge.room_a_id === selectedInteriorId || edge.room_b_id === selectedInteriorId) ? 0 : 1;
    const length = edge.end - edge.start;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && relatedToSelection < best.relatedToSelection) ||
      (distance === best.distance && relatedToSelection === best.relatedToSelection && length < best.length) ||
      (
        distance === best.distance &&
        relatedToSelection === best.relatedToSelection &&
        length === best.length &&
        String(edge.edge_key || "") < String(best.edge.edge_key || "")
      )
    ) {
      best = { edge, distance, relatedToSelection, length };
    }
  }
  return best ? best.edge : null;
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

function isInteriorLocked(interiorId) {
  const room = typeof interiorId === "string" ? state.interiors.get(interiorId) : interiorId;
  return !!room?.locked;
}

function canEditInterior(interiorId) {
  const room = typeof interiorId === "string" ? state.interiors.get(interiorId) : interiorId;
  return !!(room && isGM() && !room.locked);
}

function isInteriorEdgeLocked(edge) {
  if (!edge) return false;
  return isInteriorLocked(edge.room_a_id) || isInteriorLocked(edge.room_b_id);
}

function hitTestInteriorOverlap(wx, wy) {
  const resolved = getResolvedInteriors();
  let best = null;
  for (const relationship of resolved.relationships) {
    if (relationship.type !== "overlap" || !relationship.overlap_rect) continue;
    const rect = relationship.overlap_rect;
    if (wx < rect.x || wx > rect.x + rect.w || wy < rect.y || wy > rect.y + rect.h) continue;
    const area = rect.w * rect.h;
    if (
      !best ||
      area < best.area ||
      (area === best.area && String(relationship.room_a_id) < String(best.relationship.room_a_id)) ||
      (
        area === best.area &&
        String(relationship.room_a_id) === String(best.relationship.room_a_id) &&
        String(relationship.room_b_id) < String(best.relationship.room_b_id)
      )
    ) {
      best = { relationship, area };
    }
  }
  return best ? best.relationship : null;
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
  const sharedByRoomEdge = new Map();
  const sharedEdges = [];
  const edgeModeByKey = new Map();
  const relationships = [];

  for (const edge of state.interior_edges.values()) {
    if (edge && edge.edge_key) edgeModeByKey.set(edge.edge_key, edge.mode || "auto");
  }

  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = i + 1; j < rooms.length; j += 1) {
      const roomA = rooms[i];
      const roomB = rooms[j];
      const relationship = classifyRoomRelationship(roomA, roomB);
      relationships.push({ room_a_id: roomA.id, room_b_id: roomB.id, ...relationship });
      if (relationship.type !== "adjacent") continue;
      for (const shared of relationship.shared) {
        const edgeKey = canonicalInteriorEdgeKey(
          shared.room_a_id,
          shared.room_b_id,
          shared.orientation,
          shared.line,
          shared.start,
          shared.end,
        );
        const mode = edgeModeByKey.get(edgeKey) || "auto";
        sharedEdges.push({
          edge_key: edgeKey,
          room_a_id: shared.room_a_id,
          room_b_id: shared.room_b_id,
          orientation: shared.orientation,
          line: shared.line,
          start: shared.start,
          end: shared.end,
          mode,
        });
        const keyA = `${shared.room_a_id}:${shared.side_a}:${shared.line}`;
        const keyB = `${shared.room_b_id}:${shared.side_b}:${shared.line}`;
        if (!sharedByRoomEdge.has(keyA)) sharedByRoomEdge.set(keyA, []);
        if (!sharedByRoomEdge.has(keyB)) sharedByRoomEdge.set(keyB, []);
        if (mode === "auto" || mode === "open") {
          sharedByRoomEdge.get(keyA).push({ start: shared.start, end: shared.end });
          sharedByRoomEdge.get(keyB).push({ start: shared.start, end: shared.end });
        } else if (mode === "door") {
          const carvedSegments = carveDoorSegment(shared.start, shared.end, ui.gridSize);
          const gapStart = carvedSegments.length ? carvedSegments[0].end : shared.start;
          const gapEnd = carvedSegments.length > 1 ? carvedSegments[1].start : shared.end;
          if (gapEnd > gapStart) {
            sharedByRoomEdge.get(keyA).push({ start: gapStart, end: gapEnd });
            sharedByRoomEdge.get(keyB).push({ start: gapStart, end: gapEnd });
          }
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

  return { rooms, visibleWalls: Array.from(dedupedWalls.values()), sharedEdges, doors, relationships };
}
