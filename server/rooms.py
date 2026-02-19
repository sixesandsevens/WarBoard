from __future__ import annotations

import asyncio
import math
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from fastapi import WebSocket

from .models import Point, RoomState, Shape, Stroke, Token, WireEvent
from .storage import load_room_state_json, save_room_state_json


AUTOSAVE_DEBOUNCE_SECONDS = 2.0
ERASER_HIT_RADIUS_DEFAULT = 18.0


@dataclass
class Room:
    state: RoomState
    sockets: Set[WebSocket] = field(default_factory=set)
    socket_to_client: Dict[WebSocket, str] = field(default_factory=dict)
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
                    state = RoomState.model_validate_json(raw)
                except Exception:
                    # fallback if json is corrupted
                    state = RoomState(room_id=room_id)
            else:
                state = RoomState(room_id=room_id)
            self._normalize_order(state)

            room = Room(state=state)
            self._rooms[room_id] = room
            return room

    async def is_room_active(self, room_id: str) -> bool:
        async with self._lock:
            room = self._rooms.get(room_id)
            return bool(room and room.sockets)

    async def drop_room(self, room_id: str) -> None:
        async with self._lock:
            self._rooms.pop(room_id, None)

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
            client_id = room.socket_to_client.pop(ws, None)
            if client_id:
                count = room.client_counts.get(client_id, 0) - 1
                if count <= 0:
                    room.client_counts.pop(client_id, None)
                else:
                    room.client_counts[client_id] = count

            # If empty, save and optionally drop from memory
            if not room.sockets:
                await self._flush_save(room_id, room)
                # Keep it simple: drop to avoid memory creep
                self._rooms.pop(room_id, None)
                return None
            return room

    def attach_client(self, room: Room, ws: WebSocket, client_id: str) -> None:
        room.socket_to_client[ws] = client_id
        room.client_counts[client_id] = room.client_counts.get(client_id, 0) + 1

    def presence_event(self, room: Room) -> WireEvent:
        clients = sorted(room.client_counts.keys())
        return WireEvent(
            type="PRESENCE",
            payload={"clients": clients, "gm_id": room.state.gm_id, "room_id": room.state.room_id},
        )

    async def broadcast(self, room: Room, event: WireEvent) -> None:
        msg = event.model_dump_json()
        dead = []
        for s in list(room.sockets):
            try:
                await s.send_text(msg)
            except Exception:
                dead.append(s)
        for s in dead:
            room.sockets.discard(s)
            client_id = room.socket_to_client.pop(s, None)
            if client_id:
                count = room.client_counts.get(client_id, 0) - 1
                if count <= 0:
                    room.client_counts.pop(client_id, None)
                else:
                    room.client_counts[client_id] = count

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
        strokes = state.draw_order.get("strokes", [])
        shapes = state.draw_order.get("shapes", [])
        strokes = [sid for sid in strokes if sid in state.strokes]
        shapes = [sid for sid in shapes if sid in state.shapes]
        for sid in state.strokes.keys():
            if sid not in strokes:
                strokes.append(sid)
        for sid in state.shapes.keys():
            if sid not in shapes:
                shapes.append(sid)
        state.draw_order["strokes"] = strokes
        state.draw_order["shapes"] = shapes

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

        return False

    def can_move_token(self, room: Room, client_id: str, token: Token) -> bool:
        # GM can move anything.
        if room.state.gm_id and client_id == room.state.gm_id:
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

    async def apply_event(self, room_id: str, room: Room, event: WireEvent, client_id: str) -> WireEvent:
        t = event.type
        p = event.payload

        if t == "UNDO":
            if not (room.state.gm_id and client_id == room.state.gm_id):
                return WireEvent(type="ERROR", payload={"message": "Only GM can undo"})
            if not room.history:
                return WireEvent(type="ERROR", payload={"message": "Nothing to undo"})
            room.future.append(self._snapshot_json(room))
            prev = room.history.pop()
            room.state = RoomState.model_validate_json(prev)
            self._normalize_order(room.state)
            self._mark_dirty(room_id, room)
            return WireEvent(type="STATE_SYNC", payload=room.state.model_dump(exclude={"gm_key_hash"}))

        if t == "REDO":
            if not (room.state.gm_id and client_id == room.state.gm_id):
                return WireEvent(type="ERROR", payload={"message": "Only GM can redo"})
            if not room.future:
                return WireEvent(type="ERROR", payload={"message": "Nothing to redo"})
            room.history.append(self._snapshot_json(room))
            nxt = room.future.pop()
            room.state = RoomState.model_validate_json(nxt)
            self._normalize_order(room.state)
            self._mark_dirty(room_id, room)
            return WireEvent(type="STATE_SYNC", payload=room.state.model_dump(exclude={"gm_key_hash"}))

        if t == "TOKEN_CREATE":
            self._push_history(room)
            token = Token(
                id=p.get("id"),
                x=float(p.get("x", 0)),
                y=float(p.get("y", 0)),
                name=p.get("name", "Token"),
                color=p.get("color", "#ffffff"),
                owner_id=None,
                locked=bool(p.get("locked", False)),
            )
            room.state.tokens[token.id] = token
            self._mark_dirty(room_id, room)
            return event  # echo

        if t == "TOKEN_MOVE":
            token_id = p.get("id")
            token = room.state.tokens.get(token_id)
            if not token:
                return WireEvent(type="ERROR", payload={"message": "Unknown token", "id": token_id})

            if not self.can_move_token(room, client_id, token):
                # Send authoritative position so clients can snap back from optimistic moves.
                return WireEvent(
                    type="TOKEN_MOVE",
                    payload={
                        "id": token_id,
                        "x": token.x,
                        "y": token.y,
                        "rejected": True,
                        "reason": "Not allowed",
                    },
                )

            # Keep move traffic cheap: history snapshots only on explicit commit moves.
            if bool(p.get("commit", False)):
                self._push_history(room)
            token.x = float(p.get("x", token.x))
            token.y = float(p.get("y", token.y))
            room.state.tokens[token.id] = token
            self._mark_dirty(room_id, room)
            return event

        if t == "ROOM_SETTINGS":
            # GM-only
            if not (room.state.gm_id and client_id == room.state.gm_id):
                return WireEvent(type="ERROR", payload={"message": "Only GM can change room settings"})

            self._push_history(room)
            if "allow_players_move" in p:
                room.state.allow_players_move = bool(p["allow_players_move"])
            if "allow_all_move" in p:
                room.state.allow_all_move = bool(p["allow_all_move"])
            if "lockdown" in p:
                room.state.lockdown = bool(p["lockdown"])
            if "background_url" in p:
                val = p.get("background_url")
                room.state.background_url = str(val) if val else None
            if "layer_visibility" in p and isinstance(p["layer_visibility"], dict):
                for k, v in p["layer_visibility"].items():
                    if k in room.state.layer_visibility:
                        room.state.layer_visibility[k] = bool(v)

            self._mark_dirty(room_id, room)
            return WireEvent(
                type="ROOM_SETTINGS",
                payload={
                    "allow_players_move": room.state.allow_players_move,
                    "allow_all_move": room.state.allow_all_move,
                    "lockdown": room.state.lockdown,
                    "background_url": room.state.background_url,
                    "layer_visibility": room.state.layer_visibility,
                },
            )

        if t == "STROKE_ADD":
            sid = p.get("id")
            pts = p.get("points", [])
            color = p.get("color", "#ffffff")
            width = float(p.get("width", 3.0))
            layer = p.get("layer", "draw")
            if layer not in ("map", "draw", "notes"):
                layer = "draw"

            if not sid or not isinstance(pts, list) or len(pts) < 2:
                return WireEvent(type="ERROR", payload={"message": "Invalid stroke"})

            stroke = Stroke(
                id=sid,
                points=[Point(x=float(pp["x"]), y=float(pp["y"])) for pp in pts if "x" in pp and "y" in pp],
                color=color,
                width=width,
                locked=bool(p.get("locked", False)),
                layer=layer,
            )

            if len(stroke.points) < 2:
                return WireEvent(type="ERROR", payload={"message": "Stroke too short"})

            self._push_history(room)
            room.state.strokes[sid] = stroke
            self._append_order(room.state, "strokes", sid)
            self._mark_dirty(room_id, room)
            return WireEvent(
                type="STROKE_ADD",
                payload={
                    "id": sid,
                    "points": [{"x": pt.x, "y": pt.y} for pt in stroke.points],
                    "color": stroke.color,
                    "width": stroke.width,
                    "locked": stroke.locked,
                    "layer": stroke.layer,
                },
            )

        if t == "STROKE_DELETE":
            if room.state.lockdown:
                return WireEvent(type="ERROR", payload={"message": "Lockdown is enabled"})
            if not (room.state.gm_id and client_id == room.state.gm_id):
                return WireEvent(type="ERROR", payload={"message": "Only GM can delete strokes"})
            ids = p.get("ids")
            if not isinstance(ids, list):
                sid = p.get("id")
                ids = [sid] if sid else []
            existing = [sid for sid in ids if sid in room.state.strokes]
            if not existing:
                return WireEvent(type="STROKE_DELETE", payload={"ids": []})
            self._push_history(room)
            for sid in existing:
                room.state.strokes.pop(sid, None)
                self._remove_order(room.state, "strokes", sid)
            self._mark_dirty(room_id, room)
            return WireEvent(type="STROKE_DELETE", payload={"ids": existing})

        if t == "STROKE_SET_LOCK":
            if not (room.state.gm_id and client_id == room.state.gm_id):
                return WireEvent(type="ERROR", payload={"message": "Only GM can lock strokes"})
            sid = p.get("id")
            stroke = room.state.strokes.get(sid)
            if not stroke:
                return WireEvent(type="ERROR", payload={"message": "Unknown stroke", "id": sid})
            self._push_history(room)
            stroke.locked = bool(p.get("locked", False))
            room.state.strokes[sid] = stroke
            self._mark_dirty(room_id, room)
            return WireEvent(type="STROKE_SET_LOCK", payload={"id": sid, "locked": stroke.locked})

        if t == "ERASE_AT":
            if room.state.lockdown:
                return WireEvent(type="ERROR", payload={"message": "Lockdown is enabled"})
            # Erasing is destructive, so GM-only for now.
            if not (room.state.gm_id and client_id == room.state.gm_id):
                return WireEvent(type="ERROR", payload={"message": "Only GM can erase"})

            cx = float(p.get("x", 0))
            cy = float(p.get("y", 0))
            r = float(p.get("r", ERASER_HIT_RADIUS_DEFAULT))
            erase_shapes = bool(p.get("erase_shapes", False))

            stroke_ids = []
            for sid, stroke in list(room.state.strokes.items()):
                if stroke.locked:
                    continue
                if self._stroke_hits_circle(stroke, cx, cy, r):
                    stroke_ids.append(sid)

            shape_ids = []
            if erase_shapes:
                for sid, shape in list(room.state.shapes.items()):
                    if shape.locked:
                        continue
                    if self._shape_hits_circle(shape, cx, cy, r):
                        shape_ids.append(sid)

            if not stroke_ids and not shape_ids:
                return WireEvent(type="ERASE_AT", payload={"stroke_ids": [], "shape_ids": []})

            self._push_history(room)
            for sid in stroke_ids:
                room.state.strokes.pop(sid, None)
                self._remove_order(room.state, "strokes", sid)
            for sid in shape_ids:
                room.state.shapes.pop(sid, None)
                self._remove_order(room.state, "shapes", sid)

            self._mark_dirty(room_id, room)
            return WireEvent(type="ERASE_AT", payload={"stroke_ids": stroke_ids, "shape_ids": shape_ids})

        if t == "SHAPE_ADD":
            sid = p.get("id")
            stype = p.get("type")
            if stype not in ("rect", "circle", "line"):
                return WireEvent(type="ERROR", payload={"message": "Invalid shape type"})
            layer = p.get("layer", "draw")
            if layer not in ("map", "draw", "notes"):
                layer = "draw"

            shape = Shape(
                id=sid,
                type=stype,
                x1=float(p.get("x1", 0)),
                y1=float(p.get("y1", 0)),
                x2=float(p.get("x2", 0)),
                y2=float(p.get("y2", 0)),
                color=p.get("color", "#ffffff"),
                width=float(p.get("width", 3.0)),
                fill=bool(p.get("fill", False)),
                locked=bool(p.get("locked", False)),
                layer=layer,
            )
            self._push_history(room)
            room.state.shapes[sid] = shape
            self._append_order(room.state, "shapes", sid)
            self._mark_dirty(room_id, room)
            return WireEvent(type="SHAPE_ADD", payload=shape.model_dump())

        if t == "SHAPE_SET_LOCK":
            # GM only
            if not (room.state.gm_id and client_id == room.state.gm_id):
                return WireEvent(type="ERROR", payload={"message": "Only GM can lock shapes"})
            sid = p.get("id")
            shape = room.state.shapes.get(sid)
            if not shape:
                return WireEvent(type="ERROR", payload={"message": "Unknown shape", "id": sid})
            self._push_history(room)
            shape.locked = bool(p.get("locked", False))
            room.state.shapes[sid] = shape
            self._mark_dirty(room_id, room)
            return WireEvent(type="SHAPE_SET_LOCK", payload={"id": sid, "locked": shape.locked})

        if t == "SHAPE_DELETE":
            # GM only
            if not (room.state.gm_id and client_id == room.state.gm_id):
                return WireEvent(type="ERROR", payload={"message": "Only GM can delete shapes"})
            sid = p.get("id")
            if sid in room.state.shapes:
                self._push_history(room)
                room.state.shapes.pop(sid, None)
                self._remove_order(room.state, "shapes", sid)
                self._mark_dirty(room_id, room)
            return WireEvent(type="SHAPE_DELETE", payload={"id": sid})

        if t == "TOKEN_DELETE":
            if room.state.lockdown:
                return WireEvent(type="ERROR", payload={"message": "Lockdown is enabled"})
            token_id = p.get("id")
            token = room.state.tokens.get(token_id)
            if not token:
                return WireEvent(type="ERROR", payload={"message": "Unknown token", "id": token_id})

            # only GM deletes (for now)
            if not (room.state.gm_id and client_id == room.state.gm_id):
                return WireEvent(type="ERROR", payload={"message": "Only GM can delete tokens", "id": token_id})

            self._push_history(room)
            room.state.tokens.pop(token_id, None)
            self._mark_dirty(room_id, room)
            return event

        if t == "TOKEN_ASSIGN":
            # GM assigns token to player
            token_id = p.get("id")
            owner_id = p.get("owner_id")
            token = room.state.tokens.get(token_id)
            if not token:
                return WireEvent(type="ERROR", payload={"message": "Unknown token", "id": token_id})

            if not (room.state.gm_id and client_id == room.state.gm_id):
                return WireEvent(type="ERROR", payload={"message": "Only GM can assign tokens", "id": token_id})

            self._push_history(room)
            token.owner_id = owner_id
            room.state.tokens[token.id] = token
            self._mark_dirty(room_id, room)
            return event

        if t == "TOKEN_SET_LOCK":
            if not (room.state.gm_id and client_id == room.state.gm_id):
                return WireEvent(type="ERROR", payload={"message": "Only GM can lock tokens"})
            token_id = p.get("id")
            token = room.state.tokens.get(token_id)
            if not token:
                return WireEvent(type="ERROR", payload={"message": "Unknown token", "id": token_id})
            self._push_history(room)
            token.locked = bool(p.get("locked", False))
            room.state.tokens[token_id] = token
            self._mark_dirty(room_id, room)
            return WireEvent(type="TOKEN_SET_LOCK", payload={"id": token_id, "locked": token.locked})

        # Unknown / not implemented
        return WireEvent(type="ERROR", payload={"message": f"Unhandled event type: {t}"})
