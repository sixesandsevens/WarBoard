from __future__ import annotations

import math
from typing import TYPE_CHECKING, Optional

from ..models import InteriorEdgeOverride, InteriorRoom, InteriorWallCut, WireEvent

if TYPE_CHECKING:
    from ..rooms import Room, RoomManager


def _edge_key_matches_rooms(edge_key: str, room_a_id: str, room_b_id: Optional[str]) -> bool:
    if not edge_key or not room_a_id or not room_b_id:
        return False
    parts = edge_key.split("|")
    if len(parts) != 6:
        return False
    left_id, right_id, orientation, line, start, end = parts
    if sorted((room_a_id, room_b_id)) != [left_id, right_id]:
        return False
    if orientation not in {"h", "v"}:
        return False
    try:
        line_value = float(line)
        start_value = float(start)
        end_value = float(end)
    except (TypeError, ValueError):
        return False
    return bool(math.isfinite(line_value) and math.isfinite(start_value) and math.isfinite(end_value) and start_value < end_value)


def _normalize_cut_span(raw_start: object, raw_end: object) -> Optional[tuple[float, float]]:
    try:
        start = float(raw_start)
        end = float(raw_end)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(start) and math.isfinite(end)):
        return None
    start = max(0.0, min(1.0, start))
    end = max(0.0, min(1.0, end))
    if end < start:
        start, end = end, start
    if end - start <= 0.0001:
        return None
    return (start, end)


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
            style=str(payload.get("style") or "wood"),
            label=str(payload.get("label") or "").strip(),
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
        if "label" in payload:
            label = payload.get("label", item.label)
            if label is None:
                label = ""
            label = str(label).strip()
            if item.label != label:
                item.label = label
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
        dead_cuts = [
            cut_id
            for cut_id, cut in room.state.interior_wall_cuts.items()
            if cut.room_id == interior_id
        ]
        for cut_id in dead_cuts:
            room.state.interior_wall_cuts.pop(cut_id, None)
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
        if room_a_id not in room.state.interiors:
            return WireEvent(type="ERROR", payload={"message": "Interior not found"})
        if mode == "door":
            if (
                not room_b_id or
                room_b_id == room_a_id or
                room_b_id not in room.state.interiors or
                not _edge_key_matches_rooms(edge_key, room_a_id, room_b_id)
            ):
                return WireEvent(type="ERROR", payload={"message": "Door overrides require a valid shared interior edge"})
        manager._push_history(room)
        existing_ids = [
            existing_id
            for existing_id, existing in room.state.interior_edges.items()
            if existing.edge_key == edge_key
        ]

        if mode == "auto":
            for existing_id in existing_ids:
                room.state.interior_edges.pop(existing_id, None)
            manager._mark_dirty(room_id, room)
            return WireEvent(
                type="INTERIOR_EDGE_SET",
                payload={
                    "id": existing_ids[-1] if existing_ids else edge_id,
                    "edge_key": edge_key,
                    "room_a_id": room_a_id,
                    "room_b_id": room_b_id,
                    "mode": "auto",
                },
            )

        keep_id = existing_ids[-1] if existing_ids else edge_id
        for existing_id in existing_ids:
            if existing_id != keep_id:
                room.state.interior_edges.pop(existing_id, None)

        edge = InteriorEdgeOverride(
            id=keep_id,
            edge_key=edge_key,
            room_a_id=room_a_id,
            room_b_id=room_b_id,
            mode=mode,
            creator_id=client_id,
        )
        room.state.interior_edges[keep_id] = edge
        manager._mark_dirty(room_id, room)
        return WireEvent(type="INTERIOR_EDGE_SET", payload=edge.model_dump())

    if event_type == "INTERIOR_WALL_CUT_ADD":
        cut_id = str(payload.get("id") or "").strip()
        room_ref = str(payload.get("room_id") or "").strip()
        side = str(payload.get("side") or "").strip().lower()
        kind = str(payload.get("kind") or "door").strip().lower()
        span = _normalize_cut_span(payload.get("t_start"), payload.get("t_end"))
        if not cut_id or not room_ref or side not in {"top", "bottom", "left", "right"} or kind not in {"door", "open"} or not span:
            return WireEvent(type="ERROR", payload={"message": "Invalid wall cut"})
        if room_ref not in room.state.interiors:
            return WireEvent(type="ERROR", payload={"message": "Interior not found"})
        manager._push_history(room)
        cut = InteriorWallCut(
            id=cut_id,
            room_id=room_ref,
            side=side,
            t_start=span[0],
            t_end=span[1],
            kind=kind,
            creator_id=client_id,
        )
        room.state.interior_wall_cuts[cut.id] = cut
        manager._mark_dirty(room_id, room)
        return WireEvent(type="INTERIOR_WALL_CUT_ADD", payload=cut.model_dump())

    if event_type == "INTERIOR_WALL_CUT_REMOVE":
        cut_id = str(payload.get("id") or "").strip()
        if not cut_id:
            return WireEvent(type="ERROR", payload={"message": "Missing wall cut id"})
        if cut_id not in room.state.interior_wall_cuts:
            return WireEvent(type="INTERIOR_WALL_CUT_REMOVE", payload={"id": cut_id})
        manager._push_history(room)
        room.state.interior_wall_cuts.pop(cut_id, None)
        manager._mark_dirty(room_id, room)
        return WireEvent(type="INTERIOR_WALL_CUT_REMOVE", payload={"id": cut_id})

    return WireEvent(type="ERROR", payload={"message": f"Unhandled interior event: {event_type}"})
