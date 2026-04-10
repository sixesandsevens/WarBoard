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

const assetState = {
  items: [],
  privatePacks: [],
  sessionSharedPacks: [],
  search: "",
  searchInput: "",
  searchDebounceMs: 160,
  folder: "",
  viewMode: "pieces",
  packFilter: "all",
  typeFilter: "all",
  alphaFilter: "all",
  sizeFilter: "all",
  sortMode: "recent",
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
  packsLoading: false,
  packMetaSessionId: "",
  pageSize: 60,
  renderCount: 60,
  hasMore: false,
  filterKey: "",
  lastRenderKey: "",
  lastRenderedCount: 0,
};

const ASSET_THUMB_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
let assetThumbObserver = null;
let assetSearchDebounceTimer = null;
let assetSuppressCardClick = false;
let mapPreviewAsset = null;
let mapPreviewSourceUrl = "";
let mapPreviewLoadSeq = 0;
const expandedAssetFolders = new Set([""]);

// ─── Pack sanitization ────────────────────────────────────────────────────────

function sanitizePackToken(token, packId) {
  const id = String(token?.id || "").trim();
  const name = String(token?.name || id || "Token").trim() || "Token";
  const file = String(token?.file || "").trim();
  const tags = Array.isArray(token?.tags) ? token.tags.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
  if (!id || !file) return null;
  const safePath = file
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return {
    id,
    name,
    file,
    tags,
    image_url: `/packs/${encodeURIComponent(packId)}/${safePath}`,
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
    const manifest = await apiGet(`/api/packs/${encodeURIComponent(packId)}`);
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
    const data = await apiGet("/api/packs");
    const packs = Array.isArray(data.packs) ? data.packs : [];
    packState.packs = packs;
    const existing = new Set(packs.map((p) => p.pack_id));
    if (!existing.has(packState.selectedPackId)) {
      packState.selectedPackId = packs[0]?.pack_id || "";
    }
    packSelectEl.innerHTML = packs.map((p) => (
      `<option value="${p.pack_id}">${p.name} (${p.token_count})</option>`
    )).join("") || `<option value="">(no packs)</option>`;
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
        renderAssetGrid();
      };
    });
  }
  if (assetSearchHintEl) {
    const hints = [];
    if (Array.isArray(conflictHints) && conflictHints.length) {
      hints.push(`Conflicts: ${conflictHints.join(" | ")} (query tokens override UI filters).`);
    }
    hints.push("Search tokens: tag:, pack:, type:, alpha:");
    assetSearchHintEl.textContent = hints.join(" ");
  }
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
  if (assetState.sortMode === "recent" && isAssetsTabActive()) {
    renderAssetGrid();
  }
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
  if (!sessionId) {
    resetAssetSessionPackState();
    return;
  }
  if (assetState.packsLoading && assetState.packMetaSessionId === sessionId) return;
  assetState.packsLoading = true;
  assetState.packMetaSessionId = sessionId;
  try {
    const [privateData, sharedData] = await Promise.all([
      apiGet(`/api/private-packs?session_id=${encodeURIComponent(sessionId)}`),
      apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/shared-packs`),
    ]);
    assetState.privatePacks = Array.isArray(privateData?.packs) ? privateData.packs : [];
    assetState.sessionSharedPacks = Array.isArray(sharedData?.packs) ? sharedData.packs : [];
  } catch (e) {
    console.warn("asset session packs refresh failed", e);
    assetState.privatePacks = [];
    assetState.sessionSharedPacks = [];
  } finally {
    assetState.packsLoading = false;
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

function renderAssetSessionSharePanel() {
  if (!assetSessionShareBoxEl || !assetSessionShareSummaryEl || !assetSessionSharedListEl || !assetSessionManageWrapEl || !assetSessionManageListEl) return;
  const sessionId = currentAssetSessionId();
  if (!sessionId) {
    assetSessionShareBoxEl.style.display = "none";
    assetSessionShareSummaryEl.textContent = "No session attached.";
    assetSessionSharedListEl.innerHTML = "";
    assetSessionManageWrapEl.style.display = "none";
    assetSessionManageListEl.innerHTML = "";
    return;
  }
  assetSessionShareBoxEl.style.display = "block";
  const canManageSession = ["gm", "co_gm"].includes(String(playSessionState.user_role || ""));
  const sharedPacks = Array.isArray(assetState.sessionSharedPacks) ? assetState.sessionSharedPacks : [];
  const privatePacks = Array.isArray(assetState.privatePacks) ? assetState.privatePacks : [];
  assetSessionShareSummaryEl.textContent = sharedPacks.length
    ? `${sharedPacks.length} pack${sharedPacks.length === 1 ? "" : "s"} shared in ${playSessionState.name || "this session"}.`
    : `No packs are shared in ${playSessionState.name || "this session"} yet.`;
  assetSessionSharedListEl.innerHTML = sharedPacks.length
    ? sharedPacks.map((pack) => `
        <div style="display:flex; align-items:center; gap:6px; border:1px solid rgba(255,255,255,0.12); border-radius:999px; padding:4px 8px; font-size:11px;">
          <span style="font-weight:600;">${escapeHtml(String(pack.name || pack.slug || "Pack"))}</span>
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
        return `
          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; border:1px solid rgba(255,255,255,0.1); border-radius:8px; padding:6px 8px;">
            <div style="min-width:0;">
              <div style="font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(String(pack?.name || pack?.slug || "Pack"))}</div>
              <div style="font-size:11px; opacity:.7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(String(pack?.slug || ""))}${shared ? " • shared now" : ""}</div>
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
  const current = String(assetState.packFilter || "all");
  const packs = new Set();
  let uploadCount = 0;
  for (const item of assetState.items) {
    const slug = String(item.pack_slug || "").trim();
    if (slug) packs.add(slug);
    else uploadCount += 1;
  }
  const sortedPacks = Array.from(packs).sort((a, b) => a.localeCompare(b));
  const options = [
    `<option value="all">All Packs</option>`,
    `<option value="upload">Uploads${uploadCount ? ` (${uploadCount})` : ""}</option>`,
    ...sortedPacks.map((slug) => `<option value="${escapeHtml(slug)}">${escapeHtml(slug)}</option>`),
  ];
  assetPackFilterEl.innerHTML = options.join("");
  if (current === "all" || current === "upload" || packs.has(current)) {
    assetPackFilterEl.value = current;
  } else {
    assetPackFilterEl.value = "all";
    assetState.packFilter = "all";
  }
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
    sortMode: String(assetState.sortMode || "recent"),
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
    assetState.sortMode = String(preset.sortMode || "recent");
    assetState.folder = String(preset.folder || "");
    if (announce) {
      toast(`Restored filters for ${source === "upload" ? "Uploads" : source === "all" ? "All Packs" : `Pack: ${source}`}.`);
    }
  } else {
    assetState.viewMode = source === "upload" ? "pieces" : "all";
    assetState.typeFilter = "all";
    assetState.alphaFilter = "all";
    assetState.sizeFilter = "all";
    assetState.sortMode = "recent";
    assetState.folder = "";
  }
  syncAssetFilterControls();
  renderAssetFolderTree();
}

function getCurrentAssetFilterSnapshot() {
  return {
    searchInput: String(assetState.searchInput || ""),
    viewMode: String(assetState.viewMode || "pieces"),
    packFilter: String(assetState.packFilter || "all"),
    typeFilter: String(assetState.typeFilter || "all"),
    alphaFilter: String(assetState.alphaFilter || "all"),
    sizeFilter: String(assetState.sizeFilter || "all"),
    sortMode: String(assetState.sortMode || "recent"),
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
  const normalizePackFilter = (value) => {
    const raw = String(value || "all").trim();
    if (!raw || raw === "all" || raw === "upload") return raw || "all";
    const present = new Set();
    for (const item of assetState.items || []) {
      const slug = String(item?.pack_slug || "").trim();
      if (slug) present.add(slug);
    }
    if (present.has(raw)) return raw;
    toast(`Pack '${raw}' is unavailable. Falling back to All Packs.`);
    return "all";
  };
  const searchInput = String(snapshot.searchInput || "").replace(/\s+/g, " ").trim();
  const folder = String(snapshot.folder || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  assetState.searchInput = searchInput;
  assetState.search = searchInput;
  assetState.viewMode = normalizeEnum(snapshot.viewMode, ["pieces", "maps", "unknown", "all"], "pieces");
  assetState.packFilter = normalizePackFilter(snapshot.packFilter);
  assetState.typeFilter = normalizeEnum(snapshot.typeFilter, ["all", "png", "webp", "jpg", "gif"], "all");
  assetState.alphaFilter = normalizeEnum(snapshot.alphaFilter, ["all", "yes", "no"], "all");
  assetState.sizeFilter = normalizeEnum(snapshot.sizeFilter, ["all", "tiny", "small", "medium", "large", "huge"], "all");
  assetState.sortMode = normalizeEnum(snapshot.sortMode, ["recent", "newest", "largest", "name"], "recent");
  assetState.folder = folder;
  syncAssetFilterControls();
  renderAssetFolderTree();
  if (shouldRender) renderAssetGrid();
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
  if (!assetState.loaded) {
    assetGridEl.innerHTML = `<div style="opacity:.75; grid-column:1/-1;">Open Asset Library to load items.</div>`;
    return;
  }
  const q = (assetState.search || "").trim().toLowerCase();
  const parsedSearch = parseAssetSearch(assetState.search);
  const folder = (assetState.folder || "").trim();
  const viewMode = String(assetState.viewMode || "pieces");
  const packFilterUi = String(assetState.packFilter || "all");
  const typeFilterUi = String(assetState.typeFilter || "all");
  const alphaFilterUi = String(assetState.alphaFilter || "all");
  const sizeFilter = String(assetState.sizeFilter || "all");
  const sortMode = String(assetState.sortMode || "recent");
  const conflictHints = [];
  const packFilter = parsedSearch.pack ? `query:${parsedSearch.pack}` : packFilterUi;
  const typeFilter = parsedSearch.type || typeFilterUi;
  let alphaFilter = alphaFilterUi;
  if (parsedSearch.alpha) {
    const a = parsedSearch.alpha;
    alphaFilter = (a === "yes" || a === "true" || a === "1") ? "yes" : (a === "no" || a === "false" || a === "0") ? "no" : alphaFilterUi;
  }
  if (parsedSearch.type && typeFilterUi !== "all" && parsedSearch.type !== typeFilterUi) {
    conflictHints.push(`type:${parsedSearch.type} vs UI type=${typeFilterUi}`);
  }
  if (parsedSearch.alpha && alphaFilterUi !== "all" && alphaFilter !== alphaFilterUi) {
    conflictHints.push(`alpha:${parsedSearch.alpha} vs UI alpha=${alphaFilterUi}`);
  }
  if (parsedSearch.pack && packFilterUi !== "all") {
    conflictHints.push(`pack:${parsedSearch.pack} vs UI pack=${packFilterUi}`);
  }
  renderAssetSearchMeta(parsedSearch, conflictHints);
  const ranked = [];
  for (const a of assetState.items) {
    const fp = String(a.folder_path || "");
    if (folder && fp !== folder) continue;
    const slug = String(a.pack_slug || "").trim();
    if (packFilter === "upload" && slug) continue;
    if (packFilter.startsWith("query:")) {
      const qPack = packFilter.slice("query:".length).trim().toLowerCase();
      const hay = (slug || "uploads").toLowerCase();
      if (!hay.includes(qPack)) continue;
    } else if (packFilter !== "all" && packFilter !== "upload" && slug !== packFilter) continue;
    const kind = assetKind(a);
    if (viewMode === "maps" && kind !== "map") continue;
    if (viewMode === "pieces" && kind !== "piece") continue;
    if (viewMode === "unknown" && kind !== "unknown") continue;
    const ext = assetFileExt(a);
    if (typeFilter !== "all" && ext !== typeFilter) continue;
    const hasAlpha = assetHasAlphaGuess(a);
    if (alphaFilter === "yes" && !hasAlpha) continue;
    if (alphaFilter === "no" && hasAlpha) continue;
    if (sizeFilter !== "all" && assetSizeBucket(a) !== sizeFilter) continue;
    const score = assetSearchScore(a, parsedSearch);
    if (score < 0) continue;
    ranked.push({ asset: a, score });
  }
  ranked.sort((ra, rb) => {
    if (q) {
      if (rb.score !== ra.score) return rb.score - ra.score;
    }
    const a = ra.asset;
    const b = rb.asset;
    if (sortMode === "name") {
      return String(a.name || "").localeCompare(String(b.name || ""));
    }
    if (sortMode === "largest") {
      const areaA = Math.max(0, Number(a.width || 0)) * Math.max(0, Number(a.height || 0));
      const areaB = Math.max(0, Number(b.width || 0)) * Math.max(0, Number(b.height || 0));
      if (areaA !== areaB) return areaB - areaA;
    } else if (sortMode === "recent") {
      const ra = Number(assetState.recentUsed[assetUsageKey(a)] || 0);
      const rb = Number(assetState.recentUsed[assetUsageKey(b)] || 0);
      if (ra !== rb) return rb - ra;
    }
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });
  const rows = ranked.map((r) => r.asset);
  const filterKey = `${q}\n${folder}\n${viewMode}\n${packFilter}\n${typeFilter}\n${alphaFilter}\n${sizeFilter}\n${sortMode}\n${rows.length}\n${assetState.recentVersion}`;
  if (assetState.filterKey !== filterKey) {
    assetState.filterKey = filterKey;
    assetState.renderCount = assetState.pageSize;
  }
  const visibleCount = Math.min(rows.length, Math.max(assetState.pageSize, assetState.renderCount));
  const visibleRows = rows.slice(0, visibleCount);
  assetState.hasMore = visibleCount < rows.length;
  const isMapWorkflow = viewMode === "maps";
  const isAllWorkflow = viewMode === "all";
  if (isMapWorkflow) {
    assetGridEl.style.gridTemplateColumns = "repeat(auto-fill, minmax(220px, 1fr))";
  } else if (isAllWorkflow) {
    assetGridEl.style.gridTemplateColumns = "repeat(auto-fill, minmax(140px, 1fr))";
  } else {
    assetGridEl.style.gridTemplateColumns = "repeat(auto-fill, minmax(110px, 1fr))";
  }
  if (!rows.length) {
    assetGridEl.innerHTML = `<div style="opacity:.75; grid-column:1/-1;">(no assets)</div>`;
    assetState.lastRenderKey = filterKey;
    assetState.lastRenderedCount = 0;
    return;
  }
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
    const packLabel = String(a.pack_slug || "").trim() || "uploads";
    const packMetaLabel = a.shared_in_session ? `${packLabel} • session-shared` : packLabel;
    const kind = assetKind(a);
    const kindBadge = kind === "map" ? "MAP" : kind === "piece" ? "PCS" : "?";
    const kindBadgeBg = kind === "map" ? "rgba(10,132,255,0.9)" : kind === "piece" ? "rgba(52,199,89,0.9)" : "rgba(255,149,0,0.92)";
    if (isMapWorkflow) {
      const setBgDisabled = isGM() ? "" : "disabled";
      return `
    <div
      data-asset-card="1"
      data-asset-idx="${idx}"
      title="${escapeHtml(String(a.name || "Asset"))} (Shift+Right-click: classify)"
      style="padding:8px; border:1px solid rgba(255,255,255,0.14); background:rgba(255,255,255,0.03); color:#eee; border-radius:8px;">
      <div style="width:100%; aspect-ratio:${previewAspect}; border-radius:8px; overflow:hidden; background:#1a1a1a; display:flex; align-items:center; justify-content:center; position:relative;">
        <img class="asset-thumb" ${thumbAttrs} alt="${escapeHtml(String(a.name || "Asset"))}" style="width:100%; height:100%; object-fit:cover;">
        <button type="button" data-asset-action="kind-open" data-asset-idx="${idx}" title="Classification" style="position:absolute; top:6px; left:6px; font-size:12px; line-height:1; color:#fff; background:rgba(0,0,0,0.65); border:1px solid rgba(255,255,255,0.35); border-radius:6px; padding:2px 6px;">⋯</button>
        <div data-asset-kind-menu style="display:none; position:absolute; top:30px; left:6px; z-index:6; background:rgba(0,0,0,0.92); border:1px solid rgba(255,255,255,0.22); border-radius:8px; padding:4px; min-width:130px;">
          <button type="button" data-asset-action="kind-map" data-asset-idx="${idx}" style="display:block; width:100%; margin:2px 0; text-align:left; padding:4px 6px;">Treat as Map</button>
          <button type="button" data-asset-action="kind-piece" data-asset-idx="${idx}" style="display:block; width:100%; margin:2px 0; text-align:left; padding:4px 6px;">Treat as Piece</button>
          <button type="button" data-asset-action="kind-unknown" data-asset-idx="${idx}" style="display:block; width:100%; margin:2px 0; text-align:left; padding:4px 6px;">Treat as Unknown</button>
          <button type="button" data-asset-action="kind-auto" data-asset-idx="${idx}" style="display:block; width:100%; margin:2px 0; text-align:left; padding:4px 6px;">Auto (clear)</button>
        </div>
        <span title="Kind: ${escapeHtml(kind)}" style="position:absolute; top:6px; right:6px; font-size:10px; font-weight:700; color:#fff; background:${kindBadgeBg}; padding:2px 6px; border-radius:999px;">${kindBadge}</span>
      </div>
      <div style="margin-top:8px; font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(String(a.name || "Asset"))}</div>
      <div style="font-size:11px; opacity:.8; margin-top:2px;">${escapeHtml(dimsLabel)} • ${escapeHtml(ext)} • ${escapeHtml(alphaLabel)}</div>
      <div style="font-size:11px; opacity:.7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(String(a.folder_path || "/"))} • ${escapeHtml(packMetaLabel)}</div>
      <div style="display:flex; gap:6px; margin-top:8px;">
        <button type="button" data-asset-action="preview" data-asset-idx="${idx}" style="flex:1; padding:4px 6px;">Preview</button>
        <button type="button" data-asset-action="set-bg" data-asset-idx="${idx}" ${setBgDisabled} style="flex:1; padding:4px 6px;">Set as Background</button>
      </div>
      <div style="display:flex; gap:6px; margin-top:6px;">
        <button type="button" data-asset-action="clear-bg" data-asset-idx="${idx}" ${setBgDisabled} style="flex:1; padding:4px 6px;">Clear BG</button>
        <button type="button" data-asset-action="fit-bg" data-asset-idx="${idx}" style="flex:1; padding:4px 6px;">Fit to View</button>
        <button type="button" data-asset-action="overlay" data-asset-idx="${idx}" style="flex:1; padding:4px 6px;">Use as Overlay</button>
        <button type="button" data-asset-action="spawn" data-asset-idx="${idx}" style="flex:1; padding:4px 6px;">Place Piece</button>
      </div>
    </div>
  `;
    }
    return `
    <button
      data-asset-card="1"
      data-asset-idx="${idx}"
      style="padding:6px; border:1px solid rgba(255,255,255,0.14); background:rgba(255,255,255,0.03); color:#eee; text-align:center;"
      title="${escapeHtml(String(a.name || "Asset"))} (Shift+Right-click: classify)">
      <div style="width:100%; aspect-ratio:1/1; border-radius:8px; overflow:hidden; background:#1a1a1a; display:flex; align-items:center; justify-content:center; position:relative;">
        <img class="asset-thumb" ${thumbAttrs} alt="${escapeHtml(String(a.name || "Asset"))}" style="width:100%; height:100%; object-fit:cover;">
        <button type="button" data-asset-action="kind-open" data-asset-idx="${idx}" title="Classification" style="position:absolute; top:6px; left:6px; font-size:12px; line-height:1; color:#fff; background:rgba(0,0,0,0.65); border:1px solid rgba(255,255,255,0.35); border-radius:6px; padding:2px 6px;">⋯</button>
        <div data-asset-kind-menu style="display:none; position:absolute; top:30px; left:6px; z-index:6; background:rgba(0,0,0,0.92); border:1px solid rgba(255,255,255,0.22); border-radius:8px; padding:4px; min-width:130px;">
          <button type="button" data-asset-action="kind-map" data-asset-idx="${idx}" style="display:block; width:100%; margin:2px 0; text-align:left; padding:4px 6px;">Treat as Map</button>
          <button type="button" data-asset-action="kind-piece" data-asset-idx="${idx}" style="display:block; width:100%; margin:2px 0; text-align:left; padding:4px 6px;">Treat as Piece</button>
          <button type="button" data-asset-action="kind-unknown" data-asset-idx="${idx}" style="display:block; width:100%; margin:2px 0; text-align:left; padding:4px 6px;">Treat as Unknown</button>
          <button type="button" data-asset-action="kind-auto" data-asset-idx="${idx}" style="display:block; width:100%; margin:2px 0; text-align:left; padding:4px 6px;">Auto (clear)</button>
        </div>
        <span title="Kind: ${escapeHtml(kind)}" style="position:absolute; top:6px; right:6px; font-size:10px; font-weight:700; color:#fff; background:${kindBadgeBg}; padding:2px 6px; border-radius:999px;">${kindBadge}</span>
      </div>
      <div style="margin-top:6px; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(String(a.name || "Asset"))}</div>
      <div style="font-size:10px; opacity:.75; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(String(a.folder_path || "/"))}</div>
      <div style="font-size:10px; opacity:.65; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(packMetaLabel)}</div>
    </button>
  `;
  }).join("");
  const appendOnly = assetState.lastRenderKey === filterKey && visibleCount > assetState.lastRenderedCount && assetState.lastRenderedCount > 0;
  const footerHtml = assetState.hasMore ? `<div data-asset-more="1" style="opacity:.7; grid-column:1/-1; text-align:center; padding:4px 0;">Scroll to load more…</div>` : "";
  if (appendOnly) {
    const oldHint = assetGridEl.querySelector("[data-asset-more='1']");
    if (oldHint) oldHint.remove();
    assetGridEl.insertAdjacentHTML("beforeend", renderCardsHtml(visibleRows.slice(assetState.lastRenderedCount), assetState.lastRenderedCount));
    if (footerHtml) assetGridEl.insertAdjacentHTML("beforeend", footerHtml);
  } else {
    assetGridEl.innerHTML = renderCardsHtml(visibleRows, 0) + footerHtml;
  }
  assetState.lastRenderKey = filterKey;
  assetState.lastRenderedCount = visibleCount;
  observeAssetThumbs();
  assetGridEl.querySelectorAll("[data-asset-card='1']").forEach((card) => {
    const idx = Number(card.getAttribute("data-asset-idx"));
    const a = visibleRows[idx];
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

    if (!isMapWorkflow) {
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
      if (!isGM()) return;
      if (a.readonly) return;
      if (!confirm(`Delete asset '${a.name || "asset"}'?`)) return;
      try {
        await apiDeleteAsset(String(a.asset_id || a.id || ""));
        await refreshAssetsPanel();
      } catch (err) {
        log(`ASSET DELETE ERROR: ${err.message || err}`);
      }
    };
  });
  assetGridEl.querySelectorAll("button[data-asset-action]").forEach((btn) => {
    const idx = Number(btn.getAttribute("data-asset-idx"));
    const action = String(btn.getAttribute("data-asset-action") || "");
    const a = visibleRows[idx];
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
      if (action === "preview") { openMapPreview(a); return; }
      if (action === "set-bg") { setAssetAsBackground(a); return; }
      if (action === "clear-bg") { clearRoomBackground(); return; }
      if (action === "fit-bg") { fitBackgroundToView(a); return; }
      if (action === "overlay") { spawnOverlayAsset(a); return; }
      if (action === "spawn") { spawnPackAsset(a); }
    };
  });
  requestAnimationFrame(maybeLoadMoreAssets);
}

// ─── Folder tree ──────────────────────────────────────────────────────────────

function buildAssetFolderTree(paths = []) {
  const root = { name: "", path: "", children: new Map(), count: 0 };
  for (const rawPath of paths) {
    const cleaned = String(rawPath || "").trim().replace(/^\/+|\/+$/g, "");
    if (!cleaned) continue;
    const parts = cleaned.split("/").filter(Boolean);
    let node = root;
    node.count += 1;
    let pathAcc = "";
    for (const part of parts) {
      pathAcc = pathAcc ? `${pathAcc}/${part}` : part;
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, path: pathAcc, children: new Map(), count: 0 });
      }
      node = node.children.get(part);
      node.count += 1;
    }
  }
  return root;
}

function renderAssetFolderTree() {
  if (!assetFolderTreeEl) return;
  const allFolders = assetState.items.map((a) => String(a.folder_path || "")).filter(Boolean);
  const root = buildAssetFolderTree(allFolders);
  const selected = String(assetState.folder || "");
  const lines = [];

  const row = (node, depth, hasChildren) => {
    const isSelected = selected === node.path;
    const expanded = expandedAssetFolders.has(node.path);
    const indent = depth * 14;
    const caret = hasChildren ? (expanded ? "▾" : "▸") : "•";
    const label = node.path || "All folders";
    const count = node.path ? node.count : assetState.items.length;
    lines.push(`
      <div style="display:flex; align-items:center; gap:6px; padding:2px 4px; border-radius:6px; ${isSelected ? "background:rgba(0,209,255,0.15);" : ""}">
        <button type="button" data-folder-toggle="${escapeHtml(node.path)}" style="width:16px; text-align:center; background:transparent; border:none; color:#ddd; cursor:${hasChildren ? "pointer" : "default"};">${caret}</button>
        <button type="button" data-folder-select="${escapeHtml(node.path)}" style="flex:1; text-align:left; background:transparent; border:none; color:${isSelected ? "#fff" : "#ddd"}; cursor:pointer; padding-left:${indent}px;">
          ${escapeHtml(label)} <span style="opacity:.65">(${count})</span>
        </button>
      </div>
    `);
  };

  const walk = (node, depth) => {
    const children = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
    row(node, depth, children.length > 0);
    if (!children.length || !expandedAssetFolders.has(node.path)) return;
    for (const child of children) walk(child, depth + 1);
  };
  walk(root, 0);
  assetFolderTreeEl.innerHTML = lines.join("") || `<div style="opacity:.75;">(no folders)</div>`;
}

// ─── Asset loading & refresh ──────────────────────────────────────────────────

async function refreshAssetsPanel() {
  if (assetState.loading) return;
  assetState.loading = true;
  const metadataReceivedAt = Date.now();
  try {
    const [data] = await Promise.all([
      apiGet(`/api/assets?src=assetlib&lite=1${assetSessionQuery()}`),
      refreshAssetSessionPackData(),
    ]);
    assetState.items = Array.isArray(data.assets) ? data.assets.map((a) => normalizePackBackedRecord(a)) : [];
    resetAssetDiagnostics();
    for (const item of assetState.items) {
      recordAssetDiagnostic(item, { metadataReceivedAt });
    }
    assetState.loaded = true;
    assetState.filterKey = "";
    assetState.renderCount = assetState.pageSize;
    refreshAssetFilterOptions();
    renderAssetSessionSharePanel();
    applyAssetFilterPresetForSource(assetState.packFilter);
    renderAssetSavedSets();
    renderAssetFolderTree();
    renderAssetGrid();
  } catch (e) {
    assetState.items = [];
    assetState.loaded = false;
    resetAssetDiagnostics();
    resetAssetSessionPackState();
    if (assetGridEl) assetGridEl.innerHTML = `<div style="color:#ffb3b3; grid-column:1/-1;">Asset load failed</div>`;
    log(`ASSETS ERROR: ${e.message || e}`);
  } finally {
    assetState.loading = false;
  }
}

async function ensureAssetPanelReady() {
  if (assetState.loaded || assetState.loading) {
    renderAssetFolderTree();
    renderAssetGrid();
    return;
  }
  await refreshAssetsPanel();
}

function isAssetsTabActive() {
  const tab = document.getElementById("tab-assets");
  return !!tab && tab.classList.contains("active");
}

function maybeLoadMoreAssets() {
  if (!isAssetsTabActive()) return;
  if (!assetState.loaded || !assetState.hasMore) return;
  const scroller = drawerContentEl || assetPanel;
  if (!scroller) return;
  const remaining = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
  if (remaining > 280) return;
  assetState.renderCount += assetState.pageSize;
  renderAssetGrid();
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
  if (assetSessionShareRefreshBtnEl) assetSessionShareRefreshBtnEl.onclick = async () => {
    await refreshAssetSessionPackData();
    renderAssetSessionSharePanel();
    if (assetState.loaded) await refreshAssetsPanel();
  };
  if (assetSearchInputEl) assetSearchInputEl.addEventListener("input", () => {
    assetState.searchInput = assetSearchInputEl.value || "";
    if (assetSearchDebounceTimer) clearTimeout(assetSearchDebounceTimer);
    assetSearchDebounceTimer = setTimeout(() => {
      assetState.search = assetState.searchInput;
      renderAssetGrid();
    }, assetState.searchDebounceMs);
  });
  if (assetViewModeEl) {
    assetViewModeEl.value = assetState.viewMode;
    assetViewModeEl.addEventListener("change", () => {
      assetState.viewMode = String(assetViewModeEl.value || "pieces");
      saveAssetFilterPreset();
      renderAssetGrid();
    });
  }
  if (assetPackFilterEl) {
    assetPackFilterEl.value = assetState.packFilter;
    assetPackFilterEl.addEventListener("change", () => {
      const prev = String(assetState.packFilter || "all");
      saveAssetFilterPreset();
      assetState.packFilter = String(assetPackFilterEl.value || "all");
      applyAssetFilterPresetForSource(assetState.packFilter, prev !== assetState.packFilter);
      renderAssetGrid();
    });
  }
  if (assetTypeFilterEl) {
    assetTypeFilterEl.value = assetState.typeFilter;
    assetTypeFilterEl.addEventListener("change", () => {
      assetState.typeFilter = String(assetTypeFilterEl.value || "all");
      saveAssetFilterPreset();
      renderAssetGrid();
    });
  }
  if (assetAlphaFilterEl) {
    assetAlphaFilterEl.value = assetState.alphaFilter;
    assetAlphaFilterEl.addEventListener("change", () => {
      assetState.alphaFilter = String(assetAlphaFilterEl.value || "all");
      saveAssetFilterPreset();
      renderAssetGrid();
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
      assetState.sortMode = String(assetSortModeEl.value || "recent");
      saveAssetFilterPreset();
      renderAssetGrid();
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
  if (assetFolderTreeEl) assetFolderTreeEl.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-folder-toggle]");
    if (toggle) {
      const path = String(toggle.getAttribute("data-folder-toggle") || "");
      if (expandedAssetFolders.has(path)) expandedAssetFolders.delete(path);
      else expandedAssetFolders.add(path);
      renderAssetFolderTree();
      return;
    }
    const selectBtn = e.target.closest("[data-folder-select]");
    if (selectBtn) {
      assetState.folder = String(selectBtn.getAttribute("data-folder-select") || "");
      saveAssetFilterPreset();
      renderAssetFolderTree();
      renderAssetGrid();
    }
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
