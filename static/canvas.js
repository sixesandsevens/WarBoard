  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const logEl = document.getElementById("logText");
  const logWrapEl = document.getElementById("log");
  const logToggleEl = document.getElementById("logToggle");

  const roomEl = document.getElementById("room");
  const cidEl = document.getElementById("cid");
  const OFFLINE_STATE_KEY = "warhamster_offline_state_v1";
  let online = false;
  let me = null;

  // If launched from the lobby, auto-fill room from query (?room=xxxx)
  try {
    const qp = new URLSearchParams(location.search);
    const qroom = qp.get("room");
    const qinvite = qp.get("invite");
    if (qroom) roomEl.value = qroom;
    if (!qroom && qinvite) roomEl.value = "";
  } catch(e) {}
  const allowPlayersMoveEl = document.getElementById("allowPlayersMove");
  const allowAllMoveEl = document.getElementById("allowAllMove");
  const lockAssetMoveEl = document.getElementById("lockAssetMove");
  const lockdownEl = document.getElementById("lockdown");
  const bgUrlEl = document.getElementById("bgUrl");
  const bgFileEl = document.getElementById("bgFile");
  const uploadBgEl = document.getElementById("uploadBg");
  const terrainBgEl = document.getElementById("terrainBg");
  const terrainStyleEl = document.getElementById("terrainStyle");
  const worldToneEl = document.getElementById("worldTone");
  const worldToneValEl = document.getElementById("worldToneVal");
  const regenTerrainEl = document.getElementById("regenTerrain");
  const terrainBadgeEl = document.getElementById("terrainBadge");

  const layerGridEl = document.getElementById("layerGrid");
  const layerDrawEl = document.getElementById("layerDraw");
  const layerShapesEl = document.getElementById("layerShapes");
  const layerAssetsEl = document.getElementById("layerAssets");
  const layerTokensEl = document.getElementById("layerTokens");
  const layerInteriorsEl = document.getElementById("layerInteriors");

  const gmPanel = document.getElementById("gmPanel");
  const roomsPanel = document.getElementById("roomsPanel");
  const libraryPanel = document.getElementById("libraryPanel");
  const assetPanel = document.getElementById("assetPanel");
  const tokenMenuEl = document.getElementById("tokenMenu");
  const drawer = document.getElementById("drawer");
  const drawerToggle = document.getElementById("drawerToggle");
  const drawerClose = document.getElementById("drawerClose");
  const mapCtx = document.getElementById("mapCtx");
  const mapCtxBg = document.getElementById("mapCtx-bg");
  const mapCtxLayers = document.getElementById("mapCtx-layers");
  const mapCtxClear = document.getElementById("mapCtx-clear");
  const penCtx = document.getElementById("penCtx");
  const shapeCtx = document.getElementById("shapeCtx");
  const textCtx = document.getElementById("textCtx");
  const rulerCtx = document.getElementById("rulerCtx");
  const assetCtx = document.getElementById("assetCtx");
  const interiorEdgeMenu = document.getElementById("interiorEdgeMenu");
  const interiorCtx = document.getElementById("interiorCtx");
  const assetScaleSliderEl = document.getElementById("assetScaleSlider");
  const assetScaleValueEl = document.getElementById("assetScaleValue");
  const assetRotateSliderEl = document.getElementById("assetRotateSlider");
  const assetRotateValueEl = document.getElementById("assetRotateValue");
  const toolColorPanel = document.getElementById("toolColorPanel");
  const toolColorTitle = document.getElementById("toolColorTitle");
  const toolColorPicker = document.getElementById("toolColorPicker");
  const toolSizePanel = document.getElementById("toolSizePanel");
  const toolSizeTitle = document.getElementById("toolSizeTitle");
  const toolSizeSlider = document.getElementById("toolSizeSlider");
  const toolSizeValue = document.getElementById("toolSizeValue");
  const toolTextPanel = document.getElementById("toolTextPanel");
  const toolTextInput = document.getElementById("toolTextInput");
  const toolTextApply = document.getElementById("toolTextApply");
  const uiTooltip = document.getElementById("uiTooltip");
  const allCtxMenus = [mapCtx, mapCtxBg, mapCtxLayers, mapCtxClear, penCtx, shapeCtx, textCtx, rulerCtx, assetCtx, interiorEdgeMenu, interiorCtx];
  const playerListEl = document.getElementById("playerList");
  const tokenListEl = document.getElementById("tokenList");
  const strokeListEl = document.getElementById("strokeList");
  const shapeListEl = document.getElementById("shapeList");
  const roomsListEl = document.getElementById("roomsList");
  const sessionSummaryTextEl = document.getElementById("sessionSummaryText");
  const sessionRoomsListEl = document.getElementById("sessionRoomsList");
  const sessionMembersListEl = document.getElementById("sessionMembersList");
  const sessionActivityListEl = document.getElementById("sessionActivityList");
  const roomMovePromptEl = document.getElementById("roomMovePrompt");
  const roomMovePromptBackdropEl = document.getElementById("roomMovePromptBackdrop");
  const roomMovePromptTitleEl = document.getElementById("roomMovePromptTitle");
  const roomMovePromptTextEl = document.getElementById("roomMovePromptText");
  const roomMovePromptJoinEl = document.getElementById("roomMovePromptJoin");
  const roomMovePromptDismissEl = document.getElementById("roomMovePromptDismiss");
  const roomMovePromptCloseEl = document.getElementById("roomMovePromptClose");
  const snapshotsListEl = document.getElementById("snapshotsList");
  const snapshotRoomLabelEl = document.getElementById("snapshotRoomLabel");
  const newRoomNameEl = document.getElementById("newRoomName");
  const newRoomIdEl = document.getElementById("newRoomId");
  const newSessionNameEl = document.getElementById("newSessionName");
  const createSessionBtnEl = document.getElementById("createSessionBtn");
  const snapshotLabelInputEl = document.getElementById("snapshotLabelInput");
  const packSelectEl = document.getElementById("packSelect");
  const packSearchEl = document.getElementById("packSearch");
  const packGridEl = document.getElementById("packGrid");
  const assetNameInputEl = document.getElementById("assetNameInput");
  const assetTagsInputEl = document.getElementById("assetTagsInput");
  const assetFileInputEl = document.getElementById("assetFileInput");
  const assetUploadBtnEl = document.getElementById("assetUploadBtn");
  const assetZipInputEl = document.getElementById("assetZipInput");
  const assetZipUploadBtnEl = document.getElementById("assetZipUploadBtn");
  const assetRefreshBtnEl = document.getElementById("assetRefreshBtn");
  const assetModeBrowseBtnEl = document.getElementById("assetModeBrowseBtn");
  const assetModeManageBtnEl = document.getElementById("assetModeManageBtn");
  const assetBrowseViewEl = document.getElementById("assetBrowseView");
  const assetManageViewEl = document.getElementById("assetManageView");
  const assetFiltersToggleBtnEl = document.getElementById("assetFiltersToggleBtn");
  const assetAdvancedFiltersEl = document.getElementById("assetAdvancedFilters");
  const assetSearchInputEl = document.getElementById("assetSearchInput");
  const assetSessionShareBoxEl = document.getElementById("assetSessionShareBox");
  const assetSessionShareSummaryEl = document.getElementById("assetSessionShareSummary");
  const assetSessionShareAllBtnEl = document.getElementById("assetSessionShareAllBtn");
  const assetSessionShareRefreshBtnEl = document.getElementById("assetSessionShareRefreshBtn");
  const assetSessionSharedListEl = document.getElementById("assetSessionSharedList");
  const assetSessionManageWrapEl = document.getElementById("assetSessionManageWrap");
  const assetSessionManageListEl = document.getElementById("assetSessionManageList");
  const assetSearchChipsEl = document.getElementById("assetSearchChips");
  const assetSearchHintEl = document.getElementById("assetSearchHint");
  const assetDebugSummaryEl = document.getElementById("assetDebugSummary");
  const assetViewModeEl = document.getElementById("assetViewMode");
  const assetPackFilterEl = document.getElementById("assetPackFilter");
  const assetTypeFilterEl = document.getElementById("assetTypeFilter");
  const assetAlphaFilterEl = document.getElementById("assetAlphaFilter");
  const assetSizeFilterEl = document.getElementById("assetSizeFilter");
  const assetSortModeEl = document.getElementById("assetSortMode");
  const assetDebugNetEl = document.getElementById("assetDebugNet");
  const assetSetSelectEl = document.getElementById("assetSetSelect");
  const assetSetApplyBtnEl = document.getElementById("assetSetApplyBtn");
  const assetSetSaveBtnEl = document.getElementById("assetSetSaveBtn");
  const assetSetDeleteBtnEl = document.getElementById("assetSetDeleteBtn");
  const assetPlaceModeBtnEl = document.getElementById("assetPlaceModeBtn");
  const assetRecentStripEl = document.getElementById("assetRecentStrip");
  const assetCategoryListEl = document.getElementById("assetCategoryList");
  const assetSubcategorySectionEl = document.getElementById("assetSubcategorySection");
  const assetSubcategoryListEl = document.getElementById("assetSubcategoryList");
  const assetGridStatusEl = document.getElementById("assetGridStatus");
  const assetGridEl = document.getElementById("assetGrid");
  const drawerContentEl = document.querySelector(".drawer-content");

  const toolEl = document.getElementById("tool");
  const toolBtnMove = document.getElementById("toolBtnMove");
  const toolBtnPen = document.getElementById("toolBtnPen");
  const toolBtnShape = document.getElementById("toolBtnShape");
  const toolBtnText = document.getElementById("toolBtnText");
  const toolBtnErase = document.getElementById("toolBtnErase");
  const toolBtnRuler = document.getElementById("toolBtnRuler");
  const toolBtnInterior = document.getElementById("toolBtnInterior");
  const toolBtnTerrainPaint = document.getElementById("toolBtnTerrainPaint");
  const toolBtnFogPaint = document.getElementById("toolBtnFogPaint");
  const terrainPaintPanel = document.getElementById("terrainPaintPanel");
  const fogPaintPanel = document.getElementById("fogPaintPanel");
  const terrainMaterialPillsEl = document.getElementById("terrainMaterialPills");
  const terrainOpPaintBtn = document.getElementById("terrainOpPaint");
  const terrainOpEraseBtn = document.getElementById("terrainOpErase");
  const terrainRadiusSlider = document.getElementById("terrainRadiusSlider");
  const terrainRadiusVal = document.getElementById("terrainRadiusVal");
  const terrainOpacitySlider = document.getElementById("terrainOpacitySlider");
  const terrainOpacityVal = document.getElementById("terrainOpacityVal");
  const terrainHardnessSlider = document.getElementById("terrainHardnessSlider");
  const terrainHardnessVal = document.getElementById("terrainHardnessVal");
  const terrainUndoBtn = document.getElementById("terrainUndoBtn");
  const fogEnabledToggle = document.getElementById("fogEnabledToggle");
  const fogOpRevealBtn = document.getElementById("fogOpReveal");
  const fogOpCoverBtn = document.getElementById("fogOpCover");
  const fogRadiusSlider = document.getElementById("fogRadiusSlider");
  const fogRadiusVal = document.getElementById("fogRadiusVal");
  const fogOpacitySlider = document.getElementById("fogOpacitySlider");
  const fogOpacityVal = document.getElementById("fogOpacityVal");
  const fogHardnessSlider = document.getElementById("fogHardnessSlider");
  const fogHardnessVal = document.getElementById("fogHardnessVal");
  const fogCoverAllBtn = document.getElementById("fogCoverAllBtn");
  const fogClearAllBtn = document.getElementById("fogClearAllBtn");
  const selectModeLabelEl = document.getElementById("selectModeLabel");
  const sessionPill = document.getElementById("sessionPill");
  const sessionResyncBadge = document.getElementById("sessionResyncBadge");
  const sessionModal = document.getElementById("sessionModal");
  const sessionModalBackdrop = document.getElementById("sessionModalBackdrop");
  const sessionModalClose = document.getElementById("sessionModalClose");
  const mapPreviewModal = document.getElementById("mapPreviewModal");
  const mapPreviewBackdrop = document.getElementById("mapPreviewBackdrop");
  const mapPreviewClose = document.getElementById("mapPreviewClose");
  const mapPreviewTitleEl = document.getElementById("mapPreviewTitle");
  const mapPreviewImageEl = document.getElementById("mapPreviewImage");
  const mapPreviewMetaEl = document.getElementById("mapPreviewMeta");
  const mapPreviewPathEl = document.getElementById("mapPreviewPath");
  const mapPreviewSetBgBtn = document.getElementById("mapPreviewSetBgBtn");
  const mapPreviewClearBgBtn = document.getElementById("mapPreviewClearBgBtn");
  const mapPreviewFitBtn = document.getElementById("mapPreviewFitBtn");
  const mapPreviewOverlayBtn = document.getElementById("mapPreviewOverlayBtn");
  const mapPreviewSpawnBtn = document.getElementById("mapPreviewSpawnBtn");
  const mapPreviewCopyUrlBtn = document.getElementById("mapPreviewCopyUrlBtn");
  const mapPreviewOpenTabBtn = document.getElementById("mapPreviewOpenTabBtn");
  const sessionModalTitleEl = document.getElementById("sessionModalTitle");
  const sessionStatusTextEl = document.getElementById("sessionStatusText");
  const sessionAuthBoxEl = document.getElementById("sessionAuthBox");
  const sessionAccountBoxEl = document.getElementById("sessionAccountBox");
  const sessionAuthUserEl = document.getElementById("sessionAuthUser");
  const sessionAuthPassEl = document.getElementById("sessionAuthPass");
  const sessionLoginBtn = document.getElementById("sessionLoginBtn");
  const sessionRegisterBtn = document.getElementById("sessionRegisterBtn");
  const sessionWhoamiEl = document.getElementById("sessionWhoami");
  const sessionOpenLobbyBtn = document.getElementById("sessionOpenLobbyBtn");
  const sessionLogoutBtn = document.getElementById("sessionLogoutBtn");
  const sessionRoomEl = document.getElementById("sessionRoom");
  const sessionClientEl = document.getElementById("sessionClientId");
  const sessionConnectBtn = document.getElementById("sessionConnectBtn");
  const sessionDisconnectBtn = document.getElementById("sessionDisconnectBtn");
  const colorEl = document.getElementById("color");
  const sizeEl = document.getElementById("size");
  const drawLayerBandEl = document.getElementById("drawLayerBand");
  const feetPerSqEl = document.getElementById("feetPerSq");
  const snapEl = document.getElementById("snap");
  const gridEl = document.getElementById("grid");
  const showGridEl = document.getElementById("showGrid");
  const sizePresetButtons = {
    0.5: document.getElementById("sizePresetS"),
    1.0: document.getElementById("sizePresetM"),
    2.0: document.getElementById("sizePresetL"),
    3.0: document.getElementById("sizePresetH"),
  };
  const TOKEN_BADGES = [
    { id: "downed", label: "Downed", color: "#1f1f1f", glyph: "✖", menuId: "tokenMenuBadgeDowned" },
    { id: "poisoned", label: "Poisoned", color: "#2f8f2f", glyph: "P", menuId: "tokenMenuBadgePoisoned" },
    { id: "stunned", label: "Stunned", color: "#d4b000", glyph: "★", menuId: "tokenMenuBadgeStunned" },
    { id: "burning", label: "Burning", color: "#d46a00", glyph: "F", menuId: "tokenMenuBadgeBurning" },
    { id: "bleeding", label: "Bleeding", color: "#b00020", glyph: "B", menuId: "tokenMenuBadgeBleeding" },
    { id: "prone", label: "Prone", color: "#5a5a5a", glyph: "↷", menuId: "tokenMenuBadgeProne" },
  ];
  const TOKEN_BADGE_BY_ID = new Map(TOKEN_BADGES.map((b) => [b.id, b]));
  const TOKEN_BADGE_IDS = new Set(TOKEN_BADGES.map((b) => b.id));
  const tokenMenuRenameBtn = document.getElementById("tokenMenuRename");
  const tokenMenuResizeBtn = document.getElementById("tokenMenuResize");
  const tokenMenuAssignBtn = document.getElementById("tokenMenuAssign");
  const tokenMenuLockBtn = document.getElementById("tokenMenuLock");
  const tokenMenuGroupBtn = document.getElementById("tokenMenuGroup");
  const tokenMenuUngroupBtn = document.getElementById("tokenMenuUngroup");
  const tokenMenuDeleteBtn = document.getElementById("tokenMenuDelete");

  // static/canvas.js is now the bootstrap shell:
  // DOM references, top-level page globals, and shared element handles live here.
  // App behavior, event wiring, and remaining orchestration now live in static/canvas/index.js.
