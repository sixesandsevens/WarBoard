from __future__ import annotations

import time
from typing import TYPE_CHECKING, List, Optional

from ..models import FogStroke, TerrainStroke, WireEvent

if TYPE_CHECKING:
    from ..rooms import Room, RoomManager


MAX_TERRAIN_STROKES = 5_000
MAX_TERRAIN_STROKE_POINTS = 5_000
MAX_FOG_STROKES = 5_000
MAX_FOG_STROKE_POINTS = 5_000


def apply_terrain_event(
    manager: "RoomManager",
    room_id: str,
    room: "Room",
    event_type: str,
    payload: dict,
    client_id: str,
    user_id: Optional[int],
) -> WireEvent:
    if event_type == "TERRAIN_STROKE_ADD":
        if not manager.can_paint_terrain(room, user_id, client_id):
            return WireEvent(type="ERROR", payload={"message": "Only GM can paint terrain"})

        sid = str(payload.get("id") or "").strip()
        material_id = str(payload.get("material_id") or "").strip()
        if not sid or not material_id:
            return WireEvent(type="ERROR", payload={"message": "Missing id or material_id"})
        if sid in room.state.terrain_paint.strokes:
            return WireEvent(type="ERROR", payload={"message": "Duplicate terrain stroke id", "id": sid})

        op_raw = str(payload.get("op") or "paint").strip()
        op = op_raw if op_raw in ("paint", "erase") else "paint"

        pts = payload.get("points", [])
        if not isinstance(pts, list) or len(pts) < 2:
            return WireEvent(type="ERROR", payload={"message": "Terrain stroke needs at least 2 points"})
        if len(pts) > MAX_TERRAIN_STROKE_POINTS:
            return WireEvent(
                type="ERROR",
                payload={"message": f"Terrain stroke exceeds max points ({MAX_TERRAIN_STROKE_POINTS})"},
            )

        if len(room.state.terrain_paint.strokes) >= MAX_TERRAIN_STROKES:
            return WireEvent(type="ERROR", payload={"message": f"Room terrain stroke limit reached ({MAX_TERRAIN_STROKES})"})

        radius = max(5.0, min(400.0, float(payload.get("radius", 60.0))))
        opacity = max(0.0, min(1.0, float(payload.get("opacity", 0.6))))
        hardness = max(0.0, min(1.0, float(payload.get("hardness", 0.4))))

        stroke = TerrainStroke(
            id=sid,
            material_id=material_id,
            op=op,
            points=[{"x": float(pt["x"]), "y": float(pt["y"])} for pt in pts if "x" in pt and "y" in pt],
            radius=radius,
            opacity=opacity,
            hardness=hardness,
            created_by=client_id,
            created_at=time.time(),
        )
        if len(stroke.points) < 2:
            return WireEvent(type="ERROR", payload={"message": "Terrain stroke too short after filtering"})

        room.state.terrain_paint.strokes[sid] = stroke
        room.state.terrain_paint.undo_stack.append(sid)
        manager._mark_dirty(room_id, room)
        return WireEvent(
            type="TERRAIN_STROKE_ADD",
            payload={
                "id": stroke.id,
                "material_id": stroke.material_id,
                "op": stroke.op,
                "points": stroke.points,
                "radius": stroke.radius,
                "opacity": stroke.opacity,
                "hardness": stroke.hardness,
                "created_by": stroke.created_by,
                "created_at": stroke.created_at,
            },
        )

    if event_type == "TERRAIN_STROKE_UNDO":
        if not manager.can_paint_terrain(room, user_id, client_id):
            return WireEvent(type="ERROR", payload={"message": "Only GM can undo terrain strokes"})

        count = max(1, int(payload.get("count", 1)))
        removed_ids: List[str] = []
        for _ in range(count):
            if not room.state.terrain_paint.undo_stack:
                break
            sid = room.state.terrain_paint.undo_stack.pop()
            room.state.terrain_paint.strokes.pop(sid, None)
            removed_ids.append(sid)

        if removed_ids:
            manager._mark_dirty(room_id, room)
        return WireEvent(type="TERRAIN_STROKE_UNDO", payload={"ids": removed_ids})

    return WireEvent(type="ERROR", payload={"message": f"Unhandled terrain event: {event_type}"})


def apply_fog_event(
    manager: "RoomManager",
    room_id: str,
    room: "Room",
    event_type: str,
    payload: dict,
    client_id: str,
    user_id: Optional[int],
) -> WireEvent:
    if not manager.can_edit_fog(room, user_id, client_id):
        return WireEvent(type="ERROR", payload={"message": "Only GM can edit fog"})

    if event_type == "FOG_SET_ENABLED":
        enabled = bool(payload.get("enabled", False))
        default_mode = str(payload.get("default_mode") or room.state.fog_paint.default_mode).strip().lower()
        if default_mode not in ("clear", "covered"):
            default_mode = room.state.fog_paint.default_mode
        room.state.fog_paint.enabled = enabled
        room.state.fog_paint.default_mode = default_mode
        manager._mark_dirty(room_id, room)
        return WireEvent(
            type="FOG_SET_ENABLED",
            payload={"enabled": room.state.fog_paint.enabled, "default_mode": room.state.fog_paint.default_mode},
        )

    if event_type == "FOG_RESET":
        mode = str(payload.get("mode") or payload.get("default_mode") or room.state.fog_paint.default_mode).strip().lower()
        if mode not in ("clear", "covered"):
            mode = "clear"
        room.state.fog_paint.enabled = bool(payload.get("enabled", True))
        room.state.fog_paint.default_mode = mode
        room.state.fog_paint.strokes = {}
        room.state.fog_paint.undo_stack = []
        manager._mark_dirty(room_id, room)
        return WireEvent(
            type="FOG_RESET",
            payload={"enabled": room.state.fog_paint.enabled, "default_mode": room.state.fog_paint.default_mode},
        )

    if event_type == "FOG_STROKE_ADD":
        sid = str(payload.get("id") or "").strip()
        if not sid:
            return WireEvent(type="ERROR", payload={"message": "Missing fog stroke id"})
        if sid in room.state.fog_paint.strokes:
            return WireEvent(type="ERROR", payload={"message": "Duplicate fog stroke id", "id": sid})

        pts = payload.get("points", [])
        if not isinstance(pts, list) or len(pts) < 2:
            return WireEvent(type="ERROR", payload={"message": "Fog stroke needs at least 2 points"})
        if len(pts) > MAX_FOG_STROKE_POINTS:
            return WireEvent(type="ERROR", payload={"message": f"Fog stroke exceeds max points ({MAX_FOG_STROKE_POINTS})"})
        if len(room.state.fog_paint.strokes) >= MAX_FOG_STROKES:
            return WireEvent(type="ERROR", payload={"message": f"Room fog stroke limit reached ({MAX_FOG_STROKES})"})

        op = str(payload.get("op") or "reveal").strip().lower()
        if op not in ("cover", "reveal"):
            op = "reveal"
        radius = max(5.0, min(400.0, float(payload.get("radius", 60.0))))
        opacity = max(0.0, min(1.0, float(payload.get("opacity", 1.0))))
        hardness = max(0.0, min(1.0, float(payload.get("hardness", 0.6))))

        stroke = FogStroke(
            id=sid,
            op=op,
            points=[{"x": float(pt["x"]), "y": float(pt["y"])} for pt in pts if "x" in pt and "y" in pt],
            radius=radius,
            opacity=opacity,
            hardness=hardness,
            created_by=client_id,
            created_at=time.time(),
        )
        if len(stroke.points) < 2:
            return WireEvent(type="ERROR", payload={"message": "Fog stroke too short after filtering"})

        room.state.fog_paint.enabled = True
        room.state.fog_paint.strokes[sid] = stroke
        room.state.fog_paint.undo_stack.append(sid)
        manager._mark_dirty(room_id, room)
        return WireEvent(type="FOG_STROKE_ADD", payload=stroke.model_dump())

    return WireEvent(type="ERROR", payload={"message": f"Unhandled fog event: {event_type}"})
