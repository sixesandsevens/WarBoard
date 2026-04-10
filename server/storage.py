from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional

from . import storage_assets, storage_auth, storage_db, storage_rooms, storage_sessions
from .storage_models import (
    AssetRow,
    GameSessionRow,
    PrivatePackAssetRow,
    PrivatePackRow,
    RoomMetaRow,
    SessionRow,
    UserRow,
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


db_url = storage_db.db_url


engine = storage_db.engine


def init_db() -> None:
    storage_db.engine = engine
    storage_db.init_db()


def _sync_rooms_engine() -> None:
    storage_rooms.set_engine(engine)


def _sync_sessions_engine() -> None:
    storage_sessions.set_engine(engine)


def _sync_auth_engine() -> None:
    storage_auth.set_engine(engine)


def _sync_assets_engine() -> None:
    storage_assets.set_engine(engine)


def load_room_state_json(room_id: str) -> Optional[str]:
    _sync_rooms_engine()
    return storage_rooms.load_room_state_json(room_id)


def save_room_state_json(room_id: str, state_json: str) -> None:
    _sync_rooms_engine()
    storage_rooms.save_room_state_json(room_id, state_json, utc_now_iso())


def create_room_record(
    room_id: str,
    name: str,
    state_json: str,
    owner_user_id: Optional[int] = None,
    join_code: Optional[str] = None,
    session_id: Optional[str] = None,
    display_name: Optional[str] = None,
    room_order: Optional[int] = None,
    archived: bool = False,
) -> None:
    _sync_rooms_engine()
    storage_rooms.create_room_record(
        room_id=room_id,
        name=name,
        state_json=state_json,
        now_iso=utc_now_iso(),
        owner_user_id=owner_user_id,
        join_code=join_code,
        session_id=session_id,
        display_name=display_name,
        room_order=room_order,
        archived=archived,
    )


def get_room_meta(room_id: str) -> Optional[RoomMetaRow]:
    _sync_rooms_engine()
    return storage_rooms.get_room_meta(room_id)


def get_room_session_id(room_id: str) -> Optional[str]:
    _sync_rooms_engine()
    return storage_rooms.get_room_session_id(room_id)


def update_room_name(room_id: str, name: str) -> bool:
    _sync_rooms_engine()
    return storage_rooms.update_room_name(room_id, name)


def delete_room_record(room_id: str) -> bool:
    _sync_rooms_engine()
    return storage_rooms.delete_room_record(room_id)


# --- Gameplay sessions -------------------------------------------------------

def create_game_session(name: str, created_by_user_id: Optional[int]) -> GameSessionRow:
    _sync_sessions_engine()
    return storage_sessions.create_game_session(name, created_by_user_id, utc_now_iso(), add_game_session_member)


def get_game_session(session_id: str) -> Optional[GameSessionRow]:
    _sync_sessions_engine()
    return storage_sessions.get_game_session(session_id)


def touch_game_session(session_id: str) -> None:
    _sync_sessions_engine()
    storage_sessions.touch_game_session(session_id, utc_now_iso())


def add_game_session_member(session_id: str, user_id: int, role: str = "player") -> None:
    _sync_sessions_engine()
    storage_sessions.add_game_session_member(session_id, user_id, role, utc_now_iso(), touch_game_session)


def get_game_session_role(session_id: str, user_id: int) -> Optional[str]:
    _sync_sessions_engine()
    return storage_sessions.get_game_session_role(session_id, user_id)


def is_game_session_member(session_id: str, user_id: int) -> bool:
    _sync_sessions_engine()
    return storage_sessions.is_game_session_member(session_id, user_id)


def can_manage_game_session(session_id: str, user_id: int) -> bool:
    _sync_sessions_engine()
    return storage_sessions.can_manage_game_session(session_id, user_id)


def list_game_sessions_for_user(user_id: int) -> List[Dict[str, object]]:
    _sync_sessions_engine()
    return storage_sessions.list_game_sessions_for_user(user_id)


def list_game_session_members(session_id: str) -> List[Dict[str, object]]:
    _sync_sessions_engine()
    return storage_sessions.list_game_session_members(session_id)


def list_game_session_rooms(session_id: str) -> List[Dict[str, object]]:
    _sync_sessions_engine()
    return storage_sessions.list_game_session_rooms(session_id)


def next_room_order_for_session(session_id: str) -> int:
    _sync_sessions_engine()
    return storage_sessions.next_room_order_for_session(session_id)


def assign_room_to_game_session(room_id: str, session_id: str, display_name: Optional[str] = None, order: Optional[int] = None) -> bool:
    _sync_sessions_engine()
    return storage_sessions.assign_room_to_game_session(room_id, session_id, display_name, order, utc_now_iso())


def create_room_in_game_session(*, session_id: str, created_by_user_id: int, room_id: str, name: str, state_json: str, join_code: Optional[str] = None) -> None:
    _sync_sessions_engine()
    storage_sessions.create_room_in_game_session(
        session_id=session_id,
        created_by_user_id=created_by_user_id,
        room_id=room_id,
        name=name,
        state_json=state_json,
        join_code=join_code,
        create_room_record=create_room_record,
        add_membership=add_membership,
        touch_game_session=touch_game_session,
    )


# --- Snapshots ---------------------------------------------------------------

def create_snapshot(room_id: str, label: str, state_json: str) -> str:
    _sync_sessions_engine()
    return storage_sessions.create_snapshot(room_id, label, state_json, utc_now_iso())


def list_snapshots(room_id: str) -> List[Dict[str, str]]:
    _sync_sessions_engine()
    return storage_sessions.list_snapshots(room_id)


def load_snapshot_state_json(snapshot_id: str) -> Optional[str]:
    _sync_sessions_engine()
    return storage_sessions.load_snapshot_state_json(snapshot_id)


# --- Auth helpers ------------------------------------------------------------

def create_user(username: str, password_hash: str) -> UserRow:
    _sync_auth_engine()
    return storage_auth.create_user(username, password_hash, utc_now_iso())


def get_user_by_username(username: str) -> Optional[UserRow]:
    _sync_auth_engine()
    return storage_auth.get_user_by_username(username)


def get_user_by_id(user_id: int) -> Optional[UserRow]:
    _sync_auth_engine()
    return storage_auth.get_user_by_id(user_id)


def update_user_password_hash(user_id: int, password_hash: str) -> bool:
    _sync_auth_engine()
    return storage_auth.update_user_password_hash(user_id, password_hash)


def update_user_last_room(user_id: int, room_id: Optional[str]) -> bool:
    _sync_auth_engine()
    return storage_auth.update_user_last_room(user_id, room_id)


def create_session(user_id: int, ttl_days: int = 30) -> str:
    _sync_auth_engine()
    return storage_auth.create_session(user_id, ttl_days)


def delete_session(sid: str) -> None:
    _sync_auth_engine()
    storage_auth.delete_session(sid)


def get_user_by_sid(sid: str) -> Optional[UserRow]:
    _sync_auth_engine()
    return storage_auth.get_user_by_sid(sid)


# --- Membership + join codes -------------------------------------------------

_JOIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_join_code(prefix: str = "WHAM", length: int = 6) -> str:
    return storage_rooms.generate_join_code(prefix, length)


def ensure_room_join_code(room_id: str) -> str:
    _sync_rooms_engine()
    return storage_rooms.ensure_room_join_code(room_id)


def room_id_from_join_code(code: str) -> Optional[str]:
    _sync_rooms_engine()
    return storage_rooms.room_id_from_join_code(code)


def add_membership(user_id: int, room_id: str, role: str = "player") -> None:
    _sync_rooms_engine()
    storage_rooms.add_membership(user_id, room_id, utc_now_iso(), role)


def touch_membership(user_id: int, room_id: str) -> None:
    _sync_rooms_engine()
    storage_rooms.touch_membership(user_id, room_id, utc_now_iso())


def list_room_member_user_ids(room_id: str) -> List[int]:
    _sync_rooms_engine()
    return storage_rooms.list_room_member_user_ids(room_id)


def is_member(user_id: int, room_id: str) -> bool:
    _sync_rooms_engine()
    return storage_rooms.is_member(user_id, room_id)


def ensure_room_membership_for_user(user_id: int, room_id: str) -> bool:
    _sync_rooms_engine()
    return storage_rooms.ensure_room_membership_for_user(user_id, room_id, get_game_session_role)


def list_rooms_for_user(user_id: int) -> List[Dict[str, object]]:
    _sync_rooms_engine()
    return storage_rooms.list_rooms_for_user(user_id)


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
    _sync_assets_engine()
    storage_assets.create_asset_record(
        asset_id=asset_id,
        uploader_user_id=uploader_user_id,
        name=name,
        folder_path=folder_path,
        tags=tags,
        mime=mime,
        width=width,
        height=height,
        url_original=url_original,
        url_thumb=url_thumb,
        now_iso=utc_now_iso(),
    )


def list_assets_for_user(user_id: int, q: str = "", tag: str = "", folder: str = "") -> List[Dict[str, object]]:
    _sync_assets_engine()
    return storage_assets.list_assets_for_user(user_id, q=q, tag=tag, folder=folder)


def create_private_pack(
    owner_user_id: int,
    slug: str,
    name: str,
    root_rel: str,
    thumb_rel: str,
) -> PrivatePackRow:
    _sync_assets_engine()
    return storage_assets.create_private_pack(
        owner_user_id=owner_user_id,
        slug=slug,
        name=name,
        root_rel=root_rel,
        thumb_rel=thumb_rel,
        now_iso=utc_now_iso(),
    )


def get_private_pack_by_slug(slug: str) -> Optional[PrivatePackRow]:
    _sync_assets_engine()
    return storage_assets.get_private_pack_by_slug(slug)


def get_private_pack_by_id(pack_id: int) -> Optional[PrivatePackRow]:
    _sync_assets_engine()
    return storage_assets.get_private_pack_by_id(pack_id)


def get_pack_asset_by_asset_id(asset_id: str) -> Optional[PrivatePackAssetRow]:
    _sync_assets_engine()
    return storage_assets.get_pack_asset_by_asset_id(asset_id)


def user_has_pack_access(user_id: int, pack_id: int) -> bool:
    _sync_assets_engine()
    return storage_assets.user_has_pack_access(user_id, pack_id)


def grant_private_pack_access(pack_id: int, user_id: int) -> None:
    _sync_assets_engine()
    storage_assets.grant_private_pack_access(pack_id, user_id, utc_now_iso())


def revoke_private_pack_access(pack_id: int, user_id: int) -> None:
    _sync_assets_engine()
    storage_assets.revoke_private_pack_access(pack_id, user_id)


def list_game_session_shared_packs(session_id: str) -> List[Dict[str, object]]:
    _sync_sessions_engine()
    return storage_sessions.list_game_session_shared_packs(session_id)


def _shared_pack_ids_for_game_session(session_id: str) -> set[int]:
    _sync_sessions_engine()
    return storage_sessions.shared_pack_ids_for_game_session(session_id)


def is_pack_shared_in_game_session(session_id: str, pack_id: int) -> bool:
    _sync_sessions_engine()
    return storage_sessions.is_pack_shared_in_game_session(session_id, pack_id)


def set_game_session_shared_pack(
    session_id: str,
    pack_id: int,
    enabled: bool,
    shared_by_user_id: Optional[int] = None,
) -> bool:
    _sync_sessions_engine()
    return storage_sessions.set_game_session_shared_pack(session_id, pack_id, enabled, shared_by_user_id, utc_now_iso())


def list_private_packs_for_user(user_id: int, session_id: Optional[str] = None) -> List[Dict[str, object]]:
    _sync_assets_engine()
    return storage_assets.list_private_packs_for_user(
        user_id,
        session_id=session_id,
        is_game_session_member=is_game_session_member,
        shared_pack_ids_for_game_session=_shared_pack_ids_for_game_session,
    )


def list_pack_assets_for_user(
    user_id: int,
    q: str = "",
    tag: str = "",
    folder: str = "",
    session_id: Optional[str] = None,
) -> List[Dict[str, object]]:
    _sync_assets_engine()
    return storage_assets.list_pack_assets_for_user(
        user_id,
        q=q,
        tag=tag,
        folder=folder,
        session_id=session_id,
        is_game_session_member=is_game_session_member,
        shared_pack_ids_for_game_session=_shared_pack_ids_for_game_session,
    )


def list_all_assets_for_user(
    user_id: int,
    q: str = "",
    tag: str = "",
    folder: str = "",
    session_id: Optional[str] = None,
) -> List[Dict[str, object]]:
    _sync_assets_engine()
    return storage_assets.list_all_assets_for_user(
        user_id,
        q=q,
        tag=tag,
        folder=folder,
        session_id=session_id,
        is_game_session_member=is_game_session_member,
        shared_pack_ids_for_game_session=_shared_pack_ids_for_game_session,
    )


def get_asset_by_id(asset_id: str) -> Optional[AssetRow]:
    _sync_assets_engine()
    return storage_assets.get_asset_by_id(asset_id)


def get_asset_for_user(asset_id: str, user_id: int) -> Optional[AssetRow]:
    _sync_assets_engine()
    return storage_assets.get_asset_for_user(asset_id, user_id)


def delete_asset_record(asset_id: str, user_id: int) -> bool:
    _sync_assets_engine()
    return storage_assets.delete_asset_record(asset_id, user_id)
