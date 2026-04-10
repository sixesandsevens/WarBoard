from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..models import WireEvent

if TYPE_CHECKING:
    from ..rooms import Room, RoomManager


def apply_cogm_event(
    manager: "RoomManager",
    room_id: str,
    room: "Room",
    event_type: str,
    payload: dict,
    client_id: str,
    user_id: Optional[int],
) -> WireEvent:
    if not manager._is_primary_gm(room, user_id, client_id):
        return WireEvent(type="ERROR", payload={"message": "Only the primary GM can manage co-GMs"})

    target_id: str = payload.get("target_id", "")
    target_user_id: Optional[int] = payload.get("target_user_id")

    if not target_id:
        return WireEvent(type="ERROR", payload={"message": "target_id required"})

    if target_id == room.state.gm_id or (target_user_id is not None and target_user_id == room.state.gm_user_id):
        return WireEvent(type="ERROR", payload={"message": "Primary GM cannot be added as co-GM"})

    if event_type == "COGM_ADD":
        if target_id not in room.state.co_gm_ids:
            room.state.co_gm_ids.append(target_id)
        if target_user_id is not None and target_user_id not in room.state.co_gm_user_ids:
            room.state.co_gm_user_ids.append(target_user_id)
    elif event_type == "COGM_REMOVE":
        room.state.co_gm_ids = [value for value in room.state.co_gm_ids if value != target_id]
        if target_user_id is not None:
            room.state.co_gm_user_ids = [value for value in room.state.co_gm_user_ids if value != target_user_id]

    manager._mark_dirty(room_id, room)
    return WireEvent(type="COGM_UPDATE", payload={"co_gm_ids": room.state.co_gm_ids})
