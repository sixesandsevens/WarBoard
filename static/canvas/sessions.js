// static/canvas/sessions.js — Session, lobby, rooms, room-move, GM panel UI
// Depends on globals from canvas.js: state, online, ws, me, roomEl, cidEl, drawer,
//   heartbeatTimer, staleSyncTimer, lastInboundChangeTs, lastResyncRequestTs, resyncBadgeTimer,
//   seenInboundMutationSinceConnect, bgImage, bgImageUrl, bgImageStatus, ui,
//   draggingTokenId, draggingTokenIds, dragMoveStartWorld, dragStartTokenPositions,
//   draggingAssetId, assetDragOrigin, draggingShapeId, shapeDragOrigin,
//   marqueeSelectRect, dragSpawn, dragSpawnWorld, dragSpawnOverCanvas,
//   activeStroke, activeShapePreview, activeRuler, activePaintStroke, activeFogStroke,
//   selectedTokenId, selectedAssetId, selectedShapeId, hoveredTokenId, isPanning,
//   pointerCaptured, terrain, terrainMasks, fogMasks, players
// Depends on modules: api.js, utils.js (makeId, formatShortTime, escapeHtml, toast),
//   assets.js (assetState, resetAssetSessionPackState, isAssetsTabActive, refreshAssetsPanel,
//              renderAssetSessionSharePanel, pruneUnusedPackBlobUrls)
// Functions called back in canvas.js: send, log, requestRender, connectWS, refreshGmUI,
//   setSelection, closeTokenMenu, hideAllCtx, hideToolPanels, refreshToolButtons,
//   refreshTerrainBadge, setAuthIdentity, loadMe, applyStateSync, currentStateSnapshot,
//   restoreOfflineState, saveOfflineStateNow, scheduleOfflineSave

// ─── State ────────────────────────────────────────────────────────────────────

const playSessionState = {
  id: null,
  name: "",
  user_role: "",
  rooms: [],
  members: [],
  current_room: null,
  activity: [],
};
let pendingRoomMoveOffer = null;
let pendingArrivalNotice = "";

// ─── Session activity ─────────────────────────────────────────────────────────

function addSessionActivity(message, options = {}) {
  const text = String(message || "").trim();
  if (!text) return;
  const entry = {
    id: makeId(),
    message: text,
    ts: Number(options.ts || Date.now()),
    kind: String(options.kind || "notice"),
  };
  const current = Array.isArray(playSessionState.activity) ? playSessionState.activity : [];
  playSessionState.activity = [entry, ...current].slice(0, 18);
  renderSessionSummary();
}

// ─── Session modal ────────────────────────────────────────────────────────────

function openSessionModal() {
  sessionRoomEl.value = roomEl.value.trim() || "demo";
  sessionClientEl.value = cidEl.value.trim() || "player";
  refreshSessionModalAuth();
  sessionModal.classList.remove("hidden");
  sessionModalBackdrop.classList.remove("hidden");
}

function closeSessionModal() {
  sessionModal.classList.add("hidden");
  sessionModalBackdrop.classList.add("hidden");
}

function updateSessionPill() {
  const connected = online && !!(ws && ws.readyState === 1);
  const roomText = (state.room_id || roomEl.value.trim() || "demo");
  const cidText = myId() || "player";
  const role = isGM() ? "GM" : "Player";
  if (connected) {
    sessionPill.textContent = `● Connected - ${roomText} • ${cidText} (${role})`;
    sessionPill.classList.add("ok");
    sessionPill.classList.remove("bad");
    sessionDisconnectBtn.classList.remove("hidden");
  } else {
    sessionPill.textContent = "○ Disconnected - Single Session Mode";
    sessionPill.classList.add("bad");
    sessionPill.classList.remove("ok");
    sessionDisconnectBtn.classList.add("hidden");
  }
}

function refreshSessionModalAuth() {
  const connected = online && !!(ws && ws.readyState === 1);
  if (connected) {
    sessionModalTitleEl.textContent = `Connected - ${state.room_id || roomEl.value.trim() || "room"}`;
    sessionStatusTextEl.textContent = isGM() ? "You are GM in this room." : "You are connected as Player.";
  } else {
    sessionModalTitleEl.textContent = "Disconnected - Single Session Mode";
    sessionStatusTextEl.textContent = "Everything works locally. Log in to host or join a shared room.";
  }
  if (me && me.username) {
    sessionAuthBoxEl.classList.add("hidden");
    sessionAccountBoxEl.classList.remove("hidden");
    sessionWhoamiEl.textContent = `Signed in as ${me.username}`;
  } else {
    sessionAuthBoxEl.classList.remove("hidden");
    sessionAccountBoxEl.classList.add("hidden");
    sessionWhoamiEl.textContent = "";
  }
}

// ─── Resync badge ─────────────────────────────────────────────────────────────

function showResyncBadge() {
  if (!sessionResyncBadge) return;
  sessionResyncBadge.classList.remove("hidden");
  if (resyncBadgeTimer) clearTimeout(resyncBadgeTimer);
  resyncBadgeTimer = setTimeout(() => {
    hideResyncBadge();
  }, 2000);
}

function hideResyncBadge() {
  if (!sessionResyncBadge) return;
  sessionResyncBadge.classList.add("hidden");
  if (resyncBadgeTimer) {
    clearTimeout(resyncBadgeTimer);
    resyncBadgeTimer = null;
  }
}

function ensureStaleWatchdog() {
  if (staleSyncTimer) return;
  staleSyncTimer = setInterval(() => {
    if (!online || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!seenInboundMutationSinceConnect) return;
    const age = Date.now() - lastInboundChangeTs;
    const sinceLastReq = Date.now() - lastResyncRequestTs;
    if (age > 10000 && sinceLastReq > 10000) {
      lastResyncRequestTs = Date.now();
      try {
        showResyncBadge();
        ws.send(JSON.stringify({ type: "REQ_STATE_SYNC", payload: {} }));
        log("No recent updates detected; requested state sync.");
      } catch (e) {
        hideResyncBadge();
        console.error("REQ_STATE_SYNC send failed", e);
      }
    }
  }, 5000);
}

// ─── Play session state management ───────────────────────────────────────────

function clearPlaySessionState() {
  const hadSession = !!playSessionState.id;
  playSessionState.id = null;
  playSessionState.name = "";
  playSessionState.user_role = "";
  playSessionState.rooms = [];
  playSessionState.members = [];
  playSessionState.current_room = null;
  playSessionState.activity = [];
  if (hadSession) {
    assetState.loaded = false;
    resetAssetSessionPackState();
    if (isAssetsTabActive()) refreshAssetsPanel();
  }
}

function applyPlaySessionState(session) {
  const prevSessionId = String(playSessionState.id || "");
  if (!session || typeof session !== "object") {
    clearPlaySessionState();
    closeRoomMovePrompt();
    renderSessionSummary();
    return;
  }
  playSessionState.id = session.id || null;
  playSessionState.name = session.name || "";
  playSessionState.user_role = session.user_role || "";
  playSessionState.rooms = Array.isArray(session.rooms) ? session.rooms : [];
  playSessionState.members = Array.isArray(session.members) ? session.members : [];
  playSessionState.current_room = session.current_room || null;
  if (String(playSessionState.id || "") !== prevSessionId) playSessionState.activity = [];
  if (String(playSessionState.id || "") !== prevSessionId) {
    assetState.loaded = false;
    resetAssetSessionPackState();
    if (isAssetsTabActive()) refreshAssetsPanel();
  } else {
    renderAssetSessionSharePanel();
  }
  renderSessionSummary();
}

async function refreshCurrentSessionState() {
  if (!playSessionState.id) {
    renderSessionSummary();
    return;
  }
  try {
    const session = await apiGet(`/api/sessions/${encodeURIComponent(playSessionState.id)}`);
    applyPlaySessionState(session);
  } catch (e) {
    console.warn("session refresh failed", e);
    renderSessionSummary();
  }
}

// ─── Room move prompt ─────────────────────────────────────────────────────────

function closeRoomMovePrompt() {
  if (roomMovePromptEl) roomMovePromptEl.classList.add("hidden");
  if (roomMovePromptBackdropEl) roomMovePromptBackdropEl.classList.add("hidden");
}

function openRoomMovePrompt() {
  if (!roomMovePromptEl || !roomMovePromptBackdropEl || !pendingRoomMoveOffer) return;
  const move = pendingRoomMoveOffer;
  if (roomMovePromptTitleEl) roomMovePromptTitleEl.textContent = `${move.requested_by || "GM"} wants to move you`;
  if (roomMovePromptTextEl) {
    const bits = [`Destination: ${move.target_room_name || move.target_room_id}`];
    if (move.message) bits.push(move.message);
    roomMovePromptTextEl.textContent = bits.join("\n\n");
  }
  roomMovePromptEl.classList.remove("hidden");
  roomMovePromptBackdropEl.classList.remove("hidden");
}

function setPendingRoomMoveOffer(move) {
  pendingRoomMoveOffer = move || null;
  if (pendingRoomMoveOffer) openRoomMovePrompt();
  else closeRoomMovePrompt();
  renderSessionSummary();
}

// ─── Room transition ──────────────────────────────────────────────────────────

function prepareForRoomTransition() {
  isPanning = false;
  pointerCaptured = false;
  draggingTokenId = null;
  draggingTokenIds = [];
  dragMoveStartWorld = null;
  dragStartTokenPositions.clear();
  draggingAssetId = null;
  assetDragOrigin = null;
  draggingShapeId = null;
  shapeDragOrigin = null;
  marqueeSelectRect = null;
  dragSpawn = null;
  dragSpawnWorld = null;
  dragSpawnOverCanvas = false;
  activeStroke = null;
  activeShapePreview = null;
  activeRuler = null;
  activePaintStroke = null;
  activeFogStroke = null;
  terrainMasks.rebuildAllFromStrokes();
  fogMasks.rebuildAllFromStrokes();
  selectedTokenId = null;
  selectedAssetId = null;
  selectedShapeId = null;
  hoveredTokenId = null;
  setSelection([]);
  closeTokenMenu();
  hideAllCtx();
  hideToolPanels();
  requestRender();
}

async function executeIncomingRoomMove(move, options = {}) {
  if (!move || !move.target_room_id) return;
  setPendingRoomMoveOffer(null);
  if (options.notice) pendingArrivalNotice = options.notice;
  await switchRoom(move.target_room_id);
}

function clearLocalRoomView() {
  prepareForRoomTransition();
  state.room_id = null;
  state.background_mode = "solid";
  state.background_url = null;
  state.terrain_seed = 1;
  state.terrain_style = "grassland";
  bgImage = null;
  bgImageUrl = null;
  bgImageStatus = "idle";
  terrain.seed = null;
  terrain.gridSize = null;
  terrain.style = null;
  terrain.patternA = null;
  terrain.patternB = null;
  terrain.patternC = null;
  terrain.tileA = null;
  terrain.tileB = null;
  terrain.tileC = null;
  state.terrain_paint.strokes = {};
  state.terrain_paint.undo_stack = [];
  state.fog_paint.enabled = false;
  state.fog_paint.default_mode = "clear";
  state.fog_paint.strokes = {};
  state.fog_paint.undo_stack = [];
  terrainMasks.rebuildAllFromStrokes();
  fogMasks.rebuildAllFromStrokes();
  state.tokens.clear();
  state.strokes.clear();
  state.shapes.clear();
  state.assets.clear();
  state.draw_order = { strokes: [], shapes: [], assets: [] };
  selectedTokenId = null;
  selectedAssetId = null;
  selectedShapeId = null;
  setSelection([]);
  hoveredTokenId = null;
  draggingAssetId = null;
  assetDragOrigin = null;
  draggingShapeId = null;
  shapeDragOrigin = null;
  dragSpawn = null;
  dragSpawnWorld = null;
  dragSpawnOverCanvas = false;
  pruneUnusedPackBlobUrls();
  requestRender();
}

async function switchRoom(newRoomId) {
  const priorRoomId = roomEl.value.trim();
  prepareForRoomTransition();
  roomEl.value = newRoomId;
  snapshotRoomLabelEl.textContent = newRoomId;
  await refreshSnapshotsPanel();
  if (playSessionState.id && priorRoomId && priorRoomId !== newRoomId) {
    const nextRoom = playSessionState.rooms.find((room) => room.id === newRoomId);
    addSessionActivity(`Switching from ${priorRoomId} to ${nextRoom?.display_name || newRoomId}.`, { kind: "switch" });
  }
  connectWS(true);
}

// ─── Session summary panel ────────────────────────────────────────────────────

function renderSessionSummary() {
  if (!sessionSummaryTextEl || !sessionRoomsListEl || !sessionMembersListEl || !sessionActivityListEl) return;
  const hasSession = !!playSessionState.id;
  if (!hasSession) {
    sessionSummaryTextEl.textContent = pendingRoomMoveOffer
      ? `Pending move offer to ${pendingRoomMoveOffer.target_room_name || pendingRoomMoveOffer.target_room_id}`
      : "No session attached to this room yet.";
    sessionRoomsListEl.innerHTML = `<div style="opacity:.7">(standalone room)</div>`;
    sessionMembersListEl.innerHTML = `<div style="opacity:.7">(no session roster)</div>`;
    sessionActivityListEl.innerHTML = `<div style="opacity:.7">(no session activity)</div>`;
    if (createSessionBtnEl) {
      createSessionBtnEl.disabled = !isGM();
      createSessionBtnEl.textContent = "Create Session Here";
    }
    if (newSessionNameEl) newSessionNameEl.disabled = !isGM();
    return;
  }
  const currentRoomName = playSessionState.current_room?.display_name || roomEl.value.trim() || "Current Room";
  const role = String(playSessionState.user_role || "player").replace(/_/g, " ");
  const pendingSuffix = pendingRoomMoveOffer ? ` • pending move to ${pendingRoomMoveOffer.target_room_name || pendingRoomMoveOffer.target_room_id}` : "";
  sessionSummaryTextEl.textContent = `${playSessionState.name} • ${currentRoomName} • ${role}${pendingSuffix}`;
  if (createSessionBtnEl) {
    createSessionBtnEl.disabled = true;
    createSessionBtnEl.textContent = "Session Attached";
  }
  if (newSessionNameEl) newSessionNameEl.disabled = true;

  const canManageSession = ["gm", "co_gm"].includes(String(playSessionState.user_role || ""));
  const roomRows = playSessionState.rooms.map((room) => {
    const current = room.id === (state.room_id || roomEl.value.trim());
    const occupancy = Number(room.occupancy_count || 0);
    const moveButtons = canManageSession && !current
      ? `<button data-session-request="${room.id}" style="padding:2px 6px;">Request</button><button data-session-force="${room.id}" style="padding:2px 6px;">Force</button>`
      : "";
    return `
      <div style="display:flex; gap:6px; align-items:center; margin:4px 0; flex-wrap:wrap; ${current ? "background:rgba(91,156,246,0.14); border-radius:8px; padding:4px;" : ""}">
        <button data-session-open="${room.id}" style="padding:2px 6px;">Go</button>
        <button data-session-copy="${room.id}" style="padding:2px 6px;">Copy Link</button>
        ${moveButtons}
        <span style="font-weight:${current ? 700 : 500};">${room.display_name || room.id}</span>
        <span style="opacity:.65;">${occupancy} online</span>
        ${current ? '<span style="opacity:.75;">Current</span>' : ''}
      </div>
    `;
  });
  sessionRoomsListEl.innerHTML = roomRows.join("") || `<div style="opacity:.7">(no session rooms)</div>`;
  sessionRoomsListEl.querySelectorAll("button[data-session-open]").forEach((btn) => {
    btn.onclick = () => switchRoom(btn.getAttribute("data-session-open"));
  });
  sessionRoomsListEl.querySelectorAll("button[data-session-copy]").forEach((btn) => {
    btn.onclick = async () => {
      const rid = btn.getAttribute("data-session-copy");
      const room = playSessionState.rooms.find((entry) => entry.id === rid);
      if (!room || !room.join_code) return;
      const link = `${location.origin}/join/${room.join_code}`;
      try {
        await navigator.clipboard.writeText(link);
        log(`JOIN LINK COPIED ${room.join_code}`);
      } catch (_) {
        log(`JOIN LINK: ${link}`);
      }
    };
  });
  sessionRoomsListEl.querySelectorAll("button[data-session-request]").forEach((btn) => {
    btn.onclick = () => {
      const rid = btn.getAttribute("data-session-request");
      const room = playSessionState.rooms.find((entry) => entry.id === rid);
      if (!room || !playSessionState.id) return;
      const message = prompt(`Request players join ${room.display_name || rid}? Optional message:`, "") || "";
      send("SESSION_ROOM_MOVE_REQUEST", {
        session_id: playSessionState.id,
        target_room_id: rid,
        message,
      });
      log(`ROOM MOVE REQUEST ${rid}`);
    };
  });
  sessionRoomsListEl.querySelectorAll("button[data-session-force]").forEach((btn) => {
    btn.onclick = () => {
      const rid = btn.getAttribute("data-session-force");
      const room = playSessionState.rooms.find((entry) => entry.id === rid);
      if (!room || !playSessionState.id) return;
      const message = prompt(`Force-move players to ${room.display_name || rid}? Optional message:`, "") || "";
      send("SESSION_ROOM_MOVE_FORCE", {
        session_id: playSessionState.id,
        target_room_id: rid,
        message,
      });
      log(`ROOM MOVE FORCE ${rid}`);
    };
  });

  const memberRows = playSessionState.members.map((member) => `
    <div style="display:flex; gap:6px; align-items:center; justify-content:space-between; margin:4px 0; flex-wrap:wrap;">
      <div style="display:flex; gap:6px; align-items:center; min-width:0;">
        <span>${member.username || "User"}</span>
        <span style="opacity:.9; text-transform:capitalize; border:1px solid rgba(255,255,255,0.16); border-radius:999px; padding:1px 6px; font-size:11px;">${String(member.role || "player").replace(/_/g, " ")}</span>
      </div>
      <span style="opacity:.65;">${escapeHtml(String(member.current_room_name || "Away from session room"))}</span>
    </div>
  `);
  sessionMembersListEl.innerHTML = memberRows.join("") || `<div style="opacity:.7">(no members)</div>`;
  const activityRows = (Array.isArray(playSessionState.activity) ? playSessionState.activity : []).map((entry) => `
    <div style="display:flex; gap:8px; align-items:flex-start; margin:4px 0;">
      <span style="opacity:.55; min-width:52px;">${escapeHtml(formatShortTime(entry.ts))}</span>
      <span style="opacity:.92;">${escapeHtml(String(entry.message || ""))}</span>
    </div>
  `);
  sessionActivityListEl.innerHTML = activityRows.join("") || `<div style="opacity:.7">(no session activity yet)</div>`;
}

// ─── GM panel ─────────────────────────────────────────────────────────────────

function refreshGmUI() {
  const gm = isGM();

  allowPlayersMoveEl.disabled = !gm;
  allowAllMoveEl.disabled = !gm;
  lockdownEl.disabled = !gm;
  bgUrlEl.disabled = !gm;
  bgFileEl.disabled = !gm;
  uploadBgEl.disabled = !gm;
  terrainBgEl.disabled = !gm;
  terrainStyleEl.disabled = !gm;
  document.getElementById("setBg").disabled = !gm;
  regenTerrainEl.disabled = !gm;
  document.getElementById("undo").disabled = !gm;
  document.getElementById("redo").disabled = !gm;

  [layerGridEl, layerDrawEl, layerShapesEl, layerAssetsEl, layerTokensEl].forEach((el) => { el.disabled = !gm; });

  allowPlayersMoveEl.checked = !!state.allow_players_move;
  allowAllMoveEl.checked = !!state.allow_all_move;
  if (lockAssetMoveEl) lockAssetMoveEl.checked = !!ui.lockAssetMove;
  lockdownEl.checked = !!state.lockdown;
  layerGridEl.checked = !!state.layer_visibility.grid;
  layerDrawEl.checked = !!state.layer_visibility.drawings;
  layerShapesEl.checked = !!state.layer_visibility.shapes;
  layerAssetsEl.checked = !!state.layer_visibility.assets;
  layerTokensEl.checked = !!state.layer_visibility.tokens;
  bgUrlEl.value = state.background_url || "";
  terrainBgEl.checked = state.background_mode === "terrain";
  terrainStyleEl.value = state.terrain_style || "grassland";
  refreshTerrainBadge();
  if (toolBtnTerrainPaint) toolBtnTerrainPaint.classList.toggle("hidden", !gm);
  if (toolBtnFogPaint) toolBtnFogPaint.classList.toggle("hidden", !gm);

  const arr = Array.from(players).sort();
  playerListEl.innerHTML = arr.map((id) => {
    const tag = id === state.gm_id ? " (GM)" : state.co_gm_ids.includes(id) ? " (co-GM)" : "";
    return `<div>${id}${tag}</div>`;
  }).join("") || `<div style="opacity:.7">(none yet)</div>`;

  const coGmSection = document.getElementById("coGmSection");
  const coGmHr = document.getElementById("coGmHr");
  const isPrimary = isPrimaryGM();
  if (coGmSection) coGmSection.style.display = isPrimary ? "" : "none";
  if (coGmHr) coGmHr.style.display = isPrimary ? "" : "none";
  if (isPrimary) {
    const coGmListEl = document.getElementById("coGmList");
    const coGmPromoteListEl = document.getElementById("coGmPromoteList");
    if (coGmListEl) {
      coGmListEl.innerHTML = state.co_gm_ids.length
        ? state.co_gm_ids.map((id) =>
            `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
              <span>${id}</span>
              <button style="font-size:11px;padding:1px 6px;" data-cogm-demote="${id}">Demote</button>
            </div>`
          ).join("")
        : `<div style="opacity:.7">(none)</div>`;
      coGmListEl.querySelectorAll("[data-cogm-demote]").forEach((btn) => {
        btn.addEventListener("click", () => {
          send("COGM_REMOVE", { target_id: btn.dataset.cogmDemote });
        });
      });
    }
    if (coGmPromoteListEl) {
      const promotable = arr.filter((id) => id !== state.gm_id && !state.co_gm_ids.includes(id));
      coGmPromoteListEl.innerHTML = promotable.length
        ? `<div style="opacity:.7;font-size:11px;margin-bottom:3px;">Promote a player:</div>` +
          promotable.map((id) =>
            `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
              <span>${id}</span>
              <button style="font-size:11px;padding:1px 6px;" data-cogm-promote="${id}">Promote</button>
            </div>`
          ).join("")
        : `<div style="opacity:.7;font-size:11px;">(no players to promote)</div>`;
      coGmPromoteListEl.querySelectorAll("[data-cogm-promote]").forEach((btn) => {
        btn.addEventListener("click", () => {
          send("COGM_ADD", { target_id: btn.dataset.cogmPromote });
        });
      });
    }
  }

  if (!gm) {
    tokenListEl.innerHTML = `<div style="opacity:.7">Only GM can edit token ownership/locks.</div>`;
    strokeListEl.innerHTML = `<div style="opacity:.7">Only GM can lock strokes.</div>`;
    shapeListEl.innerHTML = `<div style="opacity:.7">Only GM can lock shapes.</div>`;
    return;
  }

  const ownerOptions = ["", ...arr];
  const tokenRows = [];
  for (const [id, t] of state.tokens) {
    const opts = ownerOptions.map((o) => {
      const label = o === "" ? "(unassigned)" : o;
      const sel = ((t.owner_id || "") === o) ? "selected" : "";
      return `<option value="${o}" ${sel}>${label}</option>`;
    }).join("");

    const lockChecked = t.locked ? "checked" : "";
    tokenRows.push(`
      <div style="display:flex; gap:8px; align-items:center; margin:6px 0;">
        <div style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          <span>${t.name || id}</span> <span style="opacity:.6">(${id.slice(0,8)})</span>
        </div>
        <select data-token-owner="${id}" style="padding:4px;">${opts}</select>
        <label style="font-size:12px;"><input type="checkbox" data-token-lock="${id}" ${lockChecked}> lock</label>
      </div>
    `);
  }
  tokenListEl.innerHTML = tokenRows.join("") || `<div style="opacity:.7">(no tokens)</div>`;

  tokenListEl.querySelectorAll("select[data-token-owner]").forEach((sel) => {
    sel.onchange = () => send("TOKEN_ASSIGN", { id: sel.getAttribute("data-token-owner"), owner_id: sel.value.trim() || null });
  });
  tokenListEl.querySelectorAll("input[data-token-lock]").forEach((chk) => {
    chk.onchange = () => send("TOKEN_SET_LOCK", { id: chk.getAttribute("data-token-lock"), locked: chk.checked });
  });

  const strokeRows = [];
  for (const [id, s] of state.strokes) {
    const lockChecked = s.locked ? "checked" : "";
    strokeRows.push(`<div style="display:flex; justify-content:space-between; margin:4px 0;"><span>${id.slice(0, 12)}</span><label style="font-size:12px;"><input type="checkbox" data-stroke-lock="${id}" ${lockChecked}> lock</label></div>`);
  }
  strokeListEl.innerHTML = strokeRows.join("") || `<div style="opacity:.7">(no strokes)</div>`;
  strokeListEl.querySelectorAll("input[data-stroke-lock]").forEach((chk) => {
    chk.onchange = () => send("STROKE_SET_LOCK", { id: chk.getAttribute("data-stroke-lock"), locked: chk.checked });
  });

  const shapeRows = [];
  for (const [id, s] of state.shapes) {
    const lockChecked = s.locked ? "checked" : "";
    shapeRows.push(`<div style="display:flex; justify-content:space-between; margin:4px 0;"><span>${s.type} ${id.slice(0, 12)}</span><label style="font-size:12px;"><input type="checkbox" data-shape-lock="${id}" ${lockChecked}> lock</label></div>`);
  }
  shapeListEl.innerHTML = shapeRows.join("") || `<div style="opacity:.7">(no shapes)</div>`;
  shapeListEl.querySelectorAll("input[data-shape-lock]").forEach((chk) => {
    chk.onchange = () => send("SHAPE_SET_LOCK", { id: chk.getAttribute("data-shape-lock"), locked: chk.checked });
  });
}

// ─── Rooms & snapshots panels ─────────────────────────────────────────────────

async function refreshRoomsPanel() {
  try {
    const data = await apiGet("/api/my/rooms");
    const rooms = data.rooms || [];
    await refreshCurrentSessionState();
    const rows = rooms.map((r) => `
      <div style="display:flex; gap:8px; align-items:center; margin:4px 0;">
        <button data-open-room="${r.room_id}" style="padding:2px 6px;">Open</button>
        <button data-copy-join="${r.room_id}" style="padding:2px 6px;">Copy Join Link</button>
        <button data-rename-room="${r.room_id}" style="padding:2px 6px;">Rename</button>
        <button data-delete-room="${r.room_id}" style="padding:2px 6px; color:#ffb3b3;">Delete</button>
        <code>${r.room_id}</code>
        <span style="opacity:.9">${r.display_name || r.name}</span>
        <span style="opacity:.7">${r.role === "owner" ? "GM" : "Player"}</span>
        <span style="opacity:.6">${r.session_id ? "session" : "standalone"}</span>
        <span style="opacity:.6">${(r.join_code || "").trim() ? "join " + r.join_code : ""}</span>
        <span style="opacity:.6">${(r.created_at || "").replace("T", " ").slice(0, 19)}</span>
      </div>
    `);
    roomsListEl.innerHTML = rows.join("") || `<div style="opacity:.7">(no rooms)</div>`;
    roomsListEl.querySelectorAll("button[data-open-room]").forEach((btn) => {
      btn.onclick = () => switchRoom(btn.getAttribute("data-open-room"));
    });
    roomsListEl.querySelectorAll("button[data-copy-join]").forEach((btn) => {
      btn.onclick = async () => {
        const rid = btn.getAttribute("data-copy-join");
        const room = rooms.find((x) => x.room_id === rid);
        if (!room || !room.join_code) {
          log(`JOIN LINK ERROR: no join code for room ${rid}`);
          return;
        }
        const link = `${location.origin}/join/${room.join_code}`;
        try {
          await navigator.clipboard.writeText(link);
          log(`JOIN LINK COPIED ${room.join_code}`);
        } catch (e) {
          log(`JOIN LINK: ${link}`);
        }
      };
    });
    roomsListEl.querySelectorAll("button[data-rename-room]").forEach((btn) => {
      btn.onclick = async () => {
        const rid = btn.getAttribute("data-rename-room");
        const next = prompt("New room name?", "") || "";
        const name = next.trim();
        if (!name) return;
        try {
          await apiPatch(`/api/rooms/${encodeURIComponent(rid)}`, { name }, true);
          log(`ROOM RENAMED ${rid} -> ${name}`);
          await refreshRoomsPanel();
        } catch (e) {
          log(`RENAME ROOM ERROR: ${e.message || e}`);
        }
      };
    });
    roomsListEl.querySelectorAll("button[data-delete-room]").forEach((btn) => {
      btn.onclick = async () => {
        const rid = btn.getAttribute("data-delete-room");
        if (!confirm(`Delete room '${rid}'? This also deletes snapshots.`)) return;
        try {
          const url = apiUrl(`/api/rooms/${encodeURIComponent(rid)}`, true);
          const res = await fetch(url, { method: "DELETE" });
          if (!res.ok) throw new Error(await res.text());
          log(`ROOM DELETED ${rid}`);
          await refreshRoomsPanel();
          if (roomEl.value.trim() === rid) {
            roomEl.value = "";
            snapshotRoomLabelEl.textContent = "(none)";
            snapshotsListEl.innerHTML = `<div style="opacity:.7">(room deleted)</div>`;
          }
        } catch (e) {
          log(`DELETE ROOM ERROR: ${e.message || e}`);
        }
      };
    });
  } catch (e) {
    roomsListEl.innerHTML = `<div style="color:#ffb3b3">Rooms load failed</div>`;
    log(`ROOMS ERROR: ${e.message || e}`);
  }
}

async function refreshSnapshotsPanel() {
  const rid = roomEl.value.trim();
  snapshotRoomLabelEl.textContent = rid || "(none)";
  if (!rid) {
    snapshotsListEl.innerHTML = `<div style="opacity:.7">(enter room id)</div>`;
    return;
  }
  try {
    const data = await apiGet(`/api/rooms/${encodeURIComponent(rid)}/snapshots`);
    const snaps = data.snapshots || [];
    const rows = snaps.map((s) => `
      <div style="display:flex; gap:8px; align-items:center; margin:4px 0;">
        <button data-restore-snap="${s.snapshot_id}" style="padding:2px 6px;">Restore</button>
        <code>${s.snapshot_id}</code>
        <span style="opacity:.9">${s.label}</span>
        <span style="opacity:.6">${(s.created_at || "").replace("T", " ").slice(0, 19)}</span>
      </div>
    `);
    snapshotsListEl.innerHTML = rows.join("") || `<div style="opacity:.7">(no snapshots)</div>`;
    snapshotsListEl.querySelectorAll("button[data-restore-snap]").forEach((btn) => {
      btn.onclick = async () => {
        const sid = btn.getAttribute("data-restore-snap");
        try {
          await apiPost(`/api/rooms/${encodeURIComponent(rid)}/restore/${encodeURIComponent(sid)}`, {}, true);
          log(`RESTORED snapshot ${sid}`);
          await refreshSnapshotsPanel();
        } catch (e) {
          log(`RESTORE ERROR: ${e.message || e}`);
        }
      };
    });
  } catch (e) {
    snapshotsListEl.innerHTML = `<div style="color:#ffb3b3">Snapshots load failed</div>`;
    log(`SNAPSHOTS ERROR: ${e.message || e}`);
  }
}

// ─── Event bindings (called from canvas.js after DOM consts are declared) ─────

function initSessionBindings() {
  if (sessionPill) sessionPill.addEventListener("click", openSessionModal);
  if (sessionModalClose) sessionModalClose.addEventListener("click", closeSessionModal);
  if (sessionModalBackdrop) sessionModalBackdrop.addEventListener("click", closeSessionModal);
  if (sessionLoginBtn) sessionLoginBtn.addEventListener("click", async () => {
    const username = sessionAuthUserEl.value.trim();
    const password = sessionAuthPassEl.value;
    if (!username || !password) { log("LOGIN ERROR: username and password required"); return; }
    try {
      await apiPost("/api/auth/login", { username, password });
      const user = await loadMe();
      if (user?.username) {
        log(`Logged in as ${user.username}`);
        refreshSessionModalAuth();
        updateSessionPill();
      }
    } catch (e) {
      log(`LOGIN ERROR: ${e.message || e}`);
    }
  });
  if (sessionRegisterBtn) sessionRegisterBtn.addEventListener("click", async () => {
    const username = sessionAuthUserEl.value.trim();
    const password = sessionAuthPassEl.value;
    if (!username || !password) { log("REGISTER ERROR: username and password required"); return; }
    try {
      await apiPost("/api/auth/register", { username, password });
      const user = await loadMe();
      if (user?.username) {
        log(`Registered and logged in as ${user.username}`);
        refreshSessionModalAuth();
        updateSessionPill();
      }
    } catch (e) {
      log(`REGISTER ERROR: ${e.message || e}`);
    }
  });
  if (sessionOpenLobbyBtn) sessionOpenLobbyBtn.addEventListener("click", () => {
    location.href = "/static/app.html";
  });
  if (sessionLogoutBtn) sessionLogoutBtn.addEventListener("click", async () => {
    try {
      await apiPost("/api/auth/logout", {});
    } catch (e) {}
    setAuthIdentity(null);
    online = false;
    if (ws && ws.readyState === 1) {
      try { ws.close(); } catch {}
    }
    ensureOfflineGm();
    refreshSessionModalAuth();
    updateSessionPill();
  });
  if (sessionConnectBtn) sessionConnectBtn.addEventListener("click", () => {
    roomEl.value = sessionRoomEl.value.trim() || "demo";
    if (!me || !me.username) { log("Connect blocked: log in first."); return; }
    cidEl.value = me.username;
    connectWS(true);
    closeSessionModal();
  });
  if (sessionDisconnectBtn) sessionDisconnectBtn.addEventListener("click", () => {
    if (ws && (ws.readyState === 0 || ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
      try { ws.close(); } catch {}
    }
    ws = null;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    updateSessionPill();
  });
  [sessionRoomEl, sessionClientEl].filter(Boolean).forEach((inp) => {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (me && me.username) sessionConnectBtn.click();
        else sessionLoginBtn.click();
      }
    });
  });
  const gmPanelBtnEl = document.getElementById("gmPanelBtn");
  if (gmPanelBtnEl) gmPanelBtnEl.onclick = () => {
    activateDrawerTab("players", true);
    refreshGmUI();
  };
  const gmPanelCloseBtnEl = document.getElementById("gmPanelClose");
  if (gmPanelCloseBtnEl) gmPanelCloseBtnEl.onclick = () => { drawer.classList.add("hidden"); };
  const roomsPanelBtnEl = document.getElementById("roomsPanelBtn");
  if (roomsPanelBtnEl) roomsPanelBtnEl.onclick = async () => {
    activateDrawerTab("rooms", true);
    await refreshCurrentSessionState();
    await refreshRoomsPanel();
    await refreshSnapshotsPanel();
  };
  const roomsPanelCloseBtnEl = document.getElementById("roomsPanelClose");
  if (roomsPanelCloseBtnEl) roomsPanelCloseBtnEl.onclick = () => { drawer.classList.add("hidden"); };
  if (roomMovePromptJoinEl) roomMovePromptJoinEl.onclick = async () => {
    if (!pendingRoomMoveOffer) return;
    const move = pendingRoomMoveOffer;
    try {
      send("SESSION_ROOM_MOVE_ACCEPT", {
        session_id: move.session_id,
        target_room_id: move.target_room_id,
      });
    } catch (_) {}
    await executeIncomingRoomMove(move, {
      notice: `Joining ${move.target_room_name || move.target_room_id}.`,
    });
  };
  if (roomMovePromptDismissEl) roomMovePromptDismissEl.onclick = () => closeRoomMovePrompt();
  if (roomMovePromptCloseEl) roomMovePromptCloseEl.onclick = () => closeRoomMovePrompt();
  if (roomMovePromptBackdropEl) roomMovePromptBackdropEl.onclick = () => closeRoomMovePrompt();
  if (createSessionBtnEl) createSessionBtnEl.onclick = async () => {
    const rid = roomEl.value.trim();
    if (!rid) { log("CREATE SESSION ERROR: connect to a room first"); return; }
    if (playSessionState.id) { log(`SESSION READY ${playSessionState.name}`); return; }
    const name = newSessionNameEl?.value.trim() || "";
    try {
      const session = await apiPost(`/api/rooms/${encodeURIComponent(rid)}/attach-session`, { name });
      applyPlaySessionState(session);
      log(`SESSION CREATED ${session.id}`);
      addSessionActivity(`Session ${session.name || session.id} attached to this room.`, { kind: "session_create" });
      await refreshRoomsPanel();
    } catch (e) {
      log(`CREATE SESSION ERROR: ${e.message || e}`);
    }
  };
  document.getElementById("saveSnapshotBtn").onclick = async () => {
    const rid = roomEl.value.trim();
    if (!rid) { log("SAVE POINT ERROR: room id required"); return; }
    const label = snapshotLabelInputEl.value.trim();
    try {
      const snap = await apiPost(`/api/rooms/${encodeURIComponent(rid)}/snapshots`, { label }, true);
      log(`SAVE POINT ${snap.snapshot_id}`);
      await refreshSnapshotsPanel();
    } catch (e) {
      log(`SAVE POINT ERROR: ${e.message || e}`);
    }
  };
  document.getElementById("refreshRoomsBtn").onclick = () => refreshRoomsPanel();
  document.getElementById("refreshSnapshotsBtn").onclick = () => refreshSnapshotsPanel();
  document.getElementById("createRoomBtn").onclick = async () => {
    const name = newRoomNameEl.value.trim();
    const roomId = newRoomIdEl.value.trim();
    try {
      const created = playSessionState.id
        ? await apiPost(`/api/sessions/${encodeURIComponent(playSessionState.id)}/rooms`, { name, room_id: roomId })
        : await apiPost("/api/rooms", { name, room_id: roomId });
      log(`ROOM CREATED ${created.room_id}`);
      if (playSessionState.id) addSessionActivity(`Created room ${name || created.room_id}.`, { kind: "room_create" });
      if (created.room_id) await switchRoom(created.room_id);
      await refreshCurrentSessionState();
      await refreshRoomsPanel();
      await refreshSnapshotsPanel();
    } catch (e) {
      log(`CREATE ROOM ERROR: ${e.message || e}`);
    }
  };
  roomEl.addEventListener("change", () => {
    snapshotRoomLabelEl.textContent = roomEl.value.trim();
    refreshSnapshotsPanel();
  });
  allowPlayersMoveEl.addEventListener("change", (e) => send("ROOM_SETTINGS", { allow_players_move: e.target.checked }));
  allowAllMoveEl.addEventListener("change", (e) => send("ROOM_SETTINGS", { allow_all_move: e.target.checked }));
  if (lockAssetMoveEl) lockAssetMoveEl.addEventListener("change", (e) => {
    ui.lockAssetMove = !!e.target.checked;
    try {
      localStorage.setItem("warhamster:v1:lock_asset_move", ui.lockAssetMove ? "1" : "0");
    } catch (_) {}
    if (ui.lockAssetMove) {
      draggingAssetId = null;
      assetDragOrigin = null;
      selectedAssetId = null;
    }
    updateCanvasCursor();
    requestRender();
  });
  lockdownEl.addEventListener("change", (e) => send("ROOM_SETTINGS", { lockdown: e.target.checked }));
  document.getElementById("setBg").addEventListener("click", () => {
    const nextUrl = bgUrlEl.value.trim() || null;
    send("ROOM_SETTINGS", {
      background_url: nextUrl,
      background_mode: nextUrl ? "url" : "solid",
    });
  });
  uploadBgEl.addEventListener("click", async () => {
    if (!isGM()) { log("Upload BG ERROR: GM only"); return; }
    const rid = roomEl.value.trim();
    if (!rid) { log("Upload BG ERROR: room id required"); return; }
    const file = bgFileEl.files && bgFileEl.files[0];
    if (!file) { log("Upload BG ERROR: choose an image file first"); return; }
    try {
      const out = await apiUploadBackground(rid, file);
      const nextUrl = String(out.url || "").trim();
      if (!nextUrl) throw new Error("Missing image URL from server");
      bgUrlEl.value = nextUrl;
      send("ROOM_SETTINGS", { background_url: nextUrl, background_mode: "url" });
      bgFileEl.value = "";
      log("Background uploaded.");
    } catch (e) {
      log(`Upload BG ERROR: ${e.message || e}`);
    }
  });
  terrainBgEl.addEventListener("change", (e) => {
    if (e.target.checked) {
      send("ROOM_SETTINGS", { background_mode: "terrain", terrain_style: terrainStyleEl.value });
      return;
    }
    const nextUrl = (state.background_url || "").trim() || null;
    send("ROOM_SETTINGS", { background_mode: nextUrl ? "url" : "solid" });
  });
  terrainStyleEl.addEventListener("change", () => {
    send("ROOM_SETTINGS", { background_mode: "terrain", terrain_style: terrainStyleEl.value });
  });
  regenTerrainEl.addEventListener("click", () => {
    send("ROOM_SETTINGS", { background_mode: "terrain", terrain_seed: randomTerrainSeed(), terrain_style: terrainStyleEl.value });
  });
  function sendLayerVisibility() {
    send("ROOM_SETTINGS", {
      layer_visibility: {
        grid: layerGridEl.checked,
        drawings: layerDrawEl.checked,
        shapes: layerShapesEl.checked,
        assets: layerAssetsEl.checked,
        tokens: layerTokensEl.checked,
      },
    });
  }
  layerGridEl.addEventListener("change", sendLayerVisibility);
  layerDrawEl.addEventListener("change", sendLayerVisibility);
  layerShapesEl.addEventListener("change", sendLayerVisibility);
  layerAssetsEl.addEventListener("change", sendLayerVisibility);
  layerTokensEl.addEventListener("change", sendLayerVisibility);
}
