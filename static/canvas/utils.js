// utils.js — pure utility helpers with no shared app-state dependencies
// Loaded before canvas.js; all functions are globals in the same script scope.

"use strict";

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatShortTime(ts) {
  const value = Number(ts || 0);
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (_) {
    return "";
  }
}

function makeId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function toPlainObjectMap(m) {
  const out = {};
  for (const [k, v] of m.entries()) out[k] = v;
  return out;
}

function parseMoveSeq(payload) {
  const seq = Number(payload?.move_seq);
  return Number.isFinite(seq) ? seq : null;
}

function normalizeAngleDeg(rad) {
  const raw = Number(rad || 0) * (180 / Math.PI);
  let out = ((raw + 180) % 360 + 360) % 360 - 180;
  if (Object.is(out, -0)) out = 0;
  return out;
}

function normalizeWorldRect(a, b) {
  return {
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
  };
}

function normalizeLayerBand(value) {
  return value === "above_assets" ? "above_assets" : "below_assets";
}

function signedAssetScale(raw, fallback = 1) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return fallback;
  return n;
}

function toast(msg) {
  const el = document.createElement("div");
  el.textContent = String(msg || "");
  el.style.position = "fixed";
  el.style.right = "14px";
  el.style.top = "78px";
  el.style.maxWidth = "360px";
  el.style.padding = "8px 10px";
  el.style.borderRadius = "8px";
  el.style.background = "rgba(20,20,20,0.92)";
  el.style.border = "1px solid rgba(255,255,255,0.16)";
  el.style.color = "#f0f0f0";
  el.style.fontSize = "12px";
  el.style.zIndex = "5000";
  el.style.boxShadow = "0 6px 20px rgba(0,0,0,0.35)";
  document.body.appendChild(el);
  setTimeout(() => {
    try { el.remove(); } catch (_) {}
  }, 2600);
}

function pointToSegmentDistance(wx, wy, x1, y1, x2, y2) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const len2 = vx * vx + vy * vy;
  if (len2 <= 0) return Math.hypot(wx - x1, wy - y1);
  let t = ((wx - x1) * vx + (wy - y1) * vy) / len2;
  t = clamp(t, 0, 1);
  const px = x1 + t * vx;
  const py = y1 + t * vy;
  return Math.hypot(wx - px, wy - py);
}

function localStrokeHitsCircle(stroke, cx, cy, r) {
  const rr = r * r;
  for (const pt of (stroke.points || [])) {
    const dx = Number(pt.x || 0) - cx;
    const dy = Number(pt.y || 0) - cy;
    if (dx * dx + dy * dy <= rr) return true;
  }
  return false;
}

function localShapeHitsCircle(shape, cx, cy, r) {
  const rr = r * r;
  if (shape.type === "line" || shape.type === "arrow") {
    const x1 = Number(shape.x1 || 0);
    const y1 = Number(shape.y1 || 0);
    const x2 = Number(shape.x2 || 0);
    const y2 = Number(shape.y2 || 0);
    const vx = x2 - x1;
    const vy = y2 - y1;
    const segLen2 = vx * vx + vy * vy;
    if (segLen2 === 0) {
      const dx = cx - x1;
      const dy = cy - y1;
      return dx * dx + dy * dy <= rr;
    }
    let t = ((cx - x1) * vx + (cy - y1) * vy) / segLen2;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * vx;
    const py = y1 + t * vy;
    const dx = cx - px;
    const dy = cy - py;
    return dx * dx + dy * dy <= rr;
  }
  if (shape.type === "rect") {
    const minx = Math.min(Number(shape.x1 || 0), Number(shape.x2 || 0));
    const maxx = Math.max(Number(shape.x1 || 0), Number(shape.x2 || 0));
    const miny = Math.min(Number(shape.y1 || 0), Number(shape.y2 || 0));
    const maxy = Math.max(Number(shape.y1 || 0), Number(shape.y2 || 0));
    const dx = Math.max(minx - cx, 0, cx - maxx);
    const dy = Math.max(miny - cy, 0, cy - maxy);
    return dx * dx + dy * dy <= rr;
  }
  if (shape.type === "circle") {
    const ox = Number(shape.x1 || 0);
    const oy = Number(shape.y1 || 0);
    const rad = Math.hypot(Number(shape.x2 || 0) - ox, Number(shape.y2 || 0) - oy);
    const dist = Math.hypot(cx - ox, cy - oy);
    return dist <= rad + r;
  }
  if (shape.type === "text") {
    const ox = Number(shape.x1 || 0);
    const oy = Number(shape.y1 || 0);
    const fontSize = clamp(Number(shape.font_size || 20), 8, 96);
    const dist = Math.hypot(cx - ox, cy - oy);
    return dist <= r + Math.max(8, fontSize * 0.6);
  }
  return false;
}
