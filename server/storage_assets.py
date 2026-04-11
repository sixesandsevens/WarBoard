from __future__ import annotations

import json
import logging
import sqlite3
import time
from contextlib import contextmanager
from typing import Callable, Dict, List, Optional, Tuple

from sqlmodel import Session, select

from . import storage_db
from .storage_models import AssetRow, PrivatePackAssetRow, PrivatePackEntitlementRow, PrivatePackRow

engine = storage_db.engine
logger = logging.getLogger("warhamster.assets")


@contextmanager
def _raw_conn_ctx():
    """Raw SQLite connection with row_factory, derived from the SQLModel engine URL."""
    url = str(engine.url)
    if url.startswith("sqlite:///"):
        path = url[len("sqlite:///"):]
    else:
        raise RuntimeError(f"Unexpected DB URL: {url}")
    conn = sqlite3.connect(path, timeout=3.0)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


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
        owned = s.exec(select(PrivatePackRow.pack_id).where(PrivatePackRow.owner_user_id == user_id)).all()
        entitled = s.exec(
            select(PrivatePackEntitlementRow.pack_id).where(PrivatePackEntitlementRow.user_id == user_id)
        ).all()
    return {int(pack_id) for pack_id in [*owned, *entitled] if pack_id is not None}


def list_private_packs_for_user(
    user_id: int,
    session_id: Optional[str] = None,
    *,
    is_game_session_member: Callable[[str, int], bool],
    shared_pack_ids_for_game_session: Callable[[str], set[int]],
) -> List[Dict[str, object]]:
    pack_ids = _pack_ids_for_user(user_id)
    if not pack_ids:
        return []
    shared_ids = (
        shared_pack_ids_for_game_session(session_id)
        if session_id and is_game_session_member(session_id, user_id)
        else set()
    )
    with Session(engine) as s:
        packs = s.exec(select(PrivatePackRow).where(PrivatePackRow.pack_id.in_(pack_ids))).all()
    out: List[Dict[str, object]] = []
    for pack in packs:
        pack_id = int(pack.pack_id) if pack.pack_id is not None else 0
        out.append(
            {
                "pack_id": pack.pack_id,
                "slug": pack.slug,
                "name": pack.name,
                "owner_user_id": pack.owner_user_id,
                "created_at": pack.created_at,
                "root_rel": pack.root_rel,
                "thumb_rel": pack.thumb_rel,
                "shared_in_session": pack_id in shared_ids,
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
    *,
    is_game_session_member: Callable[[str, int], bool],
    shared_pack_ids_for_game_session: Callable[[str], set[int]],
) -> List[Dict[str, object]]:
    qn = (q or "").strip().lower()
    tn = (tag or "").strip().lower()
    fn = (folder or "").strip().strip("/").lower()
    pack_ids = _pack_ids_for_user(user_id)
    if session_id and is_game_session_member(session_id, user_id):
        pack_ids.update(shared_pack_ids_for_game_session(session_id))
    if not pack_ids:
        return []
    shared_ids = (
        shared_pack_ids_for_game_session(session_id)
        if session_id and is_game_session_member(session_id, user_id)
        else set()
    )
    with Session(engine) as s:
        packs = s.exec(select(PrivatePackRow).where(PrivatePackRow.pack_id.in_(pack_ids))).all()
        slug_by_pack_id = {int(pack.pack_id): pack.slug for pack in packs if pack.pack_id is not None}
        name_by_pack_id = {int(pack.pack_id): pack.name for pack in packs if pack.pack_id is not None}
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
                "shared_in_session": int(row.pack_id) in shared_ids,
            }
        )
    out.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
    return out


def list_all_assets_for_user(
    user_id: int,
    q: str = "",
    tag: str = "",
    folder: str = "",
    session_id: Optional[str] = None,
    *,
    is_game_session_member: Callable[[str, int], bool],
    shared_pack_ids_for_game_session: Callable[[str], set[int]],
) -> List[Dict[str, object]]:
    uploads = []
    for asset in list_assets_for_user(user_id, q=q, tag=tag, folder=folder):
        item = dict(asset)
        item["readonly"] = False
        item["source"] = "upload"
        item["shared_in_session"] = False
        uploads.append(item)
    packs = list_pack_assets_for_user(
        user_id,
        q=q,
        tag=tag,
        folder=folder,
        session_id=session_id,
        is_game_session_member=is_game_session_member,
        shared_pack_ids_for_game_session=shared_pack_ids_for_game_session,
    )
    merged = [*uploads, *packs]
    merged.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
    return merged


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
    safe_limit = min(max(1, int(limit or 1)), 500)
    safe_offset = max(0, int(offset or 0))

    # Resolve which pack IDs this user may see (owned + entitled + session-shared)
    pack_ids = _pack_ids_for_user(user_id)
    shared_ids: set[int] = set()
    if session_id and is_game_session_member(session_id, user_id):
        sess_pack_ids = shared_pack_ids_for_game_session(session_id)
        pack_ids.update(sess_pack_ids)
        shared_ids = sess_pack_ids

    # Build SQL WHERE fragments — name, folder, and tag all pushed into SQL
    upload_wheres: List[str] = ["a.uploader_user_id = ?"]
    upload_params: List[object] = [user_id]
    pack_extra_wheres: List[str] = []
    pack_extra_params: List[object] = []

    if qn:
        upload_wheres.append("LOWER(a.name) LIKE ?")
        upload_params.append(f"%{qn}%")
        pack_extra_wheres.append("LOWER(pa.name) LIKE ?")
        pack_extra_params.append(f"%{qn}%")

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

    upload_where_sql = " AND ".join(upload_wheres)

    with _raw_conn_ctx() as conn:
        # Load pack metadata for display fields (fast — very few rows)
        slug_by_pack_id: Dict[int, str] = {}
        name_by_pack_id: Dict[int, str] = {}
        if pack_ids:
            ph = ",".join("?" * len(pack_ids))
            for row in conn.execute(
                f"SELECT pack_id, slug, name FROM privatepackrow WHERE pack_id IN ({ph})",
                list(pack_ids),
            ).fetchall():
                pid = int(row["pack_id"])
                slug_by_pack_id[pid] = row["slug"]
                name_by_pack_id[pid] = row["name"]

        if pack_ids:
            pack_id_list = list(pack_ids)
            pack_ph = ",".join("?" * len(pack_id_list))
            # Combine pack_id constraint with any extra filters
            pack_wheres = [f"pa.pack_id IN ({pack_ph})"] + pack_extra_wheres
            pack_where_sql = " AND ".join(pack_wheres)
            all_pack_params = pack_id_list + pack_extra_params

            # Lightweight combined count (no row materialization)
            t_count = time.perf_counter()
            count_sql = f"""
                SELECT COUNT(*) FROM (
                    SELECT a.asset_id FROM assetrow a WHERE {upload_where_sql}
                    UNION ALL
                    SELECT pa.asset_id FROM privatepackassetrow pa WHERE {pack_where_sql}
                )
            """
            total_count: int = conn.execute(
                count_sql, upload_params + all_pack_params
            ).fetchone()[0]
            count_ms = (time.perf_counter() - t_count) * 1000.0

            # Single UNION page query — ordering and pagination done in SQL
            t_page = time.perf_counter()
            page_sql = f"""
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

                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
            """
            rows = conn.execute(
                page_sql, upload_params + all_pack_params + [safe_limit, safe_offset]
            ).fetchall()
            page_ms = (time.perf_counter() - t_page) * 1000.0

        else:
            # No packs accessible — uploads only
            t_count = time.perf_counter()
            total_count = conn.execute(
                f"SELECT COUNT(*) FROM assetrow a WHERE {upload_where_sql}", upload_params
            ).fetchone()[0]
            count_ms = (time.perf_counter() - t_count) * 1000.0

            t_page = time.perf_counter()
            rows = conn.execute(
                f"""
                SELECT
                    a.asset_id, a.name, a.folder_path, a.tags_json, a.mime,
                    a.width, a.height, a.url_original, a.url_thumb, a.created_at,
                    NULL AS pack_id, 0 AS is_pack
                FROM assetrow a
                WHERE {upload_where_sql}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
                """,
                upload_params + [safe_limit, safe_offset],
            ).fetchall()
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
                "shared_in_session": pack_id in shared_ids,
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
