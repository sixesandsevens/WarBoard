from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional

from sqlmodel import Session, select

from . import storage_db
from .storage_models import (
    GameSessionMemberRow,
    GameSessionRow,
    GameSessionSharedPackRow,
    PrivatePackRow,
    RoomMemberRow,
    RoomMetaRow,
    SnapshotRow,
    UserRow,
)

engine = storage_db.engine


def set_engine(value) -> None:
    global engine
    engine = value


def create_game_session(
    name: str,
    created_by_user_id: Optional[int],
    now_iso: str,
    add_game_session_member: Callable[[str, int, str], None],
) -> GameSessionRow:
    row = GameSessionRow(
        session_id="sess_" + secrets.token_hex(6),
        name=(name or "").strip() or "Untitled Session",
        created_by_user_id=created_by_user_id,
        created_at=now_iso,
        updated_at=now_iso,
        archived=False,
    )
    with Session(engine) as s:
        s.add(row)
        s.commit()
        s.refresh(row)
    if created_by_user_id is not None:
        add_game_session_member(row.session_id, created_by_user_id, "gm")
    return row


def get_game_session(session_id: str) -> Optional[GameSessionRow]:
    with Session(engine) as s:
        return s.get(GameSessionRow, session_id)


def archive_game_session(session_id: str) -> bool:
    with Session(engine) as s:
        row = s.get(GameSessionRow, session_id)
        if not row:
            return False
        row.archived = True
        s.add(row)
        s.commit()
        return True


def touch_game_session(session_id: str, now_iso: str) -> None:
    with Session(engine) as s:
        row = s.get(GameSessionRow, session_id)
        if not row:
            return
        row.updated_at = now_iso
        s.add(row)
        s.commit()


def add_game_session_member(
    session_id: str,
    user_id: int,
    role: str,
    now_iso: str,
    touch_game_session: Callable[[str], None],
) -> None:
    with Session(engine) as s:
        existing = s.exec(
            select(GameSessionMemberRow).where(
                GameSessionMemberRow.session_id == session_id,
                GameSessionMemberRow.user_id == user_id,
            )
        ).first()
        if existing:
            existing.role = role or existing.role
            s.add(existing)
        else:
            s.add(GameSessionMemberRow(session_id=session_id, user_id=user_id, role=role or "player", joined_at=now_iso))
        s.commit()
    touch_game_session(session_id)


def get_game_session_role(session_id: str, user_id: int) -> Optional[str]:
    with Session(engine) as s:
        row = s.exec(
            select(GameSessionMemberRow).where(
                GameSessionMemberRow.session_id == session_id,
                GameSessionMemberRow.user_id == user_id,
            )
        ).first()
        return row.role if row else None


def is_game_session_member(session_id: str, user_id: int) -> bool:
    return bool(get_game_session_role(session_id, user_id))


def can_manage_game_session(session_id: str, user_id: int) -> bool:
    return (get_game_session_role(session_id, user_id) or "") in {"gm", "co_gm"}


def count_session_gms(session_id: str) -> int:
    with Session(engine) as s:
        rows = s.exec(
            select(GameSessionMemberRow).where(
                GameSessionMemberRow.session_id == session_id,
                GameSessionMemberRow.role == "gm",
            )
        ).all()
    return len(rows)


def set_game_session_member_role(session_id: str, user_id: int, role: str, now_iso: str) -> bool:
    with Session(engine) as s:
        row = s.exec(
            select(GameSessionMemberRow).where(
                GameSessionMemberRow.session_id == session_id,
                GameSessionMemberRow.user_id == user_id,
            )
        ).first()
        if not row:
            return False
        row.role = role
        s.add(row)
        sess_row = s.get(GameSessionRow, session_id)
        if sess_row:
            sess_row.updated_at = now_iso
            s.add(sess_row)
        s.commit()
    return True


def remove_game_session_member(session_id: str, user_id: int, now_iso: str) -> bool:
    """Remove a user from the session and cascade-remove them from all session-backed rooms."""
    with Session(engine) as s:
        row = s.exec(
            select(GameSessionMemberRow).where(
                GameSessionMemberRow.session_id == session_id,
                GameSessionMemberRow.user_id == user_id,
            )
        ).first()
        if not row:
            return False
        s.delete(row)
        room_metas = s.exec(select(RoomMetaRow).where(RoomMetaRow.session_id == session_id)).all()
        for meta in room_metas:
            room_row = s.exec(
                select(RoomMemberRow).where(
                    RoomMemberRow.room_id == meta.room_id,
                    RoomMemberRow.user_id == user_id,
                )
            ).first()
            if room_row:
                s.delete(room_row)
        sess_row = s.get(GameSessionRow, session_id)
        if sess_row:
            sess_row.updated_at = now_iso
            s.add(sess_row)
        s.commit()
    return True


def list_game_sessions_for_user(user_id: int) -> List[Dict[str, object]]:
    with Session(engine) as s:
        memberships = s.exec(select(GameSessionMemberRow).where(GameSessionMemberRow.user_id == user_id)).all()
        session_ids = [row.session_id for row in memberships]
        sessions = (
            {
                row.session_id: row
                for row in s.exec(select(GameSessionRow).where(GameSessionRow.session_id.in_(session_ids))).all()
            }
            if session_ids
            else {}
        )
    out: List[Dict[str, object]] = []
    for membership in memberships:
        session = sessions.get(membership.session_id)
        if not session or session.archived:
            continue
        out.append(
            {
                "id": session.session_id,
                "name": session.name,
                "role": membership.role,
                "created_at": session.created_at,
                "updated_at": session.updated_at,
                "root_room_id": session.root_room_id,
            }
        )
    out.sort(key=lambda row: str(row.get("updated_at") or ""), reverse=True)
    return out


def list_game_session_members(session_id: str) -> List[Dict[str, object]]:
    with Session(engine) as s:
        members = s.exec(select(GameSessionMemberRow).where(GameSessionMemberRow.session_id == session_id)).all()
        user_ids = [member.user_id for member in members]
        users = (
            {row.user_id: row for row in s.exec(select(UserRow).where(UserRow.user_id.in_(user_ids))).all()}
            if user_ids
            else {}
        )
        room_rows = s.exec(select(RoomMetaRow).where(RoomMetaRow.session_id == session_id)).all()
        room_by_id = {row.room_id: row for row in room_rows}
    out: List[Dict[str, object]] = []
    for member in members:
        user = users.get(member.user_id)
        current_room_id = ""
        current_room_name = ""
        if user and user.last_room_id and user.last_room_id in room_by_id:
            current_room_id = user.last_room_id
            meta = room_by_id[user.last_room_id]
            current_room_name = meta.display_name or meta.name or meta.room_id
        out.append(
            {
                "user_id": member.user_id,
                "username": user.username if user else f"user-{member.user_id}",
                "role": member.role,
                "joined_at": member.joined_at,
                "current_room_id": current_room_id,
                "current_room_name": current_room_name,
            }
        )
    out.sort(key=lambda row: ({"gm": 0, "co_gm": 1, "player": 2}.get(str(row.get("role")), 9), str(row.get("username"))))
    return out


def list_game_session_rooms(session_id: str) -> List[Dict[str, object]]:
    with Session(engine) as s:
        rows = s.exec(select(RoomMetaRow).where(RoomMetaRow.session_id == session_id)).all()
    out: List[Dict[str, object]] = []
    for row in rows:
        if row.archived:
            continue
        out.append(
            {
                "room_id": row.room_id,
                "name": row.name,
                "display_name": row.display_name or row.name,
                "room_order": row.room_order if row.room_order is not None else 999999,
                "join_code": row.join_code or "",
                "created_at": row.created_at,
                "owner_user_id": row.owner_user_id,
                "parent_room_id": row.parent_room_id,
            }
        )
    out.sort(
        key=lambda row: (
            int(row.get("room_order") or 999999),
            str(row.get("display_name") or "").lower(),
            str(row.get("room_id") or ""),
        )
    )
    return out


def next_room_order_for_session(session_id: str) -> int:
    rooms = list_game_session_rooms(session_id)
    if not rooms:
        return 0
    return max(int(row.get("room_order") or 0) for row in rooms) + 1


def assign_room_to_game_session(
    room_id: str,
    session_id: str,
    display_name: Optional[str],
    order: Optional[int],
    now_iso: str,
) -> bool:
    with Session(engine) as s:
        meta = s.get(RoomMetaRow, room_id)
        session = s.get(GameSessionRow, session_id)
        if not meta or not session:
            return False
        meta.session_id = session_id
        meta.display_name = (display_name or "").strip() or meta.display_name or meta.name
        meta.room_order = next_room_order_for_session(session_id) if order is None else order
        s.add(meta)
        if not session.root_room_id:
            session.root_room_id = room_id
        session.updated_at = now_iso
        s.add(session)
        s.commit()
        return True


def get_game_session_root_room_id(session_id: str) -> Optional[str]:
    with Session(engine) as s:
        row = s.get(GameSessionRow, session_id)
        return row.root_room_id if row else None


def set_game_session_root_room(session_id: str, room_id: str, now_iso: str) -> bool:
    with Session(engine) as s:
        row = s.get(GameSessionRow, session_id)
        if not row:
            return False
        row.root_room_id = room_id
        row.updated_at = now_iso
        s.add(row)
        s.commit()
        return True


def set_room_parent(room_id: str, parent_room_id: Optional[str], now_iso: str) -> bool:
    with Session(engine) as s:
        meta = s.get(RoomMetaRow, room_id)
        if not meta:
            return False
        if parent_room_id is None:
            meta.parent_room_id = None
            s.add(meta)
            s.commit()
            return True
        if parent_room_id == room_id:
            return False  # Cannot parent to itself
        parent_meta = s.get(RoomMetaRow, parent_room_id)
        if not parent_meta:
            return False
        if parent_meta.session_id != meta.session_id:
            return False  # Parent must be in same session
        # Cycle check: walk up from parent; if we reach room_id, it would be a cycle
        visited: set[str] = {room_id}
        current: Optional[str] = parent_room_id
        while current:
            if current in visited:
                return False
            visited.add(current)
            cur = s.get(RoomMetaRow, current)
            current = cur.parent_room_id if cur else None
        meta.parent_room_id = parent_room_id
        s.add(meta)
        s.commit()
        return True


def create_room_in_game_session(
    *,
    session_id: str,
    created_by_user_id: int,
    room_id: str,
    name: str,
    state_json: str,
    join_code: Optional[str],
    create_room_record: Callable[..., None],
    add_membership: Callable[[int, str, str], None],
    touch_game_session: Callable[[str], None],
    parent_room_id: Optional[str] = None,
) -> None:
    display_name = (name or "").strip() or "Untitled Room"
    create_room_record(
        room_id=room_id,
        name=display_name,
        state_json=state_json,
        owner_user_id=created_by_user_id,
        join_code=join_code,
        session_id=session_id,
        display_name=display_name,
        room_order=next_room_order_for_session(session_id),
        parent_room_id=parent_room_id,
    )
    add_membership(created_by_user_id, room_id, "owner")
    for member in list_game_session_members(session_id):
        member_user_id = member.get("user_id")
        if not isinstance(member_user_id, int) or member_user_id == created_by_user_id:
            continue
        add_membership(member_user_id, room_id, "player")
    # Promote to root if session has none yet
    with Session(engine) as s:
        sess_row = s.get(GameSessionRow, session_id)
        if sess_row and not sess_row.root_room_id:
            sess_row.root_room_id = room_id
            sess_row.updated_at = datetime.now(timezone.utc).isoformat()
            s.add(sess_row)
            s.commit()
    touch_game_session(session_id)


def create_snapshot(room_id: str, label: str, state_json: str, now_iso: str) -> str:
    snapshot_id = secrets.token_hex(8)
    with Session(engine) as s:
        s.add(SnapshotRow(snapshot_id=snapshot_id, room_id=room_id, label=label, state_json=state_json, created_at=now_iso))
        s.commit()
    return snapshot_id


def list_snapshots(room_id: str) -> List[Dict[str, str]]:
    with Session(engine) as s:
        snaps = s.exec(select(SnapshotRow).where(SnapshotRow.room_id == room_id)).all()
        return [
            {"snapshot_id": snap.snapshot_id, "room_id": snap.room_id, "label": snap.label, "created_at": snap.created_at}
            for snap in snaps
        ]


def load_snapshot_state_json(snapshot_id: str) -> Optional[str]:
    with Session(engine) as s:
        snap = s.get(SnapshotRow, snapshot_id)
        return snap.state_json if snap else None


def list_game_session_shared_packs(session_id: str) -> List[Dict[str, object]]:
    with Session(engine) as s:
        shared_rows = s.exec(
            select(GameSessionSharedPackRow).where(GameSessionSharedPackRow.session_id == session_id)
        ).all()
        pack_ids = [row.pack_id for row in shared_rows]
        packs = (
            {
                int(row.pack_id): row
                for row in s.exec(select(PrivatePackRow).where(PrivatePackRow.pack_id.in_(pack_ids))).all()
            }
            if pack_ids
            else {}
        )
    out: List[Dict[str, object]] = []
    for row in shared_rows:
        pack = packs.get(int(row.pack_id))
        if not pack:
            continue
        out.append(
            {
                "id": row.id,
                "session_id": row.session_id,
                "pack_id": row.pack_id,
                "slug": pack.slug,
                "name": pack.name,
                "owner_user_id": pack.owner_user_id,
                "shared_by_user_id": row.shared_by_user_id,
                "shared_at": row.shared_at,
            }
        )
    out.sort(key=lambda item: (str(item.get("name") or "").lower(), int(item.get("pack_id") or 0)))
    return out


def shared_pack_ids_for_game_session(session_id: str) -> set[int]:
    with Session(engine) as s:
        rows = s.exec(
            select(GameSessionSharedPackRow.pack_id).where(GameSessionSharedPackRow.session_id == session_id)
        ).all()
    return {int(pack_id) for pack_id in rows if pack_id is not None}


def is_pack_shared_in_game_session(session_id: str, pack_id: int) -> bool:
    with Session(engine) as s:
        row = s.exec(
            select(GameSessionSharedPackRow).where(
                GameSessionSharedPackRow.session_id == session_id,
                GameSessionSharedPackRow.pack_id == pack_id,
            )
        ).first()
    return row is not None


def set_game_session_shared_pack(
    session_id: str,
    pack_id: int,
    enabled: bool,
    shared_by_user_id: Optional[int],
    now_iso: str,
) -> bool:
    with Session(engine) as s:
        session = s.get(GameSessionRow, session_id)
        pack = s.get(PrivatePackRow, pack_id)
        if not session or not pack:
            return False
        existing = s.exec(
            select(GameSessionSharedPackRow).where(
                GameSessionSharedPackRow.session_id == session_id,
                GameSessionSharedPackRow.pack_id == pack_id,
            )
        ).first()
        if enabled:
            if existing:
                existing.shared_by_user_id = shared_by_user_id if shared_by_user_id is not None else existing.shared_by_user_id
                existing.shared_at = now_iso
                s.add(existing)
            else:
                s.add(
                    GameSessionSharedPackRow(
                        session_id=session_id,
                        pack_id=pack_id,
                        shared_by_user_id=shared_by_user_id,
                        shared_at=now_iso,
                    )
                )
        else:
            if not existing:
                return True
            s.delete(existing)
        session.updated_at = now_iso
        s.add(session)
        s.commit()
    return True
