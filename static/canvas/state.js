"use strict";

function loadStoredAssetMoveLock() {
  try {
    return localStorage.getItem("warhamster:v1:lock_asset_move") === "1";
  } catch (_) {
    return false;
  }
}

let ws = null;
let wsConnectSeq = 0;
let appInitialized = false;
let heartbeatTimer = null;
let staleSyncTimer = null;
let lastInboundChangeTs = Date.now();
let lastResyncRequestTs = 0;
let resyncBadgeTimer = null;
let seenInboundMutationSinceConnect = false;
let sessionConnecting = false;
let wsReadyPromise = null;
let wsReadyResolver = null;
let wsReadyRejector = null;
let wsReadyRoomId = "";
const players = new Set();
const STATE_CHANGE_EVENTS = new Set([
  "STATE_SYNC",
  "ROOM_SETTINGS",
  "TOKEN_CREATE",
  "TOKEN_MOVE",
  "TOKEN_DELETE",
  "TOKEN_ASSIGN",
  "TOKEN_RENAME",
  "TOKEN_SET_SIZE",
  "TOKEN_SET_LOCK",
  "TOKEN_BADGE_TOGGLE",
  "STROKE_ADD",
  "STROKE_DELETE",
  "STROKE_SET_LOCK",
  "ERASE_AT",
  "SHAPE_ADD",
  "SHAPE_UPDATE",
  "SHAPE_DELETE",
  "SHAPE_SET_LOCK",
  "ASSET_INSTANCE_CREATE",
  "ASSET_INSTANCE_UPDATE",
  "ASSET_INSTANCE_DELETE",
  "INTERIOR_ADD",
  "INTERIOR_UPDATE",
  "INTERIOR_DELETE",
  "INTERIOR_SET_LOCK",
  "INTERIOR_EDGE_SET",
]);
const WATCHDOG_MUTATION_EVENTS = new Set([
  "ROOM_SETTINGS",
  "TOKEN_CREATE",
  "TOKEN_MOVE",
  "TOKEN_DELETE",
  "TOKEN_ASSIGN",
  "TOKEN_RENAME",
  "TOKEN_SET_SIZE",
  "TOKEN_SET_LOCK",
  "TOKEN_BADGE_TOGGLE",
  "STROKE_ADD",
  "STROKE_DELETE",
  "STROKE_SET_LOCK",
  "ERASE_AT",
  "SHAPE_ADD",
  "SHAPE_UPDATE",
  "SHAPE_DELETE",
  "SHAPE_SET_LOCK",
  "ASSET_INSTANCE_CREATE",
  "ASSET_INSTANCE_UPDATE",
  "ASSET_INSTANCE_DELETE",
  "INTERIOR_ADD",
  "INTERIOR_UPDATE",
  "INTERIOR_DELETE",
  "INTERIOR_SET_LOCK",
  "INTERIOR_EDGE_SET",
]);

const state = {
  room_id: null,
  room_name: null,
  gm_id: null,
  co_gm_ids: [],
  allow_players_move: false,
  allow_all_move: false,
  lockdown: false,
  background_mode: "solid",
  background_url: null,
  terrain_seed: 1,
  terrain_style: "grassland",
  world_tone: 0.32,
  layer_visibility: { grid: true, drawings: true, shapes: true, assets: true, tokens: true, interiors: true },
  draw_order: { strokes: [], shapes: [], assets: [], interiors: [] },
  version: 0,
  tokens: new Map(),
  strokes: new Map(),
  shapes: new Map(),
  assets: new Map(),
  interiors: new Map(),
  interior_edges: new Map(),
  terrain_paint: {
    materials: {
      mud:       { id: "mud",       label: "Mud",       style: "dirt",      seedOfs: 101, mode: "mud",        scale: 1.0, zOrder: 0 },
      stone:     { id: "stone",     label: "Ground",    style: "grassland", seedOfs: 202, mode: "micro",      scale: 1.0, zOrder: 1 },
      shore:     { id: "shore",     label: "Shore",     style: "shore",     seedOfs: 909, mode: "shore",      scale: 1.0, zOrder: 2 },
      dirt_road: { id: "dirt_road", label: "Dirt Road", style: "dirt",      seedOfs: 505, mode: "path",       scale: 1.0, zOrder: 3 },
      cobble:    { id: "cobble",    label: "Cobble",    style: "cobble",    seedOfs: 404, mode: "cobble",     scale: 1.0, zOrder: 4, transparentBase: true },
      slime:     { id: "slime",     label: "Water",     style: "water",     seedOfs: 303, mode: "macro_soft", scale: 1.0, zOrder: 5 },
      sand:      { id: "sand",      label: "Sand",      style: "desert",    seedOfs: 606, mode: "macro_soft", scale: 1.0, zOrder: 6 },
      snow:      { id: "snow",      label: "Snow",      style: "snow",      seedOfs: 707, mode: "macro_soft", scale: 1.0, zOrder: 7 },
      volcano:   { id: "volcano",   label: "Volcano",   style: "volcano",   seedOfs: 808, mode: "macro_soft", scale: 1.2, zOrder: 8 },
    },
    strokes: {},
    undo_stack: [],
  },
  fog_paint: {
    enabled: false,
    default_mode: "clear",
    strokes: {},
    undo_stack: [],
  },
};

const cam = { x: 80, y: 60, z: 1 };
const ui = {
  gridSize: 72,
  snap: true,
  showGrid: true,
  feetPerSq: 5,
  tokenSpawnScale: 1.0,
  textDraft: "",
  textFontSize: 24,
  lockAssetMove: loadStoredAssetMoveLock(),
};

let draggingTokenId = null;
let draggingAssetId = null;
let draggingShapeId = null;
let draggingInteriorId = null;
let resizingInterior = null;
let selectedTokenId = null;
let selectedAssetId = null;
let selectedShapeId = null;
let selectedInteriorId = null;
let currentInteriorContextId = null;
let currentInteriorEdge = null;
const selectedAssetIds = new Set();
let draggingAssetIds = [];
let dragStartAssetPositions = new Map();
let assetDragOrigin = null;
let hoveredTokenId = null;
let hoverWorldPos = null;
let hoverCanvasActive = false;
let dragOffset = { x: 0, y: 0 };
let interiorDragStart = null;
let interiorDragOrigin = null;
let shapeDragOrigin = null;
const selectedTokenIds = new Set();
let draggingTokenIds = [];
let dragMoveStartWorld = null;
let dragStartTokenPositions = new Map();
let marqueeSelectRect = null;
let isPanning = false;
let isShiftDown = false;
let panStart = { sx: 0, sy: 0, camX: 0, camY: 0 };
let pointerCaptured = false;

let activeStroke = null;
let activeShapePreview = null;
let activeInteriorPreview = null;
let activeRuler = null;
let hoveredInteriorId = null;
let hoveredInteriorEdge = null;
let hoveredInteriorResize = null;
let erasingActive = false;
let lastEraseWorld = null;

let lastMoveSentAt = 0;
const MOVE_SEND_INTERVAL_MS = 33;
let lastEraseSentAt = 0;
const ERASE_SEND_INTERVAL_MS = 40;
let dragSpawn = null;
let dragSpawnWorld = null;
let dragSpawnOverCanvas = false;
let pendingTextPlacement = null;
let textPanelTargetShapeId = null;
let colorPanelTargetShapeId = null;
let sizePanelTargetShapeId = null;
let sizePanelMode = "brush";
let tokenMenuTokenId = null;
let mapCtxWorld = null;
let ctxSubHideTimer = null;
let lastShapeTool = "rect";
let lastCtxClientPos = { x: 24, y: 24 };
let tooltipTimer = null;
let lastPartialRejectLogAt = 0;
let moveSeqCounter = 0;
let activeDragMoveSeq = null;

function getLocalMoveClientId() {
  const key = "warhamster:v1:move_client_id";
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = makeId();
    sessionStorage.setItem(key, created);
    return created;
  } catch (_) {
    return makeId();
  }
}

const localMoveClientId = getLocalMoveClientId();

let bgImage = null;
let bgImageUrl = null;
let bgImageStatus = "idle";
const bgCache = new Map();
const tokenImageCache = new Map();
const packAssetBlobUrlCache = new Map();
const packAssetBlobFetches = new Map();

let offlineSaveTimer = null;
let lastOfflineEraseHistoryAt = 0;
const offlineHistory = [];
const offlineFuture = [];
const OFFLINE_HISTORY_LIMIT = 50;
const OFFLINE_MUTATION_TYPES = new Set([
  "ROOM_SETTINGS",
  "TOKEN_CREATE",
  "TOKEN_DELETE",
  "TOKEN_ASSIGN",
  "TOKEN_RENAME",
  "TOKEN_SET_SIZE",
  "TOKEN_SET_LOCK",
  "TOKEN_BADGE_TOGGLE",
  "TOKEN_MOVE",
  "STROKE_ADD",
  "STROKE_DELETE",
  "STROKE_SET_LOCK",
  "ERASE_AT",
  "SHAPE_ADD",
  "SHAPE_UPDATE",
  "SHAPE_DELETE",
  "SHAPE_SET_LOCK",
  "ASSET_INSTANCE_CREATE",
  "ASSET_INSTANCE_UPDATE",
  "ASSET_INSTANCE_DELETE",
  "INTERIOR_ADD",
  "INTERIOR_UPDATE",
  "INTERIOR_DELETE",
  "INTERIOR_SET_LOCK",
  "INTERIOR_EDGE_SET",
  "TERRAIN_STROKE_ADD",
  "TERRAIN_STROKE_UNDO",
  "FOG_STROKE_ADD",
  "FOG_RESET",
  "FOG_SET_ENABLED",
  "COGM_ADD",
  "COGM_REMOVE",
]);

// ─── WS readiness helpers ──────────────────────────────────────────────────────

function resetWsReadyState() {
  wsReadyPromise = null;
  wsReadyResolver = null;
  wsReadyRejector = null;
  wsReadyRoomId = "";
}

function beginWsReadyWait(roomId) {
  const targetRoomId = String(roomId || "").trim();
  wsReadyRoomId = targetRoomId;
  wsReadyPromise = new Promise((resolve, reject) => {
    wsReadyResolver = resolve;
    wsReadyRejector = reject;
  });
  return wsReadyPromise;
}

function resolveWsReady(roomId) {
  const targetRoomId = String(roomId || "").trim();
  if (!wsReadyResolver) return;
  if (wsReadyRoomId && targetRoomId && wsReadyRoomId !== targetRoomId) return;
  const resolve = wsReadyResolver;
  resetWsReadyState();
  resolve(true);
}

function rejectWsReady(message) {
  if (!wsReadyRejector) return;
  const reject = wsReadyRejector;
  resetWsReadyState();
  reject(new Error(message || "WebSocket closed before room was ready."));
}

function setSessionConnecting(next) {
  sessionConnecting = !!next;
  if (typeof updateSessionPill === "function") {
    updateSessionPill();
  }
}
