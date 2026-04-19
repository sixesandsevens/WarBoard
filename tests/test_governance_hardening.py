"""
Governance hardening tests — high-risk invariants in the WarBoard backend.

Covers:
  A. Platform authority: owner/admin protections, must_change_password
  B. Session governance: role changes, GM transfer, remove-member cascade
  C. Room governance: member management, transfer ownership, session-backed guards
  D. Pack visibility: owned, entitled, session-shared, revocation
  E. Official pack: create/archive/delete lifecycle, cleanup
"""
from __future__ import annotations

import pytest
import httpx

from server.storage import (
    add_game_session_member,
    add_membership,
    assign_room_to_game_session,
    count_session_gms,
    create_game_session,
    create_room_record,
    create_session,
    create_user,
    delete_game_session_shared_pack_rows,
    get_game_session_role,
    get_room_member_role,
    grant_private_pack_access,
    is_game_session_member,
    is_member,
    list_game_session_members,
    list_game_session_shared_packs,
    list_private_packs_for_user,
    list_room_members,
    remove_game_session_member,
    set_game_session_member_role,
    set_game_session_shared_pack,
    update_user_must_change_password,
    update_user_role,
    utc_now_iso,
    PrivatePackAssetRow,
    PrivatePackRow,
)
from server.models import RoomState
from sqlmodel import Session
from server import storage as _storage_module


# ---------------------------------------------------------------------------
# Shared seed helpers
# ---------------------------------------------------------------------------

def _seed_room(owner_id: int, room_id: str, join_code: str) -> str:
    state = RoomState(room_id=room_id, gm_user_id=owner_id)
    create_room_record(
        room_id=room_id,
        name=room_id,
        state_json=state.model_dump_json(),
        owner_user_id=owner_id,
        join_code=join_code,
    )
    add_membership(owner_id, room_id, "owner")
    return room_id


def _seed_pack(owner_user_id: int, slug: str) -> int:
    with Session(_storage_module.engine) as s:
        pack = PrivatePackRow(
            slug=slug,
            name=slug,
            owner_user_id=owner_user_id,
            created_at=utc_now_iso(),
            root_rel=f"{slug}/manifest.json",
            thumb_rel=f"{slug}/thumb.webp",
        )
        s.add(pack)
        s.commit()
        s.refresh(pack)
        pack_id = int(pack.pack_id)
        s.add(
            PrivatePackAssetRow(
                asset_id=f"{slug}-tok",
                pack_id=pack_id,
                name="Token",
                folder_path="tokens",
                tags_json="[]",
                mime="image/png",
                width=64,
                height=64,
                url_original=f"/packs/{slug}/t.png",
                url_thumb=f"/packs/{slug}/th.webp",
                created_at=utc_now_iso(),
            )
        )
        s.commit()
        return pack_id


# ---------------------------------------------------------------------------
# A. Platform Authority Invariants
# ---------------------------------------------------------------------------

class TestPlatformAuthority:
    """Owner/admin protections and must_change_password restrictions."""

    async def test_only_owner_can_change_site_roles(self, app):
        """A plain admin (non-owner) cannot change a user's site role."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as owner_c, httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as admin_c:
            # First user is owner
            await owner_c.post("/api/auth/register", json={"username": "pa_owner", "password": "password123"})
            # Second user becomes admin via storage
            u2 = create_user("pa_admin", "hash")
            update_user_role(u2.user_id, "admin")
            admin_sid = create_session(u2.user_id)

            # Third user is a plain user
            u3 = create_user("pa_target", "hash")

            r = await admin_c.post(
                f"/api/admin/users/{u3.user_id}/role",
                json={"role": "admin"},
                cookies={"warhamster_sid": admin_sid},
            )
            assert r.status_code == 403, f"admin should not be able to change roles, got {r.status_code}"

    async def test_admin_cannot_disable_owner_account(self, app):
        """A non-owner admin cannot disable/delete an owner account."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # Register owner (first user)
            await client.post("/api/auth/register", json={"username": "ao_owner", "password": "password123"})
            owner = create_user.__module__ and _storage_module.get_user_by_username("ao_owner")

            # Create admin
            u_admin = create_user("ao_admin", "hash")
            update_user_role(u_admin.user_id, "admin")
            admin_sid = create_session(u_admin.user_id)

            r = await client.post(
                f"/api/admin/users/{owner.user_id}/disable",
                json={"reason": "test"},
                cookies={"warhamster_sid": admin_sid},
            )
            # admin cannot act on owner accounts
            assert r.status_code in (403, 404, 405)

    async def test_last_active_owner_cannot_be_demoted(self, app):
        """Cannot demote the sole active owner to a lower role."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            r = await client.post("/api/auth/register", json={"username": "lo_owner", "password": "password123"})
            assert r.status_code == 200
            owner = _storage_module.get_user_by_username("lo_owner")

            r2 = await client.post(
                f"/api/admin/users/{owner.user_id}/role",
                json={"role": "admin"},
            )
            assert r2.status_code == 403, "cannot demote the last owner"

    async def test_last_active_owner_cannot_be_soft_deleted(self, app):
        """Cannot soft-delete the sole active owner."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post("/api/auth/register", json={"username": "lo_del_owner", "password": "password123"})
            owner = _storage_module.get_user_by_username("lo_del_owner")

            r = await client.request(
                "DELETE",
                f"/api/admin/users/{owner.user_id}",
                content=b'{"reason":"test"}',
                headers={"Content-Type": "application/json"},
            )
            assert r.status_code == 403, "cannot delete the last owner"

    async def test_must_change_password_blocks_general_api(self, app):
        """User with must_change_password=True cannot reach protected routes."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post("/api/auth/register", json={"username": "mcp_user", "password": "password123"})
            u = _storage_module.get_user_by_username("mcp_user")
            update_user_must_change_password(u.user_id, True)

            r = await client.get("/api/rooms")
            assert r.status_code in (400, 403, 404, 307), f"must_change_password should block /api/rooms, got {r.status_code}"

            # The specific blocked route
            r2 = await client.get("/api/my/rooms")
            assert r2.status_code == 403

    async def test_must_change_password_allows_change_password(self, app):
        """User with must_change_password=True can still reach the change-password route."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post("/api/auth/register", json={"username": "mcp_ok", "password": "password123"})
            u = _storage_module.get_user_by_username("mcp_ok")
            update_user_must_change_password(u.user_id, True)

            # /api/account/change-password is allowed
            r = await client.post(
                "/api/account/change-password",
                json={"current_password": "password123", "new_password": "newpassword123"},
            )
            # 200 = success, 400 = wrong payload, both mean it wasn't blocked at the middleware level
            assert r.status_code != 403, "must_change_password should not block the change-password route"

    async def test_unauthenticated_admin_route_returns_401(self, http_client):
        """Admin routes require authentication."""
        r = await http_client.get("/api/admin/users")
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# B. Session Governance Invariants
# ---------------------------------------------------------------------------

class TestSessionGovernance:
    """Session role changes, GM transfer, remove-member, and cascade logic."""

    def _setup_session_with_gm_and_player(self):
        gm = create_user("sg_gm_" + utc_now_iso()[-6:], "hash")
        player = create_user("sg_pl_" + utc_now_iso()[-6:], "hash")
        sess = create_game_session("Test Session", gm.user_id)
        add_game_session_member(sess.session_id, player.user_id, "player")
        return gm, player, sess

    def test_cannot_remove_only_gm_storage(self):
        """Storage: count_session_gms stays >= 1 — removing the only GM returns False if we guard it."""
        gm = create_user("sg_onlygm", "hash")
        sess = create_game_session("Only GM Session", gm.user_id)
        # Direct removal without the GM count guard — storage allows it (no guard at storage layer)
        # The guard lives in the API layer; test the count helper is accurate
        assert count_session_gms(sess.session_id) == 1

    async def test_cannot_remove_only_gm_via_api(self, app):
        """API: removing the only GM from a session is rejected."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post("/api/auth/register", json={"username": "rm_gm_owner", "password": "password123"})
            gm = _storage_module.get_user_by_username("rm_gm_owner")
            room_r = await client.post("/api/rooms", json={"name": "GM Room"})
            room_id = room_r.json()["room_id"]
            sess_r = await client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "GM Session"})
            session_id = sess_r.json()["id"]

            r = await client.post(
                f"/api/sessions/{session_id}/members/{gm.user_id}/remove",
                json={},
            )
            assert r.status_code == 400, "removing the only GM must be rejected"

    async def test_cannot_demote_only_gm_via_role_route(self, app):
        """API: setting the only GM's role to co_gm via /role is rejected."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post("/api/auth/register", json={"username": "dg_owner", "password": "password123"})
            gm = _storage_module.get_user_by_username("dg_owner")
            room_r = await client.post("/api/rooms", json={"name": "Demote Room"})
            room_id = room_r.json()["room_id"]
            sess_r = await client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Demote Session"})
            session_id = sess_r.json()["id"]

            r = await client.post(
                f"/api/sessions/{session_id}/members/{gm.user_id}/role",
                json={"role": "co_gm"},
            )
            assert r.status_code == 400, "cannot demote the only GM via role route"

    async def test_gm_can_promote_player_to_co_gm(self, app):
        """API: GM can promote a player to co_gm."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post("/api/auth/register", json={"username": "promo_gm", "password": "password123"})
            player = create_user("promo_player", "hash")
            room_r = await client.post("/api/rooms", json={"name": "Promo Room"})
            room_id = room_r.json()["room_id"]
            join_code = room_r.json()["join_code"]
            sess_r = await client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Promo Session"})
            session_id = sess_r.json()["id"]
            add_game_session_member(session_id, player.user_id, "player")

            r = await client.post(
                f"/api/sessions/{session_id}/members/{player.user_id}/role",
                json={"role": "co_gm"},
            )
            assert r.status_code == 200
            assert get_game_session_role(session_id, player.user_id) == "co_gm"

    async def test_gm_cannot_demote_another_gm_via_role_route(self, app):
        """API: A non-admin GM cannot demote another GM via /role (must use transfer-gm)."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # Seed the owner first so the HTTP-registered user is NOT the owner
            _ = create_user("gmr_site_owner", "hash")

            await client.post("/api/auth/register", json={"username": "gmr_gm1", "password": "password123"})
            gm1 = _storage_module.get_user_by_username("gmr_gm1")
            gm2 = create_user("gmr_gm2", "hash")

            room_r = await client.post("/api/rooms", json={"name": "Two GM Room"})
            room_id = room_r.json()["room_id"]
            sess_r = await client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Two GM Session"})
            session_id = sess_r.json()["id"]
            # Make gm2 a second GM in the session
            add_game_session_member(session_id, gm2.user_id, "gm")
            assert count_session_gms(session_id) == 2

            # gm1 (non-admin) tries to demote gm2 via /role — must fail
            r = await client.post(
                f"/api/sessions/{session_id}/members/{gm2.user_id}/role",
                json={"role": "co_gm"},
            )
            assert r.status_code == 400, "non-admin GM cannot demote another GM via /role; must use transfer-gm"

    async def test_transfer_gm_promotes_target_and_demotes_actor(self, app):
        """API: transfer-gm elevates the target to GM and demotes the previous GM to co_gm."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # Seed owner so the HTTP-registered user is a plain user (non-admin GM)
            _ = create_user("tgm_site_owner", "hash")
            await client.post("/api/auth/register", json={"username": "tgm_gm", "password": "password123"})
            gm = _storage_module.get_user_by_username("tgm_gm")
            target = create_user("tgm_target", "hash")

            room_r = await client.post("/api/rooms", json={"name": "Transfer Room"})
            room_id = room_r.json()["room_id"]
            sess_r = await client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "Transfer Session"})
            session_id = sess_r.json()["id"]
            add_game_session_member(session_id, target.user_id, "player")

            r = await client.post(
                f"/api/sessions/{session_id}/transfer-gm",
                json={"user_id": target.user_id},
            )
            assert r.status_code == 200
            assert get_game_session_role(session_id, target.user_id) == "gm"
            assert get_game_session_role(session_id, gm.user_id) == "co_gm"

    def test_remove_member_cascades_to_session_rooms(self):
        """Storage: removing a session member also removes them from session-backed rooms."""
        gm = create_user("casc_gm", "hash")
        player = create_user("casc_player", "hash")
        sess = create_game_session("Cascade Session", gm.user_id)
        add_game_session_member(sess.session_id, player.user_id, "player")

        room_id = "casc_room_1"
        _seed_room(gm.user_id, room_id, "WHAM-CASC01")
        assign_room_to_game_session(room_id, sess.session_id, display_name="Map A")
        add_membership(player.user_id, room_id, "player")

        assert is_member(player.user_id, room_id) is True
        assert remove_game_session_member(sess.session_id, player.user_id) is True
        assert is_game_session_member(sess.session_id, player.user_id) is False
        assert is_member(player.user_id, room_id) is False, (
            "Removing a session member must cascade-remove them from session-backed rooms"
        )


# ---------------------------------------------------------------------------
# C. Room Governance Invariants
# ---------------------------------------------------------------------------

class TestRoomGovernance:
    """Room member listing, removal, ownership transfer, session-backed guard."""

    async def test_owner_can_list_room_members(self, app):
        """Room owner can list members."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post("/api/auth/register", json={"username": "rg_owner", "password": "password123"})
            r = await client.post("/api/rooms", json={"name": "Member Room"})
            room_id = r.json()["room_id"]

            r2 = await client.get(f"/api/rooms/{room_id}/members")
            assert r2.status_code == 200
            data = r2.json()
            assert "members" in data
            assert any(m["username"] == "rg_owner" for m in data["members"])

    async def test_non_owner_cannot_list_members(self, app):
        """Non-owner player cannot list room members."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as owner_c, httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as player_c:
            await owner_c.post("/api/auth/register", json={"username": "nm_owner", "password": "password123"})
            r = await owner_c.post("/api/rooms", json={"name": "Restricted Room"})
            room_id = r.json()["room_id"]
            join_code = r.json()["join_code"]

            await player_c.post("/api/auth/register", json={"username": "nm_player", "password": "password123"})
            await player_c.post("/api/join", json={"code": join_code})

            r2 = await player_c.get(f"/api/rooms/{room_id}/members")
            assert r2.status_code == 403

    async def test_cannot_remove_room_owner_via_member_remove(self, app):
        """Attempting to remove the room owner via the remove-member route returns 400."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post("/api/auth/register", json={"username": "rmo_owner", "password": "password123"})
            owner = _storage_module.get_user_by_username("rmo_owner")
            r = await client.post("/api/rooms", json={"name": "Owner Protection Room"})
            room_id = r.json()["room_id"]

            r2 = await client.post(f"/api/rooms/{room_id}/members/{owner.user_id}/remove", json={})
            assert r2.status_code == 400, "removing the room owner must be rejected"

    async def test_session_backed_room_blocks_member_remove(self, app):
        """Session-backed room member removal is blocked at the room governance level."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post("/api/auth/register", json={"username": "sbr_owner", "password": "password123"})
            player = create_user("sbr_player", "hash")
            r = await client.post("/api/rooms", json={"name": "Session Backed Room"})
            room_id = r.json()["room_id"]
            sess_r = await client.post(f"/api/rooms/{room_id}/attach-session", json={"name": "SBR Session"})
            session_id = sess_r.json()["id"]
            add_game_session_member(session_id, player.user_id, "player")
            add_membership(player.user_id, room_id, "player")

            r2 = await client.post(f"/api/rooms/{room_id}/members/{player.user_id}/remove", json={})
            assert r2.status_code == 400, (
                "session-backed room membership must be managed by the session, not the room"
            )

    async def test_transfer_room_ownership_succeeds(self, app):
        """Owner can transfer room ownership to another member."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post("/api/auth/register", json={"username": "tro_owner", "password": "password123"})
            new_owner = create_user("tro_new", "hash")
            r = await client.post("/api/rooms", json={"name": "Transfer Room"})
            room_id = r.json()["room_id"]
            add_membership(new_owner.user_id, room_id, "player")

            r2 = await client.post(
                f"/api/rooms/{room_id}/transfer-ownership",
                json={"user_id": new_owner.user_id},
            )
            assert r2.status_code == 200
            role = get_room_member_role(new_owner.user_id, room_id)
            assert role == "owner"

    async def test_transfer_room_ownership_to_non_member_fails(self, app):
        """Transfer ownership to a user not in the room is rejected."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post("/api/auth/register", json={"username": "tron_owner", "password": "password123"})
            outsider = create_user("tron_outsider", "hash")
            r = await client.post("/api/rooms", json={"name": "Non-member Transfer Room"})
            room_id = r.json()["room_id"]

            r2 = await client.post(
                f"/api/rooms/{room_id}/transfer-ownership",
                json={"user_id": outsider.user_id},
            )
            assert r2.status_code == 400


# ---------------------------------------------------------------------------
# D. Pack Visibility / Sharing Invariants
# ---------------------------------------------------------------------------

class TestPackVisibility:
    """Pack access control: owned, direct entitlement, session-shared, revocation."""

    def test_owned_pack_visible_to_owner(self):
        owner = create_user("pv_owner", "hash")
        pack_id = _seed_pack(owner.user_id, "pv-owned")
        packs = list_private_packs_for_user(owner.user_id)
        assert any(int(p["pack_id"]) == pack_id for p in packs), "owned pack must be visible to its owner"

    def test_owned_pack_not_visible_to_stranger(self):
        owner = create_user("pv_ownr2", "hash")
        stranger = create_user("pv_strgr", "hash")
        pack_id = _seed_pack(owner.user_id, "pv-owned2")
        packs = list_private_packs_for_user(stranger.user_id)
        assert not any(int(p["pack_id"]) == pack_id for p in packs), "owned pack must NOT be visible to strangers"

    def test_directly_entitled_pack_visible_to_entitled_user(self):
        owner = create_user("pv_ent_owner", "hash")
        entitled = create_user("pv_ent_user", "hash")
        pack_id = _seed_pack(owner.user_id, "pv-entitled")
        grant_private_pack_access(pack_id, entitled.user_id)
        packs = list_private_packs_for_user(entitled.user_id)
        assert any(int(p["pack_id"]) == pack_id for p in packs), "entitled user must see directly-granted pack"

    def test_session_shared_pack_visible_to_session_member(self):
        gm = create_user("pv_sgm", "hash")
        player = create_user("pv_spl", "hash")
        sess = create_game_session("Pack Share Session", gm.user_id)
        add_game_session_member(sess.session_id, player.user_id, "player")
        pack_id = _seed_pack(gm.user_id, "pv-session")
        set_game_session_shared_pack(sess.session_id, pack_id, True, shared_by_user_id=gm.user_id)

        packs = list_private_packs_for_user(player.user_id, session_id=sess.session_id)
        assert any(int(p["pack_id"]) == pack_id for p in packs), (
            "session-shared pack must be visible to session members"
        )

    def test_session_shared_pack_not_visible_after_revoke(self):
        gm = create_user("pv_rgm", "hash")
        player = create_user("pv_rpl", "hash")
        sess = create_game_session("Pack Revoke Session", gm.user_id)
        add_game_session_member(sess.session_id, player.user_id, "player")
        pack_id = _seed_pack(gm.user_id, "pv-revoke")

        set_game_session_shared_pack(sess.session_id, pack_id, True, shared_by_user_id=gm.user_id)
        assert any(int(p["pack_id"]) == pack_id for p in list_private_packs_for_user(player.user_id, session_id=sess.session_id))

        set_game_session_shared_pack(sess.session_id, pack_id, False, shared_by_user_id=gm.user_id)
        packs_after = list_private_packs_for_user(player.user_id, session_id=sess.session_id)
        assert not any(int(p["pack_id"]) == pack_id for p in packs_after), (
            "revoked session-shared pack must not be visible to session members"
        )
        assert list_game_session_shared_packs(sess.session_id) == []

    def test_removed_session_member_loses_session_shared_pack_access(self):
        gm = create_user("pv_cm_gm", "hash")
        player = create_user("pv_cm_pl", "hash")
        sess = create_game_session("Member Cascade Pack Session", gm.user_id)
        add_game_session_member(sess.session_id, player.user_id, "player")
        pack_id = _seed_pack(gm.user_id, "pv-cascade")
        set_game_session_shared_pack(sess.session_id, pack_id, True, shared_by_user_id=gm.user_id)

        assert any(int(p["pack_id"]) == pack_id for p in list_private_packs_for_user(player.user_id, session_id=sess.session_id))

        # Remove from session — player is no longer a session member
        remove_game_session_member(sess.session_id, player.user_id)
        assert not is_game_session_member(sess.session_id, player.user_id)

        # Pack is still shared at session level but player cannot see it (not a member)
        packs_after = list_private_packs_for_user(player.user_id, session_id=sess.session_id)
        assert not any(int(p["pack_id"]) == pack_id for p in packs_after), (
            "removed session member must not see session-shared packs"
        )

    def test_delete_pack_cleans_up_session_shared_rows(self):
        gm = create_user("pv_del_gm", "hash")
        sess = create_game_session("Delete Pack Session", gm.user_id)
        pack_id = _seed_pack(gm.user_id, "pv-delete")
        set_game_session_shared_pack(sess.session_id, pack_id, True, shared_by_user_id=gm.user_id)
        assert len(list_game_session_shared_packs(sess.session_id)) == 1

        cleaned = delete_game_session_shared_pack_rows(pack_id)
        assert cleaned == 1, "delete_game_session_shared_pack_rows must clean up shared rows"
        assert list_game_session_shared_packs(sess.session_id) == []


# ---------------------------------------------------------------------------
# E. Official Pack Lifecycle
# ---------------------------------------------------------------------------

class TestOfficialPack:
    """Create, archive, and delete official packs via the admin API."""

    async def test_non_admin_cannot_create_official_pack(self, app):
        """Regular user cannot create an official pack."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            _ = create_user("op_first_owner", "hash")  # seed owner so HTTP user is not owner
            await client.post("/api/auth/register", json={"username": "op_regular", "password": "password123"})
            r = await client.post("/api/admin/official-packs", json={"name": "Hack Pack", "slug": "hack"})
            assert r.status_code == 403

    async def test_unauthenticated_cannot_create_official_pack(self, http_client):
        """Unauthenticated request to create official pack returns 401."""
        r = await http_client.post("/api/admin/official-packs", json={"name": "Anon Pack", "slug": "anon"})
        assert r.status_code == 401

    async def test_admin_can_create_and_archive_official_pack(self, app):
        """Owner can create an official pack and then archive it."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # First registered user = owner
            await client.post("/api/auth/register", json={"username": "op_admin_crt", "password": "password123"})
            r = await client.post(
                "/api/admin/official-packs",
                json={"name": "Official Dungeon", "slug": "official-dungeon"},
            )
            assert r.status_code == 200, f"create failed: {r.text}"
            pack_id = r.json()["pack"]["pack_id"]

            r2 = await client.post(f"/api/admin/official-packs/{pack_id}/archive", json={})
            assert r2.status_code == 200

            # Admin list still shows the pack (admin needs visibility) but archived=True
            r3 = await client.get("/api/admin/official-packs")
            pack_row = next((p for p in r3.json().get("packs", []) if p["pack_id"] == pack_id), None)
            assert pack_row is not None, "admin should still see archived packs in the admin list"
            assert pack_row["archived"] is True, "archived pack must have archived=True"

            # Public /api/packs should NOT include the archived official pack
            r4 = await client.get("/api/packs")
            public_pack_ids = [p.get("pack_id") for p in r4.json() if isinstance(r4.json(), list)]
            assert pack_id not in public_pack_ids, "archived pack must not appear in public /api/packs"

    async def test_admin_can_delete_official_pack_and_clears_shared_rows(self, app):
        """Owner can delete an official pack; shared-session rows are cleaned up."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # First registered user = owner
            await client.post("/api/auth/register", json={"username": "op_admin_del", "password": "password123"})
            r = await client.post(
                "/api/admin/official-packs",
                json={"name": "Doomed Pack", "slug": "doomed-pack"},
            )
            assert r.status_code == 200, f"create failed: {r.text}"
            pack_id = r.json()["pack"]["pack_id"]

            # Seed a fake session-shared row for this pack
            gm = create_user("op_del_gm", "hash")
            sess = create_game_session("Del Pack Session", gm.user_id)
            set_game_session_shared_pack(sess.session_id, pack_id, True, shared_by_user_id=gm.user_id)
            assert len(list_game_session_shared_packs(sess.session_id)) == 1

            r2 = await client.request(
                "DELETE",
                f"/api/admin/official-packs/{pack_id}",
                content=b'{"name":"Doomed Pack"}',
                headers={"Content-Type": "application/json"},
            )
            assert r2.status_code == 200

            # Session-shared rows for this pack must be gone
            assert list_game_session_shared_packs(sess.session_id) == [], (
                "deleting an official pack must clean up session-shared rows"
            )

    async def test_non_admin_cannot_archive_official_pack(self, app):
        """Regular user cannot archive an official pack."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # Seed owner, then create pack as owner via storage
            owner_u = create_user("op_arch_first", "hash")
            owner_sid = create_session(owner_u.user_id)

            r = await client.post(
                "/api/admin/official-packs",
                json={"name": "To Archive", "slug": "to-archive"},
                cookies={"warhamster_sid": owner_sid},
            )
            assert r.status_code == 200, f"pack create failed: {r.text}"
            pack_id = r.json()["pack"]["pack_id"]

            # Register a plain user (non-admin) and try to archive
            await client.post("/api/auth/register", json={"username": "op_arch_user", "password": "password123"})
            r2 = await client.post(f"/api/admin/official-packs/{pack_id}/archive", json={})
            assert r2.status_code == 403, "regular user must not be able to archive official packs"
