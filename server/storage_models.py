from __future__ import annotations

from typing import Optional

from sqlmodel import Field, SQLModel


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
    session_id: Optional[str] = Field(default=None, index=True)
    display_name: Optional[str] = None
    room_order: Optional[int] = None
    archived: bool = False
    parent_room_id: Optional[str] = Field(default=None, index=True)


class SnapshotRow(SQLModel, table=True):
    snapshot_id: str = Field(primary_key=True)
    room_id: str = Field(index=True)
    label: str
    state_json: str
    created_at: str


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


class GameSessionRow(SQLModel, table=True):
    session_id: str = Field(primary_key=True)
    name: str
    created_by_user_id: Optional[int] = Field(default=None, index=True)
    created_at: str
    updated_at: str
    archived: bool = False
    root_room_id: Optional[str] = Field(default=None, index=True)


class GameSessionMemberRow(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: str = Field(index=True)
    user_id: int = Field(index=True)
    role: str = "player"  # "gm" | "co_gm" | "player"
    joined_at: str


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


class GameSessionSharedPackRow(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: str = Field(index=True)
    pack_id: int = Field(index=True)
    shared_by_user_id: Optional[int] = Field(default=None, index=True)
    shared_at: str
