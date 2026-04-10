// api.js — HTTP/API helpers
// Loaded before canvas.js. All functions are globals in the same script scope.

"use strict";

function apiUrl(path, includeGm = false) {
  const url = new URL(path, window.location.origin);
  return url.toString();
}

async function apiGet(path, includeGm = false) {
  const res = await fetch(apiUrl(path, includeGm));
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiPost(path, body = {}, includeGm = false) {
  const res = await fetch(apiUrl(path, includeGm), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiPatch(path, body = {}, includeGm = false) {
  const res = await fetch(apiUrl(path, includeGm), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiDelete(path, includeGm = false) {
  const res = await fetch(apiUrl(path, includeGm), { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiUploadBackground(roomId, file) {
  const data = new FormData();
  data.append("file", file);
  const res = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(roomId)}/background-upload`, true), {
    method: "POST",
    body: data,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiUploadAsset(file, name = "", tags = "") {
  const data = new FormData();
  data.append("file", file);
  if (name) data.append("name", name);
  if (tags) data.append("tags", tags);
  const res = await fetch("/api/assets/upload", {
    method: "POST",
    body: data,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiUploadAssetZip(file, tags = "") {
  const data = new FormData();
  data.append("file", file);
  if (tags) data.append("tags", tags);
  const res = await fetch("/api/assets/upload-zip", {
    method: "POST",
    body: data,
  });
  if (!res.ok) throw new Error(await res.text());
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
  if (rec && typeof rec === "object" && String(rec.source || "").toLowerCase() === "pack" && rec.asset_id) {
    return apiAssetFileUrl(rec.asset_id);
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
