from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..models import RoomState, WireEvent

if TYPE_CHECKING:
    from ..rooms import Room, RoomManager


def apply_history_event(
    manager: "RoomManager",
    room_id: str,
    room: "Room",
    event_type: str,
    client_id: str,
    user_id: Optional[int],
) -> WireEvent:
    if event_type == "UNDO":
        if not manager._is_gm(room, user_id, client_id):
            return WireEvent(type="ERROR", payload={"message": "Only GM can undo"})
        if not room.history:
            return WireEvent(type="ERROR", payload={"message": "Nothing to undo"})
        room.future.append(manager._snapshot_json(room))
        prev = room.history.pop()
        room.state = RoomState.model_validate_json(prev)
        manager._normalize_order(room.state)
        manager._mark_dirty(room_id, room)
        return WireEvent(type="STATE_SYNC", payload=room.state.model_dump(exclude={"gm_key_hash"}))

    if event_type == "REDO":
        if not manager._is_gm(room, user_id, client_id):
            return WireEvent(type="ERROR", payload={"message": "Only GM can redo"})
        if not room.future:
            return WireEvent(type="ERROR", payload={"message": "Nothing to redo"})
        room.history.append(manager._snapshot_json(room))
        nxt = room.future.pop()
        room.state = RoomState.model_validate_json(nxt)
        manager._normalize_order(room.state)
        manager._mark_dirty(room_id, room)
        return WireEvent(type="STATE_SYNC", payload=room.state.model_dump(exclude={"gm_key_hash"}))

    return WireEvent(type="ERROR", payload={"message": "Unhandled history event"})
