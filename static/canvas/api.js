// api.js — HTTP/API helpers
// Loaded before canvas.js. All functions are globals in the same script scope.

"use strict";

function apiUrl(path, includeGm = false) {
  const url = new URL(path, window.location.origin);
  return url.toString();
}

async function readErrorText(res) {
  try {
    const text = await res.text();
    return text || `HTTP ${res.status}`;
  } catch (_) {
    return `HTTP ${res.status}`;
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableNetworkError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  if (err instanceof TypeError) return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes("networkerror") || msg.includes("failed to fetch") || msg.includes("load failed");
}

async function apiRequest(path, options = {}, { retries = 0, timeoutMs = 15000 } = {}) {
  const url = apiUrl(path);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller ? controller.signal : undefined,
      });
      if (!res.ok) {
        const message = await readErrorText(res);
        if (attempt < retries && isRetryableStatus(res.status)) {
          lastError = new Error(message);
          continue;
        }
        throw new Error(message);
      }
      return res;
    } catch (err) {
      if (attempt < retries && isRetryableNetworkError(err)) {
        lastError = err;
        continue;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || new Error("Request failed");
}

async function apiGet(path, includeGm = false) {
  const res = await apiRequest(path, {}, { retries: 2, timeoutMs: 20000 });
  return res.json();
}

async function apiPost(path, body = {}, includeGm = false) {
  const res = await apiRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, { timeoutMs: 20000 });
  return res.json();
}

async function apiPatch(path, body = {}, includeGm = false) {
  const res = await apiRequest(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, { timeoutMs: 20000 });
  return res.json();
}

async function apiDelete(path, includeGm = false) {
  const res = await apiRequest(path, { method: "DELETE" }, { timeoutMs: 20000 });
  return res.json();
}

async function apiUploadBackground(roomId, file) {
  const data = new FormData();
  data.append("file", file);
  const res = await apiRequest(`/api/rooms/${encodeURIComponent(roomId)}/background-upload`, {
    method: "POST",
    body: data,
  }, { timeoutMs: 60000 });
  return res.json();
}

async function apiUploadAsset(file, name = "", tags = "") {
  const data = new FormData();
  data.append("file", file);
  if (name) data.append("name", name);
  if (tags) data.append("tags", tags);
  const res = await apiRequest("/api/assets/upload", {
    method: "POST",
    body: data,
  }, { timeoutMs: 60000 });
  return res.json();
}

async function apiUploadAssetZip(file, tags = "") {
  const data = new FormData();
  data.append("file", file);
  if (tags) data.append("tags", tags);
  const res = await apiRequest("/api/assets/upload-zip", {
    method: "POST",
    body: data,
  }, { timeoutMs: 120000 });
  return res.json();
}

async function apiDeleteAsset(assetId) {
  return apiDelete(`/api/assets/${encodeURIComponent(assetId)}`);
}

function apiAssetFileUrl(assetId) {
  return `/api/assets/file/${encodeURIComponent(String(assetId || ""))}`;
}

function extractLegacyPrivatePackAssetId(url) {
  const m = String(url || "").match(/^\/private-packs\/[^/]+\/originals\/([A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/);
  return m ? m[1] : "";
}

function normalizePackBackedRecord(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const out = { ...raw };
  const currentAssetId = String(out.asset_id || "").trim();
  const legacyAssetId = currentAssetId || extractLegacyPrivatePackAssetId(out.image_url || out.url_original || out.url);
  if (legacyAssetId && !out.asset_id) out.asset_id = legacyAssetId;
  const sourceRaw = String(out.source || "").trim().toLowerCase();
  if (sourceRaw === "pack" || (legacyAssetId && sourceRaw !== "upload")) out.source = "pack";
  if (out.asset_id) {
    const assetUrl = apiAssetFileUrl(out.asset_id);
    if (!out.image_url) out.image_url = assetUrl;
    if (!out.url_original) out.url_original = assetUrl;
    if (!out.url_thumb) out.url_thumb = assetUrl;
  }
  if (out.source === "pack" && out.asset_id) {
    out.image_url = apiAssetFileUrl(out.asset_id);
    if (out.url_original) out.url_original = apiAssetFileUrl(out.asset_id);
  } else if (!out.image_url && out.url) {
    out.image_url = out.url;
  }
  if (Object.prototype.hasOwnProperty.call(out, "url")) delete out.url;
  return out;
}

function assetPreviewUrl(asset) {
  const rec = normalizePackBackedRecord(asset);
  if (rec && typeof rec === "object") {
    // thumb_url is a direct /uploads/ static path for uploaded assets.
    // Using it avoids an auth-endpoint roundtrip per thumbnail since /uploads/ is
    // statically mounted and the browser caches the response without hitting Python.
    if (rec.thumb_url) return String(rec.thumb_url);
    if (rec.asset_id) return apiAssetFileUrl(rec.asset_id);
  }
  return String(rec?.url_thumb || rec?.url_original || rec?.image_url || "");
}

function withAssetLibSrc(url) {
  const raw = String(url || "").trim();
  if (!raw) return raw;
  try {
    const u = new URL(raw, window.location.origin);
    u.searchParams.set("src", "assetlib");
    return u.pathname + u.search + u.hash;
  } catch (_) {
    const sep = raw.includes("?") ? "&" : "?";
    return `${raw}${sep}src=assetlib`;
  }
}
