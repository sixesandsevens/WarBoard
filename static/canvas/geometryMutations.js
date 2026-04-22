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

  // Compute edge count before normalizing openings so we can validate edgeIndex.
  const edgeCount = closed ? outer.length : Math.max(0, outer.length - 1);

  const openings = Array.isArray(raw.openings)
    ? raw.openings
        .map((op) => {
          const { t0, t1 } = clampOpeningRange(Number(op.t0 || 0), Number(op.t1 || 0));
          // Accept both camelCase (live wire) and snake_case (STATE_SYNC model_dump)
          const edgeIndex = Number(op.edgeIndex ?? op.edge_index ?? 0);
          return {
            id: String(op.id || makeId()),
            edgeIndex,
            t0,
            t1,
            kind: Object.values(OPENING_KIND).includes(op.kind) ? op.kind : OPENING_KIND.DOOR,
            assetId: op.assetId ?? op.asset_id ?? null,
            swing: op.swing ?? null,
            createdBy: String(op.createdBy ?? op.created_by ?? ""),
            createdAt: Number(op.createdAt ?? op.created_at ?? Date.now()),
          };
        })
        .filter((op) => op.edgeIndex >= 0 && op.edgeIndex < edgeCount)
        .filter((op) => op.t1 > op.t0)
    : undefined;

  const edges = Array.isArray(raw.edges)
    ? raw.edges.map((e) => ({
        index: Number(e.index || 0),
        role: Object.values(EDGE_ROLE).includes(e.role) ? e.role : EDGE_ROLE.WALL,
        // Accept both camelCase (live wire) and snake_case (STATE_SYNC model_dump)
        renderMode: Object.values(EDGE_RENDER_MODE).includes(e.renderMode ?? e.render_mode)
          ? (e.renderMode ?? e.render_mode)
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
    createdBy: String(raw.createdBy || raw.created_by || ""),
    createdAt: Number(raw.createdAt ?? raw.created_at ?? now),
    updatedAt: Number(raw.updatedAt ?? raw.updated_at ?? now),
    locked: !!raw.locked,
    visible: raw.visible !== false,
    zIndex: Number(raw.zIndex ?? raw.z_index ?? 0),
    bounds: null,
  };
}

function normalizeGeometrySeamOverride(raw) {
  if (!raw || typeof raw !== "object") return null;
  const seamKey = String(raw.seamKey ?? raw.seam_key ?? raw.id ?? "").trim();
  if (!seamKey) return null;
  const schemaVersion = Math.max(1, Number(raw.schemaVersion ?? raw.schema_version ?? 1) || 1);
  let mode = String(raw.mode || "");
  if (mode === GEOMETRY_SEAM_MODE.OPEN) {
    mode = GEOMETRY_SEAM_MODE.OPEN;
  } else if (mode === GEOMETRY_SEAM_MODE.CLOSED) {
    mode = GEOMETRY_SEAM_MODE.CLOSED;
  } else if (mode === GEOMETRY_SEAM_MODE.WALL) {
    // Legacy binary seam data used "wall" to mean "visible seam marker".
    mode = schemaVersion >= 2 ? GEOMETRY_SEAM_MODE.WALL : GEOMETRY_SEAM_MODE.CLOSED;
  } else {
    mode = GEOMETRY_SEAM_MODE.CLOSED;
  }
  return {
    id: String(raw.id || seamKey),
    seamKey,
    mode,
    createdBy: String(raw.createdBy ?? raw.created_by ?? ""),
    updatedAt: Number(raw.updatedAt ?? raw.updated_at ?? Date.now()),
    schemaVersion,
  };
}

// Normalize, validate, and compute bounds in one step.
// Returns a ready-to-store object or null if validation fails.
// Use this at every insertion point so invalid geometry never enters state.
function normalizeAndValidateGeometry(raw) {
  const obj = normalizeGeometryObject(raw);
  if (!obj) return null;
  const { valid, errors } = validateGeometryObject(obj);
  if (!valid) {
    console.warn("[geometry] Invalid object rejected:", errors, raw);
    return null;
  }
  obj.bounds = computeGeometryBounds(obj);
  return obj;
}

// ─── Mutation Application ─────────────────────────────────────────────────────

// Apply a geometry mutation transaction: { removed: [...], added: [...] }
// removed entries may be full objects or bare id strings.
// Incoming timestamps from authoritative payloads are preserved.
function applyGeometryMutation(mutation) {
  for (const entry of (mutation.removed || [])) {
    const id = typeof entry === "string" ? entry : entry.id;
    if (id) {
      state.geometry.delete(id);
      if (typeof markGeometryDerivedDirty === "function") markGeometryDerivedDirty();
      send("GEOMETRY_DELETE", { id });
    }
  }
  for (const raw of (mutation.added || [])) {
    const obj = normalizeAndValidateGeometry(raw);
    if (obj) {
      state.geometry.set(obj.id, obj);
      if (typeof markGeometryDerivedDirty === "function") markGeometryDerivedDirty();
      send("GEOMETRY_ADD", _geometryWirePayload(obj));
    }
  }
  requestRender();
}

// ─── Convenience Helpers ──────────────────────────────────────────────────────

function geometryAdd(raw) {
  const obj = normalizeAndValidateGeometry(raw);
  if (!obj) return null;
  state.geometry.set(obj.id, obj);
  if (typeof markGeometryDerivedDirty === "function") markGeometryDerivedDirty();
  send("GEOMETRY_ADD", _geometryWirePayload(obj));
  requestRender();
  return obj;
}

// Local edit: always refreshes updatedAt so the object is clearly newer than
// any authoritative copy it was derived from.
function geometryUpdate(id, changes) {
  const existing = state.geometry.get(id);
  if (!existing) return;
  // Inject a fresh updatedAt so local edits are always marked newer.
  const merged = Object.assign({}, existing, changes, { id, updatedAt: Date.now() });
  const obj = normalizeAndValidateGeometry(merged);
  if (obj) {
    state.geometry.set(id, obj);
    if (typeof markGeometryDerivedDirty === "function") markGeometryDerivedDirty();
    send("GEOMETRY_UPDATE", _geometryWirePayload(obj));
    requestRender();
  }
}

function geometrySetSeamMode(seamKey, mode) {
  const normalized = normalizeGeometrySeamOverride({ id: seamKey, seamKey, mode, updatedAt: Date.now() });
  if (!normalized) return null;
  state.geometry_seams.set(normalized.seamKey, normalized);
  if (typeof markGeometryDerivedDirty === "function") markGeometryDerivedDirty();
  send("GEOMETRY_SEAM_SET", {
    id: normalized.id,
    seamKey: normalized.seamKey,
    mode: normalized.mode,
    createdBy: normalized.createdBy,
    updatedAt: normalized.updatedAt,
    schemaVersion: 2,
  });
  requestRender();
  return normalized;
}

function geometryDelete(id) {
  if (state.geometry.delete(id)) {
    if (typeof markGeometryDerivedDirty === "function") markGeometryDerivedDirty();
    send("GEOMETRY_DELETE", { id });
    requestRender();
  }
}

// Build the camelCase wire payload the server geometry handler expects.
function _geometryWirePayload(obj) {
  return {
    id: obj.id,
    kind: obj.kind,
    outer: obj.outer,
    closed: obj.closed,
    openings: Array.isArray(obj.openings) ? obj.openings.map((op) => ({
      id: op.id,
      edgeIndex: op.edgeIndex,
      t0: op.t0,
      t1: op.t1,
      kind: op.kind,
      assetId: op.assetId || null,
      swing: op.swing || null,
      createdBy: op.createdBy || "",
      createdAt: op.createdAt || 0,
    })) : [],
    edges: Array.isArray(obj.edges) ? obj.edges.map((e) => ({
      index: e.index,
      role: e.role,
      renderMode: e.renderMode,
      thickness: e.thickness != null ? e.thickness : undefined,
    })) : [],
    style: obj.style || {},
    createdBy: obj.createdBy || "",
    createdAt: obj.createdAt || 0,
    updatedAt: obj.updatedAt || 0,
    locked: !!obj.locked,
    visible: obj.visible !== false,
    zIndex: Number(obj.zIndex || 0),
  };
}

// ─── Z-Order Helpers ──────────────────────────────────────────────────────────

function getGeometryMaxZ() {
  let maxZ = 0, seen = false;
  for (const obj of state.geometry.values()) {
    const z = Number(obj?.zIndex || 0);
    if (!seen || z > maxZ) { maxZ = z; seen = true; }
  }
  return seen ? maxZ : 0;
}

function getGeometryMinZ() {
  let minZ = 0, seen = false;
  for (const obj of state.geometry.values()) {
    const z = Number(obj?.zIndex || 0);
    if (!seen || z < minZ) { minZ = z; seen = true; }
  }
  return seen ? minZ : 0;
}

function bringGeometryToFront(id) {
  const obj = state.geometry.get(id);
  if (!obj) return false;
  const nextZ = getGeometryMaxZ() + 1;
  if (Number(obj.zIndex || 0) === nextZ) return false;
  geometryUpdate(id, { zIndex: nextZ });
  return true;
}

function sendGeometryToBack(id) {
  const obj = state.geometry.get(id);
  if (!obj) return false;
  const nextZ = getGeometryMinZ() - 1;
  if (Number(obj.zIndex || 0) === nextZ) return false;
  geometryUpdate(id, { zIndex: nextZ });
  return true;
}

// Apply a raw geometry object received from a GEOMETRY_* wire event.
// Preserves authoritative timestamps from the payload.
function applyGeometryEvent(type, payload) {
  if (type === "GEOMETRY_ADD" || type === "GEOMETRY_UPDATE") {
    const obj = normalizeAndValidateGeometry(payload);
    if (obj) {
      state.geometry.set(obj.id, obj);
      if (typeof markGeometryDerivedDirty === "function") markGeometryDerivedDirty();
      requestRender();
    }
  } else if (type === "GEOMETRY_DELETE") {
    const id = String(payload.id || "");
    if (id) geometryDelete(id);
  } else if (type === "GEOMETRY_SEAM_SET") {
    const seam = normalizeGeometrySeamOverride(payload);
    if (seam) {
      state.geometry_seams.set(seam.seamKey, seam);
      if (typeof markGeometryDerivedDirty === "function") markGeometryDerivedDirty();
      requestRender();
    }
  }
}
