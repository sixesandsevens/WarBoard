from __future__ import annotations

import random
from typing import TYPE_CHECKING, Optional

from ..models import WireEvent

if TYPE_CHECKING:
    from ..rooms import Room, RoomManager


def apply_settings_event(
    manager: "RoomManager",
    room_id: str,
    room: "Room",
    payload: dict,
    client_id: str,
    user_id: Optional[int],
) -> WireEvent:
    if not manager._is_gm(room, user_id, client_id):
        return WireEvent(type="ERROR", payload={"message": "Only GM can change room settings"})

    manager._push_history(room)
    mode_changed_to_terrain = False
    had_explicit_terrain_seed = "terrain_seed" in payload
    if "allow_players_move" in payload:
        room.state.allow_players_move = bool(payload["allow_players_move"])
    if "allow_all_move" in payload:
        room.state.allow_all_move = bool(payload["allow_all_move"])
    if "lockdown" in payload:
        room.state.lockdown = bool(payload["lockdown"])
    if "background_url" in payload:
        val = payload.get("background_url")
        room.state.background_url = str(val) if val else None
        if room.state.background_url:
            room.state.background_mode = "url"
        elif room.state.background_mode == "url":
            room.state.background_mode = "solid"
    if "background_mode" in payload:
        mode = payload.get("background_mode")
        if mode in ("solid", "url", "terrain"):
            mode_changed_to_terrain = mode == "terrain" and room.state.background_mode != "terrain"
            room.state.background_mode = mode
        else:
            return WireEvent(type="ERROR", payload={"message": "Invalid background_mode"})
    if "terrain_seed" in payload:
        try:
            room.state.terrain_seed = int(payload.get("terrain_seed"))
        except (TypeError, ValueError):
            return WireEvent(type="ERROR", payload={"message": "Invalid terrain_seed"})
    if "terrain_style" in payload:
        style = payload.get("terrain_style")
        if style in ("grassland", "dirt", "snow", "desert", "water", "volcano"):
            room.state.terrain_style = style
        else:
            return WireEvent(type="ERROR", payload={"message": "Invalid terrain_style"})
    if "world_tone" in payload:
        try:
            tone = float(payload.get("world_tone"))
        except (TypeError, ValueError):
            return WireEvent(type="ERROR", payload={"message": "Invalid world_tone"})
        room.state.world_tone = max(0.0, min(1.0, tone))
    if room.state.background_mode == "terrain" and room.state.terrain_seed <= 0:
        room.state.terrain_seed = random.randint(1, 2_147_483_647)
    if room.state.background_mode == "terrain" and mode_changed_to_terrain and not had_explicit_terrain_seed:
        room.state.terrain_seed = random.randint(1, 2_147_483_647)
    if "layer_visibility" in payload and isinstance(payload["layer_visibility"], dict):
        for key, value in payload["layer_visibility"].items():
            if key in room.state.layer_visibility:
                room.state.layer_visibility[key] = bool(value)

    manager._mark_dirty(room_id, room)
    return WireEvent(
        type="ROOM_SETTINGS",
        payload={
            "allow_players_move": room.state.allow_players_move,
            "allow_all_move": room.state.allow_all_move,
            "lockdown": room.state.lockdown,
            "background_mode": room.state.background_mode,
            "background_url": room.state.background_url,
            "terrain_seed": room.state.terrain_seed,
            "terrain_style": room.state.terrain_style,
            "world_tone": room.state.world_tone,
            "layer_visibility": room.state.layer_visibility,
        },
    )
