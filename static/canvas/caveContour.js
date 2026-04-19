"use strict";

// ─── Contour Extraction ───────────────────────────────────────────────────────
//
// Strategy: collect directed boundary half-edges from the binary mask, then
// walk them into closed loops.  Each half-edge is directed so the filled cell
// is to its RIGHT (clockwise winding, y-axis pointing down).
//
// At vertices where more than two half-edges meet (saddle / pinch points) we
// pick the continuation that makes the smallest left turn from our incoming
// direction.  This keeps us on the outer contour rather than cutting across.

function extractContoursFromMask(mask) {
  const { data, width, height } = mask;

  function get(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) return 0;
    return data[cy * width + cx];
  }

  // Build directed half-edges in grid-vertex space.
  // Vertex (i, j) is the top-left corner of cell (i, j).
  const segs = [];   // each entry: [x1, y1, x2, y2]

  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      if (!get(cx, cy)) continue;
      if (!get(cx,     cy - 1)) segs.push([cx,     cy,     cx + 1, cy    ]); // top
      if (!get(cx + 1, cy    )) segs.push([cx + 1, cy,     cx + 1, cy + 1]); // right
      if (!get(cx,     cy + 1)) segs.push([cx + 1, cy + 1, cx,     cy + 1]); // bottom
      if (!get(cx - 1, cy    )) segs.push([cx,     cy + 1, cx,     cy    ]); // left
    }
  }

  if (!segs.length) return [];

  // Forward adjacency map: "x,y" → [{to, segIdx, x, y}]
  const fwd = new Map();
  for (let i = 0; i < segs.length; i++) {
    const [x1, y1, x2, y2] = segs[i];
    const k = `${x1},${y1}`;
    if (!fwd.has(k)) fwd.set(k, []);
    fwd.get(k).push({ to: `${x2},${y2}`, segIdx: i, x: x2, y: y2 });
  }

  // When multiple unused edges leave a vertex, pick the one that turns most
  // to the left from our incoming direction (keeps us on the outer boundary).
  function pickNext(fromX, fromY, curX, curY, candidates) {
    if (candidates.length === 1) return candidates[0];
    const inDx = curX - fromX;
    const inDy = curY - fromY;
    let best = null;
    let bestCross = -Infinity;
    let bestDot   = -Infinity;
    for (const c of candidates) {
      const odx = c.x - curX;
      const ody = c.y - curY;
      const cross = inDx * ody - inDy * odx;  // sin of turn angle
      const dot   = inDx * odx + inDy * ody;  // cos of turn angle
      if (cross > bestCross || (cross === bestCross && dot > bestDot)) {
        bestCross = cross;
        bestDot   = dot;
        best = c;
      }
    }
    return best || candidates[0];
  }

  const used = new Uint8Array(segs.length);
  const contours = [];

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;

    const [x1, y1, x2, y2] = segs[i];
    const startKey = `${x1},${y1}`;
    const points   = [{ x: x1, y: y1 }, { x: x2, y: y2 }];
    let prevX = x1, prevY = y1;
    let curX  = x2, curY  = y2;
    let curKey = `${x2},${y2}`;

    let steps = 0;
    while (curKey !== startKey && steps < 100000) {
      steps++;
      const all  = fwd.get(curKey) || [];
      const free = all.filter(n => !used[n.segIdx]);
      if (!free.length) break;
      const next = pickNext(prevX, prevY, curX, curY, free);
      used[next.segIdx] = 1;
      points.push({ x: next.x, y: next.y });
      prevX = curX; prevY = curY;
      curX  = next.x; curY  = next.y;
      curKey = next.to;
    }

    // Only keep loops that close and have enough points to form a polygon.
    if (curKey === startKey && points.length >= 4) {
      contours.push(points.slice(0, -1)); // drop the duplicate closing vertex
    }
  }

  return contours;
}

// Convert grid-space contour points to world-space.
function maskContourToWorldPoints(contour, mask) {
  return contour.map(p => ({
    x: mask.originX + p.x * mask.cellSize,
    y: mask.originY + p.y * mask.cellSize,
  }));
}
