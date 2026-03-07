"""
Shared fixtures for all WarHamster tests.
"""
from __future__ import annotations

import io
import uuid
from typing import AsyncGenerator

import pytest
import httpx
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, create_engine

from server import storage
from server.storage import (
    add_membership,
    create_room_record,
    create_session,
    create_user,
)
from server.models import RoomState
from server.rooms import Room, RoomManager


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def fresh_db(monkeypatch):
    """
    Replace the module-level SQLite engine with a fresh in-memory DB for every
    test.  Tables are created via SQLModel metadata; init_db()'s migration path
    is intentionally skipped (not needed for a brand-new schema).
    """
    mem_engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    monkeypatch.setattr(storage, "engine", mem_engine)
    SQLModel.metadata.create_all(mem_engine)
    yield mem_engine


# ---------------------------------------------------------------------------
# FastAPI app + HTTP client helpers
# ---------------------------------------------------------------------------

@pytest.fixture
def app():
    from server.app import app as _app
    return _app


@pytest.fixture
async def http_client(app) -> AsyncGenerator[httpx.AsyncClient, None]:
    """Unauthenticated async HTTP client."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        yield client


@pytest.fixture
async def auth_client(app) -> AsyncGenerator[httpx.AsyncClient, None]:
    """Authenticated client for user 'gm_user'."""
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    )
    r = await client.post("/api/auth/register", json={"username": "gm_user", "password": "password123"})
    assert r.status_code == 200, f"register failed: {r.text}"
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
async def second_auth_client(app) -> AsyncGenerator[httpx.AsyncClient, None]:
    """Authenticated client for a second user 'player_user'."""
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    )
    r = await client.post("/api/auth/register", json={"username": "player_user", "password": "password123"})
    assert r.status_code == 200, f"register failed: {r.text}"
    try:
        yield client
    finally:
        await client.aclose()


# ---------------------------------------------------------------------------
# Minimal test image
# ---------------------------------------------------------------------------

@pytest.fixture
def minimal_png_bytes() -> bytes:
    """A valid 1×1 white PNG — the smallest possible upload payload."""
    try:
        from PIL import Image
        img = Image.new("RGB", (1, 1), color=(255, 255, 255))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except ImportError:
        pytest.skip("Pillow not installed")


# ---------------------------------------------------------------------------
# RoomManager / Room fixtures for unit tests
# ---------------------------------------------------------------------------

@pytest.fixture
def rm() -> RoomManager:
    return RoomManager()


@pytest.fixture
async def gm_room(rm: RoomManager):
    """
    A RoomManager with a pre-seeded room where user_id=1 / client_id='gm' is GM.
    Returns (manager, room, room_id).
    """
    room_id = "test-room"
    room = await rm.get_or_create_room(room_id)
    room.state.gm_user_id = 1
    room.state.gm_id = "gm"
    return rm, room, room_id


# ---------------------------------------------------------------------------
# Storage-level seed helpers (bypass HTTP layer)
# ---------------------------------------------------------------------------

def make_user(username: str = "testuser", password_hash: str = "hash") :
    return create_user(username, password_hash)


def make_session(user_id: int) -> str:
    return create_session(user_id)


def make_room(room_id: str = "room1", owner_user_id: int = 1, name: str = "Test Room") -> str:
    state = RoomState(room_id=room_id, gm_user_id=owner_user_id)
    create_room_record(
        room_id=room_id,
        name=name,
        state_json=state.model_dump_json(),
        owner_user_id=owner_user_id,
        join_code=f"WHAM-TEST1",
    )
    add_membership(owner_user_id, room_id, role="owner")
    return room_id
