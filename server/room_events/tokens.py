from __future__ import annotations

from typing import TYPE_CHECKING, Dict, List, Optional, Set

from ..models import Token, WireEvent

if TYPE_CHECKING:
    from ..rooms import Room, RoomManager


VALID_TOKEN_BADGES = {"downed", "poisoned", "stunned", "burning", "bleeding", "prone"}


def apply_token_event(
    manager: "RoomManager",
    room_id: str,
    room: "Room",
    event_type: str,
    payload: dict,
    client_id: str,
    user_id: Optional[int],
) -> WireEvent:
    if event_type == "TOKEN_CREATE":
        manager._push_history(room)
        badges = payload.get("badges", [])
        if isinstance(badges, list):
            badges = sorted({str(b).strip() for b in badges if str(b).strip() in VALID_TOKEN_BADGES})
        else:
            badges = []
        source_raw = str(payload.get("source") or "").strip().lower()
        source = source_raw if source_raw in ("upload", "pack") else None
        pack_asset_id = str(payload.get("asset_id") or "").strip() or None
        image_url = str(payload.get("image_url")) if payload.get("image_url") else None
        if source == "pack" and pack_asset_id:
            image_url = f"/api/assets/file/{pack_asset_id}"
        token = Token(
            id=payload.get("id"),
            x=float(payload.get("x", 0)),
            y=float(payload.get("y", 0)),
            name=payload.get("name", "Token"),
            color=payload.get("color", "#ffffff"),
            image_url=image_url,
            asset_id=pack_asset_id,
            source=source,
            pack_slug=str(payload.get("pack_slug") or "").strip() or None,
            mime=str(payload.get("mime") or "").strip() or None,
            ext=str(payload.get("ext") or "").strip() or None,
            size_scale=float(payload.get("size_scale", 1.0)),
            owner_id=None,
            group_id=str(payload.get("group_id")) if payload.get("group_id") else None,
            creator_id=client_id,
            locked=bool(payload.get("locked", False)),
            badges=badges,
        )
        token.size_scale = max(0.25, min(4.0, token.size_scale))
        room.state.tokens[token.id] = token
        manager._mark_dirty(room_id, room)
        return WireEvent(type="TOKEN_CREATE", payload=token.model_dump())

    if event_type == "TOKEN_MOVE":
        token_id = payload.get("id")
        token = room.state.tokens.get(token_id)
        move_seq = payload.get("move_seq")
        move_client = payload.get("move_client")
        if not token:
            return WireEvent(type="ERROR", payload={"message": "Unknown token", "id": token_id})

        if not manager.can_move_token(room, user_id, client_id, token):
            response: Dict[str, object] = {
                "id": token_id,
                "x": token.x,
                "y": token.y,
                "rejected": True,
                "reason": "Not allowed",
            }
            if move_seq is not None:
                response["move_seq"] = move_seq
            if move_client is not None:
                response["move_client"] = move_client
            return WireEvent(type="TOKEN_MOVE", payload=response)

        if bool(payload.get("commit", False)):
            manager._push_history(room)
        token.x = float(payload.get("x", token.x))
        token.y = float(payload.get("y", token.y))
        room.state.tokens[token.id] = token
        manager._mark_dirty(room_id, room)
        return WireEvent(type=event_type, payload=payload)

    if event_type == "TOKENS_MOVE":
        moves = payload.get("moves")
        move_seq = payload.get("move_seq")
        move_client = payload.get("move_client")
        if not isinstance(moves, list) or not moves:
            return WireEvent(type="ERROR", payload={"message": "Invalid moves payload"})

        token_ids: List[str] = []
        move_by_id: Dict[str, Dict[str, object]] = {}
        for move in moves:
            if not isinstance(move, dict):
                return WireEvent(type="ERROR", payload={"message": "Invalid move item"})
            token_id = move.get("id")
            if not isinstance(token_id, str) or not token_id:
                return WireEvent(type="ERROR", payload={"message": "Missing token id in move item"})
            token_ids.append(token_id)
            move_by_id[token_id] = move

        rejected_ids: List[str] = []
        allowed_ids: List[str] = []
        for token_id in token_ids:
            token = room.state.tokens.get(token_id)
            if not token:
                return WireEvent(type="ERROR", payload={"message": "Unknown token", "id": token_id})
            if manager.can_move_token(room, user_id, client_id, token):
                allowed_ids.append(token_id)
            else:
                rejected_ids.append(token_id)

        if bool(payload.get("commit", False)) and allowed_ids:
            manager._push_history(room)

        moved_any = False
        for token_id in allowed_ids:
            move = move_by_id[token_id]
            token = room.state.tokens[token_id]
            prev_x = token.x
            prev_y = token.y
            token.x = float(move.get("x", token.x))
            token.y = float(move.get("y", token.y))
            room.state.tokens[token_id] = token
            if token.x != prev_x or token.y != prev_y:
                moved_any = True

        if moved_any:
            manager._mark_dirty(room_id, room)

        applied: List[Dict[str, float | str]] = []
        seen: Set[str] = set()
        for token_id in token_ids:
            if token_id in seen:
                continue
            seen.add(token_id)
            token = room.state.tokens.get(token_id)
            if token:
                applied.append({"id": token_id, "x": token.x, "y": token.y})

        has_rejected = bool(rejected_ids)
        return WireEvent(
            type="TOKENS_MOVE",
            payload={
                "moves": applied,
                "commit": bool(payload.get("commit", False)),
                "rejected": has_rejected,
                "partial": has_rejected and bool(allowed_ids),
                "rejected_ids": rejected_ids,
                "reason": "Some tokens are locked or not allowed" if has_rejected else None,
                "move_seq": move_seq,
                "move_client": move_client,
            },
        )

    if event_type == "TOKEN_DELETE":
        token_id = payload.get("id")
        token = room.state.tokens.get(token_id)
        if not token:
            return WireEvent(type="ERROR", payload={"message": "Unknown token", "id": token_id})
        if not manager.can_delete_token(room, user_id, client_id, token):
            return WireEvent(type="ERROR", payload={"message": "Not allowed to delete token", "id": token_id})

        manager._push_history(room)
        room.state.tokens.pop(token_id, None)
        manager._mark_dirty(room_id, room)
        return WireEvent(type=event_type, payload=payload)

    if event_type == "TOKEN_ASSIGN":
        token_id = payload.get("id")
        owner_id = payload.get("owner_id")
        token = room.state.tokens.get(token_id)
        if not token:
            return WireEvent(type="ERROR", payload={"message": "Unknown token", "id": token_id})
        if not manager._is_gm(room, user_id, client_id):
            return WireEvent(type="ERROR", payload={"message": "Only GM can assign tokens", "id": token_id})

        manager._push_history(room)
        token.owner_id = owner_id
        room.state.tokens[token.id] = token
        manager._mark_dirty(room_id, room)
        return WireEvent(type=event_type, payload=payload)

    if event_type == "TOKEN_RENAME":
        token_id = payload.get("id")
        token = room.state.tokens.get(token_id)
        if not token:
            return WireEvent(type="ERROR", payload={"message": "Unknown token", "id": token_id})
        if not manager.can_edit_token(room, user_id, client_id, token):
            return WireEvent(type="ERROR", payload={"message": "Not allowed to rename token", "id": token_id})
        name = str(payload.get("name", "")).strip() or "Token"
        manager._push_history(room)
        token.name = name
        room.state.tokens[token_id] = token
        manager._mark_dirty(room_id, room)
        return WireEvent(type="TOKEN_RENAME", payload={"id": token_id, "name": name})

    if event_type == "TOKEN_SET_SIZE":
        token_id = payload.get("id")
        token = room.state.tokens.get(token_id)
        if not token:
            return WireEvent(type="ERROR", payload={"message": "Unknown token", "id": token_id})
        if not manager.can_edit_token(room, user_id, client_id, token):
            return WireEvent(type="ERROR", payload={"message": "Not allowed to resize token", "id": token_id})
        try:
            size_scale = float(payload.get("size_scale", token.size_scale))
        except (TypeError, ValueError):
            return WireEvent(type="ERROR", payload={"message": "Invalid token size", "id": token_id})
        size_scale = max(0.25, min(4.0, size_scale))
        manager._push_history(room)
        token.size_scale = size_scale
        room.state.tokens[token_id] = token
        manager._mark_dirty(room_id, room)
        return WireEvent(type="TOKEN_SET_SIZE", payload={"id": token_id, "size_scale": size_scale})

    if event_type == "TOKEN_SET_LOCK":
        if not manager._is_gm(room, user_id, client_id):
            return WireEvent(type="ERROR", payload={"message": "Only GM can lock tokens"})
        token_id = payload.get("id")
        token = room.state.tokens.get(token_id)
        if not token:
            return WireEvent(type="ERROR", payload={"message": "Unknown token", "id": token_id})
        manager._push_history(room)
        token.locked = bool(payload.get("locked", False))
        room.state.tokens[token_id] = token
        manager._mark_dirty(room_id, room)
        return WireEvent(type="TOKEN_SET_LOCK", payload={"id": token_id, "locked": token.locked})

    if event_type == "TOKEN_SET_GROUP":
        ids = payload.get("ids")
        if not isinstance(ids, list) or not ids:
            return WireEvent(type="ERROR", payload={"message": "ids is required"})
        if not manager._is_gm(room, user_id, client_id):
            return WireEvent(type="ERROR", payload={"message": "Only GM can group tokens"})
        group_id_raw = payload.get("group_id")
        group_id = str(group_id_raw).strip() if group_id_raw else None
        if group_id is not None and not group_id:
            group_id = None
        existing = [token_id for token_id in ids if token_id in room.state.tokens]
        if not existing:
            return WireEvent(type="TOKEN_SET_GROUP", payload={"ids": [], "group_id": group_id})
        manager._push_history(room)
        for token_id in existing:
            token = room.state.tokens[token_id]
            token.group_id = group_id
            room.state.tokens[token_id] = token
        manager._mark_dirty(room_id, room)
        return WireEvent(type="TOKEN_SET_GROUP", payload={"ids": existing, "group_id": group_id})

    if event_type == "TOKEN_BADGE_TOGGLE":
        token_id = payload.get("id")
        badge = str(payload.get("badge", "")).strip()
        token = room.state.tokens.get(token_id)
        if not token:
            return WireEvent(type="ERROR", payload={"message": "Unknown token", "id": token_id})
        if not manager._is_gm(room, user_id, client_id):
            return WireEvent(type="ERROR", payload={"message": "Only GM can edit token badges", "id": token_id})
        if badge not in VALID_TOKEN_BADGES:
            return WireEvent(type="ERROR", payload={"message": "Invalid badge", "badge": badge})

        enabled = payload.get("enabled")
        badge_set = set(token.badges)
        if isinstance(enabled, bool):
            if enabled:
                badge_set.add(badge)
            else:
                badge_set.discard(badge)
        elif badge in badge_set:
            badge_set.discard(badge)
        else:
            badge_set.add(badge)

        manager._push_history(room)
        token.badges = sorted(badge_set)
        room.state.tokens[token_id] = token
        manager._mark_dirty(room_id, room)
        return WireEvent(type="TOKEN_BADGE_TOGGLE", payload={"id": token_id, "badges": token.badges})

    return WireEvent(type="ERROR", payload={"message": f"Unhandled token event: {event_type}"})
