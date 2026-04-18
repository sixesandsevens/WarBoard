  function log(line) {
    if (!logEl) return;
    logEl.textContent += line + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  }

  // toast, formatShortTime → static/canvas/utils.js

  // addSessionActivity → static/canvas/sessions.js

  function setLogCollapsed(collapsed) {
    if (logWrapEl) logWrapEl.classList.toggle("collapsed", !!collapsed);
    if (logToggleEl) logToggleEl.textContent = collapsed ? "Maximize" : "Minimize";
  }

  function parseTokenSizeInput(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return null;
    if (["s", "small"].includes(raw)) return 0.5;
    if (["m", "medium", "med", "normal"].includes(raw)) return 1.0;
    if (["l", "large"].includes(raw)) return 2.0;
    if (["h", "huge"].includes(raw)) return 3.0;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return null;
    return clamp(parsed, 0.25, 4);
  }

  // Guardrail: if this logs during initial room connect, we've reintroduced eager library loading.
  const _nativeFetch = window.fetch.bind(window);
  function _assetNetDebugEnabled() {
    try {
      return localStorage.getItem(ASSET_DEBUG_NET_KEY) === "1";
    } catch (_) {
      return false;
    }
  }
  function _assetsTabActiveNow() {
    const tab = document.getElementById("tab-assets");
    return !!tab && tab.classList.contains("active");
  }
  window.fetch = function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : String(input?.url || "");
    if (_assetNetDebugEnabled()) {
      const isAssetLib = url.includes("src=assetlib");
      if (isAssetLib && !_assetsTabActiveNow()) {
        console.warn("[asset-net-debug] request while assets tab closed:", url);
      }
    }
    return _nativeFetch(input, init);
  };

  // apiUrl, apiGet, apiPost, apiPatch, apiDelete,
  // apiUploadBackground, apiUploadAsset, apiUploadAssetZip, apiDeleteAsset
  // → static/canvas/api.js

  function setAuthIdentity(user) {
    me = user && user.username ? user : null;
    if (me) {
      cidEl.value = me.username;
      cidEl.disabled = true;
      cidEl.title = "Logged in as " + me.username;
      sessionClientEl.value = me.username;
      sessionClientEl.disabled = true;
    } else {
      cidEl.disabled = false;
      cidEl.title = "";
      sessionClientEl.disabled = false;
    }
  }

  async function loadMe() {
    try {
      const res = await fetch("/api/me");
      if (!res.ok) {
        setAuthIdentity(null);
        return null;
      }
      const user = await res.json();
      setAuthIdentity(user);
      return user;
    } catch (e) {
      setAuthIdentity(null);
      return null;
    }
  }

  // apiAssetFileUrl, extractLegacyPrivatePackAssetId, normalizePackBackedRecord,
  // assetPreviewUrl, withAssetLibSrc → static/canvas/api.js

  async function fetchPackAssetBlobUrl(assetId) {
    const key = String(assetId || "").trim();
    if (!key) throw new Error("Missing pack asset id");
    if (packAssetBlobUrlCache.has(key)) return packAssetBlobUrlCache.get(key);
    if (packAssetBlobFetches.has(key)) return packAssetBlobFetches.get(key);
    const pending = (async () => {
      const res = await fetch(apiAssetFileUrl(key), { credentials: "include" });
      if (!res.ok) throw new Error(`Asset fetch failed (${res.status})`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      packAssetBlobUrlCache.set(key, blobUrl);
      return blobUrl;
    })();
    packAssetBlobFetches.set(key, pending);
    try {
      return await pending;
    } finally {
      packAssetBlobFetches.delete(key);
    }
  }

  function tokenImage(source) {
    const rec = normalizePackBackedRecord(source);
    if (rec && typeof rec === "object") {
      const sourceType = String(rec.source || "").toLowerCase();
      const assetId = String(rec.asset_id || "").trim();
      if (sourceType === "pack" && assetId) {
        const key = `pack:${assetId}`;
        if (tokenImageCache.has(key)) return tokenImageCache.get(key);
        const img = new Image();
        img.decoding = "async";
        img.loading = "eager";
        img.onload = () => requestRender();
        img.onerror = () => requestRender();
        tokenImageCache.set(key, img);
        const existingBlobUrl = packAssetBlobUrlCache.get(assetId);
        if (existingBlobUrl) {
          img.src = existingBlobUrl;
        } else {
          fetchPackAssetBlobUrl(assetId)
            .then((blobUrl) => {
              if (tokenImageCache.get(key) === img) img.src = blobUrl;
            })
            .catch(() => requestRender());
        }
        return img;
      }
      source = String(rec.image_url || rec.url_original || "");
    }
    const url = String(source || "").trim();
    if (!url) return null;
    if (tokenImageCache.has(url)) return tokenImageCache.get(url);
    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";
    img.onload = () => requestRender();
    img.onerror = () => requestRender();
    img.src = url;
    tokenImageCache.set(url, img);
    return img;
  }

  function drawTokenImageClippedCircle(t, s, r) {
    const img = tokenImage(t);
    if (!img || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return false;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const scale = Math.max((2 * r) / iw, (2 * r) / ih);
    const dw = iw * scale;
    const dh = ih * scale;

    ctx.save();
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, s.x - dw / 2, s.y - dh / 2, dw, dh);
    ctx.restore();
    return true;
  }

  // sanitizePackToken → static/canvas/assets.js

  // escapeHtml, normalizeLayerBand → static/canvas/utils.js

  function drawingLayerBand() {
    return "above_assets";
  }

  function normalizeStrokeRecord(stroke) {
    if (!stroke || typeof stroke !== "object") return stroke;
    return { ...stroke, layer_band: normalizeLayerBand(stroke.layer_band) };
  }

  function normalizeShapeRecord(shape) {
    if (!shape || typeof shape !== "object") return shape;
    return { ...shape, layer_band: normalizeLayerBand(shape.layer_band) };
  }

  function normalizeInteriorRecord(record = {}) {
    return {
      id: String(record.id || ""),
      x: Number(record.x || 0),
      y: Number(record.y || 0),
      w: Math.max(1, Number(record.w || 1)),
      h: Math.max(1, Number(record.h || 1)),
      style: String(record.style || "wood"),
      creator_id: record.creator_id || null,
      locked: !!record.locked,
    };
  }

  function normalizeInteriorEdgeRecord(record = {}) {
    const mode = (record.mode === "wall" || record.mode === "open" || record.mode === "door") ? record.mode : "auto";
    return {
      id: String(record.id || ""),
      edge_key: String(record.edge_key || ""),
      room_a_id: String(record.room_a_id || ""),
      room_b_id: record.room_b_id ? String(record.room_b_id) : null,
      mode,
      creator_id: record.creator_id || null,
    };
  }

  function applyInteriorEdgeOverrideToState(record = {}) {
    const edge = normalizeInteriorEdgeRecord(record);
    if (!edge.edge_key) return null;

    const matchingIds = [];
    for (const [existingId, existing] of state.interior_edges.entries()) {
      if (existing?.edge_key === edge.edge_key) matchingIds.push(existingId);
    }
    for (const existingId of matchingIds) state.interior_edges.delete(existingId);

    if (edge.mode === "auto") return null;

    const keepId = edge.id || matchingIds[matchingIds.length - 1] || "";
    if (!keepId) return null;

    const normalized = { ...edge, id: keepId };
    state.interior_edges.set(keepId, normalized);
    return normalized;
  }

  function activateDrawerTab(tab, openDrawer = true) {
    const tabId = String(tab || "tokens");
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tabId);
    });
    document.querySelectorAll(".drawer-panel").forEach((p) => {
      p.classList.toggle("active", p.id === `tab-${tabId}`);
    });
    if (openDrawer) drawer.classList.remove("hidden");
    if (drawer) drawer.classList.toggle("drawer-wide", tabId === "assets");
    if (tabId === "assets") {
      ensureAssetPanelReady();
    }
  }

  function normalizePanelForDrawer(panelEl) {
    if (!panelEl) return;
    panelEl.style.position = "static";
    panelEl.style.top = "";
    panelEl.style.right = "";
    panelEl.style.left = "";
    panelEl.style.width = "100%";
    panelEl.style.maxHeight = "none";
    panelEl.style.overflow = "visible";
    panelEl.style.background = "transparent";
    panelEl.style.border = "none";
    panelEl.style.padding = "0";
    panelEl.style.display = "block";
    panelEl.style.zIndex = "auto";
  }

  function drawerSection(parent, title) {
    const section = document.createElement("div");
    section.style.marginBottom = "12px";
    const header = document.createElement("div");
    header.textContent = title;
    header.style.fontWeight = "bold";
    header.style.margin = "6px 0";
    header.style.opacity = "0.95";
    const body = document.createElement("div");
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.gap = "6px";
    section.appendChild(header);
    section.appendChild(body);
    parent.appendChild(section);
    return body;
  }

  function drawerControlNode(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const node = el.closest("label") || el;
    if (node.dataset.drawerMoved === "1") return null;
    node.dataset.drawerMoved = "1";
    node.style.display = "flex";
    node.style.alignItems = "center";
    node.style.gap = "8px";
    return node;
  }

  function moveControlTo(body, id) {
    const node = drawerControlNode(id);
    if (!node) return;
    body.appendChild(node);
  }

  function mountSceneAndSettingsControls() {
    const tabScene = document.getElementById("tab-scene");
    const tabSettings = document.getElementById("tab-settings");
    if (!tabScene || !tabSettings) return;

    tabScene.innerHTML = "";
    tabSettings.innerHTML = "";

    const scenePerms = drawerSection(tabScene, "Permissions");
    moveControlTo(scenePerms, "allowPlayersMove");
    moveControlTo(scenePerms, "allowAllMove");
    moveControlTo(scenePerms, "lockAssetMove");
    moveControlTo(scenePerms, "lockdown");

    const sceneBackground = drawerSection(tabScene, "Background");
    moveControlTo(sceneBackground, "bgUrl");
    moveControlTo(sceneBackground, "setBg");
    moveControlTo(sceneBackground, "bgFile");
    moveControlTo(sceneBackground, "uploadBg");
    moveControlTo(sceneBackground, "terrainBg");
    moveControlTo(sceneBackground, "terrainStyle");
    moveControlTo(sceneBackground, "worldTone");
    moveControlTo(sceneBackground, "regenTerrain");
    moveControlTo(sceneBackground, "terrainBadge");

    const sceneLayers = drawerSection(tabScene, "Layers");
    moveControlTo(sceneLayers, "layerGrid");
    moveControlTo(sceneLayers, "layerDraw");
    moveControlTo(sceneLayers, "layerShapes");
    moveControlTo(sceneLayers, "layerAssets");
    moveControlTo(sceneLayers, "layerTokens");
    moveControlTo(sceneLayers, "layerInteriors");

    const settingsTools = drawerSection(tabSettings, "Tool Defaults");
    moveControlTo(settingsTools, "color");
    moveControlTo(settingsTools, "size");

    const settingsGrid = drawerSection(tabSettings, "Grid & Measure");
    moveControlTo(settingsGrid, "feetPerSq");
    moveControlTo(settingsGrid, "snap");
    moveControlTo(settingsGrid, "grid");
    moveControlTo(settingsGrid, "showGrid");

    const hotkeys = drawerSection(tabSettings, "Hotkey Cheat Sheet");
    hotkeys.style.fontSize = "12px";
    hotkeys.style.opacity = "0.9";
    hotkeys.innerHTML = `
      <div><b>V</b> Select tool</div>
      <div><b>P</b> Pen tool</div>
      <div><b>S</b> Shape tool</div>
      <div><b>T</b> Text tool</div>
      <div><b>E</b> Eraser tool</div>
      <div><b>R</b> Ruler tool</div>
      <div><b>I</b> Interior tool (GM)</div>
      <div><b>Shift+Drag</b> Marquee select tokens</div>
      <div><b>G / U</b> Group / Ungroup selected (GM)</div>
      <div><b>D</b> Toggle Downed badge (GM, selected token)</div>
      <div><b>Tab</b> Toggle drawer</div>
      <div><b>Delete/Backspace</b> Delete selected token, asset, or interior</div>
      <div><b>Esc</b> Close menus / cancel drag spawn</div>
    `;
  }

  function mountDrawerPanels() {
    const tabTokens = document.getElementById("tab-tokens");
    const tabAssets = document.getElementById("tab-assets");
    const tabRooms = document.getElementById("tab-rooms");
    const tabPlayers = document.getElementById("tab-players");

    if (libraryPanel && tabTokens && libraryPanel.parentElement !== tabTokens) tabTokens.appendChild(libraryPanel);
    if (assetPanel && tabAssets && assetPanel.parentElement !== tabAssets) tabAssets.appendChild(assetPanel);
    if (roomsPanel && tabRooms && roomsPanel.parentElement !== tabRooms) tabRooms.appendChild(roomsPanel);
    if (gmPanel && tabPlayers && gmPanel.parentElement !== tabPlayers) tabPlayers.appendChild(gmPanel);

    normalizePanelForDrawer(libraryPanel);
    normalizePanelForDrawer(assetPanel);
    normalizePanelForDrawer(roomsPanel);
    normalizePanelForDrawer(gmPanel);

    const roomsClose = document.getElementById("roomsPanelClose");
    const libraryClose = document.getElementById("libraryPanelClose");
    const assetClose = document.getElementById("assetPanelClose");
    const gmClose = document.getElementById("gmPanelClose");
    if (roomsClose) roomsClose.style.display = "none";
    if (libraryClose) libraryClose.style.display = "none";
    if (assetClose) assetClose.style.display = "none";
    if (gmClose) gmClose.style.display = "none";

    mountSceneAndSettingsControls();

    const gmBtn = document.getElementById("gmPanelBtn");
    const roomsBtn = document.getElementById("roomsPanelBtn");
    const libraryBtn = document.getElementById("libraryPanelBtn");
    if (gmBtn) gmBtn.style.display = "none";
    if (roomsBtn) roomsBtn.style.display = "none";
    if (libraryBtn) libraryBtn.style.display = "none";
  }

  function closeFloatingPanels(except = "") {
    if (except !== "gm" && except !== "rooms" && except !== "library") drawer.classList.add("hidden");
    if (except !== "token-menu") closeTokenMenu();
  }

  function closeTokenMenu() {
    tokenMenuEl.style.display = "none";
    tokenMenuTokenId = null;
  }

  function openInteriorEdgeMenu(edge, x, y) {
    if (!interiorEdgeMenu || !edge || !isGM() || isInteriorEdgeLocked(edge)) return;
    const hasSharedRooms = !!(
      edge.room_a_id &&
      edge.room_b_id &&
      state.interiors.has(edge.room_a_id) &&
      state.interiors.has(edge.room_b_id)
    );
    const currentMode = (() => {
      for (const existing of state.interior_edges.values()) {
        if (existing?.edge_key === edge.edge_key) return existing.mode || "auto";
      }
      return "auto";
    })();
    interiorEdgeMenu.querySelectorAll(".ctx-item[data-edge-mode]").forEach((item) => {
      const edgeMode = String(item.dataset.edgeMode || "").trim();
      item.style.display = edgeMode === "door" && !hasSharedRooms ? "none" : "flex";
      if (!item.dataset.baseLabel) item.dataset.baseLabel = item.textContent.replace(/^✓\s*/, "");
      item.textContent = `${item.dataset.edgeMode === currentMode ? "✓ " : ""}${item.dataset.baseLabel}`;
    });
    showContextMenu(interiorEdgeMenu, x, y);
    currentInteriorEdge = edge;
  }

  function getInteriorTargetRoomId(target) {
    if (!target) return null;
    if (target.resize?.id) return target.resize.id;
    if (target.edge) {
      if (selectedInteriorId && (selectedInteriorId === target.edge.room_a_id || selectedInteriorId === target.edge.room_b_id)) {
        return selectedInteriorId;
      }
      return target.edge.room_a_id || target.edge.room_b_id || null;
    }
    return target.roomId || null;
  }

  function resolveInteriorPointerTarget(wx, wy) {
    const resize = hitTestInteriorResize(wx, wy);
    if (resize) return { roomId: resize.id, edge: null, resize };
    const edge = hitTestInteriorEdge(wx, wy);
    if (edge) return { roomId: null, edge, resize: null };
    const roomId = hitTestInterior(wx, wy);
    return { roomId: roomId || null, edge: null, resize: null };
  }

  function maybeLogInteriorOverlapHint(wx, wy, interiorTarget = null) {
    if (!interiorTarget?.roomId || interiorTarget.edge) return;
    if (!hitTestInteriorOverlap(wx, wy)) return;
    log("These rooms overlap but do not share an editable seam.");
  }

  function openInteriorRoomMenu(interiorId, x, y) {
    const room = state.interiors.get(interiorId || "");
    if (!interiorCtx || !room || !isGM()) return;
    const lockItem = interiorCtx.querySelector('[data-action="interior_lock_toggle"]');
    if (lockItem) lockItem.textContent = room.locked ? "Unlock Interior" : "Lock Interior";
    currentInteriorContextId = room.id;
    showContextMenu(interiorCtx, x, y);
  }

  function setInteriorHoverState(nextRoomId = null, nextEdge = null, nextResize = null) {
    const edgeKey = hoveredInteriorEdge?.edge_key || "";
    const nextEdgeKey = nextEdge?.edge_key || "";
    const resizeId = hoveredInteriorResize?.id || "";
    const nextResizeId = nextResize?.id || "";
    const resizeSide = hoveredInteriorResize?.side || "";
    const nextResizeSide = nextResize?.side || "";
    const changed =
      hoveredInteriorId !== nextRoomId ||
      edgeKey !== nextEdgeKey ||
      resizeId !== nextResizeId ||
      resizeSide !== nextResizeSide;
    hoveredInteriorId = nextRoomId;
    hoveredInteriorEdge = nextEdge;
    hoveredInteriorResize = nextResize;
    updateCanvasCursor();
    if (changed) requestRender();
  }

  function resolveInteriorDragRect(wpos) {
    if (!draggingInteriorId || !interiorDragStart || !interiorDragOrigin) return null;
    const room = state.interiors.get(draggingInteriorId);
    if (!room) return null;
    let rect = null;
    if (resizingInterior) {
      let { x, y, w, h } = interiorDragOrigin;
      if (resizingInterior.side === "right") w = snapInterior(wpos.x) - x;
      if (resizingInterior.side === "left") {
        const nx = snapInterior(wpos.x);
        w = (x + w) - nx;
        x = nx;
      }
      if (resizingInterior.side === "bottom") h = snapInterior(wpos.y) - y;
      if (resizingInterior.side === "top") {
        const ny = snapInterior(wpos.y);
        h = (y + h) - ny;
        y = ny;
      }
      w = Math.max(ui.gridSize, w);
      h = Math.max(ui.gridSize, h);
      rect = { id: room.id, x, y, w, h };
    } else {
      const dx = wpos.x - interiorDragStart.x;
      const dy = wpos.y - interiorDragStart.y;
      rect = {
        id: room.id,
        x: snapInterior(interiorDragOrigin.x + dx),
        y: snapInterior(interiorDragOrigin.y + dy),
        w: room.w,
        h: room.h,
      };
    }
    const assisted = applyInteriorSeamAssist(rect, {
      excludeRoomId: room.id,
      mode: resizingInterior ? "resize" : "move",
      resizeSide: resizingInterior?.side || null,
      threshold: ui.gridSize * 0.35,
    });
    return { ...assisted.rect, assist: assisted.assist };
  }

  function hideAllCtx() {
    if (ctxSubHideTimer) {
      clearTimeout(ctxSubHideTimer);
      ctxSubHideTimer = null;
    }
    for (const m of allCtxMenus) m.classList.add("hidden");
    currentInteriorContextId = null;
    currentInteriorEdge = null;
  }

  function hideToolPanels() {
    toolColorPanel.classList.add("hidden");
    toolSizePanel.classList.add("hidden");
    toolTextPanel.classList.add("hidden");
    // terrain/fog paint panels stay visible while those tools are active
    pendingTextPlacement = null;
    textPanelTargetShapeId = null;
    colorPanelTargetShapeId = null;
    sizePanelTargetShapeId = null;
    sizePanelMode = "brush";
  }

  function showFloatingToolPanel(panelEl, x, y) {
    toolColorPanel.classList.add("hidden");
    toolSizePanel.classList.add("hidden");
    toolTextPanel.classList.add("hidden");
    panelEl.classList.remove("hidden");
    clampMenuToViewport(panelEl, x, y);
  }

  function isClickInsideToolPanel(target) {
    return !toolColorPanel.classList.contains("hidden") && toolColorPanel.contains(target)
      || !toolSizePanel.classList.contains("hidden") && toolSizePanel.contains(target)
      || !toolTextPanel.classList.contains("hidden") && toolTextPanel.contains(target)
      || (terrainPaintPanel && !terrainPaintPanel.classList.contains("hidden") && terrainPaintPanel.contains(target))
      || (fogPaintPanel && !fogPaintPanel.classList.contains("hidden") && fogPaintPanel.contains(target));
  }

  function openToolColorPanel(title = "Color", opts = {}) {
    colorPanelTargetShapeId = opts?.shapeId || null;
    textPanelTargetShapeId = null;
    sizePanelTargetShapeId = null;
    toolColorTitle.textContent = title;
    if (colorPanelTargetShapeId) {
      const sh = state.shapes.get(colorPanelTargetShapeId);
      toolColorPicker.value = String(sh?.color || colorEl.value || "#ffffff");
    } else {
      toolColorPicker.value = String(colorEl.value || "#ffffff");
    }
    showFloatingToolPanel(toolColorPanel, lastCtxClientPos.x + 8, lastCtxClientPos.y + 8);
  }

  function openToolSizePanel(title = "Size", opts = {}) {
    textPanelTargetShapeId = null;
    colorPanelTargetShapeId = null;
    sizePanelMode = opts?.mode === "text" ? "text" : "brush";
    sizePanelTargetShapeId = opts?.shapeId || null;
    const min = sizePanelMode === "text" ? 8 : 1;
    const max = sizePanelMode === "text" ? 96 : 30;
    const currentTextSize = sizePanelTargetShapeId
      ? Number(state.shapes.get(sizePanelTargetShapeId)?.font_size || ui.textFontSize || 24)
      : Number(ui.textFontSize || 24);
    const size = clamp(
      Number(sizePanelMode === "text" ? currentTextSize : (sizeEl.value || "3")),
      min,
      max
    );
    toolSizeTitle.textContent = title;
    toolSizeSlider.min = String(min);
    toolSizeSlider.max = String(max);
    toolSizeSlider.step = "1";
    toolSizeSlider.value = String(Math.round(size));
    toolSizeValue.textContent = String(Math.round(size));
    showFloatingToolPanel(toolSizePanel, lastCtxClientPos.x + 8, lastCtxClientPos.y + 8);
  }

  function createTextShapeAt(pos, text) {
    if (!pos) return;
    const content = String(text || "").trim();
    if (!content) return;
    send("SHAPE_ADD", {
      id: makeId(),
      type: "text",
      x1: pos.x,
      y1: pos.y,
      x2: pos.x,
      y2: pos.y,
      text: content,
      font_size: clamp(Number(ui.textFontSize || 24), 8, 96),
      color: brushColor(),
      width: 1,
      fill: false,
      locked: false,
      layer: "draw",
      layer_band: drawingLayerBand(),
      creator_id: myId(),
    });
  }

  function openToolTextPanel() {
    colorPanelTargetShapeId = null;
    sizePanelTargetShapeId = null;
    if (textPanelTargetShapeId) {
      const sh = state.shapes.get(textPanelTargetShapeId);
      toolTextInput.value = String(sh?.text || ui.textDraft || "");
    } else {
      toolTextInput.value = String(ui.textDraft || "");
    }
    showFloatingToolPanel(toolTextPanel, lastCtxClientPos.x + 8, lastCtxClientPos.y + 8);
    try { toolTextInput.focus(); toolTextInput.select(); } catch {}
  }

  function hideCtxSubs() {
    mapCtxBg.classList.add("hidden");
    mapCtxLayers.classList.add("hidden");
    mapCtxClear.classList.add("hidden");
  }

  function clearCtxSubHideTimer() {
    if (!ctxSubHideTimer) return;
    clearTimeout(ctxSubHideTimer);
    ctxSubHideTimer = null;
  }

  function scheduleCtxSubHide(delayMs = 120) {
    clearCtxSubHideTimer();
    ctxSubHideTimer = setTimeout(() => {
      hideCtxSubs();
      ctxSubHideTimer = null;
    }, delayMs);
  }

  function clampMenuToViewport(menuEl, x, y) {
    const wasHidden = menuEl.classList.contains("hidden");
    if (wasHidden) menuEl.classList.remove("hidden");
    const pad = 8;
    const w = menuEl.offsetWidth;
    const h = menuEl.offsetHeight;
    const maxX = window.innerWidth - w - pad;
    const maxY = window.innerHeight - h - pad;
    const cx = Math.max(pad, Math.min(x, maxX));
    const cy = Math.max(pad, Math.min(y, maxY));
    menuEl.style.left = `${cx}px`;
    menuEl.style.top = `${cy}px`;
    if (wasHidden) menuEl.classList.add("hidden");
  }

  function showMapMenu(x, y) {
    const gm = isGM();
    document.querySelectorAll("#mapCtx [data-gm='1'], #mapCtx-bg [data-gm='1'], #mapCtx-layers [data-gm='1'], #mapCtx-clear [data-gm='1']").forEach((el) => {
      el.style.display = gm ? "flex" : "none";
    });
    if (!gm) {
      mapCtxBg.classList.add("hidden");
      mapCtxLayers.classList.add("hidden");
      mapCtxClear.classList.add("hidden");
    }
    showContextMenu(mapCtx, x, y);
  }

  function setCtxChecked(action, checked) {
    const item = document.querySelector(`.ctx-item[data-action="${action}"]`);
    if (!item) return;
    if (!item.dataset.baseLabel) item.dataset.baseLabel = item.textContent.replace(/^✓\s*/, "");
    item.textContent = `${checked ? "✓ " : ""}${item.dataset.baseLabel}`;
  }

  function refreshToolContextChecks() {
    const size = Number(sizeEl.value || "3");
    const color = String(colorEl.value || "").toLowerCase();
    const currentTool = tool();
    const feet = Number(feetPerSqEl.value || "5");
    const snapOn = !!snapEl.checked;

    setCtxChecked("pen_size_2", size === 2);
    setCtxChecked("pen_size_4", size === 4);
    setCtxChecked("pen_size_8", size === 8);
    setCtxChecked("pen_color_white", color === "#ffffff");
    setCtxChecked("pen_color_red", color === "#ff3b30");
    setCtxChecked("pen_color_green", color === "#34c759");
    setCtxChecked("pen_color_blue", color === "#0a84ff");

    setCtxChecked("shape_tool_rect", currentTool === "rect");
    setCtxChecked("shape_tool_circle", currentTool === "circle");
    setCtxChecked("shape_tool_line", currentTool === "line");
    setCtxChecked("shape_tool_arrow", currentTool === "arrow");
    setCtxChecked("shape_size_2", size === 2);
    setCtxChecked("shape_size_4", size === 4);
    setCtxChecked("shape_size_8", size === 8);
    setCtxChecked("shape_toggle_snap", snapOn);
    setCtxChecked("text_size_16", Number(ui.textFontSize || 24) === 16);
    setCtxChecked("text_size_24", Number(ui.textFontSize || 24) === 24);
    setCtxChecked("text_size_32", Number(ui.textFontSize || 24) === 32);

    setCtxChecked("ruler_feet_5", feet === 5);
    setCtxChecked("ruler_feet_10", feet === 10);
    setCtxChecked("ruler_feet_15", feet === 15);
    setCtxChecked("ruler_toggle_snap", snapOn);
  }

  function showContextMenu(menuEl, x, y) {
    lastCtxClientPos = { x, y };
    refreshToolContextChecks();
    hideAllCtx();
    hideToolPanels();
    menuEl.classList.remove("hidden");
    clampMenuToViewport(menuEl, x, y);
  }

  function showSubMenu(subEl, parentRowEl) {
    clearCtxSubHideTimer();
    const rect = parentRowEl.getBoundingClientRect();
    const x = rect.right + 6;
    const y = rect.top;
    subEl.classList.remove("hidden");
    clampMenuToViewport(subEl, x, y);
  }

  function isClickInsideAnyCtxMenu(target) {
    return allCtxMenus.some((m) => !m.classList.contains("hidden") && m.contains(target));
  }

  function setLayerVisibility(next) {
    state.layer_visibility = { ...state.layer_visibility, ...next };
    layerGridEl.checked = !!state.layer_visibility.grid;
    layerDrawEl.checked = !!state.layer_visibility.drawings;
    layerShapesEl.checked = !!state.layer_visibility.shapes;
    layerAssetsEl.checked = !!state.layer_visibility.assets;
    layerTokensEl.checked = !!state.layer_visibility.tokens;
    if (layerInteriorsEl) layerInteriorsEl.checked = !!state.layer_visibility.interiors;
    send("ROOM_SETTINGS", { layer_visibility: state.layer_visibility });
    requestRender();
  }

  function spawnDefaultTokenAt(wx, wy) {
    if (!isGM()) return;
    const id = makeId();
    const name = "Token";
    const color = "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0");
    const x = snap(wx);
    const y = snap(wy);
    const size_scale = ui.tokenSpawnScale;
    const token = { id, x, y, name, color, image_url: null, size_scale, owner_id: null, locked: false, badges: [] };
    if (online) {
      state.tokens.set(id, token);
      refreshGmUI();
      requestRender();
    }
    send("TOKEN_CREATE", token);
  }

  function clearDrawings() {
    if (!isGM()) return;
    const ids = Array.from(state.strokes.keys());
    if (!ids.length) return;
    send("STROKE_DELETE", { ids });
  }

  function clearShapes() {
    if (!isGM()) return;
    const ids = Array.from(state.shapes.keys());
    for (const id of ids) send("SHAPE_DELETE", { id });
  }

  function clearTokens() {
    if (!isGM()) return;
    const ids = Array.from(state.tokens.keys());
    for (const id of ids) send("TOKEN_DELETE", { id });
  }

  function canDuplicateInterior(interiorId) {
    const room = typeof interiorId === "string" ? state.interiors.get(interiorId) : interiorId;
    return !!(room && isGM());
  }

  function duplicateInteriorRoom(interiorId) {
    const room = state.interiors.get(interiorId || "");
    if (!room || !canDuplicateInterior(room)) return;

    const offset = ui.gridSize;
    const duplicate = normalizeInteriorRecord({
      id: makeId(),
      x: Number(room.x || 0) + offset,
      y: Number(room.y || 0) + offset,
      w: room.w,
      h: room.h,
      style: room.style,
      creator_id: myId(),
      locked: false,
    });

    send("INTERIOR_ADD", duplicate);

    selectedInteriorId = duplicate.id;
    currentInteriorContextId = duplicate.id;
    draggingInteriorId = null;
    resizingInterior = null;
    activeInteriorAssist = null;
    interiorDragStart = null;
    interiorDragOrigin = null;
    requestRender();
  }

  function handleCtxAction(action) {
    switch (action) {
      case "spawn_default": {
        const w = mapCtxWorld || screenToWorld(canvas.getBoundingClientRect().width / 2, canvas.getBoundingClientRect().height / 2);
        spawnDefaultTokenAt(w.x, w.y);
        break;
      }
      case "bg_solid":
        if (isGM()) send("ROOM_SETTINGS", { background_mode: "solid", background_url: null });
        break;
      case "bg_url":
        if (isGM()) {
          const url = prompt("Background image URL:", state.background_url || "");
          if (url !== null) send("ROOM_SETTINGS", { background_mode: (url.trim() ? "url" : "solid"), background_url: url.trim() || null });
        }
        break;
      case "bg_terrain":
        if (isGM()) send("ROOM_SETTINGS", { background_mode: "terrain", terrain_style: terrainStyleEl.value });
        break;
      case "bg_terrain_regen":
        if (isGM()) send("ROOM_SETTINGS", { background_mode: "terrain", terrain_seed: randomTerrainSeed(), terrain_style: terrainStyleEl.value });
        break;
      case "toggle_layer_grid":
        if (!isGM()) return;
        setLayerVisibility({ grid: !state.layer_visibility.grid });
        break;
      case "toggle_layer_drawings":
        if (!isGM()) return;
        setLayerVisibility({ drawings: !state.layer_visibility.drawings });
        break;
      case "toggle_layer_shapes":
        if (!isGM()) return;
        setLayerVisibility({ shapes: !state.layer_visibility.shapes });
        break;
      case "toggle_layer_assets":
        if (!isGM()) return;
        setLayerVisibility({ assets: !state.layer_visibility.assets });
        break;
      case "toggle_layer_tokens":
        if (!isGM()) return;
        setLayerVisibility({ tokens: !state.layer_visibility.tokens });
        break;
      case "toggle_layer_interiors":
        if (!isGM()) return;
        setLayerVisibility({ interiors: !state.layer_visibility.interiors });
        break;
      case "clear_drawings":
        if (!isGM()) return;
        if (confirm("Clear drawings for this room?")) clearDrawings();
        break;
      case "clear_shapes":
        if (!isGM()) return;
        if (confirm("Clear shapes for this room?")) clearShapes();
        break;
      case "clear_tokens":
        if (!isGM()) return;
        if (confirm("Clear all tokens for this room?")) clearTokens();
        break;
      case "save_snapshot":
        if (isGM()) document.getElementById("saveSnapshotBtn").click();
        break;
      case "open_tokens":
        activateDrawerTab("tokens", true);
        break;
      case "open_assets":
        activateDrawerTab("assets", true);
        ensureAssetPanelReady();
        break;
      case "asset_duplicate": {
        const offset = ui.snap ? ui.gridSize : Math.max(24, ui.gridSize * 0.5);
        const dupIds = selectedAssetIds.size > 1 ? Array.from(selectedAssetIds) : [selectedAssetId];
        const newIds = [];
        for (const dupId of dupIds) {
          const a = state.assets.get(dupId || "");
          if (!a || !canEditAssetLocal(a)) continue;
          const newId = makeId();
          newIds.push(newId);
          send("ASSET_INSTANCE_CREATE", {
            ...a,
            id: newId,
            x: Number(a.x || 0) + offset,
            y: Number(a.y || 0) + offset,
            creator_id: myId(),
            locked: false,
          });
        }
        // Transfer selection to the new duplicates so they can be immediately dragged.
        if (newIds.length) {
          selectedAssetIds.clear();
          for (const id of newIds) selectedAssetIds.add(id);
          selectedAssetId = newIds[newIds.length - 1];
        }
        break;
      }
      case "asset_show_in_library": {
        const a = state.assets.get(selectedAssetId || "");
        if (!a) break;
        if (typeof revealPlacedAssetInLibrary === "function") {
          void revealPlacedAssetInLibrary(a);
        }
        break;
      }
      case "asset_resize_up": {
        const a = state.assets.get(selectedAssetId || "");
        if (!a || !canEditAssetLocal(a)) break;
        applyAssetUpdate(a.id, assetResizePatch(a, +1), true);
        break;
      }
      case "asset_resize_down": {
        const a = state.assets.get(selectedAssetId || "");
        if (!a || !canEditAssetLocal(a)) break;
        applyAssetUpdate(a.id, assetResizePatch(a, -1), true);
        break;
      }
      case "asset_rotate_cw": {
        const a = state.assets.get(selectedAssetId || "");
        if (!a || !canEditAssetLocal(a)) break;
        applyAssetUpdate(a.id, { rotation: Number(a.rotation || 0) + (Math.PI / 12) }, true);
        break;
      }
      case "asset_rotate_ccw": {
        const a = state.assets.get(selectedAssetId || "");
        if (!a || !canEditAssetLocal(a)) break;
        applyAssetUpdate(a.id, { rotation: Number(a.rotation || 0) - (Math.PI / 12) }, true);
        break;
      }
      case "asset_rotate_reset": {
        const a = state.assets.get(selectedAssetId || "");
        if (!a || !canEditAssetLocal(a)) break;
        applyAssetUpdate(a.id, { rotation: 0 }, true);
        break;
      }
      case "asset_flip_x": {
        const a = state.assets.get(selectedAssetId || "");
        if (!a || !canEditAssetLocal(a)) break;
        const sx = signedAssetScale(a.scale_x, 1);
        applyAssetUpdate(a.id, { scale_x: -sx }, true);
        break;
      }
      case "asset_layer_front": {
        const a = state.assets.get(selectedAssetId || "");
        if (!a || !canEditAssetLocal(a)) break;
        let maxLayer = Number(a.layer || 0);
        for (const item of state.assets.values()) {
          const l = Number(item?.layer || 0);
          if (l > maxLayer) maxLayer = l;
        }
        const nextLayer = maxLayer + 1;
        if (Number(a.layer || 0) !== nextLayer) applyAssetUpdate(a.id, { layer: nextLayer }, true);
        break;
      }
      case "asset_layer_back": {
        const a = state.assets.get(selectedAssetId || "");
        if (!a || !canEditAssetLocal(a)) break;
        let minLayer = Number(a.layer || 0);
        for (const item of state.assets.values()) {
          const l = Number(item?.layer || 0);
          if (l < minLayer) minLayer = l;
        }
        const nextLayer = minLayer - 1;
        if (Number(a.layer || 0) !== nextLayer) applyAssetUpdate(a.id, { layer: nextLayer }, true);
        break;
      }
      case "asset_flip_y": {
        const a = state.assets.get(selectedAssetId || "");
        if (!a || !canEditAssetLocal(a)) break;
        const sy = signedAssetScale(a.scale_y, 1);
        applyAssetUpdate(a.id, { scale_y: -sy }, true);
        break;
      }
      case "asset_lock_toggle": {
        const a = state.assets.get(selectedAssetId || "");
        if (!a || !isGM()) break;
        applyAssetUpdate(a.id, { locked: !a.locked }, true);
        break;
      }
      case "asset_delete": {
        const delIds = selectedAssetIds.size > 1 ? Array.from(selectedAssetIds) : [selectedAssetId];
        const deletable = delIds.filter((id) => { const a = state.assets.get(id || ""); return a && canDeleteAssetLocal(a); });
        if (!deletable.length) break;
        const msg = deletable.length > 1 ? `Delete ${deletable.length} selected assets?` : "Delete selected asset?";
        if (!confirm(msg)) break;
        for (const id of deletable) send("ASSET_INSTANCE_DELETE", { id });
        selectedAssetIds.clear();
        selectedAssetId = null;
        break;
      }
      case "interior_lock_toggle": {
        const room = state.interiors.get(currentInteriorContextId || selectedInteriorId || "");
        if (!room || !isGM()) break;
        send("INTERIOR_SET_LOCK", { id: room.id, locked: !room.locked });
        break;
      }
      case "interior_duplicate": {
        const room = state.interiors.get(currentInteriorContextId || selectedInteriorId || "");
        if (!room) break;
        duplicateInteriorRoom(room.id);
        break;
      }
      case "interior_delete": {
        const room = state.interiors.get(currentInteriorContextId || selectedInteriorId || "");
        if (!room || !isGM()) break;
        send("INTERIOR_DELETE", { id: room.id });
        selectedInteriorId = null;
        break;
      }
      case "open_rooms":
        activateDrawerTab("rooms", true);
        refreshRoomsPanel();
        refreshSnapshotsPanel();
        break;
      case "open_scene":
        activateDrawerTab("scene", true);
        break;
      case "pen_size_2":
        sizeEl.value = "2";
        break;
      case "pen_size_4":
        sizeEl.value = "4";
        break;
      case "pen_size_8":
        sizeEl.value = "8";
        break;
      case "pen_size_custom": {
        openToolSizePanel("Pen Size");
        break;
      }
      case "pen_color_white":
        colorEl.value = "#ffffff";
        break;
      case "pen_color_red":
        colorEl.value = "#ff3b30";
        break;
      case "pen_color_green":
        colorEl.value = "#34c759";
        break;
      case "pen_color_blue":
        colorEl.value = "#0a84ff";
        break;
      case "pen_color_custom": {
        openToolColorPanel("Pen Color");
        break;
      }
      case "shape_tool_rect":
        setTool("rect");
        break;
      case "shape_tool_circle":
        setTool("circle");
        break;
      case "shape_tool_line":
        setTool("line");
        break;
      case "shape_tool_arrow":
        setTool("arrow");
        break;
      case "shape_size_2":
        sizeEl.value = "2";
        break;
      case "shape_size_4":
        sizeEl.value = "4";
        break;
      case "shape_size_8":
        sizeEl.value = "8";
        break;
      case "shape_size_custom": {
        openToolSizePanel("Shape Stroke");
        break;
      }
      case "shape_color_custom": {
        openToolColorPanel("Shape Color");
        break;
      }
      case "shape_toggle_snap":
        snapEl.checked = !snapEl.checked;
        refreshUI();
        break;
      case "text_set_content":
        if (selectedShapeId) {
          const sh = state.shapes.get(selectedShapeId);
          if (sh?.type === "text") {
            if (!canEditShapeLocal(sh)) {
              log("Not allowed to edit this text.");
              break;
            }
            textPanelTargetShapeId = selectedShapeId;
          } else {
            textPanelTargetShapeId = null;
          }
        } else {
          textPanelTargetShapeId = null;
        }
        openToolTextPanel();
        break;
      case "text_size_16":
        if (selectedShapeId) {
          const sh = state.shapes.get(selectedShapeId);
          if (sh && sh.type === "text" && canEditShapeLocal(sh)) {
            send("SHAPE_UPDATE", { id: selectedShapeId, font_size: 16, commit: true });
            refreshToolContextChecks();
            break;
          }
        }
        ui.textFontSize = 16;
        refreshToolContextChecks();
        break;
      case "text_size_24":
        if (selectedShapeId) {
          const sh = state.shapes.get(selectedShapeId);
          if (sh && sh.type === "text" && canEditShapeLocal(sh)) {
            send("SHAPE_UPDATE", { id: selectedShapeId, font_size: 24, commit: true });
            refreshToolContextChecks();
            break;
          }
        }
        ui.textFontSize = 24;
        refreshToolContextChecks();
        break;
      case "text_size_32":
        if (selectedShapeId) {
          const sh = state.shapes.get(selectedShapeId);
          if (sh && sh.type === "text" && canEditShapeLocal(sh)) {
            send("SHAPE_UPDATE", { id: selectedShapeId, font_size: 32, commit: true });
            refreshToolContextChecks();
            break;
          }
        }
        ui.textFontSize = 32;
        refreshToolContextChecks();
        break;
      case "text_size_custom": {
        if (selectedShapeId) {
          const sh = state.shapes.get(selectedShapeId);
          if (sh && sh.type === "text" && canEditShapeLocal(sh)) {
            openToolSizePanel("Text Size", { mode: "text", shapeId: selectedShapeId });
            break;
          }
        }
        openToolSizePanel("Text Size", { mode: "text" });
        break;
      }
      case "text_color_custom":
        if (selectedShapeId) {
          const sh = state.shapes.get(selectedShapeId);
          if (sh && canEditShapeLocal(sh)) {
            openToolColorPanel("Text Color", { shapeId: selectedShapeId });
            break;
          }
        }
        openToolColorPanel("Text Color");
        break;
      case "ruler_feet_5":
        feetPerSqEl.value = "5";
        refreshUI();
        break;
      case "ruler_feet_10":
        feetPerSqEl.value = "10";
        refreshUI();
        break;
      case "ruler_feet_15":
        feetPerSqEl.value = "15";
        refreshUI();
        break;
      case "ruler_toggle_snap":
        snapEl.checked = !snapEl.checked;
        refreshUI();
        break;
      case "ruler_clear":
        activeRuler = null;
        requestRender();
        break;
      default:
        break;
    }
  }

  function normalizedBadgeList(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const raw of input) {
      const id = String(raw || "").trim();
      if (!TOKEN_BADGE_IDS.has(id)) continue;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  function tokenBadgesSet(token) {
    return new Set(normalizedBadgeList(token?.badges));
  }

  function refreshTokenMenuBadgeButtons() {
    if (!tokenMenuTokenId) return;
    const t = state.tokens.get(tokenMenuTokenId);
    const current = tokenBadgesSet(t);
    for (const badge of TOKEN_BADGES) {
      const btn = document.getElementById(badge.menuId);
      if (!btn) continue;
      btn.textContent = `${current.has(badge.id) ? "✓ " : ""}${badge.label}`;
    }
    const clearBtn = document.getElementById("tokenMenuBadgeClear");
    if (clearBtn) clearBtn.style.opacity = current.size ? "1" : "0.6";
  }

  function sendTokenBadgeToggle(tokenId, badgeId, enabled = null) {
    send("TOKEN_BADGE_TOGGLE", { id: tokenId, badge: badgeId, enabled });
  }

  function setTokenBadgeLocal(tokenId, badgeId, enabled = null) {
    const t = state.tokens.get(tokenId);
    if (!t || !TOKEN_BADGE_IDS.has(badgeId)) return;
    const next = tokenBadgesSet(t);
    if (enabled === true) next.add(badgeId);
    else if (enabled === false) next.delete(badgeId);
    else if (next.has(badgeId)) next.delete(badgeId);
    else next.add(badgeId);
    t.badges = Array.from(next).sort();
    state.tokens.set(tokenId, t);
  }

  function canEditTokenLocal(token) {
    if (!token) return false;
    if (token.locked) return false;
    if (isGM()) return true;
    if (state.lockdown) return false;
    return !!state.allow_all_move;
  }

  function canDeleteTokenLocal(token) {
    if (!token) return false;
    if (isGM()) return true;
    if (state.lockdown) return false;
    if (token.locked) return false;
    return !!(token.creator_id && token.creator_id === myId());
  }

  function getSelectedInterior() {
    return selectedInteriorId ? state.interiors.get(selectedInteriorId) : null;
  }

  function canDeleteSelectedInterior() {
    const room = getSelectedInterior();
    return !!(room && isGM());
  }

  function canEditShapeLocal(shape) {
    if (!shape) return false;
    if (shape.locked) return false;
    if (isGM()) return true;
    if (state.lockdown) return false;
    if (state.allow_all_move) return true;
    return !!(shape.creator_id && shape.creator_id === myId());
  }

  // canEditAssetLocal, canDeleteAssetLocal, isAssetInteractionLocked → static/canvas/assets.js

  // signedAssetScale → static/canvas/utils.js

  // assetResizePatch, applyAssetUpdate → static/canvas/assets.js

  // normalizeAngleDeg → static/canvas/utils.js

  // syncAssetCtxSliders → static/canvas/assets.js

  function setSelection(ids = [], primaryId = null) {
    selectedTokenIds.clear();
    for (const id of ids) {
      if (state.tokens.has(id)) selectedTokenIds.add(id);
    }
    if (primaryId && selectedTokenIds.has(primaryId)) {
      selectedTokenId = primaryId;
      return;
    }
    selectedTokenId = selectedTokenIds.size ? Array.from(selectedTokenIds)[0] : null;
  }

  function selectOnly(tokenId) {
    if (!tokenId || !state.tokens.has(tokenId)) {
      setSelection([]);
      return;
    }
    setSelection([tokenId], tokenId);
  }

  function toggleSelection(tokenId) {
    if (!tokenId || !state.tokens.has(tokenId)) return;
    if (selectedTokenIds.has(tokenId)) selectedTokenIds.delete(tokenId);
    else selectedTokenIds.add(tokenId);
    selectedTokenId = selectedTokenIds.has(selectedTokenId) ? selectedTokenId : (selectedTokenIds.size ? tokenId : null);
  }

  function selectedIdsArray() {
    if (selectedTokenIds.size) return Array.from(selectedTokenIds).filter((id) => state.tokens.has(id));
    return selectedTokenId && state.tokens.has(selectedTokenId) ? [selectedTokenId] : [];
  }

  function selectionCount() {
    return selectedIdsArray().length;
  }

  function selectedIdsIncludingGroups() {
    const base = new Set(selectedIdsArray());
    const groupIds = new Set();
    for (const id of base) {
      const t = state.tokens.get(id);
      if (t?.group_id) groupIds.add(String(t.group_id));
    }
    if (!groupIds.size) return Array.from(base);
    for (const [id, t] of state.tokens) {
      if (t?.group_id && groupIds.has(String(t.group_id))) base.add(id);
    }
    return Array.from(base);
  }

  function tokenIntersectsWorldRect(token, rect) {
    const r = tokenRadiusWorld(token);
    const nearestX = clamp(token.x, rect.minX, rect.maxX);
    const nearestY = clamp(token.y, rect.minY, rect.maxY);
    const dx = token.x - nearestX;
    const dy = token.y - nearestY;
    return (dx * dx + dy * dy) <= r * r;
  }

  // normalizeWorldRect → static/canvas/utils.js

  function groupSelectedTokens() {
    if (!isGM()) return;
    const ids = selectedIdsArray();
    if (ids.length < 2) {
      log("Group requires at least 2 selected tokens.");
      return;
    }
    const groupId = `grp-${makeId()}`;
    send("TOKEN_SET_GROUP", { ids, group_id: groupId });
  }

  function ungroupSelectedTokens() {
    if (!isGM()) return;
    const ids = selectedIdsIncludingGroups();
    if (!ids.length) return;
    send("TOKEN_SET_GROUP", { ids, group_id: null });
  }

  function openTokenMenu(tokenId, clientX, clientY) {
    tokenMenuTokenId = tokenId;
    const t = state.tokens.get(tokenId);
    const canEdit = canEditTokenLocal(t);
    const canDelete = canDeleteTokenLocal(t);
    if (tokenMenuLockBtn) tokenMenuLockBtn.textContent = t?.locked ? "Unlock" : "Lock";
    if (tokenMenuRenameBtn) tokenMenuRenameBtn.style.display = canEdit ? "block" : "none";
    if (tokenMenuResizeBtn) tokenMenuResizeBtn.style.display = canEdit ? "block" : "none";
    if (tokenMenuAssignBtn) tokenMenuAssignBtn.style.display = isGM() ? "block" : "none";
    if (tokenMenuLockBtn) tokenMenuLockBtn.style.display = isGM() ? "block" : "none";
    if (tokenMenuGroupBtn) tokenMenuGroupBtn.style.display = isGM() ? "block" : "none";
    if (tokenMenuUngroupBtn) tokenMenuUngroupBtn.style.display = isGM() ? "block" : "none";
    if (tokenMenuDeleteBtn) tokenMenuDeleteBtn.style.display = canDelete ? "block" : "none";
    for (const badge of TOKEN_BADGES) {
      const btn = document.getElementById(badge.menuId);
      if (btn) btn.style.display = isGM() ? "block" : "none";
    }
    const badgeClearBtn = document.getElementById("tokenMenuBadgeClear");
    if (badgeClearBtn) badgeClearBtn.style.display = isGM() ? "block" : "none";
    refreshTokenMenuBadgeButtons();
    const wrapRect = document.getElementById("wrap").getBoundingClientRect();
    tokenMenuEl.style.display = "block";
    tokenMenuEl.style.visibility = "hidden";
    const menuRect = tokenMenuEl.getBoundingClientRect();
    const clientXClamped = Math.min(clientX, window.innerWidth - menuRect.width - 8);
    const clientYClamped = Math.min(clientY, window.innerHeight - menuRect.height - 8);
    const x = clamp(clientXClamped - wrapRect.left, 8, Math.max(8, wrapRect.width - menuRect.width - 8));
    const y = clamp(clientYClamped - wrapRect.top, 8, Math.max(8, wrapRect.height - menuRect.height - 8));
    tokenMenuEl.style.left = `${x}px`;
    tokenMenuEl.style.top = `${y}px`;
    tokenMenuEl.style.visibility = "visible";
    tokenMenuEl.style.display = "block";
  }

  function tokenMenuTargetId() {
    return tokenMenuTokenId && state.tokens.has(tokenMenuTokenId) ? tokenMenuTokenId : selectedTokenId;
  }

  // openSessionModal, closeSessionModal, updateSessionPill, refreshSessionModalAuth → static/canvas/sessions.js

  // openMapPreview, closeMapPreview → static/canvas/assets.js

  function flashToolActivate(el) {
    if (!el) return;
    el.classList.remove("tool-activate");
    // Reflow so repeated toggles replay animation.
    void el.offsetWidth;
    el.classList.add("tool-activate");
  }

  function hideTooltip() {
    if (tooltipTimer) {
      clearTimeout(tooltipTimer);
      tooltipTimer = null;
    }
    uiTooltip.classList.add("hidden");
  }

  function showTooltipFor(el) {
    if (!el) return;
    const text = el.dataset.tip;
    if (!text) return;
    hideTooltip();
    tooltipTimer = setTimeout(() => {
      uiTooltip.textContent = text;
      uiTooltip.classList.remove("hidden");
      const rect = el.getBoundingClientRect();
      const pad = 8;
      const tw = uiTooltip.offsetWidth;
      const th = uiTooltip.offsetHeight;
      const x = Math.max(pad, Math.min(rect.left + rect.width / 2 - tw / 2, window.innerWidth - tw - pad));
      const y = Math.max(pad, rect.bottom + 8);
      uiTooltip.style.left = `${x}px`;
      uiTooltip.style.top = `${y}px`;
    }, 300);
  }

  function updateCanvasCursor() {
    if (dragSpawn) {
      canvas.style.cursor = "copy";
      return;
    }
    const t = tool();
    if (t === "move" && (draggingInteriorId || resizingInterior)) {
      if (resizingInterior) {
        canvas.style.cursor = (resizingInterior.side === "left" || resizingInterior.side === "right") ? "ew-resize" : "ns-resize";
      } else {
        canvas.style.cursor = "grabbing";
      }
      return;
    }
    if (isPanning || (t === "move" && (draggingTokenIds.length || !!draggingAssetId))) {
      canvas.style.cursor = "grabbing";
      return;
    }
    if (t === "move") {
      if (hoveredInteriorResize) {
        if (canEditInterior(hoveredInteriorResize.id)) {
          canvas.style.cursor = (hoveredInteriorResize.side === "left" || hoveredInteriorResize.side === "right") ? "ew-resize" : "ns-resize";
        } else {
          canvas.style.cursor = "default";
        }
        return;
      }
      if (hoveredInteriorEdge) {
        canvas.style.cursor = isGM() && !isInteriorEdgeLocked(hoveredInteriorEdge) ? "pointer" : "default";
        return;
      }
      if (hoveredInteriorId) {
        canvas.style.cursor = canEditInterior(hoveredInteriorId) ? "grab" : "default";
        return;
      }
      canvas.style.cursor = "grab";
      return;
    }
    if (t === "pen" || t === "rect" || t === "circle" || t === "line" || t === "arrow" || t === "text" || t === "ruler") {
      canvas.style.cursor = "crosshair";
      return;
    }
    if (t === "eraser") {
      canvas.style.cursor = "not-allowed";
      return;
    }
    canvas.style.cursor = "default";
  }

  function applyTokenSizePreset(scale) {
    ui.tokenSpawnScale = scale;
    for (const [k, btn] of Object.entries(sizePresetButtons)) {
      if (!btn) continue;
      btn.classList.toggle("active", Math.abs(parseFloat(k) - scale) < 0.01);
    }
    if (selectedTokenId) {
      const tok = state.tokens.get(selectedTokenId);
      if (tok && canEditTokenLocal(tok)) {
        if (online) {
          tok.size_scale = scale;
          state.tokens.set(selectedTokenId, tok);
        }
        send("TOKEN_SET_SIZE", { id: selectedTokenId, size_scale: scale });
        if (online) requestRender();
      }
    }
    scheduleOfflineSave();
    refreshToolContextChecks();
  }

  function markInboundChange() {
    lastInboundChangeTs = Date.now();
  }

  // showResyncBadge, hideResyncBadge, ensureStaleWatchdog → static/canvas/sessions.js

  // renderPackGrid, loadPack, refreshPacks, assetFileExt, assetHasAlphaGuess, assetSizeBucket,
  // assetFilterSourceKey, assetOverrideKey, assetLegacyOverrideKeys, getAssetKindOverride,
  // persistAssetKindOverrides, setAssetKindOverride, assetKind, parseAssetSearch,
  // updateAssetSearchFromParsed, renderAssetSearchMeta, closeAssetKindMenus, assetSearchScore,
  // assetUsageKey, setAssetAsBackground, fitBackgroundToView, spawnOverlayAsset,
  // markAssetRecentlyUsed, currentAssetSessionId, resetAssetDiagnostics, recordAssetDiagnostic,
  // renderAssetDebugSummary, assetByUsageKey, assetSessionQuery, resetAssetSessionPackState,
  // refreshAssetSessionPackData, toggleSessionSharedPack, renderAssetSessionSharePanel,
  // refreshAssetFilterOptions, persistAssetFilterPresets, saveAssetFilterPreset,
  // syncAssetFilterControls, applyAssetFilterPresetForSource, getCurrentAssetFilterSnapshot,
  // persistAssetSavedSets, renderAssetSavedSets, applyAssetFilterSnapshot, saveAssetSet,
  // deleteSelectedAssetSet, renderAssetGrid, buildAssetFolderTree, renderAssetFolderTree,
  // refreshAssetsPanel, ensureAssetPanelReady, isAssetsTabActive, maybeLoadMoreAssets,
  // observeAssetThumbs, spawnPackToken, spawnPackAsset → static/canvas/assets.js
  // ws, wsConnectSeq, appInitialized, heartbeatTimer, staleSyncTimer,
  // lastInboundChangeTs, lastResyncRequestTs, resyncBadgeTimer,
  // seenInboundMutationSinceConnect, players, STATE_CHANGE_EVENTS,
  // WATCHDOG_MUTATION_EVENTS, state, cam, ui, draggingTokenId,
  // draggingAssetId, draggingShapeId, selectedTokenId, selectedAssetId,
  // selectedShapeId, assetDragOrigin, hoveredTokenId, dragOffset,
  // shapeDragOrigin, selectedTokenIds, draggingTokenIds, dragMoveStartWorld,
  // dragStartTokenPositions, marqueeSelectRect, isPanning, isShiftDown,
  // panStart, pointerCaptured, activeStroke, activeShapePreview,
  // activeRuler, erasingActive, lastEraseWorld, lastMoveSentAt,
  // MOVE_SEND_INTERVAL_MS, lastEraseSentAt, ERASE_SEND_INTERVAL_MS,
  // dragSpawn, dragSpawnWorld, dragSpawnOverCanvas, textPanelTargetShapeId,
  // colorPanelTargetShapeId, tokenMenuTokenId, mapCtxWorld, ctxSubHideTimer,
  // lastShapeTool, lastCtxClientPos, tooltipTimer, lastPartialRejectLogAt,
  // moveSeqCounter, activeDragMoveSeq, localMoveClientId, bgImage,
  // bgImageUrl, bgImageStatus, bgCache, tokenImageCache,
  // packAssetBlobUrlCache, packAssetBlobFetches, offlineSaveTimer,
  // lastOfflineEraseHistoryAt, offlineHistory, offlineFuture,
  // OFFLINE_HISTORY_LIMIT, OFFLINE_MUTATION_TYPES → static/canvas/state.js

  // playSessionState, pendingRoomMoveOffer, pendingArrivalNotice → static/canvas/sessions.js

  // terrainBrush, activePaintStroke → static/canvas/terrain.js
  // fogBrush, activeFogStroke → static/canvas/fog.js
  // packState, ASSET_*_KEY constants, loadAsset* functions, assetState, ASSET_THUMB_PLACEHOLDER,
  // assetThumbObserver, assetSearchDebounceTimer, assetSuppressCardClick, mapPreviewAsset,
  // mapPreviewSourceUrl, mapPreviewLoadSeq, expandedAssetFolders,
  // collectReferencedPackAssetIds, pruneUnusedPackBlobUrls → static/canvas/assets.js

  function myId() { return cidEl.value.trim(); }
  function isPrimaryGM() { return !!(state.gm_id && myId() === state.gm_id); }
  function isCoGM() { return state.co_gm_ids.includes(myId()); }
  function isGM() { return isPrimaryGM() || isCoGM(); }
  function ensureOfflineGm() {
    if (online) return;
    const cid = myId() || "player";
    if (!state.gm_id) state.gm_id = cid;
    if (!state.room_id) state.room_id = "offline";
    players.clear();
    players.add(cid);
    refreshGmUI();
  }

  // TERRAIN_MACRO_TILE, TERRAIN_MICRO_TILE, TERRAIN_BREAKUP_TILE, TERRAIN_STYLES, BIOME_PALETTES, terrain → static/canvas/terrain.js

  // normalizeBackgroundMode, normalizeTerrainSeed, normalizeTerrainStyle, randomTerrainSeed → static/canvas/terrain.js
  // terrainScaleFromGrid, mulberry32, shadeColor, colorWithAlpha, drawCloudShadows → static/canvas/terrain.js

  // buildTerrainPattern, ensureTerrain → static/canvas/terrain.js

  // TERRAIN_MASK_TILE_WORLD, TERRAIN_MASK_TILE_PX, terrainMasks, maskKey, worldToTile, worldToTilePx → static/canvas/terrain.js
  // getOrCreateMaskTile, drawBrushDab, applyStrokeToMasks, terrainMasks.applyStroke, terrainMasks.rebuildAllFromStrokes → static/canvas/terrain.js
  // ensureMaterialPattern, invalidateMaterialPatterns, viewWorldRect, drawTerrainOverlays → static/canvas/terrain.js
  // ─── End Terrain Mask Subsystem ────────────────────────────────────────────

  // FOG_MASK_TILE_WORLD, FOG_MASK_TILE_PX, fogMasks, fogMaskKey, resetFogTile,
  // getOrCreateFogTile, drawFogBrushDab, applyFogStrokeToMasks, drawFogOverlays
  // → static/canvas/fog.js

  // drawTerrainBackground → static/canvas/terrain.js

  function setBackgroundUrl(url) {
    const next = url || null;
    if (next === bgImageUrl) return;
    bgImageUrl = next;
    if (!next) {
      bgImage = null;
      bgImageStatus = "idle";
      requestRender();
      return;
    }
    if (bgCache.has(next)) {
      bgImage = bgCache.get(next);
      bgImageStatus = "ready";
      requestRender();
      return;
    }
    bgImageStatus = "loading";
    bgImage = null;
    const img = new Image();
    img.onload = () => {
      if (bgImageUrl === next) {
        bgImage = img;
        bgCache.set(next, img);
        bgImageStatus = "ready";
        requestRender();
      }
    };
    img.onerror = () => {
      bgImageStatus = "error";
      const msg = `Background failed to load: ${next}`;
      log(msg);
      toast(msg);
      requestRender();
    };
    img.src = next;
  }

  function applyBackgroundState(mode, url, seed, style) {
    state.background_url = url || null;
    state.background_mode = normalizeBackgroundMode(mode, state.background_url);
    state.terrain_seed = normalizeTerrainSeed(seed, state.terrain_seed || 1);
    state.terrain_style = normalizeTerrainStyle(style || state.terrain_style);
    if (state.background_mode === "url") setBackgroundUrl(state.background_url);
    else setBackgroundUrl(null);
    if (state.background_mode === "terrain") ensureTerrain(state.terrain_seed, state.terrain_style);
    invalidateMaterialPatterns();
  }

  // refreshTerrainBadge → static/canvas/terrain.js

  // clearPlaySessionState, applyPlaySessionState, refreshCurrentSessionState,
  // closeRoomMovePrompt, openRoomMovePrompt, setPendingRoomMoveOffer,
  // prepareForRoomTransition, executeIncomingRoomMove → static/canvas/sessions.js

  // renderSessionSummary, refreshGmUI, refreshRoomsPanel, refreshSnapshotsPanel → static/canvas/sessions.js

  // resizeCanvas, requestRender, screenToWorld, worldToScreen,
  // tokenRadiusWorld, assetHalfSizeWorld, hitTestToken, hitTestAsset,
  // shapeContainsPoint, hitTestShape, shapeSelectionBoxContainsPoint,
  // updateHoveredToken, drawBackground, drawGrid, drawStrokes,
  // drawOneShape, drawShapes, drawAssets, drawTokens, drawRuler,
  // drawDragSpawnGhost, drawMarqueeSelection, drawSelectionCountBadge,
  // render → static/canvas/render.js
  resizeCanvas();
  function snap(v) { return ui.snap ? Math.round(v / ui.gridSize) * ui.gridSize : v; }
  function snapInterior(v) { return Math.round(v / ui.gridSize) * ui.gridSize; }
  // clamp → static/canvas/utils.js
  // pointToSegmentDistance, parseMoveSeq → static/canvas/utils.js

  // send → static/canvas/network.js

  // makeId → static/canvas/utils.js

  function applyStateSync(s) {
    // Cancel local in-progress interactions so authoritative sync wins cleanly.
    isPanning = false;
    pointerCaptured = false;
    draggingTokenId = null;
    draggingAssetId = null;
    draggingTokenIds = [];
    dragMoveStartWorld = null;
    dragStartTokenPositions.clear();
    assetDragOrigin = null;
    marqueeSelectRect = null;
    draggingInteriorId = null;
    resizingInterior = null;
    dragSpawn = null;
    dragSpawnWorld = null;
    dragSpawnOverCanvas = false;
    activeStroke = null;
    activeShapePreview = null;
    activeInteriorPreview = null;
    activeInteriorAssist = null;
    interiorDragStart = null;
    interiorDragOrigin = null;
    hoveredInteriorId = null;
    hoveredInteriorEdge = null;
    hoveredInteriorResize = null;
    currentInteriorContextId = null;
    currentInteriorEdge = null;
    activeRuler = null;
    activePaintStroke = null;
    activeFogStroke = null;

    state.room_id = s.room_id;
    state.gm_id = s.gm_id;
    state.co_gm_ids = Array.isArray(s.co_gm_ids) ? s.co_gm_ids : [];
    state.allow_players_move = !!s.allow_players_move;
    state.allow_all_move = !!s.allow_all_move;
    state.lockdown = !!s.lockdown;
    state.world_tone = clamp(Number(s.world_tone ?? state.world_tone ?? 0.32), 0, 1);
    applyBackgroundState(s.background_mode, s.background_url, s.terrain_seed, s.terrain_style);
    state.layer_visibility = {
      grid: s.layer_visibility?.grid ?? true,
      drawings: s.layer_visibility?.drawings ?? true,
      shapes: s.layer_visibility?.shapes ?? true,
      assets: s.layer_visibility?.assets ?? true,
      tokens: s.layer_visibility?.tokens ?? true,
      interiors: s.layer_visibility?.interiors ?? true,
    };
    state.version = s.version || 0;

    state.tokens.clear();
    for (const [id, t] of Object.entries(s.tokens || {})) {
      const normalized = normalizePackBackedRecord(t);
      state.tokens.set(id, { ...normalized, badges: normalizedBadgeList(normalized?.badges) });
    }
    state.strokes.clear();
    for (const [id, st] of Object.entries(s.strokes || {})) state.strokes.set(id, normalizeStrokeRecord(st));
    state.shapes.clear();
    for (const [id, sh] of Object.entries(s.shapes || {})) state.shapes.set(id, normalizeShapeRecord(sh));
    state.assets.clear();
    for (const [id, a] of Object.entries(s.assets || {})) state.assets.set(id, normalizePackBackedRecord(a));
    state.interiors.clear();
    for (const [id, room] of Object.entries(s.interiors || {})) state.interiors.set(id, normalizeInteriorRecord(room));
    state.interior_edges.clear();
    for (const [id, edge] of Object.entries(s.interior_edges || {})) applyInteriorEdgeOverrideToState({ id, ...edge });
    state.draw_order = {
      strokes: Array.isArray(s.draw_order?.strokes) ? s.draw_order.strokes.filter((id) => state.strokes.has(id)) : [],
      shapes: Array.isArray(s.draw_order?.shapes) ? s.draw_order.shapes.filter((id) => state.shapes.has(id)) : [],
      assets: Array.isArray(s.draw_order?.assets) ? s.draw_order.assets.filter((id) => state.assets.has(id)) : [],
      interiors: Array.isArray(s.draw_order?.interiors) ? s.draw_order.interiors.filter((id) => state.interiors.has(id)) : [],
    };
    for (const id of state.strokes.keys()) if (!state.draw_order.strokes.includes(id)) state.draw_order.strokes.push(id);
    for (const id of state.shapes.keys()) if (!state.draw_order.shapes.includes(id)) state.draw_order.shapes.push(id);
    for (const id of state.assets.keys()) if (!state.draw_order.assets.includes(id)) state.draw_order.assets.push(id);
    for (const id of state.interiors.keys()) if (!state.draw_order.interiors.includes(id)) state.draw_order.interiors.push(id);
    markAssetOrderDirty();
    markInteriorsDirty();

    if (s.terrain_paint) {
      state.terrain_paint.strokes = s.terrain_paint.strokes || {};
      state.terrain_paint.undo_stack = s.terrain_paint.undo_stack || [];
      // materials are always client-defined; never overwrite from server
      invalidateMaterialPatterns();
      terrainMasks.rebuildAllFromStrokes();
    }
    state.fog_paint.enabled = !!s.fog_paint?.enabled;
    state.fog_paint.default_mode = s.fog_paint?.default_mode === "covered" ? "covered" : "clear";
    state.fog_paint.strokes = s.fog_paint?.strokes || {};
    state.fog_paint.undo_stack = s.fog_paint?.undo_stack || [];
    fogMasks.rebuildAllFromStrokes();

    if (selectedTokenId && !state.tokens.has(selectedTokenId)) selectedTokenId = null;
    if (selectedShapeId && !state.shapes.has(selectedShapeId)) selectedShapeId = null;
    if (selectedAssetId && !state.assets.has(selectedAssetId)) selectedAssetId = null;
    if (selectedInteriorId && !state.interiors.has(selectedInteriorId)) selectedInteriorId = null;
    setSelection(selectedIdsArray(), selectedTokenId);
    if (hoveredTokenId && !state.tokens.has(hoveredTokenId)) hoveredTokenId = null;
    if (hoveredInteriorId && !state.interiors.has(hoveredInteriorId)) hoveredInteriorId = null;
    players.add(myId());
    if (state.gm_id) players.add(state.gm_id);
    refreshFogPaintPanel();
    refreshGmUI();
    pruneUnusedPackBlobUrls();
    updateCanvasCursor();
    requestRender();
  }

  // toPlainObjectMap → static/canvas/utils.js

  function currentStateSnapshot() {
    return {
      room_id: state.room_id || "offline",
      gm_id: state.gm_id || myId() || "player",
      allow_players_move: !!state.allow_players_move,
      allow_all_move: !!state.allow_all_move,
      lockdown: !!state.lockdown,
      background_mode: state.background_mode || "solid",
      background_url: state.background_url || null,
      terrain_seed: Number(state.terrain_seed || 1),
      terrain_style: state.terrain_style || "grassland",
      world_tone: clamp(Number(state.world_tone ?? 0.32), 0, 1),
      layer_visibility: { ...state.layer_visibility },
      version: Number(state.version || 0),
      tokens: toPlainObjectMap(state.tokens),
      strokes: toPlainObjectMap(state.strokes),
      shapes: toPlainObjectMap(state.shapes),
      assets: toPlainObjectMap(state.assets),
      interiors: toPlainObjectMap(state.interiors),
      interior_edges: toPlainObjectMap(state.interior_edges),
      draw_order: {
        strokes: [...(state.draw_order?.strokes || [])],
        shapes: [...(state.draw_order?.shapes || [])],
        assets: [...(state.draw_order?.assets || [])],
        interiors: [...(state.draw_order?.interiors || [])],
      },
      terrain_paint: {
        materials: { ...(state.terrain_paint?.materials || {}) },
        strokes: { ...(state.terrain_paint?.strokes || {}) },
        undo_stack: [...(state.terrain_paint?.undo_stack || [])],
      },
      fog_paint: {
        enabled: !!state.fog_paint?.enabled,
        default_mode: state.fog_paint?.default_mode === "covered" ? "covered" : "clear",
        strokes: { ...(state.fog_paint?.strokes || {}) },
        undo_stack: [...(state.fog_paint?.undo_stack || [])],
      },
    };
  }

  function saveOfflineStateNow() {
    try {
      const payload = {
        state: currentStateSnapshot(),
        ui: {
          snap: !!snapEl.checked,
          showGrid: !!showGridEl.checked,
          gridSize: String(gridEl.value || "50"),
          feetPerSq: String(feetPerSqEl.value || "5"),
          color: String(colorEl.value || "#ffffff"),
          size: String(sizeEl.value || "3"),
          tool: String(toolEl.value || "move"),
          tokenSpawnScale: Number(ui.tokenSpawnScale || 1),
        },
      };
      localStorage.setItem(OFFLINE_STATE_KEY, JSON.stringify(payload));
    } catch (e) {}
  }

  function scheduleOfflineSave() {
    if (online) return;
    if (offlineSaveTimer) clearTimeout(offlineSaveTimer);
    offlineSaveTimer = setTimeout(() => {
      offlineSaveTimer = null;
      saveOfflineStateNow();
    }, 1000);
  }

  function pushOfflineHistory() {
    try {
      offlineHistory.push(JSON.stringify(currentStateSnapshot()));
      if (offlineHistory.length > OFFLINE_HISTORY_LIMIT) offlineHistory.shift();
      offlineFuture.length = 0;
    } catch (e) {}
  }

  function restoreOfflineState() {
    try {
      const raw = localStorage.getItem(OFFLINE_STATE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.state) return false;
      applyStateSync(parsed.state);
      const uiState = parsed.ui || {};
      snapEl.checked = !!uiState.snap;
      showGridEl.checked = !!uiState.showGrid;
      gridEl.value = String(uiState.gridSize || gridEl.value || "50");
      feetPerSqEl.value = String(uiState.feetPerSq || feetPerSqEl.value || "5");
      colorEl.value = String(uiState.color || colorEl.value || "#ffffff");
      sizeEl.value = String(uiState.size || sizeEl.value || "3");
      if (typeof uiState.tokenSpawnScale === "number") ui.tokenSpawnScale = clamp(uiState.tokenSpawnScale, 0.25, 4);
      if (uiState.tool) toolEl.value = String(uiState.tool);
      refreshUI();
      refreshToolButtons();
      return true;
    } catch (e) {
      return false;
    }
  }

  // localStrokeHitsCircle, localShapeHitsCircle → static/canvas/utils.js

  function localTokenHitsCircle(token, cx, cy, r) {
    const tx = Number(token?.x || 0);
    const ty = Number(token?.y || 0);
    const tr = tokenRadiusWorld(token);
    return Math.hypot(cx - tx, cy - ty) <= (tr + r);
  }

  function applyLocalEvent(type, payload = {}) {
    if (type === "UNDO") {
      if (!offlineHistory.length) return;
      try {
        offlineFuture.push(JSON.stringify(currentStateSnapshot()));
        const prev = offlineHistory.pop();
        applyStateSync(JSON.parse(prev));
      } catch (e) {}
      return;
    }
    if (type === "REDO") {
      if (!offlineFuture.length) return;
      try {
        offlineHistory.push(JSON.stringify(currentStateSnapshot()));
        const next = offlineFuture.pop();
        applyStateSync(JSON.parse(next));
      } catch (e) {}
      return;
    }

    if (OFFLINE_MUTATION_TYPES.has(type)) {
      if (type === "ERASE_AT") {
        const now = Date.now();
        if (now - lastOfflineEraseHistoryAt > 600) {
          lastOfflineEraseHistoryAt = now;
          pushOfflineHistory();
        }
      } else if (type !== "TOKEN_MOVE" || !!payload.commit) {
        pushOfflineHistory();
      }
    }

    if (type === "ROOM_SETTINGS") {
      if ("allow_players_move" in payload) state.allow_players_move = !!payload.allow_players_move;
      if ("allow_all_move" in payload) state.allow_all_move = !!payload.allow_all_move;
      if ("lockdown" in payload) state.lockdown = !!payload.lockdown;
      if ("world_tone" in payload) state.world_tone = clamp(Number(payload.world_tone ?? state.world_tone ?? 0.32), 0, 1);
      if ("background_mode" in payload || "background_url" in payload || "terrain_seed" in payload || "terrain_style" in payload) {
        applyBackgroundState(
          ("background_mode" in payload) ? payload.background_mode : state.background_mode,
          ("background_url" in payload) ? payload.background_url : state.background_url,
          ("terrain_seed" in payload) ? payload.terrain_seed : state.terrain_seed,
          ("terrain_style" in payload) ? payload.terrain_style : state.terrain_style,
        );
      }
      if ("layer_visibility" in payload && payload.layer_visibility) {
        state.layer_visibility = { ...state.layer_visibility, ...payload.layer_visibility };
      }
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "INTERIOR_ADD") {
      const room = normalizeInteriorRecord(payload);
      if (room.id) {
        state.interiors.set(room.id, room);
        state.draw_order.interiors = state.draw_order.interiors.filter((id) => id !== room.id);
        state.draw_order.interiors.push(room.id);
        markInteriorsDirty();
      }
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "INTERIOR_UPDATE") {
      const current = state.interiors.get(payload?.id) || {};
      const room = normalizeInteriorRecord({ ...current, ...payload });
      if (room.id) {
        state.interiors.set(room.id, room);
        if (!state.draw_order.interiors.includes(room.id)) state.draw_order.interiors.push(room.id);
        markInteriorsDirty();
      }
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "INTERIOR_DELETE") {
      const id = String(payload?.id || "");
      state.interiors.delete(id);
      state.draw_order.interiors = state.draw_order.interiors.filter((x) => x !== id);
      if (selectedInteriorId === id) selectedInteriorId = null;
      if (currentInteriorContextId === id) currentInteriorContextId = null;
      if (draggingInteriorId === id) draggingInteriorId = null;
      if (resizingInterior?.id === id) resizingInterior = null;
      if (activeInteriorAssist?.targetRoomId === id) activeInteriorAssist = null;
      if (hoveredInteriorId === id) hoveredInteriorId = null;
      if (hoveredInteriorResize?.id === id) hoveredInteriorResize = null;
      for (const [edgeId, edge] of state.interior_edges.entries()) {
        if (edge.room_a_id === id || edge.room_b_id === id) state.interior_edges.delete(edgeId);
      }
      if (hoveredInteriorEdge && (hoveredInteriorEdge.room_a_id === id || hoveredInteriorEdge.room_b_id === id)) hoveredInteriorEdge = null;
      markInteriorsDirty();
      updateCanvasCursor();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "INTERIOR_SET_LOCK") {
      const id = String(payload?.id || "");
      const room = state.interiors.get(id);
      if (room) {
        room.locked = !!payload.locked;
        state.interiors.set(id, room);
        markInteriorsDirty();
      }
      updateCanvasCursor();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "INTERIOR_EDGE_SET") {
      applyInteriorEdgeOverrideToState(payload);
      markInteriorsDirty();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "TOKEN_DELETE") {
      state.tokens.delete(payload.id);
      if (selectedTokenId === payload.id) selectedTokenId = null;
      if (hoveredTokenId === payload.id) hoveredTokenId = null;
      refreshGmUI();
      pruneUnusedPackBlobUrls();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "TOKEN_MOVE") {
      const p = payload;
      const t = state.tokens.get(p.id);
      if (t) {
        t.x = Number(p.x ?? t.x);
        t.y = Number(p.y ?? t.y);
        state.tokens.set(p.id, t);
      }
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "TOKEN_ASSIGN") {
      const t = state.tokens.get(payload.id);
      if (t) {
        t.owner_id = payload.owner_id ?? null;
        state.tokens.set(payload.id, t);
      }
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "TOKEN_BADGE_TOGGLE") {
      const t = state.tokens.get(payload.id);
      if (t) {
        setTokenBadgeLocal(payload.id, payload.badge, payload.enabled ?? null);
      }
      refreshTokenMenuBadgeButtons();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "STROKE_ADD") {
      const p = payload;
      if (p?.id) {
        state.strokes.set(p.id, normalizeStrokeRecord(p));
        state.draw_order.strokes = state.draw_order.strokes.filter((id) => id !== p.id);
        state.draw_order.strokes.push(p.id);
      }
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "STROKE_DELETE") {
      const ids = payload?.ids || [];
      for (const id of ids) {
        state.strokes.delete(id);
        state.draw_order.strokes = state.draw_order.strokes.filter((x) => x !== id);
      }
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "SHAPE_ADD") {
      const p = payload;
      if (p?.id) {
        const next = normalizeShapeRecord({ ...p });
        if (!next.creator_id) next.creator_id = myId();
        state.shapes.set(p.id, next);
        state.draw_order.shapes = state.draw_order.shapes.filter((id) => id !== p.id);
        state.draw_order.shapes.push(p.id);
      }
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "SHAPE_UPDATE") {
      const p = payload;
      if (p?.id) {
        const current = state.shapes.get(p.id) || {};
        const next = { ...current, ...p };
        if (!next.creator_id) next.creator_id = myId();
        state.shapes.set(p.id, next);
        if (!state.draw_order.shapes.includes(p.id)) state.draw_order.shapes.push(p.id);
      }
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "SHAPE_DELETE") {
      const sid = payload?.id;
      state.shapes.delete(sid);
      state.draw_order.shapes = state.draw_order.shapes.filter((x) => x !== sid);
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "ASSET_INSTANCE_CREATE") {
      const p = payload;
      if (p?.id) {
        const next = normalizePackBackedRecord(p);
        if (!next.creator_id) next.creator_id = myId();
        state.assets.set(p.id, next);
        state.draw_order.assets = state.draw_order.assets.filter((id) => id !== p.id);
        state.draw_order.assets.push(p.id);
        markAssetOrderDirty();
      }
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "ASSET_INSTANCE_UPDATE") {
      const p = payload;
      if (p?.id) {
        const current = state.assets.get(p.id) || {};
        const next = normalizePackBackedRecord({ ...current, ...p });
        if (!next.creator_id) next.creator_id = myId();
        state.assets.set(p.id, next);
        if (!state.draw_order.assets.includes(p.id)) state.draw_order.assets.push(p.id);
        markAssetOrderDirty();
      }
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "ASSET_INSTANCE_DELETE") {
      const id = payload?.id;
      state.assets.delete(id);
      state.draw_order.assets = state.draw_order.assets.filter((x) => x !== id);
      if (selectedAssetId === id) selectedAssetId = null;
      if (draggingAssetId === id) {
        draggingAssetId = null;
        assetDragOrigin = null;
      }
      markAssetOrderDirty();
      pruneUnusedPackBlobUrls();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "ERASE_AT") {
      const x = Number(payload.x || 0);
      const y = Number(payload.y || 0);
      const r = Math.max(1, Number(payload.r || 14));
      const strokeIds = [];
      const shapeIds = [];
      const tokenIds = [];
      for (const [id, s] of state.strokes.entries()) {
        if (localStrokeHitsCircle(s, x, y, r)) strokeIds.push(id);
      }
      for (const [id, sh] of state.shapes.entries()) {
        if (localShapeHitsCircle(sh, x, y, r)) shapeIds.push(id);
      }
      for (const [id, tok] of state.tokens.entries()) {
        if (localTokenHitsCircle(tok, x, y, r)) tokenIds.push(id);
      }
      for (const id of strokeIds) {
        state.strokes.delete(id);
        state.draw_order.strokes = state.draw_order.strokes.filter((v) => v !== id);
      }
      for (const id of shapeIds) {
        state.shapes.delete(id);
        state.draw_order.shapes = state.draw_order.shapes.filter((v) => v !== id);
      }
      for (const id of tokenIds) {
        state.tokens.delete(id);
        selectedTokenIds.delete(id);
        if (selectedTokenId === id) selectedTokenId = null;
        if (hoveredTokenId === id) hoveredTokenId = null;
      }
      if (!selectedTokenId && selectedTokenIds.size) selectedTokenId = Array.from(selectedTokenIds)[0];
      if (strokeIds.length || shapeIds.length || tokenIds.length) {
        refreshGmUI();
        pruneUnusedPackBlobUrls();
        requestRender();
        scheduleOfflineSave();
      }
      return;
    }

    if (type === "TOKEN_CREATE") {
      const p = payload;
      if (p?.id) {
        const normalized = normalizePackBackedRecord({ ...(state.tokens.get(p.id) || {}), ...p });
        state.tokens.set(p.id, { ...normalized, badges: normalizedBadgeList(normalized?.badges) });
      }
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }
    if (type === "TOKEN_RENAME") {
      const p = payload;
      const t = state.tokens.get(p.id);
      if (t) {
        t.name = p.name || t.name;
        state.tokens.set(p.id, t);
      }
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }
    if (type === "TOKEN_SET_SIZE") {
      const p = payload;
      const t = state.tokens.get(p.id);
      if (t) {
        t.size_scale = clamp(Number(p.size_scale ?? t.size_scale ?? 1), 0.25, 4);
        state.tokens.set(p.id, t);
      }
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }
    if (type === "TOKEN_SET_LOCK") {
      const p = payload;
      const t = state.tokens.get(p.id);
      if (t) {
        t.locked = !!p.locked;
        state.tokens.set(p.id, t);
      }
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }
    if (type === "STROKE_SET_LOCK") {
      const p = payload;
      const s = state.strokes.get(p.id);
      if (s) {
        s.locked = !!p.locked;
        state.strokes.set(p.id, s);
      }
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }
    if (type === "SHAPE_SET_LOCK") {
      const p = payload;
      const s = state.shapes.get(p.id);
      if (s) {
        s.locked = !!p.locked;
        state.shapes.set(p.id, s);
      }
      refreshGmUI();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "TERRAIN_STROKE_ADD") {
      const p = payload;
      if (p?.id) {
        if (!state.terrain_paint.strokes[p.id]) {
          state.terrain_paint.strokes[p.id] = p;
          terrainMasks.applyStroke(p);
        }
        if (!state.terrain_paint.undo_stack.includes(p.id)) {
          state.terrain_paint.undo_stack.push(p.id);
        }
      }
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "TERRAIN_STROKE_UNDO") {
      const ids = payload?.ids || [];
      for (const id of ids) {
        delete state.terrain_paint.strokes[id];
        state.terrain_paint.undo_stack = state.terrain_paint.undo_stack.filter((x) => x !== id);
      }
      if (ids.length) {
        terrainMasks.rebuildAllFromStrokes();
      }
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "FOG_SET_ENABLED") {
      state.fog_paint.enabled = !!payload?.enabled;
      state.fog_paint.default_mode = payload?.default_mode === "covered" ? "covered" : "clear";
      fogMasks.rebuildAllFromStrokes();
      refreshFogPaintPanel();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "FOG_RESET") {
      state.fog_paint.enabled = !!payload?.enabled;
      state.fog_paint.default_mode = payload?.default_mode === "covered" ? "covered" : "clear";
      state.fog_paint.strokes = {};
      state.fog_paint.undo_stack = [];
      fogMasks.rebuildAllFromStrokes();
      refreshFogPaintPanel();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "FOG_STROKE_ADD") {
      const p = payload;
      if (p?.id) {
        if (!state.fog_paint.strokes[p.id]) {
          state.fog_paint.strokes[p.id] = p;
          fogMasks.applyStroke(p);
        }
        if (!state.fog_paint.undo_stack.includes(p.id)) state.fog_paint.undo_stack.push(p.id);
        state.fog_paint.enabled = true;
      }
      refreshFogPaintPanel();
      requestRender();
      scheduleOfflineSave();
      return;
    }

    if (type === "COGM_ADD") {
      const tid = payload?.target_id;
      if (tid && !state.co_gm_ids.includes(tid)) state.co_gm_ids.push(tid);
      refreshGmUI();
      scheduleOfflineSave();
      return;
    }

    if (type === "COGM_REMOVE") {
      const tid = payload?.target_id;
      if (tid) state.co_gm_ids = state.co_gm_ids.filter((x) => x !== tid);
      refreshGmUI();
      scheduleOfflineSave();
      return;
    }
  }

  // clearLocalRoomView, switchRoom → static/canvas/sessions.js

  // connectWS (+ send, onmessage dispatch) → static/canvas/network.js

  const connectBtnEl = document.getElementById("connect");
  if (connectBtnEl) connectBtnEl.onclick = () => connectWS(false);

  const spawnBtnEl = document.getElementById("spawn");
  if (spawnBtnEl) spawnBtnEl.onclick = () => {
    dragSpawn = {
      kind: "token",
      name: "Token",
      color: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"),
      image_url: null,
      size_scale: ui.tokenSpawnScale,
    };
    dragSpawnWorld = null;
    dragSpawnOverCanvas = false;
    updateCanvasCursor();
    requestRender();
  };

  const undoBtnEl = document.getElementById("undo");
  if (undoBtnEl) undoBtnEl.onclick = () => send("UNDO", {});
  const redoBtnEl = document.getElementById("redo");
  if (redoBtnEl) redoBtnEl.onclick = () => send("REDO", {});

  const centerViewBtnEl = document.getElementById("centerViewBtn");
  if (centerViewBtnEl) centerViewBtnEl.onclick = () => {
    cam.x = (canvas.clientWidth || canvas.width) / 2;
    cam.y = (canvas.clientHeight || canvas.height) / 2;
    requestRender();
  };

  if (drawerToggle) drawerToggle.onclick = () => drawer.classList.toggle("hidden");
  if (drawerClose) drawerClose.onclick = () => drawer.classList.add("hidden");
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activateDrawerTab(btn.dataset.tab, true);
      if (btn.dataset.tab === "tokens") refreshPacks();
    });
  });
  try {
    mountDrawerPanels();
  } catch (e) {
    console.error("mountDrawerPanels failed", e);
    log(`UI INIT ERROR: ${e?.message || e}`);
    toast(`UI init error: ${e?.message || e}`);
  }
  [toolBtnMove, toolBtnPen, toolBtnShape, toolBtnText, toolBtnErase, toolBtnRuler, toolBtnInterior, toolBtnTerrainPaint, toolBtnFogPaint].forEach((btn) => {
    if (!btn) return;
    btn.onclick = () => setTool(btn.dataset.tool);
    btn.addEventListener("mouseenter", () => showTooltipFor(btn));
    btn.addEventListener("mouseleave", hideTooltip);
  });

  // refreshTerrainPaintPanel → static/canvas/terrain.js
  initTerrainPanelBindings();
  // refreshFogPaintPanel, fog panel event bindings → static/canvas/fog.js
  initFogPanelBindings();
  initAssetLibBindings();
  allCtxMenus.forEach((menuEl) => {
    if (!menuEl) return;
    menuEl.addEventListener("click", (e) => {
      const item = e.target.closest(".ctx-item");
      if (!item || !menuEl.contains(item)) return;
      const sub = String(item.dataset.sub || "").trim();
      if (sub) {
        const subEl = document.getElementById(`mapCtx-${sub}`);
        if (subEl) showSubMenu(subEl, item);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const action = String(item.dataset.action || "").trim();
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      handleCtxAction(action);
      hideAllCtx();
    });
    menuEl.addEventListener("mouseenter", (e) => {
      const item = e.target.closest(".ctx-item");
      if (!item || !menuEl.contains(item)) return;
      const sub = String(item.dataset.sub || "").trim();
      if (!sub) {
        if (menuEl === mapCtx) scheduleCtxSubHide();
        return;
      }
      const subEl = document.getElementById(`mapCtx-${sub}`);
      if (subEl) showSubMenu(subEl, item);
    }, true);
    menuEl.addEventListener("mouseleave", () => {
      if (menuEl === mapCtx || menuEl === mapCtxBg || menuEl === mapCtxLayers || menuEl === mapCtxClear) {
        scheduleCtxSubHide();
      }
    });
    menuEl.addEventListener("mouseenter", () => {
      if (menuEl === mapCtxBg || menuEl === mapCtxLayers || menuEl === mapCtxClear) {
        clearCtxSubHideTimer();
      }
    });
  });
  if (interiorEdgeMenu) {
    interiorEdgeMenu.addEventListener("click", (e) => {
      const item = e.target.closest("[data-edge-mode]");
      if (!item || !currentInteriorEdge || !isGM()) return;
      const mode = String(item.dataset.edgeMode || "").trim();
      if (!mode) return;
      send("INTERIOR_EDGE_SET", {
        id: makeId(),
        edge_key: currentInteriorEdge.edge_key,
        room_a_id: currentInteriorEdge.room_a_id,
        room_b_id: currentInteriorEdge.room_b_id,
        mode,
      });
      hideAllCtx();
      requestRender();
    });
  }
  const applyTextDraft = () => {
    const v = String(toolTextInput?.value || "").trim();
    if (textPanelTargetShapeId) {
      const sh = state.shapes.get(textPanelTargetShapeId);
      if (sh && sh.type === "text" && canEditShapeLocal(sh)) {
        const next = v || sh.text || "Text";
        state.shapes.set(textPanelTargetShapeId, { ...sh, text: next });
        send("SHAPE_UPDATE", { id: textPanelTargetShapeId, text: next, commit: true });
      }
    } else if (pendingTextPlacement) {
      ui.textDraft = v;
      createTextShapeAt(pendingTextPlacement, v);
    } else {
      ui.textDraft = v;
    }
    pendingTextPlacement = null;
    textPanelTargetShapeId = null;
    refreshToolContextChecks();
  };
  if (toolTextApply) toolTextApply.addEventListener("click", () => {
    applyTextDraft();
    hideToolPanels();
  });
  if (toolColorPicker) {
    const applyToolColor = () => {
      const next = String(toolColorPicker.value || "#ffffff");
      if (colorPanelTargetShapeId) {
        const sh = state.shapes.get(colorPanelTargetShapeId);
        if (sh && canEditShapeLocal(sh)) {
          state.shapes.set(colorPanelTargetShapeId, { ...sh, color: next });
          send("SHAPE_UPDATE", { id: colorPanelTargetShapeId, color: next, commit: true });
        }
      } else {
        colorEl.value = next;
      }
      refreshToolContextChecks();
      requestRender();
    };
    toolColorPicker.addEventListener("input", applyToolColor);
    toolColorPicker.addEventListener("change", applyToolColor);
  }
  if (toolSizeSlider) {
    const applyToolSize = () => {
      const min = Number(toolSizeSlider.min || "1");
      const max = Number(toolSizeSlider.max || "30");
      const next = clamp(Number(toolSizeSlider.value || min), min, max);
      toolSizeValue.textContent = String(Math.round(next));
      if (sizePanelMode === "text") {
        if (sizePanelTargetShapeId) {
          const sh = state.shapes.get(sizePanelTargetShapeId);
          if (sh && sh.type === "text" && canEditShapeLocal(sh)) {
            state.shapes.set(sizePanelTargetShapeId, { ...sh, font_size: next });
            send("SHAPE_UPDATE", { id: sizePanelTargetShapeId, font_size: next, commit: true });
          }
        } else {
          ui.textFontSize = next;
        }
      } else {
        sizeEl.value = String(next);
      }
      refreshToolContextChecks();
      requestRender();
    };
    toolSizeSlider.addEventListener("input", applyToolSize);
    toolSizeSlider.addEventListener("change", applyToolSize);
  }
  if (toolTextInput) {
    toolTextInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyTextDraft();
        hideToolPanels();
      }
    });
  }
  window.addEventListener("error", (e) => {
    const msg = e?.message || "unknown";
    log(`JS ERROR: ${msg}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const msg = e?.reason?.message || String(e?.reason || "unknown");
    log(`PROMISE ERROR: ${msg}`);
  });
  [document.getElementById("spawn"), document.getElementById("undo"), document.getElementById("redo")].forEach((btn) => {
    if (!btn) return;
    btn.addEventListener("mouseenter", () => showTooltipFor(btn));
    btn.addEventListener("mouseleave", hideTooltip);
  });
  // Session/room/GM panel and layer bindings → initSessionBindings() in static/canvas/sessions.js
  initSessionBindings();
  updateSessionPill();
  setLogCollapsed(false);
  if (logToggleEl && logWrapEl) {
    logToggleEl.addEventListener("click", () => {
      setLogCollapsed(!logWrapEl.classList.contains("collapsed"));
    });
  }
  Object.entries(sizePresetButtons).forEach(([key, btn]) => {
    if (!btn) return;
    btn.addEventListener("click", () => {
      applyTokenSizePreset(parseFloat(key));
    });
  });
  if (tokenMenuRenameBtn) tokenMenuRenameBtn.addEventListener("click", () => {
    const tokenId = tokenMenuTargetId();
    const token = tokenId ? state.tokens.get(tokenId) : null;
    if (!token || !canEditTokenLocal(token)) return;
    const next = prompt("Rename token:", token.name || "");
    if (next == null) return;
    const name = String(next).trim();
    if (!name || name === token.name) return;
    send("TOKEN_RENAME", { id: tokenId, name });
    closeTokenMenu();
  });
  if (tokenMenuResizeBtn) tokenMenuResizeBtn.addEventListener("click", () => {
    const tokenId = tokenMenuTargetId();
    const token = tokenId ? state.tokens.get(tokenId) : null;
    if (!token || !canEditTokenLocal(token)) return;
    const next = prompt("Token size: S, M, L, Huge, or a scale from 0.25 to 4.", String(Number(token.size_scale || 1)));
    if (next == null) return;
    const scale = parseTokenSizeInput(next);
    if (scale == null) {
      log("Resize cancelled: invalid size.");
      return;
    }
    selectedTokenId = tokenId;
    applyTokenSizePreset(scale);
    closeTokenMenu();
  });
  if (tokenMenuAssignBtn) tokenMenuAssignBtn.addEventListener("click", () => {
    const tokenId = tokenMenuTargetId();
    const token = tokenId ? state.tokens.get(tokenId) : null;
    if (!token || !isGM()) return;
    const options = Array.from(new Set(Array.from(players).filter(Boolean))).sort();
    const next = prompt(
      [
        "Assign token to player id.",
        "Leave blank to clear assignment.",
        options.length ? `Online players: ${options.join(", ")}` : "No online players detected.",
      ].join("\n"),
      token.owner_id || "",
    );
    if (next == null) return;
    send("TOKEN_ASSIGN", { id: tokenId, owner_id: String(next).trim() || null });
    closeTokenMenu();
  });
  if (tokenMenuLockBtn) tokenMenuLockBtn.addEventListener("click", () => {
    const tokenId = tokenMenuTargetId();
    const token = tokenId ? state.tokens.get(tokenId) : null;
    if (!token || !isGM()) return;
    send("TOKEN_SET_LOCK", { id: tokenId, locked: !token.locked });
    closeTokenMenu();
  });
  if (tokenMenuGroupBtn) tokenMenuGroupBtn.addEventListener("click", () => {
    if (!isGM()) return;
    groupSelectedTokens();
    closeTokenMenu();
  });
  if (tokenMenuUngroupBtn) tokenMenuUngroupBtn.addEventListener("click", () => {
    if (!isGM()) return;
    ungroupSelectedTokens();
    closeTokenMenu();
  });
  if (tokenMenuDeleteBtn) tokenMenuDeleteBtn.addEventListener("click", () => {
    const tokenIds = selectedIdsArray().length ? selectedIdsArray() : [tokenMenuTargetId()].filter(Boolean);
    for (const id of tokenIds) {
      const token = state.tokens.get(id);
      if (token && canDeleteTokenLocal(token)) send("TOKEN_DELETE", { id });
    }
    closeTokenMenu();
  });
  refreshToolButtons();
  updateCanvasCursor();
  (async () => {
    let user = null;
    try {
      user = await loadMe();
      if (!restoreOfflineState()) {
        applyStateSync(currentStateSnapshot());
      }
      ensureOfflineGm();
      refreshSessionModalAuth();
      updateSessionPill();
      saveOfflineStateNow();
      ensureStaleWatchdog();
    } finally {
      appInitialized = true;
    }
    await finishCanvasAuthFlow(user, { promptWhenNoRoom: !user?.username });
  })();

  function refreshUI() {
    ui.snap = !!snapEl.checked;
    ui.gridSize = clamp(parseInt(gridEl.value || "50", 10), 10, 300);
    ui.showGrid = !!showGridEl.checked;
    ui.feetPerSq = clamp(parseFloat(feetPerSqEl.value || "5"), 1, 100);
    if (typeof refreshTerrainPaintPanel === "function") refreshTerrainPaintPanel();
    requestRender();
    scheduleOfflineSave();
  }
  snapEl.addEventListener("change", refreshUI);
  showGridEl.addEventListener("change", refreshUI);
  gridEl.addEventListener("change", refreshUI);
  feetPerSqEl.addEventListener("change", refreshUI);
  refreshUI();
  refreshGmUI();
  snapshotRoomLabelEl.textContent = roomEl.value.trim();
  refreshPacks();

  function tool() { return toolEl.value; }
  function isShapeTool(v) { return v === "rect" || v === "circle" || v === "line" || v === "arrow"; }
  function refreshToolButtons() {
    const t = tool();
    toolBtnMove.classList.toggle("active", t === "move");
    toolBtnPen.classList.toggle("active", t === "pen");
    toolBtnShape.classList.toggle("active", isShapeTool(t));
    toolBtnText.classList.toggle("active", t === "text");
    toolBtnErase.classList.toggle("active", t === "eraser");
    toolBtnRuler.classList.toggle("active", t === "ruler");
    if (toolBtnInterior) toolBtnInterior.classList.toggle("active", t === "interior");
    if (toolBtnTerrainPaint) toolBtnTerrainPaint.classList.toggle("active", t === "terrain_paint");
    if (toolBtnFogPaint) toolBtnFogPaint.classList.toggle("active", t === "fog_paint");
    if (selectModeLabelEl) selectModeLabelEl.classList.toggle("hidden", t !== "move");
    if (terrainPaintPanel) {
      if (t === "terrain_paint") {
        terrainPaintPanel.classList.remove("hidden");
        positionTerrainPaintPanel();
        refreshTerrainPaintPanel();
      } else {
        terrainPaintPanel.classList.add("hidden");
      }
    }
    if (fogPaintPanel) {
      if (t === "fog_paint") {
        fogPaintPanel.classList.remove("hidden");
        positionFogPaintPanel();
        refreshFogPaintPanel();
      } else {
        fogPaintPanel.classList.add("hidden");
      }
    }
  }

  // positionTerrainPaintPanel → static/canvas/terrain.js
  // positionFogPaintPanel → static/canvas/fog.js
  function setTool(next) {
    if ((next === "terrain_paint" || next === "fog_paint" || next === "interior") && !isGM()) return;
    const prev = tool();
    if (prev === "terrain_paint" && next !== "terrain_paint" && activePaintStroke && isGM()) {
      commitActiveTerrainStroke();
    }
    if (prev === "fog_paint" && next !== "fog_paint" && activeFogStroke && isGM()) {
      commitActiveFogStroke();
    }
    if (next === "shape") {
      const restore = isShapeTool(toolEl.value) ? toolEl.value : lastShapeTool;
      toolEl.value = restore;
      if (!isShapeTool(toolEl.value)) toolEl.value = "rect";
    } else {
      toolEl.value = next;
      if (isShapeTool(next) && toolEl.value !== next) {
        // unknown shape type — fall back so tool state stays valid
        toolEl.value = "rect";
        lastShapeTool = "rect";
      } else if (isShapeTool(next)) {
        lastShapeTool = next;
      }
    }
    const current = tool();
    if (current !== prev) {
      if (current === "move") flashToolActivate(toolBtnMove);
      else if (current === "pen") flashToolActivate(toolBtnPen);
      else if (isShapeTool(current)) flashToolActivate(toolBtnShape);
      else if (current === "text") flashToolActivate(toolBtnText);
      else if (current === "eraser") flashToolActivate(toolBtnErase);
      else if (current === "ruler") flashToolActivate(toolBtnRuler);
      else if (current === "interior" && toolBtnInterior) flashToolActivate(toolBtnInterior);
      else if (current === "terrain_paint" && toolBtnTerrainPaint) flashToolActivate(toolBtnTerrainPaint);
      else if (current === "fog_paint" && toolBtnFogPaint) flashToolActivate(toolBtnFogPaint);
    }
    refreshToolButtons();
    updateCanvasCursor();
    scheduleOfflineSave();
  }
  function brushColor() { return colorEl.value; }
  function brushSize() { return clamp(parseFloat(sizeEl.value || "3"), 1, 30); }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift") isShiftDown = true;
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    const isTyping = tag === "input" || tag === "textarea" || tag === "select" || (e.target && e.target.isContentEditable);
    if (e.key === "Escape" && !sessionModal.classList.contains("hidden")) {
      closeSessionModal();
      return;
    }
    if (e.key === "Escape" && mapPreviewModal && !mapPreviewModal.classList.contains("hidden")) {
      closeMapPreview();
      return;
    }
    if (!isTyping) {
      const k = e.key.toLowerCase();
      if (k === "v") { setTool("move"); e.preventDefault(); return; }
      if (k === "p") { setTool("pen"); e.preventDefault(); return; }
      if (k === "s") { setTool("shape"); e.preventDefault(); return; }
      if (k === "t") { setTool("text"); e.preventDefault(); return; }
      if (k === "e") { setTool("eraser"); e.preventDefault(); return; }
      if (k === "r") { setTool("ruler"); e.preventDefault(); return; }
      if (k === "i" && isGM()) { setTool("interior"); e.preventDefault(); return; }
      if (k === "f" && isGM()) { setTool("terrain_paint"); e.preventDefault(); return; }
      if (k === "h" && isGM()) { setTool("fog_paint"); e.preventDefault(); return; }
      if (k === "z" && e.ctrlKey && tool() === "terrain_paint" && isGM()) {
        send("TERRAIN_STROKE_UNDO", { count: 1 });
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Tab" && !isTyping) {
      e.preventDefault();
      drawer.classList.toggle("hidden");
      return;
    }
    if (e.key === "Escape") {
      hideAllCtx();
      hideToolPanels();
      hideTooltip();
    }
    if (e.key === "Escape" && tokenMenuEl.style.display === "block") {
      closeTokenMenu();
      return;
    }
    if (e.key === "Escape" && dragSpawn) {
      dragSpawn = null;
      dragSpawnWorld = null;
      dragSpawnOverCanvas = false;
      requestRender();
      return;
    }
    if (e.key === "Escape" && (draggingInteriorId || resizingInterior || activeInteriorPreview)) {
      draggingInteriorId = null;
      resizingInterior = null;
      activeInteriorPreview = null;
      activeInteriorAssist = null;
      interiorDragStart = null;
      interiorDragOrigin = null;
      updateCanvasCursor();
      requestRender();
      return;
    }
    if (!isTyping && e.key.toLowerCase() === "d" && selectedTokenId && isGM()) {
      if (online) {
        setTokenBadgeLocal(selectedTokenId, "downed", null);
        refreshTokenMenuBadgeButtons();
        requestRender();
      }
      sendTokenBadgeToggle(selectedTokenId, "downed", null);
      e.preventDefault();
      return;
    }
    if (!isTyping && e.key.toLowerCase() === "g" && isGM()) {
      groupSelectedTokens();
      e.preventDefault();
      return;
    }
    if (!isTyping && e.key.toLowerCase() === "u" && isGM()) {
      ungroupSelectedTokens();
      e.preventDefault();
      return;
    }
    if (!isTyping && (e.key === "Delete" || e.key === "Backspace") && selectedIdsArray().length) {
      for (const id of selectedIdsArray()) {
        const tok = state.tokens.get(id);
        if (canDeleteTokenLocal(tok)) send("TOKEN_DELETE", { id });
      }
      e.preventDefault();
      return;
    }
    if (!isTyping && (e.key === "Delete" || e.key === "Backspace") && selectedAssetId) {
      const a = state.assets.get(selectedAssetId);
      if (canDeleteAssetLocal(a)) {
        send("ASSET_INSTANCE_DELETE", { id: selectedAssetId });
        e.preventDefault();
        return;
      }
    }
    if (!isTyping && (e.key === "Delete" || e.key === "Backspace") && selectedInteriorId && canDeleteSelectedInterior()) {
      send("INTERIOR_DELETE", { id: selectedInteriorId });
      selectedInteriorId = null;
      e.preventDefault();
      requestRender();
      return;
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") isShiftDown = false;
  });
  window.addEventListener("resize", () => {
    if (tool() === "terrain_paint" && terrainPaintPanel && !terrainPaintPanel.classList.contains("hidden")) {
      positionTerrainPaintPanel();
    }
    if (tool() === "fog_paint" && fogPaintPanel && !fogPaintPanel.classList.contains("hidden")) {
      positionFogPaintPanel();
    }
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const oldZ = cam.z;
    const zoomFactor = (e.deltaY < 0) ? 1.12 : 0.89;
    const newZ = clamp(cam.z * zoomFactor, 0.05, 3);

    const wx = (mx - cam.x) / oldZ;
    const wy = (my - cam.y) / oldZ;
    cam.z = newZ;
    cam.x = mx - wx * newZ;
    cam.y = my - wy * newZ;
    requestRender();
  }, { passive: false });

  // Block the browser's native context menu everywhere in the app except inside
  // form inputs (where right-click → paste must still work).  Runs in capture
  // phase so it fires before any element's own handlers and catches overlay
  // elements (tokenMenu, .ctx menus, #wrap, etc.) that sit on top of the canvas.
  document.addEventListener("contextmenu", (e) => {
    const tag = (e.target?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.target?.isContentEditable) return;
    e.preventDefault();
  }, { capture: true });

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wpos = screenToWorld(sx, sy);
    const t = tool();

    // Tool-first menus: if a tool has its own context menu, always show it.
    if (t === "text") {
      selectedTokenId = null;
      selectedShapeId = hitTestShape(wpos.x, wpos.y);
      selectedInteriorId = null;
      closeTokenMenu();
      showContextMenu(textCtx, e.clientX, e.clientY);
      requestRender();
      return;
    }
    if (t === "pen") {
      closeTokenMenu();
      showContextMenu(penCtx, e.clientX, e.clientY);
      return;
    }
    if (t === "rect" || t === "circle" || t === "line" || t === "arrow") {
      closeTokenMenu();
      showContextMenu(shapeCtx, e.clientX, e.clientY);
      return;
    }
    if (t === "ruler") {
      closeTokenMenu();
      showContextMenu(rulerCtx, e.clientX, e.clientY);
      return;
    }

    const hit = hitTestToken(wpos.x, wpos.y);
    if (hit) {
      const tok = state.tokens.get(hit);
      if (isGM() || canEditTokenLocal(tok) || canDeleteTokenLocal(tok)) {
        hideAllCtx();
        if (isShiftDown) toggleSelection(hit);
        else if (!selectedTokenIds.has(hit)) selectOnly(hit);
        openTokenMenu(hit, e.clientX, e.clientY);
        refreshGmUI();
        requestRender();
      } else {
        hideAllCtx();
        closeTokenMenu();
      }
      return;
    }
    const assetHit = isAssetInteractionLocked() ? null : hitTestAsset(wpos.x, wpos.y);
    const interiorTarget = (!hit && !assetHit) ? resolveInteriorPointerTarget(wpos.x, wpos.y) : null;
    if (assetHit) {
      selectedAssetId = assetHit;
      selectedShapeId = null;
      selectedTokenId = null;
      selectedInteriorId = null;
      closeTokenMenu();
      const a = state.assets.get(assetHit);
      if (a && (canEditAssetLocal(a) || canDeleteAssetLocal(a))) {
        const lockItem = assetCtx?.querySelector('[data-action="asset_lock_toggle"]');
        if (lockItem) lockItem.style.display = isGM() ? "flex" : "none";
        syncAssetCtxSliders();
        showContextMenu(assetCtx, e.clientX, e.clientY);
      }
      requestRender();
      return;
    }
    if (interiorTarget?.edge && isGM()) {
      selectedInteriorId = getInteriorTargetRoomId(interiorTarget);
      selectedAssetId = null;
      selectedAssetIds.clear();
      selectedShapeId = null;
      selectedTokenId = null;
      closeTokenMenu();
      if (!isInteriorEdgeLocked(interiorTarget.edge)) openInteriorEdgeMenu(interiorTarget.edge, e.clientX, e.clientY);
      requestRender();
      return;
    }
    if (interiorTarget?.roomId) {
      selectedInteriorId = interiorTarget.roomId;
      selectedAssetId = null;
      selectedShapeId = null;
      selectedTokenId = null;
      closeTokenMenu();
      maybeLogInteriorOverlapHint(wpos.x, wpos.y, interiorTarget);
      openInteriorRoomMenu(interiorTarget.roomId, e.clientX, e.clientY);
      requestRender();
      return;
    }
    const shapeHit = hitTestShape(wpos.x, wpos.y);
    if (shapeHit) {
      selectedShapeId = shapeHit;
      selectedTokenId = null;
      selectedInteriorId = null;
      const sh = state.shapes.get(shapeHit);
      closeTokenMenu();
      if (sh?.type === "text" && canEditShapeLocal(sh)) {
        showContextMenu(textCtx, e.clientX, e.clientY);
      }
      requestRender();
      return;
    }
    closeTokenMenu();
    mapCtxWorld = { x: wpos.x, y: wpos.y };
    showMapMenu(e.clientX, e.clientY);
  });

  canvas.addEventListener("pointerdown", (e) => {
    closeTokenMenu();
    hideAllCtx();
    hideToolPanels();

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wpos = screenToWorld(sx, sy);

    if (dragSpawn && e.button === 0) {
      dragSpawnWorld = { x: wpos.x, y: wpos.y };
      dragSpawnOverCanvas = true;
      requestRender();
      return;
    }

    if (e.button === 2) {
      const hit = hitTestToken(wpos.x, wpos.y);
      const tok = hit ? state.tokens.get(hit) : null;
      if (hit && (isGM() || canEditTokenLocal(tok) || canDeleteTokenLocal(tok))) {
        if (isShiftDown) toggleSelection(hit);
        else if (!selectedTokenIds.has(hit)) selectOnly(hit);
        selectedInteriorId = null;
        openTokenMenu(hit, e.clientX, e.clientY);
        refreshGmUI();
        requestRender();
        return;
      }
      const assetHit = (hit || isAssetInteractionLocked()) ? null : hitTestAsset(wpos.x, wpos.y);
      const interiorTarget = (hit || assetHit) ? null : resolveInteriorPointerTarget(wpos.x, wpos.y);
      if (assetHit) {
        // If right-clicking an asset not in the current selection, replace selection with just this one.
        if (!selectedAssetIds.has(assetHit)) {
          selectedAssetIds.clear();
          selectedAssetIds.add(assetHit);
        }
        selectedAssetId = assetHit;
        selectedShapeId = null;
        selectedTokenId = null;
        selectedInteriorId = null;
        const a = state.assets.get(assetHit);
        if (a && (canEditAssetLocal(a) || canDeleteAssetLocal(a))) {
          const lockItem = assetCtx?.querySelector('[data-action="asset_lock_toggle"]');
          if (lockItem) lockItem.style.display = isGM() ? "flex" : "none";
          syncAssetCtxSliders();
          showContextMenu(assetCtx, e.clientX, e.clientY);
        }
        requestRender();
        return;
      }
      if (interiorTarget?.edge && isGM()) {
        selectedInteriorId = getInteriorTargetRoomId(interiorTarget);
        selectedAssetId = null;
        selectedAssetIds.clear();
        selectedShapeId = null;
        selectedTokenId = null;
        if (!isInteriorEdgeLocked(interiorTarget.edge)) openInteriorEdgeMenu(interiorTarget.edge, e.clientX, e.clientY);
        requestRender();
        return;
      }
      if (interiorTarget?.roomId) {
        selectedInteriorId = interiorTarget.roomId;
        selectedAssetId = null;
        selectedShapeId = null;
        selectedTokenId = null;
        requestRender();
        return;
      }
      const shapeHit = hit ? null : hitTestShape(wpos.x, wpos.y);
      if (shapeHit) {
        selectedShapeId = shapeHit;
        selectedTokenId = null;
        requestRender();
        return;
      }
      isPanning = true;
      panStart = { sx: e.clientX, sy: e.clientY, camX: cam.x, camY: cam.y };
      canvas.setPointerCapture(e.pointerId);
      pointerCaptured = true;
      return;
    }

    canvas.setPointerCapture(e.pointerId);
    pointerCaptured = true;

    erasingActive = false;
    lastEraseWorld = null;
    const t = tool();

    if (t === "move") {
      const hit = hitTestToken(wpos.x, wpos.y);
      const assetHit = (hit || isAssetInteractionLocked()) ? null : hitTestAsset(wpos.x, wpos.y);
      const interiorTarget = (hit || assetHit) ? null : resolveInteriorPointerTarget(wpos.x, wpos.y);
      const interiorHit = interiorTarget?.roomId || null;
      const interiorResize = interiorTarget?.resize || null;
      const interiorEdge = interiorTarget?.edge || null;
      const shapeHitRaw = (hit || assetHit || interiorHit || interiorEdge) ? null : hitTestShape(wpos.x, wpos.y);
      let shapeHit = shapeHitRaw;
      if (!hit && !shapeHit && selectedShapeId) {
        const selectedShape = state.shapes.get(selectedShapeId);
        if (canEditShapeLocal(selectedShape) && shapeSelectionBoxContainsPoint(selectedShape, wpos.x, wpos.y)) {
          shapeHit = selectedShapeId;
        }
      }
      if (hit) {
        selectedTokenId = hit;
        selectedAssetId = null;
        selectedAssetIds.clear();
        selectedShapeId = null;
        selectedInteriorId = null;
        if (isShiftDown) {
          toggleSelection(hit);
          requestRender();
          return;
        }
        if (!selectedTokenIds.has(hit)) selectOnly(hit);
        const tok0 = state.tokens.get(hit);
        if (canEditTokenLocal(tok0)) {
          const moveIds = selectedIdsIncludingGroups();
          activeDragMoveSeq = ++moveSeqCounter;
          draggingTokenId = hit;
          draggingShapeId = null;
          shapeDragOrigin = null;
          draggingTokenIds = moveIds;
          dragMoveStartWorld = { x: wpos.x, y: wpos.y };
          dragStartTokenPositions = new Map();
          for (const id of moveIds) {
            const tok = state.tokens.get(id);
            if (tok) dragStartTokenPositions.set(id, { x: tok.x, y: tok.y });
          }
        }
      } else if (assetHit) {
        const a = state.assets.get(assetHit);
        const isCtrl = e.ctrlKey || e.metaKey;
        if (isCtrl) {
          // Ctrl+click: toggle this asset in/out of the multi-selection, no drag starts.
          if (selectedAssetIds.has(assetHit)) {
            selectedAssetIds.delete(assetHit);
            if (selectedAssetId === assetHit) {
              selectedAssetId = selectedAssetIds.size ? Array.from(selectedAssetIds).at(-1) : null;
            }
          } else {
            selectedAssetIds.add(assetHit);
            selectedAssetId = assetHit;
          }
          selectedTokenId = null;
          selectedShapeId = null;
          selectedInteriorId = null;
        } else {
          // Regular click: if the asset isn't already in the selection, replace selection with just this one.
          // If it IS already selected (part of a multi-select) keep the full selection and start dragging all.
          if (!selectedAssetIds.has(assetHit)) {
            selectedAssetIds.clear();
            selectedAssetIds.add(assetHit);
          }
          selectedTokenId = null;
          selectedAssetId = assetHit;
          selectedShapeId = null;
          selectedInteriorId = null;
          if (a && canEditAssetLocal(a)) {
            activeDragMoveSeq = ++moveSeqCounter;
            draggingAssetId = assetHit;
            draggingTokenId = null;
            draggingTokenIds = [];
            draggingShapeId = null;
            dragMoveStartWorld = null;
            dragStartTokenPositions.clear();
            shapeDragOrigin = null;
            // Build drag set: all currently selected editable assets.
            draggingAssetIds = [];
            dragStartAssetPositions = new Map();
            for (const id of selectedAssetIds) {
              const asset = state.assets.get(id);
              if (asset && canEditAssetLocal(asset)) {
                draggingAssetIds.push(id);
                dragStartAssetPositions.set(id, { x: Number(asset.x || 0), y: Number(asset.y || 0) });
              }
            }
            assetDragOrigin = { wx: wpos.x, wy: wpos.y, x: Number(a.x || 0), y: Number(a.y || 0) };
          } else {
            draggingAssetId = null;
            draggingAssetIds = [];
            dragStartAssetPositions = new Map();
            assetDragOrigin = null;
          }
        }
      } else if (interiorResize) {
        const room = state.interiors.get(interiorResize.id);
        selectedTokenId = null;
        selectedAssetId = null;
        selectedAssetIds.clear();
        selectedShapeId = null;
        selectedInteriorId = interiorResize.id;
        activeInteriorAssist = null;
        if (room && canEditInterior(room)) {
          activeDragMoveSeq = ++moveSeqCounter;
          resizingInterior = interiorResize;
          draggingInteriorId = interiorResize.id;
          interiorDragStart = { x: wpos.x, y: wpos.y };
          interiorDragOrigin = { ...room };
          updateCanvasCursor();
        }
      } else if (interiorEdge) {
        selectedTokenId = null;
        selectedAssetId = null;
        selectedAssetIds.clear();
        selectedShapeId = null;
        selectedInteriorId = getInteriorTargetRoomId(interiorTarget);
        activeInteriorAssist = null;
        draggingInteriorId = null;
        resizingInterior = null;
        interiorDragStart = null;
        interiorDragOrigin = null;
        updateCanvasCursor();
      } else if (interiorHit) {
        selectedTokenId = null;
        selectedAssetId = null;
        selectedAssetIds.clear();
        selectedShapeId = null;
        selectedInteriorId = interiorHit;
        activeInteriorAssist = null;
        const room = state.interiors.get(interiorHit);
        if (room && canEditInterior(room)) {
          activeDragMoveSeq = ++moveSeqCounter;
          draggingInteriorId = interiorHit;
          resizingInterior = null;
          interiorDragStart = { x: wpos.x, y: wpos.y };
          interiorDragOrigin = { ...room };
          updateCanvasCursor();
        } else {
          draggingInteriorId = null;
          resizingInterior = null;
          interiorDragStart = null;
          interiorDragOrigin = null;
          updateCanvasCursor();
        }
      } else if (shapeHit) {
        selectedTokenId = null;
        selectedAssetId = null;
        selectedAssetIds.clear();
        selectedInteriorId = null;
        selectedShapeId = shapeHit;
        const sh = state.shapes.get(shapeHit);
        if (canEditShapeLocal(sh)) {
          activeDragMoveSeq = ++moveSeqCounter;
          draggingShapeId = shapeHit;
          draggingTokenId = null;
          draggingTokenIds = [];
          dragMoveStartWorld = null;
          dragStartTokenPositions.clear();
          shapeDragOrigin = { wx: wpos.x, wy: wpos.y, x1: sh.x1, y1: sh.y1, x2: sh.x2, y2: sh.y2 };
        } else {
          draggingShapeId = null;
          draggingTokenId = null;
          draggingTokenIds = [];
          dragMoveStartWorld = null;
          dragStartTokenPositions.clear();
          shapeDragOrigin = null;
        }
      } else {
        selectedTokenId = null;
        selectedAssetId = null;
        selectedAssetIds.clear();
        selectedInteriorId = null;
        selectedShapeId = null;
        activeInteriorAssist = null;
        draggingTokenId = null;
        draggingAssetId = null;
        draggingAssetIds = [];
        dragStartAssetPositions = new Map();
        assetDragOrigin = null;
        draggingTokenIds = [];
        dragMoveStartWorld = null;
        dragStartTokenPositions.clear();
        resizingInterior = null;
        interiorDragStart = null;
        interiorDragOrigin = null;
        if (!isShiftDown) setSelection([]);
        marqueeSelectRect = { x1: wpos.x, y1: wpos.y, x2: wpos.x, y2: wpos.y, additive: isShiftDown };
      }
      requestRender();
      return;
    }

    if (t === "pen") {
      activeStroke = {
        id: makeId(),
        points: [{ x: wpos.x, y: wpos.y }],
        color: brushColor(),
        width: brushSize(),
        locked: false,
        layer: "draw",
        layer_band: drawingLayerBand(),
      };
      requestRender();
      return;
    }

    if (t === "interior" && isGM()) {
      const x = snapInterior(wpos.x);
      const y = snapInterior(wpos.y);
      activeInteriorAssist = null;
      activeInteriorPreview = {
        id: makeId(),
        x,
        y,
        w: ui.gridSize,
        h: ui.gridSize,
        style: "wood",
        locked: false,
        originX: x,
        originY: y,
      };
      selectedTokenId = null;
      selectedAssetId = null;
      selectedAssetIds.clear();
      selectedShapeId = null;
      selectedInteriorId = null;
      requestRender();
      return;
    }

    if (t === "terrain_paint" && isGM()) {
      activePaintStroke = {
        id: makeId(),
        material_id: terrainBrush.material_id,
        op: terrainBrush.op,
        points: [{ x: wpos.x, y: wpos.y }],
        radius: terrainBrush.radius,
        opacity: terrainBrush.opacity,
        hardness: terrainBrush.hardness,
      };
      // Apply locally for responsiveness
      terrainMasks.applyStroke(activePaintStroke);
      requestRender();
      return;
    }

    if (t === "fog_paint" && isGM()) {
      if (!state.fog_paint?.enabled) {
        toast("Enable fog first, or use Cover All / Clear All.");
        refreshFogPaintPanel();
        return;
      }
      activeFogStroke = {
        id: makeId(),
        op: fogBrush.op,
        points: [{ x: wpos.x, y: wpos.y }],
        radius: fogBrush.radius,
        opacity: fogBrush.opacity,
        hardness: fogBrush.hardness,
      };
      fogMasks.applyStroke(activeFogStroke);
      requestRender();
      return;
    }

    if (t === "eraser") {
      activeStroke = null;
      activeShapePreview = null;
      activeRuler = null;
      erasingActive = true;
      lastEraseWorld = null;
      doEraseAt(wpos.x, wpos.y);
      return;
    }

    if (t === "rect" || t === "circle" || t === "line" || t === "arrow") {
      activeShapePreview = {
        id: makeId(),
        type: t,
        x1: wpos.x,
        y1: wpos.y,
        x2: wpos.x,
        y2: wpos.y,
        color: brushColor(),
        width: brushSize(),
        fill: false,
        locked: false,
        layer: "draw",
        layer_band: drawingLayerBand(),
      };
      requestRender();
      return;
    }

    if (t === "text") {
      const text = String(ui.textDraft || "").trim();
      const x = ui.snap ? snap(wpos.x) : wpos.x;
      const y = ui.snap ? snap(wpos.y) : wpos.y;
      if (!text) {
        pendingTextPlacement = { x, y };
        openToolTextPanel();
        return;
      }
      createTextShapeAt({ x, y }, text);
      return;
    }

    if (t === "ruler") {
      activeRuler = { x1: wpos.x, y1: wpos.y, x2: wpos.x, y2: wpos.y };
      requestRender();
      return;
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    hoverCanvasActive = true;

    if (isPanning) {
      hoverWorldPos = screenToWorld(sx, sy);
      cam.x = panStart.camX + (e.clientX - panStart.sx);
      cam.y = panStart.camY + (e.clientY - panStart.sy);
      requestRender();
      return;
    }

    const wpos = screenToWorld(sx, sy);
    hoverWorldPos = { x: wpos.x, y: wpos.y };
    if (dragSpawn) {
      dragSpawnWorld = { x: wpos.x, y: wpos.y };
      dragSpawnOverCanvas = true;
      requestRender();
      return;
    }
    updateHoveredToken(wpos.x, wpos.y);
    const t = tool();

    if (t === "move" && !draggingInteriorId && !resizingInterior && !marqueeSelectRect) {
      const hoverToken = hitTestToken(wpos.x, wpos.y);
      const hoverAsset = hoverToken || isAssetInteractionLocked() ? null : hitTestAsset(wpos.x, wpos.y);
      const hoverShape = (hoverToken || hoverAsset) ? null : hitTestShape(wpos.x, wpos.y);
      if (!hoverToken && !hoverAsset && !hoverShape) {
        const interiorTarget = resolveInteriorPointerTarget(wpos.x, wpos.y);
        setInteriorHoverState(
          interiorTarget?.edge ? null : interiorTarget?.roomId || null,
          interiorTarget?.edge || null,
          interiorTarget?.resize && canEditInterior(interiorTarget.resize.id) ? interiorTarget.resize : null,
        );
      } else if (hoveredInteriorId || hoveredInteriorEdge || hoveredInteriorResize) {
        setInteriorHoverState(null, null, null);
      } else {
        updateCanvasCursor();
      }
    } else if (hoveredInteriorId || hoveredInteriorEdge || hoveredInteriorResize) {
      setInteriorHoverState(null, null, null);
    } else {
      updateCanvasCursor();
    }

    if (t === "move" && marqueeSelectRect) {
      marqueeSelectRect.x2 = wpos.x;
      marqueeSelectRect.y2 = wpos.y;
      requestRender();
      return;
    }

    if (t === "move" && draggingTokenIds.length && dragMoveStartWorld) {
      const dx = wpos.x - dragMoveStartWorld.x;
      const dy = wpos.y - dragMoveStartWorld.y;
      const moves = [];
      for (const id of draggingTokenIds) {
        const start = dragStartTokenPositions.get(id);
        const tok = state.tokens.get(id);
        if (!start || !tok) continue;
        const x = snap(start.x + dx);
        const y = snap(start.y + dy);
        tok.x = x;
        tok.y = y;
        state.tokens.set(id, tok);
        moves.push({ id, x, y });
      }
      requestRender();

      const now = Date.now();
        if (moves.length && now - lastMoveSentAt >= MOVE_SEND_INTERVAL_MS) {
          lastMoveSentAt = now;
        if (moves.length === 1) {
          send("TOKEN_MOVE", {
            id: moves[0].id,
            x: moves[0].x,
            y: moves[0].y,
            commit: false,
            move_seq: activeDragMoveSeq,
            move_client: localMoveClientId,
          });
        } else {
          send("TOKENS_MOVE", { moves, commit: false, move_seq: activeDragMoveSeq, move_client: localMoveClientId });
        }
      }
      return;
    }

    if (t === "move" && draggingInteriorId && interiorDragStart && interiorDragOrigin) {
      const room = state.interiors.get(draggingInteriorId);
      const nextRect = resolveInteriorDragRect(wpos);
      if (!room || !nextRect) return;
      room.x = nextRect.x;
      room.y = nextRect.y;
      room.w = nextRect.w;
      room.h = nextRect.h;
      activeInteriorAssist = nextRect.assist || null;
      state.interiors.set(room.id, room);
      markInteriorsDirty();
      requestRender();
      const now = Date.now();
      if (now - lastMoveSentAt >= MOVE_SEND_INTERVAL_MS) {
        lastMoveSentAt = now;
        const payload = {
          id: room.id,
          x: nextRect.x,
          y: nextRect.y,
          commit: false,
          move_seq: activeDragMoveSeq,
          move_client: localMoveClientId,
        };
        if (resizingInterior) {
          payload.w = nextRect.w;
          payload.h = nextRect.h;
        }
        send("INTERIOR_UPDATE", payload);
      }
      return;
    }

    if (t === "interior" && activeInteriorPreview) {
      const startX = Number(activeInteriorPreview.originX ?? activeInteriorPreview.x);
      const startY = Number(activeInteriorPreview.originY ?? activeInteriorPreview.y);
      const endX = snapInterior(wpos.x);
      const endY = snapInterior(wpos.y);
      const x1 = Math.min(startX, endX);
      const y1 = Math.min(startY, endY);
      const x2 = Math.max(startX, endX);
      const y2 = Math.max(startY, endY);
      const previewRect = {
        id: activeInteriorPreview.id,
        x: x1,
        y: y1,
        w: Math.max(ui.gridSize, x2 - x1),
        h: Math.max(ui.gridSize, y2 - y1),
      };
      const assisted = applyInteriorSeamAssist(previewRect, {
        mode: "place",
        threshold: ui.gridSize * 0.35,
      });
      activeInteriorPreview.x = assisted.rect.x;
      activeInteriorPreview.y = assisted.rect.y;
      activeInteriorPreview.w = assisted.rect.w;
      activeInteriorPreview.h = assisted.rect.h;
      activeInteriorAssist = assisted.assist || null;
      requestRender();
      return;
    }

    if (t === "move" && draggingAssetId && assetDragOrigin) {
      const dx = wpos.x - assetDragOrigin.wx;
      const dy = wpos.y - assetDragOrigin.wy;
      const idsToMove = draggingAssetIds.length ? draggingAssetIds : [draggingAssetId];
      for (const id of idsToMove) {
        const asset = state.assets.get(id);
        if (!asset) continue;
        const origin = dragStartAssetPositions.get(id);
        const baseX = origin ? origin.x : (id === draggingAssetId ? assetDragOrigin.x : 0);
        const baseY = origin ? origin.y : (id === draggingAssetId ? assetDragOrigin.y : 0);
        asset.x = ui.snap ? snap(baseX + dx) : baseX + dx;
        asset.y = ui.snap ? snap(baseY + dy) : baseY + dy;
        state.assets.set(id, asset);
      }
      requestRender();
      const now = Date.now();
      if (now - lastMoveSentAt >= MOVE_SEND_INTERVAL_MS) {
        lastMoveSentAt = now;
        for (const id of idsToMove) {
          const asset = state.assets.get(id);
          if (!asset) continue;
          send("ASSET_INSTANCE_UPDATE", {
            id,
            x: asset.x,
            y: asset.y,
            commit: false,
            move_seq: activeDragMoveSeq,
            move_client: localMoveClientId,
          });
        }
      }
      return;
    }

    if (t === "move" && draggingShapeId && shapeDragOrigin) {
      const sh = state.shapes.get(draggingShapeId);
      if (!sh) return;
      const dx = wpos.x - shapeDragOrigin.wx;
      const dy = wpos.y - shapeDragOrigin.wy;
      let x1 = shapeDragOrigin.x1 + dx;
      let y1 = shapeDragOrigin.y1 + dy;
      let x2 = shapeDragOrigin.x2 + dx;
      let y2 = shapeDragOrigin.y2 + dy;
      if (ui.snap) {
        x1 = snap(x1); y1 = snap(y1); x2 = snap(x2); y2 = snap(y2);
      }
      sh.x1 = x1; sh.y1 = y1; sh.x2 = x2; sh.y2 = y2;
      state.shapes.set(draggingShapeId, sh);
      requestRender();
      const now = Date.now();
      if (now - lastMoveSentAt >= MOVE_SEND_INTERVAL_MS) {
        lastMoveSentAt = now;
        send("SHAPE_UPDATE", {
          id: draggingShapeId,
          x1,
          y1,
          x2,
          y2,
          commit: false,
          move_seq: activeDragMoveSeq,
          move_client: localMoveClientId,
        });
      }
      return;
    }

    if (t === "pen" && activeStroke) {
      const last = activeStroke.points[activeStroke.points.length - 1];
      const dx = wpos.x - last.x;
      const dy = wpos.y - last.y;
      if (dx * dx + dy * dy >= 2.0) {
        activeStroke.points.push({ x: wpos.x, y: wpos.y });
        requestRender();
      }
      return;
    }

    if (t === "terrain_paint" && activePaintStroke && isGM()) {
      const pts = activePaintStroke.points;
      const last = pts[pts.length - 1];
      const dx = wpos.x - last.x;
      const dy = wpos.y - last.y;
      const minDist = terrainBrush.radius * 0.15;
      if (dx * dx + dy * dy >= minDist * minDist && pts.length < 2000) {
        const newPt = { x: wpos.x, y: wpos.y };
        pts.push(newPt);
        // Apply the incremental segment for live preview
        const prevPt = pts[pts.length - 2];
        const segStroke = { ...activePaintStroke, points: [prevPt, newPt] };
        terrainMasks.applyStroke(segStroke);
        requestRender();
      }
      return;
    }

    if (t === "fog_paint" && activeFogStroke && isGM()) {
      const pts = activeFogStroke.points;
      const last = pts[pts.length - 1];
      const dx = wpos.x - last.x;
      const dy = wpos.y - last.y;
      const minDist = fogBrush.radius * 0.15;
      if (dx * dx + dy * dy >= minDist * minDist && pts.length < 2000) {
        const newPt = { x: wpos.x, y: wpos.y };
        pts.push(newPt);
        const prevPt = pts[pts.length - 2];
        fogMasks.applyStroke({ ...activeFogStroke, points: [prevPt, newPt] });
        requestRender();
      }
      return;
    }

    if (t === "eraser" && erasingActive && (e.buttons & 1) === 1) {
      doEraseAt(wpos.x, wpos.y);
      return;
    }

    if ((t === "rect" || t === "circle" || t === "line" || t === "arrow") && activeShapePreview) {
      activeShapePreview.x2 = wpos.x;
      activeShapePreview.y2 = wpos.y;
      requestRender();
      return;
    }

    if (t === "ruler" && activeRuler) {
      activeRuler.x2 = wpos.x;
      activeRuler.y2 = wpos.y;
      requestRender();
      return;
    }

    if (t === "terrain_paint" || t === "fog_paint") requestRender();
  });

  canvas.addEventListener("pointerleave", () => {
    hoverCanvasActive = false;
    hoverWorldPos = null;
    if (dragSpawn) {
      dragSpawnOverCanvas = false;
      requestRender();
      return;
    }
    if (hoveredTokenId !== null && !draggingTokenIds.length) {
      hoveredTokenId = null;
      requestRender();
    }
    if (hoveredInteriorId || hoveredInteriorEdge || hoveredInteriorResize) {
      hoveredInteriorId = null;
      hoveredInteriorEdge = null;
      hoveredInteriorResize = null;
      requestRender();
    }
    if (activeInteriorAssist) {
      activeInteriorAssist = null;
      requestRender();
    }
    updateCanvasCursor();
  });

  window.addEventListener("pointermove", (e) => {
    if (!dragSpawn) return;
    const rect = canvas.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    dragSpawnOverCanvas = inside;
    if (inside) {
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const wpos = screenToWorld(sx, sy);
      dragSpawnWorld = { x: wpos.x, y: wpos.y };
    } else {
      dragSpawnWorld = null;
    }
    requestRender();
  });

  window.addEventListener("pointerup", (e) => {
    if (pointerCaptured) {
      endPointer(e);
      return;
    }
    if (!dragSpawn) return;
    if (!dragSpawnOverCanvas) {
      dragSpawn = null;
      dragSpawnWorld = null;
      dragSpawnOverCanvas = false;
      requestRender();
    }
  });

  function doEraseAt(wx, wy) {
    const r = 14;
    if (lastEraseWorld) {
      const dx = wx - lastEraseWorld.x;
      const dy = wy - lastEraseWorld.y;
      if (dx * dx + dy * dy < 36) return; // require ~6 world units movement
    }
    lastEraseWorld = { x: wx, y: wy };
    const now = Date.now();
    if (now - lastEraseSentAt < ERASE_SEND_INTERVAL_MS) return;
    lastEraseSentAt = now;
    send("ERASE_AT", { x: wx, y: wy, r, erase_shapes: true, erase_tokens: true });
  }

  // commitActiveTerrainStroke → static/canvas/terrain.js

  // commitActiveFogStroke → static/canvas/fog.js

  function endPointer(e) {
    if (dragSpawn) {
      if (dragSpawnWorld && dragSpawnOverCanvas) {
        if (dragSpawn.kind === "asset") {
          spawnPackAsset(dragSpawn, snap(dragSpawnWorld.x), snap(dragSpawnWorld.y));
        } else {
          spawnPackToken(dragSpawn, snap(dragSpawnWorld.x), snap(dragSpawnWorld.y));
        }
      }
      dragSpawn = null;
      dragSpawnWorld = null;
      dragSpawnOverCanvas = false;
      if (pointerCaptured) {
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
        pointerCaptured = false;
      }
      requestRender();
      return;
    }

    isPanning = false;
    const t = tool();
    const movedTokenIds = draggingTokenIds.slice();
    const movedTokenId = draggingTokenId;
    const movedAssetId = draggingAssetId;
    const movedAssetIds = draggingAssetIds.slice();
    const movedShapeId = draggingShapeId;
    const movedInteriorId = draggingInteriorId;
    const movedInteriorResize = resizingInterior ? { ...resizingInterior } : null;
    const finalInteriorPointer = (() => {
      if (!movedInteriorId) return null;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      return screenToWorld(sx, sy);
    })();
    const finalInteriorRect = finalInteriorPointer ? resolveInteriorDragRect(finalInteriorPointer) : null;
    const pendingInteriorPreview = activeInteriorPreview ? { ...activeInteriorPreview } : null;
    const finalSeq = activeDragMoveSeq;
    draggingTokenId = null;
    draggingAssetId = null;
    draggingAssetIds = [];
    dragStartAssetPositions = new Map();
    draggingShapeId = null;
    draggingInteriorId = null;
    resizingInterior = null;
    const hadMarquee = !!marqueeSelectRect;
    const finalMarqueeRect = marqueeSelectRect
      ? normalizeWorldRect({ x: marqueeSelectRect.x1, y: marqueeSelectRect.y1 }, { x: marqueeSelectRect.x2, y: marqueeSelectRect.y2 })
      : null;
    const marqueeAdditive = !!marqueeSelectRect?.additive;
    marqueeSelectRect = null;
    draggingTokenId = null;
    draggingTokenIds = [];
    dragMoveStartWorld = null;
    dragStartTokenPositions.clear();
    assetDragOrigin = null;
    interiorDragStart = null;
    interiorDragOrigin = null;
    activeInteriorAssist = null;

    if (t === "move" && hadMarquee && finalMarqueeRect) {
      const hitIds = [];
      for (const [id, tok] of state.tokens) {
        if (tokenIntersectsWorldRect(tok, finalMarqueeRect)) hitIds.push(id);
      }
      if (marqueeAdditive) {
        for (const id of hitIds) selectedTokenIds.add(id);
        selectedTokenId = selectedTokenIds.size ? Array.from(selectedTokenIds)[0] : null;
      } else {
        setSelection(hitIds, hitIds[0] || null);
      }
      requestRender();
    }

    if (t === "move" && movedTokenIds.length) {
      const moves = [];
      for (const id of movedTokenIds) {
        const tok = state.tokens.get(id);
        if (!tok) continue;
        moves.push({ id, x: tok.x, y: tok.y });
      }
      if (moves.length === 1 && movedTokenId) {
        send("TOKEN_MOVE", {
          id: movedTokenId,
          x: moves[0].x,
          y: moves[0].y,
          commit: true,
          move_seq: finalSeq,
          move_client: localMoveClientId,
        });
      } else if (moves.length > 1) {
        send("TOKENS_MOVE", { moves, commit: true, move_seq: finalSeq, move_client: localMoveClientId });
      }
    }
    if (t === "move" && movedAssetId) {
      const commitIds = movedAssetIds.length ? movedAssetIds : [movedAssetId];
      for (const id of commitIds) {
        const a = state.assets.get(id);
        if (a) {
          send("ASSET_INSTANCE_UPDATE", {
            id,
            x: a.x,
            y: a.y,
            commit: true,
            move_seq: finalSeq,
            move_client: localMoveClientId,
          });
        }
      }
    }
    if (t === "move" && movedShapeId) {
      const sh = state.shapes.get(movedShapeId);
      if (sh) {
        send("SHAPE_UPDATE", {
          id: movedShapeId,
          x1: sh.x1,
          y1: sh.y1,
          x2: sh.x2,
          y2: sh.y2,
          commit: true,
          move_seq: finalSeq,
          move_client: localMoveClientId,
        });
      }
      shapeDragOrigin = null;
    }
    if (t === "move" && movedInteriorId) {
      const room = state.interiors.get(movedInteriorId);
      if (room && finalInteriorRect) {
        room.x = finalInteriorRect.x;
        room.y = finalInteriorRect.y;
        room.w = finalInteriorRect.w;
        room.h = finalInteriorRect.h;
        state.interiors.set(room.id, room);
        markInteriorsDirty();
        requestRender();
      }
      if (room) {
        const payload = {
          id: room.id,
          x: room.x,
          y: room.y,
          commit: true,
          move_seq: finalSeq,
          move_client: localMoveClientId,
        };
        if (movedInteriorResize) {
          payload.w = room.w;
          payload.h = room.h;
        }
        send("INTERIOR_UPDATE", payload);
      }
    }
    activeDragMoveSeq = null;
    updateCanvasCursor();

    if (t === "interior" && pendingInteriorPreview && isGM()) {
      const room = normalizeInteriorRecord({
        ...pendingInteriorPreview,
        creator_id: myId(),
      });
      activeInteriorPreview = null;
      selectedInteriorId = room.id;
      send("INTERIOR_ADD", room);
      requestRender();
    } else if (t !== "interior") {
      activeInteriorPreview = null;
    }

    if (t === "eraser") {
      erasingActive = false;
      lastEraseWorld = null;
    }

    // Commit terrain stroke even if tool changed before release.
    if (activePaintStroke && isGM()) commitActiveTerrainStroke();
    if (activeFogStroke && isGM()) commitActiveFogStroke();

    if (t === "pen" && activeStroke) {
      if (activeStroke.points.length >= 2) {
        const pts = activeStroke.points;
        const chunkSize = 12;
        if (pts.length <= chunkSize) {
          state.strokes.set(activeStroke.id, normalizeStrokeRecord({
            id: activeStroke.id,
            points: pts,
            color: activeStroke.color,
            width: activeStroke.width,
            locked: false,
            layer: "draw",
            layer_band: normalizeLayerBand(activeStroke.layer_band),
          }));
          state.draw_order.strokes = state.draw_order.strokes.filter((id) => id !== activeStroke.id);
          state.draw_order.strokes.push(activeStroke.id);
          send("STROKE_ADD", {
            id: activeStroke.id,
            points: pts,
            color: activeStroke.color,
            width: activeStroke.width,
            locked: false,
            layer: "draw",
            layer_band: normalizeLayerBand(activeStroke.layer_band),
          });
        } else {
          let idx = 0;
          for (let i = 0; i < pts.length - 1; i += (chunkSize - 1)) {
            const chunk = pts.slice(i, i + chunkSize);
            if (chunk.length < 2) continue;
            const chunkId = `${activeStroke.id}-${idx++}`;
            state.strokes.set(chunkId, normalizeStrokeRecord({
              id: chunkId,
              points: chunk,
              color: activeStroke.color,
              width: activeStroke.width,
              locked: false,
              layer: "draw",
              layer_band: normalizeLayerBand(activeStroke.layer_band),
            }));
            state.draw_order.strokes = state.draw_order.strokes.filter((id) => id !== chunkId);
            state.draw_order.strokes.push(chunkId);
            send("STROKE_ADD", {
              id: chunkId,
              points: chunk,
              color: activeStroke.color,
              width: activeStroke.width,
              locked: false,
              layer: "draw",
              layer_band: normalizeLayerBand(activeStroke.layer_band),
            });
          }
        }
      }
      activeStroke = null;
      requestRender();
    }

    if ((t === "rect" || t === "circle" || t === "line" || t === "arrow") && activeShapePreview) {
      const sh = activeShapePreview;
      const x1 = ui.snap ? snap(sh.x1) : sh.x1;
      const y1 = ui.snap ? snap(sh.y1) : sh.y1;
      const x2 = ui.snap ? snap(sh.x2) : sh.x2;
      const y2 = ui.snap ? snap(sh.y2) : sh.y2;

      state.shapes.set(sh.id, {
        ...sh,
        x1,
        y1,
        x2,
        y2,
        creator_id: myId(),
        layer: "draw",
        layer_band: normalizeLayerBand(sh.layer_band),
      });
      state.draw_order.shapes = state.draw_order.shapes.filter((id) => id !== sh.id);
      state.draw_order.shapes.push(sh.id);
      send("SHAPE_ADD", {
        id: sh.id,
        type: sh.type,
        x1, y1, x2, y2,
        color: sh.color,
        width: sh.width,
        fill: false,
        locked: false,
        layer: "draw",
        layer_band: normalizeLayerBand(sh.layer_band),
        creator_id: myId(),
      });
      activeShapePreview = null;
      requestRender();
    }

    if (t === "ruler") {
      activeRuler = null;
      requestRender();
    }

    if (pointerCaptured) {
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
      pointerCaptured = false;
    }
  }

  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  window.addEventListener("beforeunload", () => {
    if (!online) saveOfflineStateNow();
  });
