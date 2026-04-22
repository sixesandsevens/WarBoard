from __future__ import annotations

import asyncio
import json
import logging
import math
import random
import re
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from fastapi import WebSocket

from .models import AssetInstance, FogPaintState, FogStroke, InteriorEdgeOverride, InteriorRoom, InteriorWallCut, Point, RoomState, Shape, Stroke, TerrainPaintState, TerrainStroke, Token, WireEvent
from .room_events import (
    apply_asset_event,
    apply_geometry_event,
    apply_cogm_event,
    apply_fog_event,
    apply_history_event,
    apply_interior_event,
    apply_settings_event,
    apply_shape_event,
    apply_stroke_event,
    apply_terrain_event,
    apply_token_event,
)
from .storage import load_room_state_json, save_room_state_json


AUTOSAVE_DEBOUNCE_SECONDS = 2.0
ERASER_HIT_RADIUS_DEFAULT = 18.0
TOKEN_HIT_BASE_RADIUS = 25.0
VALID_TOKEN_BADGES = {"downed", "poisoned", "stunned", "burning", "bleeding", "prone"}
BROADCAST_SEND_TIMEOUT_SECONDS = 5.0
MAX_STROKE_POINTS = 25_000
MAX_CANVAS_COORD = 1_000_000.0
MAX_STROKE_WIDTH = 100.0
MAX_TERRAIN_STROKES = 5_000
MAX_TERRAIN_STROKE_POINTS = 5_000
MAX_FOG_STROKES = 5_000
MAX_FOG_STROKE_POINTS = 5_000
logger = logging.getLogger("warhamster.ws")
_LEGACY_PRIVATE_PACK_RE = re.compile(r"^/private-packs/[^/]+/originals/([A-Za-z0-9_-]+)\.[A-Za-z0-9]+$")


@dataclass
class Room:
    state: RoomState
    sockets: Set[WebSocket] = field(default_factory=set)
    socket_to_client: Dict[WebSocket, str] = field(default_factory=dict)
    # Authoritative per-socket identity used for session membership checks.
    # Populated by attach_client alongside socket_to_client.
    socket_to_user_id: Dict[WebSocket, int] = field(default_factory=dict)
    client_counts: Dict[str, int] = field(default_factory=dict)
    dirty: bool = False
    last_change_ts: float = 0.0
    autosave_task: Optional[asyncio.Task] = None
    history: List[str] = field(default_factory=list)
    future: List[str] = field(default_factory=list)


class RoomManager:
    def __init__(self) -> None:
        self._rooms: Dict[str, Room] = {}
        self._lock = asyncio.Lock()

    async def get_or_create_room(self, room_id: str) -> Room:
        async with self._lock:
            if room_id in self._rooms:
                return self._rooms[room_id]

            # Try load from DB
            raw = load_room_state_json(room_id)
            if raw:
                try:
                    state = RoomState.model_validate_json(self._migrate_legacy_asset_refs(raw))
                except (ValueError, TypeError):
                    # fallback if json is corrupted or schema has drifted
                    state = RoomState(room_id=room_id)
            else:
                state = RoomState(room_id=room_id)
            # Migration compatibility: pre-mode rooms that have a URL should stay URL-backed.
            if state.background_url and state.background_mode == "solid":
                state.background_mode = "url"
            self._normalize_order(state)

            room = Room(state=state)
            self._rooms[room_id] = room
            return room

    def _migrate_legacy_asset_refs(self, raw: str) -> str:
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return raw
        if not isinstance(data, dict):
            return raw
        changed = False

        tokens = data.get("tokens")
        if isinstance(tokens, dict):
            for token in tokens.values():
                if not isinstance(token, dict):
                    continue
                legacy_url = str(token.get("url") or "").strip()
                if not token.get("image_url") and legacy_url:
                    token["image_url"] = legacy_url
                    changed = True
                if not token.get("asset_id") and legacy_url:
                    m = _LEGACY_PRIVATE_PACK_RE.match(legacy_url)
                    if m:
                        token["asset_id"] = m.group(1)
                        token["source"] = "pack"
                        token["image_url"] = f"/api/assets/file/{m.group(1)}"
                        changed = True
                if "url" in token:
                    token.pop("url", None)
                    changed = True

        assets = data.get("assets")
        if isinstance(assets, dict):
            for asset in assets.values():
                if not isinstance(asset, dict):
                    continue
                image_url = str(asset.get("image_url") or "").strip()
                if not image_url:
                    continue
                if not asset.get("asset_id"):
                    m = _LEGACY_PRIVATE_PACK_RE.match(image_url)
                    if m:
                        asset["asset_id"] = m.group(1)
                        asset["source"] = "pack"
                        asset["image_url"] = f"/api/assets/file/{m.group(1)}"
                        changed = True
        if not changed:
            return raw
        try:
            return json.dumps(data)
        except (TypeError, ValueError):
            return raw

    async def is_room_active(self, room_id: str) -> bool:
        async with self._lock:
            room = self._rooms.get(room_id)
            return bool(room and room.sockets)

    async def drop_room(self, room_id: str) -> None:
        async with self._lock:
            self._rooms.pop(room_id, None)

    async def kick_all_and_drop(self, room_id: str) -> None:
        """Notify all connected clients the room is being deleted, close their sockets, then drop the room."""
        async with self._lock:
            room = self._rooms.get(room_id)
            sockets = list(room.sockets) if room else []
        if sockets:
            msg = WireEvent(
                type="SESSION_SYSTEM_NOTICE",
                payload={"message": "This room has been deleted.", "redirect": "/static/app.html"},
            ).model_dump_json()
            async def _kick(ws: WebSocket) -> None:
                try:
                    await ws.send_text(msg)
                except Exception:
                    pass
                try:
                    await ws.close(code=1001)
                except Exception:
                    pass
            await asyncio.gather(*(_kick(s) for s in sockets), return_exceptions=True)
        await self.drop_room(room_id)

    async def connect(self, room_id: str, ws: WebSocket) -> Room:
        room = await self.get_or_create_room(room_id)
        room.sockets.add(ws)
        self._normalize_order(room.state)
        return room

    async def disconnect(self, room_id: str, ws: WebSocket) -> Optional[Room]:
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return None
            room.sockets.discard(ws)
            room.socket_to_user_id.pop(ws, None)
            client_id = room.socket_to_client.pop(ws, None)
            if client_id:
                count = room.client_counts.get(client_id, 0) - 1
                if count <= 0:
                    room.client_counts.pop(client_id, None)
                else:
                    room.client_counts[client_id] = count

            # If empty, save and optionally drop from memory
            if not room.sockets:
                if room.autosave_task and not room.autosave_task.done():
                    room.autosave_task.cancel()
                    room.autosave_task = None
                await self._flush_save(room_id, room)
                # Keep it simple: drop to avoid memory creep
                self._rooms.pop(room_id, None)
                return None
            return room

    def attach_client(self, room: Room, ws: WebSocket, client_id: str, user_id: int) -> None:
        room.socket_to_client[ws] = client_id
        room.socket_to_user_id[ws] = user_id
        room.client_counts[client_id] = room.client_counts.get(client_id, 0) + 1

    def presence_event(self, room: Room) -> WireEvent:
        clients = sorted(room.client_counts.keys())
        return WireEvent(
            type="PRESENCE",
            payload={"clients": clients, "gm_id": room.state.gm_id, "co_gm_ids": room.state.co_gm_ids, "room_id": room.state.room_id},
        )

    async def broadcast(self, room: Room, event: WireEvent) -> None:
        msg = event.model_dump_json()
        sockets = list(room.sockets)
        if not sockets:
            return
        results = await asyncio.gather(
            *(asyncio.wait_for(s.send_text(msg), timeout=BROADCAST_SEND_TIMEOUT_SECONDS) for s in sockets),
            return_exceptions=True,
        )
        dead = [s for s, result in zip(sockets, results) if isinstance(result, Exception)]
        if dead:
            timeout_count = 0
            error_count = 0
            error_types: Dict[str, int] = {}
            for result in results:
                if isinstance(result, Exception):
                    if isinstance(result, TimeoutError):
                        timeout_count += 1
                    else:
                        error_count += 1
                        name = result.__class__.__name__
                        error_types[name] = error_types.get(name, 0) + 1
            logger.warning(
                "WS BROADCAST DROP room=%s dropped=%s timeout=%s send_error=%s error_types=%s",
                room.state.room_id,
                len(dead),
                timeout_count,
                error_count,
                error_types,
            )
        for s in dead:
            room.sockets.discard(s)
            room.socket_to_user_id.pop(s, None)
            client_id = room.socket_to_client.pop(s, None)
            if client_id:
                count = room.client_counts.get(client_id, 0) - 1
                if count <= 0:
                    room.client_counts.pop(client_id, None)
                else:
                    room.client_counts[client_id] = count

    async def broadcast_others(self, room: Room, exclude: WebSocket, event: WireEvent) -> None:
        """Broadcast to all sockets in room except the one being excluded (e.g. the sender)."""
        others = [s for s in room.sockets if s is not exclude]
        if not others:
            return
        msg = event.model_dump_json()
        results = await asyncio.gather(
            *(asyncio.wait_for(s.send_text(msg), timeout=BROADCAST_SEND_TIMEOUT_SECONDS) for s in others),
            return_exceptions=True,
        )
        dead = [s for s, r in zip(others, results) if isinstance(r, Exception)]
        for s in dead:
            room.sockets.discard(s)
            room.socket_to_user_id.pop(s, None)
            client_id = room.socket_to_client.pop(s, None)
            if client_id:
                count = room.client_counts.get(client_id, 0) - 1
                if count <= 0:
                    room.client_counts.pop(client_id, None)
                else:
                    room.client_counts[client_id] = count

    def live_rooms(self):
        """Iterate over (room_id, live_room) pairs for all currently active rooms."""
        return list(self._rooms.items())

    def _mark_dirty(self, room_id: str, room: Room) -> None:
        room.dirty = True
        room.last_change_ts = time.time()
        room.state.version += 1

        if room.autosave_task is None or room.autosave_task.done():
            room.autosave_task = asyncio.create_task(self._debounced_save(room_id, room))

    async def _debounced_save(self, room_id: str, room: Room) -> None:
        # Wait until changes stop for debounce window
        while True:
            last = room.last_change_ts
            await asyncio.sleep(AUTOSAVE_DEBOUNCE_SECONDS)
            if room.last_change_ts == last:
                break
        await self._flush_save(room_id, room)

    async def _flush_save(self, room_id: str, room: Room) -> None:
        if not room.dirty:
            return
        room.dirty = False
        save_room_state_json(room_id, room.state.model_dump_json())

    def _snapshot_json(self, room: Room) -> str:
        return room.state.model_dump_json()

    def _push_history(self, room: Room, clear_future: bool = True) -> None:
        room.history.append(self._snapshot_json(room))
        if len(room.history) > 50:
            room.history = room.history[-50:]
        if clear_future:
            room.future.clear()

    def _normalize_order(self, state: RoomState) -> None:
        if "assets" not in state.layer_visibility:
            state.layer_visibility["assets"] = True
        if "interiors" not in state.layer_visibility:
            state.layer_visibility["interiors"] = True
        strokes = state.draw_order.get("strokes", [])
        shapes = state.draw_order.get("shapes", [])
        assets = state.draw_order.get("assets", [])
        interiors = state.draw_order.get("interiors", [])
        strokes = [sid for sid in strokes if sid in state.strokes]
        shapes = [sid for sid in shapes if sid in state.shapes]
        assets = [sid for sid in assets if sid in state.assets]
        interiors = [sid for sid in interiors if sid in state.interiors]
        for sid in state.strokes.keys():
            if sid not in strokes:
                strokes.append(sid)
        for sid in state.shapes.keys():
            if sid not in shapes:
                shapes.append(sid)
        for sid in state.assets.keys():
            if sid not in assets:
                assets.append(sid)
        for sid in state.interiors.keys():
            if sid not in interiors:
                interiors.append(sid)
        state.draw_order["strokes"] = strokes
        state.draw_order["shapes"] = shapes
        state.draw_order["assets"] = assets
        state.draw_order["interiors"] = interiors

    def _append_order(self, state: RoomState, kind: str, item_id: str) -> None:
        self._normalize_order(state)
        state.draw_order[kind] = [x for x in state.draw_order[kind] if x != item_id]
        state.draw_order[kind].append(item_id)

    def _remove_order(self, state: RoomState, kind: str, item_id: str) -> None:
        state.draw_order[kind] = [x for x in state.draw_order.get(kind, []) if x != item_id]

    # --------- Event application & permissions ---------

    def _stroke_hits_circle(self, stroke: Stroke, cx: float, cy: float, r: float) -> bool:
        rr = r * r
        for pt in stroke.points:
            dx = pt.x - cx
            dy = pt.y - cy
            if dx * dx + dy * dy <= rr:
                return True
        return False

    def _shape_hits_circle(self, shape: Shape, cx: float, cy: float, r: float) -> bool:
        rr = r * r
        if shape.type == "line":
            x1, y1, x2, y2 = shape.x1, shape.y1, shape.x2, shape.y2
            vx = x2 - x1
            vy = y2 - y1
            seg_len2 = vx * vx + vy * vy
            if seg_len2 == 0:
                dx = cx - x1
                dy = cy - y1
                return dx * dx + dy * dy <= rr
            t = ((cx - x1) * vx + (cy - y1) * vy) / seg_len2
            t = max(0.0, min(1.0, t))
            px = x1 + t * vx
            py = y1 + t * vy
            dx = cx - px
            dy = cy - py
            return dx * dx + dy * dy <= rr

        if shape.type == "rect":
            minx = min(shape.x1, shape.x2)
            maxx = max(shape.x1, shape.x2)
            miny = min(shape.y1, shape.y2)
            maxy = max(shape.y1, shape.y2)
            dx = max(minx - cx, 0.0, cx - maxx)
            dy = max(miny - cy, 0.0, cy - maxy)
            return dx * dx + dy * dy <= rr

        if shape.type == "circle":
            radius = math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1)
            dist = math.hypot(cx - shape.x1, cy - shape.y1)
            return dist <= radius + r
        if shape.type == "text":
            # Text is point-anchored; use loose hit radius for eraser.
            dist = math.hypot(cx - shape.x1, cy - shape.y1)
            return dist <= r + max(8.0, float(shape.font_size) * 0.6)

        return False

    def _token_hits_circle(self, token: Token, cx: float, cy: float, r: float) -> bool:
        token_r = TOKEN_HIT_BASE_RADIUS * max(0.25, min(4.0, float(token.size_scale or 1.0)))
        dist = math.hypot(cx - float(token.x), cy - float(token.y))
        return dist <= token_r + r

    def _is_primary_gm(self, room: Room, user_id: Optional[int], client_id: str) -> bool:
        if room.state.gm_user_id is not None and user_id is not None:
            return room.state.gm_user_id == user_id
        # Legacy fallback for old room states.
        return bool(room.state.gm_id and client_id == room.state.gm_id)

    def _is_co_gm(self, room: Room, user_id: Optional[int], client_id: str) -> bool:
        if user_id is not None and user_id in room.state.co_gm_user_ids:
            return True
        return client_id in room.state.co_gm_ids

    def _is_gm(self, room: Room, user_id: Optional[int], client_id: str) -> bool:
        return self._is_primary_gm(room, user_id, client_id) or self._is_co_gm(room, user_id, client_id)

    def can_move_token(self, room: Room, user_id: Optional[int], client_id: str, token: Token) -> bool:
        # GM can move anything.
        if self._is_gm(room, user_id, client_id):
            return True

        if room.state.lockdown:
            return False

        if token.locked:
            return False

        # Party mode: anyone can move any unlocked token.
        if room.state.allow_all_move:
            return True

        # Assignment mode.
        if room.state.allow_players_move and token.owner_id == client_id:
            return True

        return False

    def can_edit_token(self, room: Room, user_id: Optional[int], client_id: str, token: Token) -> bool:
        # GM can always edit token metadata.
        if self._is_gm(room, user_id, client_id):
            return True
        if room.state.lockdown:
            return False
        if token.locked:
            return False
        # When everyone-can-move is enabled, allow non-GM rename/resize/group edits.
        return room.state.allow_all_move

    def can_delete_token(self, room: Room, user_id: Optional[int], client_id: str, token: Token) -> bool:
        if self._is_gm(room, user_id, client_id):
            return True
        if room.state.lockdown:
            return False
        if token.locked:
            return False
        return bool(token.creator_id and token.creator_id == client_id)

    def can_delete_stroke(self, room: Room, user_id: Optional[int], client_id: str, stroke: Stroke) -> bool:
        if self._is_gm(room, user_id, client_id):
            return True
        if room.state.lockdown:
            return False
        if stroke.locked:
            return False
        return bool(stroke.creator_id and stroke.creator_id == client_id)

    def can_delete_shape(self, room: Room, user_id: Optional[int], client_id: str, shape: Shape) -> bool:
        if self._is_gm(room, user_id, client_id):
            return True
        if room.state.lockdown:
            return False
        if shape.locked:
            return False
        return bool(shape.creator_id and shape.creator_id == client_id)

    def can_edit_shape(self, room: Room, user_id: Optional[int], client_id: str, shape: Shape) -> bool:
        if self._is_gm(room, user_id, client_id):
            return True
        if room.state.lockdown:
            return False
        if shape.locked:
            return False
        if room.state.allow_all_move:
            return True
        return bool(shape.creator_id and shape.creator_id == client_id)

    def can_edit_asset(self, room: Room, user_id: Optional[int], client_id: str, asset: AssetInstance) -> bool:
        if self._is_gm(room, user_id, client_id):
            return True
        if room.state.lockdown:
            return False
        if asset.locked:
            return False
        if room.state.allow_all_move:
            return True
        return bool(asset.creator_id and asset.creator_id == client_id)

    def can_delete_asset(self, room: Room, user_id: Optional[int], client_id: str, asset: AssetInstance) -> bool:
        if self._is_gm(room, user_id, client_id):
            return True
        if room.state.lockdown:
            return False
        if asset.locked:
            return False
        return bool(asset.creator_id and asset.creator_id == client_id)

    def can_paint_terrain(self, room: Room, user_id: Optional[int], client_id: str) -> bool:
        return self._is_gm(room, user_id, client_id)

    def can_edit_fog(self, room: Room, user_id: Optional[int], client_id: str) -> bool:
        return self._is_gm(room, user_id, client_id)

    async def apply_event(self, room_id: str, room: Room, event: WireEvent, client_id: str, user_id: Optional[int] = None) -> WireEvent:
        t = event.type
        p = event.payload

        if t == "REQ_STATE_SYNC":
            return WireEvent(type="STATE_SYNC", payload=room.state.model_dump(exclude={"gm_key_hash"}))

        if t in ("UNDO", "REDO"):
            return self._apply_history_event(room_id, room, t, client_id, user_id)

        if t in {"TOKEN_CREATE", "TOKEN_MOVE", "TOKENS_MOVE", "TOKEN_DELETE",
                 "TOKEN_ASSIGN", "TOKEN_RENAME", "TOKEN_SET_SIZE", "TOKEN_SET_LOCK",
                 "TOKEN_SET_GROUP", "TOKEN_BADGE_TOGGLE"}:
            return self._apply_token_event(room_id, room, t, p, client_id, user_id)

        if t == "ROOM_SETTINGS":
            return self._apply_settings_event(room_id, room, p, client_id, user_id)

        if t in {"STROKE_ADD", "STROKE_DELETE", "STROKE_SET_LOCK", "ERASE_AT"}:
            return self._apply_stroke_event(room_id, room, t, p, client_id, user_id)

        if t in {"SHAPE_ADD", "SHAPE_UPDATE", "SHAPE_SET_LOCK", "SHAPE_DELETE"}:
            return self._apply_shape_event(room_id, room, t, p, client_id, user_id)

        if t in {"ASSET_INSTANCE_CREATE", "ASSET_INSTANCE_UPDATE", "ASSET_INSTANCE_DELETE"}:
            return self._apply_asset_event(room_id, room, t, p, client_id, user_id)

        if t in {"INTERIOR_ADD", "INTERIOR_UPDATE", "INTERIOR_DELETE", "INTERIOR_SET_LOCK", "INTERIOR_EDGE_SET", "INTERIOR_WALL_CUT_ADD", "INTERIOR_WALL_CUT_REMOVE"}:
            return self._apply_interior_event(room_id, room, t, p, client_id, user_id)

        if t in {"GEOMETRY_ADD", "GEOMETRY_UPDATE", "GEOMETRY_DELETE", "GEOMETRY_SEAM_SET"}:
            return self._apply_geometry_event(room_id, room, t, p, client_id, user_id)

        if t in {"TERRAIN_STROKE_ADD", "TERRAIN_STROKE_UNDO"}:
            return self._apply_terrain_event(room_id, room, t, p, client_id, user_id)

        if t in {"FOG_STROKE_ADD", "FOG_RESET", "FOG_SET_ENABLED"}:
            return self._apply_fog_event(room_id, room, t, p, client_id, user_id)

        if t in {"COGM_ADD", "COGM_REMOVE"}:
            return self._apply_cogm_event(room_id, room, t, p, client_id, user_id)

        # Unknown / not implemented
        return WireEvent(type="ERROR", payload={"message": f"Unhandled event type: {t}"})

    # ------------------------------------------------------------------ history
    def _apply_history_event(self, room_id: str, room: Room, t: str, client_id: str, user_id: Optional[int]) -> WireEvent:
        return apply_history_event(self, room_id, room, t, client_id, user_id)

    # ------------------------------------------------------------------ tokens
    def _apply_token_event(self, room_id: str, room: Room, t: str, p: dict, client_id: str, user_id: Optional[int]) -> WireEvent:
        return apply_token_event(self, room_id, room, t, p, client_id, user_id)

    # ------------------------------------------------------------------ settings
    def _apply_settings_event(self, room_id: str, room: Room, p: dict, client_id: str, user_id: Optional[int]) -> WireEvent:
        return apply_settings_event(self, room_id, room, p, client_id, user_id)

    # ------------------------------------------------------------------ strokes
    def _apply_stroke_event(self, room_id: str, room: Room, t: str, p: dict, client_id: str, user_id: Optional[int]) -> WireEvent:
        return apply_stroke_event(self, room_id, room, t, p, client_id, user_id)

    # ------------------------------------------------------------------ shapes
    def _apply_shape_event(self, room_id: str, room: Room, t: str, p: dict, client_id: str, user_id: Optional[int]) -> WireEvent:
        return apply_shape_event(self, room_id, room, t, p, client_id, user_id)

    # ------------------------------------------------------------------ assets
    def _apply_asset_event(self, room_id: str, room: Room, t: str, p: dict, client_id: str, user_id: Optional[int]) -> WireEvent:
        return apply_asset_event(self, room_id, room, t, p, client_id, user_id)

    # ---------------------------------------------------------------- interiors
    def _apply_interior_event(self, room_id: str, room: Room, t: str, p: dict, client_id: str, user_id: Optional[int]) -> WireEvent:
        return apply_interior_event(self, room_id, room, t, p, client_id, user_id)

    # ---------------------------------------------------------------- geometry
    def _apply_geometry_event(self, room_id: str, room: Room, t: str, p: dict, client_id: str, user_id: Optional[int]) -> WireEvent:
        return apply_geometry_event(self, room_id, room, t, p, client_id, user_id)

    # ------------------------------------------------------------------ terrain
    def _apply_terrain_event(self, room_id: str, room: Room, t: str, p: dict, client_id: str, user_id: Optional[int]) -> WireEvent:
        return apply_terrain_event(self, room_id, room, t, p, client_id, user_id)

    # ------------------------------------------------------------------ fog
    def _apply_fog_event(self, room_id: str, room: Room, t: str, p: dict, client_id: str, user_id: Optional[int]) -> WireEvent:
        return apply_fog_event(self, room_id, room, t, p, client_id, user_id)

    # ------------------------------------------------------------------ co-gm
    def _apply_cogm_event(self, room_id: str, room: Room, t: str, p: dict, client_id: str, user_id: Optional[int]) -> WireEvent:
        return apply_cogm_event(self, room_id, room, t, p, client_id, user_id)
