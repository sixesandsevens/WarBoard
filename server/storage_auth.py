from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlmodel import Session, select

from . import storage_db
from .storage_models import SessionRow, UserRow

engine = storage_db.engine


def set_engine(value) -> None:
    global engine
    engine = value


def create_user(username: str, password_hash: str, now_iso: str) -> UserRow:
    with Session(engine) as s:
        existing = s.exec(select(UserRow).where(UserRow.username == username)).first()
        if existing:
            raise ValueError("Username already exists")
        user = UserRow(username=username, password_hash=password_hash, created_at=now_iso)
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


def create_session(user_id: int, ttl_days: int = 30) -> str:
    sid = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=ttl_days)
    with Session(engine) as s:
        row = SessionRow(sid=sid, user_id=user_id, created_at=now.isoformat(), expires_at=expires.isoformat())
        s.add(row)
        s.commit()
        return sid


def delete_session(sid: str) -> None:
    with Session(engine) as s:
        row = s.get(SessionRow, sid)
        if row:
            s.delete(row)
            s.commit()


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
        return s.get(UserRow, sess.user_id)
