"""
Unit tests for server/storage.py

All tests run against an in-memory SQLite DB via the fresh_db fixture in conftest.py.
No async needed — every storage function is synchronous.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

import pytest

from sqlmodel import SQLModel, create_engine as _sa_create_engine

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
    get_game_session_root_room_id,
    list_all_assets_for_user,
    get_room_meta,
    get_user_by_id,
    get_user_by_sid,
    get_user_by_username,
    is_member,
    list_game_session_shared_packs,
    list_assets_for_user,
    list_game_session_members,
    list_game_session_rooms,
    list_game_sessions_for_user,
    list_private_packs_for_user,
    list_rooms_for_user,
    list_snapshots,
    load_snapshot_state_json,
    room_id_from_join_code,
    set_game_session_shared_pack,
    set_game_session_root_room,
    set_room_parent,
    SessionRow,
    PrivatePackAssetRow,
    PrivatePackRow,
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


def _make_private_pack(owner_user_id: int, slug: str = "crypt-pack", name: str = "Crypt Pack") -> int:
    with Session(storage.engine) as s:
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
                name=f"{name} Statue",
                folder_path="props",
                tags_json='["statue","crypt"]',
                mime="image/png",
                width=256,
                height=256,
                url_original=f"/private-packs/{slug}/originals/{slug}-asset.png",
                url_thumb=f"/private-packs/{slug}/thumbs/{slug}-asset.webp",
                created_at=utc_now_iso(),
            )
        )
        s.commit()
        return int(pack.pack_id)


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

    def test_session_members_include_current_room_name(self):
        gm = _make_user("roster_gm")
        player = _make_user("roster_player")
        room_id = _make_room(room_id="roster-room", owner_id=gm.user_id)
        session = create_game_session("Roster Test", gm.user_id)
        assign_room_to_game_session(room_id, session.session_id, display_name="Prison Cells")
        add_game_session_member(session.session_id, player.user_id, "player")
        update_user_last_room(player.user_id, room_id)

        memberships = list_game_session_members(session.session_id)
        player_row = next(member for member in memberships if member["user_id"] == player.user_id)
        assert player_row["current_room_id"] == room_id
        assert player_row["current_room_name"] == "Prison Cells"

    def test_session_shared_pack_visibility_extends_asset_library(self):
        gm = _make_user("asset_gm")
        player = _make_user("asset_player")
        session = create_game_session("Asset Share Test", gm.user_id)
        add_game_session_member(session.session_id, player.user_id, "player")
        pack_id = _make_private_pack(gm.user_id, slug="shared-crypt", name="Shared Crypt")

        assets_before = list_all_assets_for_user(player.user_id)
        assert all(item.get("pack_id") != pack_id for item in assets_before)

        assert set_game_session_shared_pack(session.session_id, pack_id, True, shared_by_user_id=gm.user_id) is True

        shared_packs = list_game_session_shared_packs(session.session_id)
        assert len(shared_packs) == 1
        assert shared_packs[0]["pack_id"] == pack_id

        packs_for_gm = list_private_packs_for_user(gm.user_id, session_id=session.session_id)
        assert packs_for_gm[0]["shared_in_session"] is True

        assets_after = list_all_assets_for_user(player.user_id, session_id=session.session_id)
        shared_assets = [item for item in assets_after if item.get("pack_id") == pack_id]
        assert len(shared_assets) == 1
        assert shared_assets[0]["shared_in_session"] is True

    def test_unsharing_pack_removes_session_library_access(self):
        gm = _make_user("asset_gm_two")
        player = _make_user("asset_player_two")
        session = create_game_session("Asset Share Remove", gm.user_id)
        add_game_session_member(session.session_id, player.user_id, "player")
        pack_id = _make_private_pack(gm.user_id, slug="shared-vault", name="Shared Vault")

        assert set_game_session_shared_pack(session.session_id, pack_id, True, shared_by_user_id=gm.user_id) is True
        assert any(item.get("pack_id") == pack_id for item in list_all_assets_for_user(player.user_id, session_id=session.session_id))

        assert set_game_session_shared_pack(session.session_id, pack_id, False, shared_by_user_id=gm.user_id) is True
        assert list_game_session_shared_packs(session.session_id) == []
        assert all(item.get("pack_id") != pack_id for item in list_all_assets_for_user(player.user_id, session_id=session.session_id))


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


# ---------------------------------------------------------------------------
# Paginated asset search — list_assets_for_user_page
#
# _raw_conn_ctx() opens a fresh sqlite3 connection by URL, so these tests
# must use a file-based engine (not :memory:) and override the autouse
# fresh_db fixture via a second monkeypatch within the same function scope.
# ---------------------------------------------------------------------------

class TestPagedAssets:
    @pytest.fixture(autouse=True)
    def file_db(self, tmp_path, monkeypatch):
        """Replace the in-memory engine from fresh_db with a file-based engine
        so that _raw_conn_ctx() in storage_assets can open a second connection
        to the same database."""
        db_path = str(tmp_path / "paged_assets.db")
        file_engine = _sa_create_engine(f"sqlite:///{db_path}")
        SQLModel.metadata.create_all(file_engine)
        monkeypatch.setattr(storage, "engine", file_engine)

    def _asset(self, uid, asset_id, name, tags):
        create_asset_record(
            asset_id=asset_id,
            uploader_user_id=uid,
            name=name,
            tags=tags,
            mime="image/png",
            width=64,
            height=64,
            url_original=f"/uploads/{asset_id}.png",
            url_thumb=f"/uploads/{asset_id}_t.png",
        )

    def test_search_by_name(self):
        from server.storage import list_assets_for_user_page
        u = _make_user("pg1")
        self._asset(u.user_id, "pg-goblin", "Goblin Warrior", ["enemy"])
        self._asset(u.user_id, "pg-dragon", "Ancient Dragon", ["boss"])
        items, total, _ = list_assets_for_user_page(u.user_id, q="goblin")
        assert total == 1
        assert items[0]["asset_id"] == "pg-goblin"

    def test_search_by_tag_via_q(self):
        """Free-text q must match tags — regression parity with list_assets_for_user."""
        from server.storage import list_assets_for_user_page
        u = _make_user("pg2")
        self._asset(u.user_id, "pg-undead", "Mystery Token", ["undead", "crypt"])
        self._asset(u.user_id, "pg-tree",   "Forest Tree",   ["terrain"])
        items, total, _ = list_assets_for_user_page(u.user_id, q="undead")
        assert total == 1
        assert items[0]["asset_id"] == "pg-undead"

    def test_search_no_match(self):
        from server.storage import list_assets_for_user_page
        u = _make_user("pg3")
        self._asset(u.user_id, "pg-x", "Some Asset", ["prop"])
        items, total, _ = list_assets_for_user_page(u.user_id, q="zzz")
        assert total == 0
        assert items == []

    def test_explicit_tag_filter(self):
        from server.storage import list_assets_for_user_page
        u = _make_user("pg4")
        self._asset(u.user_id, "pg-sk", "Skeleton",  ["undead"])
        self._asset(u.user_id, "pg-zb", "Zombie",    ["undead", "slow"])
        items, total, _ = list_assets_for_user_page(u.user_id, tag="slow")
        assert total == 1
        assert items[0]["asset_id"] == "pg-zb"

    def test_search_and_tag_combined(self):
        from server.storage import list_assets_for_user_page
        u = _make_user("pg5")
        self._asset(u.user_id, "pg-sw", "Skeleton Warrior", ["undead", "melee"])
        self._asset(u.user_id, "pg-sa", "Skeleton Archer",  ["undead", "ranged"])
        # q matches both; tag="ranged" narrows to one
        items, total, _ = list_assets_for_user_page(u.user_id, q="skeleton", tag="ranged")
        assert total == 1
        assert items[0]["asset_id"] == "pg-sa"

    def test_total_count_and_page_items_agree(self):
        from server.storage import list_assets_for_user_page
        u = _make_user("pg6")
        for i in range(5):
            self._asset(u.user_id, f"pg-bulk-{i}", f"Asset {i}", ["bulk"])
        items, total, has_more = list_assets_for_user_page(u.user_id, q="asset", limit=3)
        assert total == 5
        assert len(items) == 3
        assert has_more is True


# ---------------------------------------------------------------------------
# Session hierarchy — root_room_id and parent_room_id
# ---------------------------------------------------------------------------

def _make_session_with_room(session_name="Campaign", room_name="Hub"):
    """Helper: user + session + one attached room. Returns (user, session, room_id)."""
    u = _make_user(session_name + "_gm")
    state = RoomState(room_id=session_name + "_room1")
    create_room_record(
        room_id=session_name + "_room1",
        name=room_name,
        state_json=state.model_dump_json(),
        owner_user_id=u.user_id,
        join_code="WHAM-" + "".join(c for c in session_name.upper() if c.isalnum())[:9],
    )
    add_membership(u.user_id, session_name + "_room1", "owner")
    sess = create_game_session(session_name, u.user_id)
    assign_room_to_game_session(session_name + "_room1", sess.session_id, display_name=room_name)
    return u, sess, session_name + "_room1"


class TestRootRoomId:
    def test_attach_first_room_sets_root(self):
        u = _make_user("root_gm1")
        state = RoomState(room_id="root_r1")
        create_room_record(room_id="root_r1", name="Hub", state_json=state.model_dump_json(), owner_user_id=u.user_id, join_code="WHAM-ROOT01")
        add_membership(u.user_id, "root_r1", "owner")
        sess = create_game_session("Root Test", u.user_id)
        assert get_game_session_root_room_id(sess.session_id) is None
        assign_room_to_game_session("root_r1", sess.session_id, display_name="Hub")
        assert get_game_session_root_room_id(sess.session_id) == "root_r1"

    def test_attach_second_room_does_not_overwrite_root(self):
        u = _make_user("root_gm2")
        codes = {"root2_r1": "WHAM-R2RA01", "root2_r2": "WHAM-R2RB01"}
        for rid, code in codes.items():
            state = RoomState(room_id=rid)
            create_room_record(room_id=rid, name=rid, state_json=state.model_dump_json(), owner_user_id=u.user_id, join_code=code)
            add_membership(u.user_id, rid, "owner")
        sess = create_game_session("Root Test 2", u.user_id)
        assign_room_to_game_session("root2_r1", sess.session_id)
        assign_room_to_game_session("root2_r2", sess.session_id)
        assert get_game_session_root_room_id(sess.session_id) == "root2_r1"

    def test_set_game_session_root_room_updates(self):
        u = _make_user("root_gm3")
        state = RoomState(room_id="root3_r1")
        create_room_record(room_id="root3_r1", name="R1", state_json=state.model_dump_json(), owner_user_id=u.user_id, join_code="WHAM-ROOT31")
        add_membership(u.user_id, "root3_r1", "owner")
        sess = create_game_session("Root Test 3", u.user_id)
        assign_room_to_game_session("root3_r1", sess.session_id)
        ok = set_game_session_root_room(sess.session_id, "root3_r1")
        assert ok is True
        assert get_game_session_root_room_id(sess.session_id) == "root3_r1"

    def test_create_room_in_session_sets_root_if_none(self):
        from server.storage import create_room_in_game_session
        u = _make_user("root_gm4")
        sess = create_game_session("Root Test 4", u.user_id)
        assert get_game_session_root_room_id(sess.session_id) is None
        rid = "root4_r1"
        state = RoomState(room_id=rid, gm_user_id=u.user_id)
        create_room_in_game_session(
            session_id=sess.session_id,
            created_by_user_id=u.user_id,
            room_id=rid,
            name="Main Hall",
            state_json=state.model_dump_json(),
            join_code="WHAM-ROOT41",
        )
        assert get_game_session_root_room_id(sess.session_id) == rid

    def test_list_game_sessions_includes_root_room_id(self):
        u, sess, room_id = _make_session_with_room("rootlist", "Main")
        sessions = list_game_sessions_for_user(u.user_id)
        match = next((s for s in sessions if s["id"] == sess.session_id), None)
        assert match is not None
        assert match.get("root_room_id") == room_id


class TestParentRoomId:
    def test_list_session_rooms_includes_parent_room_id(self):
        u, sess, room_id = _make_session_with_room("parentlist", "Hub")
        rooms = list_game_session_rooms(sess.session_id)
        assert len(rooms) == 1
        assert "parent_room_id" in rooms[0]
        assert rooms[0]["parent_room_id"] is None

    def test_set_room_parent_links_child_to_parent(self):
        from server.storage import create_room_in_game_session
        u = _make_user("parent_gm1")
        sess = create_game_session("Parent Test 1", u.user_id)
        for rid, code in [("par1_r1", "WHAM-PAR101"), ("par1_r2", "WHAM-PAR102")]:
            state = RoomState(room_id=rid, gm_user_id=u.user_id)
            create_room_in_game_session(
                session_id=sess.session_id,
                created_by_user_id=u.user_id,
                room_id=rid,
                name=rid,
                state_json=state.model_dump_json(),
                join_code=code,
            )
        ok = set_room_parent("par1_r2", "par1_r1")
        assert ok is True
        meta = get_room_meta("par1_r2")
        assert meta.parent_room_id == "par1_r1"

    def test_set_room_parent_rejects_self_reference(self):
        u, sess, room_id = _make_session_with_room("selfpar", "Hub")
        ok = set_room_parent(room_id, room_id)
        assert ok is False

    def test_set_room_parent_rejects_cross_session(self):
        u, sess1, r1 = _make_session_with_room("crosspar1", "Hub A")
        _, sess2, r2 = _make_session_with_room("crosspar2", "Hub B")
        ok = set_room_parent(r1, r2)
        assert ok is False

    def test_set_room_parent_rejects_cycle(self):
        from server.storage import create_room_in_game_session
        u = _make_user("cycle_gm")
        sess = create_game_session("Cycle Test", u.user_id)
        for rid, code in [("cyc_r1", "WHAM-CYC101"), ("cyc_r2", "WHAM-CYC102"), ("cyc_r3", "WHAM-CYC103")]:
            state = RoomState(room_id=rid, gm_user_id=u.user_id)
            create_room_in_game_session(
                session_id=sess.session_id,
                created_by_user_id=u.user_id,
                room_id=rid,
                name=rid,
                state_json=state.model_dump_json(),
                join_code=code,
            )
        # r1 -> r2 -> r3, then try r3 -> r1 (cycle)
        assert set_room_parent("cyc_r2", "cyc_r1")
        assert set_room_parent("cyc_r3", "cyc_r2")
        ok = set_room_parent("cyc_r1", "cyc_r3")
        assert ok is False  # Would create a cycle

    def test_set_room_parent_none_clears_parent(self):
        from server.storage import create_room_in_game_session
        u = _make_user("clearpar_gm")
        sess = create_game_session("Clear Parent Test", u.user_id)
        for rid, code in [("clp_r1", "WHAM-CLP101"), ("clp_r2", "WHAM-CLP102")]:
            state = RoomState(room_id=rid, gm_user_id=u.user_id)
            create_room_in_game_session(
                session_id=sess.session_id,
                created_by_user_id=u.user_id,
                room_id=rid,
                name=rid,
                state_json=state.model_dump_json(),
                join_code=code,
            )
        set_room_parent("clp_r2", "clp_r1")
        assert get_room_meta("clp_r2").parent_room_id == "clp_r1"
        set_room_parent("clp_r2", None)
        assert get_room_meta("clp_r2").parent_room_id is None

    def test_create_room_in_session_inherits_parent(self):
        from server.storage import create_room_in_game_session
        u = _make_user("inherit_gm")
        sess = create_game_session("Inherit Parent Test", u.user_id)
        root_rid = "inh_root"
        child_rid = "inh_child"
        state_root = RoomState(room_id=root_rid, gm_user_id=u.user_id)
        create_room_in_game_session(
            session_id=sess.session_id,
            created_by_user_id=u.user_id,
            room_id=root_rid,
            name="Root",
            state_json=state_root.model_dump_json(),
            join_code="WHAM-INHR01",
        )
        state_child = RoomState(room_id=child_rid, gm_user_id=u.user_id)
        create_room_in_game_session(
            session_id=sess.session_id,
            created_by_user_id=u.user_id,
            room_id=child_rid,
            name="Child",
            state_json=state_child.model_dump_json(),
            join_code="WHAM-INHR02",
            parent_room_id=root_rid,
        )
        meta = get_room_meta(child_rid)
        assert meta.parent_room_id == root_rid
