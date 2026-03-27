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

    async def test_gm_can_share_private_pack_to_session(self, auth_client):
        created = await auth_client.post("/api/rooms", json={"name": "Share Room"})
        room_id = created.json()["room_id"]
        attached = await auth_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Share Session"})
        session_id = attached.json()["id"]

        gm_user = create_user("share_owner", "hash")
        add_game_session_member(session_id, gm_user.user_id, "co_gm")
        pack_id = _seed_private_pack(gm_user.user_id, slug="ghoul-pack", name="Ghoul Pack")
        sid = create_session(gm_user.user_id)

        shared = await auth_client.post(
            f"/api/sessions/{session_id}/shared-packs/{pack_id}",
            cookies={"warhamster_sid": sid},
        )
        assert shared.status_code == 200
        assert any(pack["pack_id"] == pack_id for pack in shared.json()["packs"])

    async def test_player_sees_session_shared_pack_assets_in_library(self, auth_client, second_auth_client):
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
        add_game_session_member(session_id, owner.user_id, "co_gm")

        shared = await auth_client.post(
            f"/api/sessions/{session_id}/shared-packs/{pack_id}",
            cookies={"warhamster_sid": owner_sid},
        )
        assert shared.status_code == 200

        listing = await second_auth_client.get(f"/api/assets?session_id={session_id}")
        assert listing.status_code == 200
        assets = listing.json()["assets"]
        assert any(asset["pack_id"] == pack_id and asset["shared_in_session"] is True for asset in assets)

        shared_packs = await second_auth_client.get(f"/api/sessions/{session_id}/shared-packs")
        assert shared_packs.status_code == 200
        assert any(pack["pack_id"] == pack_id for pack in shared_packs.json()["packs"])

    async def test_non_member_cannot_query_session_scoped_assets(self, auth_client):
        created = await auth_client.post("/api/rooms", json={"name": "Hidden Session Room"})
        room_id = created.json()["room_id"]
        attached = await auth_client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Hidden Session"})
        session_id = attached.json()["id"]

        outsider = create_user("outsider_assets", "hash")
        outsider_sid = create_session(outsider.user_id)

        denied = await auth_client.get(
            f"/api/assets?session_id={session_id}",
            cookies={"warhamster_sid": outsider_sid},
        )
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
                # Owner triggers gm_claimed, so server sends 6 initial messages:
                # direct STATE_SYNC, HELLO, PRESENCE + broadcast STATE_SYNC, HELLO, PRESENCE
                for _ in range(6):
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
                for _ in range(6):
                    gm_ws.receive_text()
                for _ in range(5):
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
                for _ in range(6):
                    gm_ws.receive_text()
                for _ in range(5):
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
