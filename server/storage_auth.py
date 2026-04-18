from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlmodel import Session, select

from . import storage_db
from .storage_models import SessionRow, UserRow

engine = storage_db.engine
VALID_SITE_ROLES = {"user", "admin", "owner"}


def set_engine(value) -> None:
    global engine
    engine = value


def create_user(username: str, password_hash: str, now_iso: str) -> UserRow:
    with Session(engine) as s:
        existing = s.exec(select(UserRow).where(UserRow.username == username)).first()
        if existing:
            raise ValueError("Username already exists")
        existing_count = len(s.exec(select(UserRow.user_id)).all())
        user = UserRow(
            username=username,
            password_hash=password_hash,
            created_at=now_iso,
            role="owner" if existing_count == 0 else "user",
            status="active",
            must_change_password=False,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        return user


def get_user_by_username(username: str) -> Optional[UserRow]:
    with Session(engine) as s:
        return s.exec(select(UserRow).where(UserRow.username == username)).first()


def get_user_by_id(user_id: int) -> Optional[UserRow]:
    with Session(engine) as s:
        return s.get(UserRow, user_id)


def update_user_password_hash(user_id: int, password_hash: str) -> bool:
    with Session(engine) as s:
        user = s.get(UserRow, user_id)
        if not user:
            return False
        user.password_hash = password_hash
        s.add(user)
        s.commit()
        return True


def update_user_last_room(user_id: int, room_id: Optional[str]) -> bool:
    with Session(engine) as s:
        user = s.get(UserRow, user_id)
        if not user:
            return False
        user.last_room_id = room_id
        s.add(user)
        s.commit()
        return True


def update_user_status(user_id: int, status: str, now_iso: str, reason: Optional[str] = None) -> bool:
    next_status = str(status or "").strip() or "active"
    with Session(engine) as s:
        user = s.get(UserRow, user_id)
        if not user:
            return False
        user.status = next_status
        if next_status == "disabled":
            user.disabled_at = now_iso
            user.disabled_reason = str(reason or "").strip() or None
        elif next_status == "deleted":
            user.deleted_at = now_iso
            user.disabled_at = user.disabled_at or now_iso
            user.disabled_reason = str(reason or "").strip() or user.disabled_reason
        else:
            user.disabled_at = None
            user.disabled_reason = None
            if next_status != "deleted":
                user.deleted_at = None
        s.add(user)
        s.commit()
        return True


def update_user_must_change_password(user_id: int, must_change_password: bool) -> bool:
    with Session(engine) as s:
        user = s.get(UserRow, user_id)
        if not user:
            return False
        user.must_change_password = bool(must_change_password)
        s.add(user)
        s.commit()
        return True


def update_user_role(user_id: int, role: str) -> bool:
    next_role = str(role or "").strip().lower()
    if next_role not in VALID_SITE_ROLES:
        raise ValueError("Invalid role")
    with Session(engine) as s:
        user = s.get(UserRow, user_id)
        if not user:
            return False
        user.role = next_role
        s.add(user)
        s.commit()
        return True


def count_users_with_role(role: str, status: Optional[str] = None) -> int:
    role_name = str(role or "").strip().lower()
    if role_name not in VALID_SITE_ROLES:
        return 0
    with Session(engine) as s:
        stmt = select(UserRow.user_id).where(UserRow.role == role_name)
        if status is not None:
            stmt = stmt.where(UserRow.status == str(status or "").strip().lower())
        rows = s.exec(stmt).all()
    return len(rows)


def bootstrap_owner_if_missing() -> Optional[UserRow]:
    with Session(engine) as s:
        existing_owner = s.exec(
            select(UserRow)
            .where(UserRow.role == "owner")
            .where(UserRow.status == "active")
            .order_by(UserRow.user_id)
        ).first()
        if existing_owner:
            return None
        candidate = s.exec(
            select(UserRow)
            .where(UserRow.status == "active")
            .order_by(UserRow.created_at, UserRow.user_id)
        ).first()
        if not candidate:
            return None
        candidate.role = "owner"
        s.add(candidate)
        s.commit()
        s.refresh(candidate)
        return candidate


def create_session(user_id: int, ttl_days: int = 30) -> str:
    sid = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=ttl_days)
    with Session(engine) as s:
        row = SessionRow(sid=sid, user_id=user_id, created_at=now.isoformat(), expires_at=expires.isoformat())
        s.add(row)
        s.commit()
        return sid


def list_sessions_for_user(user_id: int) -> list[dict]:
    now = datetime.now(timezone.utc)
    with Session(engine) as s:
        rows = s.exec(select(SessionRow).where(SessionRow.user_id == user_id)).all()
        active_rows = []
        removed = False
        for row in rows:
            try:
                expires = datetime.fromisoformat(row.expires_at)
            except Exception:
                s.delete(row)
                removed = True
                continue
            if expires < now:
                s.delete(row)
                removed = True
                continue
            active_rows.append(row)
        if removed:
            s.commit()
    active_rows.sort(key=lambda row: str(row.created_at or ""), reverse=True)
    return [
        {
            "sid": row.sid,
            "created_at": row.created_at,
            "expires_at": row.expires_at,
        }
        for row in active_rows
    ]


def delete_session(sid: str) -> None:
    with Session(engine) as s:
        row = s.get(SessionRow, sid)
        if row:
            s.delete(row)
            s.commit()


def delete_session_for_user(user_id: int, sid: str) -> bool:
    with Session(engine) as s:
        row = s.get(SessionRow, sid)
        if not row or int(row.user_id) != int(user_id):
            return False
        s.delete(row)
        s.commit()
        return True


def delete_all_sessions_for_user(user_id: int, except_sid: Optional[str] = None) -> int:
    removed = 0
    with Session(engine) as s:
        rows = s.exec(select(SessionRow).where(SessionRow.user_id == user_id)).all()
        for row in rows:
            if except_sid and row.sid == except_sid:
                continue
            s.delete(row)
            removed += 1
        if removed:
            s.commit()
    return removed


def get_user_by_sid(sid: str) -> Optional[UserRow]:
    if not sid:
        return None
    with Session(engine) as s:
        sess = s.get(SessionRow, sid)
        if not sess:
            return None
        try:
            exp = datetime.fromisoformat(sess.expires_at)
        except Exception:
            s.delete(sess)
            s.commit()
            return None
        if exp < datetime.now(timezone.utc):
            s.delete(sess)
            s.commit()
            return None
        user = s.get(UserRow, sess.user_id)
        if not user:
            s.delete(sess)
            s.commit()
            return None
        if str(user.status or "active") != "active":
            s.delete(sess)
            s.commit()
            return None
        return user
