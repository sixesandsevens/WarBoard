"use strict";

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  requestRender();
}

function requestRender() { render(); }

function screenToWorld(sx, sy) { return { x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z }; }
function worldToScreen(wx, wy) { return { x: wx * cam.z + cam.x, y: wy * cam.z + cam.y }; }

function tokenRadiusWorld(token = null) {
  const s = clamp(Number(token?.size_scale ?? 1), 0.25, 4);
  return (ui.gridSize * s) / 2;
}

function assetHalfSizeWorld(asset = null) {
  const w = Math.max(8, Number(asset?.width || ui.gridSize));
  const h = Math.max(8, Number(asset?.height || ui.gridSize));
  const sx = Math.abs(signedAssetScale(asset?.scale_x, 1));
  const sy = Math.abs(signedAssetScale(asset?.scale_y, 1));
  return { hw: (w * sx) / 2, hh: (h * sy) / 2 };
}

function hitTestToken(wx, wy) {
  let best = null;
  let bestD2 = Infinity;
  for (const [id, t] of state.tokens) {
    const r = tokenRadiusWorld(t);
    const dx = wx - t.x;
    const dy = wy - t.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r * r && d2 < bestD2) {
      best = id;
      bestD2 = d2;
    }
  }
  return best;
}

function hitTestAsset(wx, wy) {
  const order = state.draw_order?.assets || [];
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const a = state.assets.get(id);
    if (!a) continue;
    const { hw, hh } = assetHalfSizeWorld(a);
    if (wx >= a.x - hw && wx <= a.x + hw && wy >= a.y - hh && wy <= a.y + hh) return id;
  }
  return null;
}

function shapeContainsPoint(sh, wx, wy) {
  const tol = Math.max(6 / cam.z, (sh.width || 3) * 0.8);
  if (sh.type === "line") {
    return pointToSegmentDistance(wx, wy, sh.x1, sh.y1, sh.x2, sh.y2) <= tol;
  }
  if (sh.type === "rect") {
    const minx = Math.min(sh.x1, sh.x2) - tol;
    const maxx = Math.max(sh.x1, sh.x2) + tol;
    const miny = Math.min(sh.y1, sh.y2) - tol;
    const maxy = Math.max(sh.y1, sh.y2) + tol;
    return wx >= minx && wx <= maxx && wy >= miny && wy <= maxy;
  }
  if (sh.type === "circle") {
    const r = Math.hypot(sh.x2 - sh.x1, sh.y2 - sh.y1);
    const d = Math.hypot(wx - sh.x1, wy - sh.y1);
    return d <= r + tol;
  }
  if (sh.type === "text") {
    const fs = clamp(Number(sh.font_size || 20), 8, 96);
    const txt = String(sh.text || "").trim() || "Text";
    const w = Math.max(fs, txt.length * fs * 0.6);
    const h = fs * 1.2;
    return wx >= sh.x1 - tol && wx <= sh.x1 + w + tol && wy >= sh.y1 - tol && wy <= sh.y1 + h + tol;
  }
  return false;
}

function hitTestShape(wx, wy) {
  const order = state.draw_order?.shapes || [];
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const sh = state.shapes.get(id);
    if (!sh) continue;
    if (shapeContainsPoint(sh, wx, wy)) return id;
  }
  return null;
}

function shapeSelectionBoxContainsPoint(sh, wx, wy) {
  if (!sh) return false;
  const pad = Math.max(6 / cam.z, 4 / cam.z);
  if (sh.type === "text") {
    const fs = clamp(Number(sh.font_size || 20), 8, 96);
    const txt = String(sh.text || "").trim() || "Text";
    const w = Math.max(fs, txt.length * fs * 0.6);
    const h = fs * 1.2;
    return (
      wx >= (sh.x1 - pad) &&
      wx <= (sh.x1 + w + pad) &&
      wy >= (sh.y1 - pad) &&
      wy <= (sh.y1 + h + pad)
    );
  }
  const minx = Math.min(sh.x1, sh.x2) - pad;
  const maxx = Math.max(sh.x1, sh.x2) + pad;
  const miny = Math.min(sh.y1, sh.y2) - pad;
  const maxy = Math.max(sh.y1, sh.y2) + pad;
  return wx >= minx && wx <= maxx && wy >= miny && wy <= maxy;
}

function updateHoveredToken(wx, wy) {
  const next = draggingTokenId || (draggingTokenIds.length ? draggingTokenIds[0] : hitTestToken(wx, wy));
  if (next === hoveredTokenId) return;
  hoveredTokenId = next;
  requestRender();
}

function drawBackground() {
  if (state.background_mode === "terrain") {
    ensureTerrain(state.terrain_seed, state.terrain_style);
    drawTerrainBackground();
    return;
  }

  if (state.background_mode === "url" && bgImage) {
    const a = worldToScreen(0, 0);
    const b = worldToScreen(bgImage.naturalWidth, bgImage.naturalHeight);
    const w = b.x - a.x;
    const h = b.y - a.y;
    ctx.drawImage(bgImage, a.x, a.y, w, h);
  }

  if (state.background_mode === "url" && bgImageStatus === "loading") {
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(12, 12, 140, 28);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillText("Loading background...", 20, 30);
    ctx.restore();
  } else if (state.background_mode === "url" && bgImageStatus === "error") {
    ctx.save();
    ctx.fillStyle = "rgba(120,0,0,0.55)";
    ctx.fillRect(12, 12, 180, 28);
    ctx.fillStyle = "rgba(255,240,240,0.95)";
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillText("Background failed to load", 20, 30);
    ctx.restore();
  }
}

function drawGrid() {
  if (!ui.showGrid || !state.layer_visibility.grid) return;

  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  const gs = ui.gridSize * cam.z;
  if (gs < 8) return;

  const topLeft = screenToWorld(0, 0);
  const botRight = screenToWorld(w, h);

  const startX = Math.floor(topLeft.x / ui.gridSize) * ui.gridSize;
  const endX = Math.ceil(botRight.x / ui.gridSize) * ui.gridSize;
  const startY = Math.floor(topLeft.y / ui.gridSize) * ui.gridSize;
  const endY = Math.ceil(botRight.y / ui.gridSize) * ui.gridSize;

  ctx.save();
  ctx.lineWidth = 1;
  const gridAlpha = state.background_mode === "terrain"
    ? 0.18
    : (state.background_mode === "url" ? 0.35 : 0.25);
  ctx.strokeStyle = `rgba(255,255,255,${gridAlpha})`;

  for (let x = startX; x <= endX; x += ui.gridSize) {
    const sx = worldToScreen(x, 0).x;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
    ctx.stroke();
  }
  for (let y = startY; y <= endY; y += ui.gridSize) {
    const sy = worldToScreen(0, y).y;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
    ctx.stroke();
  }
  ctx.restore();
}

function drawStrokes(layerBand) {
  if (!state.layer_visibility.drawings) return;
  for (const id of state.draw_order.strokes) {
    const s = state.strokes.get(id);
    if (!s) continue;
    if (normalizeLayerBand(s.layer_band) !== layerBand) continue;
    if (!s.points || s.points.length < 2) continue;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = s.color || "#fff";
    ctx.lineWidth = (s.width || 3) * cam.z;
    ctx.beginPath();
    const p0 = worldToScreen(s.points[0].x, s.points[0].y);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < s.points.length; i++) {
      const pi = worldToScreen(s.points[i].x, s.points[i].y);
      ctx.lineTo(pi.x, pi.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  if (activeStroke && normalizeLayerBand(activeStroke.layer_band) === layerBand && activeStroke.points.length >= 2) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = activeStroke.color;
    ctx.lineWidth = activeStroke.width * cam.z;
    ctx.beginPath();
    const p0 = worldToScreen(activeStroke.points[0].x, activeStroke.points[0].y);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < activeStroke.points.length; i++) {
      const pi = worldToScreen(activeStroke.points[i].x, activeStroke.points[i].y);
      ctx.lineTo(pi.x, pi.y);
    }
    ctx.stroke();
    ctx.restore();
  }
}

function drawOneShape(sh, isPreview) {
  const a = worldToScreen(sh.x1, sh.y1);
  const b = worldToScreen(sh.x2, sh.y2);

  ctx.save();
  ctx.strokeStyle = sh.color || "#fff";
  ctx.lineWidth = (sh.width || 3) * cam.z;
  if (isPreview) ctx.setLineDash([8, 6]);

  if (sh.type === "line") {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (sh.type === "rect") {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x);
    const h = Math.abs(a.y - b.y);
    ctx.strokeRect(left, top, w, h);
    ctx.restore();
    return;
  }

  if (sh.type === "circle") {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const r = Math.sqrt(dx * dx + dy * dy);
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (sh.type === "text") {
    const fontSize = clamp(Number(sh.font_size || 20), 8, 96) * cam.z;
    const text = String(sh.text || "").trim() || (isPreview ? "Text" : "");
    if (!text) {
      ctx.restore();
      return;
    }
    ctx.font = `${fontSize}px ui-monospace, monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = sh.color || "#fff";
    ctx.fillText(text, a.x, a.y);
    ctx.restore();
    return;
  }

  ctx.restore();
}

function drawShapes(layerBand) {
  if (!state.layer_visibility.shapes) return;
  for (const id of state.draw_order.shapes) {
    const sh = state.shapes.get(id);
    if (!sh) continue;
    if (normalizeLayerBand(sh.layer_band) !== layerBand) continue;
    drawOneShape(sh, false);
    if (id === selectedShapeId) {
      const a = worldToScreen(sh.x1, sh.y1);
      const b = worldToScreen(sh.x2, sh.y2);
      ctx.save();
      ctx.strokeStyle = "#00d1ff";
      ctx.lineWidth = Math.max(1.5, cam.z);
      if (sh.type === "text") {
        const fs = clamp(Number(sh.font_size || 20), 8, 96) * cam.z;
        const txt = String(sh.text || "").trim() || "Text";
        const w = Math.max(fs, txt.length * fs * 0.6);
        const h = fs * 1.2;
        ctx.strokeRect(a.x - 4, a.y - 4, w + 8, h + 8);
      } else {
        const left = Math.min(a.x, b.x) - 4;
        const top = Math.min(a.y, b.y) - 4;
        const w = Math.abs(a.x - b.x) + 8;
        const h = Math.abs(a.y - b.y) + 8;
        ctx.strokeRect(left, top, w, h);
      }
      ctx.restore();
    }
  }
  if (activeShapePreview && normalizeLayerBand(activeShapePreview.layer_band) === layerBand) {
    drawOneShape(activeShapePreview, true);
  }
}

function drawAssetStatusBadges(center, w, h, asset) {
  if (cam.z < 0.35) return;
  const badges = [];
  if (asset?.is_overlay) badges.push({ label: "OVR", color: "rgba(90,120,255,0.92)", width: 31 });
  if (!badges.length) return;
  const startX = center.x - (w / 2) + 6;
  let x = startX;
  let y = center.y - (h / 2) + 6;
  const fontPx = 11;
  const bh = fontPx + 5;
  ctx.save();
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (const badge of badges) {
    const bw = badge.width;
    if (x + bw > center.x + (w / 2) - 4) {
      x = startX;
      y += bh + 4;
    }
    ctx.fillStyle = badge.color;
    ctx.fillRect(x, y, bw, bh);
    ctx.fillStyle = "rgba(255,255,255,0.98)";
    ctx.fillText(badge.label, x + 5, y + 2);
    x += bw + 4;
  }
  ctx.restore();
}

function drawAssets() {
  if (!state.layer_visibility.assets) return;
  const ids = [...(state.draw_order.assets || [])];
  ids.sort((a, b) => {
    const aa = state.assets.get(a);
    const bb = state.assets.get(b);
    return Number(aa?.layer || 0) - Number(bb?.layer || 0);
  });
  for (const id of ids) {
    const a = state.assets.get(id);
    if (!a) continue;
    const s = worldToScreen(a.x, a.y);
    const { hw, hh } = assetHalfSizeWorld(a);
    const w = hw * 2 * cam.z;
    const h = hh * 2 * cam.z;
    const opacity = clamp(Number(a.opacity ?? 1), 0.05, 1);
    const angle = Number(a.rotation || 0);
    const sxSign = signedAssetScale(a.scale_x, 1) < 0 ? -1 : 1;
    const sySign = signedAssetScale(a.scale_y, 1) < 0 ? -1 : 1;
    const img = tokenImage(a);
    ctx.save();
    ctx.translate(s.x, s.y);
    if (angle) ctx.rotate(angle);
    if (sxSign < 0 || sySign < 0) ctx.scale(sxSign, sySign);
    ctx.globalAlpha = opacity;
    if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      ctx.fillStyle = "rgba(200,200,200,0.25)";
      ctx.fillRect(-w / 2, -h / 2, w, h);
    }
    const selected = id === selectedAssetId;
    if (selected) {
      ctx.lineWidth = Math.max(2, 2 * cam.z);
      ctx.strokeStyle = "#00d1ff";
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    }
    ctx.restore();
    drawAssetStatusBadges(s, w, h, a);
  }
}

function drawTokenBadges(t, s, r) {
  const badges = normalizedBadgeList(t?.badges);
  if (!badges.length) return;
  const bubbleR = clamp(r * 0.28, 6, 12);
  const angles = [-Math.PI / 4, Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4];
  const visible = badges.slice(0, 4);

  for (let i = 0; i < visible.length; i++) {
    const meta = TOKEN_BADGE_BY_ID.get(visible[i]);
    if (!meta) continue;
    const a = angles[i];
    const bx = s.x + Math.cos(a) * (r - bubbleR * 0.2);
    const by = s.y + Math.sin(a) * (r - bubbleR * 0.2);
    ctx.save();
    ctx.beginPath();
    ctx.arc(bx, by, bubbleR, 0, Math.PI * 2);
    ctx.fillStyle = meta.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = `${Math.max(10, Math.floor(bubbleR * 1.35))}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(meta.glyph, bx, by + 0.5);
    ctx.restore();
  }

  if (badges.length > 4) {
    const extra = badges.length - 4;
    const bx = s.x + (r - bubbleR * 0.2);
    const by = s.y;
    ctx.save();
    ctx.beginPath();
    ctx.arc(bx, by, bubbleR, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = `${Math.max(10, Math.floor(bubbleR * 1.1))}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`+${extra}`, bx, by + 0.5);
    ctx.restore();
  }
}

function drawTokens() {
  if (!state.layer_visibility.tokens) return;
  for (const [id, t] of state.tokens) {
    const s = worldToScreen(t.x, t.y);
    const r = tokenRadiusWorld(t) * cam.z;

    ctx.save();
    const imageDrawn = drawTokenImageClippedCircle(t, s, r);
    if (!imageDrawn) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = t.color || "#fff";
      ctx.fill();
    }
    ctx.lineWidth = Math.max(2, 2 * cam.z);
    const selected = selectedTokenIds.has(id) || id === selectedTokenId;
    ctx.strokeStyle = selected ? "#00d1ff" : t.locked ? "rgba(255,0,0,0.8)" : "rgba(255,255,255,0.45)";
    ctx.stroke();

    drawTokenBadges(t, s, r);

    const showLabel = selected || id === hoveredTokenId;
    if (showLabel) {
      const label = (t.name || "Token").slice(0, 18);
      const fontSize = Math.max(14, 14 * cam.z);
      ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const metrics = ctx.measureText(label);
      const textWidth = metrics.width;
      const textHeight = fontSize;
      const padX = Math.max(8, 6 * cam.z);
      const padY = Math.max(4, 3 * cam.z);
      const boxW = textWidth + padX * 2;
      const boxH = textHeight + padY * 2;
      const boxX = s.x - boxW / 2;
      const boxY = s.y - boxH / 2;
      const radius = Math.max(8, boxH * 0.35);

      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, radius);
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      ctx.fill();

      ctx.strokeStyle = "rgba(255,255,255,0.32)";
      ctx.lineWidth = Math.max(1, cam.z * 0.9);
      ctx.stroke();

      ctx.fillStyle = "#fff";
      ctx.fillText(label, s.x, s.y);
    }
    ctx.restore();
  }
}

function drawRuler() {
  if (!activeRuler) return;
  const a = worldToScreen(activeRuler.x1, activeRuler.y1);
  const b = worldToScreen(activeRuler.x2, activeRuler.y2);

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);

  const dx = activeRuler.x2 - activeRuler.x1;
  const dy = activeRuler.y2 - activeRuler.y1;
  const distWorld = Math.sqrt(dx * dx + dy * dy);
  const squares = distWorld / ui.gridSize;
  const feet = squares * ui.feetPerSq;

  const midx = (a.x + b.x) / 2;
  const midy = (a.y + b.y) / 2;

  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(midx - 90, midy - 14, 180, 28);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.font = "12px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${squares.toFixed(2)} sq (${feet.toFixed(1)} ft)`, midx, midy);
  ctx.restore();
}

function drawDragSpawnGhost() {
  if (!dragSpawn || !dragSpawnWorld || !dragSpawnOverCanvas) return;
  const s = worldToScreen(dragSpawnWorld.x, dragSpawnWorld.y);
  if (dragSpawn.kind === "asset") {
    const w = Math.max(8, Number(dragSpawn.width || ui.gridSize)) * cam.z;
    const h = Math.max(8, Number(dragSpawn.height || ui.gridSize)) * cam.z;
    ctx.save();
    ctx.globalAlpha = 0.7;
    if (dragSpawn.url_original || dragSpawn.image_url) {
      const img = tokenImage(dragSpawn);
      if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
        ctx.drawImage(img, s.x - w / 2, s.y - h / 2, w, h);
      } else {
        ctx.fillStyle = "rgba(220,220,220,0.3)";
        ctx.fillRect(s.x - w / 2, s.y - h / 2, w, h);
      }
    } else {
      ctx.fillStyle = "rgba(220,220,220,0.3)";
      ctx.fillRect(s.x - w / 2, s.y - h / 2, w, h);
    }
    ctx.lineWidth = Math.max(2, 2 * cam.z);
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.strokeRect(s.x - w / 2, s.y - h / 2, w, h);
    ctx.setLineDash([]);
    ctx.restore();
    return;
  }
  const r = tokenRadiusWorld(dragSpawn) * cam.z;
  ctx.save();
  ctx.globalAlpha = 0.7;
  const imageDrawn = drawTokenImageClippedCircle(dragSpawn, s, r);
  if (!imageDrawn) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = dragSpawn.color || "#888";
    ctx.fill();
  }
  ctx.lineWidth = Math.max(2, 2 * cam.z);
  ctx.setLineDash([7, 5]);
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawMarqueeSelection() {
  if (!marqueeSelectRect) return;
  const a = worldToScreen(marqueeSelectRect.x1, marqueeSelectRect.y1);
  const b = worldToScreen(marqueeSelectRect.x2, marqueeSelectRect.y2);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  if (w < 2 || h < 2) return;
  ctx.save();
  ctx.fillStyle = "rgba(0, 209, 255, 0.14)";
  ctx.strokeStyle = "rgba(0, 209, 255, 0.95)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([8, 6]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function drawSelectionCountBadge() {
  const count = selectionCount();
  if (count <= 0) return;
  const text = count === 1 ? "1 selected" : `${count} selected`;
  ctx.save();
  ctx.font = "600 12px system-ui, sans-serif";
  const textW = ctx.measureText(text).width;
  const x = 12;
  const y = 12;
  const w = Math.ceil(textW + 18);
  const h = 24;
  ctx.fillStyle = "rgba(0, 0, 0, 0.68)";
  ctx.strokeStyle = "rgba(0, 209, 255, 0.7)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 12);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 9, y + h / 2);
  ctx.restore();
}

function render() {
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  updateCanvasCursor();
  document.getElementById("spawn").classList.toggle("active", !!dragSpawn);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, w, h);

  drawBackground();
  if (state.background_mode === "terrain") drawTerrainOverlays();
  drawGrid();
  drawStrokes("below_assets");
  drawShapes("below_assets");
  drawAssets();
  drawStrokes("above_assets");
  drawShapes("above_assets");
  drawTokens();
  drawFogOverlays();
  drawMarqueeSelection();
  drawSelectionCountBadge();
  drawDragSpawnGhost();
  drawRuler();
}

window.addEventListener("resize", resizeCanvas);
