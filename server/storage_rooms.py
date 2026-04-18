from __future__ import annotations

import secrets
from typing import Callable, Dict, List, Optional

from sqlmodel import Session, select

from . import storage_db
from .storage_models import GameSessionMemberRow, RoomMemberRow, RoomMetaRow, RoomRow, SnapshotRow, UserRow

engine = storage_db.engine

_JOIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def set_engine(value) -> None:
    global engine
    engine = value


def load_room_state_json(room_id: str) -> Optional[str]:
    with Session(engine) as s:
        row = s.exec(select(RoomRow).where(RoomRow.room_id == room_id)).first()
        return row.state_json if row else None


def save_room_state_json(room_id: str, state_json: str, now_iso: str) -> None:
    with Session(engine) as s:
        row = s.get(RoomRow, room_id)
        if row:
            row.state_json = state_json
            row.updated_at = now_iso
        else:
            row = RoomRow(room_id=room_id, state_json=state_json, updated_at=now_iso)
            s.add(row)
        s.commit()


def create_room_record(
    room_id: str,
    name: str,
    state_json: str,
    now_iso: str,
    owner_user_id: Optional[int] = None,
    join_code: Optional[str] = None,
    session_id: Optional[str] = None,
    display_name: Optional[str] = None,
    room_order: Optional[int] = None,
    archived: bool = False,
    parent_room_id: Optional[str] = None,
) -> None:
    with Session(engine) as s:
        existing = s.get(RoomMetaRow, room_id)
        if existing:
            raise ValueError("Room already exists")
        s.add(
            RoomMetaRow(
                room_id=room_id,
                name=name,
                created_at=now_iso,
                owner_user_id=owner_user_id,
                join_code=join_code,
                session_id=session_id,
                display_name=display_name,
                room_order=room_order,
                archived=archived,
                parent_room_id=parent_room_id,
            )
        )
        s.add(RoomRow(room_id=room_id, state_json=state_json, updated_at=now_iso))
        s.commit()


def get_room_meta(room_id: str) -> Optional[RoomMetaRow]:
    with Session(engine) as s:
        return s.get(RoomMetaRow, room_id)


def get_room_session_id(room_id: str) -> Optional[str]:
    with Session(engine) as s:
        meta = s.get(RoomMetaRow, room_id)
        return meta.session_id if meta else None


def update_room_name(room_id: str, name: str) -> bool:
    with Session(engine) as s:
        meta = s.get(RoomMetaRow, room_id)
        if not meta:
            return False
        meta.name = name
        s.add(meta)
        s.commit()
        return True


def update_room_display_name(room_id: str, display_name: str) -> bool:
    with Session(engine) as s:
        meta = s.get(RoomMetaRow, room_id)
        if not meta:
            return False
        meta.display_name = display_name
        s.add(meta)
        s.commit()
        return True


def update_room_order(room_id: str, room_order: int) -> bool:
    with Session(engine) as s:
        meta = s.get(RoomMetaRow, room_id)
        if not meta:
            return False
        meta.room_order = room_order
        s.add(meta)
        s.commit()
        return True


def delete_room_record(room_id: str) -> bool:
    with Session(engine) as s:
        meta = s.get(RoomMetaRow, room_id)
        row = s.get(RoomRow, room_id)
        if not meta and not row:
            return False
        if meta:
            s.delete(meta)
        if row:
            s.delete(row)
        snaps = s.exec(select(SnapshotRow).where(SnapshotRow.room_id == room_id)).all()
        for snap in snaps:
            s.delete(snap)
        memberships = s.exec(select(RoomMemberRow).where(RoomMemberRow.room_id == room_id)).all()
        for membership in memberships:
            s.delete(membership)
        s.commit()
        return True


def generate_join_code(prefix: str = "WHAM", length: int = 6) -> str:
    core = "".join(secrets.choice(_JOIN_ALPHABET) for _ in range(length))
    return f"{prefix}-{core}"


def ensure_room_join_code(room_id: str) -> str:
    with Session(engine) as s:
        meta = s.get(RoomMetaRow, room_id)
        if not meta:
            raise ValueError("Room not found")
        if meta.join_code:
            return meta.join_code
        code = None
        for _ in range(20):
            candidate = generate_join_code()
            existing = s.exec(select(RoomMetaRow).where(RoomMetaRow.join_code == candidate)).first()
            if not existing:
                code = candidate
                break
        if not code:
            raise RuntimeError("Failed to allocate join code")
        meta.join_code = code
        s.add(meta)
        s.commit()
        return code


def room_id_from_join_code(code: str) -> Optional[str]:
    if not code:
        return None
    normalized_code = code.strip()
    with Session(engine) as s:
        meta = s.exec(select(RoomMetaRow).where(RoomMetaRow.join_code == normalized_code)).first()
        return meta.room_id if meta else None


def add_membership(user_id: int, room_id: str, now_iso: str, role: str = "player") -> None:
    with Session(engine) as s:
        row = s.get(RoomMemberRow, (user_id, room_id))
        if row:
            row.role = role or row.role
            row.last_seen_at = now_iso
            s.add(row)
        else:
            s.add(RoomMemberRow(user_id=user_id, room_id=room_id, role=role, last_seen_at=now_iso))
        s.commit()


def touch_membership(user_id: int, room_id: str, now_iso: str) -> None:
    with Session(engine) as s:
        row = s.get(RoomMemberRow, (user_id, room_id))
        if row:
            row.last_seen_at = now_iso
            s.add(row)
            s.commit()


def list_room_member_user_ids(room_id: str) -> List[int]:
    with Session(engine) as s:
        rows = s.exec(select(RoomMemberRow).where(RoomMemberRow.room_id == room_id)).all()
        return [int(row.user_id) for row in rows]


def list_room_members(room_id: str) -> List[Dict[str, object]]:
    with Session(engine) as s:
        rows = s.exec(select(RoomMemberRow).where(RoomMemberRow.room_id == room_id)).all()
        user_ids = [int(row.user_id) for row in rows]
        users = (
            {row.user_id: row for row in s.exec(select(UserRow).where(UserRow.user_id.in_(user_ids))).all()}
            if user_ids
            else {}
        )
    out: List[Dict[str, object]] = []
    for row in rows:
        user = users.get(row.user_id)
        room_role = str(row.role or "player").strip() or "player"
        out.append(
            {
                "user_id": row.user_id,
                "username": user.username if user else f"user-{row.user_id}",
                "room_role": room_role if room_role == "owner" else "player",
                "role": room_role,
                "status": (user.status if user and user.status else "active"),
                "last_seen_at": row.last_seen_at,
            }
        )
    out.sort(key=lambda item: (0 if item.get("room_role") == "owner" else 1, str(item.get("username") or "").lower()))
    return out


def is_member(user_id: int, room_id: str) -> bool:
    with Session(engine) as s:
        row = s.get(RoomMemberRow, (user_id, room_id))
        return bool(row)


def get_room_member_role(user_id: int, room_id: str) -> Optional[str]:
    with Session(engine) as s:
        row = s.get(RoomMemberRow, (user_id, room_id))
        if not row:
            return None
        return str(row.role or "").strip() or None


def remove_room_membership(user_id: int, room_id: str) -> bool:
    with Session(engine) as s:
        row = s.get(RoomMemberRow, (user_id, room_id))
        if not row:
            return False
        s.delete(row)
        s.commit()
        return True


def transfer_room_ownership(room_id: str, new_owner_user_id: int, fallback_role: str = "player") -> bool:
    with Session(engine) as s:
        meta = s.get(RoomMetaRow, room_id)
        if not meta:
            return False
        target_row = s.get(RoomMemberRow, (new_owner_user_id, room_id))
        if not target_row:
            return False
        previous_owner_user_id = meta.owner_user_id
        previous_owner_row = s.get(RoomMemberRow, (previous_owner_user_id, room_id)) if previous_owner_user_id is not None else None
        target_row.role = "owner"
        s.add(target_row)
        if previous_owner_row and int(previous_owner_row.user_id) != int(new_owner_user_id):
            previous_owner_row.role = fallback_role or "player"
            s.add(previous_owner_row)
        meta.owner_user_id = int(new_owner_user_id)
        s.add(meta)
        s.commit()
        return True


def ensure_room_membership_for_user(
    user_id: int,
    room_id: str,
    get_game_session_role: Callable[[str, int], Optional[str]],
) -> bool:
    if is_member(user_id, room_id):
        return True
    with Session(engine) as s:
        meta = s.get(RoomMetaRow, room_id)
        if not meta or not meta.session_id:
            return False
        created_at = meta.created_at
        session_id = meta.session_id
    role = get_game_session_role(session_id, user_id)
    if not role:
        return False
    add_membership(user_id, room_id, created_at, role="owner" if role == "gm" else "player")
    return True


def list_rooms_for_user(user_id: int) -> List[Dict[str, object]]:
    with Session(engine) as s:
        memberships = s.exec(select(RoomMemberRow).where(RoomMemberRow.user_id == user_id)).all()
        session_memberships = s.exec(select(GameSessionMemberRow).where(GameSessionMemberRow.user_id == user_id)).all()
        session_ids = [membership.session_id for membership in session_memberships]
        session_role_by_id = {membership.session_id: membership.role for membership in session_memberships}
        metas = {meta.room_id: meta for meta in s.exec(select(RoomMetaRow)).all()}
        direct_room_ids = {membership.room_id for membership in memberships}
        for meta in metas.values():
            if meta.session_id and meta.session_id in session_ids and meta.room_id not in direct_room_ids:
                memberships.append(
                    RoomMemberRow(
                        user_id=user_id,
                        room_id=meta.room_id,
                        role="owner" if session_role_by_id.get(meta.session_id) == "gm" else "player",
                        last_seen_at=meta.created_at,
                    )
                )
        out: List[Dict[str, object]] = []
        memberships_sorted = sorted(memberships, key=lambda membership: membership.last_seen_at or "", reverse=True)
        seen_room_ids = set()
        for membership in memberships_sorted:
            if membership.room_id in seen_room_ids:
                continue
            seen_room_ids.add(membership.room_id)
            meta = metas.get(membership.room_id)
            if not meta or meta.archived:
                continue
            out.append(
                {
                    "room_id": meta.room_id,
                    "name": meta.name,
                    "display_name": meta.display_name or meta.name,
                    "join_code": meta.join_code or "",
                    "role": membership.role,
                    "last_seen_at": membership.last_seen_at,
                    "created_at": meta.created_at,
                    "session_id": meta.session_id,
                    "room_order": meta.room_order,
                    "parent_room_id": meta.parent_room_id,
                }
            )
        return out
