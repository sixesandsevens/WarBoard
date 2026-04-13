"use strict";

// ─── Terrain Subsystem ──────────────────────────────────────────────────────
// Extracted from canvas.js. All declarations are globals (no wrapping IIFE).
// Loaded before canvas.js.

// ── terrainBrush / activePaintStroke ────────────────────────────────────────
const terrainBrush = {
  material_id: "mud",
  radius: 60,
  opacity: 0.6,
  hardness: 0.4,
  op: "paint",
};
let activePaintStroke = null;

// ── Terrain constants, palettes, and state object ───────────────────────────
const TERRAIN_MACRO_TILE = 1024;
const TERRAIN_MICRO_TILE = 512;
const TERRAIN_BREAKUP_TILE = 1536;
const TERRAIN_STYLES = new Set(["grassland", "dirt", "shore", "snow", "desert", "water", "volcano"]);
const BIOME_PALETTES = {
  grassland: {
    base: "#2d3d22",
    speckA: "#38492a",
    speckB: "#24311d",
    strokeA: "#465a33",
    strokeB: "#1d2818",
    stain: "#6a5b3d",
    pebbleA: "#6d6a63",
    pebbleB: "#4f4b45",
    shadowShade: [16, 18, 14],
  },
  dirt: {
    base: "#4b3c2f",
    speckA: "#584637",
    speckB: "#3c3026",
    strokeA: "#6a5642",
    strokeB: "#2f251d",
    stain: "#7d6545",
    pebbleA: "#7a6a58",
    pebbleB: "#5a4c3d",
    shadowShade: [18, 15, 12],
  },
  shore: {
    base: "#6c5a45",
    speckA: "#7b6851",
    speckB: "#5b4b3a",
    strokeA: "#8b765b",
    strokeB: "#4a3d2f",
    stain: "#8a7557",
    pebbleA: "#8b7a67",
    pebbleB: "#695b4c",
    shadowShade: [20, 17, 14],
  },
  snow: {
    base: "#bcc2c7",
    speckA: "#c9d0d5",
    speckB: "#aab1b7",
    strokeA: "#d1d8de",
    strokeB: "#929ba2",
    stain: "#9aa2aa",
    pebbleA: "#7e878f",
    pebbleB: "#666f77",
    shadowShade: [24, 26, 30],
  },
  desert: {
    base: "#a58a5e",
    speckA: "#b39668",
    speckB: "#8f7750",
    strokeA: "#b79a69",
    strokeB: "#7a6544",
    stain: "#8c6f48",
    pebbleA: "#7b6545",
    pebbleB: "#5e4d36",
    shadowShade: [22, 18, 12],
  },
  water: {
    base: "#27485a",
    speckA: "#305a70",
    speckB: "#203b4a",
    strokeA: "#3c6b82",
    strokeB: "#162b36",
    stain: "#3b6477",
    pebbleA: "#567c8f",
    pebbleB: "#345564",
    shadowShade: [8, 16, 22],
  },
  volcano: {
    base: "#2a2321",
    speckA: "#352c2a",
    speckB: "#1d1816",
    strokeA: "#43352f",
    strokeB: "#130f0d",
    stain: "#8e371d",
    pebbleA: "#5e544f",
    pebbleB: "#403935",
    shadowShade: [20, 12, 10],
  },
  cobble: {
    base: "#474441",
    speckA: "#55514d",
    speckB: "#373431",
    strokeA: "#6e6964",
    strokeB: "#252321",
    stain: "#57524d",
    pebbleA: "#625d58",
    pebbleB: "#4d4844",
    shadowShade: [30, 28, 26],
  },
};
const terrain = {
  seed: null,
  gridSize: null,
  style: null,
  patternA: null,
  patternB: null,
  patternC: null,
  tileA: null,
  tileB: null,
  tileC: null,
};

// ── Terrain helper functions ─────────────────────────────────────────────────
function normalizeBackgroundMode(mode, bgUrl) {
  if (mode === "terrain" || mode === "url" || mode === "solid") return mode;
  return bgUrl ? "url" : "solid";
}

function normalizeTerrainSeed(seed, fallback = 1) {
  const parsed = Number(seed);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return fallback;
}

function normalizeTerrainStyle(style) {
  return TERRAIN_STYLES.has(style) ? style : "grassland";
}

function normalizeBiomeStyle(style) {
  return BIOME_PALETTES[style] ? style : "grassland";
}

function randomTerrainSeed() {
  if (window.crypto && crypto.getRandomValues) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return Math.max(1, (a[0] & 0x7fffffff));
  }
  return Math.floor(Math.random() * 2_147_483_647) + 1;
}

function terrainScaleFromGrid(gridSize) {
  return clamp((gridSize || 50) / 50, 0.55, 2.4);
}

function mulberry32(seed) {
  let s = seed >>> 0;
  const rnd = function () {
    let t = s += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rnd.save    = () => s;
  rnd.restore = (v) => { s = v >>> 0; };
  return rnd;
}

function shadeColor(baseRgb, variance, rnd) {
  const r = clamp(Math.round(baseRgb[0] + (rnd() - 0.5) * variance), 0, 255);
  const g = clamp(Math.round(baseRgb[1] + (rnd() - 0.5) * variance), 0, 255);
  const b = clamp(Math.round(baseRgb[2] + (rnd() - 0.5) * variance), 0, 255);
  return `rgb(${r},${g},${b})`;
}

function colorWithAlpha(color, alpha) {
  const a = clamp(alpha, 0, 1);
  if (typeof color !== "string") return `rgba(0,0,0,${a})`;
  const hex = color.trim();
  if (hex.startsWith("#")) {
    const raw = hex.slice(1);
    const full = raw.length === 3
      ? raw.split("").map((ch) => ch + ch).join("")
      : raw;
    if (full.length === 6) {
      const r = parseInt(full.slice(0, 2), 16);
      const g = parseInt(full.slice(2, 4), 16);
      const b = parseInt(full.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${a})`;
    }
  }
  return color;
}

function drawCloudShadows(c, rnd, tileSize, intensity = 0.045) {
  const clouds = 2 + Math.floor(rnd() * 2);
  for (let i = 0; i < clouds; i++) {
    const cx = rnd() * tileSize;
    const cy = rnd() * tileSize;
    const r = tileSize * (0.33 + rnd() * 0.27);
    const dxs = [0], dys = [0];
    if (cx - r < 0) dxs.push(tileSize);
    if (cx + r > tileSize) dxs.push(-tileSize);
    if (cy - r < 0) dys.push(tileSize);
    if (cy + r > tileSize) dys.push(-tileSize);
    for (const dx of dxs) {
      for (const dy of dys) {
        const ox = cx + dx, oy = cy + dy;
        const g = c.createRadialGradient(ox, oy, r * 0.2, ox, oy, r);
        g.addColorStop(0, `rgba(0,0,0,${intensity})`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = g;
        c.beginPath();
        c.arc(ox, oy, r, 0, Math.PI * 2);
        c.fill();
      }
    }
  }
}

function applyTerrainMoodPass(c, tileSize, style) {
  const img = c.getImageData(0, 0, tileSize, tileSize);
  const d = img.data;
  const tint = style === "snow"
    ? [0.94, 0.96, 0.97]
    : style === "water"
      ? [0.92, 0.95, 0.93]
      : [0.95, 0.97, 0.93];

  for (let i = 0; i < d.length; i += 4) {
    const alpha = d[i + 3];
    if (!alpha) continue;
    const gray = (d[i] + d[i + 1] + d[i + 2]) / 3;
    d[i] = clamp(Math.round((d[i] * 0.78 + gray * 0.22) * 0.87 * tint[0]), 0, 255);
    d[i + 1] = clamp(Math.round((d[i + 1] * 0.78 + gray * 0.22) * 0.87 * tint[1]), 0, 255);
    d[i + 2] = clamp(Math.round((d[i + 2] * 0.78 + gray * 0.22) * 0.87 * tint[2]), 0, 255);
  }

  c.putImageData(img, 0, 0);

  c.save();
  c.globalCompositeOperation = "multiply";
  c.fillStyle = style === "snow" ? "rgba(24, 28, 26, 0.08)" : "rgba(36, 30, 24, 0.10)";
  c.fillRect(0, 0, tileSize, tileSize);
  c.restore();
}

function normalizedWorldTone() {
  return clamp(Number(state?.world_tone ?? 0.32), 0, 1);
}

function describeWorldTone(t = normalizedWorldTone()) {
  if (t <= 0.16) return "Grimdark";
  if (t <= 0.38) return "Moody";
  if (t <= 0.62) return "Neutral";
  if (t <= 0.84) return "Heroic";
  return "Whimsy";
}

function worldToneParams() {
  const t = normalizedWorldTone();
  const midpoint = 0.5;
  const grim = Math.pow(clamp((midpoint - t) / midpoint, 0, 1), 1.6);
  const whimsy = Math.pow(clamp((t - midpoint) / midpoint, 0, 1), 1.2);
  const neutral = 1 - Math.max(grim, whimsy);
  const assetToneStrength = 0.8;
  return {
    t,
    eased: t * t * (3 - (2 * t)),
    grim,
    whimsy,
    neutral,
    assetToneStrength,
    terrainMicroAlpha: 0.34 + (0.12 * whimsy) - (0.03 * grim),
    terrainBreakupAlpha: 0.10 + (0.06 * whimsy) - (0.015 * grim),
    terrainWashAlpha: 0.20 * grim,
    assetWashAlpha: 0,
    bgWashAlpha: 0.16 * grim,
    terrainLiftAlpha: 0.10 * whimsy,
    assetLiftAlpha: 0,
    bgLiftAlpha: 0.07 * whimsy,
    assetSaturation: 1 - (0.16 * grim * assetToneStrength) + (0.25 * whimsy * assetToneStrength),
    assetBrightness: 1 - (0.10 * grim * assetToneStrength) + (0.08 * whimsy * assetToneStrength),
    assetContrast: 1 + (0.25 * grim * assetToneStrength) + (0.04 * whimsy * assetToneStrength),
    assetTint: [
      1 - (0.05 * grim * assetToneStrength) + (0.02 * whimsy * assetToneStrength),
      1 - (0.04 * grim * assetToneStrength) + (0.03 * whimsy * assetToneStrength),
      1 - (0.01 * grim * assetToneStrength) + (0.08 * whimsy * assetToneStrength),
    ],
    assetHighlightPreserve: 8 + (12 * grim) + (4 * whimsy),
    assetShadowLift: 4 + (8 * grim) + (2 * whimsy),
    label: describeWorldTone(t),
  };
}

function refreshWorldToneUi() {
  if (worldToneEl) worldToneEl.value = String(Math.round(normalizedWorldTone() * 100));
  if (worldToneValEl) worldToneValEl.textContent = describeWorldTone();
}

function applyWorldToneWashRect(x, y, w, h, alpha = null) {
  const tone = worldToneParams();
  const washAlpha = alpha == null ? tone.assetWashAlpha : alpha;
  if (washAlpha <= 0.001 || w <= 0 || h <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = `rgba(42,44,50,${washAlpha.toFixed(3)})`;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function applyWorldToneLiftRect(x, y, w, h, alpha = 0) {
  if (alpha <= 0.001 || w <= 0 || h <= 0) return;
  ctx.save();
  ctx.fillStyle = `rgba(228,220,204,${alpha.toFixed(3)})`;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function buildTerrainPattern(ctxMain, seed, tileSize = 512, opts = {}) {
  const mode = opts.mode || "macro";
  const scale = clamp(opts.scale || 1, 0.55, 2.4);
  const style = normalizeBiomeStyle(opts.style);
  const transparentBase = !!opts.transparentBase;
  const palette = BIOME_PALETTES[style];
  const off = document.createElement("canvas");
  off.width = tileSize;
  off.height = tileSize;
  const c = off.getContext("2d");
  const rnd = mulberry32(seed);
  const clampByte = (v) => Math.max(0, Math.min(255, v));

  if (!(mode === "cobble" && transparentBase)) {
    c.fillStyle = palette.base;
    c.fillRect(0, 0, tileSize, tileSize);
  }

  if (mode === "macro" || mode === "macro_soft") {
    c.globalAlpha = mode === "macro_soft" ? 0.04 : 0.07;
    const macroSpeckleCount = mode === "macro_soft"
      ? Math.max(1200, Math.floor(3200 / Math.sqrt(scale)))
      : Math.max(1600, Math.floor(5200 / Math.sqrt(scale)));
    for (let i = 0; i < macroSpeckleCount; i++) {
      const x = rnd() * tileSize;
      const y = rnd() * tileSize;
      const szBase = mode === "macro_soft" ? 14 : 8;
      const szRange = mode === "macro_soft" ? 30 : 24;
      const sz = (szBase + rnd() * szRange) * scale;
      const speckColor = rnd() < 0.5 ? palette.speckA : palette.speckB;
      c.fillStyle = speckColor;
      c.fillRect(x, y, sz, sz);
      if (x + sz > tileSize) c.fillRect(x - tileSize, y, sz, sz);
      if (y + sz > tileSize) c.fillRect(x, y - tileSize, sz, sz);
      if (x + sz > tileSize && y + sz > tileSize) c.fillRect(x - tileSize, y - tileSize, sz, sz);
    }

    const patchCount = Math.max(2, Math.round(3 / Math.sqrt(scale)));
    for (let b = 0; b < patchCount; b++) {
      const cx = rnd() * tileSize;
      const cy = rnd() * tileSize;
      const scaleMin = mode === "macro_soft" ? 0.22 : 0.12;
      const scaleRange = mode === "macro_soft" ? 0.20 : 0.16;
      const r = tileSize * (scaleMin + rnd() * scaleRange) * scale;
      const stainAlpha = mode === "macro_soft" ? 0.05 : 0.08;
      const edgeCount = Math.max(14, Math.round(36 / Math.sqrt(scale)));
      const dxs = [0], dys = [0];
      if (cx - r < 0) dxs.push(tileSize);
      if (cx + r > tileSize) dxs.push(-tileSize);
      if (cy - r < 0) dys.push(tileSize);
      if (cy + r > tileSize) dys.push(-tileSize);
      const savedRnd = rnd.save();
      for (const dx of dxs) {
        for (const dy of dys) {
          rnd.restore(savedRnd);
          const ox = cx + dx, oy = cy + dy;
          const g = c.createRadialGradient(ox, oy, r * 0.15, ox, oy, r);
          g.addColorStop(0, colorWithAlpha(palette.stain, stainAlpha));
          g.addColorStop(1, colorWithAlpha(palette.stain, 0));
          c.fillStyle = g;
          c.beginPath();
          c.arc(ox, oy, r, 0, Math.PI * 2);
          c.fill();
          c.globalAlpha = mode === "macro_soft" ? 0.03 : 0.045;
          for (let k = 0; k < edgeCount; k++) {
            c.save();
            c.translate(ox + (rnd() - 0.5) * r * 0.9, oy + (rnd() - 0.5) * r * 0.9);
            c.rotate(rnd() * Math.PI * 2);
            c.scale(1 + rnd() * 1.7, 0.6 + rnd() * 0.9);
            c.fillStyle = palette.stain;
            c.beginPath();
            c.arc(0, 0, r * (0.10 + rnd() * 0.20), 0, Math.PI * 2);
            c.fill();
            c.restore();
          }
        }
      }
    }
    c.globalAlpha = 1;

    if (mode === "macro") {
      c.globalAlpha = 0.08;
      const macroStrokeCount = Math.max(280, Math.round(900 / scale));
      for (let i = 0; i < macroStrokeCount; i++) {
        const x = rnd() * tileSize;
        const y = rnd() * tileSize;
        const len = (5 + rnd() * 10) * scale;
        const ang = rnd() * Math.PI * 2;
        const strokeColor = rnd() < 0.45 ? palette.strokeA : palette.strokeB;
        c.strokeStyle = strokeColor;
        c.lineWidth = 1;
        const ex = x + Math.cos(ang) * len;
        const ey = y + Math.sin(ang) * len;
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(ex, ey);
        c.stroke();
        if (ex > tileSize) { c.beginPath(); c.moveTo(x - tileSize, y); c.lineTo(ex - tileSize, ey); c.stroke(); }
        if (ex < 0)        { c.beginPath(); c.moveTo(x + tileSize, y); c.lineTo(ex + tileSize, ey); c.stroke(); }
        if (ey > tileSize) { c.beginPath(); c.moveTo(x, y - tileSize); c.lineTo(ex, ey - tileSize); c.stroke(); }
        if (ey < 0)        { c.beginPath(); c.moveTo(x, y + tileSize); c.lineTo(ex, ey + tileSize); c.stroke(); }
      }
      c.globalAlpha = 1;
    }

    drawCloudShadows(c, rnd, tileSize, mode === "macro_soft" ? 0.035 : 0.05);
  } else if (mode === "cobble") {
    // Cobble should read as a packed surface: dense setts over a mortar base.
    if (!transparentBase) {
      const img = c.getImageData(0, 0, tileSize, tileSize);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const n = (rnd() - 0.5) * 14;
        d[i]   = clampByte(d[i]   + n);
        d[i+1] = clampByte(d[i+1] + n);
        d[i+2] = clampByte(d[i+2] + n);
      }
      c.putImageData(img, 0, 0);

      c.globalAlpha = 0.22;
      const seamStrokeCount = Math.max(900, Math.round(1700 / Math.sqrt(scale)));
      for (let i = 0; i < seamStrokeCount; i++) {
        const x = rnd() * tileSize;
        const y = rnd() * tileSize;
        const len = (3 + rnd() * 9) * Math.sqrt(scale);
        const ang = rnd() * Math.PI * 2;
        c.strokeStyle = rnd() < 0.9 ? palette.strokeB : palette.strokeA;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
        c.stroke();
      }
      c.globalAlpha = 1;
    }

    const cell = Math.max(10, Math.round(20 * Math.sqrt(scale)));
    const cols = Math.ceil(tileSize / cell) + 3;
    const rows = Math.ceil(tileSize / cell) + 3;

    for (let row = -1; row < rows; row++) {
      const rowOffset = (row & 1) ? cell * (0.35 + rnd() * 0.2) : 0;
      for (let col = -1; col < cols; col++) {
        if (rnd() < 0.04) continue;

        const cx = col * cell + rowOffset + cell * 0.5 + (rnd() - 0.5) * cell * 0.34;
        const cy = row * cell + cell * 0.5 + (rnd() - 0.5) * cell * 0.30;
        const w = cell * (0.78 + rnd() * 0.52);
        const h = cell * (0.66 + rnd() * 0.48);
        const rr = Math.max(2, Math.min(w, h) * (0.18 + rnd() * 0.22));
        const ang = (rnd() - 0.5) * 0.42;

        c.save();
        c.translate(cx, cy);
        c.rotate(ang);

        c.globalAlpha = 0.26;
        c.fillStyle = "#000";
        c.beginPath();
        c.roundRect(-w * 0.5 + 1.8, -h * 0.5 + 2.1, w, h, rr);
        c.fill();

        const tone = rnd();
        const stoneColor = tone < 0.52 ? palette.pebbleA : palette.pebbleB;

        c.globalAlpha = 1;
        c.fillStyle = stoneColor;
        c.beginPath();
        c.roundRect(-w * 0.5, -h * 0.5, w, h, rr);
        c.fill();

        c.globalAlpha = 0.22;
        c.strokeStyle = palette.strokeA;
        c.lineWidth = Math.max(0.75, cell * 0.06);
        c.stroke();

        const gl = c.createLinearGradient(-w * 0.45, -h * 0.45, w * 0.35, h * 0.4);
        gl.addColorStop(0, colorWithAlpha("#ffffff", 0.09));
        gl.addColorStop(1, colorWithAlpha("#ffffff", 0));
        c.globalAlpha = 1;
        c.fillStyle = gl;
        c.fill();
        c.restore();
      }
    }

    if (!transparentBase) {
      c.globalAlpha = 0.14;
      const gritCount = Math.max(2200, Math.round(4400 / Math.sqrt(scale)));
      for (let i = 0; i < gritCount; i++) {
        const x = rnd() * tileSize;
        const y = rnd() * tileSize;
        c.fillStyle = rnd() < 0.72 ? palette.speckA : palette.speckB;
        c.fillRect(x, y, 1, 1);
      }
      c.globalAlpha = 1;

      c.globalAlpha = 0.15;
      const crackCount = Math.max(180, Math.round(320 / Math.sqrt(scale)));
      for (let i = 0; i < crackCount; i++) {
        const x = rnd() * tileSize;
        const y = rnd() * tileSize;
        const len = (6 + rnd() * 18) * Math.sqrt(scale);
        const ang = rnd() * Math.PI * 2;
        c.strokeStyle = colorWithAlpha("#171615", 0.75);
        c.lineWidth = 0.8;
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
        c.stroke();
      }
      c.globalAlpha = 1;

      // broad grime shadows for a colder, worn mood
      c.globalCompositeOperation = "multiply";
      const grimePatches = 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < grimePatches; i++) {
        const cx = rnd() * tileSize;
        const cy = rnd() * tileSize;
        const r = tileSize * (0.22 + rnd() * 0.26);
        const g = c.createRadialGradient(cx, cy, r * 0.18, cx, cy, r);
        g.addColorStop(0, "rgba(0,0,0,0.24)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = g;
        c.beginPath();
        c.arc(cx, cy, r, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = "rgba(0,0,0,0.12)";
      c.fillRect(0, 0, tileSize, tileSize);
      c.globalCompositeOperation = "source-over";
    }
  } else {
    const img = c.getImageData(0, 0, tileSize, tileSize);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * 18;
      d[i + 0] = clampByte(d[i + 0] + n);
      d[i + 1] = clampByte(d[i + 1] + n);
      d[i + 2] = clampByte(d[i + 2] + n);
    }
    c.putImageData(img, 0, 0);

    c.globalAlpha = 0.14;
    const microStrokeCount = Math.max(1200, Math.round(2600 / Math.sqrt(scale)));
    for (let i = 0; i < microStrokeCount; i++) {
      const x = rnd() * tileSize;
      const y = rnd() * tileSize;
      const len = (1.3 + rnd() * 3.4) * Math.sqrt(scale);
      const ang = rnd() * Math.PI * 2;
      const strokeColor = rnd() < 0.55 ? palette.strokeA : palette.strokeB;
      c.strokeStyle = strokeColor;
      c.lineWidth = 1;
      const ex = x + Math.cos(ang) * len;
      const ey = y + Math.sin(ang) * len;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(ex, ey);
      c.stroke();
      if (ex > tileSize) { c.beginPath(); c.moveTo(x - tileSize, y); c.lineTo(ex - tileSize, ey); c.stroke(); }
      if (ex < 0)        { c.beginPath(); c.moveTo(x + tileSize, y); c.lineTo(ex + tileSize, ey); c.stroke(); }
      if (ey > tileSize) { c.beginPath(); c.moveTo(x, y - tileSize); c.lineTo(ex, ey - tileSize); c.stroke(); }
      if (ey < 0)        { c.beginPath(); c.moveTo(x, y + tileSize); c.lineTo(ex, ey + tileSize); c.stroke(); }
    }
    c.globalAlpha = 1;

    c.globalAlpha = 0.08;
    const microSpeckleCount = Math.max(1800, Math.round(4200 / Math.sqrt(scale)));
    for (let i = 0; i < microSpeckleCount; i++) {
      const x = rnd() * tileSize;
      const y = rnd() * tileSize;
      c.fillStyle = shadeColor(palette.shadowShade, 42, rnd);
      c.fillRect(x, y, 1, 1);
    }
    c.globalAlpha = 1;

    const clusterCount = Math.max(10, Math.round(24 / Math.sqrt(scale)));
    for (let cl = 0; cl < clusterCount; cl++) {
      const cx = rnd() * tileSize;
      const cy = rnd() * tileSize;
      const members = 2 + Math.floor(rnd() * 6);
      const clusterExtent = 12 + 3.6 * Math.sqrt(scale);
      const dxs = [0], dys = [0];
      if (cx - clusterExtent < 0) dxs.push(tileSize);
      if (cx + clusterExtent > tileSize) dxs.push(-tileSize);
      if (cy - clusterExtent < 0) dys.push(tileSize);
      if (cy + clusterExtent > tileSize) dys.push(-tileSize);
      const savedRnd = rnd.save();
      for (const dx of dxs) {
        for (const dy of dys) {
          rnd.restore(savedRnd);
          const ocx = cx + dx, ocy = cy + dy;
          for (let i = 0; i < members; i++) {
            const x = ocx + (rnd() - 0.5) * 24;
            const y = ocy + (rnd() - 0.5) * 24;
            const r = (0.9 + rnd() * 2.6) * Math.sqrt(scale);
            c.globalAlpha = 0.18;
            c.fillStyle = "#000";
            c.beginPath();
            c.arc(x + 0.8, y + 0.8, r, 0, Math.PI * 2);
            c.fill();
            c.globalAlpha = 0.55;
            c.fillStyle = rnd() < 0.5 ? palette.pebbleA : palette.pebbleB;
            c.beginPath();
            c.arc(x, y, r, 0, Math.PI * 2);
            c.fill();
          }
        }
      }
    }
    c.globalAlpha = 1;
  }

  applyTerrainMoodPass(c, tileSize, style);

  return { tileCanvas: off, pattern: ctxMain.createPattern(off, "repeat") };
}

function ensureTerrain(seed, style = state.terrain_style) {
  const nextSeed = normalizeTerrainSeed(seed, 1);
  const nextStyle = normalizeTerrainStyle(style);
  const nextGridSize = clamp(Math.round(ui.gridSize || 50), 10, 300);
  const terrainScale = terrainScaleFromGrid(nextGridSize);
  if (terrain.seed === nextSeed && terrain.style === nextStyle && terrain.gridSize === nextGridSize && terrain.patternA && terrain.patternB && terrain.patternC) return;
  const builtA = buildTerrainPattern(ctx, nextSeed, TERRAIN_MACRO_TILE, { mode: "macro", scale: terrainScale, style: nextStyle });
  const builtB = buildTerrainPattern(ctx, (nextSeed ^ 0x9e3779b9) >>> 0, TERRAIN_MICRO_TILE, { mode: "micro", scale: terrainScale, style: nextStyle });
  const builtC = buildTerrainPattern(ctx, (nextSeed ^ 0x85ebca6b) >>> 0, TERRAIN_BREAKUP_TILE, { mode: "macro_soft", scale: terrainScale * 1.15, style: nextStyle });
  terrain.seed = nextSeed;
  terrain.gridSize = nextGridSize;
  terrain.style = nextStyle;
  terrain.patternA = builtA.pattern;
  terrain.patternB = builtB.pattern;
  terrain.patternC = builtC.pattern;
  terrain.tileA = builtA.tileCanvas;
  terrain.tileB = builtB.tileCanvas;
  terrain.tileC = builtC.tileCanvas;
}

// ─── Terrain Mask Subsystem ─────────────────────────────────────────────────
// Must be a multiple of ui.gridSize so tile seams fall exactly on grid lines.
// 1000 = 20×50 (default), 40×25, 10×100 — covers all standard grid sizes.
const TERRAIN_MASK_TILE_WORLD = 1000;
const TERRAIN_MASK_TILE_PX    = 512;

const terrainMasks = {
  tiles: new Map(),    // key: `${materialId}:${tx},${ty}` -> canvas
  patterns: new Map(), // materialId -> CanvasPattern
  disp: null,          // scratch canvas for zoom-correct overlay rendering
  dispCtx: null,
  dispPx: 0,
};

function maskKey(materialId, tx, ty) { return `${materialId}:${tx},${ty}`; }

function worldToTile(x, y) {
  return { tx: Math.floor(x / TERRAIN_MASK_TILE_WORLD), ty: Math.floor(y / TERRAIN_MASK_TILE_WORLD) };
}

function worldToTilePx(x, y, tx, ty) {
  const ox = tx * TERRAIN_MASK_TILE_WORLD;
  const oy = ty * TERRAIN_MASK_TILE_WORLD;
  return {
    px: ((x - ox) / TERRAIN_MASK_TILE_WORLD) * TERRAIN_MASK_TILE_PX,
    py: ((y - oy) / TERRAIN_MASK_TILE_WORLD) * TERRAIN_MASK_TILE_PX,
  };
}

function getOrCreateMaskTile(materialId, tx, ty) {
  const key = maskKey(materialId, tx, ty);
  let c = terrainMasks.tiles.get(key);
  if (!c) {
    c = document.createElement("canvas");
    c.width  = TERRAIN_MASK_TILE_PX;
    c.height = TERRAIN_MASK_TILE_PX;
    terrainMasks.tiles.set(key, c);
  }
  return c;
}

function drawBrushDab(maskCtx, x, y, radiusPx, opacity, hardness, op) {
  maskCtx.save();
  maskCtx.globalCompositeOperation = op === "erase" ? "destination-out" : "source-over";
  const r = Math.max(1, radiusPx);
  const inner = r * Math.max(0, Math.min(1, hardness));
  const g = maskCtx.createRadialGradient(x, y, inner, x, y, r);
  g.addColorStop(0, `rgba(255,255,255,${opacity})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  maskCtx.fillStyle = g;
  maskCtx.beginPath();
  maskCtx.arc(x, y, r, 0, Math.PI * 2);
  maskCtx.fill();
  maskCtx.restore();
}

function applyStrokeToMasks(stroke) {
  const { material_id, points, radius, opacity, hardness, op } = stroke;
  if (!points || points.length < 2) return;
  const spacing = Math.max(2, radius * 0.35);
  let prev = points[0];
  for (let i = 1; i < points.length; i++) {
    const cur = points[i];
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    const dist = Math.hypot(dx, dy) || 0;
    const steps = Math.max(1, Math.floor(dist / spacing));
    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 0 : s / steps;
      const x = prev.x + dx * t;
      const y = prev.y + dy * t;
      const { tx, ty } = worldToTile(x, y);
      const { px, py } = worldToTilePx(x, y, tx, ty);
      const radiusPx = (radius / TERRAIN_MASK_TILE_WORLD) * TERRAIN_MASK_TILE_PX;
      // Paint the dab on the center tile and any neighboring tiles the radius bleeds into.
      const dxs = [0], dys = [0];
      if (px - radiusPx < 0)                  dxs.push(-1);
      if (px + radiusPx > TERRAIN_MASK_TILE_PX) dxs.push(1);
      if (py - radiusPx < 0)                  dys.push(-1);
      if (py + radiusPx > TERRAIN_MASK_TILE_PX) dys.push(1);
      for (const dtx of dxs) {
        for (const dty of dys) {
          const ntx = tx + dtx, nty = ty + dty;
          const neighborCtx = getOrCreateMaskTile(material_id, ntx, nty).getContext("2d");
          // Offset the dab center into the neighbor tile's local coordinates.
          drawBrushDab(neighborCtx,
            px - dtx * TERRAIN_MASK_TILE_PX,
            py - dty * TERRAIN_MASK_TILE_PX,
            radiusPx, opacity, hardness, op);
        }
      }
    }
    prev = cur;
  }
}

terrainMasks.applyStroke = applyStrokeToMasks;

terrainMasks.rebuildAllFromStrokes = function() {
  for (const c of terrainMasks.tiles.values()) {
    c.getContext("2d").clearRect(0, 0, TERRAIN_MASK_TILE_PX, TERRAIN_MASK_TILE_PX);
  }
  const strokes = Object.values(state.terrain_paint?.strokes || {});
  for (const st of strokes) terrainMasks.applyStroke(st);
};

function ensureMaterialPattern(materialId) {
  const cached = terrainMasks.patterns.get(materialId);
  if (cached) return cached;
  const def = (state.terrain_paint?.materials || {})[materialId];
  if (!def) return null;
  const baseSeed = state.terrain_seed || 1;
  const seed = ((baseSeed ^ (def.seedOfs | 0)) >>> 0) || 1;
  const { tileCanvas } = buildTerrainPattern(ctx, seed, 512, {
    mode: def.mode || "macro_soft",
    scale: def.scale || 1.0,
    style: def.style || "grassland",
    transparentBase: !!def.transparentBase,
  });
  const pattern = ctx.createPattern(tileCanvas, "repeat");
  terrainMasks.patterns.set(materialId, pattern);
  return pattern;
}

function invalidateMaterialPatterns() {
  terrainMasks.patterns.clear();
}

function viewWorldRect() {
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(w, h);
  return { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
}

function drawTerrainOverlays() {
  const mats = state.terrain_paint?.materials;
  if (!mats) return;
  const { x0, y0, x1, y1 } = viewWorldRect();
  const tx0 = Math.floor(x0 / TERRAIN_MASK_TILE_WORLD) - 1;
  const ty0 = Math.floor(y0 / TERRAIN_MASK_TILE_WORLD) - 1;
  const tx1 = Math.floor(x1 / TERRAIN_MASK_TILE_WORLD) + 1;
  const ty1 = Math.floor(y1 / TERRAIN_MASK_TILE_WORLD) + 1;

  // Ensure display scratch canvas is sized to 1 screen pixel per world unit (capped).
  // This makes the material pattern render at the same scale and zoom as the background.
  const neededPx = Math.min(2048, Math.max(256, Math.ceil(TERRAIN_MASK_TILE_WORLD * cam.z)));
  if (terrainMasks.dispPx !== neededPx) {
    terrainMasks.disp = document.createElement("canvas");
    terrainMasks.disp.width = neededPx;
    terrainMasks.disp.height = neededPx;
    terrainMasks.dispCtx = terrainMasks.disp.getContext("2d");
    terrainMasks.dispPx = neededPx;
  }
  const dc = terrainMasks.dispCtx;
  const dp = terrainMasks.dispPx;
  // Scale pattern so one period covers the full tile — matches the old visual scale
  // (old code drew a 512px pattern into a 512px canvas then upscaled 2× to world size).
  const patScale = dp / 512;

  ctx.save();
  ctx.translate(cam.x, cam.y);
  ctx.scale(cam.z, cam.z);

  const sortedMats = Object.entries(mats).sort((a, b) => (a[1].zOrder ?? 0) - (b[1].zOrder ?? 0));
  for (const [materialId] of sortedMats) {
    const pattern = ensureMaterialPattern(materialId);
    if (!pattern) continue;
    // Scale pattern so one tile covers the full dp×dp canvas.
    pattern.setTransform(new DOMMatrix([patScale, 0, 0, patScale, 0, 0]));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const mask = terrainMasks.tiles.get(maskKey(materialId, tx, ty));
        if (!mask) continue;
        const wx = tx * TERRAIN_MASK_TILE_WORLD;
        const wy = ty * TERRAIN_MASK_TILE_WORLD;
        dc.clearRect(0, 0, dp, dp);
        dc.globalCompositeOperation = "source-over";
        dc.fillStyle = pattern;
        dc.fillRect(0, 0, dp, dp);
        dc.globalCompositeOperation = "destination-in";
        dc.drawImage(mask, 0, 0, dp, dp);
        dc.globalCompositeOperation = "source-over";
        ctx.drawImage(terrainMasks.disp, wx, wy, TERRAIN_MASK_TILE_WORLD, TERRAIN_MASK_TILE_WORLD);
      }
    }
    pattern.setTransform(new DOMMatrix()); // reset
  }
  ctx.restore();
}
// ─── End Terrain Mask Subsystem ────────────────────────────────────────────

function drawTerrainBackground() {
  if (!terrain.patternA || !terrain.patternB || !terrain.patternC) return;
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  const topLeft = screenToWorld(0, 0);
  const botRight = screenToWorld(w, h);

  const tone = worldToneParams();
  const terrainStyle = state?.terrain_style || terrain?.style || "";
  const isWater = terrainStyle === "water";
  const microAlpha = isWater ? tone.terrainMicroAlpha * 0.9 : tone.terrainMicroAlpha;
  const breakupAlpha = isWater ? tone.terrainBreakupAlpha * 0.85 : tone.terrainBreakupAlpha;
  const washAlpha = isWater ? tone.terrainWashAlpha * 0.85 : tone.terrainWashAlpha;
  const liftAlpha = isWater ? tone.terrainLiftAlpha * 0.75 : tone.terrainLiftAlpha;
  ctx.save();
  ctx.translate(cam.x, cam.y);
  ctx.scale(cam.z, cam.z);
  ctx.globalAlpha = 1.0;
  ctx.fillStyle = terrain.patternA;
  ctx.fillRect(topLeft.x, topLeft.y, botRight.x - topLeft.x, botRight.y - topLeft.y);
  ctx.globalAlpha = microAlpha;
  ctx.fillStyle = terrain.patternB;
  ctx.fillRect(topLeft.x, topLeft.y, botRight.x - topLeft.x, botRight.y - topLeft.y);
  ctx.globalAlpha = breakupAlpha;
  ctx.fillStyle = terrain.patternC;
  ctx.fillRect(topLeft.x, topLeft.y, botRight.x - topLeft.x, botRight.y - topLeft.y);
  ctx.globalAlpha = 1.0;
  ctx.restore();

  // Slight edge darkening improves token/readability over textured terrain.
  ctx.save();
  const g = ctx.createRadialGradient(w / 2, h / 2, 100, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.22)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  if (washAlpha > 0.001) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = `rgba(42,44,50,${washAlpha.toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
  applyWorldToneLiftRect(0, 0, w, h, liftAlpha);
}

function refreshTerrainBadge() {
  if (!isGM() || state.background_mode !== "terrain") {
    terrainBadgeEl.style.display = "none";
    terrainBadgeEl.textContent = "";
    return;
  }
  terrainBadgeEl.textContent = `Terrain: ${state.terrain_style} (seed ${state.terrain_seed})`;
  terrainBadgeEl.style.display = "inline-block";
}

// ── refreshTerrainPaintPanel + terrain paint panel event bindings ─────────────
function refreshTerrainPaintPanel() {
  if (!terrainMaterialPillsEl) return;
  terrainMaterialPillsEl.innerHTML = "";
  const mats = state.terrain_paint?.materials || {};
  const sorted = Object.entries(mats).sort((a, b) => (a[1].zOrder ?? 0) - (b[1].zOrder ?? 0));
  sorted.forEach(([mid, def], idx) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex; align-items:center; gap:4px;";

    const upBtn = document.createElement("button");
    upBtn.className = "ghost";
    upBtn.style.cssText = "font-size:10px; padding:1px 5px; min-width:22px; opacity:" + (idx === 0 ? ".3" : "1") + ";";
    upBtn.textContent = "↑";
    upBtn.disabled = idx === 0;
    upBtn.onclick = () => {
      const prev = sorted[idx - 1];
      if (!prev) return;
      const tmp = def.zOrder ?? idx;
      def.zOrder = prev[1].zOrder ?? (idx - 1);
      prev[1].zOrder = tmp;
      refreshTerrainPaintPanel();
      requestRender();
    };

    const btn = document.createElement("button");
    const isActive = terrainBrush.material_id === mid;
    btn.className = "ghost" + (isActive ? " active" : "");
    btn.style.cssText = "font-size:11px; padding:3px 8px; border-radius:12px; flex:1;" +
      (isActive ? " box-shadow:0 0 0 2px #5b9cf6; font-weight:600;" : "");
    btn.textContent = (isActive ? "● " : "") + (def.label || mid);
    btn.onclick = () => { terrainBrush.material_id = mid; refreshTerrainPaintPanel(); };

    const downBtn = document.createElement("button");
    downBtn.className = "ghost";
    downBtn.style.cssText = "font-size:10px; padding:1px 5px; min-width:22px; opacity:" + (idx === sorted.length - 1 ? ".3" : "1") + ";";
    downBtn.textContent = "↓";
    downBtn.disabled = idx === sorted.length - 1;
    downBtn.onclick = () => {
      const next = sorted[idx + 1];
      if (!next) return;
      const tmp = def.zOrder ?? idx;
      def.zOrder = next[1].zOrder ?? (idx + 1);
      next[1].zOrder = tmp;
      refreshTerrainPaintPanel();
      requestRender();
    };

    row.appendChild(upBtn);
    row.appendChild(btn);
    row.appendChild(downBtn);
    terrainMaterialPillsEl.appendChild(row);
  });
  if (terrainOpPaintBtn) terrainOpPaintBtn.classList.toggle("active", terrainBrush.op === "paint");
  if (terrainOpEraseBtn) terrainOpEraseBtn.classList.toggle("active", terrainBrush.op === "erase");
}

// Called from canvas.js after DOM element consts are declared.
function initTerrainPanelBindings() {
  if (terrainOpPaintBtn) terrainOpPaintBtn.onclick = () => { terrainBrush.op = "paint"; refreshTerrainPaintPanel(); };
  if (terrainOpEraseBtn) terrainOpEraseBtn.onclick = () => { terrainBrush.op = "erase"; refreshTerrainPaintPanel(); };

  if (terrainRadiusSlider) {
    terrainRadiusSlider.oninput = () => {
      terrainBrush.radius = Number(terrainRadiusSlider.value);
      if (terrainRadiusVal) terrainRadiusVal.textContent = String(terrainBrush.radius);
    };
  }
  if (terrainOpacitySlider) {
    terrainOpacitySlider.oninput = () => {
      terrainBrush.opacity = Number(terrainOpacitySlider.value) / 100;
      if (terrainOpacityVal) terrainOpacityVal.textContent = terrainOpacitySlider.value + "%";
    };
  }
  if (terrainHardnessSlider) {
    terrainHardnessSlider.oninput = () => {
      terrainBrush.hardness = Number(terrainHardnessSlider.value) / 100;
      if (terrainHardnessVal) terrainHardnessVal.textContent = terrainHardnessSlider.value + "%";
    };
  }
  if (terrainUndoBtn) {
    terrainUndoBtn.onclick = () => { if (isGM()) send("TERRAIN_STROKE_UNDO", { count: 1 }); };
  }
}

function positionTerrainPaintPanel() {
  if (!terrainPaintPanel) return;
  const topEl = document.getElementById("top");
  const topRect = topEl ? topEl.getBoundingClientRect() : { bottom: 56 };
  const pad = 10;
  // Dock to top-right so it doesn't cover center-map painting.
  const x = window.innerWidth - terrainPaintPanel.offsetWidth - pad;
  const y = topRect.bottom + 8;
  clampMenuToViewport(terrainPaintPanel, x, y);
}

function commitActiveTerrainStroke() {
  if (!activePaintStroke || !isGM()) return;
  const st = activePaintStroke;
  activePaintStroke = null;
  if (!Array.isArray(st.points) || st.points.length < 1) return;
  if (st.points.length === 1) {
    const p0 = st.points[0];
    st.points = [p0, { x: Number(p0.x), y: Number(p0.y) }];
  }
  // Persist locally immediately so context/menu/sync churn cannot drop just-painted terrain.
  state.terrain_paint.strokes[st.id] = st;
  if (!state.terrain_paint.undo_stack.includes(st.id)) state.terrain_paint.undo_stack.push(st.id);
  send("TERRAIN_STROKE_ADD", {
    id: st.id,
    material_id: st.material_id,
    op: st.op,
    points: st.points,
    radius: st.radius,
    opacity: st.opacity,
    hardness: st.hardness,
  });
  requestRender();
}
