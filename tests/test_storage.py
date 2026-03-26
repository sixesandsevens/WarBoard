"""
Unit tests for server/storage.py

All tests run against an in-memory SQLite DB via the fresh_db fixture in conftest.py.
No async needed — every storage function is synchronous.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

import pytest

from server import storage
from server.storage import (
    add_game_session_member,
    add_membership,
    assign_room_to_game_session,
    create_asset_record,
    create_game_session,
    create_room_record,
    create_session,
    create_snapshot,
    create_user,
    delete_asset_record,
    delete_room_record,
    delete_session,
    ensure_room_join_code,
    ensure_room_membership_for_user,
    get_asset_by_id,
    get_asset_for_user,
    get_game_session_role,
    get_room_meta,
    get_user_by_id,
    get_user_by_sid,
    get_user_by_username,
    is_member,
    list_assets_for_user,
    list_game_session_members,
    list_game_session_rooms,
    list_game_sessions_for_user,
    list_rooms_for_user,
    list_snapshots,
    load_snapshot_state_json,
    room_id_from_join_code,
    SessionRow,
    touch_membership,
    update_room_name,
    update_user_last_room,
    update_user_password_hash,
    utc_now_iso,
)
from server.models import RoomState
from sqlmodel import Session


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_user(username="alice", pw="hash"):
    return create_user(username, pw)


def _make_room(room_id="room1", owner_id=1):
    state = RoomState(room_id=room_id)
    create_room_record(
        room_id=room_id,
        name="Test Room",
        state_json=state.model_dump_json(),
        owner_user_id=owner_id,
        join_code="WHAM-AAAA11",
    )
    return room_id


def _make_asset(asset_id="asset1", uploader_id=1):
    create_asset_record(
        asset_id=asset_id,
        uploader_user_id=uploader_id,
        name="Test Asset",
        tags=[],
        mime="image/png",
        width=64,
        height=64,
        url_original="/uploads/assets/1/asset1.png",
        url_thumb="/uploads/assets/1/thumbs/asset1.webp",
    )
    return asset_id


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

class TestCreateUser:
    def test_creates_user_successfully(self):
        u = _make_user("bob", "hash123")
        assert u.username == "bob"
        assert u.user_id is not None

    def test_duplicate_username_raises(self):
        _make_user("bob")
        with pytest.raises(ValueError, match="already exists"):
            _make_user("bob")

    def test_get_user_by_username(self):
        _make_user("carol")
        u = get_user_by_username("carol")
        assert u is not None
        assert u.username == "carol"

    def test_get_user_by_username_missing_returns_none(self):
        assert get_user_by_username("nobody") is None

    def test_get_user_by_id(self):
        u = _make_user("dave")
        fetched = get_user_by_id(u.user_id)
        assert fetched is not None
        assert fetched.username == "dave"

    def test_get_user_by_id_missing_returns_none(self):
        assert get_user_by_id(99999) is None

    def test_update_password_hash(self):
        u = _make_user("eve")
        ok = update_user_password_hash(u.user_id, "new_hash")
        assert ok is True
        updated = get_user_by_id(u.user_id)
        assert updated.password_hash == "new_hash"

    def test_update_password_hash_missing_user_returns_false(self):
        assert update_user_password_hash(99999, "x") is False

    def test_update_last_room(self):
        u = _make_user("frank")
        ok = update_user_last_room(u.user_id, "room-abc")
        assert ok is True
        updated = get_user_by_id(u.user_id)
        assert updated.last_room_id == "room-abc"

    def test_update_last_room_missing_user_returns_false(self):
        assert update_user_last_room(99999, "x") is False


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

class TestSessions:
    def test_create_session_returns_sid_string(self):
        u = _make_user()
        sid = create_session(u.user_id)
        assert isinstance(sid, str)
        assert len(sid) > 0

    def test_get_user_by_valid_sid(self):
        u = _make_user()
        sid = create_session(u.user_id)
        fetched = get_user_by_sid(sid)
        assert fetched is not None
        assert fetched.user_id == u.user_id

    def test_get_user_by_sid_empty_returns_none(self):
        assert get_user_by_sid("") is None

    def test_get_user_by_sid_unknown_returns_none(self):
        assert get_user_by_sid("not-a-real-sid") is None

    def test_get_user_by_expired_sid_returns_none_and_deletes_row(self):
        u = _make_user()
        sid = create_session(u.user_id)
        # Back-date the expiry directly in the DB
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        with Session(storage.engine) as s:
            row = s.get(SessionRow, sid)
            row.expires_at = past
            s.add(row)
            s.commit()
        assert get_user_by_sid(sid) is None
        # Row should be cleaned up
        with Session(storage.engine) as s:
            assert s.get(SessionRow, sid) is None

    def test_delete_session(self):
        u = _make_user()
        sid = create_session(u.user_id)
        delete_session(sid)
        assert get_user_by_sid(sid) is None

    def test_delete_session_nonexistent_is_noop(self):
        delete_session("ghost-sid")  # should not raise


# ---------------------------------------------------------------------------
# Rooms
# ---------------------------------------------------------------------------

class TestRooms:
    def test_create_room_record(self):
        u = _make_user()
        room_id = _make_room(owner_id=u.user_id)
        meta = get_room_meta(room_id)
        assert meta is not None
        assert meta.name == "Test Room"
        assert meta.owner_user_id == u.user_id

    def test_create_room_duplicate_raises(self):
        u = _make_user()
        _make_room(owner_id=u.user_id)
        with pytest.raises(ValueError, match="already exists"):
            _make_room(owner_id=u.user_id)

    def test_get_room_meta_missing_returns_none(self):
        assert get_room_meta("no-such-room") is None

    def test_update_room_name(self):
        u = _make_user()
        room_id = _make_room(owner_id=u.user_id)
        ok = update_room_name(room_id, "Renamed Room")
        assert ok is True
        meta = get_room_meta(room_id)
        assert meta.name == "Renamed Room"

    def test_update_room_name_missing_returns_false(self):
        assert update_room_name("ghost-room", "x") is False

    def test_delete_room_removes_meta_row_and_state(self):
        u = _make_user()
        room_id = _make_room(owner_id=u.user_id)
        ok = delete_room_record(room_id)
        assert ok is True
        assert get_room_meta(room_id) is None

    def test_delete_room_cascades_snapshots_and_memberships(self):
        u = _make_user()
        room_id = _make_room(owner_id=u.user_id)
        add_membership(u.user_id, room_id, role="owner")
        create_snapshot(room_id, "snap", "{}")
        delete_room_record(room_id)
        assert list_snapshots(room_id) == []
        assert is_member(u.user_id, room_id) is False

    def test_delete_room_missing_returns_false(self):
        assert delete_room_record("no-such") is False


# ---------------------------------------------------------------------------
# Membership + join codes
# ---------------------------------------------------------------------------

class TestMembership:
    def test_add_membership_and_is_member(self):
        u = _make_user()
        room_id = _make_room(owner_id=u.user_id)
        add_membership(u.user_id, room_id, role="owner")
        assert is_member(u.user_id, room_id) is True

    def test_is_member_false_for_non_member(self):
        u = _make_user()
        assert is_member(u.user_id, "nonexistent-room") is False

    def test_add_membership_is_idempotent(self):
        u = _make_user()
        room_id = _make_room(owner_id=u.user_id)
        add_membership(u.user_id, room_id, role="owner")
        add_membership(u.user_id, room_id, role="owner")  # second call should not raise
        assert is_member(u.user_id, room_id) is True

    def test_touch_membership_updates_last_seen(self):
        u = _make_user()
        room_id = _make_room(owner_id=u.user_id)
        add_membership(u.user_id, room_id, role="owner")
        before = list_rooms_for_user(u.user_id)[0]["last_seen_at"]
        import time; time.sleep(0.01)
        touch_membership(u.user_id, room_id)
        after = list_rooms_for_user(u.user_id)[0]["last_seen_at"]
        assert after >= before

    def test_list_rooms_for_user(self):
        u = _make_user()
        room_id = _make_room(owner_id=u.user_id)
        add_membership(u.user_id, room_id, role="owner")
        rooms = list_rooms_for_user(u.user_id)
        assert len(rooms) == 1
        assert rooms[0]["room_id"] == room_id

    def test_room_id_from_join_code(self):
        u = _make_user()
        room_id = _make_room(owner_id=u.user_id)
        found = room_id_from_join_code("WHAM-AAAA11")
        assert found == room_id

    def test_room_id_from_join_code_missing_returns_none(self):
        assert room_id_from_join_code("WHAM-XXXXXX") is None

    def test_room_id_from_join_code_empty_returns_none(self):
        assert room_id_from_join_code("") is None

    def test_ensure_room_join_code_returns_existing(self):
        u = _make_user()
        room_id = _make_room(owner_id=u.user_id)
        code = ensure_room_join_code(room_id)
        assert code == "WHAM-AAAA11"

    def test_ensure_room_join_code_missing_room_raises(self):
        with pytest.raises(ValueError, match="not found"):
            ensure_room_join_code("ghost-room")


# ---------------------------------------------------------------------------
# Gameplay sessions
# ---------------------------------------------------------------------------

class TestGameplaySessions:
    def test_create_game_session_adds_creator_as_gm(self):
        u = _make_user("session_gm")
        session = create_game_session("Friday Night", u.user_id)
        assert session.session_id.startswith("sess_")
        assert get_game_session_role(session.session_id, u.user_id) == "gm"

    def test_assign_room_to_game_session_updates_room_meta(self):
        u = _make_user("attach_owner")
        room_id = _make_room(room_id="attach-room", owner_id=u.user_id)
        session = create_game_session("Attach Test", u.user_id)
        ok = assign_room_to_game_session(room_id, session.session_id, display_name="Antechamber")
        assert ok is True
        meta = get_room_meta(room_id)
        assert meta.session_id == session.session_id
        assert meta.display_name == "Antechamber"
        rooms = list_game_session_rooms(session.session_id)
        assert len(rooms) == 1
        assert rooms[0]["display_name"] == "Antechamber"

    def test_session_members_gain_room_access(self):
        gm = _make_user("session_owner")
        player = _make_user("session_player")
        room_id = _make_room(room_id="session-room", owner_id=gm.user_id)
        session = create_game_session("Access Test", gm.user_id)
        assign_room_to_game_session(room_id, session.session_id, display_name="Map A")
        add_game_session_member(session.session_id, player.user_id, "player")
        assert ensure_room_membership_for_user(player.user_id, room_id) is True
        assert is_member(player.user_id, room_id) is True

    def test_list_rooms_for_user_includes_session_rooms(self):
        gm = _make_user("session_owner_two")
        player = _make_user("session_player_two")
        room_id = _make_room(room_id="session-room-two", owner_id=gm.user_id)
        session = create_game_session("List Test", gm.user_id)
        assign_room_to_game_session(room_id, session.session_id, display_name="Map B")
        add_game_session_member(session.session_id, player.user_id, "player")
        rooms = list_rooms_for_user(player.user_id)
        assert any(room["room_id"] == room_id and room["session_id"] == session.session_id for room in rooms)
        memberships = list_game_session_members(session.session_id)
        assert any(member["username"] == "session_player_two" for member in memberships)
        sessions = list_game_sessions_for_user(player.user_id)
        assert any(entry["id"] == session.session_id for entry in sessions)


# ---------------------------------------------------------------------------
# Snapshots
# ---------------------------------------------------------------------------

class TestSnapshots:
    def test_create_and_load_snapshot(self):
        u = _make_user()
        room_id = _make_room(owner_id=u.user_id)
        snap_id = create_snapshot(room_id, "Before battle", '{"test": 1}')
        assert isinstance(snap_id, str)
        loaded = load_snapshot_state_json(snap_id)
        assert loaded == '{"test": 1}'

    def test_list_snapshots(self):
        u = _make_user()
        room_id = _make_room(owner_id=u.user_id)
        create_snapshot(room_id, "Snap A", "{}")
        create_snapshot(room_id, "Snap B", "{}")
        snaps = list_snapshots(room_id)
        assert len(snaps) == 2
        labels = {s["label"] for s in snaps}
        assert labels == {"Snap A", "Snap B"}

    def test_load_snapshot_missing_returns_none(self):
        assert load_snapshot_state_json("nonexistent") is None


# ---------------------------------------------------------------------------
# Assets — ownership rules (critical regression tests)
# ---------------------------------------------------------------------------

class TestAssets:
    def test_create_asset_record(self):
        u = _make_user()
        _make_asset("a1", uploader_id=u.user_id)
        row = get_asset_by_id("a1")
        assert row is not None
        assert row.name == "Test Asset"

    def test_get_asset_by_id_ignores_ownership(self):
        """
        Any caller can fetch an asset by ID regardless of who uploaded it.
        This is the fix that allows players to see GM-placed assets.
        """
        gm = _make_user("gm")
        _make_user("player")
        _make_asset("gm-asset", uploader_id=gm.user_id)

        # get_asset_by_id should return it regardless of who asks
        row = get_asset_by_id("gm-asset")
        assert row is not None
        assert row.uploader_user_id == gm.user_id

    def test_get_asset_for_user_enforces_ownership(self):
        """
        get_asset_for_user must ONLY return assets uploaded by that user.
        Players should not be able to manage (delete/list) the GM's assets.
        """
        gm = _make_user("gm2")
        player = _make_user("player2")
        _make_asset("gm-asset2", uploader_id=gm.user_id)

        # Owner can get it
        assert get_asset_for_user("gm-asset2", gm.user_id) is not None
        # Non-owner cannot
        assert get_asset_for_user("gm-asset2", player.user_id) is None

    def test_get_asset_by_id_missing_returns_none(self):
        assert get_asset_by_id("no-such") is None

    def test_delete_asset_enforces_ownership(self):
        gm = _make_user("gm3")
        player = _make_user("player3")
        _make_asset("del-asset", uploader_id=gm.user_id)

        # Non-owner cannot delete
        assert delete_asset_record("del-asset", player.user_id) is False
        assert get_asset_by_id("del-asset") is not None  # still exists

        # Owner can delete
        assert delete_asset_record("del-asset", gm.user_id) is True
        assert get_asset_by_id("del-asset") is None

    def test_list_assets_for_user_scoped_to_owner(self):
        gm = _make_user("gm4")
        player = _make_user("player4")
        _make_asset("asset-gm4", uploader_id=gm.user_id)

        gm_assets = list_assets_for_user(gm.user_id)
        player_assets = list_assets_for_user(player.user_id)

        assert len(gm_assets) == 1
        assert len(player_assets) == 0

    def test_list_assets_filters_by_name(self):
        u = _make_user()
        create_asset_record(
            asset_id="goblin1", uploader_user_id=u.user_id, name="Goblin Warrior",
            tags=[], mime="image/png", width=64, height=64,
            url_original="/uploads/a.png", url_thumb="/uploads/t.png",
        )
        create_asset_record(
            asset_id="dragon1", uploader_user_id=u.user_id, name="Ancient Dragon",
            tags=[], mime="image/png", width=64, height=64,
            url_original="/uploads/b.png", url_thumb="/uploads/t2.png",
        )
        assert len(list_assets_for_user(u.user_id, q="goblin")) == 1
        assert len(list_assets_for_user(u.user_id, q="dragon")) == 1
        assert len(list_assets_for_user(u.user_id, q="zzz")) == 0

    def test_list_assets_filters_by_tag(self):
        u = _make_user()
        create_asset_record(
            asset_id="t1", uploader_user_id=u.user_id, name="Monster",
            tags=["enemy", "undead"], mime="image/png", width=64, height=64,
            url_original="/uploads/c.png", url_thumb="/uploads/tc.png",
        )
        assert len(list_assets_for_user(u.user_id, tag="undead")) == 1
        assert len(list_assets_for_user(u.user_id, tag="ally")) == 0
