"use strict";

// ─── Fog Subsystem ───────────────────────────────────────────────────────────
// Extracted from canvas.js. All declarations are globals (no wrapping IIFE).
// Loaded before canvas.js. Depends on: terrain.js (worldToTile, worldToTilePx).

const fogBrush = {
  op: "reveal",
  radius: 90,
  opacity: 1.0,
  hardness: 0.65,
};
let activeFogStroke = null;

const FOG_MASK_TILE_WORLD = 1000;
const FOG_MASK_TILE_PX = 512;

const fogMasks = {
  tiles: new Map(),
  disp: null,
  dispCtx: null,
  dispPx: 0,
};

function fogMaskKey(tx, ty) { return `${tx},${ty}`; }

function resetFogTile(canvasEl) {
  const c = canvasEl.getContext("2d");
  c.clearRect(0, 0, FOG_MASK_TILE_PX, FOG_MASK_TILE_PX);
  if (state.fog_paint?.default_mode === "covered") {
    c.fillStyle = "rgba(255,255,255,1)";
    c.fillRect(0, 0, FOG_MASK_TILE_PX, FOG_MASK_TILE_PX);
  }
}

function getOrCreateFogTile(tx, ty) {
  const key = fogMaskKey(tx, ty);
  let tile = fogMasks.tiles.get(key);
  if (!tile) {
    tile = document.createElement("canvas");
    tile.width = FOG_MASK_TILE_PX;
    tile.height = FOG_MASK_TILE_PX;
    fogMasks.tiles.set(key, tile);
    resetFogTile(tile);
  }
  return tile;
}

function drawFogBrushDab(maskCtx, x, y, radiusPx, opacity, hardness, op) {
  maskCtx.save();
  maskCtx.globalCompositeOperation = op === "reveal" ? "destination-out" : "source-over";
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

function applyFogStrokeToMasks(stroke) {
  const { points, radius, opacity, hardness, op } = stroke || {};
  if (!Array.isArray(points) || points.length < 2) return;
  const spacing = Math.max(2, Number(radius || 60) * 0.35);
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
      const radiusPx = (Number(radius || 60) / FOG_MASK_TILE_WORLD) * FOG_MASK_TILE_PX;
      const dxs = [0], dys = [0];
      if (px - radiusPx < 0) dxs.push(-1);
      if (px + radiusPx > FOG_MASK_TILE_PX) dxs.push(1);
      if (py - radiusPx < 0) dys.push(-1);
      if (py + radiusPx > FOG_MASK_TILE_PX) dys.push(1);
      for (const dtx of dxs) {
        for (const dty of dys) {
          const neighbor = getOrCreateFogTile(tx + dtx, ty + dty).getContext("2d");
          drawFogBrushDab(
            neighbor,
            px - dtx * FOG_MASK_TILE_PX,
            py - dty * FOG_MASK_TILE_PX,
            radiusPx,
            Number(opacity ?? 1.0),
            Number(hardness ?? 0.6),
            op === "cover" ? "cover" : "reveal",
          );
        }
      }
    }
    prev = cur;
  }
}

fogMasks.applyStroke = applyFogStrokeToMasks;
fogMasks.rebuildAllFromStrokes = function() {
  fogMasks.tiles.clear();
  const strokes = Object.values(state.fog_paint?.strokes || {});
  for (const st of strokes) fogMasks.applyStroke(st);
};

function drawFogOverlays() {
  if (!state.fog_paint?.enabled) return;
  const { x0, y0, x1, y1 } = viewWorldRect();
  const tx0 = Math.floor(x0 / FOG_MASK_TILE_WORLD) - 1;
  const ty0 = Math.floor(y0 / FOG_MASK_TILE_WORLD) - 1;
  const tx1 = Math.floor(x1 / FOG_MASK_TILE_WORLD) + 1;
  const ty1 = Math.floor(y1 / FOG_MASK_TILE_WORLD) + 1;
  const neededPx = Math.min(2048, Math.max(256, Math.ceil(FOG_MASK_TILE_WORLD * cam.z)));
  if (fogMasks.dispPx !== neededPx) {
    fogMasks.disp = document.createElement("canvas");
    fogMasks.disp.width = neededPx;
    fogMasks.disp.height = neededPx;
    fogMasks.dispCtx = fogMasks.disp.getContext("2d");
    fogMasks.dispPx = neededPx;
  }
  const dc = fogMasks.dispCtx;
  const dp = fogMasks.dispPx;
  ctx.save();
  ctx.translate(cam.x, cam.y);
  ctx.scale(cam.z, cam.z);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const mask = state.fog_paint.default_mode === "covered"
        ? getOrCreateFogTile(tx, ty)
        : fogMasks.tiles.get(fogMaskKey(tx, ty));
      if (!mask) continue;
      const wx = tx * FOG_MASK_TILE_WORLD;
      const wy = ty * FOG_MASK_TILE_WORLD;
      dc.clearRect(0, 0, dp, dp);
      dc.globalCompositeOperation = "source-over";
      dc.fillStyle = "rgba(0,0,0,1)";
      dc.fillRect(0, 0, dp, dp);
      dc.globalCompositeOperation = "destination-in";
      dc.drawImage(mask, 0, 0, dp, dp);
      dc.globalCompositeOperation = "source-over";
      ctx.drawImage(fogMasks.disp, wx, wy, FOG_MASK_TILE_WORLD, FOG_MASK_TILE_WORLD);
    }
  }
  ctx.restore();
}

function refreshFogPaintPanel() {
  if (fogEnabledToggle) fogEnabledToggle.checked = !!state.fog_paint?.enabled;
  if (fogOpRevealBtn) fogOpRevealBtn.classList.toggle("active", fogBrush.op === "reveal");
  if (fogOpCoverBtn) fogOpCoverBtn.classList.toggle("active", fogBrush.op === "cover");
  if (fogRadiusSlider) fogRadiusSlider.value = String(Math.round(fogBrush.radius));
  if (fogRadiusVal) fogRadiusVal.textContent = String(Math.round(fogBrush.radius));
  if (fogOpacitySlider) fogOpacitySlider.value = String(Math.round(fogBrush.opacity * 100));
  if (fogOpacityVal) fogOpacityVal.textContent = `${Math.round(fogBrush.opacity * 100)}%`;
  if (fogHardnessSlider) fogHardnessSlider.value = String(Math.round(fogBrush.hardness * 100));
  if (fogHardnessVal) fogHardnessVal.textContent = `${Math.round(fogBrush.hardness * 100)}%`;
}

// Called from canvas.js after DOM element consts are declared.
function initFogPanelBindings() {
  if (fogEnabledToggle) {
    fogEnabledToggle.onchange = () => {
      if (!isGM()) {
        fogEnabledToggle.checked = !!state.fog_paint?.enabled;
        return;
      }
      send("FOG_SET_ENABLED", { enabled: !!fogEnabledToggle.checked, default_mode: state.fog_paint?.default_mode || "clear" });
    };
  }
  if (fogOpRevealBtn) fogOpRevealBtn.onclick = () => { fogBrush.op = "reveal"; refreshFogPaintPanel(); };
  if (fogOpCoverBtn) fogOpCoverBtn.onclick = () => { fogBrush.op = "cover"; refreshFogPaintPanel(); };
  if (fogRadiusSlider) {
    fogRadiusSlider.oninput = () => {
      fogBrush.radius = Number(fogRadiusSlider.value);
      refreshFogPaintPanel();
    };
  }
  if (fogOpacitySlider) {
    fogOpacitySlider.oninput = () => {
      fogBrush.opacity = Number(fogOpacitySlider.value) / 100;
      refreshFogPaintPanel();
    };
  }
  if (fogHardnessSlider) {
    fogHardnessSlider.oninput = () => {
      fogBrush.hardness = Number(fogHardnessSlider.value) / 100;
      refreshFogPaintPanel();
    };
  }
  if (fogCoverAllBtn) fogCoverAllBtn.onclick = () => { if (isGM()) send("FOG_RESET", { mode: "covered", enabled: true }); };
  if (fogClearAllBtn) fogClearAllBtn.onclick = () => { if (isGM()) send("FOG_RESET", { mode: "clear", enabled: true }); };
}

function positionFogPaintPanel() {
  if (!fogPaintPanel) return;
  const topEl = document.getElementById("top");
  const topRect = topEl ? topEl.getBoundingClientRect() : { bottom: 56 };
  const pad = 10;
  const x = window.innerWidth - fogPaintPanel.offsetWidth - pad;
  const y = topRect.bottom + 8;
  clampMenuToViewport(fogPaintPanel, x, y);
}

function commitActiveFogStroke() {
  if (!activeFogStroke || !isGM()) return;
  const st = activeFogStroke;
  activeFogStroke = null;
  if (!Array.isArray(st.points) || st.points.length < 1) return;
  if (st.points.length === 1) {
    const p0 = st.points[0];
    st.points = [p0, { x: Number(p0.x), y: Number(p0.y) }];
  }
  state.fog_paint.enabled = true;
  state.fog_paint.strokes[st.id] = st;
  if (!state.fog_paint.undo_stack.includes(st.id)) state.fog_paint.undo_stack.push(st.id);
  send("FOG_STROKE_ADD", {
    id: st.id,
    op: st.op,
    points: st.points,
    radius: st.radius,
    opacity: st.opacity,
    hardness: st.hardness,
  });
  refreshFogPaintPanel();
  requestRender();
}
