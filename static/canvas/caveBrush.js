"use strict";

// ─── Tunables ─────────────────────────────────────────────────────────────────
const CAVE_BRUSH_DEFAULT_RADIUS = 48;
const CAVE_DIRTY_PADDING        = 16;  // extra world-unit padding around dirty bounds

// ─── State (also declared in state.js as `let caveBrush`) ────────────────────
// caveBrush is initialized in state.js; nothing here re-declares it.

// ─── Panel Helpers ────────────────────────────────────────────────────────────

function positionCaveBrushPanel() {
  if (!caveBrushPanel) return;
  const topEl = document.getElementById("top");
  const topRect = topEl ? topEl.getBoundingClientRect() : { bottom: 56 };
  const x = window.innerWidth - caveBrushPanel.offsetWidth - 10;
  const y = topRect.bottom + 8;
  clampMenuToViewport(caveBrushPanel, x, y);
}

function refreshCaveBrushPanel() {
  const addBtn   = document.getElementById("caveBrushOpAdd");
  const eraseBtn = document.getElementById("caveBrushOpErase");
  const valEl    = document.getElementById("caveBrushRadiusVal");
  const slider   = document.getElementById("caveBrushRadiusSlider");
  if (addBtn)   addBtn.classList.toggle("active",  caveBrush.mode === "add");
  if (eraseBtn) eraseBtn.classList.toggle("active", caveBrush.mode === "erase");
  if (valEl)    valEl.textContent = String(Math.round(caveBrush.brushRadius));
  if (slider)   slider.value = String(caveBrush.brushRadius);
}

function initCaveBrushPanelBindings() {
  const addBtn   = document.getElementById("caveBrushOpAdd");
  const eraseBtn = document.getElementById("caveBrushOpErase");
  const slider   = document.getElementById("caveBrushRadiusSlider");
  if (addBtn) addBtn.addEventListener("click", () => {
    caveBrush.mode = "add";
    refreshCaveBrushPanel();
  });
  if (eraseBtn) eraseBtn.addEventListener("click", () => {
    caveBrush.mode = "erase";
    refreshCaveBrushPanel();
  });
  if (slider) slider.addEventListener("input", () => {
    caveBrush.brushRadius = clamp(Number(slider.value), 10, 300);
    refreshCaveBrushPanel();
    requestRender();
  });
}

// ─── Stroke Lifecycle ─────────────────────────────────────────────────────────

function beginCaveStroke(worldX, worldY) {
  caveBrush.active = true;
  caveBrush.strokePoints = [{ x: worldX, y: worldY }];
  caveBrush.dirtyBounds = boundsFromPoints(caveBrush.strokePoints, caveBrush.brushRadius);
}

function updateCaveStroke(worldX, worldY) {
  if (!caveBrush.active) return;
  const pts = caveBrush.strokePoints;
  const last = pts[pts.length - 1];
  const minDist = caveBrush.brushRadius * 0.25;
  const dx = worldX - last.x;
  const dy = worldY - last.y;
  if (dx * dx + dy * dy < minDist * minDist) return;
  pts.push({ x: worldX, y: worldY });
  caveBrush.dirtyBounds = unionWorldBounds(
    caveBrush.dirtyBounds,
    boundsFromPoints([{ x: worldX, y: worldY }], caveBrush.brushRadius)
  );
}

function cancelCaveStroke() {
  caveBrush.active = false;
  caveBrush.strokePoints = [];
  caveBrush.dirtyBounds = null;
}

// Full commit pipeline: rasterize → extract → clean → mutate.
// createdBy is passed from the IIFE scope (e.g. myId()).
function commitCaveStroke(createdBy) {
  const pts = caveBrush.strokePoints;
  if (!pts.length) { cancelCaveStroke(); return; }

  const strokeBounds = boundsFromPoints(pts, caveBrush.brushRadius);
  if (!strokeBounds) { cancelCaveStroke(); return; }

  const dirtyBounds = expandWorldBounds(strokeBounds, CAVE_DIRTY_PADDING);

  // Gather existing caves whose bounds overlap the dirty region.
  const affected = getIntersectingCaveGeometry(dirtyBounds);

  // Union the dirty bounds with every affected cave's bounds so the mask is big
  // enough to hold all existing cave pixels that might be merged or split.
  let workBounds = dirtyBounds;
  for (const obj of affected) {
    const gb = geometryBoundsToWorldBounds(obj.bounds);
    if (gb) workBounds = unionWorldBounds(workBounds, gb);
  }
  workBounds = expandWorldBounds(workBounds, CAVE_MASK_CELL_SIZE * 2);

  // Build and populate the working mask.
  const mask = createBinaryMask(workBounds, CAVE_MASK_CELL_SIZE);
  for (const obj of affected) rasterizeCaveIntoMask(mask, obj);

  // Apply stroke stamps (add or erase).
  const fill = caveBrush.mode === "add";
  for (const pt of pts) stampCircleOnMask(mask, pt.x, pt.y, caveBrush.brushRadius, fill);

  // Extract → convert → filter → simplify → smooth → filter again.
  let contours = extractContoursFromMask(mask);
  contours = contours.map(c => maskContourToWorldPoints(c, mask));
  contours = filterSmallContours(contours);
  contours = contours.map(c => simplifyContour(c, CAVE_SIMPLIFY_TOLERANCE));
  contours = contours.map(c => smoothContour(c, CAVE_SMOOTHING_ITERATIONS));
  contours = filterSmallContours(contours);

  const newCaves = buildCaveGeometryObjectsFromContours(contours, createdBy);

  // One atomic mutation: remove affected old caves, add replacement caves.
  applyGeometryMutation({
    removed: affected.map(o => o.id),
    added:   newCaves,
  });

  cancelCaveStroke();
}

function endCaveStroke(createdBy) {
  if (!caveBrush.active) return;
  commitCaveStroke(createdBy);
}

// ─── Preview Rendering ────────────────────────────────────────────────────────

// Draw a semi-transparent overlay of the in-progress brush stroke.
// Called from render.js drawCaveBrushOverlay().
function drawCaveBrushOverlay() {
  if (!caveBrush.active || !caveBrush.strokePoints.length) return;

  const radiusPx = caveBrush.brushRadius * cam.z;
  if (radiusPx < 1) return;

  ctx.save();
  if (caveBrush.mode === "add") {
    ctx.fillStyle   = "rgba(70, 55, 35, 0.32)";
    ctx.strokeStyle = "rgba(140, 110, 70, 0.55)";
  } else {
    ctx.fillStyle   = "rgba(180, 80, 40, 0.22)";
    ctx.strokeStyle = "rgba(200, 90, 50, 0.50)";
  }
  ctx.lineWidth = 1;
  ctx.setLineDash([]);

  for (const pt of caveBrush.strokePoints) {
    const sp = worldToScreen(pt.x, pt.y);
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, Math.max(2, radiusPx), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
