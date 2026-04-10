// network.js — WebSocket lifecycle: connect, send, receive/dispatch
// Loaded before canvas.js. All functions are globals in the same script scope.
// Shared vars (ws, online, wsConnectSeq, heartbeatTimer, state, etc.) live in canvas.js.

"use strict";

function send(type, payload = {}) {
  if (online && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, payload }));
    return;
  }
  applyLocalEvent(type, payload);
}

function connectWS(force = false) {
  if (!appInitialized) {
    log("Connect deferred: app not initialized yet.");
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    if (!force) {
      log(ws.readyState === 1 ? "Already connected." : "Connection in progress.");
      return;
    }
    try { ws.close(); } catch {}
  }

  if (!force) clearLocalRoomView();
  const room = encodeURIComponent(roomEl.value.trim());
  const cid = encodeURIComponent(cidEl.value.trim());
  const proto = (location.protocol === "https:") ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws/${room}?client_id=${cid}`;

  const thisWs = new WebSocket(url);
  const thisSeq = ++wsConnectSeq;
  ws = thisWs;
  thisWs.onopen = () => {
    if (ws !== thisWs || thisSeq !== wsConnectSeq) return;
    online = true;
    hideResyncBadge();
    markInboundChange();
    seenInboundMutationSinceConnect = false;
    log(`connected: ${url}`);
    updateSessionPill();
    refreshSessionModalAuth();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws === thisWs && thisWs.readyState === 1) send("HEARTBEAT", { ts: Date.now() });
    }, 10000);
  };
  thisWs.onclose = (ev) => {
    if (ws !== thisWs || thisSeq !== wsConnectSeq) return;
    ws = null;
    online = false;
    hideResyncBadge();
    seenInboundMutationSinceConnect = false;
    const reason = (ev && ev.reason) ? ` (${ev.reason})` : "";
    log(`disconnected (code ${ev.code})${reason}`);
    if (ev.code === 1008) {
      const authMessage = "Connection rejected: login expired or you are not a member of this room.";
      log(authMessage);
      toast(authMessage);
      maybeOpenSessionModalForSharedRoom(authMessage);
    }
    clearPlaySessionState();
    closeRoomMovePrompt();
    renderSessionSummary();
    updateSessionPill();
    refreshSessionModalAuth();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  thisWs.onerror = () => {
    if (ws !== thisWs || thisSeq !== wsConnectSeq) return;
    log("ws error");
    updateSessionPill();
    refreshSessionModalAuth();
  };

  thisWs.onmessage = (msg) => {
    if (ws !== thisWs || thisSeq !== wsConnectSeq) return;
    let ev = null;
    try {
      ev = JSON.parse(msg.data);
    } catch (e) {
      console.error("WS parse failed", e, msg?.data);
      return;
    }
    try {
    if (STATE_CHANGE_EVENTS.has(ev.type)) markInboundChange();
    if (WATCHDOG_MUTATION_EVENTS.has(ev.type)) seenInboundMutationSinceConnect = true;

    if (ev.type === "STATE_SYNC") {
      hideResyncBadge();
      applyStateSync(ev.payload);
      if (pendingArrivalNotice) {
        toast(pendingArrivalNotice);
        log(pendingArrivalNotice);
        addSessionActivity(pendingArrivalNotice, { kind: "arrival" });
        pendingArrivalNotice = "";
      }
      log(`STATE_SYNC v${state.version} gm=${state.gm_id} strokes=${state.strokes.size} shapes=${state.shapes.size}`);
      updateSessionPill();
      refreshSessionModalAuth();
      return;
    }

    if (ev.type === "HELLO") {
      if (typeof ev.payload?.is_gm === "boolean") {
        log(ev.payload.is_gm ? "You are GM" : `GM is ${state.gm_id || "(unclaimed)"}`);
      }
      if (ev.payload && Object.prototype.hasOwnProperty.call(ev.payload, "session")) {
        applyPlaySessionState(ev.payload.session || null);
      }
      refreshGmUI();
      updateSessionPill();
      refreshSessionModalAuth();
      return;
    }

    if (ev.type === "SESSION_ROOM_MOVE_OFFER") {
      setPendingRoomMoveOffer(ev.payload || null);
      const moveMessage = `${ev.payload?.requested_by || "GM"} requested that players join ${ev.payload?.target_room_name || ev.payload?.target_room_id || "another room"}.`;
      toast(moveMessage);
      addSessionActivity(moveMessage, { kind: "move_offer" });
      return;
    }

    if (ev.type === "SESSION_ROOM_MOVE_EXECUTE") {
      const targetName = ev.payload?.target_room_name || ev.payload?.target_room_id || "another room";
      addSessionActivity(`${ev.payload?.requested_by || "GM"} moved players to ${targetName}.`, { kind: "move_force" });
      void executeIncomingRoomMove(ev.payload || null, {
        notice: `${ev.payload?.requested_by || "GM"} moved you to ${targetName}.`,
      });
      return;
    }

    if (ev.type === "SESSION_SYSTEM_NOTICE") {
      if (ev.payload?.message) {
        toast(ev.payload.message);
        log(`SESSION NOTICE: ${ev.payload.message}`);
        addSessionActivity(ev.payload.message, { kind: "notice" });
      }
      if (ev.payload?.redirect) {
        try { if (ws) ws.close(); } catch {}
        setTimeout(() => { location.href = ev.payload.redirect; }, 1500);
      }
      return;
    }

    if (ev.type === "HEARTBEAT") {
      return;
    }

    if (ev.type === "PRESENCE") {
      players.clear();
      for (const id of (ev.payload?.clients || [])) players.add(id);
      if (ev.payload?.gm_id) state.gm_id = ev.payload.gm_id;
      state.co_gm_ids = Array.isArray(ev.payload?.co_gm_ids) ? ev.payload.co_gm_ids : state.co_gm_ids;
      refreshGmUI();
      updateSessionPill();
      refreshSessionModalAuth();
      return;
    }

    if (ev.type === "COGM_UPDATE") {
      state.co_gm_ids = Array.isArray(ev.payload?.co_gm_ids) ? ev.payload.co_gm_ids : [];
      refreshGmUI();
      return;
    }

    if (ev.type === "ROOM_SETTINGS") {
      if ("allow_players_move" in ev.payload) state.allow_players_move = !!ev.payload.allow_players_move;
      if ("allow_all_move" in ev.payload) state.allow_all_move = !!ev.payload.allow_all_move;
      if ("lockdown" in ev.payload) state.lockdown = !!ev.payload.lockdown;
      if ("background_mode" in ev.payload || "background_url" in ev.payload || "terrain_seed" in ev.payload || "terrain_style" in ev.payload) {
        applyBackgroundState(
          ("background_mode" in ev.payload) ? ev.payload.background_mode : state.background_mode,
          ("background_url" in ev.payload) ? ev.payload.background_url : state.background_url,
          ("terrain_seed" in ev.payload) ? ev.payload.terrain_seed : state.terrain_seed,
          ("terrain_style" in ev.payload) ? ev.payload.terrain_style : state.terrain_style,
        );
      }
      if ("layer_visibility" in ev.payload && ev.payload.layer_visibility) {
        state.layer_visibility = { ...state.layer_visibility, ...ev.payload.layer_visibility };
      }
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "TOKEN_CREATE") {
      const p = ev.payload;
      if (p?.id) {
        const normalized = normalizePackBackedRecord({ ...(state.tokens.get(p.id) || {}), ...p });
        state.tokens.set(p.id, { ...normalized, badges: normalizedBadgeList(normalized?.badges) });
      }
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "TOKEN_MOVE") {
      const p = ev.payload;
      const respSeq = parseMoveSeq(p);
      const isLocalMoveResponse = p?.move_client === localMoveClientId;
      if (isLocalMoveResponse && respSeq !== null && activeDragMoveSeq !== null && respSeq !== activeDragMoveSeq) return;
      const t = state.tokens.get(p.id);
      if (t) {
        t.x = p.x;
        t.y = p.y;
        state.tokens.set(p.id, t);
        requestRender();
      }
      if (p.rejected) {
        if (draggingTokenId === p.id) draggingTokenId = null;
        draggingTokenIds = [];
        dragMoveStartWorld = null;
        dragStartTokenPositions.clear();
        log(`MOVE REJECTED for ${p.id}: ${p.reason}`);
      }
      return;
    }

    if (ev.type === "TOKENS_MOVE") {
      const respSeq = parseMoveSeq(ev.payload);
      const isLocalMoveResponse = ev.payload?.move_client === localMoveClientId;
      if (isLocalMoveResponse && respSeq !== null && activeDragMoveSeq !== null && respSeq !== activeDragMoveSeq) return;
      const moves = Array.isArray(ev.payload?.moves) ? ev.payload.moves : [];
      for (const mv of moves) {
        const t = state.tokens.get(mv.id);
        if (!t) continue;
        t.x = Number(mv.x ?? t.x);
        t.y = Number(mv.y ?? t.y);
        state.tokens.set(mv.id, t);
      }
      if (ev.payload?.rejected) {
        const partial = !!ev.payload?.partial;
        if (!partial) {
          draggingTokenId = null;
          draggingTokenIds = [];
          dragMoveStartWorld = null;
          dragStartTokenPositions.clear();
        }
        const now = Date.now();
        const shouldLog = !partial || !!ev.payload?.commit || (now - lastPartialRejectLogAt > 1200);
        if (shouldLog) {
          const rejectedCount = Array.isArray(ev.payload?.rejected_ids) ? ev.payload.rejected_ids.length : 0;
          const suffix = rejectedCount ? ` (${rejectedCount} blocked)` : "";
          log(`MOVE REJECTED: ${ev.payload.reason || "Not allowed"}${suffix}`);
          if (partial) lastPartialRejectLogAt = now;
        }
      }
      requestRender();
      return;
    }

    if (ev.type === "TOKEN_DELETE") {
      state.tokens.delete(ev.payload.id);
      selectedTokenIds.delete(ev.payload.id);
      if (selectedTokenId === ev.payload.id) selectedTokenId = null;
      if (!selectedTokenId && selectedTokenIds.size) selectedTokenId = Array.from(selectedTokenIds)[0];
      if (hoveredTokenId === ev.payload.id) hoveredTokenId = null;
      refreshGmUI();
      pruneUnusedPackBlobUrls();
      requestRender();
      return;
    }

    if (ev.type === "TOKEN_ASSIGN") {
      const p = ev.payload;
      const t = state.tokens.get(p.id);
      if (t) {
        t.owner_id = p.owner_id ?? null;
        state.tokens.set(p.id, t);
      }
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "TOKEN_RENAME") {
      const p = ev.payload;
      const t = state.tokens.get(p.id);
      if (t) {
        t.name = p.name || t.name;
        state.tokens.set(p.id, t);
      }
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "TOKEN_SET_GROUP") {
      const ids = Array.isArray(ev.payload?.ids) ? ev.payload.ids : [];
      const groupId = ev.payload?.group_id ? String(ev.payload.group_id) : null;
      for (const id of ids) {
        const t = state.tokens.get(id);
        if (!t) continue;
        t.group_id = groupId;
        state.tokens.set(id, t);
      }
      requestRender();
      return;
    }

    if (ev.type === "TOKEN_SET_SIZE") {
      const p = ev.payload;
      const t = state.tokens.get(p.id);
      if (t) {
        t.size_scale = clamp(Number(p.size_scale ?? t.size_scale ?? 1), 0.25, 4);
        state.tokens.set(p.id, t);
      }
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "TOKEN_SET_LOCK") {
      const p = ev.payload;
      const t = state.tokens.get(p.id);
      if (t) {
        t.locked = !!p.locked;
        state.tokens.set(p.id, t);
      }
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "TOKEN_BADGE_TOGGLE") {
      const p = ev.payload;
      const t = state.tokens.get(p.id);
      if (t) {
        t.badges = normalizedBadgeList(p.badges);
        state.tokens.set(p.id, t);
      }
      refreshTokenMenuBadgeButtons();
      requestRender();
      return;
    }

    if (ev.type === "ASSET_INSTANCE_CREATE") {
      const p = ev.payload;
      if (p?.id) {
        state.assets.set(p.id, normalizePackBackedRecord(p));
        state.draw_order.assets = state.draw_order.assets.filter((id) => id !== p.id);
        state.draw_order.assets.push(p.id);
      }
      requestRender();
      return;
    }

    if (ev.type === "ASSET_INSTANCE_UPDATE") {
      const p = ev.payload;
      const respSeq = parseMoveSeq(p);
      const isLocalMoveResponse = p?.move_client === localMoveClientId;
      if (isLocalMoveResponse && respSeq !== null && activeDragMoveSeq !== null && respSeq !== activeDragMoveSeq) return;
      if (isLocalMoveResponse && !p?.commit && respSeq !== null) {
        if (draggingAssetId === p?.id) return;
        if (draggingAssetId === null) return;
      }
      if (p?.id) {
        state.assets.set(p.id, normalizePackBackedRecord({ ...(state.assets.get(p.id) || {}), ...p }));
        if (!state.draw_order.assets.includes(p.id)) state.draw_order.assets.push(p.id);
      }
      requestRender();
      return;
    }

    if (ev.type === "ASSET_INSTANCE_DELETE") {
      const aid = ev.payload?.id;
      state.assets.delete(aid);
      state.draw_order.assets = state.draw_order.assets.filter((id) => id !== aid);
      if (selectedAssetId === aid) selectedAssetId = null;
      if (draggingAssetId === aid) {
        draggingAssetId = null;
        assetDragOrigin = null;
      }
      pruneUnusedPackBlobUrls();
      requestRender();
      return;
    }

    if (ev.type === "STROKE_ADD") {
      const p = ev.payload;
      if (p?.id) {
        state.strokes.set(p.id, normalizeStrokeRecord(p));
        state.draw_order.strokes = state.draw_order.strokes.filter((id) => id !== p.id);
        state.draw_order.strokes.push(p.id);
      }
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "STROKE_DELETE") {
      const ids = ev.payload?.ids || [];
      for (const id of ids) {
        state.strokes.delete(id);
        state.draw_order.strokes = state.draw_order.strokes.filter((x) => x !== id);
      }
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "STROKE_SET_LOCK") {
      const p = ev.payload;
      const s = state.strokes.get(p.id);
      if (s) {
        s.locked = !!p.locked;
        state.strokes.set(p.id, s);
      }
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "ERASE_AT") {
      const strokeIds = ev.payload?.stroke_ids || [];
      const shapeIds = ev.payload?.shape_ids || [];
      const tokenIds = ev.payload?.token_ids || [];
      for (const id of strokeIds) {
        state.strokes.delete(id);
        state.draw_order.strokes = state.draw_order.strokes.filter((x) => x !== id);
      }
      for (const id of shapeIds) {
        state.shapes.delete(id);
        state.draw_order.shapes = state.draw_order.shapes.filter((x) => x !== id);
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
      }
      return;
    }

    if (ev.type === "SHAPE_ADD") {
      const p = ev.payload;
      if (p?.id) {
        state.shapes.set(p.id, normalizeShapeRecord(p));
        state.draw_order.shapes = state.draw_order.shapes.filter((id) => id !== p.id);
        state.draw_order.shapes.push(p.id);
      }
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "SHAPE_UPDATE") {
      const p = ev.payload;
      const respSeq = parseMoveSeq(p);
      const isLocalMoveResponse = p?.move_client === localMoveClientId;
      if (isLocalMoveResponse && respSeq !== null && activeDragMoveSeq !== null && respSeq !== activeDragMoveSeq) return;
      if (isLocalMoveResponse && !p?.commit && respSeq !== null) {
        if (draggingShapeId === p?.id) return;
        if (draggingShapeId === null) return;
      }
      if (p?.id) {
        state.shapes.set(p.id, normalizeShapeRecord({ ...(state.shapes.get(p.id) || {}), ...p }));
        if (!state.draw_order.shapes.includes(p.id)) state.draw_order.shapes.push(p.id);
      }
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "SHAPE_DELETE") {
      const sid = ev.payload?.id;
      state.shapes.delete(sid);
      state.draw_order.shapes = state.draw_order.shapes.filter((x) => x !== sid);
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "SHAPE_SET_LOCK") {
      const p = ev.payload;
      const s = state.shapes.get(p.id);
      if (s) {
        s.locked = !!p.locked;
        state.shapes.set(p.id, s);
      }
      refreshGmUI();
      requestRender();
      return;
    }

    if (ev.type === "TERRAIN_STROKE_ADD") {
      const p = ev.payload;
      if (p?.id) {
        if (state.terrain_paint.strokes[p.id]) {
          if (!state.terrain_paint.undo_stack.includes(p.id)) {
            state.terrain_paint.undo_stack.push(p.id);
          }
          return;
        }
        state.terrain_paint.strokes[p.id] = p;
        if (!state.terrain_paint.undo_stack.includes(p.id)) {
          state.terrain_paint.undo_stack.push(p.id);
        }
        terrainMasks.applyStroke(p);
        requestRender();
      }
      return;
    }

    if (ev.type === "TERRAIN_STROKE_UNDO") {
      const ids = ev.payload?.ids || [];
      for (const id of ids) {
        delete state.terrain_paint.strokes[id];
        state.terrain_paint.undo_stack = state.terrain_paint.undo_stack.filter((x) => x !== id);
      }
      if (ids.length) {
        terrainMasks.rebuildAllFromStrokes();
        requestRender();
      }
      return;
    }

    if (ev.type === "FOG_SET_ENABLED") {
      state.fog_paint.enabled = !!ev.payload?.enabled;
      state.fog_paint.default_mode = ev.payload?.default_mode === "covered" ? "covered" : "clear";
      fogMasks.rebuildAllFromStrokes();
      refreshFogPaintPanel();
      requestRender();
      return;
    }

    if (ev.type === "FOG_RESET") {
      state.fog_paint.enabled = !!ev.payload?.enabled;
      state.fog_paint.default_mode = ev.payload?.default_mode === "covered" ? "covered" : "clear";
      state.fog_paint.strokes = {};
      state.fog_paint.undo_stack = [];
      fogMasks.rebuildAllFromStrokes();
      refreshFogPaintPanel();
      requestRender();
      return;
    }

    if (ev.type === "FOG_STROKE_ADD") {
      const p = ev.payload;
      if (p?.id) {
        if (!state.fog_paint.strokes[p.id]) {
          state.fog_paint.strokes[p.id] = p;
          fogMasks.applyStroke(p);
        }
        if (!state.fog_paint.undo_stack.includes(p.id)) state.fog_paint.undo_stack.push(p.id);
        state.fog_paint.enabled = true;
        refreshFogPaintPanel();
        requestRender();
      }
      return;
    }

    if (ev.type === "ERROR") {
      log(`ERROR: ${ev.payload.message}`);
      return;
    }
    } catch (e) {
      console.error("WS dispatch failed", ev, e);
    }
  };

  refreshSnapshotsPanel();
}
