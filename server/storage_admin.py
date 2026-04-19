from __future__ import annotations

from typing import Dict, List, Optional

from sqlmodel import Session, desc, select

from . import storage_db
from .storage_models import (
    AssetRow,
    PrivatePackEntitlementRow,
    PrivatePackRow,
    RoomMetaRow,
    SessionRow,
    UserRow,
)

engine = storage_db.engine


def set_engine(value) -> None:
    global engine
    engine = value


def list_users(q: str = "", limit: int = 100) -> List[Dict[str, object]]:
    safe_limit = max(1, min(int(limit or 100), 500))
    query = str(q or "").strip().lower()
    with Session(engine) as s:
        rows = s.exec(select(UserRow).order_by(UserRow.username)).all()
        if query:
            rows = [row for row in rows if query in str(row.username or "").lower()]
        rows = rows[:safe_limit]
    return [
        {
            "user_id": row.user_id,
            "username": row.username,
            "role": row.role or "user",
            "status": row.status or "active",
            "must_change_password": bool(row.must_change_password),
            "created_at": row.created_at,
            "last_room_id": row.last_room_id,
            "deleted_at": row.deleted_at,
            "disabled_at": row.disabled_at,
        }
        for row in rows
    ]


def count_users() -> int:
    with Session(engine) as s:
        rows = s.exec(select(UserRow.user_id)).all()
    return len(rows)


def count_owned_rooms(user_id: int) -> int:
    with Session(engine) as s:
        rows = s.exec(select(RoomMetaRow.room_id).where(RoomMetaRow.owner_user_id == user_id)).all()
    return len(rows)


def list_owned_assets(user_id: int, limit: int = 12) -> List[Dict[str, object]]:
    safe_limit = max(1, min(int(limit or 12), 100))
    with Session(engine) as s:
        rows = s.exec(
            select(AssetRow)
            .where(AssetRow.uploader_user_id == user_id)
            .order_by(desc(AssetRow.created_at))
            .limit(safe_limit)
        ).all()
    return [
        {
            "asset_id": row.asset_id,
            "name": row.name,
            "folder_path": row.folder_path,
            "mime": row.mime,
            "width": row.width,
            "height": row.height,
            "url_original": row.url_original,
            "url_thumb": row.url_thumb,
            "created_at": row.created_at,
        }
        for row in rows
    ]


def count_owned_assets(user_id: int) -> int:
    with Session(engine) as s:
        rows = s.exec(select(AssetRow.asset_id).where(AssetRow.uploader_user_id == user_id)).all()
    return len(rows)


def list_owned_packs(user_id: int, limit: int = 20) -> List[Dict[str, object]]:
    safe_limit = max(1, min(int(limit or 20), 100))
    with Session(engine) as s:
        rows = s.exec(
            select(PrivatePackRow)
            .where(PrivatePackRow.owner_user_id == user_id)
            .order_by(desc(PrivatePackRow.created_at))
            .limit(safe_limit)
        ).all()
    return [
        {
            "pack_id": row.pack_id,
            "slug": row.slug,
            "name": row.name,
            "description": row.description or "",
            "content_type": row.content_type or "asset_pack",
            "pack_scope": row.pack_scope or "personal",
            "globally_visible": bool(row.globally_visible),
            "archived": bool(row.archived),
            "owner_user_id": row.owner_user_id,
            "created_at": row.created_at,
            "root_rel": row.root_rel,
            "thumb_rel": row.thumb_rel,
        }
        for row in rows
    ]


def count_owned_packs(user_id: int) -> int:
    with Session(engine) as s:
        rows = s.exec(select(PrivatePackRow.pack_id).where(PrivatePackRow.owner_user_id == user_id)).all()
    return len(rows)


def list_user_pack_entitlements(user_id: int) -> List[Dict[str, object]]:
    with Session(engine) as s:
        rows = s.exec(
            select(PrivatePackEntitlementRow).where(PrivatePackEntitlementRow.user_id == user_id)
        ).all()
        pack_ids = [row.pack_id for row in rows]
        packs = (
            {row.pack_id: row for row in s.exec(select(PrivatePackRow).where(PrivatePackRow.pack_id.in_(pack_ids))).all()}
            if pack_ids
            else {}
        )
    out: List[Dict[str, object]] = []
    for row in rows:
        pack = packs.get(row.pack_id)
        out.append(
            {
                "pack_id": row.pack_id,
                "granted_at": row.granted_at,
                "pack_name": pack.name if pack else f"Pack {row.pack_id}",
                "pack_slug": pack.slug if pack else "",
                "content_type": pack.content_type if pack else "asset_pack",
                "pack_scope": pack.pack_scope if pack else "personal",
                "owner_user_id": pack.owner_user_id if pack else None,
            }
        )
    out.sort(key=lambda item: str(item.get("pack_name") or "").lower())
    return out


def list_all_private_packs(limit: int = 200) -> List[Dict[str, object]]:
    safe_limit = max(1, min(int(limit or 200), 500))
    with Session(engine) as s:
        packs = s.exec(select(PrivatePackRow).order_by(PrivatePackRow.name).limit(safe_limit)).all()
        owner_ids = sorted({int(pack.owner_user_id) for pack in packs if pack.owner_user_id is not None})
        owners = (
            {row.user_id: row for row in s.exec(select(UserRow).where(UserRow.user_id.in_(owner_ids))).all()}
            if owner_ids
            else {}
        )
        ent_rows = s.exec(select(PrivatePackEntitlementRow)).all()
    entitlement_counts: Dict[int, int] = {}
    for row in ent_rows:
        entitlement_counts[int(row.pack_id)] = entitlement_counts.get(int(row.pack_id), 0) + 1
    return [
        {
            "pack_id": pack.pack_id,
            "slug": pack.slug,
            "name": pack.name,
            "description": pack.description or "",
            "content_type": pack.content_type or "asset_pack",
            "pack_scope": pack.pack_scope or "personal",
            "globally_visible": bool(pack.globally_visible),
            "archived": bool(pack.archived),
            "owner_user_id": pack.owner_user_id,
            "owner_username": owners.get(pack.owner_user_id).username if owners.get(pack.owner_user_id) else "",
            "created_at": pack.created_at,
            "entitlement_count": entitlement_counts.get(int(pack.pack_id or 0), 0),
        }
        for pack in packs
    ]


def get_user_detail(user_id: int) -> Optional[Dict[str, object]]:
    with Session(engine) as s:
        user = s.get(UserRow, user_id)
        if not user:
            return None
        session_count = len(s.exec(select(SessionRow.sid).where(SessionRow.user_id == user_id)).all())
    return {
        "user_id": user.user_id,
        "username": user.username,
        "role": user.role or "user",
        "status": user.status or "active",
        "must_change_password": bool(user.must_change_password),
        "created_at": user.created_at,
        "last_room_id": user.last_room_id,
        "disabled_at": user.disabled_at,
        "disabled_reason": user.disabled_reason,
        "deleted_at": user.deleted_at,
        "session_count": session_count,
        "owned_room_count": count_owned_rooms(user_id),
        "owned_asset_count": count_owned_assets(user_id),
        "owned_pack_count": count_owned_packs(user_id),
    }
