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
    "TOKEN_DELETE",
    "TOKEN_RENAME",
    "TOKEN_SET_SIZE",
    "TOKEN_ASSIGN",
    "TOKEN_SET_LOCK",
    "TOKEN_BADGE_TOGGLE",
    "STROKE_ADD",
    "STROKE_DELETE",
    "STROKE_SET_LOCK",
    "ERASE_AT",
    "SHAPE_ADD",
    "SHAPE_DELETE",
    "SHAPE_SET_LOCK",
    "ERROR",
]


class Token(BaseModel):
    id: str
    x: float
    y: float
    name: str = "Token"
    color: str = "#ffffff"
    image_url: Optional[str] = None
    size_scale: float = 1.0
    owner_id: Optional[str] = None
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
    locked: bool = False
    layer: Literal["map", "draw", "notes"] = "draw"


class Shape(BaseModel):
    id: str
    type: Literal["rect", "circle", "line"]
    x1: float
    y1: float
    x2: float
    y2: float
    color: str = "#ffffff"
    width: float = 3.0
    fill: bool = False
    locked: bool = False
    layer: Literal["map", "draw", "notes"] = "draw"


class RoomState(BaseModel):
    room_id: str
    version: int = 0
    gm_id: Optional[str] = None
    gm_user_id: Optional[int] = None
    allow_players_move: bool = False
    allow_all_move: bool = False
    lockdown: bool = False
    gm_key_hash: Optional[str] = None
    background_mode: Literal["solid", "url", "terrain"] = "solid"
    background_url: Optional[str] = None
    terrain_seed: int = 1
    terrain_style: Literal["grassland", "dirt", "snow", "desert"] = "grassland"
    layer_visibility: Dict[str, bool] = Field(
        default_factory=lambda: {"grid": True, "drawings": True, "shapes": True, "tokens": True}
    )
    tokens: Dict[str, Token] = Field(default_factory=dict)
    strokes: Dict[str, Stroke] = Field(default_factory=dict)
    shapes: Dict[str, Shape] = Field(default_factory=dict)
    draw_order: Dict[str, List[str]] = Field(default_factory=lambda: {"strokes": [], "shapes": []})


class ClientHello(BaseModel):
    type: Literal["HELLO"] = "HELLO"
    payload: Dict[str, Any] = Field(default_factory=dict)


class WireEvent(BaseModel):
    type: EventType
    payload: Dict[str, Any] = Field(default_factory=dict)

    # Optional metadata (helpful for debugging / future auth)
    client_id: Optional[str] = None
    ts: Optional[float] = None
