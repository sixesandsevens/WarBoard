"use strict";

// ─── Normalization ────────────────────────────────────────────────────────────

function normalizeGeometryObject(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = Object.values(GEOMETRY_KIND).includes(raw.kind) ? raw.kind : GEOMETRY_KIND.ROOM;
  const outer = Array.isArray(raw.outer)
    ? raw.outer.map((p) => ({ x: Number(p.x || 0), y: Number(p.y || 0) }))
    : [];
  const defaultClosed = kind !== GEOMETRY_KIND.WALL_PATH;
  const closed = typeof raw.closed === "boolean" ? raw.closed : defaultClosed;

  const openings = Array.isArray(raw.openings)
    ? raw.openings.map((op) => ({
        id: String(op.id || makeId()),
        edgeIndex: Number(op.edgeIndex || 0),
        t0: clamp(Number(op.t0 || 0), 0, 1),
        t1: clamp(Number(op.t1 || 0), 0, 1),
        kind: Object.values(OPENING_KIND).includes(op.kind) ? op.kind : OPENING_KIND.DOOR,
        assetId: op.assetId || null,
        swing: op.swing || null,
        createdBy: String(op.createdBy || ""),
        createdAt: Number(op.createdAt || Date.now()),
      }))
    : undefined;

  const edges = Array.isArray(raw.edges)
    ? raw.edges.map((e) => ({
        index: Number(e.index || 0),
        role: Object.values(EDGE_ROLE).includes(e.role) ? e.role : EDGE_ROLE.WALL,
        renderMode: Object.values(EDGE_RENDER_MODE).includes(e.renderMode)
          ? e.renderMode
          : EDGE_RENDER_MODE.CLEAN_STROKE,
        thickness: e.thickness != null ? Number(e.thickness) : undefined,
      }))
    : undefined;

  const now = Date.now();
  return {
    id: String(raw.id || makeId()),
    type: "geometry",
    kind,
    outer,
    closed,
    holes: raw.holes || undefined,
    edges,
    openings,
    style: Object.assign({}, GEOMETRY_STYLE_PRESETS[kind] || {}, raw.style || {}),
    createdBy: String(raw.createdBy || ""),
    createdAt: Number(raw.createdAt || now),
    updatedAt: Number(raw.updatedAt || now),
    locked: !!raw.locked,
    visible: raw.visible !== false,
    zIndex: Number(raw.zIndex || 0),
    bounds: null,
  };
}

// ─── Mutation Application ─────────────────────────────────────────────────────

// Apply a geometry mutation transaction: { removed: [...], added: [...] }
// removed entries may be full objects or bare id strings.
function applyGeometryMutation(mutation) {
  for (const entry of (mutation.removed || [])) {
    const id = typeof entry === "string" ? entry : entry.id;
    if (id) state.geometry.delete(id);
  }
  for (const raw of (mutation.added || [])) {
    const obj = normalizeGeometryObject(raw);
    if (obj) {
      obj.bounds = computeGeometryBounds(obj);
      state.geometry.set(obj.id, obj);
    }
  }
  requestRender();
}

// ─── Convenience Helpers ──────────────────────────────────────────────────────

function geometryAdd(raw) {
  const obj = normalizeGeometryObject(raw);
  if (!obj) return null;
  obj.bounds = computeGeometryBounds(obj);
  state.geometry.set(obj.id, obj);
  requestRender();
  return obj;
}

function geometryUpdate(id, changes) {
  const existing = state.geometry.get(id);
  if (!existing) return;
  const merged = Object.assign({}, existing, changes, { id });
  const updated = normalizeGeometryObject(merged);
  if (updated) {
    updated.bounds = computeGeometryBounds(updated);
    state.geometry.set(id, updated);
    requestRender();
  }
}

function geometryDelete(id) {
  if (state.geometry.delete(id)) requestRender();
}

// Apply a raw geometry object received from STATE_SYNC or a GEOMETRY_* event.
function applyGeometryEvent(type, payload) {
  if (type === "GEOMETRY_ADD" || type === "GEOMETRY_UPDATE") {
    const obj = normalizeGeometryObject(payload);
    if (obj) {
      obj.bounds = computeGeometryBounds(obj);
      state.geometry.set(obj.id, obj);
      requestRender();
    }
  } else if (type === "GEOMETRY_DELETE") {
    const id = String(payload.id || "");
    if (id) geometryDelete(id);
  }
}
