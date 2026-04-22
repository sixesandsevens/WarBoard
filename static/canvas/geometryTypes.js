"use strict";

// ─── Kind / Role / Mode Constants ─────────────────────────────────────────────
const GEOMETRY_KIND = Object.freeze({
  ROOM: "room",
  CAVE: "cave",
  WALL_PATH: "wall_path",
});

const EDGE_ROLE = Object.freeze({
  WALL: "wall",
  OPEN: "open",
  BOUNDARY: "boundary",
});

const EDGE_RENDER_MODE = Object.freeze({
  CLEAN_STROKE: "clean_stroke",
  ROUGH_STROKE: "rough_stroke",
  ROCK_WALL: "rock_wall",
  HIDDEN: "hidden",
});

const OPENING_KIND = Object.freeze({
  DOOR: "door",
  WINDOW: "window",
  ARCH: "arch",
  GAP: "gap",
});

const GEOMETRY_SEAM_MODE = Object.freeze({
  OPEN: "open",
  CLOSED: "closed",
  WALL: "wall",
});

// ─── Default Style Presets ────────────────────────────────────────────────────
const GEOMETRY_STYLE_PRESETS = Object.freeze({
  room: {
    fillMode: "pattern",
    fillColor: "#b99d79",
    edgeDefaultRole: "wall",
    edgeDefaultRenderMode: "clean_stroke",
    edgeThickness: 6,
    smoothing: 0,
    edgeJitter: 0,
  },
  cave: {
    fillMode: "pattern",
    fillColor: "#6b5c40",
    edgeDefaultRole: "boundary",
    edgeDefaultRenderMode: "rough_stroke",
    edgeThickness: 3,
    smoothing: 1,
    edgeJitter: 1,
  },
  wall_path: {
    fillMode: "none",
    fillColor: null,
    edgeDefaultRole: "wall",
    edgeDefaultRenderMode: "clean_stroke",
    edgeThickness: 2,
    smoothing: 0,
    edgeJitter: 0,
  },
});

// ─── Factory Functions ────────────────────────────────────────────────────────

function createGeometryObject(kind, outer, closed, opts = {}) {
  const now = Date.now();
  return {
    id: opts.id || makeId(),
    type: "geometry",
    kind: String(kind),
    outer: outer.map((p) => ({ x: Number(p.x), y: Number(p.y) })),
    closed: !!closed,
    holes: opts.holes || undefined,
    edges: opts.edges || undefined,
    openings: opts.openings || undefined,
    style: Object.assign({}, GEOMETRY_STYLE_PRESETS[kind] || {}, opts.style || {}),
    createdBy: String(opts.createdBy || ""),
    createdAt: Number(opts.createdAt || now),
    updatedAt: Number(opts.updatedAt || now),
    locked: !!opts.locked,
    visible: opts.visible !== false,
    zIndex: Number(opts.zIndex || 0),
    bounds: null,
  };
}

function createRoomGeometry(points, style = {}) {
  return createGeometryObject(GEOMETRY_KIND.ROOM, points, true, { style });
}

// Builds a closed 4-corner room polygon from axis-aligned rectangle bounds.
// Corners are in consistent winding order regardless of drag direction.
function createRectangleRoomGeometry(x, y, w, h, opts = {}) {
  const pts = [
    { x,     y     },
    { x: x + w, y     },
    { x: x + w, y: y + h },
    { x,     y: y + h },
  ];
  return createGeometryObject(GEOMETRY_KIND.ROOM, pts, true, opts);
}

function createCaveGeometry(points, style = {}) {
  return createGeometryObject(GEOMETRY_KIND.CAVE, points, true, { style, zIndex: -1 });
}

function createWallPath(points, closed = false, style = {}) {
  return createGeometryObject(GEOMETRY_KIND.WALL_PATH, points, closed, { style });
}

function createOpening(edgeIndex, t0, t1, kind, opts = {}) {
  return {
    id: opts.id || makeId(),
    edgeIndex: Number(edgeIndex),
    t0: Number(t0),
    t1: Number(t1),
    kind: String(kind),
    assetId: opts.assetId || null,
    swing: opts.swing || null,
    createdBy: String(opts.createdBy || ""),
    createdAt: Number(opts.createdAt || Date.now()),
  };
}
