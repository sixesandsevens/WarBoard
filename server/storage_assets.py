from __future__ import annotations

import json
import logging
import sqlite3
import time
from contextlib import contextmanager
from typing import Callable, Dict, List, Optional, Tuple

from sqlmodel import Session, select

from . import storage_db
from .storage_models import AssetRow, PrivatePackAssetRow, PrivatePackEntitlementRow, PrivatePackRow, UserRow

_PACK_ACCESS_PRIORITY = {
    "official": -1,
    "owned": 0,
    "direct_entitlement": 1,
    "session_shared": 2,
}

PACK_CONTENT_TYPES = {"asset_pack", "token_pack"}
PACK_SCOPES = {"personal", "official"}

engine = storage_db.engine
logger = logging.getLogger("warhamster.assets")


def _normalize_pack_content_type(value: str, default: str = "asset_pack") -> str:
    raw = str(value or "").strip().lower()
    return raw if raw in PACK_CONTENT_TYPES else default


def _normalize_pack_scope(value: str, default: str = "personal") -> str:
    raw = str(value or "").strip().lower()
    return raw if raw in PACK_SCOPES else default


@contextmanager
def _raw_conn_ctx():
    """Raw SQLite connection with row_factory, checked out from the SQLAlchemy engine pool.

    Using engine.raw_connection() avoids opening a second sqlite3.connect() which
    would create a fresh empty database for :memory: URLs (used in tests).
    driver_connection is the actual sqlite3.Connection; row_factory must be set there.
    """
    proxy = engine.raw_connection()
    conn = proxy.driver_connection
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        proxy.close()


def set_engine(value) -> None:
    global engine
    engine = value


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
    now_iso: str,
) -> None:
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
                created_at=now_iso,
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
    out.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
    return out


def create_private_pack(
    owner_user_id: int,
    slug: str,
    name: str,
    root_rel: str,
    thumb_rel: str,
    now_iso: str,
    *,
    description: str = "",
    content_type: str = "asset_pack",
    pack_scope: str = "personal",
    globally_visible: bool = False,
    archived: bool = False,
) -> PrivatePackRow:
    with Session(engine) as s:
        existing = s.exec(select(PrivatePackRow).where(PrivatePackRow.slug == slug)).first()
        if existing:
            raise ValueError("Private pack slug already exists")
        row = PrivatePackRow(
            slug=slug,
            name=name,
            owner_user_id=owner_user_id,
            created_at=now_iso,
            description=str(description or "").strip(),
            content_type=_normalize_pack_content_type(content_type),
            pack_scope=_normalize_pack_scope(pack_scope),
            globally_visible=bool(globally_visible),
            archived=bool(archived),
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


def update_private_pack(
    pack_id: int,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    globally_visible: Optional[bool] = None,
    archived: Optional[bool] = None,
) -> Optional[PrivatePackRow]:
    with Session(engine) as s:
        row = s.get(PrivatePackRow, pack_id)
        if not row:
            return None
        if name is not None:
            row.name = str(name or "").strip() or row.name
        if description is not None:
            row.description = str(description or "").strip()
        if globally_visible is not None:
            row.globally_visible = bool(globally_visible)
        if archived is not None:
            row.archived = bool(archived)
        s.add(row)
        s.commit()
        s.refresh(row)
        return row


def add_private_pack_asset_record(
    *,
    pack_id: int,
    asset_id: str,
    name: str,
    folder_path: str = "",
    tags: List[str],
    mime: str,
    width: int,
    height: int,
    url_original: str,
    url_thumb: str,
    now_iso: str,
) -> PrivatePackAssetRow:
    with Session(engine) as s:
        row = PrivatePackAssetRow(
            asset_id=asset_id,
            pack_id=pack_id,
            name=name,
            folder_path=folder_path or "",
            tags_json=json.dumps(tags or []),
            mime=mime,
            width=max(0, int(width or 0)),
            height=max(0, int(height or 0)),
            url_original=url_original,
            url_thumb=url_thumb,
            created_at=now_iso,
        )
        s.add(row)
        s.commit()
        s.refresh(row)
        return row


def delete_private_pack_asset_record(pack_id: int, asset_id: str) -> bool:
    with Session(engine) as s:
        row = s.get(PrivatePackAssetRow, asset_id)
        if not row or int(row.pack_id) != int(pack_id):
            return False
        s.delete(row)
        s.commit()
        return True


def delete_private_pack_asset_rows(pack_id: int) -> int:
    with Session(engine) as s:
        rows = s.exec(select(PrivatePackAssetRow).where(PrivatePackAssetRow.pack_id == pack_id)).all()
        count = len(rows)
        for row in rows:
            s.delete(row)
        s.commit()
        return count


def delete_private_pack_row(pack_id: int) -> bool:
    with Session(engine) as s:
        pack = s.get(PrivatePackRow, pack_id)
        if not pack:
            return False
        entitlements = s.exec(
            select(PrivatePackEntitlementRow).where(PrivatePackEntitlementRow.pack_id == pack_id)
        ).all()
        for row in entitlements:
            s.delete(row)
        s.delete(pack)
        s.commit()
        return True


def count_private_pack_asset_rows(pack_id: int) -> int:
    with Session(engine) as s:
        return len(s.exec(select(PrivatePackAssetRow.asset_id).where(PrivatePackAssetRow.pack_id == pack_id)).all())


def list_private_pack_assets(pack_id: int) -> List[PrivatePackAssetRow]:
    with Session(engine) as s:
        return s.exec(select(PrivatePackAssetRow).where(PrivatePackAssetRow.pack_id == pack_id)).all()


def get_pack_asset_by_asset_id(asset_id: str) -> Optional[PrivatePackAssetRow]:
    with Session(engine) as s:
        return s.get(PrivatePackAssetRow, asset_id)


def user_has_pack_access(user_id: int, pack_id: int) -> bool:
    with Session(engine) as s:
        pack = s.get(PrivatePackRow, pack_id)
        if not pack:
            return False
        if bool(getattr(pack, "archived", False)):
            return False
        if str(getattr(pack, "pack_scope", "") or "") == "official" and bool(getattr(pack, "globally_visible", False)):
            return True
        if int(pack.owner_user_id) == int(user_id):
            return True
        entitlement = s.get(PrivatePackEntitlementRow, (pack_id, user_id))
        return entitlement is not None


def grant_private_pack_access(pack_id: int, user_id: int, now_iso: str) -> None:
    with Session(engine) as s:
        row = s.get(PrivatePackEntitlementRow, (pack_id, user_id))
        if row:
            row.granted_at = now_iso
            s.add(row)
        else:
            s.add(PrivatePackEntitlementRow(pack_id=pack_id, user_id=user_id, granted_at=now_iso))
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
        owned = s.exec(
            select(PrivatePackRow.pack_id).where(
                PrivatePackRow.owner_user_id == user_id,
                PrivatePackRow.archived == False,  # noqa: E712
            )
        ).all()
        official = s.exec(
            select(PrivatePackRow.pack_id).where(
                PrivatePackRow.pack_scope == "official",
                PrivatePackRow.globally_visible == True,  # noqa: E712
                PrivatePackRow.archived == False,  # noqa: E712
            )
        ).all()
        entitled = s.exec(
            select(PrivatePackEntitlementRow.pack_id).where(PrivatePackEntitlementRow.user_id == user_id)
        ).all()
    return {int(pack_id) for pack_id in [*owned, *official, *entitled] if pack_id is not None}


def _pack_access_sources_for_user(
    user_id: int,
    session_id: Optional[str],
    *,
    is_game_session_member: Callable[[str, int], bool],
    shared_pack_ids_for_game_session: Callable[[str], set[int]],
) -> tuple[Dict[int, List[str]], set[int]]:
    with Session(engine) as s:
        owned_ids = {
            int(pack_id)
            for pack_id in s.exec(
                select(PrivatePackRow.pack_id).where(
                    PrivatePackRow.owner_user_id == user_id,
                    PrivatePackRow.archived == False,  # noqa: E712
                )
            ).all()
            if pack_id is not None
        }
        official_ids = {
            int(pack_id)
            for pack_id in s.exec(
                select(PrivatePackRow.pack_id).where(
                    PrivatePackRow.pack_scope == "official",
                    PrivatePackRow.globally_visible == True,  # noqa: E712
                    PrivatePackRow.archived == False,  # noqa: E712
                )
            ).all()
            if pack_id is not None
        }
        entitled_ids = {
            int(pack_id)
            for pack_id in s.exec(select(PrivatePackEntitlementRow.pack_id).where(PrivatePackEntitlementRow.user_id == user_id)).all()
            if pack_id is not None
        }
    shared_ids = (
        shared_pack_ids_for_game_session(session_id)
        if session_id and is_game_session_member(session_id, user_id)
        else set()
    )
    source_map: Dict[int, set[str]] = {}
    for pack_id in official_ids:
        source_map.setdefault(pack_id, set()).add("official")
    for pack_id in owned_ids:
        source_map.setdefault(pack_id, set()).add("owned")
    for pack_id in entitled_ids:
        source_map.setdefault(pack_id, set()).add("direct_entitlement")
    for pack_id in shared_ids:
        source_map.setdefault(int(pack_id), set()).add("session_shared")
    normalized = {
        int(pack_id): sorted(
            {str(source or "").strip() for source in sources if str(source or "").strip()},
            key=lambda source: _PACK_ACCESS_PRIORITY.get(source, 99),
        )
        for pack_id, sources in source_map.items()
    }
    return normalized, shared_ids


def _primary_pack_access_source(access_sources: List[str]) -> str:
    if not access_sources:
        return "direct_entitlement"
    return access_sources[0]


def _pack_access_metadata(
    pack_id: int,
    access_sources_by_pack_id: Dict[int, List[str]],
    *,
    session_id: Optional[str] = None,
) -> Dict[str, object]:
    access_sources = list(access_sources_by_pack_id.get(int(pack_id), []))
    access_source = _primary_pack_access_source(access_sources)
    shared_via_sessions = (
        [{"session_id": session_id, "label": "Current Session"}]
        if session_id and "session_shared" in access_sources
        else []
    )
    return {
        "access_source": access_source,
        "access_sources": access_sources,
        "shared_in_session": "session_shared" in access_sources,
        "shared_via_sessions": shared_via_sessions,
    }


def list_private_packs_for_user(
    user_id: int,
    session_id: Optional[str] = None,
    *,
    content_type: str = "",
    is_game_session_member: Callable[[str, int], bool],
    shared_pack_ids_for_game_session: Callable[[str], set[int]],
) -> List[Dict[str, object]]:
    access_sources_by_pack_id, _shared_ids = _pack_access_sources_for_user(
        user_id,
        session_id,
        is_game_session_member=is_game_session_member,
        shared_pack_ids_for_game_session=shared_pack_ids_for_game_session,
    )
    pack_ids = set(access_sources_by_pack_id.keys())
    if not pack_ids:
        return []
    with Session(engine) as s:
        packs = s.exec(select(PrivatePackRow).where(PrivatePackRow.pack_id.in_(pack_ids))).all()
        owner_ids = sorted({int(pack.owner_user_id) for pack in packs if pack.owner_user_id is not None})
        owners = (
            {
                row.user_id: row.username
                for row in s.exec(select(UserRow).where(UserRow.user_id.in_(owner_ids))).all()
            }
            if owner_ids
            else {}
        )
    out: List[Dict[str, object]] = []
    normalized_content_type = _normalize_pack_content_type(content_type, "") if content_type else ""
    for pack in packs:
        if bool(getattr(pack, "archived", False)):
            continue
        if normalized_content_type and str(getattr(pack, "content_type", "") or "") != normalized_content_type:
            continue
        pack_id = int(pack.pack_id) if pack.pack_id is not None else 0
        access_meta = _pack_access_metadata(pack_id, access_sources_by_pack_id, session_id=session_id)
        out.append(
            {
                "pack_id": pack.pack_id,
                "slug": pack.slug,
                "name": pack.name,
                "description": getattr(pack, "description", "") or "",
                "content_type": getattr(pack, "content_type", "asset_pack") or "asset_pack",
                "pack_scope": getattr(pack, "pack_scope", "personal") or "personal",
                "globally_visible": bool(getattr(pack, "globally_visible", False)),
                "archived": bool(getattr(pack, "archived", False)),
                "owner_user_id": pack.owner_user_id,
                "owner_username": owners.get(pack.owner_user_id, "") if pack.owner_user_id is not None else "",
                "created_at": pack.created_at,
                "root_rel": pack.root_rel,
                "thumb_rel": pack.thumb_rel,
                **access_meta,
            }
        )
    out.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
    return out


def list_pack_assets_for_user(
    user_id: int,
    q: str = "",
    tag: str = "",
    folder: str = "",
    session_id: Optional[str] = None,
    content_type: str = "asset_pack",
    *,
    is_game_session_member: Callable[[str, int], bool],
    shared_pack_ids_for_game_session: Callable[[str], set[int]],
) -> List[Dict[str, object]]:
    qn = (q or "").strip().lower()
    tn = (tag or "").strip().lower()
    fn = (folder or "").strip().strip("/").lower()
    access_sources_by_pack_id, _shared_ids = _pack_access_sources_for_user(
        user_id,
        session_id,
        is_game_session_member=is_game_session_member,
        shared_pack_ids_for_game_session=shared_pack_ids_for_game_session,
    )
    pack_ids = set(access_sources_by_pack_id.keys())
    if not pack_ids:
        return []
    with Session(engine) as s:
        packs = s.exec(select(PrivatePackRow).where(PrivatePackRow.pack_id.in_(pack_ids))).all()
        normalized_content_type = _normalize_pack_content_type(content_type, "asset_pack") if content_type else ""
        packs = [
            pack for pack in packs
            if not bool(getattr(pack, "archived", False))
            and (not normalized_content_type or str(getattr(pack, "content_type", "") or "") == normalized_content_type)
        ]
        if not packs:
            return []
        slug_by_pack_id = {int(pack.pack_id): pack.slug for pack in packs if pack.pack_id is not None}
        name_by_pack_id = {int(pack.pack_id): pack.name for pack in packs if pack.pack_id is not None}
        owner_id_by_pack_id = {int(pack.pack_id): int(pack.owner_user_id) for pack in packs if pack.pack_id is not None and pack.owner_user_id is not None}
        content_type_by_pack_id = {int(pack.pack_id): str(getattr(pack, "content_type", "asset_pack") or "asset_pack") for pack in packs if pack.pack_id is not None}
        scope_by_pack_id = {int(pack.pack_id): str(getattr(pack, "pack_scope", "personal") or "personal") for pack in packs if pack.pack_id is not None}
        global_by_pack_id = {int(pack.pack_id): bool(getattr(pack, "globally_visible", False)) for pack in packs if pack.pack_id is not None}
        owner_ids = sorted(set(owner_id_by_pack_id.values()))
        owners = (
            {
                row.user_id: row.username
                for row in s.exec(select(UserRow).where(UserRow.user_id.in_(owner_ids))).all()
            }
            if owner_ids
            else {}
        )
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
                "pack_id": row.pack_id,
                "pack_slug": slug_by_pack_id.get(int(row.pack_id), ""),
                "pack_name": name_by_pack_id.get(int(row.pack_id), ""),
                "content_type": content_type_by_pack_id.get(int(row.pack_id), "asset_pack"),
                "pack_scope": scope_by_pack_id.get(int(row.pack_id), "personal"),
                "globally_visible": global_by_pack_id.get(int(row.pack_id), False),
                "owner_user_id": owner_id_by_pack_id.get(int(row.pack_id)),
                "owner_username": owners.get(owner_id_by_pack_id.get(int(row.pack_id)), "") if owner_id_by_pack_id.get(int(row.pack_id)) is not None else "",
                **_pack_access_metadata(int(row.pack_id), access_sources_by_pack_id, session_id=session_id),
            }
        )
    out.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
    return out


def _normalize_asset_type(value: str) -> str:
    raw = (value or "").strip().lower()
    return "jpg" if raw == "jpeg" else raw


def _normalize_asset_alpha(value: str) -> str:
    raw = (value or "").strip().lower()
    if raw in {"yes", "true", "1"}:
        return "yes"
    if raw in {"no", "false", "0"}:
        return "no"
    return ""


def _normalize_asset_kind(value: str) -> str:
    raw = (value or "").strip().lower()
    if raw in {"pieces", "piece"}:
        return "piece"
    if raw in {"maps", "map"}:
        return "map"
    if raw == "unknown":
        return "unknown"
    return ""


def _asset_type_sql(alias: str) -> str:
    return (
        f"CASE "
        f"WHEN LOWER(COALESCE({alias}.mime, '')) = 'image/jpeg' THEN 'jpg' "
        f"WHEN LOWER(COALESCE({alias}.mime, '')) = 'image/png' THEN 'png' "
        f"WHEN LOWER(COALESCE({alias}.mime, '')) = 'image/webp' THEN 'webp' "
        f"WHEN LOWER(COALESCE({alias}.mime, '')) = 'image/gif' THEN 'gif' "
        f"ELSE '' END"
    )


def _asset_has_alpha_sql(alias: str) -> str:
    return f"({_asset_type_sql(alias)} IN ('png', 'webp', 'gif'))"


def _asset_name_folder_sql(alias: str) -> str:
    return f"LOWER(COALESCE({alias}.name, '') || ' ' || COALESCE({alias}.folder_path, ''))"


def _asset_kind_sql(alias: str) -> str:
    name_folder = _asset_name_folder_sql(alias)
    has_alpha = _asset_has_alpha_sql(alias)
    largest_edge = f"MAX(COALESCE({alias}.width, 0), COALESCE({alias}.height, 0))"
    area = f"(COALESCE({alias}.width, 0) * COALESCE({alias}.height, 0))"
    return (
        "CASE "
        f"WHEN NOT {has_alpha} AND ({largest_edge} >= 1500 OR {area} >= 2000000) THEN 'map' "
        f"WHEN {name_folder} LIKE '%map%' OR {name_folder} LIKE '%battlemap%' OR {name_folder} LIKE '%scene%' OR {name_folder} LIKE '%terrain%' THEN 'map' "
        f"WHEN {has_alpha} AND {largest_edge} <= 1500 THEN 'piece' "
        f"WHEN {name_folder} LIKE '%tile%' OR {name_folder} LIKE '%wall%' OR {name_folder} LIKE '%prop%' OR {name_folder} LIKE '%token%' "
        f"OR {name_folder} LIKE '%tree%' OR {name_folder} LIKE '%rock%' OR {name_folder} LIKE '%door%' OR {name_folder} LIKE '%piece%' "
        f"OR {name_folder} LIKE '%object%' OR {name_folder} LIKE '%debris%' THEN 'piece' "
        "ELSE 'unknown' END"
    )


def _asset_order_sql(sort: str) -> str:
    raw = (sort or "").strip().lower()
    if raw == "largest":
        return "(COALESCE(width, 0) * COALESCE(height, 0)) DESC, created_at DESC, LOWER(COALESCE(name, '')) ASC"
    if raw == "name":
        return "LOWER(COALESCE(name, '')) ASC, created_at DESC"
    return "created_at DESC, LOWER(COALESCE(name, '')) ASC"


def list_asset_folders_for_user(
    user_id: int,
    *,
    q: str = "",
    tag: str = "",
    pack: str = "",
    kind: str = "",
    type: str = "",
    alpha: str = "",
    session_id: Optional[str] = None,
    skip_missing: bool = False,  # handled by callers; kept for API compat
    is_game_session_member: Callable[[str, int], bool],
    shared_pack_ids_for_game_session: Callable[[str], set[int]],
) -> List[Dict[str, object]]:
    """
    Return per-folder asset counts using SQL GROUP BY for all filter combinations.
    All filtering (q, tag, kind, type, alpha, pack) is pushed into SQL — no full
    asset-universe scan.  skip_missing requires disk I/O so it is handled upstream
    (app.py) before this function is called.
    """
    pack_filter = (pack or "").strip()
    qn = (q or "").strip().lower()
    tn = (tag or "").strip().lower()
    kind_filter = _normalize_asset_kind(kind)
    type_filter = _normalize_asset_type(type)
    alpha_filter = _normalize_asset_alpha(alpha)

    pack_ids = _pack_ids_for_user(user_id)
    if session_id and is_game_session_member(session_id, user_id):
        pack_ids.update(shared_pack_ids_for_game_session(session_id))

    with _raw_conn_ctx() as conn:
        slug_by_pack_id: Dict[int, str] = {}
        if pack_ids:
            ph = ",".join("?" * len(pack_ids))
            for row in conn.execute(
                f"SELECT pack_id, slug FROM privatepackrow WHERE pack_id IN ({ph}) AND COALESCE(archived, 0) = 0 AND COALESCE(content_type, 'asset_pack') = 'asset_pack'",
                list(pack_ids),
            ).fetchall():
                slug_by_pack_id[int(row["pack_id"])] = str(row["slug"] or "")

        include_uploads = pack_filter in {"", "all", "upload"}
        selected_pack_ids = [] if pack_filter == "upload" else list(pack_ids)
        if pack_filter and pack_filter not in {"all", "upload"}:
            selected_pack_ids = [pid for pid, slug in slug_by_pack_id.items() if slug == pack_filter]
            include_uploads = False

        # Build WHERE fragments (mirroring list_assets_for_user_page logic)
        upload_wheres: List[str] = ["a.uploader_user_id = ?", "COALESCE(a.folder_path, '') != ''"]
        upload_params: List[object] = [user_id]
        pack_extra_wheres: List[str] = ["COALESCE(pa.folder_path, '') != ''"]
        pack_extra_params: List[object] = []

        if qn:
            upload_wheres.append(
                "(LOWER(a.name) LIKE ? OR EXISTS"
                " (SELECT 1 FROM json_each(COALESCE(a.tags_json, '[]')) WHERE LOWER(value) LIKE ?))"
            )
            upload_params.extend([f"%{qn}%", f"%{qn}%"])
            pack_extra_wheres.append(
                "(LOWER(pa.name) LIKE ? OR EXISTS"
                " (SELECT 1 FROM json_each(COALESCE(pa.tags_json, '[]')) WHERE LOWER(value) LIKE ?))"
            )
            pack_extra_params.extend([f"%{qn}%", f"%{qn}%"])

        if tn:
            upload_wheres.append(
                "EXISTS (SELECT 1 FROM json_each(COALESCE(a.tags_json, '[]')) WHERE LOWER(value) = ?)"
            )
            upload_params.append(tn)
            pack_extra_wheres.append(
                "EXISTS (SELECT 1 FROM json_each(COALESCE(pa.tags_json, '[]')) WHERE LOWER(value) = ?)"
            )
            pack_extra_params.append(tn)

        if type_filter:
            upload_wheres.append(f"{_asset_type_sql('a')} = ?")
            upload_params.append(type_filter)
            pack_extra_wheres.append(f"{_asset_type_sql('pa')} = ?")
            pack_extra_params.append(type_filter)

        if alpha_filter:
            wants_alpha = alpha_filter == "yes"
            upload_wheres.append(_asset_has_alpha_sql("a") if wants_alpha else f"NOT {_asset_has_alpha_sql('a')}")
            pack_extra_wheres.append(_asset_has_alpha_sql("pa") if wants_alpha else f"NOT {_asset_has_alpha_sql('pa')}")

        if kind_filter:
            upload_wheres.append(f"{_asset_kind_sql('a')} = ?")
            upload_params.append(kind_filter)
            pack_extra_wheres.append(f"{_asset_kind_sql('pa')} = ?")
            pack_extra_params.append(kind_filter)

        upload_where_sql = " AND ".join(upload_wheres)
        raw_rows: List[dict] = []

        if include_uploads:
            for row in conn.execute(
                f"""
                SELECT a.folder_path, COUNT(*) AS count
                FROM assetrow a
                WHERE {upload_where_sql}
                GROUP BY a.folder_path
                """,
                upload_params,
            ).fetchall():
                raw_rows.append(dict(row))

        if selected_pack_ids:
            ph = ",".join("?" * len(selected_pack_ids))
            pack_wheres = [f"pa.pack_id IN ({ph})"] + pack_extra_wheres
            pack_where_sql = " AND ".join(pack_wheres)
            for row in conn.execute(
                f"""
                SELECT pa.folder_path, COUNT(*) AS count
                FROM privatepackassetrow pa
                WHERE {pack_where_sql}
                GROUP BY pa.folder_path
                """,
                selected_pack_ids + pack_extra_params,
            ).fetchall():
                raw_rows.append(dict(row))

    merged: Dict[str, int] = {}
    for row in raw_rows:
        path = str(row.get("folder_path") or "").strip()
        if not path:
            continue
        merged[path] = merged.get(path, 0) + int(row.get("count") or 0)
    return [{"path": path, "count": count} for path, count in sorted(merged.items())]


def list_all_assets_for_user(
    user_id: int,
    q: str = "",
    tag: str = "",
    folder: str = "",
    pack: str = "",
    kind: str = "",
    type: str = "",
    alpha: str = "",
    sort: str = "recent",
    session_id: Optional[str] = None,
    *,
    is_game_session_member: Callable[[str, int], bool],
    shared_pack_ids_for_game_session: Callable[[str], set[int]],
) -> List[Dict[str, object]]:
    out: List[Dict[str, object]] = []
    offset = 0
    page_size = 500
    while True:
        page, _, has_more = list_assets_for_user_page(
            user_id,
            q=q,
            tag=tag,
            folder=folder,
            pack=pack,
            kind=kind,
            type=type,
            alpha=alpha,
            sort=sort,
            limit=page_size,
            offset=offset,
            session_id=session_id,
            is_game_session_member=is_game_session_member,
            shared_pack_ids_for_game_session=shared_pack_ids_for_game_session,
        )
        out.extend(page)
        if not has_more:
            break
        offset += len(page)
        if not page:
            break
    return out


def list_token_packs_for_user(
    user_id: int,
    session_id: Optional[str] = None,
    *,
    is_game_session_member: Callable[[str, int], bool],
    shared_pack_ids_for_game_session: Callable[[str], set[int]],
) -> List[Dict[str, object]]:
    return list_private_packs_for_user(
        user_id,
        session_id=session_id,
        content_type="token_pack",
        is_game_session_member=is_game_session_member,
        shared_pack_ids_for_game_session=shared_pack_ids_for_game_session,
    )


def get_token_pack_for_user(
    user_id: int,
    pack_id: int,
    session_id: Optional[str] = None,
    *,
    is_game_session_member: Callable[[str, int], bool],
    shared_pack_ids_for_game_session: Callable[[str], set[int]],
) -> Optional[Dict[str, object]]:
    visible = list_token_packs_for_user(
        user_id,
        session_id=session_id,
        is_game_session_member=is_game_session_member,
        shared_pack_ids_for_game_session=shared_pack_ids_for_game_session,
    )
    pack = next((row for row in visible if int(row.get("pack_id") or 0) == int(pack_id)), None)
    if not pack:
        return None
    items = []
    for row in list_private_pack_assets(pack_id):
        items.append(
            {
                "id": str(row.asset_id),
                "name": str(row.name or "Token"),
                "image_url": f"/api/assets/file/{row.asset_id}",
                "thumb_url": f"/api/assets/file/{row.asset_id}?src=assetlib",
                "tags": [str(t).strip().lower() for t in (json.loads(row.tags_json or "[]") or []) if str(t).strip()],
                "folder_path": str(row.folder_path or ""),
                "mime": str(row.mime or ""),
                "width": int(row.width or 0),
                "height": int(row.height or 0),
            }
        )
    items.sort(key=lambda item: str(item.get("name") or "").lower())
    return {
        **pack,
        "tokens": items,
        "token_count": len(items),
    }


def get_asset_by_id(asset_id: str) -> Optional[AssetRow]:
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


def list_assets_for_user_page(
    user_id: int,
    q: str = "",
    tag: str = "",
    folder: str = "",
    pack: str = "",
    kind: str = "",
    type: str = "",
    alpha: str = "",
    sort: str = "recent",
    limit: int = 120,
    offset: int = 0,
    session_id: Optional[str] = None,
    *,
    is_game_session_member: Callable[[str, int], bool],
    shared_pack_ids_for_game_session: Callable[[str], set[int]],
) -> Tuple[List[Dict[str, object]], int, bool]:
    """
    Paginated merged query for uploaded + entitled private pack assets.
    Pushes ordering and row-level filtering into SQL — only loads the requested
    page rather than the entire asset universe.
    Returns (items, total_count, has_more).
    """
    t0 = time.perf_counter()

    qn = (q or "").strip().lower()
    tn = (tag or "").strip().lower()
    fn = (folder or "").strip().strip("/").lower()
    pack_filter = (pack or "").strip()
    kind_filter = _normalize_asset_kind(kind)
    type_filter = _normalize_asset_type(type)
    alpha_filter = _normalize_asset_alpha(alpha)
    order_sql = _asset_order_sql(sort)
    safe_limit = min(max(1, int(limit or 1)), 500)
    safe_offset = max(0, int(offset or 0))

    # Resolve which pack IDs this user may see (owned + entitled + session-shared)
    access_sources_by_pack_id, _shared_ids = _pack_access_sources_for_user(
        user_id,
        session_id,
        is_game_session_member=is_game_session_member,
        shared_pack_ids_for_game_session=shared_pack_ids_for_game_session,
    )
    pack_ids = set(access_sources_by_pack_id.keys())

    # Build SQL WHERE fragments — name, folder, and tag all pushed into SQL
    upload_wheres: List[str] = ["a.uploader_user_id = ?"]
    upload_params: List[object] = [user_id]
    pack_extra_wheres: List[str] = []
    pack_extra_params: List[object] = []

    if qn:
        # Match name OR any tag — preserves legacy list_assets_for_user behaviour.
        upload_wheres.append(
            "(LOWER(a.name) LIKE ? OR EXISTS"
            " (SELECT 1 FROM json_each(COALESCE(a.tags_json, '[]')) WHERE LOWER(value) LIKE ?))"
        )
        upload_params.extend([f"%{qn}%", f"%{qn}%"])
        pack_extra_wheres.append(
            "(LOWER(pa.name) LIKE ? OR EXISTS"
            " (SELECT 1 FROM json_each(COALESCE(pa.tags_json, '[]')) WHERE LOWER(value) LIKE ?))"
        )
        pack_extra_params.extend([f"%{qn}%", f"%{qn}%"])

    if fn:
        upload_wheres.append("LOWER(TRIM(a.folder_path, '/')) = ?")
        upload_params.append(fn)
        pack_extra_wheres.append("LOWER(TRIM(pa.folder_path, '/')) = ?")
        pack_extra_params.append(fn)

    if tn:
        # Use json_each to filter tags in SQL so count and page results are always consistent.
        upload_wheres.append(
            "EXISTS (SELECT 1 FROM json_each(COALESCE(a.tags_json, '[]')) WHERE LOWER(value) = ?)"
        )
        upload_params.append(tn)
        pack_extra_wheres.append(
            "EXISTS (SELECT 1 FROM json_each(COALESCE(pa.tags_json, '[]')) WHERE LOWER(value) = ?)"
        )
        pack_extra_params.append(tn)

    if type_filter:
        upload_wheres.append(f"{_asset_type_sql('a')} = ?")
        upload_params.append(type_filter)
        pack_extra_wheres.append(f"{_asset_type_sql('pa')} = ?")
        pack_extra_params.append(type_filter)

    if alpha_filter:
        wants_alpha = alpha_filter == "yes"
        upload_wheres.append(_asset_has_alpha_sql("a") if wants_alpha else f"NOT {_asset_has_alpha_sql('a')}")
        pack_extra_wheres.append(_asset_has_alpha_sql("pa") if wants_alpha else f"NOT {_asset_has_alpha_sql('pa')}")

    if kind_filter:
        upload_wheres.append(f"{_asset_kind_sql('a')} = ?")
        upload_params.append(kind_filter)
        pack_extra_wheres.append(f"{_asset_kind_sql('pa')} = ?")
        pack_extra_params.append(kind_filter)

    upload_where_sql = " AND ".join(upload_wheres)

    with _raw_conn_ctx() as conn:
        # Load pack metadata for display fields (fast — very few rows)
        slug_by_pack_id: Dict[int, str] = {}
        name_by_pack_id: Dict[int, str] = {}
        pack_id_by_slug: Dict[str, int] = {}
        owner_id_by_pack_id: Dict[int, int] = {}
        owner_username_by_pack_id: Dict[int, str] = {}
        content_type_by_pack_id: Dict[int, str] = {}
        pack_scope_by_pack_id: Dict[int, str] = {}
        globally_visible_by_pack_id: Dict[int, bool] = {}
        if pack_ids:
            ph = ",".join("?" * len(pack_ids))
            for row in conn.execute(
                f"""
                SELECT p.pack_id, p.slug, p.name, p.owner_user_id, p.content_type, p.pack_scope, p.globally_visible, COALESCE(u.username, '') AS owner_username
                FROM privatepackrow p
                LEFT JOIN userrow u ON u.user_id = p.owner_user_id
                WHERE p.pack_id IN ({ph}) AND COALESCE(p.archived, 0) = 0
                """,
                list(pack_ids),
            ).fetchall():
                pid = int(row["pack_id"])
                slug_by_pack_id[pid] = row["slug"]
                name_by_pack_id[pid] = row["name"]
                pack_id_by_slug[str(row["slug"])] = pid
                content_type_by_pack_id[pid] = str(row["content_type"] or "asset_pack")
                pack_scope_by_pack_id[pid] = str(row["pack_scope"] or "personal")
                globally_visible_by_pack_id[pid] = bool(row["globally_visible"])
                if row["owner_user_id"] is not None:
                    owner_id_by_pack_id[pid] = int(row["owner_user_id"])
                owner_username_by_pack_id[pid] = str(row["owner_username"] or "")

        include_uploads = pack_filter in {"", "all", "upload"}
        selected_pack_ids = [] if pack_filter == "upload" else [
            pid for pid in pack_ids if content_type_by_pack_id.get(pid) == "asset_pack"
        ]
        if pack_filter and pack_filter not in {"all", "upload"}:
            target_pack_id = pack_id_by_slug.get(pack_filter)
            selected_pack_ids = [target_pack_id] if target_pack_id and content_type_by_pack_id.get(target_pack_id) == "asset_pack" else []
            include_uploads = False

        if selected_pack_ids:
            pack_id_list = selected_pack_ids
            pack_ph = ",".join("?" * len(pack_id_list))
            # Combine pack_id constraint with any extra filters
            pack_wheres = [f"pa.pack_id IN ({pack_ph})"] + pack_extra_wheres
            pack_where_sql = " AND ".join(pack_wheres)
            all_pack_params = pack_id_list + pack_extra_params

            # Lightweight combined count (no row materialization)
            t_count = time.perf_counter()
            if include_uploads:
                count_sql = f"""
                    SELECT COUNT(*) FROM (
                        SELECT a.asset_id FROM assetrow a WHERE {upload_where_sql}
                        UNION ALL
                        SELECT pa.asset_id FROM privatepackassetrow pa WHERE {pack_where_sql}
                    )
                """
                total_count = conn.execute(count_sql, upload_params + all_pack_params).fetchone()[0]
            else:
                total_count = conn.execute(
                    f"SELECT COUNT(*) FROM privatepackassetrow pa WHERE {pack_where_sql}",
                    all_pack_params,
                ).fetchone()[0]
            count_ms = (time.perf_counter() - t_count) * 1000.0

            # Single UNION page query — ordering and pagination done in SQL
            t_page = time.perf_counter()
            if include_uploads:
                page_sql = f"""
                    SELECT * FROM (
                        SELECT
                            a.asset_id, a.name, a.folder_path, a.tags_json, a.mime,
                            a.width, a.height, a.url_original, a.url_thumb, a.created_at,
                            NULL AS pack_id, 0 AS is_pack
                        FROM assetrow a
                        WHERE {upload_where_sql}

                        UNION ALL

                        SELECT
                            pa.asset_id, pa.name, pa.folder_path, pa.tags_json, pa.mime,
                            pa.width, pa.height, pa.url_original, pa.url_thumb, pa.created_at,
                            pa.pack_id, 1 AS is_pack
                        FROM privatepackassetrow pa
                        WHERE {pack_where_sql}
                    )
                    ORDER BY {order_sql}
                    LIMIT ? OFFSET ?
                """
                rows = conn.execute(page_sql, upload_params + all_pack_params + [safe_limit, safe_offset]).fetchall()
            else:
                rows = conn.execute(
                    f"""
                    SELECT
                        pa.asset_id, pa.name, pa.folder_path, pa.tags_json, pa.mime,
                        pa.width, pa.height, pa.url_original, pa.url_thumb, pa.created_at,
                        pa.pack_id, 1 AS is_pack
                    FROM privatepackassetrow pa
                    WHERE {pack_where_sql}
                    ORDER BY {order_sql}
                    LIMIT ? OFFSET ?
                    """,
                    all_pack_params + [safe_limit, safe_offset],
                ).fetchall()
            page_ms = (time.perf_counter() - t_page) * 1000.0

        else:
            # No packs accessible — uploads only
            t_count = time.perf_counter()
            total_count = conn.execute(
                f"SELECT COUNT(*) FROM assetrow a WHERE {'0=1' if not include_uploads else upload_where_sql}",
                [] if not include_uploads else upload_params,
            ).fetchone()[0]
            count_ms = (time.perf_counter() - t_count) * 1000.0

            t_page = time.perf_counter()
            if include_uploads:
                rows = conn.execute(
                    f"""
                    SELECT
                        a.asset_id, a.name, a.folder_path, a.tags_json, a.mime,
                        a.width, a.height, a.url_original, a.url_thumb, a.created_at,
                        NULL AS pack_id, 0 AS is_pack
                    FROM assetrow a
                    WHERE {upload_where_sql}
                    ORDER BY {order_sql}
                    LIMIT ? OFFSET ?
                    """,
                    upload_params + [safe_limit, safe_offset],
                ).fetchall()
            else:
                rows = []
            page_ms = (time.perf_counter() - t_page) * 1000.0

    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    logger.debug(
        "list_assets_for_user_page user=%s packs=%s limit=%s offset=%s total=%s "
        "count_ms=%.1f page_ms=%.1f total_ms=%.1f",
        user_id, len(pack_ids), safe_limit, safe_offset, total_count,
        count_ms, page_ms, elapsed_ms,
    )

    out: List[Dict[str, object]] = []
    for row in rows:
        try:
            tags = [str(t).strip() for t in (json.loads(row["tags_json"] or "[]") or []) if str(t).strip()]
        except Exception:
            tags = []
        is_pack = bool(row["is_pack"])
        if is_pack:
            pack_id = int(row["pack_id"])
            pack_slug = slug_by_pack_id.get(pack_id, "")
            # Pre-resolve the thumb filename from the stored DB path so the lite
            # response can return a fast /api/pack-thumbs/ URL that skips the full
            # dynamic file endpoint (no per-asset DB lookup, login check only).
            raw_db_thumb = str(row["url_thumb"] or "")
            thumb_filename = raw_db_thumb.rsplit("/", 1)[-1] if raw_db_thumb else ""
            pack_thumb_url = (
                f"/api/pack-thumbs/{pack_slug}/{thumb_filename}"
                if thumb_filename and pack_slug
                else ""
            )
            out.append({
                "asset_id": row["asset_id"],
                "name": row["name"],
                "folder_path": row["folder_path"] or "",
                "tags": tags,
                "mime": row["mime"],
                "width": row["width"],
                "height": row["height"],
                "url_original": f"/api/assets/file/{row['asset_id']}",
                "url_thumb": f"/api/assets/file/{row['asset_id']}",
                "thumb_url": pack_thumb_url,
                "created_at": row["created_at"],
                "readonly": True,
                "source": "pack",
                "pack_id": pack_id,
                "pack_slug": pack_slug,
                "pack_name": name_by_pack_id.get(pack_id, ""),
                "content_type": content_type_by_pack_id.get(pack_id, "asset_pack"),
                "pack_scope": pack_scope_by_pack_id.get(pack_id, "personal"),
                "globally_visible": globally_visible_by_pack_id.get(pack_id, False),
                "owner_user_id": owner_id_by_pack_id.get(pack_id),
                "owner_username": owner_username_by_pack_id.get(pack_id, ""),
                **_pack_access_metadata(pack_id, access_sources_by_pack_id, session_id=session_id),
            })
        else:
            out.append({
                "asset_id": row["asset_id"],
                "name": row["name"],
                "folder_path": row["folder_path"] or "",
                "tags": tags,
                "mime": row["mime"],
                "width": row["width"],
                "height": row["height"],
                "url_original": row["url_original"],
                "url_thumb": row["url_thumb"],  # direct /uploads/ path
                "created_at": row["created_at"],
                "readonly": False,
                "source": "upload",
                "shared_in_session": False,
            })

    has_more = (safe_offset + safe_limit) < total_count
    return out, total_count, has_more
