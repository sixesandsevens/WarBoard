from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..models import AssetInstance, WireEvent

if TYPE_CHECKING:
    from ..rooms import Room, RoomManager


def apply_asset_event(
    manager: "RoomManager",
    room_id: str,
    room: "Room",
    event_type: str,
    payload: dict,
    client_id: str,
    user_id: Optional[int],
) -> WireEvent:
    if event_type == "ASSET_INSTANCE_CREATE":
        if room.state.lockdown:
            return WireEvent(type="ERROR", payload={"message": "Lockdown is enabled"})
        if not manager._is_gm(room, user_id, client_id) and not room.state.allow_all_move:
            return WireEvent(type="ERROR", payload={"message": "Not allowed to place assets"})
        asset_id = str(payload.get("id") or "").strip()
        source_raw = str(payload.get("source") or "").strip().lower()
        source = source_raw if source_raw in ("upload", "pack") else None
        pack_asset_id = str(payload.get("asset_id") or "").strip() or None
        image_url = str(payload.get("image_url") or "").strip()
        if source == "pack" and pack_asset_id:
            image_url = f"/api/assets/file/{pack_asset_id}"
        if not asset_id or not image_url:
            return WireEvent(type="ERROR", payload={"message": "Invalid asset instance"})

        def _clamp_asset_scale(value: float) -> float:
            v = max(-10.0, min(10.0, float(value)))
            if 0 < v < 0.05:
                return 0.05
            if -0.05 < v < 0:
                return -0.05
            if v == 0:
                return 0.05
            return v

        asset = AssetInstance(
            id=asset_id,
            asset_id=pack_asset_id,
            source=source,
            pack_slug=str(payload.get("pack_slug") or "").strip() or None,
            mime=str(payload.get("mime") or "").strip() or None,
            ext=str(payload.get("ext") or "").strip() or None,
            image_url=image_url,
            x=float(payload.get("x", 0)),
            y=float(payload.get("y", 0)),
            width=max(8.0, float(payload.get("width", 64))),
            height=max(8.0, float(payload.get("height", 64))),
            scale_x=_clamp_asset_scale(float(payload.get("scale_x", 1.0))),
            scale_y=_clamp_asset_scale(float(payload.get("scale_y", 1.0))),
            rotation=float(payload.get("rotation", 0.0)),
            opacity=max(0.05, min(1.0, float(payload.get("opacity", 1.0)))),
            layer=int(payload.get("layer", 0)),
            creator_id=client_id,
            locked=bool(payload.get("locked", False)),
        )
        manager._push_history(room)
        room.state.assets[asset.id] = asset
        manager._append_order(room.state, "assets", asset.id)
        manager._mark_dirty(room_id, room)
        return WireEvent(type="ASSET_INSTANCE_CREATE", payload=asset.model_dump())

    if event_type == "ASSET_INSTANCE_UPDATE":
        def _clamp_asset_scale(value: float) -> float:
            v = max(-10.0, min(10.0, float(value)))
            if 0 < v < 0.05:
                return 0.05
            if -0.05 < v < 0:
                return -0.05
            if v == 0:
                return 0.05
            return v

        asset_id = payload.get("id")
        asset = room.state.assets.get(asset_id)
        if not asset:
            return WireEvent(type="ERROR", payload={"message": "Unknown asset instance", "id": asset_id})
        if not manager.can_edit_asset(room, user_id, client_id, asset):
            return WireEvent(type="ERROR", payload={"message": "Not allowed to edit asset", "id": asset_id})
        if bool(payload.get("commit", False)):
            manager._push_history(room)
        changed = False
        for key in ("x", "y", "rotation"):
            if key in payload:
                setattr(asset, key, float(payload.get(key)))
                changed = True
        for key in ("width", "height"):
            if key in payload:
                setattr(asset, key, max(8.0, float(payload.get(key))))
                changed = True
        for key in ("scale_x", "scale_y"):
            if key in payload:
                setattr(asset, key, _clamp_asset_scale(float(payload.get(key))))
                changed = True
        if "opacity" in payload:
            asset.opacity = max(0.05, min(1.0, float(payload.get("opacity"))))
            changed = True
        if "layer" in payload:
            asset.layer = int(payload.get("layer", asset.layer))
            changed = True
        if "locked" in payload and manager._is_gm(room, user_id, client_id):
            asset.locked = bool(payload.get("locked", False))
            changed = True
        if changed:
            room.state.assets[asset.id] = asset
            manager._mark_dirty(room_id, room)
        return WireEvent(type="ASSET_INSTANCE_UPDATE", payload=asset.model_dump())

    if event_type == "ASSET_INSTANCE_DELETE":
        asset_id = payload.get("id")
        asset = room.state.assets.get(asset_id)
        if not asset:
            return WireEvent(type="ASSET_INSTANCE_DELETE", payload={"id": asset_id})
        if not manager.can_delete_asset(room, user_id, client_id, asset):
            return WireEvent(type="ERROR", payload={"message": "Not allowed to delete asset", "id": asset_id})
        manager._push_history(room)
        room.state.assets.pop(asset_id, None)
        manager._remove_order(room.state, "assets", asset_id)
        manager._mark_dirty(room_id, room)
        return WireEvent(type="ASSET_INSTANCE_DELETE", payload={"id": asset_id})

    return WireEvent(type="ERROR", payload={"message": f"Unhandled asset event: {event_type}"})
