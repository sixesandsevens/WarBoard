from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..models import InteriorEdgeOverride, InteriorRoom, WireEvent

if TYPE_CHECKING:
    from ..rooms import Room, RoomManager


def apply_interior_event(
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

    if event_type == "INTERIOR_ADD":
        interior_id = str(payload.get("id") or "").strip()
        if not interior_id:
            return WireEvent(type="ERROR", payload={"message": "Missing interior id"})
        manager._push_history(room)
        item = InteriorRoom(
            id=interior_id,
            x=float(payload.get("x", 0)),
            y=float(payload.get("y", 0)),
            w=max(1.0, float(payload.get("w", 1))),
            h=max(1.0, float(payload.get("h", 1))),
            style="wood",
            creator_id=client_id,
            locked=bool(payload.get("locked", False)),
        )
        room.state.interiors[item.id] = item
        manager._append_order(room.state, "interiors", item.id)
        manager._mark_dirty(room_id, room)
        return WireEvent(type="INTERIOR_ADD", payload=item.model_dump())

    if event_type == "INTERIOR_UPDATE":
        interior_id = str(payload.get("id") or "").strip()
        item = room.state.interiors.get(interior_id)
        if not item:
            return WireEvent(type="ERROR", payload={"message": "Interior not found"})
        if bool(payload.get("commit", False)):
            manager._push_history(room)
        changed = False
        for key in ("x", "y"):
            if key in payload:
                setattr(item, key, float(payload.get(key, getattr(item, key))))
                changed = True
        for key in ("w", "h"):
            if key in payload:
                setattr(item, key, max(1.0, float(payload.get(key, getattr(item, key)))))
                changed = True
        if "locked" in payload:
            item.locked = bool(payload.get("locked", False))
            changed = True
        if changed:
            room.state.interiors[item.id] = item
            manager._append_order(room.state, "interiors", item.id)
            manager._mark_dirty(room_id, room)
        response_payload = item.model_dump()
        if "commit" in payload:
            response_payload["commit"] = bool(payload.get("commit", False))
        if "move_seq" in payload:
            response_payload["move_seq"] = payload.get("move_seq")
        if "move_client" in payload:
            response_payload["move_client"] = payload.get("move_client")
        return WireEvent(type="INTERIOR_UPDATE", payload=response_payload)

    if event_type == "INTERIOR_DELETE":
        interior_id = str(payload.get("id") or "").strip()
        if interior_id not in room.state.interiors:
            return WireEvent(type="INTERIOR_DELETE", payload={"id": interior_id})
        manager._push_history(room)
        room.state.interiors.pop(interior_id, None)
        manager._remove_order(room.state, "interiors", interior_id)
        dead_edges = [
            edge_id
            for edge_id, edge in room.state.interior_edges.items()
            if edge.room_a_id == interior_id or edge.room_b_id == interior_id
        ]
        for edge_id in dead_edges:
            room.state.interior_edges.pop(edge_id, None)
        manager._mark_dirty(room_id, room)
        return WireEvent(type="INTERIOR_DELETE", payload={"id": interior_id})

    if event_type == "INTERIOR_SET_LOCK":
        interior_id = str(payload.get("id") or "").strip()
        item = room.state.interiors.get(interior_id)
        if not item:
            return WireEvent(type="ERROR", payload={"message": "Interior not found"})
        manager._push_history(room)
        item.locked = bool(payload.get("locked", False))
        room.state.interiors[item.id] = item
        manager._mark_dirty(room_id, room)
        return WireEvent(type="INTERIOR_SET_LOCK", payload={"id": item.id, "locked": item.locked})

    if event_type == "INTERIOR_EDGE_SET":
        edge_id = str(payload.get("id") or "").strip()
        edge_key = str(payload.get("edge_key") or "").strip()
        room_a_id = str(payload.get("room_a_id") or "").strip()
        room_b_id = str(payload.get("room_b_id") or "").strip() or None
        mode = str(payload.get("mode") or "auto").strip().lower()
        if mode not in {"auto", "wall", "open", "door"}:
            mode = "auto"
        if not edge_id or not edge_key or not room_a_id:
            return WireEvent(type="ERROR", payload={"message": "Invalid edge override"})
        manager._push_history(room)
        edge = InteriorEdgeOverride(
            id=edge_id,
            edge_key=edge_key,
            room_a_id=room_a_id,
            room_b_id=room_b_id,
            mode=mode,
            creator_id=client_id,
        )
        room.state.interior_edges[edge.id] = edge
        manager._mark_dirty(room_id, room)
        return WireEvent(type="INTERIOR_EDGE_SET", payload=edge.model_dump())

    return WireEvent(type="ERROR", payload={"message": f"Unhandled interior event: {event_type}"})
