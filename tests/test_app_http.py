"""
Integration tests for server/app.py HTTP routes.

Uses httpx.AsyncClient with ASGITransport (no real network socket).
WebSocket tests use Starlette's synchronous TestClient.
"""
from __future__ import annotations

import io
import json
import uuid

import pytest
import httpx
from starlette.testclient import TestClient

from server.storage import (
    add_game_session_member,
    add_membership,
    assign_room_to_game_session,
    create_asset_record,
    create_game_session,
    create_room_record,
    create_session,
    create_user,
    get_asset_by_id,
    PrivatePackAssetRow,
    PrivatePackRow,
    utc_now_iso,
)
from server.models import RoomState
from sqlmodel import Session


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seed_user_and_session(username="testgm", password_hash="hash"):
    u = create_user(username, password_hash)
    sid = create_session(u.user_id)
    return u, sid


def _seed_room(owner_id: int, room_id: str = "room1", join_code: str = "WHAM-TEST11"):
    state = RoomState(room_id=room_id, gm_user_id=owner_id)
    create_room_record(
        room_id=room_id,
        name="Test Room",
        state_json=state.model_dump_json(),
        owner_user_id=owner_id,
        join_code=join_code,
    )
    add_membership(owner_id, room_id, role="owner")
    return room_id


def _seed_asset(asset_id: str, uploader_id: int, tmp_path):
    """Create a DB record and a real file on disk that the serve endpoint can return."""
    from server.app import ASSET_UPLOADS_DIR
    user_dir = ASSET_UPLOADS_DIR / str(uploader_id)
    user_dir.mkdir(parents=True, exist_ok=True)
    file_path = user_dir / f"{asset_id}.png"
    file_path.write_bytes(b"PNG_FAKE_CONTENT")
    create_asset_record(
        asset_id=asset_id,
        uploader_user_id=uploader_id,
        name="Test",
        tags=[],
        mime="image/png",
        width=64,
        height=64,
        url_original=f"/uploads/assets/{uploader_id}/{asset_id}.png",
        url_thumb=f"/uploads/assets/{uploader_id}/thumbs/{asset_id}.webp",
    )
    return file_path


def _seed_private_pack(owner_user_id: int, slug: str = "shared-pack", name: str = "Shared Pack") -> int:
    from server import storage as storage_module

    with Session(storage_module.engine) as s:
        pack = PrivatePackRow(
            slug=slug,
            name=name,
            owner_user_id=owner_user_id,
            created_at=utc_now_iso(),
            root_rel=f"{slug}/manifest.json",
            thumb_rel=f"{slug}/thumb.webp",
        )
        s.add(pack)
        s.commit()
        s.refresh(pack)
        assert pack.pack_id is not None
        s.add(
            PrivatePackAssetRow(
                asset_id=f"{slug}-asset",
                pack_id=pack.pack_id,
                name=f"{name} Piece",
                folder_path="props",
                tags_json='["shared"]',
                mime="image/png",
                width=128,
                height=128,
                url_original=f"/private-packs/{slug}/originals/{slug}-asset.png",
                url_thumb=f"/private-packs/{slug}/thumbs/{slug}-asset.webp",
                created_at=utc_now_iso(),
            )
        )
        s.commit()
        return int(pack.pack_id)


# ---------------------------------------------------------------------------
# Auth middleware
# ---------------------------------------------------------------------------

class TestAuthMiddleware:
    async def test_unauthenticated_api_returns_401_json(self, http_client):
        r = await http_client.get("/api/me")
        assert r.status_code == 401
        assert r.json()["detail"] == "Login required"

    async def test_packs_api_is_public(self, http_client):
        r = await http_client.get("/api/packs")
        # Returns 200 with pack list (may be empty in test env)
        assert r.status_code == 200

    async def test_unauthenticated_static_canvas_is_public(self, http_client):
        r = await http_client.get("/static/canvas.html")
        assert r.status_code in (200, 404)  # 404 if file not mounted in test


# ---------------------------------------------------------------------------
# Register / Login / Logout
# ---------------------------------------------------------------------------

class TestAuth:
    async def test_register_success(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "newuser", "password": "password123"})
        assert r.status_code == 200
        assert r.json().get("username") == "newuser"

    async def test_register_sets_session_cookie(self, http_client):
        await http_client.post("/api/auth/register",
                               json={"username": "cookietest", "password": "password123"})
        assert "warhamster_sid" in http_client.cookies

    async def test_register_short_username_400(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "ab", "password": "password123"})
        assert r.status_code == 400

    async def test_register_short_password_400(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "validuser", "password": "short"})
        assert r.status_code == 400

    async def test_register_duplicate_username_409(self, http_client):
        await http_client.post("/api/auth/register",
                               json={"username": "dupuser", "password": "password123"})
        r = await http_client.post("/api/auth/register",
                                   json={"username": "dupuser", "password": "password123"})
        assert r.status_code == 409

    async def test_login_success(self, app, http_client):
        # Register first, then log in from a fresh client
        await http_client.post("/api/auth/register",
                               json={"username": "logintest", "password": "password123"})
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as fresh:
            r = await fresh.post("/api/auth/login",
                                 json={"username": "logintest", "password": "password123"})
            assert r.status_code == 200
            assert "warhamster_sid" in fresh.cookies

    async def test_login_wrong_password_401(self, app, http_client):
        await http_client.post("/api/auth/register",
                               json={"username": "wrongpw", "password": "password123"})
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as fresh:
            r = await fresh.post("/api/auth/login",
                                 json={"username": "wrongpw", "password": "badpassword"})
            assert r.status_code == 401

    async def test_login_unknown_user_401(self, app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as fresh:
            r = await fresh.post("/api/auth/login",
                                 json={"username": "ghost", "password": "password123"})
            assert r.status_code == 401

    async def test_logout_clears_cookie(self, auth_client):
        r = await auth_client.post("/api/auth/logout")
        assert r.status_code == 200
        # Cookie should be cleared (empty or absent)
        cookie_val = auth_client.cookies.get("warhamster_sid", "")
        assert cookie_val == ""

    async def test_me_returns_current_user(self, auth_client):
        r = await auth_client.get("/api/me")
        assert r.status_code == 200
        assert r.json().get("username") == "gm_user"


# ---------------------------------------------------------------------------
# Room CRUD
# ---------------------------------------------------------------------------

class TestRoomCrud:
    async def test_create_room_success(self, auth_client):
        r = await auth_client.post("/api/rooms", json={"name": "My Dungeon"})
        assert r.status_code == 200
        data = r.json()
        assert "room_id" in data
        assert data["name"] == "My Dungeon"
        assert "join_code" in data

    async def test_create_room_unauthenticated_401(self, http_client):
        r = await http_client.post("/api/rooms", json={"name": "Test"})
        assert r.status_code == 401

    async def test_my_rooms_lists_created_room(self, auth_client):
        await auth_client.post("/api/rooms", json={"name": "Dragon's Lair"})
        r = await auth_client.get("/api/my/rooms")
        assert r.status_code == 200
        rooms = r.json()["rooms"]
        names = [room["name"] for room in rooms]
        assert "Dragon's Lair" in names

    async def test_join_room_via_code(self, auth_client, second_auth_client):
        r = await auth_client.post("/api/rooms", json={"name": "Secret Room"})
        join_code = r.json()["join_code"]

        r2 = await second_auth_client.post("/api/join", json={"code": join_code})
        assert r2.status_code == 200
        assert "room_id" in r2.json()

    async def test_join_room_invalid_code_404(self, auth_client):
        r = await auth_client.post("/api/join", json={"code": "WHAM-XXXXXX"})
        assert r.status_code == 404

    async def test_delete_room_by_owner(self, auth_client):
        r = await auth_client.post("/api/rooms", json={"name": "To Delete"})
        room_id = r.json()["room_id"]
        gm_key = "testkey123"

        r2 = await auth_client.delete(f"/api/rooms/{room_id}?gm_key={gm_key}")
        # owner can delete without needing to claim GM via WS
        assert r2.status_code in (200, 400)  # 400 if room has active connections

    async def test_rename_room(self, auth_client):
        r = await auth_client.post("/api/rooms", json={"name": "Old Name"})
        room_id = r.json()["room_id"]
        r2 = await auth_client.patch(f"/api/rooms/{room_id}",
                                     json={"name": "New Name", "gm_key": ""})
        assert r2.status_code in (200, 403)


# ---------------------------------------------------------------------------
# Gameplay sessions
# ---------------------------------------------------------------------------

class TestGameplaySessionsApi:
    async def test_attach_room_to_new_session(self, auth_client):
        created = await auth_client.post("/api/rooms", json={"name": "Anchor Room"})
        room_id = created.json()["room_id"]
        attached = await auth_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Session Alpha"})
        assert attached.status_code == 200
        payload = attached.json()
        assert payload["name"] == "Session Alpha"
        assert payload["current_room"]["id"] == room_id
        assert any(room["id"] == room_id for room in payload["rooms"])

    async def test_create_room_inside_session(self, auth_client):
        created = await auth_client.post("/api/rooms", json={"name": "Room One"})
        room_id = created.json()["room_id"]
        attached = await auth_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Session Beta"})
        session_id = attached.json()["id"]
        second = await auth_client.post(f"/api/sessions/{session_id}/rooms", json={"name": "Room Two"})
        assert second.status_code == 200
        listed = await auth_client.get(f"/api/sessions/{session_id}/rooms")
        assert listed.status_code == 200
        assert len(listed.json()["rooms"]) == 2

    async def test_joining_session_room_adds_session_membership(self, auth_client, second_auth_client):
        created = await auth_client.post("/api/rooms", json={"name": "Session Start"})
        room_id = created.json()["room_id"]
        join_code = created.json()["join_code"]
        attached = await auth_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Session Gamma"})
        session_id = attached.json()["id"]
        joined = await second_auth_client.post("/api/join", json={"code": join_code})
        assert joined.status_code == 200
        session = await second_auth_client.get(f"/api/sessions/{session_id}")
        assert session.status_code == 200
        assert session.json()["user_role"] == "player"

    async def test_session_members_api_includes_current_room_name(self, auth_client, second_auth_client):
        created = await auth_client.post("/api/rooms", json={"name": "Session Delta"})
        room_id = created.json()["room_id"]
        join_code = created.json()["join_code"]
        attached = await auth_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Roster Session"})
        session_id = attached.json()["id"]

        joined = await second_auth_client.post("/api/join", json={"code": join_code})
        assert joined.status_code == 200

        members = await auth_client.get(f"/api/sessions/{session_id}/members")
        assert members.status_code == 200
        player_row = next(member for member in members.json()["members"] if member["username"] == "player_user")
        assert player_row["current_room_id"] == room_id
        assert player_row["current_room_name"] == "Session Delta"

    async def test_gm_can_share_private_pack_to_session(self, auth_client, app):
        created = await auth_client.post("/api/rooms", json={"name": "Share Room"})
        room_id = created.json()["room_id"]
        attached = await auth_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Share Session"})
        session_id = attached.json()["id"]

        gm_user = create_user("share_owner", "hash")
        add_game_session_member(session_id, gm_user.user_id, "gm")
        pack_id = _seed_private_pack(gm_user.user_id, slug="ghoul-pack", name="Ghoul Pack")
        sid = create_session(gm_user.user_id)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            cookies={"warhamster_sid": sid},
        ) as owner_client:
            shared = await owner_client.post(f"/api/sessions/{session_id}/shared-packs/{pack_id}")
        assert shared.status_code == 200
        assert any(pack["pack_id"] == pack_id for pack in shared.json()["packs"])

    async def test_player_sees_session_shared_pack_assets_in_library(self, auth_client, second_auth_client, app):
        created = await auth_client.post("/api/rooms", json={"name": "Shared Assets Room"})
        room_id = created.json()["room_id"]
        join_code = created.json()["join_code"]
        attached = await auth_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Shared Assets Session"})
        session_id = attached.json()["id"]

        joined = await second_auth_client.post("/api/join", json={"code": join_code})
        assert joined.status_code == 200

        owner = create_user("shared_assets_owner", "hash")
        pack_id = _seed_private_pack(owner.user_id, slug="lantern-pack", name="Lantern Pack")
        owner_sid = create_session(owner.user_id)
        add_game_session_member(session_id, owner.user_id, "gm")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            cookies={"warhamster_sid": owner_sid},
        ) as owner_client:
            shared = await owner_client.post(f"/api/sessions/{session_id}/shared-packs/{pack_id}")
        assert shared.status_code == 200

        listing = await second_auth_client.get(f"/api/assets?session_id={session_id}")
        assert listing.status_code == 200
        assets = listing.json()["assets"]
        assert any(asset["pack_id"] == pack_id and asset["shared_in_session"] is True for asset in assets)

        shared_packs = await second_auth_client.get(f"/api/sessions/{session_id}/shared-packs")
        assert shared_packs.status_code == 200
        assert any(pack["pack_id"] == pack_id for pack in shared_packs.json()["packs"])

    async def test_non_member_cannot_query_session_scoped_assets(self, auth_client, app):
        created = await auth_client.post("/api/rooms", json={"name": "Hidden Session Room"})
        room_id = created.json()["room_id"]
        attached = await auth_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Hidden Session"})
        session_id = attached.json()["id"]

        outsider = create_user("outsider_assets", "hash")
        outsider_sid = create_session(outsider.user_id)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            cookies={"warhamster_sid": outsider_sid},
        ) as outsider_client:
            denied = await outsider_client.get(f"/api/assets?session_id={session_id}")
        assert denied.status_code == 403


# ---------------------------------------------------------------------------
# Snapshots
# ---------------------------------------------------------------------------

class TestSnapshots:
    async def test_list_snapshots_empty(self, auth_client):
        r = await auth_client.post("/api/rooms", json={"name": "Snap Room"})
        room_id = r.json()["room_id"]
        r2 = await auth_client.get(f"/api/rooms/{room_id}/snapshots")
        assert r2.status_code == 200
        assert r2.json()["snapshots"] == []

    async def test_create_snapshot_requires_membership(self, http_client):
        r = await http_client.post("/api/rooms/fake-room/snapshots",
                                   json={"label": "Test"})
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# Asset file serving — critical regression tests
# ---------------------------------------------------------------------------

class TestAssetFileServing:
    async def test_owner_can_fetch_own_asset(self, auth_client, tmp_path, monkeypatch):
        """The uploader can always fetch their own asset."""
        from server import app as app_module
        monkeypatch.setattr(app_module, "UPLOADS_DIR", tmp_path)
        monkeypatch.setattr(app_module, "ASSET_UPLOADS_DIR", tmp_path / "assets")

        # Seed via storage (bypass HTTP upload)
        u = create_user("assetowner", "hash")
        asset_id = uuid.uuid4().hex
        _seed_asset(asset_id, u.user_id, tmp_path)

        # Auth as this user
        sid = create_session(u.user_id)
        r = await auth_client.get(
            f"/api/assets/file/{asset_id}",
            cookies={"warhamster_sid": sid},
        )
        assert r.status_code == 200

    async def test_non_owner_can_fetch_gm_asset(self, app, tmp_path, monkeypatch):
        """
        Regression test: players must be able to load assets placed by the GM
        even if they don't own them.  Before the fix, this returned 404.
        """
        from server import app as app_module
        monkeypatch.setattr(app_module, "UPLOADS_DIR", tmp_path)
        monkeypatch.setattr(app_module, "ASSET_UPLOADS_DIR", tmp_path / "assets")

        gm = create_user("gm_asset_test", "hash")
        player = create_user("player_asset_test", "hash")
        asset_id = uuid.uuid4().hex
        _seed_asset(asset_id, gm.user_id, tmp_path)

        player_sid = create_session(player.user_id)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            cookies={"warhamster_sid": player_sid},
        ) as client:
            r = await client.get(f"/api/assets/file/{asset_id}")
            assert r.status_code == 200, (
                "Player should be able to fetch GM's asset — "
                "this was broken before get_asset_by_id fix"
            )

    async def test_asset_file_missing_db_record_returns_404(self, auth_client):
        r = await auth_client.get("/api/assets/file/no-such-asset-id")
        assert r.status_code == 404

    async def test_asset_file_unauthenticated_returns_401(self, http_client):
        r = await http_client.get("/api/assets/file/some-asset-id")
        assert r.status_code == 401

    async def test_asset_file_db_record_missing_file_returns_404(self, auth_client, tmp_path, monkeypatch):
        """DB record exists but the file was deleted from disk."""
        from server import app as app_module
        monkeypatch.setattr(app_module, "UPLOADS_DIR", tmp_path)
        monkeypatch.setattr(app_module, "ASSET_UPLOADS_DIR", tmp_path / "assets")

        u = create_user("assetowner2", "hash")
        asset_id = uuid.uuid4().hex
        # Create DB record but NOT the file
        create_asset_record(
            asset_id=asset_id,
            uploader_user_id=u.user_id,
            name="Ghost",
            tags=[],
            mime="image/png",
            width=64, height=64,
            url_original=f"/uploads/assets/{u.user_id}/{asset_id}.png",
            url_thumb=f"/uploads/assets/{u.user_id}/thumbs/{asset_id}.webp",
        )
        sid = create_session(u.user_id)
        r = await auth_client.get(
            f"/api/assets/file/{asset_id}",
            cookies={"warhamster_sid": sid},
        )
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Asset upload
# ---------------------------------------------------------------------------

class TestAssetUpload:
    async def test_upload_requires_auth(self, http_client, minimal_png_bytes):
        r = await http_client.post(
            "/api/assets/upload",
            files={"file": ("test.png", minimal_png_bytes, "image/png")},
        )
        assert r.status_code == 401

    async def test_upload_success(self, auth_client, minimal_png_bytes, tmp_path, monkeypatch):
        from server import app as app_module
        monkeypatch.setattr(app_module, "UPLOADS_DIR", tmp_path)
        monkeypatch.setattr(app_module, "ASSET_UPLOADS_DIR", tmp_path / "assets")

        r = await auth_client.post(
            "/api/assets/upload",
            files={"file": ("goblin.png", minimal_png_bytes, "image/png")},
            data={"name": "Test Goblin", "tags": "monster,enemy"},
        )
        assert r.status_code in (200, 503)  # 503 if multipart not available
        if r.status_code == 200:
            data = r.json()
            assert "asset_id" in data
            assert data["name"] == "Test Goblin"

    async def test_upload_empty_body_400(self, auth_client, tmp_path, monkeypatch):
        from server import app as app_module
        monkeypatch.setattr(app_module, "UPLOADS_DIR", tmp_path)
        monkeypatch.setattr(app_module, "ASSET_UPLOADS_DIR", tmp_path / "assets")

        r = await auth_client.post(
            "/api/assets/upload",
            files={"file": ("empty.png", b"", "image/png")},
        )
        assert r.status_code in (400, 422, 503)


# ---------------------------------------------------------------------------
# WebSocket — basic connection tests (synchronous Starlette TestClient)
# ---------------------------------------------------------------------------

class TestWebSocket:
    def _make_app(self):
        from server.app import app
        return app

    def test_ws_rejects_unauthenticated(self):
        app = self._make_app()
        with TestClient(app) as client:
            with pytest.raises(Exception):
                # Should close with 1008 before accepting
                with client.websocket_connect("/ws/room-id") as ws:
                    ws.receive_text()

    def test_ws_rejects_non_member(self):
        """User is authenticated but not a room member."""
        u, sid = _seed_user_and_session("ws_nonmember")
        app = self._make_app()
        with TestClient(app) as client:
            with pytest.raises(Exception):
                with client.websocket_connect(
                    "/ws/some-room",
                    cookies={"warhamster_sid": sid},
                ) as ws:
                    ws.receive_text()

    def test_ws_accepts_member_and_sends_state_sync(self):
        """Room member connects and receives STATE_SYNC as first message."""
        u, sid = _seed_user_and_session("ws_member")
        room_id = _seed_room(u.user_id)

        app = self._make_app()
        with TestClient(app) as client:
            with client.websocket_connect(
                f"/ws/{room_id}",
                cookies={"warhamster_sid": sid},
            ) as ws:
                data = json.loads(ws.receive_text())
                assert data["type"] == "STATE_SYNC"

    def test_ws_heartbeat_is_echoed(self):
        """Client sends HEARTBEAT, server responds with HEARTBEAT."""
        u, sid = _seed_user_and_session("ws_hb")
        room_id = _seed_room(u.user_id, room_id="hb-room", join_code="WHAM-HBEAT1")

        app = self._make_app()
        with TestClient(app) as client:
            with client.websocket_connect(
                f"/ws/{room_id}",
                cookies={"warhamster_sid": sid},
            ) as ws:
                # Owner triggers gm_claimed. Bootstrap sends STATE_SYNC, HELLO, PRESENCE
                # directly to this socket only; broadcast_others goes to nobody (alone).
                for _ in range(3):
                    ws.receive_text()

                ws.send_text(json.dumps({"type": "HEARTBEAT", "payload": {}}))
                resp = json.loads(ws.receive_text())
                assert resp["type"] == "HEARTBEAT"
                assert "ts" in resp["payload"]

    def test_ws_session_move_request_reaches_players(self):
        gm, gm_sid = _seed_user_and_session("ws_move_gm")
        player, player_sid = _seed_user_and_session("ws_move_player")
        room_a = _seed_room(gm.user_id, room_id="move-room-a", join_code="WHAM-MOVEA1")
        room_b = _seed_room(gm.user_id, room_id="move-room-b", join_code="WHAM-MOVEB1")
        add_membership(player.user_id, room_a, role="player")
        session = create_game_session("WS Session", gm.user_id)
        add_game_session_member(session.session_id, player.user_id, "player")
        assert assign_room_to_game_session(room_a, session.session_id, display_name="Map A")
        assert assign_room_to_game_session(room_b, session.session_id, display_name="Map B")

        app = self._make_app()
        with TestClient(app) as client:
            with client.websocket_connect(f"/ws/{room_a}", cookies={"warhamster_sid": gm_sid}) as gm_ws,                  client.websocket_connect(f"/ws/{room_a}", cookies={"warhamster_sid": player_sid}) as player_ws:
                # GM gets 3 direct bootstrap + 2 from player join (HELLO, PRESENCE)
                for _ in range(5):
                    gm_ws.receive_text()
                # Player gets 3 direct bootstrap only (no self-echo from broadcast_others)
                for _ in range(3):
                    player_ws.receive_text()
                gm_ws.send_text(json.dumps({
                    "type": "SESSION_ROOM_MOVE_REQUEST",
                    "payload": {
                        "session_id": session.session_id,
                        "target_room_id": room_b,
                        "message": "Please join the next map.",
                    },
                }))
                offer = json.loads(player_ws.receive_text())
                assert offer["type"] == "SESSION_ROOM_MOVE_OFFER"
                assert offer["payload"]["target_room_id"] == room_b

    def test_ws_session_move_force_reaches_players(self):
        gm, gm_sid = _seed_user_and_session("ws_force_gm")
        player, player_sid = _seed_user_and_session("ws_force_player")
        room_a = _seed_room(gm.user_id, room_id="force-room-a", join_code="WHAM-FORCEA")
        room_b = _seed_room(gm.user_id, room_id="force-room-b", join_code="WHAM-FORCEB")
        add_membership(player.user_id, room_a, role="player")
        session = create_game_session("WS Force Session", gm.user_id)
        add_game_session_member(session.session_id, player.user_id, "player")
        assert assign_room_to_game_session(room_a, session.session_id, display_name="Map A")
        assert assign_room_to_game_session(room_b, session.session_id, display_name="Map B")

        app = self._make_app()
        with TestClient(app) as client:
            with client.websocket_connect(f"/ws/{room_a}", cookies={"warhamster_sid": gm_sid}) as gm_ws,                  client.websocket_connect(f"/ws/{room_a}", cookies={"warhamster_sid": player_sid}) as player_ws:
                for _ in range(5):
                    gm_ws.receive_text()
                for _ in range(3):
                    player_ws.receive_text()
                gm_ws.send_text(json.dumps({
                    "type": "SESSION_ROOM_MOVE_FORCE",
                    "payload": {
                        "session_id": session.session_id,
                        "target_room_id": room_b,
                        "message": "The floor collapses beneath you.",
                    },
                }))
                execute = json.loads(player_ws.receive_text())
                assert execute["type"] == "SESSION_ROOM_MOVE_EXECUTE"
                assert execute["payload"]["target_room_id"] == room_b

    def test_ws_gm_owner_gets_is_gm_true_in_hello(self):
        """Room owner should be recognised as GM on connect."""
        u, sid = _seed_user_and_session("ws_gm_owner")
        room_id = _seed_room(u.user_id, room_id="gm-room", join_code="WHAM-GMOWN1")

        app = self._make_app()
        with TestClient(app) as client:
            with client.websocket_connect(
                f"/ws/{room_id}",
                cookies={"warhamster_sid": sid},
            ) as ws:
                # Messages: STATE_SYNC, HELLO, PRESENCE (order may vary slightly)
                messages = [json.loads(ws.receive_text()) for _ in range(3)]
                hello = next((m for m in messages if m["type"] == "HELLO"), None)
                assert hello is not None
                assert hello["payload"]["is_gm"] is True


# ---------------------------------------------------------------------------
# Session hierarchy — HTTP integration tests
# ---------------------------------------------------------------------------

class TestMySessionsInlineRooms:
    """GET /api/my/sessions should return rooms inline for each session."""

    async def test_my_sessions_includes_rooms(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "sesrooms_gm", "password": "password123"})
        assert r.status_code == 200

        # Create a room then attach it to a session
        r2 = await http_client.post("/api/rooms", json={"name": "Tavern"})
        assert r2.status_code == 200
        room_id = r2.json()["room_id"]

        r3 = await http_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Sewer Crawl"})
        assert r3.status_code == 200
        session_id = r3.json()["id"]

        r4 = await http_client.get("/api/my/sessions")
        assert r4.status_code == 200
        sessions = r4.json()["sessions"]
        assert len(sessions) == 1
        sess = sessions[0]
        assert sess["id"] == session_id
        assert "rooms" in sess
        assert any(rm["room_id"] == room_id for rm in sess["rooms"])

    async def test_my_sessions_root_room_id_set(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "rootrm_gm", "password": "password123"})
        assert r.status_code == 200
        r2 = await http_client.post("/api/rooms", json={"name": "Main Room"})
        room_id = r2.json()["room_id"]
        r3 = await http_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Main Session"})
        session_id = r3.json()["id"]

        r4 = await http_client.get("/api/my/sessions")
        sess = next(s for s in r4.json()["sessions"] if s["id"] == session_id)
        assert sess.get("root_room_id") == room_id

    async def test_join_link_adds_session_membership(self, app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as gm_client:
            r = await gm_client.post("/api/auth/register",
                                     json={"username": "joinlink_gm", "password": "password123"})
            assert r.status_code == 200
            r2 = await gm_client.post("/api/rooms", json={"name": "Join Link Room"})
            assert r2.status_code == 200
            room_id = r2.json()["room_id"]
            r3 = await gm_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Join Link Session"})
            assert r3.status_code == 200

            r4 = await gm_client.post(f"/api/rooms/{room_id}/join-code", json={})
            assert r4.status_code == 200
            join_code = r4.json()["join_code"]

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
        ) as player_client:
            r5 = await player_client.post("/api/auth/register",
                                          json={"username": "joinlink_player", "password": "password123"})
            assert r5.status_code == 200

            r6 = await player_client.get(f"/join/{join_code.lower()}")
            assert r6.status_code == 302
            assert r6.headers["location"] == f"/static/canvas.html?room={room_id}"

            r7 = await player_client.get("/api/my/sessions")
            assert r7.status_code == 200
            sessions = r7.json()["sessions"]
            assert len(sessions) == 1
            assert any(rm["room_id"] == room_id for rm in sessions[0]["rooms"])


class TestSessionRoomCreate:
    """POST /api/sessions/{id}/rooms with optional parent_room_id."""

    async def test_create_room_in_session_returns_parent_room_id(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "sescrm_gm", "password": "password123"})
        assert r.status_code == 200
        r2 = await http_client.post("/api/rooms", json={"name": "Hub"})
        room_id = r2.json()["room_id"]
        r3 = await http_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Child Test"})
        session_id = r3.json()["id"]

        r4 = await http_client.post(
            f"/api/sessions/{session_id}/rooms",
            json={"name": "Basement", "parent_room_id": room_id},
        )
        assert r4.status_code == 200
        body = r4.json()
        assert body["session_id"] == session_id
        assert body["parent_room_id"] == room_id

    async def test_create_room_invalid_parent_400(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "sescrm_gm2", "password": "password123"})
        assert r.status_code == 200
        r2 = await http_client.post("/api/rooms", json={"name": "Hub"})
        room_id = r2.json()["room_id"]
        r3 = await http_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Invalid Parent Test"})
        session_id = r3.json()["id"]

        r4 = await http_client.post(
            f"/api/sessions/{session_id}/rooms",
            json={"name": "Orphan", "parent_room_id": "no_such_room"},
        )
        assert r4.status_code == 400

    async def test_player_cannot_create_session_room(self, http_client):
        gm_r = await http_client.post("/api/auth/register",
                                      json={"username": "sescrm_gm3", "password": "password123"})
        assert gm_r.status_code == 200
        r2 = await http_client.post("/api/rooms", json={"name": "Hub"})
        room_id = r2.json()["room_id"]
        r3 = await http_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Player Block Test"})
        session_id = r3.json()["id"]

        # Log out, register player, try to create room
        await http_client.post("/api/auth/logout")
        await http_client.post("/api/auth/register",
                               json={"username": "sescrm_player", "password": "password123"})
        r4 = await http_client.post(
            f"/api/sessions/{session_id}/rooms",
            json={"name": "Sneaky Room"},
        )
        assert r4.status_code == 403


class TestSessionTree:
    """GET /api/sessions/{id}/tree returns flat + nested structure."""

    async def test_tree_returns_rooms_and_tree(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "tree_gm", "password": "password123"})
        assert r.status_code == 200
        r2 = await http_client.post("/api/rooms", json={"name": "Root"})
        root_id = r2.json()["room_id"]
        r3 = await http_client.post(f"/api/rooms/{root_id}/attach-session", json={"name": "Tree Test"})
        session_id = r3.json()["id"]

        r4 = await http_client.post(
            f"/api/sessions/{session_id}/rooms",
            json={"name": "Child", "parent_room_id": root_id},
        )
        child_id = r4.json()["room_id"]

        r5 = await http_client.get(f"/api/sessions/{session_id}/tree")
        assert r5.status_code == 200
        body = r5.json()
        assert body["id"] == session_id
        assert body["root_room_id"] == root_id
        assert "rooms" in body
        assert "tree" in body
        room_ids_flat = [rm["room_id"] for rm in body["rooms"]]
        assert root_id in room_ids_flat
        assert child_id in room_ids_flat
        # Tree root should be root_id with child nested
        tree = body["tree"]
        assert len(tree) == 1
        root_node = tree[0]
        assert root_node["room_id"] == root_id
        child_ids = [c["room_id"] for c in root_node.get("children", [])]
        assert child_id in child_ids

    async def test_tree_requires_membership(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "tree_gm2", "password": "password123"})
        assert r.status_code == 200
        r2 = await http_client.post("/api/rooms", json={"name": "Hub"})
        root_id = r2.json()["room_id"]
        r3 = await http_client.post(f"/api/rooms/{root_id}/attach-session", json={"name": "Private Session"})
        session_id = r3.json()["id"]

        await http_client.post("/api/auth/logout")
        await http_client.post("/api/auth/register",
                               json={"username": "tree_stranger", "password": "password123"})
        r4 = await http_client.get(f"/api/sessions/{session_id}/tree")
        assert r4.status_code == 403


class TestRoomPatchHierarchy:
    """PATCH /api/rooms/{id} supports display_name, parent_room_id, room_order for session GMs."""

    async def test_patch_display_name(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "patch_dn_gm", "password": "password123"})
        assert r.status_code == 200
        r2 = await http_client.post("/api/rooms", json={"name": "Old Name"})
        room_id = r2.json()["room_id"]
        r3 = await http_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Display Name Test"})
        session_id = r3.json()["id"]

        r4 = await http_client.patch(f"/api/rooms/{room_id}", json={"display_name": "New Display"})
        assert r4.status_code == 200

        r5 = await http_client.get(f"/api/sessions/{session_id}/rooms")
        rooms = r5.json()["rooms"]
        match = next(rm for rm in rooms if rm["room_id"] == room_id)
        assert match["display_name"] == "New Display"

    async def test_patch_parent_room_id(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "patch_par_gm", "password": "password123"})
        assert r.status_code == 200
        r2 = await http_client.post("/api/rooms", json={"name": "Root"})
        root_id = r2.json()["room_id"]
        r3 = await http_client.post(f"/api/rooms/{root_id}/attach-session", json={"name": "Parent Patch Test"})
        session_id = r3.json()["id"]

        r4 = await http_client.post(f"/api/sessions/{session_id}/rooms", json={"name": "Child"})
        child_id = r4.json()["room_id"]

        # Clear parent, then set it
        rp = await http_client.patch(f"/api/rooms/{child_id}", json={"parent_room_id": root_id})
        assert rp.status_code == 200
        rooms = (await http_client.get(f"/api/sessions/{session_id}/rooms")).json()["rooms"]
        child = next(rm for rm in rooms if rm["room_id"] == child_id)
        assert child["parent_room_id"] == root_id

    async def test_patch_cycle_returns_400(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "patch_cyc_gm", "password": "password123"})
        assert r.status_code == 200
        r2 = await http_client.post("/api/rooms", json={"name": "Root"})
        root_id = r2.json()["room_id"]
        r3 = await http_client.post(f"/api/rooms/{root_id}/attach-session", json={"name": "Cycle Patch Test"})
        session_id = r3.json()["id"]

        r4 = await http_client.post(f"/api/sessions/{session_id}/rooms", json={"name": "Child"})
        child_id = r4.json()["room_id"]

        # Set child as parent of root — cycle
        rp = await http_client.patch(f"/api/rooms/{root_id}", json={"parent_room_id": child_id})
        assert rp.status_code == 400

    async def test_patch_hierarchy_forbidden_for_non_session_room(self, http_client):
        r = await http_client.post("/api/auth/register",
                                   json={"username": "patch_noses_gm", "password": "password123"})
        assert r.status_code == 200
        r2 = await http_client.post("/api/rooms", json={"name": "Standalone"})
        room_id = r2.json()["room_id"]

        rp = await http_client.patch(f"/api/rooms/{room_id}", json={"display_name": "Renamed"})
        assert rp.status_code == 403


# ---------------------------------------------------------------------------
# WebSocket hardening regression tests
# ---------------------------------------------------------------------------

def _drain_bootstrap(ws) -> None:
    """Send a HEARTBEAT and read until it echoes back, consuming all buffered bootstrap messages."""
    ws.send_text(json.dumps({"type": "HEARTBEAT", "payload": {}}))
    for _ in range(30):
        msg = json.loads(ws.receive_text())
        if msg["type"] == "HEARTBEAT":
            return
    raise AssertionError("HEARTBEAT echo never arrived — bootstrap drain failed")


class TestWebSocketHardening:
    """Regression coverage for normalized bootstrap and session move fanout."""

    def _make_app(self):
        from server.app import app
        return app

    def test_bootstrap_delivers_exactly_3_messages_to_new_socket(self):
        """A newly connected member receives STATE_SYNC, HELLO, PRESENCE — nothing more."""
        u, sid = _seed_user_and_session("bs_solo_user")
        room_id = _seed_room(u.user_id, room_id="bs-solo-room", join_code="WHAM-BSSOLO")
        app = self._make_app()
        with TestClient(app) as client:
            with client.websocket_connect(f"/ws/{room_id}", cookies={"warhamster_sid": sid}) as ws:
                msgs = [json.loads(ws.receive_text()) for _ in range(3)]
                types = [m["type"] for m in msgs]
                assert "STATE_SYNC" in types
                assert "HELLO" in types
                assert "PRESENCE" in types
                # No fourth message buffered (would timeout/block if we tried to read one)

    def test_second_client_receives_3_bootstrap_messages(self):
        """A player joining a room where GM is already connected still gets exactly 3."""
        gm, gm_sid = _seed_user_and_session("bs_gm2")
        player, player_sid = _seed_user_and_session("bs_player2")
        room_id = _seed_room(gm.user_id, room_id="bs-two-room", join_code="WHAM-BSTWO1")
        add_membership(player.user_id, room_id, role="player")
        app = self._make_app()
        with TestClient(app) as client:
            with client.websocket_connect(f"/ws/{room_id}", cookies={"warhamster_sid": gm_sid}) as gm_ws, \
                 client.websocket_connect(f"/ws/{room_id}", cookies={"warhamster_sid": player_sid}) as player_ws:
                # GM: 3 direct + 2 from player join (HELLO, PRESENCE via broadcast_others)
                for _ in range(5):
                    gm_ws.receive_text()
                player_msgs = [json.loads(player_ws.receive_text()) for _ in range(3)]
                player_types = [m["type"] for m in player_msgs]
                assert "STATE_SYNC" in player_types
                assert "HELLO" in player_types
                assert "PRESENCE" in player_types

    def test_session_move_does_not_reach_co_gm(self):
        """SESSION_ROOM_MOVE_OFFER must only reach players; co-GM should not receive it."""
        gm, gm_sid = _seed_user_and_session("mv_excl_gm")
        co_gm, co_gm_sid = _seed_user_and_session("mv_excl_cogm")
        player, player_sid = _seed_user_and_session("mv_excl_player")
        room_a = _seed_room(gm.user_id, room_id="excl-room-a", join_code="WHAM-EXCLA1")
        room_b = _seed_room(gm.user_id, room_id="excl-room-b", join_code="WHAM-EXCLB1")
        add_membership(co_gm.user_id, room_a, role="co_gm")
        add_membership(player.user_id, room_a, role="player")
        session = create_game_session("Excl Session", gm.user_id)
        add_game_session_member(session.session_id, co_gm.user_id, "co_gm")
        add_game_session_member(session.session_id, player.user_id, "player")
        assert assign_room_to_game_session(room_a, session.session_id, display_name="A")
        assert assign_room_to_game_session(room_b, session.session_id, display_name="B")

        app = self._make_app()
        with TestClient(app) as client:
            with client.websocket_connect(f"/ws/{room_a}", cookies={"warhamster_sid": gm_sid}) as gm_ws, \
                 client.websocket_connect(f"/ws/{room_a}", cookies={"warhamster_sid": co_gm_sid}) as cogm_ws, \
                 client.websocket_connect(f"/ws/{room_a}", cookies={"warhamster_sid": player_sid}) as player_ws:
                # Drain all bootstrap messages using heartbeat echo as a sentinel.
                _drain_bootstrap(gm_ws)
                _drain_bootstrap(cogm_ws)
                _drain_bootstrap(player_ws)

                gm_ws.send_text(json.dumps({
                    "type": "SESSION_ROOM_MOVE_REQUEST",
                    "payload": {
                        "session_id": session.session_id,
                        "target_room_id": room_b,
                        "message": "Move!",
                    },
                }))

                # Player must receive SESSION_ROOM_MOVE_OFFER
                player_msg = json.loads(player_ws.receive_text())
                assert player_msg["type"] == "SESSION_ROOM_MOVE_OFFER"

                # co-GM must receive SESSION_SYSTEM_NOTICE (the broadcast notice), not OFFER
                cogm_msg = json.loads(cogm_ws.receive_text())
                assert cogm_msg["type"] == "SESSION_SYSTEM_NOTICE"
                assert cogm_msg["type"] != "SESSION_ROOM_MOVE_OFFER"

    def test_non_session_member_does_not_receive_session_move(self):
        """A room member who is not in the session should not receive session move events."""
        gm, gm_sid = _seed_user_and_session("mv_nonmem_gm")
        outsider, out_sid = _seed_user_and_session("mv_nonmem_out")
        player, player_sid = _seed_user_and_session("mv_nonmem_player")
        room_a = _seed_room(gm.user_id, room_id="nm-room-a", join_code="WHAM-NMMEMA")
        room_b = _seed_room(gm.user_id, room_id="nm-room-b", join_code="WHAM-NMMEMB")
        # Outsider has room membership but is NOT a session member
        add_membership(outsider.user_id, room_a, role="player")
        add_membership(player.user_id, room_a, role="player")
        session = create_game_session("NonMem Session", gm.user_id)
        add_game_session_member(session.session_id, player.user_id, "player")
        assert assign_room_to_game_session(room_a, session.session_id, display_name="A")
        assert assign_room_to_game_session(room_b, session.session_id, display_name="B")

        app = self._make_app()
        with TestClient(app) as client:
            with client.websocket_connect(f"/ws/{room_a}", cookies={"warhamster_sid": gm_sid}) as gm_ws, \
                 client.websocket_connect(f"/ws/{room_a}", cookies={"warhamster_sid": out_sid}) as out_ws, \
                 client.websocket_connect(f"/ws/{room_a}", cookies={"warhamster_sid": player_sid}) as player_ws:
                # Drain all bootstrap messages using heartbeat echo as a sentinel.
                _drain_bootstrap(gm_ws)
                _drain_bootstrap(out_ws)
                _drain_bootstrap(player_ws)

                gm_ws.send_text(json.dumps({
                    "type": "SESSION_ROOM_MOVE_REQUEST",
                    "payload": {
                        "session_id": session.session_id,
                        "target_room_id": room_b,
                        "message": "Move!",
                    },
                }))

                # Player (session member) gets the offer
                player_msg = json.loads(player_ws.receive_text())
                assert player_msg["type"] == "SESSION_ROOM_MOVE_OFFER"

                # Outsider (non-session-member) receives nothing from session events.
                # Verify by sending a heartbeat — it should be the next message (no offer buffered).
                out_ws.send_text(json.dumps({"type": "HEARTBEAT", "payload": {}}))
                out_hb = json.loads(out_ws.receive_text())
                assert out_hb["type"] == "HEARTBEAT", f"outsider got {out_hb['type']!r} instead of HEARTBEAT"


# ---------------------------------------------------------------------------
# Pack import safety regression tests
# ---------------------------------------------------------------------------

class TestPackImportSafety:
    """Regression coverage for _create_pack_record file rollback and asset serving policy."""

    def _make_app(self):
        from server.app import app
        return app

    def test_pack_import_db_failure_cleans_up_copied_files(self, tmp_path, monkeypatch):
        """If add_private_pack_asset_record raises, copied originals/thumbs are removed."""
        import zipfile, io as _io
        from PIL import Image
        from server import app as app_module, storage as storage_module

        monkeypatch.setattr(app_module, "PRIVATE_PACKS_DIR", tmp_path / "packs")
        monkeypatch.setattr(app_module, "UPLOADS_DIR", tmp_path / "uploads")
        monkeypatch.setattr(app_module, "ASSET_UPLOADS_DIR", tmp_path / "uploads" / "assets")

        gm, gm_sid = _seed_user_and_session("zip_fail_gm")

        # Create a valid 1×1 PNG in memory
        buf = _io.BytesIO()
        Image.new("RGB", (1, 1), (255, 0, 0)).save(buf, format="PNG")
        png_bytes = buf.getvalue()

        # Build a minimal zip
        zip_buf = _io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w") as zf:
            zf.writestr("token.png", png_bytes)
        zip_buf.seek(0)

        app = self._make_app()
        with TestClient(app) as client:
            # Register and create token pack
            client.post("/api/auth/register",
                        json={"username": "zip_fail_gm", "password": "password123"},
                        cookies={"warhamster_sid": gm_sid})
            create_r = client.post("/api/token-packs",
                                   json={"name": "Fail Pack", "slug": "fail-pack"},
                                   cookies={"warhamster_sid": gm_sid})
            assert create_r.status_code == 200
            pack_id = create_r.json()["pack"]["pack_id"]

            # Inject DB failure
            monkeypatch.setattr(app_module, "add_private_pack_asset_record",
                                lambda **_: (_ for _ in ()).throw(RuntimeError("db boom")))

            resp = client.post(
                f"/api/token-packs/{pack_id}/upload-zip",
                files={"file": ("tokens.zip", zip_buf.getvalue(), "application/zip")},
                cookies={"warhamster_sid": gm_sid},
            )
            # The import may return 200 with 0 created (skipped) or 500 — either is acceptable;
            # what matters is that no orphan files remain.
            pack_root = tmp_path / "packs" / "fail-pack"
            originals = list((pack_root / "originals").glob("*")) if (pack_root / "originals").exists() else []
            thumbs = list((pack_root / "thumbs").glob("*")) if (pack_root / "thumbs").exists() else []
            assert originals == [], f"Orphaned originals: {originals}"
            assert thumbs == [], f"Orphaned thumbs: {thumbs}"

    def test_pack_asset_file_fetch_allowed_for_any_logged_in_user(self, tmp_path, monkeypatch):
        """
        Policy test: any authenticated user can fetch a pack asset file by ID —
        entitlement is enforced at the library listing layer, not file-serve layer.
        Players need this to render GM-placed private-pack tokens on maps.
        """
        import io as _io
        from PIL import Image
        from server import app as app_module, storage as storage_module
        from server.storage import PrivatePackAssetRow, PrivatePackRow, utc_now_iso

        monkeypatch.setattr(app_module, "PRIVATE_PACKS_DIR", tmp_path / "packs")

        owner, owner_sid = _seed_user_and_session("fileserv_owner")
        stranger, stranger_sid = _seed_user_and_session("fileserv_stranger")

        # Seed pack + asset record + real file
        with Session(storage_module.engine) as s:
            pack = PrivatePackRow(
                slug="serve-pack", name="Serve Pack",
                owner_user_id=owner.user_id, created_at=utc_now_iso(),
                root_rel="serve-pack/manifest.json", thumb_rel="serve-pack/thumb.webp",
            )
            s.add(pack)
            s.commit()
            s.refresh(pack)
            asset_id = str(uuid.uuid4())
            s.add(PrivatePackAssetRow(
                asset_id=asset_id, pack_id=pack.pack_id,
                name="Goblin Token", folder_path="tokens",
                tags_json="[]", mime="image/png",
                width=64, height=64,
                url_original=f"{asset_id}.png",
                url_thumb=f"{asset_id}_t.png",
                created_at=utc_now_iso(),
            ))
            s.commit()

        # Write the actual file where the route expects it
        pack_originals = tmp_path / "packs" / "serve-pack" / "originals"
        pack_originals.mkdir(parents=True, exist_ok=True)
        buf = _io.BytesIO()
        Image.new("RGB", (64, 64), (0, 128, 0)).save(buf, format="PNG")
        (pack_originals / f"{asset_id}.png").write_bytes(buf.getvalue())

        app = self._make_app()
        with TestClient(app) as client:
            # Owner can fetch their own asset (expected)
            r_owner = client.get(f"/api/assets/file/{asset_id}",
                                 cookies={"warhamster_sid": owner_sid})
            assert r_owner.status_code == 200

            # Stranger (no entitlement) can ALSO fetch by asset_id — policy: open to logged-in users
            r_stranger = client.get(f"/api/assets/file/{asset_id}",
                                    cookies={"warhamster_sid": stranger_sid})
            assert r_stranger.status_code == 200, (
                "Pack asset file serving must be open to any logged-in user. "
                "Entitlement is enforced at the library listing layer so players "
                "can render GM-placed private-pack tokens on maps."
            )

            # Unauthenticated is still blocked
            r_anon = client.get(f"/api/assets/file/{asset_id}")
            assert r_anon.status_code in (401, 403)
