from __future__ import annotations

import os
import secrets
import sqlite3
import json
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Tuple

from sqlmodel import SQLModel, Field, Session, create_engine, select


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def db_url() -> str:
    # Render: mount a disk and set DATA_DIR=/var/data
    # Local dev: DATA_DIR=./data
    data_dir = os.getenv("DATA_DIR", "./data")
    os.makedirs(data_dir, exist_ok=True)
    return f"sqlite:///{os.path.join(data_dir, 'warboard.db')}"


engine = create_engine(db_url(), connect_args={"check_same_thread": False, "timeout": 3.0})


# --- Core room persistence ----------------------------------------------------

class RoomRow(SQLModel, table=True):
    room_id: str = Field(primary_key=True)
    state_json: str
    updated_at: str


class RoomMetaRow(SQLModel, table=True):
    room_id: str = Field(primary_key=True)
    name: str
    created_at: str
    owner_user_id: Optional[int] = Field(default=None, index=True)
    join_code: Optional[str] = Field(default=None, index=True, unique=True)


class SnapshotRow(SQLModel, table=True):
    snapshot_id: str = Field(primary_key=True)
    room_id: str = Field(index=True)
    label: str
    state_json: str
    created_at: str


# --- Auth + membership --------------------------------------------------------

class UserRow(SQLModel, table=True):
    user_id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True)
    password_hash: str
    created_at: str
    last_room_id: Optional[str] = Field(default=None, index=True)


class SessionRow(SQLModel, table=True):
    sid: str = Field(primary_key=True)
    user_id: int = Field(index=True)
    created_at: str
    expires_at: str


class RoomMemberRow(SQLModel, table=True):
    user_id: int = Field(primary_key=True)
    room_id: str = Field(primary_key=True, index=True)
    role: str = "player"  # "owner" | "player"
    last_seen_at: str


class AssetRow(SQLModel, table=True):
    asset_id: str = Field(primary_key=True)
    uploader_user_id: int = Field(index=True)
    name: str
    folder_path: str = ""
    tags_json: str = "[]"
    mime: str
    width: int = 0
    height: int = 0
    url_original: str
    url_thumb: str
    created_at: str


class PrivatePackRow(SQLModel, table=True):
    pack_id: Optional[int] = Field(default=None, primary_key=True)
    slug: str = Field(index=True, unique=True)
    name: str
    owner_user_id: int = Field(index=True)
    created_at: str
    root_rel: str
    thumb_rel: str


class PrivatePackEntitlementRow(SQLModel, table=True):
    pack_id: int = Field(primary_key=True)
    user_id: int = Field(primary_key=True)
    granted_at: str


class PrivatePackAssetRow(SQLModel, table=True):
    asset_id: str = Field(primary_key=True)
    pack_id: int = Field(index=True)
    name: str
    folder_path: str = ""
    tags_json: str = "[]"
    mime: str
    width: int
    height: int
    url_original: str
    url_thumb: str
    created_at: str


def _sqlite_conn() -> sqlite3.Connection:
    # engine.url is like sqlite:////path/to/db
    url = str(engine.url)
    assert url.startswith("sqlite:///")
    path = url.replace("sqlite:///", "", 1)
    return sqlite3.connect(path, timeout=3.0)


def _column_exists(conn: sqlite3.Connection, table: str, col: str) -> bool:
    cur = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == col for row in cur.fetchall())


def init_db() -> None:
    """
    Creates tables and performs tiny SQLite "migrations" for new columns.

    We intentionally keep this lightweight (no Alembic) for MVP.
    """
    SQLModel.metadata.create_all(engine)

    # Add columns to existing RoomMetaRow table if upgrading from earlier versions.
    try:
        conn = _sqlite_conn()
        # Harden SQLite behavior for concurrent web requests.
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=3000;")
        conn.execute("PRAGMA foreign_keys=OFF;")
        # RoomMetaRow table name defaults to "roommetarow"
        table = "roommetarow"
        if _table_exists(conn, table):
            if not _column_exists(conn, table, "owner_user_id"):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN owner_user_id INTEGER;")
            if not _column_exists(conn, table, "join_code"):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN join_code TEXT;")
                conn.execute(f"CREATE UNIQUE INDEX IF NOT EXISTS ix_roommetarow_join_code ON {table}(join_code);")
        user_table = "userrow"
        if _table_exists(conn, user_table):
            if not _column_exists(conn, user_table, "last_room_id"):
                conn.execute(f"ALTER TABLE {user_table} ADD COLUMN last_room_id TEXT;")
                conn.execute(f"CREATE INDEX IF NOT EXISTS ix_userrow_last_room_id ON {user_table}(last_room_id);")
        asset_table = "assetrow"
        if _table_exists(conn, asset_table):
            if not _column_exists(conn, asset_table, "folder_path"):
                conn.execute(f"ALTER TABLE {asset_table} ADD COLUMN folder_path TEXT DEFAULT '';")
        conn.commit()
    except Exception:
        # If anything goes sideways here, we don't want startup to fail; the app
        # can still run and new DBs will be fine.
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?;", (table,))
    return cur.fetchone() is not None


def load_room_state_json(room_id: str) -> Optional[str]:
    with Session(engine) as s:
        row = s.exec(select(RoomRow).where(RoomRow.room_id == room_id)).first()
        return row.state_json if row else None


def save_room_state_json(room_id: str, state_json: str) -> None:
    now = utc_now_iso()
    with Session(engine) as s:
        row = s.get(RoomRow, room_id)
        if row:
            row.state_json = state_json
            row.updated_at = now
        else:
            row = RoomRow(room_id=room_id, state_json=state_json, updated_at=now)
            s.add(row)
        s.commit()


def create_room_record(room_id: str, name: str, state_json: str, owner_user_id: Optional[int] = None, join_code: Optional[str] = None) -> None:
    now = utc_now_iso()
    with Session(engine) as s:
        existing = s.get(RoomMetaRow, room_id)
        if existing:
            raise ValueError("Room already exists")
        s.add(RoomMetaRow(room_id=room_id, name=name, created_at=now, owner_user_id=owner_user_id, join_code=join_code))
        s.add(RoomRow(room_id=room_id, state_json=state_json, updated_at=now))
        s.commit()


def get_room_meta(room_id: str) -> Optional[RoomMetaRow]:
    with Session(engine) as s:
        return s.get(RoomMetaRow, room_id)


def update_room_name(room_id: str, name: str) -> bool:
    with Session(engine) as s:
        meta = s.get(RoomMetaRow, room_id)
        if not meta:
            return False
        meta.name = name
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
        # also delete snapshots + memberships
        snaps = s.exec(select(SnapshotRow).where(SnapshotRow.room_id == room_id)).all()
        for sn in snaps:
            s.delete(sn)
        mems = s.exec(select(RoomMemberRow).where(RoomMemberRow.room_id == room_id)).all()
        for m in mems:
            s.delete(m)
        s.commit()
        return True


# --- Snapshots ---------------------------------------------------------------

def create_snapshot(room_id: str, label: str, state_json: str) -> str:
    snap_id = secrets.token_hex(8)
    now = utc_now_iso()
    with Session(engine) as s:
        s.add(SnapshotRow(snapshot_id=snap_id, room_id=room_id, label=label, state_json=state_json, created_at=now))
        s.commit()
    return snap_id


def list_snapshots(room_id: str) -> List[Dict[str, str]]:
    with Session(engine) as s:
        snaps = s.exec(select(SnapshotRow).where(SnapshotRow.room_id == room_id)).all()
        return [
            {"snapshot_id": sn.snapshot_id, "room_id": sn.room_id, "label": sn.label, "created_at": sn.created_at}
            for sn in snaps
        ]


def load_snapshot_state_json(snapshot_id: str) -> Optional[str]:
    with Session(engine) as s:
        sn = s.get(SnapshotRow, snapshot_id)
        return sn.state_json if sn else None


# --- Auth helpers ------------------------------------------------------------

def create_user(username: str, password_hash: str) -> UserRow:
    now = utc_now_iso()
    with Session(engine) as s:
        existing = s.exec(select(UserRow).where(UserRow.username == username)).first()
        if existing:
            raise ValueError("Username already exists")
        u = UserRow(username=username, password_hash=password_hash, created_at=now)
        s.add(u)
        s.commit()
        s.refresh(u)
        return u


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


# --- Membership + join codes -------------------------------------------------

_JOIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_join_code(prefix: str = "WARB", length: int = 6) -> str:
    core = "".join(secrets.choice(_JOIN_ALPHABET) for _ in range(length))
    return f"{prefix}-{core}"


def ensure_room_join_code(room_id: str) -> str:
    with Session(engine) as s:
        meta = s.get(RoomMetaRow, room_id)
        if not meta:
            raise ValueError("Room not found")
        if meta.join_code:
            return meta.join_code
        # generate unique
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
    code = code.strip()
    with Session(engine) as s:
        meta = s.exec(select(RoomMetaRow).where(RoomMetaRow.join_code == code)).first()
        return meta.room_id if meta else None


def add_membership(user_id: int, room_id: str, role: str = "player") -> None:
    now = utc_now_iso()
    with Session(engine) as s:
        row = s.get(RoomMemberRow, (user_id, room_id))
        if row:
            row.role = role or row.role
            row.last_seen_at = now
            s.add(row)
        else:
            s.add(RoomMemberRow(user_id=user_id, room_id=room_id, role=role, last_seen_at=now))
        s.commit()


def touch_membership(user_id: int, room_id: str) -> None:
    now = utc_now_iso()
    with Session(engine) as s:
        row = s.get(RoomMemberRow, (user_id, room_id))
        if row:
            row.last_seen_at = now
            s.add(row)
            s.commit()


def is_member(user_id: int, room_id: str) -> bool:
    with Session(engine) as s:
        row = s.get(RoomMemberRow, (user_id, room_id))
        return bool(row)


def list_rooms_for_user(user_id: int) -> List[Dict[str, str]]:
    with Session(engine) as s:
        mems = s.exec(select(RoomMemberRow).where(RoomMemberRow.user_id == user_id)).all()
        metas = {m.room_id: m for m in s.exec(select(RoomMetaRow)).all()}
        rows = {r.room_id: r for r in s.exec(select(RoomRow)).all()}
        out: List[Dict[str, str]] = []
        # sort by last_seen desc
        mems_sorted = sorted(mems, key=lambda m: m.last_seen_at or "", reverse=True)
        for m in mems_sorted:
            meta = metas.get(m.room_id)
            if not meta:
                continue
            out.append(
                {
                    "room_id": meta.room_id,
                    "name": meta.name,
                    "join_code": meta.join_code or "",
                    "role": m.role,
                    "last_seen_at": m.last_seen_at,
                    "created_at": meta.created_at,
                }
            )
        return out


# --- Asset library -----------------------------------------------------------

def create_asset_record(
    *,
    asset_id: str,
    uploader_user_id: int,
    name: str,
    folder_path: str = "",
    tags: List[str],
    mime: str,
    width: int,
    height: int,
    url_original: str,
    url_thumb: str,
) -> None:
    now = utc_now_iso()
    with Session(engine) as s:
        s.add(
            AssetRow(
                asset_id=asset_id,
                uploader_user_id=uploader_user_id,
                name=name,
                folder_path=folder_path or "",
                tags_json=json.dumps(tags or []),
                mime=mime,
                width=max(0, int(width or 0)),
                height=max(0, int(height or 0)),
                url_original=url_original,
                url_thumb=url_thumb,
                created_at=now,
            )
        )
        s.commit()


def list_assets_for_user(user_id: int, q: str = "", tag: str = "", folder: str = "") -> List[Dict[str, object]]:
    qn = (q or "").strip().lower()
    tn = (tag or "").strip().lower()
    fn = (folder or "").strip().strip("/").lower()
    with Session(engine) as s:
        rows = s.exec(select(AssetRow).where(AssetRow.uploader_user_id == user_id)).all()
    out: List[Dict[str, object]] = []
    for row in rows:
        try:
            tags = [str(t).strip() for t in (json.loads(row.tags_json or "[]") or []) if str(t).strip()]
        except Exception:
            tags = []
        if qn and qn not in (row.name or "").lower() and not any(qn in t.lower() for t in tags):
            continue
        if tn and not any(tn == t.lower() for t in tags):
            continue
        if fn and str(row.folder_path or "").strip("/").lower() != fn:
            continue
        out.append(
            {
                "asset_id": row.asset_id,
                "name": row.name,
                "folder_path": row.folder_path or "",
                "tags": tags,
                "mime": row.mime,
                "width": row.width,
                "height": row.height,
                "url_original": row.url_original,
                "url_thumb": row.url_thumb,
                "created_at": row.created_at,
            }
        )
    out.sort(key=lambda a: str(a.get("created_at", "")), reverse=True)
    return out


def create_private_pack(
    owner_user_id: int,
    slug: str,
    name: str,
    root_rel: str,
    thumb_rel: str,
) -> PrivatePackRow:
    now = utc_now_iso()
    with Session(engine) as s:
        existing = s.exec(select(PrivatePackRow).where(PrivatePackRow.slug == slug)).first()
        if existing:
            raise ValueError("Private pack slug already exists")
        row = PrivatePackRow(
            slug=slug,
            name=name,
            owner_user_id=owner_user_id,
            created_at=now,
            root_rel=root_rel,
            thumb_rel=thumb_rel,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return row


def get_private_pack_by_slug(slug: str) -> Optional[PrivatePackRow]:
    with Session(engine) as s:
        return s.exec(select(PrivatePackRow).where(PrivatePackRow.slug == slug)).first()


def get_private_pack_by_id(pack_id: int) -> Optional[PrivatePackRow]:
    with Session(engine) as s:
        return s.get(PrivatePackRow, pack_id)


def get_pack_asset_by_asset_id(asset_id: str) -> Optional[PrivatePackAssetRow]:
    with Session(engine) as s:
        return s.get(PrivatePackAssetRow, asset_id)


def user_has_pack_access(user_id: int, pack_id: int) -> bool:
    with Session(engine) as s:
        pack = s.get(PrivatePackRow, pack_id)
        if not pack:
            return False
        if int(pack.owner_user_id) == int(user_id):
            return True
        entitlement = s.get(PrivatePackEntitlementRow, (pack_id, user_id))
        return entitlement is not None


def grant_private_pack_access(pack_id: int, user_id: int) -> None:
    now = utc_now_iso()
    with Session(engine) as s:
        row = s.get(PrivatePackEntitlementRow, (pack_id, user_id))
        if row:
            row.granted_at = now
            s.add(row)
        else:
            s.add(PrivatePackEntitlementRow(pack_id=pack_id, user_id=user_id, granted_at=now))
        s.commit()


def revoke_private_pack_access(pack_id: int, user_id: int) -> None:
    with Session(engine) as s:
        row = s.get(PrivatePackEntitlementRow, (pack_id, user_id))
        if not row:
            return
        s.delete(row)
        s.commit()


def _pack_ids_for_user(user_id: int) -> set[int]:
    with Session(engine) as s:
        owned = s.exec(select(PrivatePackRow.pack_id).where(PrivatePackRow.owner_user_id == user_id)).all()
        entitled = s.exec(
            select(PrivatePackEntitlementRow.pack_id).where(PrivatePackEntitlementRow.user_id == user_id)
        ).all()
    return {int(pid) for pid in [*owned, *entitled] if pid is not None}


def list_private_packs_for_user(user_id: int) -> List[Dict[str, object]]:
    pack_ids = _pack_ids_for_user(user_id)
    if not pack_ids:
        return []
    with Session(engine) as s:
        packs = s.exec(select(PrivatePackRow).where(PrivatePackRow.pack_id.in_(pack_ids))).all()
    out: List[Dict[str, object]] = []
    for p in packs:
        out.append(
            {
                "pack_id": p.pack_id,
                "slug": p.slug,
                "name": p.name,
                "owner_user_id": p.owner_user_id,
                "created_at": p.created_at,
                "root_rel": p.root_rel,
                "thumb_rel": p.thumb_rel,
            }
        )
    out.sort(key=lambda p: str(p.get("created_at", "")), reverse=True)
    return out


def list_pack_assets_for_user(user_id: int, q: str = "", tag: str = "", folder: str = "") -> List[Dict[str, object]]:
    qn = (q or "").strip().lower()
    tn = (tag or "").strip().lower()
    fn = (folder or "").strip().strip("/").lower()
    pack_ids = _pack_ids_for_user(user_id)
    if not pack_ids:
        return []

    with Session(engine) as s:
        packs = s.exec(select(PrivatePackRow).where(PrivatePackRow.pack_id.in_(pack_ids))).all()
        slug_by_pack_id = {int(p.pack_id): p.slug for p in packs if p.pack_id is not None}
        rows = s.exec(select(PrivatePackAssetRow).where(PrivatePackAssetRow.pack_id.in_(pack_ids))).all()

    out: List[Dict[str, object]] = []
    for row in rows:
        try:
            tags = [str(t).strip() for t in (json.loads(row.tags_json or "[]") or []) if str(t).strip()]
        except Exception:
            tags = []
        if qn and qn not in (row.name or "").lower() and not any(qn in t.lower() for t in tags):
            continue
        if tn and not any(tn == t.lower() for t in tags):
            continue
        if fn and str(row.folder_path or "").strip("/").lower() != fn:
            continue
        out.append(
            {
                "asset_id": row.asset_id,
                "name": row.name,
                "folder_path": row.folder_path or "",
                "tags": tags,
                "mime": row.mime,
                "width": row.width,
                "height": row.height,
                "url_original": f"/api/assets/file/{row.asset_id}",
                "url_thumb": f"/api/assets/file/{row.asset_id}",
                "created_at": row.created_at,
                "readonly": True,
                "source": "pack",
                "pack_slug": slug_by_pack_id.get(int(row.pack_id), ""),
            }
        )
    out.sort(key=lambda a: str(a.get("created_at", "")), reverse=True)
    return out


def list_all_assets_for_user(user_id: int, q: str = "", tag: str = "", folder: str = "") -> List[Dict[str, object]]:
    uploads = []
    for a in list_assets_for_user(user_id, q=q, tag=tag, folder=folder):
        item = dict(a)
        item["readonly"] = False
        item["source"] = "upload"
        uploads.append(item)
    packs = list_pack_assets_for_user(user_id, q=q, tag=tag, folder=folder)
    merged = [*uploads, *packs]
    merged.sort(key=lambda a: str(a.get("created_at", "")), reverse=True)
    return merged


def get_asset_by_id(asset_id: str) -> Optional[AssetRow]:
    """Return an asset record regardless of who uploaded it (for serving files to room members)."""
    with Session(engine) as s:
        return s.get(AssetRow, asset_id)


def get_asset_for_user(asset_id: str, user_id: int) -> Optional[AssetRow]:
    with Session(engine) as s:
        row = s.get(AssetRow, asset_id)
        if not row or row.uploader_user_id != user_id:
            return None
        return row


def delete_asset_record(asset_id: str, user_id: int) -> bool:
    with Session(engine) as s:
        row = s.get(AssetRow, asset_id)
        if not row or row.uploader_user_id != user_id:
            return False
        s.delete(row)
        s.commit()
        return True
