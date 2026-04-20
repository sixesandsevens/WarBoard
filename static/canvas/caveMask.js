"use strict";

// ─── Tunables ─────────────────────────────────────────────────────────────────
const CAVE_MASK_CELL_SIZE = 8;  // world-units per mask cell; tune experimentally

// ─── Mask Factory ─────────────────────────────────────────────────────────────

// Returns a binary mask covering the given world bounds at the given cell size.
// Adds one cell of padding on each side so contours don't hit the edge.
function createBinaryMask(worldBounds, cellSize) {
  const cs = cellSize || CAVE_MASK_CELL_SIZE;
  const w = Math.max(4, Math.ceil((worldBounds.maxX - worldBounds.minX) / cs) + 2);
  const h = Math.max(4, Math.ceil((worldBounds.maxY - worldBounds.minY) / cs) + 2);
  return {
    data: new Uint8Array(w * h),
    width: w,
    height: h,
    originX: worldBounds.minX - cs,  // one cell of left/top padding
    originY: worldBounds.minY - cs,
    cellSize: cs,
  };
}

// ─── Stamp Operations ─────────────────────────────────────────────────────────

// Stamp a filled or erased circle onto the mask in world coordinates.
function stampCircleOnMask(mask, worldX, worldY, worldRadius, fill) {
  const cs = mask.cellSize;
  const ccx = (worldX - mask.originX) / cs;
  const ccy = (worldY - mask.originY) / cs;
  const cr = worldRadius / cs;
  const cr2 = cr * cr;
  const minCx = Math.max(0, Math.floor(ccx - cr));
  const maxCx = Math.min(mask.width - 1, Math.ceil(ccx + cr));
  const minCy = Math.max(0, Math.floor(ccy - cr));
  const maxCy = Math.min(mask.height - 1, Math.ceil(ccy + cr));
  const value = fill ? 1 : 0;
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const dx = cx + 0.5 - ccx;
      const dy = cy + 0.5 - ccy;
      if (dx * dx + dy * dy <= cr2) {
        mask.data[cy * mask.width + cx] = value;
      }
    }
  }
}

// Rasterize a closed cave geometry polygon into the mask (scanline fill).
function rasterizeCaveIntoMask(mask, obj) {
  if (!obj.outer || obj.outer.length < 3 || !obj.closed) return;
  const pts = obj.outer;
  const { width, height, originX, originY, cellSize } = mask;
  for (let cy = 0; cy < height; cy++) {
    const wy = originY + (cy + 0.5) * cellSize;
    const xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const ay = pts[i].y, by = pts[j].y;
      if ((ay > wy) !== (by > wy)) {
        xs.push(pts[i].x + ((wy - ay) / (by - ay)) * (pts[j].x - pts[i].x));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const cx0 = Math.max(0, Math.ceil( (xs[k]     - originX) / cellSize - 0.5));
      const cx1 = Math.min(width - 1, Math.floor((xs[k + 1] - originX) / cellSize - 0.5));
      for (let cx = cx0; cx <= cx1; cx++) {
        mask.data[cy * width + cx] = 1;
      }
    }
  }
}

// ─── Bounds Helpers ───────────────────────────────────────────────────────────

function expandWorldBounds(bounds, padding) {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

function unionWorldBounds(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

// Compute world bounds that cover all stroke points expanded by radius.
function boundsFromPoints(points, radius) {
  if (!points || !points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x - radius < minX) minX = p.x - radius;
    if (p.y - radius < minY) minY = p.y - radius;
    if (p.x + radius > maxX) maxX = p.x + radius;
    if (p.y + radius > maxY) maxY = p.y + radius;
  }
  return { minX, minY, maxX, maxY };
}

// Convert a geometry bounds rect { x, y, width, height } to {minX,…} form.
function geometryBoundsToWorldBounds(bounds) {
  if (!bounds) return null;
  return { minX: bounds.x, minY: bounds.y, maxX: bounds.x + bounds.width, maxY: bounds.y + bounds.height };
}

// Returns true if two world-bounds rectangles overlap (exclusive).
function boundsIntersect(a, b) {
  if (!a || !b) return false;
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}
