// static/canvas/assets.js — Asset Library & Pack UI
// Depends on globals from canvas.js: state, online, cam, ui, canvas, dragSpawn, dragSpawnWorld,
//   dragSpawnOverCanvas, selectedAssetId, tokenImageCache, packAssetBlobUrlCache, packAssetBlobFetches,
//   bgImage, bgImageUrl, playSessionState, drawer
// Depends on modules: api.js (apiGet, apiPost, apiDelete, apiUploadAsset, apiUploadAssetZip,
//   apiDeleteAsset, assetPreviewUrl, withAssetLibSrc, normalizePackBackedRecord),
//   utils.js (signedAssetScale, normalizeAngleDeg, clamp, makeId, toast, escapeHtml)
// Functions called back in canvas.js: send, log, requestRender, refreshGmUI, screenToWorld,
//   snap, myId, isGM, tool, updateCanvasCursor, activateDrawerTab

// ─── State ────────────────────────────────────────────────────────────────────

const packState = {
  packs: [],
  selectedPackId: "",
  tokens: [],
  search: "",
};

const ASSET_RECENT_USAGE_KEY = "warhamster:v1:asset_recent_usage";
const ASSET_KIND_OVERRIDE_KEY = "warhamster:v1:asset_kind_override";
const ASSET_FILTER_PRESET_KEY = "warhamster:v1:asset_filter_preset";
const ASSET_DEBUG_NET_KEY = "warhamster:v1:asset_debug_net";
const ASSET_SAVED_SETS_KEY = "warhamster:v1:asset_saved_sets";
const ASSET_SCOPE_KEY = "warhamster:v1:asset_scope";

function loadAssetRecentUsage() {
  try {
    const raw = localStorage.getItem(ASSET_RECENT_USAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return {};
    return data;
  } catch (_) {
    return {};
  }
}
function loadAssetKindOverrides() {
  try {
    const raw = localStorage.getItem(ASSET_KIND_OVERRIDE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return {};
    return data;
  } catch (_) {
    return {};
  }
}
function loadAssetFilterPresets() {
  try {
    const raw = localStorage.getItem(ASSET_FILTER_PRESET_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return {};
    return data;
  } catch (_) {
    return {};
  }
}
function loadAssetDebugNet() {
  try {
    return localStorage.getItem(ASSET_DEBUG_NET_KEY) === "1";
  } catch (_) {
    return false;
  }
}
function loadAssetSavedSets() {
  try {
    const raw = localStorage.getItem(ASSET_SAVED_SETS_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .map((item) => {
        const id = String(item?.id || "").trim();
        const name = String(item?.name || "").trim();
        const filters = item?.filters && typeof item.filters === "object" ? item.filters : null;
        if (!id || !name || !filters) return null;
        return { id, name, filters };
      })
      .filter(Boolean)
      .slice(0, 200);
  } catch (_) {
    return [];
  }
}
function loadAssetMoveLock() {
  try {
    return localStorage.getItem("warhamster:v1:lock_asset_move") === "1";
  } catch (_) {
    return false;
  }
}
function loadAssetScope() {
  try {
    return localStorage.getItem(ASSET_SCOPE_KEY) || "all";
  } catch (_) {
    return "all";
  }
}
function saveAssetScope(value) {
  try {
    localStorage.setItem(ASSET_SCOPE_KEY, String(value || "all"));
  } catch (_) {}
}

function normalizeAssetSortMode(value, fallback = "newest") {
  const raw = String(value || fallback).trim().toLowerCase();
  if (raw === "recent") return "newest";
  return ["newest", "largest", "name"].includes(raw) ? raw : fallback;
}

const assetState = {
  items: [],
  privatePacks: [],
  sessionSharedPacks: [],
  uiMode: "browse",
  filtersOpen: false,
  search: "",
  searchInput: "",
  searchDebounceMs: 160,
  folder: "",
  navCategory: "",
  navSubcategory: "",
  viewMode: "pieces",
  packFilter: loadAssetScope(),
  typeFilter: "all",
  alphaFilter: "all",
  sizeFilter: "all",
  sortMode: "newest",
  diagnostics: {},
  diagnosticsOrder: [],
  recentUsed: loadAssetRecentUsage(),
  recentVersion: 0,
  kindOverride: loadAssetKindOverrides(),
  filterPresets: loadAssetFilterPresets(),
  debugNet: loadAssetDebugNet(),
  savedSets: loadAssetSavedSets(),
  selectedSetId: "",
  placeMode: true,
  loaded: false,
  loading: false,
  error: "",
  packsLoading: false,
  packMetaSessionId: "",
  folderSummary: [],
  folderLoading: false,
  folderError: "",
  skipMissing: false,
  serverPageSize: 100,
  serverOffset: 0,
  serverHasMore: false,
  totalCount: 0,
  serverLoading: false,
  hasMore: false,
  lastRenderKey: "",
  lastRenderedCount: 0,
  requestSeq: 0,
  pendingQueryRefresh: false,
};

const ASSET_THUMB_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
let assetThumbObserver = null;
let assetSearchDebounceTimer = null;
let assetSuppressCardClick = false;
let mapPreviewAsset = null;
let mapPreviewSourceUrl = "";
let mapPreviewLoadSeq = 0;

// ─── Pack sanitization ────────────────────────────────────────────────────────

function sanitizePackToken(token, packId) {
  const id = String(token?.id || "").trim();
  const name = String(token?.name || id || "Token").trim() || "Token";
  const file = String(token?.file || "").trim();
  const directImageUrl = String(token?.image_url || token?.url_original || "").trim();
  const thumbUrl = String(token?.thumb_url || "").trim();
  const tags = Array.isArray(token?.tags) ? token.tags.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
  if (!id || (!file && !directImageUrl)) return null;
  const safePath = file
    ? file
        .replace(/^\/+/, "")
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/")
    : "";
  return {
    id,
    name,
    file,
    tags,
    image_url: directImageUrl || `/packs/${encodeURIComponent(packId)}/${safePath}`,
    thumb_url: thumbUrl || directImageUrl || `/packs/${encodeURIComponent(packId)}/${safePath}`,
  };
}

// ─── Asset permission checks ──────────────────────────────────────────────────

function canEditAssetLocal(asset) {
  if (!asset) return false;
  if (asset.locked) return false;
  if (isGM()) return true;
  if (state.lockdown) return false;
  if (state.allow_all_move) return true;
  return !!(asset.creator_id && asset.creator_id === myId());
}

function canDeleteAssetLocal(asset) {
  if (!asset) return false;
  if (isGM()) return true;
  if (state.lockdown) return false;
  if (asset.locked) return false;
  return !!(asset.creator_id && asset.creator_id === myId());
}

function isAssetInteractionLocked() {
  return !!ui.lockAssetMove && tool() === "move";
}

// ─── Asset editor helpers ─────────────────────────────────────────────────────

function assetResizePatch(asset, direction = 1) {
  const sx = signedAssetScale(asset?.scale_x, 1);
  const sy = signedAssetScale(asset?.scale_y, 1);
  const signX = sx < 0 ? -1 : 1;
  const signY = sy < 0 ? -1 : 1;
  const absX = Math.abs(sx);
  const absY = Math.abs(sy);
  if (!ui.snap) {
    const f = direction > 0 ? 1.25 : 0.8;
    return {
      scale_x: signX * clamp(absX * f, 0.05, 10),
      scale_y: signY * clamp(absY * f, 0.05, 10),
    };
  }
  const baseW = Math.max(8, Number(asset?.width || ui.gridSize));
  const cellsW = Math.max(1, Math.round((baseW * absX) / ui.gridSize));
  const nextCellsW = direction > 0 ? (cellsW + 1) : Math.max(1, cellsW - 1);
  const nextAbsX = clamp((nextCellsW * ui.gridSize) / baseW, 0.05, 10);
  const ratio = absY / Math.max(absX, 0.0001);
  const nextAbsY = clamp(nextAbsX * ratio, 0.05, 10);
  return {
    scale_x: signX * nextAbsX,
    scale_y: signY * nextAbsY,
  };
}

function applyAssetUpdate(assetId, patch, commit = true) {
  const current = state.assets.get(assetId);
  if (!current) return;
  const next = { ...current, ...patch };
  state.assets.set(assetId, next);
  requestRender();
  send("ASSET_INSTANCE_UPDATE", { id: assetId, ...patch, commit: !!commit });
}

function syncAssetCtxSliders() {
  const a = state.assets.get(selectedAssetId || "");
  const enabled = !!a;
  if (assetScaleSliderEl) assetScaleSliderEl.disabled = !enabled;
  if (assetRotateSliderEl) assetRotateSliderEl.disabled = !enabled;
  if (!enabled) {
    if (assetScaleValueEl) assetScaleValueEl.textContent = "--";
    if (assetRotateValueEl) assetRotateValueEl.textContent = "--";
    return;
  }
  const sx = Math.abs(signedAssetScale(a.scale_x, 1));
  const scalePct = Math.round(clamp(sx * 100, 5, 400));
  const rotDeg = Math.round(clamp(normalizeAngleDeg(a.rotation || 0), -180, 180));
  if (assetScaleSliderEl) assetScaleSliderEl.value = String(scalePct);
  if (assetRotateSliderEl) assetRotateSliderEl.value = String(rotDeg);
  if (assetScaleValueEl) assetScaleValueEl.textContent = `${scalePct}%`;
  if (assetRotateValueEl) assetRotateValueEl.textContent = `${rotDeg}°`;
}

// ─── Map preview modal ────────────────────────────────────────────────────────

function openMapPreview(asset) {
  const normalized = normalizePackBackedRecord(asset || {});
  const name = String(normalized?.name || "Asset").trim() || "Asset";
  const width = Math.max(0, Number(normalized?.width || 0));
  const height = Math.max(0, Number(normalized?.height || 0));
  const dims = width > 0 && height > 0 ? `${width}x${height}` : "unknown size";
  const ext = assetFileExt(normalized).toUpperCase() || "IMG";
  const alpha = assetHasAlphaGuess(normalized) ? "alpha" : "opaque";
  const slug = String(normalized?.pack_slug || "").trim() || "uploads";
  const sharedBadge = normalized?.shared_in_session ? " • session-shared" : "";
  const folder = String(normalized?.folder_path || "/");
  const src = withAssetLibSrc(assetPreviewUrl(normalized));
  const loadSeq = ++mapPreviewLoadSeq;
  mapPreviewAsset = normalized;
  mapPreviewSourceUrl = src || "";
  if (mapPreviewTitleEl) mapPreviewTitleEl.textContent = name;
  if (mapPreviewMetaEl) mapPreviewMetaEl.textContent = `${dims} • ${ext} • ${alpha} • ${slug}${sharedBadge}`;
  if (mapPreviewPathEl) mapPreviewPathEl.textContent = folder;
  if (mapPreviewImageEl) {
    mapPreviewImageEl.onload = () => {
      if (loadSeq !== mapPreviewLoadSeq) return;
    };
    mapPreviewImageEl.onerror = () => {
      if (loadSeq !== mapPreviewLoadSeq) return;
      toast("Map preview failed to load.");
    };
    mapPreviewImageEl.src = src || ASSET_THUMB_PLACEHOLDER;
  }
  const gm = isGM();
  if (mapPreviewSetBgBtn) mapPreviewSetBgBtn.disabled = !gm;
  if (mapPreviewClearBgBtn) mapPreviewClearBgBtn.disabled = !gm;
  if (mapPreviewBackdrop) mapPreviewBackdrop.classList.remove("hidden");
  if (mapPreviewModal) mapPreviewModal.classList.remove("hidden");
}

function closeMapPreview() {
  mapPreviewLoadSeq += 1;
  mapPreviewAsset = null;
  mapPreviewSourceUrl = "";
  if (mapPreviewModal) mapPreviewModal.classList.add("hidden");
  if (mapPreviewBackdrop) mapPreviewBackdrop.classList.add("hidden");
  if (mapPreviewImageEl) {
    mapPreviewImageEl.onload = null;
    mapPreviewImageEl.onerror = null;
    mapPreviewImageEl.src = "";
  }
}

// ─── Pack grid ────────────────────────────────────────────────────────────────

function renderPackGrid() {
  const q = packState.search.toLowerCase().trim();
  const rows = packState.tokens.filter((t) => {
    if (!q) return true;
    const hay = `${t.name} ${t.tags.join(" ")}`.toLowerCase();
    return hay.includes(q);
  });

  if (!rows.length) {
    packGridEl.innerHTML = `<div style="opacity:.75; grid-column:1/-1;">(no tokens match)</div>`;
    return;
  }

  packGridEl.innerHTML = rows.map((t, idx) => `
    <button
      data-pack-idx="${idx}"
      style="padding:6px; border:1px solid rgba(255,255,255,0.14); background:rgba(255,255,255,0.03); color:#eee; text-align:center;"
      title="${escapeHtml(t.name)} (click: token, Alt+click: asset)">
      <div style="width:100%; aspect-ratio:1/1; border-radius:8px; overflow:hidden; background:#1a1a1a; display:flex; align-items:center; justify-content:center;">
        <img src="${escapeHtml(t.image_url)}" alt="${escapeHtml(t.name)}" style="width:100%; height:100%; object-fit:cover;">
      </div>
      <div style="margin-top:6px; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(t.name)}</div>
    </button>
  `).join("");

  packGridEl.querySelectorAll("button[data-pack-idx]").forEach((btn) => {
    const idx = Number(btn.getAttribute("data-pack-idx"));
    const t = rows[idx];
    if (!t) return;

    btn.onclick = (e) => {
      if (e && e.altKey) {
        spawnPackAsset(t);
        return;
      }
      spawnPackToken(t);
    };
    btn.onpointerdown = (e) => {
      if (e.button !== 0) return;
      dragSpawn = { ...t, size_scale: ui.tokenSpawnScale, kind: "token" };
      dragSpawnWorld = null;
      dragSpawnOverCanvas = false;
      e.preventDefault();
    };
  });
}

async function loadPack(packId) {
  if (!packId) {
    packState.tokens = [];
    renderPackGrid();
    return;
  }
  try {
    const sessionId = currentAssetSessionId();
    const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
    const manifest = await apiGet(`/api/packs/${encodeURIComponent(packId)}${qs}`);
    const tokens = [];
    for (const token of (manifest.tokens || [])) {
      const normalized = sanitizePackToken(token, packId);
      if (normalized) tokens.push(normalized);
    }
    packState.tokens = tokens;
    renderPackGrid();
  } catch (e) {
    packState.tokens = [];
    packGridEl.innerHTML = `<div style="color:#ffb3b3; grid-column:1/-1;">Pack load failed</div>`;
    log(`PACK LOAD ERROR: ${e.message || e}`);
  }
}

async function refreshPacks() {
  try {
    const sessionId = currentAssetSessionId();
    const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
    const data = await apiGet(`/api/packs${qs}`);
    const packs = Array.isArray(data.packs) ? data.packs : [];
    packState.packs = packs;
    const existing = new Set(packs.map((p) => p.pack_id));
    if (!existing.has(packState.selectedPackId)) {
      packState.selectedPackId = packs[0]?.pack_id || "";
    }
    packSelectEl.innerHTML = packs.map((p) => {
      const typeLabel = String(p?.pack_scope || "") === "official" ? "Official" : assetPackAccessLabel(p?.access_source || "");
      return (
      `<option value="${p.pack_id}">${p.name} (${p.token_count})${typeLabel ? ` · ${typeLabel}` : ""}</option>`
      );
    }).join("") || `<option value="">(no packs)</option>`;
    packSelectEl.value = packState.selectedPackId || "";
    await loadPack(packState.selectedPackId);
  } catch (e) {
    packState.packs = [];
    packState.tokens = [];
    packSelectEl.innerHTML = `<option value="">(packs unavailable)</option>`;
    packGridEl.innerHTML = `<div style="color:#ffb3b3; grid-column:1/-1;">Packs load failed</div>`;
    log(`PACKS ERROR: ${e.message || e}`);
  }
}

// ─── Asset classification ─────────────────────────────────────────────────────

function assetFileExt(asset) {
  const mime = String(asset?.mime || "").toLowerCase();
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  const raw = String(asset?.url_original || asset?.image_url || "");
  const m = raw.match(/\.([a-z0-9]+)(?:$|[?#])/i);
  if (!m) return "";
  const ext = String(m[1] || "").toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

function assetHasAlphaGuess(asset) {
  const ext = assetFileExt(asset);
  if (ext === "png" || ext === "webp" || ext === "gif") return true;
  if (ext === "jpg") return false;
  return false;
}

function assetSizeBucket(asset) {
  const w = Math.max(0, Number(asset?.width || 0));
  const h = Math.max(0, Number(asset?.height || 0));
  const m = Math.max(w, h);
  if (m <= 256) return "tiny";
  if (m <= 512) return "small";
  if (m <= 1024) return "medium";
  if (m <= 2048) return "large";
  return "huge";
}

function assetFilterSourceKey(value) {
  const v = String(value || "all").trim();
  if (!v || v === "all") return "all";
  if (v === "upload") return "upload";
  return `pack:${v}`;
}

function assetOverrideKey(asset) {
  const source = String(asset?.source || "").trim().toLowerCase();
  const aid = String(asset?.asset_id || "").trim();
  const packId = String(asset?.pack_id || "").trim();
  const packSlug = String(asset?.pack_slug || "").trim();
  if (source === "upload" && aid) return `upload:${aid}`;
  if (source === "pack" && aid) return `private:${packId || packSlug || "unknown"}:${aid}`;
  if (source === "pack") {
    const pathish = String(asset?.file || asset?.url_original || asset?.image_url || "").trim();
    if (pathish) return `pack:${packId || packSlug || "unknown"}:${pathish}`;
  }
  if (aid) return `asset:${aid}`;
  const fallback = String(asset?.url_original || asset?.image_url || "").trim();
  return fallback ? `url:${fallback}` : "";
}

function assetLegacyOverrideKeys(asset) {
  const keys = [];
  const source = String(asset?.source || "").trim().toLowerCase();
  const aid = String(asset?.asset_id || "").trim();
  const packSlugLower = String(asset?.pack_slug || "").trim().toLowerCase();
  if (source === "upload" && aid) keys.push(`upload:${aid}`);
  if (source === "pack" && aid) keys.push(`private:${packSlugLower || "unknown"}:${aid}`);
  if (source === "pack") {
    const pathishLower = String(asset?.file || asset?.url_original || asset?.image_url || "").trim().toLowerCase();
    if (pathishLower) keys.push(`pack:${packSlugLower || "unknown"}:${pathishLower}`);
  }
  const fallbackLower = String(asset?.url_original || asset?.image_url || "").trim().toLowerCase();
  if (fallbackLower) keys.push(`url:${fallbackLower}`);
  return keys;
}

function getAssetKindOverride(asset) {
  const key = assetOverrideKey(asset);
  if (key) {
    const raw = String(assetState.kindOverride[key] || "").trim().toLowerCase();
    if (raw === "map" || raw === "piece" || raw === "unknown") return raw;
  }
  for (const legacyKey of assetLegacyOverrideKeys(asset)) {
    if (!legacyKey || (key && legacyKey === key)) continue;
    const raw = String(assetState.kindOverride[legacyKey] || "").trim().toLowerCase();
    if (raw !== "map" && raw !== "piece" && raw !== "unknown") continue;
    if (key) {
      assetState.kindOverride[key] = raw;
      delete assetState.kindOverride[legacyKey];
      persistAssetKindOverrides();
    }
    return raw;
  }
  return "";
}

function persistAssetKindOverrides() {
  try {
    localStorage.setItem(ASSET_KIND_OVERRIDE_KEY, JSON.stringify(assetState.kindOverride));
  } catch (_) {}
}

function setAssetKindOverride(asset, nextKind) {
  const key = assetOverrideKey(asset);
  if (!key) return;
  const kind = String(nextKind || "").trim().toLowerCase();
  if (kind === "map" || kind === "piece" || kind === "unknown") {
    assetState.kindOverride[key] = kind;
  } else {
    delete assetState.kindOverride[key];
  }
  persistAssetKindOverrides();
  renderAssetGrid();
}

function assetKind(asset) {
  const override = getAssetKindOverride(asset);
  if (override) return override;
  const name = `${asset?.name || ""} ${asset?.folder_path || ""}`.toLowerCase();
  const w = Math.max(0, Number(asset?.width || 0));
  const h = Math.max(0, Number(asset?.height || 0));
  const area = w * h;
  const hasAlpha = assetHasAlphaGuess(asset);
  if (!hasAlpha && (Math.max(w, h) >= 1500 || area >= 2_000_000)) return "map";
  if (/\b(map|battlemap|scene|terrain)\b/.test(name)) return "map";
  if (hasAlpha && Math.max(w, h) <= 1500) return "piece";
  if (/\b(tile|wall|prop|token|tree|rock|door|piece|object|debris)\b/.test(name)) return "piece";
  return "unknown";
}

function assetPackAccessLabel(source) {
  const normalized = String(source || "").trim();
  if (normalized === "official") return "Official";
  if (normalized === "owned") return "Owned";
  if (normalized === "session_shared") return "Shared via Session";
  if (normalized === "direct_entitlement") return "Direct Access";
  return "";
}

function assetPackSecondaryAccessNote(entity) {
  const primary = String(entity?.access_source || "").trim();
  const sources = Array.isArray(entity?.access_sources) ? entity.access_sources : [];
  const extras = sources.filter((source) => source && source !== primary);
  if (!extras.length) return "";
  return `Also ${extras.map(assetPackAccessLabel).filter(Boolean).join(" · ")}`;
}

// ─── Asset search ─────────────────────────────────────────────────────────────

function parseAssetSearch(rawSearch) {
  const raw = String(rawSearch || "").trim();
  const out = {
    textTerms: [],
    tags: [],
    pack: "",
    type: "",
    alpha: "",
    tokens: [],
    raw,
  };
  if (!raw) return out;
  for (const token of raw.split(/\s+/)) {
    if (!token) continue;
    const m = token.match(/^([a-z]+):(.*)$/i);
    if (!m) {
      out.textTerms.push(token.toLowerCase());
      continue;
    }
    const key = String(m[1] || "").toLowerCase();
    const value = String(m[2] || "").trim().toLowerCase();
    if (!value) continue;
    if (key === "tag") out.tags.push(value);
    else if (key === "pack") out.pack = value;
    else if (key === "type") out.type = value === "jpeg" ? "jpg" : value;
    else if (key === "alpha") out.alpha = value;
    else out.textTerms.push(token.toLowerCase());
    if (key === "tag" || key === "pack" || key === "type" || key === "alpha") {
      out.tokens.push({ key, value, raw: `${key}:${value}` });
    }
  }
  return out;
}

function updateAssetSearchFromParsed(parsed, removeIdx = -1) {
  const out = [];
  if (parsed && Array.isArray(parsed.tokens)) {
    parsed.tokens.forEach((t, idx) => {
      if (idx === removeIdx) return;
      out.push(`${t.key}:${t.value}`);
    });
  }
  if (parsed && Array.isArray(parsed.textTerms)) out.push(...parsed.textTerms);
  assetState.searchInput = out.join(" ").trim();
  assetState.search = assetState.searchInput;
  if (assetSearchInputEl) assetSearchInputEl.value = assetState.searchInput;
}

function syncAssetNavSelectionFromFolder() {
  const folder = String(assetState.folder || "").trim().replace(/^\/+|\/+$/g, "");
  if (!folder) {
    assetState.navSubcategory = "";
    return;
  }
  assetState.navCategory = inferAssetCategory(folder);
  assetState.navSubcategory = folder;
}

function renderAssetSearchMeta(parsed, conflictHints = []) {
  if (assetSearchChipsEl) {
    const chips = [];
    const toks = Array.isArray(parsed?.tokens) ? parsed.tokens : [];
    toks.forEach((t, idx) => {
      chips.push(`
        <button type="button" data-asset-chip-idx="${idx}" style="font-size:11px; border:1px solid rgba(255,255,255,0.22); background:rgba(255,255,255,0.06); color:#eee; border-radius:999px; padding:2px 8px;">
          ${escapeHtml(`${t.key}:${t.value}`)} ×
        </button>
      `);
    });
    assetSearchChipsEl.innerHTML = chips.join("");
    assetSearchChipsEl.querySelectorAll("[data-asset-chip-idx]").forEach((btn) => {
      btn.onclick = () => {
        const idx = Number(btn.getAttribute("data-asset-chip-idx"));
        updateAssetSearchFromParsed(parsed, idx);
        void applyAssetQueryChange({ search: assetState.searchInput, searchInput: assetState.searchInput });
      };
    });
  }
  if (assetSearchHintEl) {
    if (Array.isArray(conflictHints) && conflictHints.length) {
      assetSearchHintEl.textContent = `Advanced query tokens active: ${conflictHints.join(" | ")}`;
    } else if (Array.isArray(parsed?.tokens) && parsed.tokens.length) {
      assetSearchHintEl.textContent = "Advanced query tokens are active.";
    } else {
      assetSearchHintEl.textContent = "";
    }
  }
}

function renderAssetMode() {
  const browse = assetState.uiMode !== "manage";
  if (assetModeBrowseBtnEl) assetModeBrowseBtnEl.classList.toggle("active", browse);
  if (assetModeManageBtnEl) assetModeManageBtnEl.classList.toggle("active", !browse);
  if (assetBrowseViewEl) assetBrowseViewEl.classList.toggle("hidden", !browse);
  if (assetManageViewEl) assetManageViewEl.classList.toggle("hidden", browse);
}

function renderAssetAdvancedFilters() {
  if (!assetAdvancedFiltersEl || !assetFiltersToggleBtnEl) return;
  assetAdvancedFiltersEl.hidden = !assetState.filtersOpen;
  assetFiltersToggleBtnEl.textContent = assetState.filtersOpen ? "Hide Filters" : "More Filters";
  assetFiltersToggleBtnEl.classList.toggle("primary", assetState.filtersOpen);
}

function availableAssetPackOptions() {
  const packs = Array.isArray(assetState.privatePacks) ? assetState.privatePacks : [];
  return packs
    .filter((pack) => String(pack?.content_type || "asset_pack") === "asset_pack")
    .map((pack) => ({
      value: String(pack?.slug || "").trim(),
      label: String(pack?.name || pack?.slug || "Pack").trim() || "Pack",
      shared: !!pack?.shared_in_session,
      accessSource: String(pack?.access_source || "").trim(),
    }))
    .filter((pack) => pack.value)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function normalizeAssetPackFilter(value) {
  const raw = String(value || "all").trim();
  if (!raw || raw === "all" || raw === "upload") return raw || "all";
  const available = new Set(availableAssetPackOptions().map((pack) => pack.value));
  return available.has(raw) ? raw : "all";
}

function effectiveAssetBrowseQuery() {
  const visibleSearch = String(assetState.searchInput || assetState.search || "").trim();
  if (assetState.search !== visibleSearch) assetState.search = visibleSearch;
  const parsed = parseAssetSearch(visibleSearch);
  const rawAlpha = String(parsed.alpha || assetState.alphaFilter || "all").trim().toLowerCase();
  const normalizedAlpha = rawAlpha === "yes" || rawAlpha === "true" || rawAlpha === "1"
    ? "yes"
    : rawAlpha === "no" || rawAlpha === "false" || rawAlpha === "0"
      ? "no"
      : "all";
  const rawKind = String(assetState.viewMode || "pieces").trim().toLowerCase();
  const rawSort = normalizeAssetSortMode(assetState.sortMode);
  return {
    parsed,
    q: parsed.textTerms.join(" ").trim(),
    tag: parsed.tags[0] || "",
    folder: String(assetState.folder || "").trim(),
    pack: normalizeAssetPackFilter(parsed.pack || assetState.packFilter),
    kind: ["pieces", "maps", "unknown", "all"].includes(rawKind) ? rawKind : "pieces",
    type: parsed.type || String(assetState.typeFilter || "all").trim().toLowerCase() || "all",
    alpha: normalizedAlpha,
    sort: rawSort,
  };
}

function buildAssetApiQuery(offset = 0) {
  const query = effectiveAssetBrowseQuery();
  const params = new URLSearchParams();
  params.set("src", "assetlib");
  params.set("lite", "1");
  params.set("limit", String(assetState.serverPageSize));
  params.set("offset", String(Math.max(0, Number(offset || 0))));
  if (query.q) params.set("q", query.q);
  if (query.tag) params.set("tag", query.tag);
  if (query.folder) params.set("folder", query.folder);
  if (query.pack && query.pack !== "all") params.set("pack", query.pack);
  if (query.kind && query.kind !== "all") params.set("kind", query.kind);
  if (query.type && query.type !== "all") params.set("type", query.type);
  if (query.alpha && query.alpha !== "all") params.set("alpha", query.alpha);
  if (query.sort) params.set("sort", query.sort);
  if (assetState.skipMissing) params.set("skip_missing", "1");
  const sessionId = currentAssetSessionId();
  if (sessionId) params.set("session_id", sessionId);
  return params.toString();
}

function buildAssetFolderApiQuery() {
  // The folder tree is for scope navigation, not search results. Omit q/tag so
  // that typing in the search box doesn't rebuild the tree with filtered counts.
  const query = effectiveAssetBrowseQuery();
  const params = new URLSearchParams();
  if (query.pack && query.pack !== "all") params.set("pack", query.pack);
  if (query.kind && query.kind !== "all") params.set("kind", query.kind);
  if (query.type && query.type !== "all") params.set("type", query.type);
  if (query.alpha && query.alpha !== "all") params.set("alpha", query.alpha);
  if (assetState.skipMissing) params.set("skip_missing", "1");
  const sessionId = currentAssetSessionId();
  if (sessionId) params.set("session_id", sessionId);
  return params.toString();
}

function resetAssetResults() {
  assetState.items = [];
  assetState.serverOffset = 0;
  assetState.serverHasMore = false;
  assetState.totalCount = 0;
  assetState.hasMore = false;
  assetState.lastRenderKey = "";
  assetState.lastRenderedCount = 0;
  assetState.error = "";
}

async function fetchAssetFolders() {
  assetState.folderLoading = true;
  assetState.folderError = "";
  renderAssetFolderTree();
  try {
    const data = await apiGet(`/api/assets/folders?${buildAssetFolderApiQuery()}`);
    assetState.folderSummary = Array.isArray(data?.folders) ? data.folders : [];
  } catch (e) {
    assetState.folderSummary = [];
    assetState.folderError = String(e?.message || e || "Folder load failed");
  } finally {
    assetState.folderLoading = false;
    renderAssetFolderTree();
  }
}

async function fetchAssetResults({ append = false, refreshPackMeta = false, refreshFolders = true } = {}) {
  if (assetState.serverLoading) {
    if (!append) assetState.pendingQueryRefresh = true;
    return;
  }
  if (append && !assetState.serverHasMore) return;
  const offset = append ? assetState.serverOffset : 0;
  const requestSeq = ++assetState.requestSeq;
  assetState.serverLoading = true;
  if (!append) {
    assetState.error = "";
    if (!assetState.loaded) assetState.loading = true;
  }
  renderAssetGrid();
  renderAssetFolderTree();
  try {
    if (refreshPackMeta) await refreshAssetSessionPackData();
    if (!append && refreshFolders) void fetchAssetFolders();
    const data = await apiGet(`/api/assets?${buildAssetApiQuery(offset)}`);
    if (requestSeq !== assetState.requestSeq) return;
    const incoming = Array.isArray(data?.assets) ? data.assets.map((asset) => normalizePackBackedRecord(asset)) : [];
    assetState.items = append ? [...assetState.items, ...incoming] : incoming;
    assetState.serverOffset = Number(data?.next_offset || (offset + incoming.length));
    assetState.serverHasMore = !!data?.has_more;
    assetState.totalCount = Number(data?.total_count || assetState.items.length || 0);
    assetState.loaded = true;
    assetState.loading = false;
    assetState.error = "";
    resetAssetDiagnostics();
    const metadataReceivedAt = Date.now();
    for (const item of assetState.items) {
      recordAssetDiagnostic(item, { metadataReceivedAt });
    }
    refreshAssetFilterOptions();
    renderAssetSavedSets();
    renderAssetFolderTree();
    renderAssetGrid();
  } catch (e) {
    if (requestSeq !== assetState.requestSeq) return;
    if (!append) resetAssetResults();
    assetState.loaded = false;
    assetState.loading = false;
    assetState.error = String(e?.message || e || "Asset load failed");
    renderAssetFolderTree();
    renderAssetGrid();
    log(`ASSETS ERROR: ${assetState.error}`);
  } finally {
    if (requestSeq === assetState.requestSeq) {
      assetState.serverLoading = false;
      assetState.loading = false;
      renderAssetGrid();
      if (assetState.pendingQueryRefresh) {
        assetState.pendingQueryRefresh = false;
        void fetchAssetResults({ append: false });
      }
    }
  }
}

function softResetAssetResults() {
  assetState.serverOffset = 0;
  assetState.serverHasMore = false;
  assetState.hasMore = false;
  assetState.lastRenderKey = "";
  assetState.lastRenderedCount = 0;
  assetState.error = "";
}

async function applyAssetQueryChange(patch = {}, { refreshFolders = true, preserveItems = false } = {}) {
  Object.keys(patch).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(assetState, key)) assetState[key] = patch[key];
  });
  syncAssetNavSelectionFromFolder();
  assetState.packFilter = normalizeAssetPackFilter(assetState.packFilter);
  if (preserveItems) softResetAssetResults();
  else resetAssetResults();
  renderAssetAdvancedFilters();
  renderAssetMode();
  renderAssetSessionSharePanel();
  syncAssetFilterControls();
  renderAssetFolderTree();
  renderAssetGrid();
  await fetchAssetResults({ refreshPackMeta: false, append: false, refreshFolders });
}

function closeAssetKindMenus(exceptMenu = null) {
  if (!assetGridEl) return;
  assetGridEl.querySelectorAll("[data-asset-kind-menu]").forEach((menu) => {
    if (exceptMenu && menu === exceptMenu) return;
    menu.style.display = "none";
  });
}

function assetSearchScore(asset, parsed) {
  if (!parsed || (!parsed.raw && !parsed.textTerms.length && !parsed.tags.length)) return 0;
  const name = String(asset?.name || "").toLowerCase();
  const folder = String(asset?.folder_path || "").toLowerCase();
  const tags = Array.isArray(asset?.tags) ? asset.tags.map((x) => String(x).toLowerCase()) : [];
  const pack = String(asset?.pack_slug || "").toLowerCase();
  if (parsed.pack && !pack.includes(parsed.pack)) return -1;
  if (parsed.type) {
    const ext = assetFileExt(asset);
    if (ext !== parsed.type) return -1;
  }
  if (parsed.alpha) {
    const hasAlpha = assetHasAlphaGuess(asset);
    if ((parsed.alpha === "yes" || parsed.alpha === "true") && !hasAlpha) return -1;
    if ((parsed.alpha === "no" || parsed.alpha === "false") && hasAlpha) return -1;
  }
  for (const tag of parsed.tags) {
    if (!tags.some((t) => t.includes(tag))) return -1;
  }
  let score = 0;
  for (const term of parsed.textTerms) {
    let termScore = 0;
    if (name === term) termScore = Math.max(termScore, 120);
    else if (name.startsWith(term)) termScore = Math.max(termScore, 90);
    else if (name.includes(term)) termScore = Math.max(termScore, 70);
    if (tags.some((t) => t === term)) termScore = Math.max(termScore, 85);
    else if (tags.some((t) => t.includes(term))) termScore = Math.max(termScore, 65);
    if (folder.includes(term)) termScore = Math.max(termScore, 45);
    if (pack.includes(term)) termScore = Math.max(termScore, 25);
    if (!termScore) return -1;
    score += termScore;
  }
  if (!parsed.textTerms.length && (parsed.tags.length || parsed.pack || parsed.type || parsed.alpha)) score += 1;
  return score;
}

// ─── Asset usage & diagnostics ────────────────────────────────────────────────

function assetUsageKey(asset) {
  return String(asset?.asset_id || asset?.id || asset?.url_original || asset?.image_url || "");
}

function assetByUsageKey(key) {
  const raw = String(key || "").trim();
  if (!raw) return null;
  for (const item of assetState.items) {
    if (assetUsageKey(item) === raw) return item;
  }
  return null;
}

function markAssetRecentlyUsed(asset) {
  const key = assetUsageKey(asset);
  if (!key) return;
  assetState.recentUsed[key] = Date.now();
  const entries = Object.entries(assetState.recentUsed).sort((a, b) => Number(b[1]) - Number(a[1]));
  assetState.recentUsed = Object.fromEntries(entries.slice(0, 1000));
  assetState.recentVersion += 1;
  try {
    localStorage.setItem(ASSET_RECENT_USAGE_KEY, JSON.stringify(assetState.recentUsed));
  } catch (_) {}
  if (isAssetsTabActive()) renderAssetRecentStrip();
}

function currentAssetSessionId() {
  return String(playSessionState.id || "").trim();
}

function resetAssetDiagnostics() {
  assetState.diagnostics = {};
  assetState.diagnosticsOrder = [];
  renderAssetDebugSummary();
}

function recordAssetDiagnostic(asset, patch = {}) {
  const key = assetUsageKey(asset);
  if (!key) return;
  const current = assetState.diagnostics[key] || {
    id: key,
    name: String(asset?.name || "Asset"),
    pack: String(asset?.pack_slug || "").trim() || "uploads",
  };
  assetState.diagnostics[key] = { ...current, ...patch };
  assetState.diagnosticsOrder = [key, ...assetState.diagnosticsOrder.filter((entry) => entry !== key)].slice(0, 10);
  if (assetState.debugNet) renderAssetDebugSummary();
}

function renderAssetDebugSummary() {
  if (!assetDebugSummaryEl) return;
  if (!assetState.debugNet) {
    assetDebugSummaryEl.style.display = "none";
    assetDebugSummaryEl.innerHTML = "";
    return;
  }
  const rows = assetState.diagnosticsOrder
    .map((key) => assetState.diagnostics[key])
    .filter(Boolean)
    .map((entry) => {
      const metaAt = Number(entry.metadataReceivedAt || 0);
      const requestAt = Number(entry.requestStartAt || 0);
      const loadAt = Number(entry.imageLoadedAt || 0);
      const visibleAt = Number(entry.firstVisibleAt || 0);
      const requestLag = metaAt && requestAt ? Math.max(0, requestAt - metaAt) : 0;
      const loadLag = requestAt && loadAt ? Math.max(0, loadAt - requestAt) : 0;
      const visibleLag = metaAt && visibleAt ? Math.max(0, visibleAt - metaAt) : 0;
      return `
        <div style="display:flex; gap:8px; align-items:flex-start; margin:3px 0; flex-wrap:wrap;">
          <span style="font-weight:600;">${escapeHtml(String(entry.name || "Asset"))}</span>
          <span style="opacity:.7;">${escapeHtml(String(entry.pack || "uploads"))}</span>
          <span style="opacity:.85;">meta->req ${requestLag}ms</span>
          <span style="opacity:.85;">req->load ${loadLag}ms</span>
          <span style="opacity:.85;">meta->visible ${visibleLag}ms</span>
        </div>
      `;
    });
  assetDebugSummaryEl.style.display = "block";
  assetDebugSummaryEl.innerHTML = rows.length
    ? `<div style="font-weight:600; margin-bottom:4px;">Recent Asset Timing</div>${rows.join("")}`
    : `<div style="opacity:.75;">Recent Asset Timing will appear here once previews start loading.</div>`;
}

// ─── Asset session sharing ────────────────────────────────────────────────────

function assetSessionQuery() {
  const sessionId = currentAssetSessionId();
  return sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : "";
}

function resetAssetSessionPackState() {
  assetState.privatePacks = [];
  assetState.sessionSharedPacks = [];
  assetState.packMetaSessionId = "";
  renderAssetSessionSharePanel();
}

async function refreshAssetSessionPackData() {
  const sessionId = currentAssetSessionId();
  if (assetState.packsLoading && assetState.packMetaSessionId === sessionId) return;
  assetState.packsLoading = true;
  assetState.packMetaSessionId = sessionId;
  try {
    const [privateData, sharedData] = await Promise.all([
      apiGet(sessionId ? `/api/private-packs?session_id=${encodeURIComponent(sessionId)}` : "/api/private-packs"),
      sessionId
        ? apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/shared-packs`)
        : Promise.resolve({ packs: [] }),
    ]);
    assetState.privatePacks = Array.isArray(privateData?.packs) ? privateData.packs : [];
    assetState.sessionSharedPacks = Array.isArray(sharedData?.packs) ? sharedData.packs : [];
  } catch (e) {
    console.warn("asset session packs refresh failed", e);
    assetState.privatePacks = [];
    assetState.sessionSharedPacks = [];
  } finally {
    assetState.packsLoading = false;
    refreshAssetFilterOptions();
    syncAssetFilterControls();
    renderAssetSessionSharePanel();
  }
}

async function toggleSessionSharedPack(packId, enabled) {
  const sessionId = currentAssetSessionId();
  if (!sessionId || !packId) return;
  try {
    if (enabled) {
      await apiPost(`/api/sessions/${encodeURIComponent(sessionId)}/shared-packs/${encodeURIComponent(packId)}`, {});
    } else {
      await apiDelete(`/api/sessions/${encodeURIComponent(sessionId)}/shared-packs/${encodeURIComponent(packId)}`);
    }
    await Promise.all([refreshAssetSessionPackData(), refreshAssetsPanel()]);
  } catch (e) {
    log(`SHARED PACK ERROR: ${e.message || e}`);
    toast(enabled ? "Could not share pack to session." : "Could not unshare pack from session.");
  }
}

async function shareAllSessionPrivatePacks() {
  const sessionId = currentAssetSessionId();
  if (!sessionId) return;
  const privatePacks = Array.isArray(assetState.privatePacks) ? assetState.privatePacks : [];
  const pending = privatePacks
    .filter((pack) => !pack?.shared_in_session)
    .map((pack) => Number(pack?.pack_id || 0))
    .filter((packId) => packId > 0);
  if (!pending.length) {
    toast("All available packs are already shared.");
    return;
  }
  try {
    if (assetSessionShareAllBtnEl) assetSessionShareAllBtnEl.disabled = true;
    for (const packId of pending) {
      await apiPost(`/api/sessions/${encodeURIComponent(sessionId)}/shared-packs/${encodeURIComponent(packId)}`, {});
    }
    await Promise.all([refreshAssetSessionPackData(), refreshAssetsPanel()]);
    toast(`Shared ${pending.length} pack${pending.length === 1 ? "" : "s"} to this session.`);
  } catch (e) {
    log(`SHARE ALL PACKS ERROR: ${e.message || e}`);
    toast("Could not share all packs to session.");
  } finally {
    if (assetSessionShareAllBtnEl) assetSessionShareAllBtnEl.disabled = false;
  }
}

function renderAssetSessionSharePanel() {
  if (!assetSessionShareBoxEl || !assetSessionShareSummaryEl || !assetSessionSharedListEl || !assetSessionManageWrapEl || !assetSessionManageListEl) return;
  const sessionId = currentAssetSessionId();
  if (!sessionId) {
    assetSessionShareBoxEl.style.display = "none";
    assetSessionShareSummaryEl.textContent = "No session attached.";
    assetSessionSharedListEl.innerHTML = "";
    assetSessionManageWrapEl.style.display = "none";
    assetSessionManageListEl.innerHTML = "";
    if (assetSessionShareAllBtnEl) assetSessionShareAllBtnEl.disabled = true;
    return;
  }
  assetSessionShareBoxEl.style.display = "block";
  const canManageSession = ["gm", "co_gm"].includes(String(playSessionState.user_role || ""));
  const sharedPacks = Array.isArray(assetState.sessionSharedPacks) ? assetState.sessionSharedPacks : [];
  const privatePacks = Array.isArray(assetState.privatePacks) ? assetState.privatePacks : [];
  if (assetSessionShareAllBtnEl) {
    const shareableCount = privatePacks.filter((pack) => !pack?.shared_in_session).length;
    assetSessionShareAllBtnEl.disabled = !canManageSession || !shareableCount || assetState.packsLoading;
    assetSessionShareAllBtnEl.textContent = shareableCount ? `Share All Packs (${shareableCount})` : "All Packs Shared";
  }
  assetSessionShareSummaryEl.textContent = sharedPacks.length
    ? `${sharedPacks.length} pack${sharedPacks.length === 1 ? "" : "s"} shared in ${playSessionState.name || "this session"}.`
    : `No packs are shared in ${playSessionState.name || "this session"} yet.`;
  assetSessionSharedListEl.innerHTML = sharedPacks.length
    ? sharedPacks.map((pack) => `
        <div style="display:flex; align-items:center; gap:6px; border:1px solid rgba(255,255,255,0.12); border-radius:999px; padding:4px 8px; font-size:11px;">
          <span style="font-weight:600;">${escapeHtml(String(pack.name || pack.slug || "Pack"))}</span>
          <span style="opacity:.75;">${escapeHtml(String(pack.content_type || "asset_pack") === "token_pack" ? "Token" : "Asset")}</span>
          <span style="opacity:.65;">${escapeHtml(String(pack.slug || ""))}</span>
        </div>
      `).join("")
    : `<div style="font-size:11px; opacity:.7;">Players only see pack assets here after a GM or co-GM shares them.</div>`;
  if (!canManageSession) {
    assetSessionManageWrapEl.style.display = "none";
    assetSessionManageListEl.innerHTML = "";
    return;
  }
  assetSessionManageWrapEl.style.display = "block";
  assetSessionManageListEl.innerHTML = privatePacks.length
    ? privatePacks.map((pack) => {
        const packId = Number(pack?.pack_id || 0);
        const shared = !!pack?.shared_in_session;
        const accessLabel = assetPackAccessLabel(pack?.access_source || (shared ? "session_shared" : ""));
        return `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; border:1px solid rgba(255,255,255,0.1); border-radius:8px; padding:6px 8px;">
            <div style="min-width:0;">
              <div style="font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(String(pack?.name || pack?.slug || "Pack"))}</div>
              <div style="font-size:11px; opacity:.7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(String(pack?.slug || ""))} • ${escapeHtml(String(pack?.content_type || 'asset_pack') === 'token_pack' ? 'Token' : 'Asset')}${accessLabel ? ` • ${escapeHtml(accessLabel)}` : ""}${shared ? " • shared now" : ""}</div>
            </div>
            <button type="button" data-session-pack-toggle="${packId}" data-session-pack-enabled="${shared ? "1" : "0"}" style="padding:4px 8px;">${shared ? "Unshare" : "Share"}</button>
          </div>
        `;
      }).join("")
    : `<div style="font-size:11px; opacity:.7;">No eligible private packs found on this account yet.</div>`;
  assetSessionManageListEl.querySelectorAll("[data-session-pack-toggle]").forEach((btn) => {
    btn.onclick = () => {
      const packId = Number(btn.getAttribute("data-session-pack-toggle") || "0");
      const enabled = btn.getAttribute("data-session-pack-enabled") !== "1";
      toggleSessionSharedPack(packId, enabled);
    };
  });
}

// ─── Asset filter management ──────────────────────────────────────────────────

function refreshAssetFilterOptions() {
  if (!assetPackFilterEl) return;
  const current = normalizeAssetPackFilter(assetState.packFilter);
  const packs = availableAssetPackOptions();
  const options = [
    `<option value="all">All Packs</option>`,
    `<option value="upload">Uploads</option>`,
    ...packs.map((pack) => {
      const accessLabel = assetPackAccessLabel(pack.accessSource);
      const suffix = accessLabel ? ` • ${accessLabel}` : (pack.shared ? " • shared" : "");
      return `<option value="${escapeHtml(pack.value)}">${escapeHtml(pack.label)}${escapeHtml(suffix)}</option>`;
    }),
  ];
  assetPackFilterEl.innerHTML = options.join("");
  assetState.packFilter = current;
  assetPackFilterEl.value = current;
}

function persistAssetFilterPresets() {
  try {
    localStorage.setItem(ASSET_FILTER_PRESET_KEY, JSON.stringify(assetState.filterPresets));
  } catch (_) {}
}

function saveAssetFilterPreset(sourceValue = null) {
  const key = assetFilterSourceKey(sourceValue ?? assetState.packFilter);
  assetState.filterPresets[key] = {
    viewMode: String(assetState.viewMode || "pieces"),
    typeFilter: String(assetState.typeFilter || "all"),
    alphaFilter: String(assetState.alphaFilter || "all"),
    sizeFilter: String(assetState.sizeFilter || "all"),
    sortMode: normalizeAssetSortMode(assetState.sortMode),
    folder: String(assetState.folder || ""),
  };
  persistAssetFilterPresets();
}

function syncAssetFilterControls() {
  if (assetViewModeEl) assetViewModeEl.value = assetState.viewMode;
  if (assetPackFilterEl) assetPackFilterEl.value = assetState.packFilter;
  if (assetTypeFilterEl) assetTypeFilterEl.value = assetState.typeFilter;
  if (assetAlphaFilterEl) assetAlphaFilterEl.value = assetState.alphaFilter;
  if (assetSizeFilterEl) assetSizeFilterEl.value = assetState.sizeFilter;
  if (assetSortModeEl) assetSortModeEl.value = assetState.sortMode;
  if (assetSearchInputEl && assetSearchInputEl.value !== assetState.searchInput) assetSearchInputEl.value = assetState.searchInput;
}

function applyAssetFilterPresetForSource(sourceValue = null, announce = false) {
  const source = String(sourceValue ?? assetState.packFilter ?? "all");
  const key = assetFilterSourceKey(source);
  const preset = assetState.filterPresets[key];
  if (preset && typeof preset === "object") {
    assetState.viewMode = String(preset.viewMode || "pieces");
    assetState.typeFilter = String(preset.typeFilter || "all");
    assetState.alphaFilter = String(preset.alphaFilter || "all");
    assetState.sizeFilter = String(preset.sizeFilter || "all");
    assetState.sortMode = normalizeAssetSortMode(preset.sortMode);
    assetState.folder = String(preset.folder || "");
    if (announce) {
      toast(`Restored filters for ${source === "upload" ? "Uploads" : source === "all" ? "All Packs" : `Pack: ${source}`}.`);
    }
  } else {
    assetState.viewMode = source === "upload" ? "pieces" : "all";
    assetState.typeFilter = "all";
    assetState.alphaFilter = "all";
    assetState.sizeFilter = "all";
    assetState.sortMode = "newest";
    assetState.folder = "";
  }
  syncAssetFilterControls();
  renderAssetFolderTree();
}

function getCurrentAssetFilterSnapshot() {
  return {
    searchInput: String(assetState.searchInput || ""),
    viewMode: String(assetState.viewMode || "pieces"),
    packFilter: normalizeAssetPackFilter(assetState.packFilter),
    typeFilter: String(assetState.typeFilter || "all"),
    alphaFilter: String(assetState.alphaFilter || "all"),
    sizeFilter: String(assetState.sizeFilter || "all"),
    sortMode: normalizeAssetSortMode(assetState.sortMode),
    folder: String(assetState.folder || ""),
  };
}

function persistAssetSavedSets() {
  try {
    localStorage.setItem(ASSET_SAVED_SETS_KEY, JSON.stringify(assetState.savedSets || []));
  } catch (_) {}
}

function renderAssetSavedSets() {
  if (!assetSetSelectEl) return;
  const rows = Array.isArray(assetState.savedSets) ? assetState.savedSets : [];
  if (!rows.length) {
    assetSetSelectEl.innerHTML = `<option value="">(no saved sets)</option>`;
    assetState.selectedSetId = "";
    return;
  }
  assetSetSelectEl.innerHTML = [`<option value="">(choose)</option>`, ...rows.map((row) => (
    `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`
  ))].join("");
  const hasSelected = rows.some((row) => row.id === assetState.selectedSetId);
  assetSetSelectEl.value = hasSelected ? assetState.selectedSetId : "";
}

function applyAssetFilterSnapshot(snapshot, shouldRender = true) {
  if (!snapshot || typeof snapshot !== "object") return;
  const normalizeEnum = (value, allowed, fallback) => {
    const raw = String(value || fallback).trim().toLowerCase();
    return allowed.includes(raw) ? raw : fallback;
  };
  const searchInput = String(snapshot.searchInput || "").replace(/\s+/g, " ").trim();
  const folder = String(snapshot.folder || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  assetState.searchInput = searchInput;
  assetState.search = searchInput;
  assetState.viewMode = normalizeEnum(snapshot.viewMode, ["pieces", "maps", "unknown", "all"], "pieces");
  assetState.packFilter = normalizeAssetPackFilter(snapshot.packFilter);
  assetState.typeFilter = normalizeEnum(snapshot.typeFilter, ["all", "png", "webp", "jpg", "gif"], "all");
  assetState.alphaFilter = normalizeEnum(snapshot.alphaFilter, ["all", "yes", "no"], "all");
  assetState.sizeFilter = normalizeEnum(snapshot.sizeFilter, ["all", "tiny", "small", "medium", "large", "huge"], "all");
  assetState.sortMode = normalizeAssetSortMode(snapshot.sortMode);
  assetState.folder = folder;
  syncAssetFilterControls();
  renderAssetFolderTree();
  if (shouldRender) void applyAssetQueryChange({});
}

function saveAssetSet(nameInput = "") {
  const name = String(nameInput || "").trim();
  if (!name) return false;
  const existing = (assetState.savedSets || []).find((row) => row.name.toLowerCase() === name.toLowerCase());
  const entry = {
    id: existing?.id || makeId(),
    name,
    filters: getCurrentAssetFilterSnapshot(),
  };
  const next = (assetState.savedSets || []).filter((row) => row.id !== entry.id);
  next.push(entry);
  next.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  assetState.savedSets = next.slice(0, 200);
  assetState.selectedSetId = entry.id;
  persistAssetSavedSets();
  renderAssetSavedSets();
  return true;
}

function deleteSelectedAssetSet() {
  const id = String(assetState.selectedSetId || "");
  if (!id) return false;
  const before = (assetState.savedSets || []).length;
  assetState.savedSets = (assetState.savedSets || []).filter((row) => row.id !== id);
  assetState.selectedSetId = "";
  if ((assetState.savedSets || []).length === before) return false;
  persistAssetSavedSets();
  renderAssetSavedSets();
  return true;
}

// ─── Asset grid rendering ─────────────────────────────────────────────────────

function renderAssetGrid() {
  if (!assetGridEl) return;
  const query = effectiveAssetBrowseQuery();
  const parsedSearch = query.parsed;
  const sizeFilter = String(assetState.sizeFilter || "all");
  const conflictHints = [];
  if (parsedSearch.pack) conflictHints.push(`pack:${parsedSearch.pack}`);
  if (parsedSearch.type) conflictHints.push(`type:${parsedSearch.type}`);
  if (parsedSearch.alpha) conflictHints.push(`alpha:${parsedSearch.alpha}`);
  if (parsedSearch.tags.length) conflictHints.push(`tag:${parsedSearch.tags.join(",")}`);
  renderAssetSearchMeta(parsedSearch, conflictHints);
  const rows = (assetState.items || [])
    .filter((asset) => !shouldSuppressAssetPath(asset?.folder_path || ""))
    .filter((asset) => sizeFilter === "all" || assetSizeBucket(asset) === sizeFilter)
    .slice();
  if (query.sort === "recent") {
    rows.sort((a, b) => {
      const recentA = Number(assetState.recentUsed[assetUsageKey(a)] || 0);
      const recentB = Number(assetState.recentUsed[assetUsageKey(b)] || 0);
      if (recentA !== recentB) return recentB - recentA;
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
  }
  assetState.hasMore = !!assetState.serverHasMore;
  assetGridEl.classList.toggle("asset-grid--maps", query.kind === "maps");
  assetGridEl.classList.toggle("asset-grid--all", query.kind === "all");

  if (assetGridStatusEl) {
    if (assetState.serverLoading && !rows.length) {
      assetGridStatusEl.textContent = "Loading assets...";
    } else if (assetState.error) {
      assetGridStatusEl.textContent = assetState.error;
    } else if (!assetState.loaded) {
      assetGridStatusEl.textContent = "Open Asset Library to load items.";
    } else {
      const shown = rows.length;
      const label = assetState.navSubcategory || (assetState.folder ? assetState.navCategory : "");
      assetGridStatusEl.textContent = shown
        ? `${label ? `${label} • ` : ""}${shown} asset${shown === 1 ? "" : "s"}${assetState.serverLoading && shown ? " • loading more..." : ""}`
        : "No matching assets.";
    }
  }

  if (!assetState.loaded && !assetState.serverLoading) {
    assetGridEl.innerHTML = `<div class="asset-grid-empty">Open Asset Library to load items.</div>`;
    return;
  }
  if (assetState.serverLoading && !rows.length) {
    assetGridEl.innerHTML = Array.from({ length: query.kind === "maps" ? 4 : 8 }, () => `<div class="asset-grid-skeleton"></div>`).join("");
    return;
  }
  if (assetState.error) {
    assetGridEl.innerHTML = `<div class="asset-grid-empty">${escapeHtml(assetState.error)}</div>`;
    return;
  }
  if (!rows.length) {
    assetGridEl.innerHTML = `<div class="asset-grid-empty">No assets match this view yet.</div>`;
    return;
  }

  const filterKey = `${query.q}\n${query.tag}\n${query.folder}\n${query.kind}\n${query.pack}\n${query.type}\n${query.alpha}\n${sizeFilter}\n${query.sort}\n${rows.length}\n${assetState.recentVersion}\n${assetState.serverHasMore ? 1 : 0}\n${assetState.serverLoading ? 1 : 0}`;
  const renderCardsHtml = (chunkRows, offset) => chunkRows.map((a, localIdx) => {
    const idx = offset + localIdx;
    const previewUrl = withAssetLibSrc(assetPreviewUrl(a));
    const escapedPreview = escapeHtml(previewUrl);
    const thumbAttrs = previewUrl
      ? `src="${ASSET_THUMB_PLACEHOLDER}" data-src="${escapedPreview}" data-asset-key="${escapeHtml(assetUsageKey(a))}" loading="lazy"`
      : `src="${ASSET_THUMB_PLACEHOLDER}" data-asset-key="${escapeHtml(assetUsageKey(a))}" loading="lazy"`;
    const width = Math.max(1, Number(a?.width || 0));
    const height = Math.max(1, Number(a?.height || 0));
    const previewAspect = (width > 0 && height > 0) ? `${width}/${height}` : "1/1";
    const ext = assetFileExt(a).toUpperCase() || "IMG";
    const dimsLabel = (width > 0 && height > 0) ? `${width}x${height}` : "unknown size";
    const alphaLabel = assetHasAlphaGuess(a) ? "alpha" : "opaque";
    const packLabel = String(a.pack_name || a.pack_slug || "").trim() || "uploads";
    const accessLabel = assetPackAccessLabel(a.access_source || (a.shared_in_session ? "session_shared" : ""));
    const secondaryAccess = assetPackSecondaryAccessNote(a);
    const ownerLabel = String(a.owner_username || "").trim();
    const packMetaBits = [packLabel];
    if (accessLabel) packMetaBits.push(accessLabel);
    if (ownerLabel && String(a.source || "") === "pack") packMetaBits.push(`Owner ${ownerLabel}`);
    if (secondaryAccess) packMetaBits.push(secondaryAccess);
    const packMetaLabel = packMetaBits.join(" • ");
    const kind = assetKind(a);
    const mediaClass = kind === "map"
      ? "asset-card-media asset-card-media--map"
      : "asset-card-media asset-card-media--piece";
    const kindBadge = kind === "map" ? "Map" : kind === "piece" ? "Piece" : "Unknown";
    const accessBadge = accessLabel
      ? `<span class="asset-card-pill">${escapeHtml(accessLabel)}</span>`
      : (a.readonly ? `<span class="asset-card-pill">Read only</span>` : "");
    return `
    <button
      data-asset-card="1"
      data-asset-idx="${idx}"
      class="asset-card"
      title="${escapeHtml(String(a.name || "Asset"))} (Shift+Right-click: classify)">
      <div class="${mediaClass}" style="aspect-ratio:${previewAspect};">
        <img class="asset-thumb" ${thumbAttrs} alt="${escapeHtml(String(a.name || "Asset"))}">
        <div class="asset-card-badges">
          <div class="asset-card-pill-row">
            <span class="asset-card-pill kind-${escapeHtml(kind)}">${escapeHtml(kindBadge)}</span>
            ${accessBadge}
          </div>
          <div class="asset-card-menu">
            <button type="button" data-asset-action="kind-open" data-asset-idx="${idx}" class="asset-kind-trigger" title="Classification">⋯</button>
            <div data-asset-kind-menu class="asset-kind-menu">
              <button type="button" data-asset-action="kind-map" data-asset-idx="${idx}">Treat as Map</button>
              <button type="button" data-asset-action="kind-piece" data-asset-idx="${idx}">Treat as Piece</button>
              <button type="button" data-asset-action="kind-unknown" data-asset-idx="${idx}">Treat as Unknown</button>
              <button type="button" data-asset-action="kind-auto" data-asset-idx="${idx}">Auto (clear)</button>
            </div>
          </div>
        </div>
      </div>
      <div class="asset-card-body">
        <div class="asset-card-name">${escapeHtml(String(a.name || "Asset"))}</div>
        <div class="asset-card-meta">${escapeHtml(dimsLabel)} • ${escapeHtml(ext)} • ${escapeHtml(alphaLabel)}</div>
        <div class="asset-card-submeta">${escapeHtml(packMetaLabel)}</div>
      </div>
    </button>
  `;
  }).join("");
  const footerHtml = assetState.serverLoading && rows.length
    ? `<div class="asset-grid-loading-more">Loading more assets...</div>`
    : assetState.serverHasMore
      ? `<div class="asset-grid-loading-more">Scroll to load more…</div>`
      : "";
  if (assetState.lastRenderKey === filterKey && assetState.lastRenderedCount === rows.length) {
    return;
  }
  const appendOnly = assetState.lastRenderKey === filterKey && rows.length > assetState.lastRenderedCount && assetState.lastRenderedCount > 0;
  if (appendOnly) {
    const oldHint = assetGridEl.querySelector(".asset-grid-loading-more");
    if (oldHint) oldHint.remove();
    assetGridEl.insertAdjacentHTML("beforeend", renderCardsHtml(rows.slice(assetState.lastRenderedCount), assetState.lastRenderedCount));
    if (footerHtml) assetGridEl.insertAdjacentHTML("beforeend", footerHtml);
  } else {
    assetGridEl.innerHTML = renderCardsHtml(rows, 0) + footerHtml;
  }
  assetState.lastRenderKey = filterKey;
  assetState.lastRenderedCount = rows.length;
  observeAssetThumbs();
  assetGridEl.querySelectorAll("[data-asset-card='1']").forEach((card) => {
    const idx = Number(card.getAttribute("data-asset-idx"));
    const a = rows[idx];
    if (!a) return;
    // Shared drag-to-canvas handler for all asset card types
    const startAssetDrag = (e, onNoDropClick) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest("button[data-asset-action]")) return;
      assetSuppressCardClick = true;
      const capturedAsset = { ...a, kind: "asset" };
      dragSpawn = capturedAsset;
      dragSpawnWorld = null;
      dragSpawnOverCanvas = false;
      updateCanvasCursor();
      markAssetRecentlyUsed(a);
      e.preventDefault();
      const onDragUp = (upEvent) => {
        window.removeEventListener("pointerup", onDragUp);
        const stillDragging = dragSpawn === capturedAsset;
        dragSpawn = null;
        dragSpawnWorld = null;
        dragSpawnOverCanvas = false;
        updateCanvasCursor();
        requestRender();
        if (!stillDragging) return;
        const rect = canvas.getBoundingClientRect();
        const cx = upEvent.clientX;
        const cy = upEvent.clientY;
        if (cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom) {
          const wpos = screenToWorld(cx - rect.left, cy - rect.top);
          spawnPackAsset(capturedAsset, snap(wpos.x), snap(wpos.y));
        } else if (onNoDropClick) {
          assetSuppressCardClick = false;
        }
      };
      window.addEventListener("pointerup", onDragUp);
    };

    if (query.kind !== "maps") {
      card.onclick = () => {
        if (assetSuppressCardClick) {
          assetSuppressCardClick = false;
          return;
        }
        if (assetState.placeMode) {
          dragSpawn = { ...a, kind: "asset" };
          dragSpawnWorld = null;
          dragSpawnOverCanvas = false;
          updateCanvasCursor();
          markAssetRecentlyUsed(a);
          return;
        }
        spawnPackAsset(a);
      };
      card.onpointerdown = (e) => {
        if (!assetState.placeMode) return;
        startAssetDrag(e, null);
      };
    } else {
      card.onclick = () => {
        if (assetSuppressCardClick) {
          assetSuppressCardClick = false;
          return;
        }
        openMapPreview(a);
      };
      card.onpointerdown = (e) => {
        startAssetDrag(e, () => openMapPreview(a));
      };
    }
    {
      let pressTimer = null;
      let longPressed = false;
      const clearPress = () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      };
      card.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "touch" || e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest("button[data-asset-action]")) return;
        clearPress();
        longPressed = false;
        pressTimer = setTimeout(() => {
          const menu = card.querySelector("[data-asset-kind-menu]");
          if (!menu) return;
          longPressed = true;
          assetSuppressCardClick = true;
          closeAssetKindMenus(menu);
          menu.style.display = "block";
        }, 420);
      });
      card.addEventListener("pointerup", () => {
        clearPress();
        if (longPressed) assetSuppressCardClick = true;
      });
      card.addEventListener("pointercancel", clearPress);
      card.addEventListener("pointerleave", clearPress);
    }
    card.oncontextmenu = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = card.querySelector("[data-asset-kind-menu]");
      if (e.shiftKey) {
        const current = assetKind(a);
        const raw = prompt("Kind override: map / piece / unknown / auto", current) || "";
        const next = raw.trim().toLowerCase();
        if (!next) return;
        if (next === "auto" || next === "clear" || next === "default") {
          setAssetKindOverride(a, "");
          return;
        }
        if (next === "map" || next === "piece" || next === "unknown") {
          setAssetKindOverride(a, next);
          return;
        }
        log(`ASSET KIND ERROR: '${raw}' is not valid`);
        return;
      }
      if (menu) {
        const opening = menu.style.display !== "block";
        closeAssetKindMenus(opening ? menu : null);
        menu.style.display = opening ? "block" : "none";
        return;
      }
    };
  });
  assetGridEl.querySelectorAll("button[data-asset-action]").forEach((btn) => {
    const idx = Number(btn.getAttribute("data-asset-idx"));
    const action = String(btn.getAttribute("data-asset-action") || "");
    const a = rows[idx];
    if (!a) return;
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = btn.closest("[data-asset-card='1']");
      const menu = card ? card.querySelector("[data-asset-kind-menu]") : null;
      if (action === "kind-open") {
        if (!menu) return;
        const opening = menu.style.display !== "block";
        closeAssetKindMenus(opening ? menu : null);
        menu.style.display = opening ? "block" : "none";
        return;
      }
      if (action === "kind-map") { setAssetKindOverride(a, "map"); closeAssetKindMenus(); return; }
      if (action === "kind-piece") { setAssetKindOverride(a, "piece"); closeAssetKindMenus(); return; }
      if (action === "kind-unknown") { setAssetKindOverride(a, "unknown"); closeAssetKindMenus(); return; }
      if (action === "kind-auto") { setAssetKindOverride(a, ""); closeAssetKindMenus(); return; }
    };
  });
  if (!assetState.serverLoading) requestAnimationFrame(maybeLoadMoreAssets);
}

// ─── Browse navigation ───────────────────────────────────────────────────────

function inferAssetCategory(path = "") {
  const p = String(path || "").toLowerCase();
  if (!p) return "Misc";
  if (/(tunnel|ruin|catacomb|cave|crypt|dungeon|temple|prison|sewer)/.test(p)) return "Dungeon";
  if (/(shop|tavern|room|house|interior|inn|kitchen|bedroom|hall|library|quarters)/.test(p)) return "Interior";
  if (/(forest|tree|swamp|desert|nature|jungle|outdoor|garden|rock|river|mountain)/.test(p)) return "Nature";
  if (/(goblin|orc|creature|monster|beast|undead|npc|enemy|dragon|animal)/.test(p)) return "Creatures";
  if (/(prop|debris|furniture|barrel|door|chest|weapon|foliage|statue|object)/.test(p)) return "Props";
  return "Misc";
}

function shouldSuppressAssetPath(path = "") {
  const p = String(path || "").toLowerCase();
  if (!p) return false;
  return p.includes("300 dpi") || p.includes("(print)");
}

function folderSummaryGroups() {
  const folderRows = Array.isArray(assetState.folderSummary) ? assetState.folderSummary : [];
  const categories = new Map();
  for (const row of folderRows) {
    const path = String(row?.path || "").trim().replace(/^\/+|\/+$/g, "");
    if (shouldSuppressAssetPath(path)) continue;
    if (!path) continue;
    const count = Math.max(0, Number(row?.count || 0));
    const category = inferAssetCategory(path);
    if (!categories.has(category)) categories.set(category, { name: category, count: 0, items: [] });
    const bucket = categories.get(category);
    bucket.count += count;
    bucket.items.push({ path, count, label: path.split("/").filter(Boolean).pop() || path });
  }
  return Array.from(categories.values())
    .map((bucket) => ({
      ...bucket,
      items: bucket.items.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.label.localeCompare(b.label);
      }),
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
}

function getRecentAssetRows(limit = 10) {
  const usage = assetState.recentUsed || {};
  return [...(assetState.items || [])]
    .filter((asset) => usage[assetUsageKey(asset)])
    .sort((a, b) => (usage[assetUsageKey(b)] || 0) - (usage[assetUsageKey(a)] || 0))
    .slice(0, limit);
}

function activateAssetLibraryItem(asset) {
  if (!asset) return;
  const kind = assetKind(asset);
  if (kind === "map") {
    openMapPreview(asset);
    return;
  }
  if (assetState.placeMode) {
    dragSpawn = { ...asset, kind: "asset" };
    dragSpawnWorld = null;
    dragSpawnOverCanvas = false;
    updateCanvasCursor();
    markAssetRecentlyUsed(asset);
    return;
  }
  spawnPackAsset(asset);
}

function renderAssetRecentStrip() {
  if (!assetRecentStripEl) return;
  const rows = getRecentAssetRows(10);
  if (!rows.length) {
    assetRecentStripEl.innerHTML = `<div class="asset-sidebar-empty">Use a few assets and your quick picks will appear here.</div>`;
    return;
  }
  assetRecentStripEl.innerHTML = rows.map((asset, idx) => `
    <button type="button" class="asset-recent-chip" data-asset-recent-idx="${idx}" title="${escapeHtml(String(asset?.name || "Asset"))}">
      <span class="asset-recent-chip-name">${escapeHtml(String(asset?.name || "Asset"))}</span>
      <span class="asset-recent-chip-meta">${escapeHtml(String(asset?.pack_name || asset?.pack_slug || "Uploads"))}</span>
    </button>
  `).join("");
  assetRecentStripEl.querySelectorAll("[data-asset-recent-idx]").forEach((btn) => {
    btn.onclick = () => {
      const idx = Number(btn.getAttribute("data-asset-recent-idx") || "-1");
      activateAssetLibraryItem(rows[idx]);
    };
  });
}

function renderAssetCategoryNav() {
  if (!assetCategoryListEl) return;
  const groups = folderSummaryGroups();
  if (assetState.folderLoading && !groups.length) {
    assetCategoryListEl.innerHTML = `<div class="asset-sidebar-empty">Loading categories…</div>`;
    return;
  }
  if (assetState.folderError) {
    assetCategoryListEl.innerHTML = `<div class="asset-sidebar-empty">${escapeHtml(assetState.folderError)}</div>`;
    return;
  }
  assetCategoryListEl.innerHTML = groups.length
    ? groups.map((group) => `
        <button type="button" class="asset-nav-btn ${assetState.navCategory === group.name ? "active" : ""}" data-asset-category="${escapeHtml(group.name)}">
          <span class="asset-nav-btn-name">${escapeHtml(group.name)}</span>
          <span class="asset-nav-btn-meta">${group.count} assets</span>
        </button>
      `).join("")
    : `<div class="asset-sidebar-empty">No categories yet.</div>`;
}

function renderAssetSubcategoryNav() {
  if (!assetSubcategorySectionEl || !assetSubcategoryListEl) return;
  const hasSearch = !!String(assetState.searchInput || assetState.search || "").trim();
  const group = folderSummaryGroups().find((entry) => entry.name === assetState.navCategory);
  assetSubcategorySectionEl.hidden = hasSearch || !group;
  if (assetSubcategorySectionEl.hidden) {
    assetSubcategoryListEl.innerHTML = "";
    return;
  }
  assetSubcategoryListEl.innerHTML = group.items.length
    ? group.items.map((item) => `
        <button type="button" class="asset-nav-btn ${assetState.navSubcategory === item.path ? "active" : ""}" data-asset-subcategory="${escapeHtml(item.path)}">
          <span class="asset-nav-btn-name">${escapeHtml(item.label)}</span>
          <span class="asset-nav-btn-meta">${item.count} assets</span>
        </button>
      `).join("")
    : `<div class="asset-sidebar-empty">No subcategories here yet.</div>`;
}

function renderAssetFolderTree() {
  syncAssetNavSelectionFromFolder();
  renderAssetRecentStrip();
  renderAssetCategoryNav();
  renderAssetSubcategoryNav();
}

// ─── Asset loading & refresh ──────────────────────────────────────────────────

async function refreshAssetsPanel() {
  if (assetState.loading || assetState.serverLoading) return;
  assetState.loading = true;
  renderAssetMode();
  renderAssetAdvancedFilters();
  await fetchAssetResults({ append: false, refreshPackMeta: true });
}

async function loadMoreAssetMetadata() {
  await fetchAssetResults({ append: true });
}

async function ensureAssetPanelReady() {
  renderAssetMode();
  renderAssetAdvancedFilters();
  if (assetState.loaded || assetState.loading || assetState.serverLoading) {
    renderAssetFolderTree();
    renderAssetGrid();
    return;
  }
  await refreshAssetsPanel();
}

async function revealPlacedAssetInLibrary(asset) {
  const folder = String(asset?.folder_path || "").trim();
  const packSlug = String(asset?.pack_slug || "").trim();
  const source = String(asset?.source || "").trim().toLowerCase();

  activateDrawerTab("assets", true);
  await ensureAssetPanelReady();

  const nextPackFilter = packSlug || (source === "upload" ? "upload" : "all");

  await applyAssetQueryChange(
    {
      search: "",
      searchInput: "",
      folder,
      packFilter: nextPackFilter,
    },
    { refreshFolders: true, preserveItems: false },
  );
}

function isAssetsTabActive() {
  const tab = document.getElementById("tab-assets");
  return !!tab && tab.classList.contains("active");
}

function maybeLoadMoreAssets() {
  if (!isAssetsTabActive()) return;
  if (!assetState.loaded) return;
  const scroller = drawerContentEl || assetPanel;
  if (!scroller) return;
  const remaining = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
  if (remaining > 280) return;
  if (assetState.serverHasMore) {
    void loadMoreAssetMetadata();
  }
}

function observeAssetThumbs() {
  if (!assetGridEl) return;
  const thumbs = Array.from(assetGridEl.querySelectorAll("img.asset-thumb[data-src]"));
  if (!thumbs.length) {
    if (assetThumbObserver) assetThumbObserver.disconnect();
    return;
  }
  if (!("IntersectionObserver" in window)) {
    for (const img of thumbs) {
      const src = img.getAttribute("data-src");
      if (!src) continue;
      const asset = assetByUsageKey(img.getAttribute("data-asset-key"));
      if (asset) recordAssetDiagnostic(asset, { requestStartAt: Date.now() });
      img.onload = () => {
        if (asset) {
          const imageLoadedAt = Date.now();
          recordAssetDiagnostic(asset, { imageLoadedAt });
          requestAnimationFrame(() => recordAssetDiagnostic(asset, { firstVisibleAt: Date.now() }));
        }
      };
      img.src = src;
      img.removeAttribute("data-src");
    }
    return;
  }
  if (!assetThumbObserver) {
    assetThumbObserver = new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        const src = img.getAttribute("data-src");
        if (src) {
          const asset = assetByUsageKey(img.getAttribute("data-asset-key"));
          if (asset) recordAssetDiagnostic(asset, { requestStartAt: Date.now() });
          img.onload = () => {
            if (!asset) return;
            const imageLoadedAt = Date.now();
            recordAssetDiagnostic(asset, { imageLoadedAt });
            requestAnimationFrame(() => recordAssetDiagnostic(asset, { firstVisibleAt: Date.now() }));
          };
          img.src = src;
        }
        img.removeAttribute("data-src");
        obs.unobserve(img);
      }
    }, {
      root: drawerContentEl || assetPanel || null,
      rootMargin: "200px 0px",
      threshold: 0.01,
    });
  } else {
    assetThumbObserver.disconnect();
  }
  for (const img of thumbs) assetThumbObserver.observe(img);
}

// ─── Spawn helpers ────────────────────────────────────────────────────────────

function spawnPackToken(packToken, x = null, y = null) {
  const normalized = normalizePackBackedRecord(packToken || {});
  const id = makeId();
  let wx = x;
  let wy = y;
  if (wx === null || wy === null) {
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;
    const centerWorld = screenToWorld(w / 2, h / 2);
    wx = snap(centerWorld.x + (Math.random() * 80 - 40));
    wy = snap(centerWorld.y + (Math.random() * 80 - 40));
  }

  const token = {
    id,
    x: wx,
    y: wy,
    name: normalized.name || "Token",
    color: normalized.color || "#ffffff",
    image_url: normalized.image_url || null,
    asset_id: normalized.asset_id || null,
    source: normalized.source || null,
    pack_slug: normalized.pack_slug || null,
    mime: normalized.mime || null,
    ext: normalized.ext || null,
    size_scale: clamp(Number(normalized.size_scale ?? ui.tokenSpawnScale), 0.25, 4),
    owner_id: null,
    locked: false,
    badges: [],
  };
  if (online) {
    state.tokens.set(id, token);
    refreshGmUI();
    requestRender();
  }
  send("TOKEN_CREATE", token);
}

function spawnPackAsset(packToken, x = null, y = null) {
  const normalized = normalizePackBackedRecord(packToken || {});
  markAssetRecentlyUsed(normalized);
  const id = makeId();
  let wx = x;
  let wy = y;
  if (wx === null || wy === null) {
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;
    const centerWorld = screenToWorld(w / 2, h / 2);
    wx = snap(centerWorld.x + (Math.random() * 80 - 40));
    wy = snap(centerWorld.y + (Math.random() * 80 - 40));
  }
  const base = ui.gridSize;
  const width = Math.max(8, Number(normalized.width || base));
  const height = Math.max(8, Number(normalized.height || base));
  const asset = {
    id,
    asset_id: normalized.asset_id || normalized.id || null,
    source: normalized.source || null,
    pack_slug: normalized.pack_slug || null,
    folder_path: normalized.folder_path || null,
    mime: normalized.mime || null,
    ext: normalized.ext || null,
    image_url: normalized.url_original || normalized.image_url || "",
    x: wx,
    y: wy,
    width,
    height,
    scale_x: clamp(Number(normalized.size_scale ?? 1), 0.05, 10),
    scale_y: clamp(Number(normalized.size_scale ?? 1), 0.05, 10),
    rotation: 0,
    opacity: 1,
    layer: 0,
    locked: false,
    creator_id: myId(),
  };
  if (online) {
    state.assets.set(id, asset);
    state.draw_order.assets = state.draw_order.assets.filter((aid) => aid !== id);
    state.draw_order.assets.push(id);
    markAssetOrderDirty();
    requestRender();
  }
  send("ASSET_INSTANCE_CREATE", asset);
}

function setAssetAsBackground(asset) {
  const url = String(asset?.url_original || asset?.image_url || "").trim();
  if (!url) {
    log("ASSET ERROR: missing URL for background");
    toast("Background URL missing for this asset.");
    return;
  }
  markAssetRecentlyUsed(asset);
  send("ROOM_SETTINGS", { background_mode: "url", background_url: url });
  log(`Background set: ${String(asset?.name || "Asset")}`);
}

function fitBackgroundToView(asset = null) {
  const width = Math.max(0, Number(asset?.width || bgImage?.naturalWidth || 0));
  const height = Math.max(0, Number(asset?.height || bgImage?.naturalHeight || 0));
  if (!fitRectToView(width, height, 0.88)) {
    log("FIT VIEW ERROR: background dimensions unavailable");
    toast("Cannot fit view: background dimensions unavailable.");
    return;
  }
  log(`Fit view to ${width}x${height}`);
}

function spawnOverlayAsset(assetRef) {
  const normalized = normalizePackBackedRecord(assetRef || {});
  markAssetRecentlyUsed(normalized);
  const id = makeId();
  const center = screenToWorld((canvas.clientWidth || canvas.width || 0) / 2, (canvas.clientHeight || canvas.height || 0) / 2);
  const base = ui.gridSize;
  const width = Math.max(8, Number(normalized.width || base));
  const height = Math.max(8, Number(normalized.height || base));
  const overlay = {
    id,
    asset_id: normalized.asset_id || normalized.id || null,
    source: normalized.source || null,
    pack_slug: normalized.pack_slug || null,
    folder_path: normalized.folder_path || null,
    mime: normalized.mime || null,
    ext: normalized.ext || null,
    image_url: normalized.url_original || normalized.image_url || "",
    x: center.x,
    y: center.y,
    width,
    height,
    scale_x: 1,
    scale_y: 1,
    rotation: 0,
    opacity: 1,
    layer: -100,
    locked: true,
    creator_id: myId(),
    is_overlay: true,
  };
  if (online) {
    state.assets.set(id, overlay);
    state.draw_order.assets = state.draw_order.assets.filter((aid) => aid !== id);
    state.draw_order.assets.push(id);
    markAssetOrderDirty();
    requestRender();
  }
  send("ASSET_INSTANCE_CREATE", overlay);
  log(`Overlay placed: ${String(normalized.name || "Asset")}`);
}

// ─── Pack blob URL cache management ──────────────────────────────────────────

function collectReferencedPackAssetIds() {
  const keep = new Set();
  const scan = (item) => {
    if (!item || typeof item !== "object") return;
    const source = String(item.source || "").toLowerCase();
    const aid = String(item.asset_id || "").trim();
    if (source === "pack" && aid) keep.add(aid);
  };
  for (const t of state.tokens.values()) scan(t);
  for (const a of state.assets.values()) scan(a);
  scan(dragSpawn);
  return keep;
}

function pruneUnusedPackBlobUrls() {
  const keep = collectReferencedPackAssetIds();
  for (const [assetId, blobUrl] of packAssetBlobUrlCache.entries()) {
    if (keep.has(assetId)) continue;
    try { URL.revokeObjectURL(blobUrl); } catch (_) {}
    packAssetBlobUrlCache.delete(assetId);
    tokenImageCache.delete(`pack:${assetId}`);
  }
}

// ─── Event bindings (called from canvas.js after DOM consts are declared) ─────

function initAssetLibBindings() {
  if (assetScaleSliderEl) {
    assetScaleSliderEl.addEventListener("input", () => {
      const a = state.assets.get(selectedAssetId || "");
      if (!a || !canEditAssetLocal(a)) return;
      const pct = clamp(Number(assetScaleSliderEl.value || "100"), 5, 400);
      const nextAbs = clamp(pct / 100, 0.05, 10);
      const sx = signedAssetScale(a.scale_x, 1);
      const sy = signedAssetScale(a.scale_y, 1);
      const signX = sx < 0 ? -1 : 1;
      const signY = sy < 0 ? -1 : 1;
      applyAssetUpdate(a.id, { scale_x: signX * nextAbs, scale_y: signY * nextAbs }, false);
      if (assetScaleValueEl) assetScaleValueEl.textContent = `${Math.round(pct)}%`;
    });
    assetScaleSliderEl.addEventListener("change", () => {
      const a = state.assets.get(selectedAssetId || "");
      if (!a || !canEditAssetLocal(a)) return;
      const pct = clamp(Number(assetScaleSliderEl.value || "100"), 5, 400);
      const nextAbs = clamp(pct / 100, 0.05, 10);
      const sx = signedAssetScale(a.scale_x, 1);
      const sy = signedAssetScale(a.scale_y, 1);
      const signX = sx < 0 ? -1 : 1;
      const signY = sy < 0 ? -1 : 1;
      applyAssetUpdate(a.id, { scale_x: signX * nextAbs, scale_y: signY * nextAbs }, true);
      syncAssetCtxSliders();
    });
  }
  if (assetRotateSliderEl) {
    assetRotateSliderEl.addEventListener("input", () => {
      const a = state.assets.get(selectedAssetId || "");
      if (!a || !canEditAssetLocal(a)) return;
      const deg = clamp(Number(assetRotateSliderEl.value || "0"), -180, 180);
      const rad = deg * (Math.PI / 180);
      applyAssetUpdate(a.id, { rotation: rad }, false);
      if (assetRotateValueEl) assetRotateValueEl.textContent = `${Math.round(deg)}°`;
    });
    assetRotateSliderEl.addEventListener("change", () => {
      const a = state.assets.get(selectedAssetId || "");
      if (!a || !canEditAssetLocal(a)) return;
      const deg = clamp(Number(assetRotateSliderEl.value || "0"), -180, 180);
      const rad = deg * (Math.PI / 180);
      applyAssetUpdate(a.id, { rotation: rad }, true);
      syncAssetCtxSliders();
    });
  }
  const libraryPanelBtnEl = document.getElementById("libraryPanelBtn");
  if (libraryPanelBtnEl) libraryPanelBtnEl.onclick = async () => {
    activateDrawerTab("tokens", true);
    await refreshPacks();
  };
  const libraryPanelCloseBtnEl = document.getElementById("libraryPanelClose");
  if (libraryPanelCloseBtnEl) libraryPanelCloseBtnEl.onclick = () => { drawer.classList.add("hidden"); };
  const refreshPacksBtnEl = document.getElementById("refreshPacksBtn");
  if (refreshPacksBtnEl) refreshPacksBtnEl.onclick = () => refreshPacks();
  const assetPanelCloseBtnEl = document.getElementById("assetPanelClose");
  if (assetPanelCloseBtnEl) assetPanelCloseBtnEl.onclick = () => { drawer.classList.add("hidden"); };
  if (drawerContentEl) drawerContentEl.addEventListener("scroll", maybeLoadMoreAssets, { passive: true });
  if (assetRefreshBtnEl) assetRefreshBtnEl.onclick = () => refreshAssetsPanel();
  if (assetModeBrowseBtnEl) assetModeBrowseBtnEl.onclick = () => {
    assetState.uiMode = "browse";
    renderAssetMode();
  };
  if (assetModeManageBtnEl) assetModeManageBtnEl.onclick = () => {
    assetState.uiMode = "manage";
    renderAssetMode();
  };
  if (assetFiltersToggleBtnEl) assetFiltersToggleBtnEl.onclick = () => {
    assetState.filtersOpen = !assetState.filtersOpen;
    renderAssetAdvancedFilters();
  };
  if (assetSessionShareRefreshBtnEl) assetSessionShareRefreshBtnEl.onclick = async () => {
    await refreshAssetSessionPackData();
    renderAssetSessionSharePanel();
    if (assetState.loaded) await refreshAssetsPanel();
  };
  if (assetSessionShareAllBtnEl) assetSessionShareAllBtnEl.onclick = async () => {
    await shareAllSessionPrivatePacks();
  };
  if (assetSearchInputEl) assetSearchInputEl.addEventListener("input", () => {
    assetState.searchInput = assetSearchInputEl.value || "";
    if (assetSearchDebounceTimer) clearTimeout(assetSearchDebounceTimer);
    assetSearchDebounceTimer = setTimeout(() => {
      void applyAssetQueryChange(
        { search: assetState.searchInput, searchInput: assetState.searchInput },
        { refreshFolders: false },
      );
    }, assetState.searchDebounceMs);
  });
  if (assetViewModeEl) {
    assetViewModeEl.value = assetState.viewMode;
    assetViewModeEl.addEventListener("change", () => {
      assetState.viewMode = String(assetViewModeEl.value || "pieces");
      saveAssetFilterPreset();
      void applyAssetQueryChange({ viewMode: assetState.viewMode });
    });
  }
  if (assetPackFilterEl) {
    assetPackFilterEl.value = assetState.packFilter;
    assetPackFilterEl.addEventListener("change", () => {
      const prev = String(assetState.packFilter || "all");
      saveAssetFilterPreset();
      assetState.packFilter = String(assetPackFilterEl.value || "all");
      saveAssetScope(assetState.packFilter);
      applyAssetFilterPresetForSource(assetState.packFilter, prev !== assetState.packFilter);
      void applyAssetQueryChange({ packFilter: assetState.packFilter });
    });
  }
  if (assetTypeFilterEl) {
    assetTypeFilterEl.value = assetState.typeFilter;
    assetTypeFilterEl.addEventListener("change", () => {
      assetState.typeFilter = String(assetTypeFilterEl.value || "all");
      saveAssetFilterPreset();
      void applyAssetQueryChange({ typeFilter: assetState.typeFilter });
    });
  }
  if (assetAlphaFilterEl) {
    assetAlphaFilterEl.value = assetState.alphaFilter;
    assetAlphaFilterEl.addEventListener("change", () => {
      assetState.alphaFilter = String(assetAlphaFilterEl.value || "all");
      saveAssetFilterPreset();
      void applyAssetQueryChange({ alphaFilter: assetState.alphaFilter });
    });
  }
  if (assetSizeFilterEl) {
    assetSizeFilterEl.value = assetState.sizeFilter;
    assetSizeFilterEl.addEventListener("change", () => {
      assetState.sizeFilter = String(assetSizeFilterEl.value || "all");
      saveAssetFilterPreset();
      renderAssetGrid();
    });
  }
  if (assetSortModeEl) {
    assetSortModeEl.value = assetState.sortMode;
    assetSortModeEl.addEventListener("change", () => {
      assetState.sortMode = normalizeAssetSortMode(assetSortModeEl.value);
      saveAssetFilterPreset();
      void applyAssetQueryChange({ sortMode: assetState.sortMode });
    });
  }
  if (assetDebugNetEl) {
    assetDebugNetEl.checked = !!assetState.debugNet;
    assetDebugNetEl.addEventListener("change", () => {
      assetState.debugNet = !!assetDebugNetEl.checked;
      try {
        localStorage.setItem(ASSET_DEBUG_NET_KEY, assetState.debugNet ? "1" : "0");
      } catch (_) {}
      log(`Asset network debug ${assetState.debugNet ? "enabled" : "disabled"}.`);
      renderAssetDebugSummary();
    });
  }
  if (assetSetSelectEl) {
    renderAssetSavedSets();
    assetSetSelectEl.addEventListener("change", () => {
      assetState.selectedSetId = String(assetSetSelectEl.value || "");
    });
  }
  if (assetSetApplyBtnEl) assetSetApplyBtnEl.addEventListener("click", () => {
    const id = String(assetState.selectedSetId || assetSetSelectEl?.value || "");
    if (!id) { toast("Select a saved set first."); return; }
    const row = (assetState.savedSets || []).find((item) => item.id === id);
    if (!row) { toast("Saved set was not found."); renderAssetSavedSets(); return; }
    applyAssetFilterSnapshot(row.filters, true);
    toast(`Applied set: ${row.name}`);
  });
  if (assetSetSaveBtnEl) assetSetSaveBtnEl.addEventListener("click", () => {
    const fallback = (() => {
      const existing = (assetState.savedSets || []).find((row) => row.id === assetState.selectedSetId);
      return existing ? existing.name : "";
    })();
    const name = prompt("Save set name", fallback) || "";
    if (!name.trim()) return;
    if (!saveAssetSet(name)) { toast("Could not save set."); return; }
    toast(`Saved set: ${name.trim()}`);
  });
  if (assetSetDeleteBtnEl) assetSetDeleteBtnEl.addEventListener("click", () => {
    const id = String(assetState.selectedSetId || assetSetSelectEl?.value || "");
    if (!id) { toast("Select a saved set first."); return; }
    const row = (assetState.savedSets || []).find((item) => item.id === id);
    if (!row) { toast("Saved set was not found."); renderAssetSavedSets(); return; }
    if (!confirm(`Delete saved set '${row.name}'?`)) return;
    if (!deleteSelectedAssetSet()) { toast("Delete failed."); return; }
    toast(`Deleted set: ${row.name}`);
  });
  if (assetPlaceModeBtnEl) {
    const syncPlaceModeBtn = () => {
      assetPlaceModeBtnEl.textContent = assetState.placeMode ? "Place Mode: On" : "Place Mode: Off";
      assetPlaceModeBtnEl.classList.toggle("primary", assetState.placeMode);
    };
    assetPlaceModeBtnEl.onclick = () => {
      assetState.placeMode = !assetState.placeMode;
      syncPlaceModeBtn();
    };
    syncPlaceModeBtn();
  }
  if (assetCategoryListEl) assetCategoryListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-asset-category]");
    if (!btn) return;
    const category = String(btn.getAttribute("data-asset-category") || "");
    const nextCategory = assetState.navCategory === category ? "" : category;
    assetState.navCategory = nextCategory;
    if (!nextCategory) {
      assetState.navSubcategory = "";
      if (assetState.folder) {
        assetState.folder = "";
        saveAssetFilterPreset();
        renderAssetFolderTree();
        void applyAssetQueryChange({ folder: "" }, { refreshFolders: false, preserveItems: true });
        return;
      }
    } else if (assetState.navSubcategory && inferAssetCategory(assetState.navSubcategory) !== nextCategory) {
      assetState.navSubcategory = "";
      assetState.folder = "";
      saveAssetFilterPreset();
      renderAssetFolderTree();
      void applyAssetQueryChange({ folder: "" }, { refreshFolders: false, preserveItems: true });
      return;
    }
    renderAssetFolderTree();
  });
  if (assetSubcategoryListEl) assetSubcategoryListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-asset-subcategory]");
    if (!btn) return;
    const path = String(btn.getAttribute("data-asset-subcategory") || "");
    assetState.navSubcategory = assetState.navSubcategory === path ? "" : path;
    assetState.folder = assetState.navSubcategory;
    saveAssetFilterPreset();
    renderAssetFolderTree();
    void applyAssetQueryChange(
      { folder: assetState.folder },
      { refreshFolders: false, preserveItems: true },
    );
  });
  if (assetUploadBtnEl) assetUploadBtnEl.onclick = async () => {
    const file = assetFileInputEl?.files && assetFileInputEl.files[0];
    if (!file) { log("ASSET UPLOAD ERROR: choose a file first"); return; }
    try {
      await apiUploadAsset(file, String(assetNameInputEl?.value || "").trim(), String(assetTagsInputEl?.value || "").trim());
      if (assetFileInputEl) assetFileInputEl.value = "";
      if (assetNameInputEl) assetNameInputEl.value = "";
      if (assetTagsInputEl) assetTagsInputEl.value = "";
      await refreshAssetsPanel();
      log("Asset uploaded.");
    } catch (e) {
      log(`ASSET UPLOAD ERROR: ${e.message || e}`);
    }
  };
  if (assetZipUploadBtnEl) assetZipUploadBtnEl.onclick = async () => {
    const file = assetZipInputEl?.files && assetZipInputEl.files[0];
    if (!file) { log("ASSET ZIP ERROR: choose a zip file first"); return; }
    try {
      const out = await apiUploadAssetZip(file, String(assetTagsInputEl?.value || "").trim());
      if (assetZipInputEl) assetZipInputEl.value = "";
      await refreshAssetsPanel();
      const createdCount = Number(out?.created_count || 0);
      const skippedCount = Number(out?.skipped_count || 0);
      log(`ZIP imported: ${createdCount} assets, skipped ${skippedCount}`);
      const skipped = Array.isArray(out?.skipped) ? out.skipped.slice(0, 8) : [];
      if (skipped.length) log(`Skipped examples: ${skipped.join(", ")}`);
    } catch (e) {
      log(`ASSET ZIP ERROR: ${e.message || e}`);
    }
  };
  renderAssetMode();
  renderAssetAdvancedFilters();
  if (packSelectEl) packSelectEl.addEventListener("change", async () => {
    packState.selectedPackId = packSelectEl.value;
    await loadPack(packState.selectedPackId);
  });
  if (packSearchEl) packSearchEl.addEventListener("input", () => {
    packState.search = packSearchEl.value || "";
    renderPackGrid();
  });
  // Map preview modal
  if (mapPreviewClose) mapPreviewClose.addEventListener("click", closeMapPreview);
  if (mapPreviewBackdrop) mapPreviewBackdrop.addEventListener("click", closeMapPreview);
  if (mapPreviewSetBgBtn) mapPreviewSetBgBtn.addEventListener("click", () => {
    if (!mapPreviewAsset) return;
    setAssetAsBackground(mapPreviewAsset);
  });
  if (mapPreviewClearBgBtn) mapPreviewClearBgBtn.addEventListener("click", () => {
    clearRoomBackground();
  });
  if (mapPreviewFitBtn) mapPreviewFitBtn.addEventListener("click", () => {
    fitBackgroundToView(mapPreviewAsset || null);
  });
  if (mapPreviewOverlayBtn) mapPreviewOverlayBtn.addEventListener("click", () => {
    if (!mapPreviewAsset) return;
    spawnOverlayAsset(mapPreviewAsset);
  });
  if (mapPreviewSpawnBtn) mapPreviewSpawnBtn.addEventListener("click", () => {
    if (!mapPreviewAsset) return;
    spawnPackAsset(mapPreviewAsset);
  });
  if (mapPreviewCopyUrlBtn) mapPreviewCopyUrlBtn.addEventListener("click", async () => {
    const url = String(mapPreviewSourceUrl || "").trim();
    if (!url) { toast("No preview URL available."); return; }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        toast("Preview URL copied.");
      } else {
        throw new Error("Clipboard API unavailable");
      }
    } catch (_) {
      prompt("Copy preview URL", url);
    }
  });
  if (mapPreviewOpenTabBtn) mapPreviewOpenTabBtn.addEventListener("click", () => {
    const url = String(mapPreviewSourceUrl || "").trim();
    if (!url) { toast("No preview URL available."); return; }
    window.open(url, "_blank", "noopener,noreferrer");
  });
}
