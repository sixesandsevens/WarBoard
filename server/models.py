from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field


EventType = Literal[
    "HEARTBEAT",
    "REQ_STATE_SYNC",
    "HELLO",
    "PRESENCE",
    "STATE_SYNC",
    "ROOM_SETTINGS",
    "UNDO",
    "REDO",
    "TOKEN_CREATE",
    "TOKEN_MOVE",
    "TOKENS_MOVE",
    "TOKEN_DELETE",
    "TOKEN_RENAME",
    "TOKEN_SET_SIZE",
    "TOKEN_ASSIGN",
    "TOKEN_SET_LOCK",
    "TOKEN_SET_GROUP",
    "TOKEN_BADGE_TOGGLE",
    "STROKE_ADD",
    "STROKE_DELETE",
    "STROKE_SET_LOCK",
    "ERASE_AT",
    "SHAPE_ADD",
    "SHAPE_UPDATE",
    "SHAPE_DELETE",
    "SHAPE_SET_LOCK",
    "ASSET_INSTANCE_CREATE",
    "ASSET_INSTANCE_UPDATE",
    "ASSET_INSTANCE_DELETE",
    "TERRAIN_STROKE_ADD",
    "TERRAIN_STROKE_UNDO",
    "FOG_STATE_SYNC",
    "FOG_STROKE_ADD",
    "FOG_RESET",
    "FOG_SET_ENABLED",
    "COGM_ADD",
    "COGM_REMOVE",
    "COGM_UPDATE",
    "SESSION_ROOM_MOVE_REQUEST",
    "SESSION_ROOM_MOVE_FORCE",
    "SESSION_ROOM_MOVE_OFFER",
    "SESSION_ROOM_MOVE_EXECUTE",
    "SESSION_ROOM_MOVE_ACCEPT",
    "SESSION_SYSTEM_NOTICE",
    "ERROR",
]


class Token(BaseModel):
    id: str
    x: float
    y: float
    name: str = "Token"
    color: str = "#ffffff"
    image_url: Optional[str] = None
    asset_id: Optional[str] = None
    source: Optional[Literal["upload", "pack"]] = None
    pack_slug: Optional[str] = None
    mime: Optional[str] = None
    ext: Optional[str] = None
    size_scale: float = 1.0
    owner_id: Optional[str] = None
    group_id: Optional[str] = None
    creator_id: Optional[str] = None
    locked: bool = False
    badges: List[str] = Field(default_factory=list)


class Point(BaseModel):
    x: float
    y: float


class Stroke(BaseModel):
    id: str
    points: List[Point] = Field(default_factory=list)
    color: str = "#ffffff"
    width: float = 3.0
    creator_id: Optional[str] = None
    locked: bool = False
    layer: Literal["map", "draw", "notes"] = "draw"
    layer_band: Literal["below_assets", "above_assets"] = "below_assets"


class Shape(BaseModel):
    id: str
    type: Literal["rect", "circle", "line", "arrow", "text"]
    x1: float
    y1: float
    x2: float
    y2: float
    color: str = "#ffffff"
    width: float = 3.0
    creator_id: Optional[str] = None
    text: Optional[str] = None
    font_size: float = 20.0
    fill: bool = False
    locked: bool = False
    layer: Literal["map", "draw", "notes"] = "draw"
    layer_band: Literal["below_assets", "above_assets"] = "below_assets"


class AssetInstance(BaseModel):
    id: str
    asset_id: Optional[str] = None
    source: Optional[Literal["upload", "pack"]] = None
    pack_slug: Optional[str] = None
    folder_path: Optional[str] = None
    mime: Optional[str] = None
    ext: Optional[str] = None
    image_url: str
    x: float
    y: float
    width: float = 64.0
    height: float = 64.0
    scale_x: float = 1.0
    scale_y: float = 1.0
    rotation: float = 0.0
    opacity: float = 1.0
    layer: int = 0
    creator_id: Optional[str] = None
    locked: bool = False


class TerrainStroke(BaseModel):
    id: str
    material_id: str
    op: Literal["paint", "erase"] = "paint"
    points: List[dict] = Field(default_factory=list)
    radius: float = 60.0
    opacity: float = 0.6
    hardness: float = 0.4
    created_by: Optional[str] = None
    created_at: Optional[float] = None


class TerrainPaintState(BaseModel):
    base_material_id: Optional[str] = None
    materials: Dict[str, dict] = Field(default_factory=dict)
    strokes: Dict[str, "TerrainStroke"] = Field(default_factory=dict)
    undo_stack: List[str] = Field(default_factory=list)


class FogStroke(BaseModel):
    id: str
    op: Literal["cover", "reveal"] = "reveal"
    points: List[dict] = Field(default_factory=list)
    radius: float = 60.0
    opacity: float = 1.0
    hardness: float = 0.6
    created_by: Optional[str] = None
    created_at: Optional[float] = None


class FogPaintState(BaseModel):
    enabled: bool = False
    default_mode: Literal["clear", "covered"] = "clear"
    strokes: Dict[str, "FogStroke"] = Field(default_factory=dict)
    undo_stack: List[str] = Field(default_factory=list)


class RoomState(BaseModel):
    room_id: str
    version: int = 0
    gm_id: Optional[str] = None
    gm_user_id: Optional[int] = None
    co_gm_ids: List[str] = Field(default_factory=list)
    co_gm_user_ids: List[int] = Field(default_factory=list)
    allow_players_move: bool = False
    allow_all_move: bool = False
    lockdown: bool = False
    gm_key_hash: Optional[str] = None
    background_mode: Literal["solid", "url", "terrain"] = "solid"
    background_url: Optional[str] = None
    terrain_seed: int = 1
    terrain_style: Literal["grassland", "dirt", "snow", "desert", "water", "volcano"] = "grassland"
    world_tone: float = 0.32
    layer_visibility: Dict[str, bool] = Field(
        default_factory=lambda: {"grid": True, "drawings": True, "shapes": True, "assets": True, "tokens": True}
    )
    tokens: Dict[str, Token] = Field(default_factory=dict)
    strokes: Dict[str, Stroke] = Field(default_factory=dict)
    shapes: Dict[str, Shape] = Field(default_factory=dict)
    assets: Dict[str, AssetInstance] = Field(default_factory=dict)
    draw_order: Dict[str, List[str]] = Field(default_factory=lambda: {"strokes": [], "shapes": [], "assets": []})
    terrain_paint: TerrainPaintState = Field(default_factory=TerrainPaintState)
    fog_paint: FogPaintState = Field(default_factory=FogPaintState)


class ClientHello(BaseModel):
    type: Literal["HELLO"] = "HELLO"
    payload: Dict[str, Any] = Field(default_factory=dict)


class WireEvent(BaseModel):
    type: EventType
    payload: Dict[str, Any] = Field(default_factory=dict)

    # Optional metadata (helpful for debugging / future auth)
    client_id: Optional[str] = None
    ts: Optional[float] = None
