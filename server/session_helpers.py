from __future__ import annotations

import asyncio

from .models import WireEvent


def build_session_summary(
    *,
    session_id: str,
    user_id: int,
    current_room_id: str | None,
    get_game_session_fn,
    get_game_session_role_fn,
    list_game_session_rooms_fn,
    list_game_session_members_fn,
    get_room_meta_fn,
    room_online_count_fn,
) -> dict | None:
    session = get_game_session_fn(session_id)
    if not session:
        return None
    role = get_game_session_role_fn(session_id, user_id)
    if not role:
        return None
    rooms = []
    for room in list_game_session_rooms_fn(session_id):
        room_id = str(room.get("room_id") or "")
        rooms.append(
            {
                "id": room_id,
                "display_name": room.get("display_name") or room.get("name") or room_id,
                "join_code": room.get("join_code") or "",
                "room_order": room.get("room_order"),
                "occupancy_count": room_online_count_fn(room_id),
                "is_current": room_id == current_room_id,
            }
        )
    members = []
    for member in list_game_session_members_fn(session_id):
        members.append(
            {
                "user_id": member.get("user_id"),
                "username": member.get("username"),
                "role": member.get("role"),
            }
        )
    current_room = None
    if current_room_id:
        meta = get_room_meta_fn(current_room_id)
        if meta:
            current_room = {"id": current_room_id, "display_name": meta.display_name or meta.name}
    return {
        "id": session.session_id,
        "name": session.name,
        "user_role": role,
        "rooms": rooms,
        "members": members,
        "current_room": current_room,
    }


def room_session_payload(
    *,
    room_id: str,
    user_id: int,
    get_room_meta_fn,
    build_session_summary_fn,
) -> dict | None:
    meta = get_room_meta_fn(room_id)
    if not meta or not meta.session_id:
        return None
    return build_session_summary_fn(meta.session_id, user_id, room_id)


def session_room_name(*, session_id: str, target_room_id: str, list_game_session_rooms_fn) -> str | None:
    for room in list_game_session_rooms_fn(session_id):
        if str(room.get("room_id") or "") == target_room_id:
            return str(room.get("display_name") or room.get("name") or target_room_id)
    return None


async def broadcast_session_event(
    *,
    session_id: str,
    event: WireEvent,
    rm,
    list_game_session_rooms_fn,
    list_game_session_members_fn,
    roles: set[str] | None = None,
) -> None:
    session_rooms = {str(room.get("room_id") or "") for room in list_game_session_rooms_fn(session_id)}
    if not session_rooms:
        return
    members_by_username = {
        str(member.get("username") or ""): str(member.get("role") or "player")
        for member in list_game_session_members_fn(session_id)
    }
    sockets = []
    message = event.model_dump_json()
    for room_id, live_room in list(rm._rooms.items()):
        if room_id not in session_rooms:
            continue
        for ws in list(live_room.sockets):
            username = str(live_room.socket_to_client.get(ws) or "")
            role = members_by_username.get(username)
            if not role:
                continue
            if roles is not None and role not in roles:
                continue
            sockets.append(ws)
    if not sockets:
        return
    await asyncio.gather(*(ws.send_text(message) for ws in sockets), return_exceptions=True)


async def broadcast_session_notice(
    *,
    session_id: str,
    message: str,
    broadcast_session_event_fn,
) -> None:
    await broadcast_session_event_fn(
        session_id,
        WireEvent(type="SESSION_SYSTEM_NOTICE", payload={"scope": "session", "message": message}),
    )


async def handle_session_control_event(
    *,
    event: WireEvent,
    user,
    client_id: str,
    get_game_session_role_fn,
    session_room_name_fn,
    broadcast_session_event_fn,
    broadcast_session_notice_fn,
) -> WireEvent | None:
    session_id = str(event.payload.get("session_id") or "").strip()
    target_room_id = str(event.payload.get("target_room_id") or "").strip()
    if not session_id or not target_room_id:
        return WireEvent(type="ERROR", payload={"message": "session_id and target_room_id are required"})
    if user.user_id is None:
        return WireEvent(type="ERROR", payload={"message": "Invalid user"})
    target_room_name = session_room_name_fn(session_id, target_room_id)
    if not target_room_name:
        return WireEvent(type="ERROR", payload={"message": "Target room is not in this session"})
    role = get_game_session_role_fn(session_id, user.user_id)
    if not role:
        return WireEvent(type="ERROR", payload={"message": "Not a member of this session"})
    message = str(event.payload.get("message") or "").strip()
    requested_by = user.username or client_id

    if event.type in {"SESSION_ROOM_MOVE_REQUEST", "SESSION_ROOM_MOVE_FORCE"}:
        if role not in {"gm", "co_gm"}:
            return WireEvent(type="ERROR", payload={"message": "Only GM or co-GM can move players"})
        outgoing_type = "SESSION_ROOM_MOVE_OFFER" if event.type == "SESSION_ROOM_MOVE_REQUEST" else "SESSION_ROOM_MOVE_EXECUTE"
        await broadcast_session_event_fn(
            session_id,
            WireEvent(
                type=outgoing_type,
                payload={
                    "session_id": session_id,
                    "target_room_id": target_room_id,
                    "target_room_name": target_room_name,
                    "requested_by": requested_by,
                    "message": message,
                },
            ),
            roles={"player"},
        )
        if event.type == "SESSION_ROOM_MOVE_REQUEST":
            await broadcast_session_notice_fn(session_id, f"{requested_by} requested that players join {target_room_name}.")
        else:
            await broadcast_session_notice_fn(session_id, f"{requested_by} moved players to {target_room_name}.")
        return None

    if event.type == "SESSION_ROOM_MOVE_ACCEPT":
        if role != "player":
            return WireEvent(type="ERROR", payload={"message": "Only players can accept room move offers"})
        await broadcast_session_notice_fn(session_id, f"{requested_by} accepted room move to {target_room_name}.")
        return None

    return WireEvent(type="ERROR", payload={"message": "Unhandled session control event"})
