from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..models import GeometryObject, Point, WireEvent

if TYPE_CHECKING:
    from ..rooms import Room, RoomManager

_VALID_KINDS = {"room", "cave", "wall_path"}


def _parse_points(raw: object) -> list[Point]:
    if not isinstance(raw, list):
        return []
    pts = []
    for p in raw:
        if isinstance(p, dict):
            try:
                pts.append(Point(x=float(p.get("x", 0)), y=float(p.get("y", 0))))
            except (TypeError, ValueError):
                pass
    return pts


def apply_geometry_event(
    manager: "RoomManager",
    room_id: str,
    room: "Room",
    event_type: str,
    payload: dict,
    client_id: str,
    user_id: Optional[int],
) -> WireEvent:
    if not manager._is_gm(room, user_id, client_id):
        return WireEvent(type="ERROR", payload={"message": "Not allowed"})

    if event_type == "GEOMETRY_ADD":
        geo_id = str(payload.get("id") or "").strip()
        if not geo_id:
            return WireEvent(type="ERROR", payload={"message": "Missing geometry id"})
        kind = str(payload.get("kind") or "cave").strip()
        if kind not in _VALID_KINDS:
            kind = "cave"
        outer = _parse_points(payload.get("outer"))
        if len(outer) < 3:
            return WireEvent(type="ERROR", payload={"message": "Geometry requires at least 3 outer points"})
        manager._push_history(room)
        obj = GeometryObject(
            id=geo_id,
            kind=kind,
            outer=outer,
            closed=bool(payload.get("closed", True)),
            style=dict(payload.get("style") or {}),
            created_by=str(payload.get("createdBy") or client_id),
            created_at=float(payload.get("createdAt") or 0),
            updated_at=float(payload.get("updatedAt") or 0),
            locked=bool(payload.get("locked", False)),
            visible=bool(payload.get("visible", True)),
            z_index=int(payload.get("zIndex") or 0),
        )
        room.state.geometry[obj.id] = obj
        manager._mark_dirty(room_id, room)
        return WireEvent(type="GEOMETRY_ADD", payload=_dump(obj))

    if event_type == "GEOMETRY_UPDATE":
        geo_id = str(payload.get("id") or "").strip()
        obj = room.state.geometry.get(geo_id)
        if not obj:
            return WireEvent(type="ERROR", payload={"message": "Geometry not found"})
        manager._push_history(room)
        if "kind" in payload:
            k = str(payload["kind"]).strip()
            if k in _VALID_KINDS:
                obj.kind = k
        if "outer" in payload:
            pts = _parse_points(payload["outer"])
            if len(pts) >= 3:
                obj.outer = pts
        if "closed" in payload:
            obj.closed = bool(payload["closed"])
        if "style" in payload and isinstance(payload["style"], dict):
            obj.style = dict(payload["style"])
        if "locked" in payload:
            obj.locked = bool(payload["locked"])
        if "visible" in payload:
            obj.visible = bool(payload["visible"])
        if "zIndex" in payload:
            obj.z_index = int(payload["zIndex"])
        if "updatedAt" in payload:
            obj.updated_at = float(payload["updatedAt"])
        room.state.geometry[obj.id] = obj
        manager._mark_dirty(room_id, room)
        return WireEvent(type="GEOMETRY_UPDATE", payload=_dump(obj))

    if event_type == "GEOMETRY_DELETE":
        geo_id = str(payload.get("id") or "").strip()
        if geo_id not in room.state.geometry:
            return WireEvent(type="GEOMETRY_DELETE", payload={"id": geo_id})
        manager._push_history(room)
        room.state.geometry.pop(geo_id, None)
        manager._mark_dirty(room_id, room)
        return WireEvent(type="GEOMETRY_DELETE", payload={"id": geo_id})

    return WireEvent(type="ERROR", payload={"message": f"Unhandled geometry event: {event_type}"})


def _dump(obj: GeometryObject) -> dict:
    return {
        "id": obj.id,
        "kind": obj.kind,
        "outer": [{"x": p.x, "y": p.y} for p in obj.outer],
        "closed": obj.closed,
        "style": obj.style,
        "createdBy": obj.created_by,
        "createdAt": obj.created_at,
        "updatedAt": obj.updated_at,
        "locked": obj.locked,
        "visible": obj.visible,
        "zIndex": obj.z_index,
    }
