from __future__ import annotations

import json
from typing import Callable, Dict, List, Optional

from sqlmodel import Session, select

from . import storage_db
from .storage_models import AssetRow, PrivatePackAssetRow, PrivatePackEntitlementRow, PrivatePackRow

engine = storage_db.engine


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
