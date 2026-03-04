"""
Unit tests for server/rooms.py

Covers RoomManager.apply_event() dispatch, permission helpers, bounds/limits,
and undo/redo history.  All event tests are async (apply_event is a coroutine).
Permission-helper tests are synchronous.
"""
from __future__ import annotations

import pytest

from server.models import AssetInstance, RoomState, Shape, Stroke, Token, WireEvent, Point
from server.rooms import (
    MAX_CANVAS_COORD,
    MAX_STROKE_POINTS,
    MAX_STROKE_WIDTH,
    Room,
    RoomManager,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_points(n: int) -> list[dict]:
    return [{"x": float(i), "y": float(i)} for i in range(n)]


def make_event(type_: str, **payload) -> WireEvent:
    return WireEvent(type=type_, payload=payload)


async def apply(rm, room, room_id, event_type, client_id="gm", user_id=1, **payload):
    event = make_event(event_type, **payload)
    return await rm.apply_event(room_id, room, event, client_id, user_id)


async def apply_as_player(rm, room, room_id, event_type, **payload):
    """Send an event as a non-GM player (client_id='player', user_id=2)."""
    event = make_event(event_type, **payload)
    return await rm.apply_event(room_id, room, event, "player", 2)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

def test_max_stroke_points_value():
    assert MAX_STROKE_POINTS == 10_000


def test_max_canvas_coord_value():
    assert MAX_CANVAS_COORD == 1_000_000.0


def test_max_stroke_width_value():
    assert MAX_STROKE_WIDTH == 100.0


# ---------------------------------------------------------------------------
# Permission helpers (synchronous)
# ---------------------------------------------------------------------------

class TestPermissionHelpers:
    def setup_method(self):
        self.rm = RoomManager()
        state = RoomState(room_id="p-room", gm_user_id=1, gm_id="gm")
        self.room = Room(state=state)

    def _token(self, owner_id=None, locked=False, creator_id=None):
        return Token(id="t1", x=0, y=0, owner_id=owner_id, locked=locked, creator_id=creator_id)

    def _stroke(self, creator_id=None, locked=False):
        return Stroke(id="s1", points=[Point(x=0, y=0), Point(x=1, y=1)], creator_id=creator_id, locked=locked)

    def _shape(self, creator_id=None, locked=False):
        return Shape(id="sh1", type="rect", x1=0, y1=0, x2=10, y2=10, creator_id=creator_id, locked=locked)

    def _asset(self, creator_id=None, locked=False):
        return AssetInstance(id="a1", image_url="/img.png", x=0, y=0, creator_id=creator_id, locked=locked)

    # can_move_token
    def test_gm_can_move_any_token(self):
        token = self._token(locked=True)
        assert self.rm.can_move_token(self.room, 1, "gm", token) is True

    def test_player_blocked_in_lockdown(self):
        self.room.state.lockdown = True
        token = self._token()
        assert self.rm.can_move_token(self.room, 2, "player", token) is False

    def test_player_blocked_for_locked_token(self):
        token = self._token(locked=True)
        assert self.rm.can_move_token(self.room, 2, "player", token) is False

    def test_player_allowed_in_allow_all_move(self):
        self.room.state.allow_all_move = True
        token = self._token()
        assert self.rm.can_move_token(self.room, 2, "player", token) is True

    def test_player_allowed_to_move_assigned_token(self):
        self.room.state.allow_players_move = True
        token = self._token(owner_id="player")
        assert self.rm.can_move_token(self.room, 2, "player", token) is True

    def test_player_blocked_from_unassigned_token_in_assignment_mode(self):
        self.room.state.allow_players_move = True
        token = self._token(owner_id="other_player")
        assert self.rm.can_move_token(self.room, 2, "player", token) is False

    # can_delete_token
    def test_gm_can_delete_any_token(self):
        token = self._token(locked=True)
        assert self.rm.can_delete_token(self.room, 1, "gm", token) is True

    def test_creator_can_delete_own_token(self):
        token = self._token(creator_id="player")
        assert self.rm.can_delete_token(self.room, 2, "player", token) is True

    def test_non_creator_cannot_delete_token(self):
        token = self._token(creator_id="other")
        assert self.rm.can_delete_token(self.room, 2, "player", token) is False

    def test_locked_token_cannot_be_deleted_by_non_gm(self):
        token = self._token(creator_id="player", locked=True)
        assert self.rm.can_delete_token(self.room, 2, "player", token) is False

    # can_delete_stroke
    def test_gm_can_delete_any_stroke(self):
        assert self.rm.can_delete_stroke(self.room, 1, "gm", self._stroke(locked=True)) is True

    def test_creator_can_delete_own_stroke(self):
        assert self.rm.can_delete_stroke(self.room, 2, "player", self._stroke(creator_id="player")) is True

    def test_non_creator_cannot_delete_stroke(self):
        assert self.rm.can_delete_stroke(self.room, 2, "player", self._stroke(creator_id="other")) is False

    # can_edit_token
    def test_player_cannot_edit_in_lockdown(self):
        self.room.state.lockdown = True
        assert self.rm.can_edit_token(self.room, 2, "player", self._token()) is False

    def test_player_can_edit_in_allow_all_move(self):
        self.room.state.allow_all_move = True
        assert self.rm.can_edit_token(self.room, 2, "player", self._token()) is True


# ---------------------------------------------------------------------------
# TOKEN_CREATE
# ---------------------------------------------------------------------------

class TestTokenCreate:
    async def test_gm_creates_token(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "TOKEN_CREATE",
                             id="t1", x=100, y=200, name="Goblin", color="#ff0000")
        assert result.type == "TOKEN_CREATE"
        assert "t1" in room.state.tokens
        assert room.state.tokens["t1"].name == "Goblin"

    async def test_token_create_increments_version(self, gm_room):
        rm, room, room_id = gm_room
        v0 = room.state.version
        await apply(rm, room, room_id, "TOKEN_CREATE", id="t1", x=0, y=0)
        assert room.state.version > v0

    async def test_token_create_size_scale_clamped_to_max(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "TOKEN_CREATE", id="t1", x=0, y=0, size_scale=99.0)
        assert room.state.tokens["t1"].size_scale <= 4.0

    async def test_token_create_size_scale_clamped_to_min(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "TOKEN_CREATE", id="t1", x=0, y=0, size_scale=0.0)
        assert room.state.tokens["t1"].size_scale >= 0.25

    async def test_token_create_strips_invalid_badges(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "TOKEN_CREATE", id="t1", x=0, y=0,
                    badges=["downed", "flying", "invisible"])
        badges = room.state.tokens["t1"].badges
        assert "downed" in badges
        assert "flying" not in badges
        assert "invisible" not in badges

    async def test_token_create_pack_source_sets_api_url(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "TOKEN_CREATE", id="t1", x=0, y=0,
                    source="pack", asset_id="abc123")
        token = room.state.tokens["t1"]
        assert token.image_url == "/api/assets/file/abc123"

    async def test_token_create_pushes_history(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "TOKEN_CREATE", id="t1", x=0, y=0)
        assert len(room.history) == 1


# ---------------------------------------------------------------------------
# TOKEN_MOVE
# ---------------------------------------------------------------------------

class TestTokenMove:
    async def _seed_token(self, rm, room, room_id, token_id="t1", owner_id=None, locked=False):
        token = Token(id=token_id, x=0, y=0, owner_id=owner_id, locked=locked, creator_id="gm")
        room.state.tokens[token_id] = token
        return token

    async def test_gm_can_move_token(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_token(rm, room, room_id, locked=True)
        result = await apply(rm, room, room_id, "TOKEN_MOVE", id="t1", x=50, y=50, commit=True)
        assert result.type == "TOKEN_MOVE"
        assert room.state.tokens["t1"].x == 50

    async def test_player_cannot_move_token_without_permission(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_token(rm, room, room_id)
        result = await apply_as_player(rm, room, room_id, "TOKEN_MOVE", id="t1", x=50, y=50)
        # Rejected moves return TOKEN_MOVE with rejected=True (not ERROR),
        # so the client can snap back from its optimistic move.
        assert result.type == "TOKEN_MOVE"
        assert result.payload.get("rejected") is True
        assert room.state.tokens["t1"].x != 50

    async def test_player_can_move_in_allow_all_move(self, gm_room):
        rm, room, room_id = gm_room
        room.state.allow_all_move = True
        await self._seed_token(rm, room, room_id)
        result = await apply_as_player(rm, room, room_id, "TOKEN_MOVE", id="t1", x=50, y=50)
        assert result.type == "TOKEN_MOVE"

    async def test_player_blocked_in_lockdown(self, gm_room):
        rm, room, room_id = gm_room
        room.state.lockdown = True
        room.state.allow_all_move = True
        await self._seed_token(rm, room, room_id)
        result = await apply_as_player(rm, room, room_id, "TOKEN_MOVE", id="t1", x=50, y=50)
        assert result.type == "TOKEN_MOVE"
        assert result.payload.get("rejected") is True

    async def test_commit_move_pushes_history(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_token(rm, room, room_id)
        await apply(rm, room, room_id, "TOKEN_MOVE", id="t1", x=10, y=10, commit=True)
        assert len(room.history) >= 1

    async def test_non_commit_move_does_not_push_history(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_token(rm, room, room_id)
        h0 = len(room.history)
        await apply(rm, room, room_id, "TOKEN_MOVE", id="t1", x=10, y=10, commit=False)
        assert len(room.history) == h0


# ---------------------------------------------------------------------------
# TOKEN_DELETE
# ---------------------------------------------------------------------------

class TestTokenDelete:
    async def test_gm_can_delete_any_token(self, gm_room):
        rm, room, room_id = gm_room
        room.state.tokens["t1"] = Token(id="t1", x=0, y=0, locked=True)
        result = await apply(rm, room, room_id, "TOKEN_DELETE", id="t1")
        assert result.type == "TOKEN_DELETE"
        assert "t1" not in room.state.tokens

    async def test_player_cannot_delete_others_token(self, gm_room):
        rm, room, room_id = gm_room
        room.state.tokens["t1"] = Token(id="t1", x=0, y=0, creator_id="other")
        result = await apply_as_player(rm, room, room_id, "TOKEN_DELETE", id="t1")
        assert result.type == "ERROR"
        assert "t1" in room.state.tokens


# ---------------------------------------------------------------------------
# STROKE_ADD — bounds and validation
# ---------------------------------------------------------------------------

class TestStrokeAdd:
    async def test_stroke_add_success(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "STROKE_ADD",
                             id="s1", points=make_points(5), color="#ff0000", width=3.0)
        assert result.type == "STROKE_ADD"
        assert "s1" in room.state.strokes

    async def test_stroke_add_too_few_points_returns_error(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "STROKE_ADD",
                             id="s1", points=make_points(1))
        assert result.type == "ERROR"

    async def test_stroke_add_exceeds_max_points_returns_error(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "STROKE_ADD",
                             id="s1", points=make_points(MAX_STROKE_POINTS + 1))
        assert result.type == "ERROR"
        assert "maximum point count" in result.payload["message"]

    async def test_stroke_add_at_exact_max_points_succeeds(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "STROKE_ADD",
                             id="s1", points=make_points(MAX_STROKE_POINTS))
        assert result.type == "STROKE_ADD"

    async def test_stroke_width_clamped_to_max(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "STROKE_ADD",
                    id="s1", points=make_points(3), width=9999.0)
        assert room.state.strokes["s1"].width == MAX_STROKE_WIDTH

    async def test_stroke_width_clamped_to_min(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "STROKE_ADD",
                    id="s1", points=make_points(3), width=0.0)
        assert room.state.strokes["s1"].width == 0.5

    async def test_stroke_add_invalid_layer_defaults_to_draw(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "STROKE_ADD",
                    id="s1", points=make_points(3), layer="invalid")
        assert room.state.strokes["s1"].layer == "draw"

    async def test_stroke_add_adds_to_draw_order(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "STROKE_ADD", id="s1", points=make_points(3))
        assert "s1" in room.state.draw_order["strokes"]


# ---------------------------------------------------------------------------
# STROKE_DELETE
# ---------------------------------------------------------------------------

class TestStrokeDelete:
    async def _seed_stroke(self, room, stroke_id="s1", creator_id="gm", locked=False):
        room.state.strokes[stroke_id] = Stroke(
            id=stroke_id,
            points=[Point(x=0, y=0), Point(x=1, y=1)],
            creator_id=creator_id,
            locked=locked,
        )
        room.state.draw_order["strokes"].append(stroke_id)

    async def test_gm_can_delete_any_stroke(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_stroke(room, creator_id="player", locked=True)
        result = await apply(rm, room, room_id, "STROKE_DELETE", id="s1")
        assert result.type == "STROKE_DELETE"
        assert "s1" not in room.state.strokes

    async def test_creator_can_delete_own_stroke(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_stroke(room, creator_id="player")
        result = await apply_as_player(rm, room, room_id, "STROKE_DELETE", id="s1")
        assert result.type == "STROKE_DELETE"

    async def test_player_cannot_delete_others_stroke(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_stroke(room, creator_id="other")
        result = await apply_as_player(rm, room, room_id, "STROKE_DELETE", id="s1")
        # Returns STROKE_DELETE but with empty ids list (no-op)
        assert result.payload.get("ids") == []

    async def test_locked_stroke_cannot_be_deleted_by_non_gm(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_stroke(room, creator_id="player", locked=True)
        result = await apply_as_player(rm, room, room_id, "STROKE_DELETE", id="s1")
        assert "s1" in room.state.strokes


# ---------------------------------------------------------------------------
# SHAPE_ADD — coordinate bounds
# ---------------------------------------------------------------------------

class TestShapeAdd:
    async def test_shape_add_success(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "SHAPE_ADD",
                             id="sh1", type="rect", x1=0, y1=0, x2=100, y2=100)
        assert result.type == "SHAPE_ADD"
        assert "sh1" in room.state.shapes

    async def test_shape_add_invalid_type_returns_error(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "SHAPE_ADD",
                             id="sh1", type="triangle", x1=0, y1=0, x2=10, y2=10)
        assert result.type == "ERROR"

    async def test_shape_add_text_without_text_field_returns_error(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "SHAPE_ADD",
                             id="sh1", type="text", x1=0, y1=0, x2=10, y2=10, text="")
        assert result.type == "ERROR"

    async def test_shape_coords_clamped_to_max_canvas_coord(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "SHAPE_ADD",
                    id="sh1", type="rect",
                    x1=5_000_000, y1=-5_000_000, x2=2_000_000, y2=-2_000_000)
        shape = room.state.shapes["sh1"]
        assert shape.x1 == MAX_CANVAS_COORD
        assert shape.y1 == -MAX_CANVAS_COORD
        assert shape.x2 == MAX_CANVAS_COORD
        assert shape.y2 == -MAX_CANVAS_COORD

    async def test_shape_width_clamped(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "SHAPE_ADD",
                    id="sh1", type="rect", x1=0, y1=0, x2=10, y2=10, width=999.0)
        assert room.state.shapes["sh1"].width == MAX_STROKE_WIDTH

    async def test_shape_add_adds_to_draw_order(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "SHAPE_ADD",
                    id="sh1", type="circle", x1=0, y1=0, x2=50, y2=50)
        assert "sh1" in room.state.draw_order["shapes"]


# ---------------------------------------------------------------------------
# SHAPE_UPDATE — coordinate bounds
# ---------------------------------------------------------------------------

class TestShapeUpdate:
    async def _seed_shape(self, room, shape_id="sh1", creator_id="gm", locked=False):
        room.state.shapes[shape_id] = Shape(
            id=shape_id, type="rect", x1=0, y1=0, x2=10, y2=10,
            creator_id=creator_id, locked=locked,
        )
        room.state.draw_order["shapes"].append(shape_id)

    async def test_gm_can_update_shape(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_shape(room)
        result = await apply(rm, room, room_id, "SHAPE_UPDATE",
                             id="sh1", x1=5, y1=5, x2=50, y2=50, commit=True)
        assert result.type == "SHAPE_UPDATE"
        assert room.state.shapes["sh1"].x1 == 5

    async def test_shape_update_coords_clamped(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_shape(room)
        await apply(rm, room, room_id, "SHAPE_UPDATE",
                    id="sh1", x1=9_000_000, commit=True)
        assert room.state.shapes["sh1"].x1 == MAX_CANVAS_COORD

    async def test_player_cannot_update_locked_shape(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_shape(room, creator_id="player", locked=True)
        result = await apply_as_player(rm, room, room_id, "SHAPE_UPDATE",
                                       id="sh1", x1=5, commit=True)
        assert result.type == "ERROR"


# ---------------------------------------------------------------------------
# SHAPE_DELETE
# ---------------------------------------------------------------------------

class TestShapeDelete:
    async def _seed_shape(self, room, creator_id="gm", locked=False):
        room.state.shapes["sh1"] = Shape(
            id="sh1", type="rect", x1=0, y1=0, x2=10, y2=10,
            creator_id=creator_id, locked=locked,
        )
        room.state.draw_order["shapes"].append("sh1")

    async def test_gm_can_delete_shape(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_shape(room, locked=True)
        result = await apply(rm, room, room_id, "SHAPE_DELETE", id="sh1")
        assert result.type == "SHAPE_DELETE"
        assert "sh1" not in room.state.shapes
        assert "sh1" not in room.state.draw_order["shapes"]

    async def test_player_cannot_delete_others_shape(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_shape(room, creator_id="other")
        result = await apply_as_player(rm, room, room_id, "SHAPE_DELETE", id="sh1")
        # SHAPE_DELETE is silently rejected (returns SHAPE_DELETE) but shape is NOT removed.
        assert result.type == "SHAPE_DELETE"
        assert "sh1" in room.state.shapes


# ---------------------------------------------------------------------------
# ASSET_INSTANCE_CREATE
# ---------------------------------------------------------------------------

class TestAssetInstanceCreate:
    async def test_gm_can_place_asset(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "ASSET_INSTANCE_CREATE",
                             id="ai1", image_url="/uploads/test.png", x=0, y=0)
        assert result.type == "ASSET_INSTANCE_CREATE"
        assert "ai1" in room.state.assets

    async def test_lockdown_blocks_asset_placement(self, gm_room):
        rm, room, room_id = gm_room
        room.state.lockdown = True
        result = await apply(rm, room, room_id, "ASSET_INSTANCE_CREATE",
                             id="ai1", image_url="/test.png", x=0, y=0)
        assert result.type == "ERROR"

    async def test_player_cannot_place_asset_by_default(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply_as_player(rm, room, room_id, "ASSET_INSTANCE_CREATE",
                                       id="ai1", image_url="/test.png", x=0, y=0)
        assert result.type == "ERROR"

    async def test_player_can_place_asset_in_allow_all_move(self, gm_room):
        rm, room, room_id = gm_room
        room.state.allow_all_move = True
        result = await apply_as_player(rm, room, room_id, "ASSET_INSTANCE_CREATE",
                                       id="ai1", image_url="/test.png", x=0, y=0)
        assert result.type == "ASSET_INSTANCE_CREATE"

    async def test_pack_source_builds_api_url(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "ASSET_INSTANCE_CREATE",
                    id="ai1", source="pack", asset_id="uuid123", x=0, y=0, image_url="")
        assert room.state.assets["ai1"].image_url == "/api/assets/file/uuid123"

    async def test_missing_image_url_returns_error(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "ASSET_INSTANCE_CREATE",
                             id="ai1", image_url="", x=0, y=0)
        assert result.type == "ERROR"

    async def test_opacity_clamped(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "ASSET_INSTANCE_CREATE",
                    id="ai1", image_url="/t.png", x=0, y=0, opacity=5.0)
        assert room.state.assets["ai1"].opacity == 1.0
        await apply(rm, room, room_id, "ASSET_INSTANCE_CREATE",
                    id="ai2", image_url="/t.png", x=0, y=0, opacity=-1.0)
        assert room.state.assets["ai2"].opacity == 0.05


# ---------------------------------------------------------------------------
# ASSET_INSTANCE_DELETE
# ---------------------------------------------------------------------------

class TestAssetInstanceDelete:
    async def _seed_asset(self, room, asset_id="ai1", creator_id="gm", locked=False):
        room.state.assets[asset_id] = AssetInstance(
            id=asset_id, image_url="/t.png", x=0, y=0, creator_id=creator_id, locked=locked,
        )
        room.state.draw_order["assets"].append(asset_id)

    async def test_gm_can_delete_asset(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_asset(room, locked=True)
        result = await apply(rm, room, room_id, "ASSET_INSTANCE_DELETE", id="ai1")
        assert result.type == "ASSET_INSTANCE_DELETE"
        assert "ai1" not in room.state.assets

    async def test_creator_can_delete_own_asset(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_asset(room, creator_id="player")
        result = await apply_as_player(rm, room, room_id, "ASSET_INSTANCE_DELETE", id="ai1")
        assert result.type == "ASSET_INSTANCE_DELETE"

    async def test_player_cannot_delete_others_asset(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_asset(room, creator_id="other")
        result = await apply_as_player(rm, room, room_id, "ASSET_INSTANCE_DELETE", id="ai1")
        assert result.type == "ERROR"
        assert "ai1" in room.state.assets


# ---------------------------------------------------------------------------
# UNDO / REDO
# ---------------------------------------------------------------------------

class TestUndoRedo:
    async def test_undo_reverts_last_action(self, gm_room):
        rm, room, room_id = gm_room
        # Create a token — this pushes history
        await apply(rm, room, room_id, "TOKEN_CREATE", id="t1", x=0, y=0)
        assert "t1" in room.state.tokens

        result = await apply(rm, room, room_id, "UNDO")
        assert result.type == "STATE_SYNC"
        assert "t1" not in room.state.tokens

    async def test_redo_reapplies_undone_action(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "TOKEN_CREATE", id="t1", x=0, y=0)
        await apply(rm, room, room_id, "UNDO")
        assert "t1" not in room.state.tokens

        result = await apply(rm, room, room_id, "REDO")
        assert result.type == "STATE_SYNC"
        assert "t1" in room.state.tokens

    async def test_undo_empty_history_returns_error(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "UNDO")
        assert result.type == "ERROR"

    async def test_redo_empty_future_returns_error(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "REDO")
        assert result.type == "ERROR"

    async def test_new_action_after_undo_clears_redo_stack(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "TOKEN_CREATE", id="t1", x=0, y=0)
        await apply(rm, room, room_id, "UNDO")
        # Create a different token — should clear redo stack
        await apply(rm, room, room_id, "TOKEN_CREATE", id="t2", x=0, y=0)
        assert len(room.future) == 0

    async def test_non_gm_cannot_undo(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "TOKEN_CREATE", id="t1", x=0, y=0)
        result = await apply_as_player(rm, room, room_id, "UNDO")
        assert result.type == "ERROR"


# ---------------------------------------------------------------------------
# ROOM_SETTINGS
# ---------------------------------------------------------------------------

class TestRoomSettings:
    async def test_gm_can_change_settings(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "ROOM_SETTINGS",
                             lockdown=True, allow_all_move=True)
        assert result.type == "ROOM_SETTINGS"
        assert room.state.lockdown is True
        assert room.state.allow_all_move is True

    async def test_non_gm_cannot_change_settings(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply_as_player(rm, room, room_id, "ROOM_SETTINGS", lockdown=True)
        assert result.type == "ERROR"
        assert room.state.lockdown is False

    async def test_background_mode_solid(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "ROOM_SETTINGS",
                             background_mode="solid", background_color="#000000")
        assert result.type == "ROOM_SETTINGS"
        assert room.state.background_mode == "solid"

    async def test_invalid_background_mode_returns_error(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "ROOM_SETTINGS",
                             background_mode="hologram")
        assert result.type == "ERROR"

    async def test_invalid_terrain_style_returns_error(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "ROOM_SETTINGS",
                             background_mode="terrain", terrain_style="jungle")
        assert result.type == "ERROR"


# ---------------------------------------------------------------------------
# TOKEN_BADGE_TOGGLE
# ---------------------------------------------------------------------------

class TestTokenBadgeToggle:
    async def _seed_token(self, room):
        room.state.tokens["t1"] = Token(id="t1", x=0, y=0)

    async def test_gm_can_add_valid_badge(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_token(room)
        result = await apply(rm, room, room_id, "TOKEN_BADGE_TOGGLE", id="t1", badge="downed")
        assert result.type == "TOKEN_BADGE_TOGGLE"
        assert "downed" in room.state.tokens["t1"].badges

    async def test_toggle_removes_existing_badge(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_token(room)
        room.state.tokens["t1"].badges = ["downed"]
        await apply(rm, room, room_id, "TOKEN_BADGE_TOGGLE", id="t1", badge="downed")
        assert "downed" not in room.state.tokens["t1"].badges

    async def test_invalid_badge_returns_error(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_token(room)
        result = await apply(rm, room, room_id, "TOKEN_BADGE_TOGGLE", id="t1", badge="invisible")
        assert result.type == "ERROR"

    async def test_non_gm_cannot_toggle_badge(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed_token(room)
        result = await apply_as_player(rm, room, room_id, "TOKEN_BADGE_TOGGLE",
                                       id="t1", badge="downed")
        assert result.type == "ERROR"


# ---------------------------------------------------------------------------
# TOKEN_SET_LOCK / STROKE_SET_LOCK / SHAPE_SET_LOCK
# ---------------------------------------------------------------------------

class TestSetLock:
    async def test_gm_can_lock_token(self, gm_room):
        rm, room, room_id = gm_room
        room.state.tokens["t1"] = Token(id="t1", x=0, y=0)
        result = await apply(rm, room, room_id, "TOKEN_SET_LOCK", id="t1", locked=True)
        assert result.type == "TOKEN_SET_LOCK"
        assert room.state.tokens["t1"].locked is True

    async def test_non_gm_cannot_lock_token(self, gm_room):
        rm, room, room_id = gm_room
        room.state.tokens["t1"] = Token(id="t1", x=0, y=0)
        result = await apply_as_player(rm, room, room_id, "TOKEN_SET_LOCK", id="t1", locked=True)
        assert result.type == "ERROR"

    async def test_gm_can_lock_stroke(self, gm_room):
        rm, room, room_id = gm_room
        room.state.strokes["s1"] = Stroke(
            id="s1", points=[Point(x=0, y=0), Point(x=1, y=1)]
        )
        result = await apply(rm, room, room_id, "STROKE_SET_LOCK", id="s1", locked=True)
        assert result.type == "STROKE_SET_LOCK"
        assert room.state.strokes["s1"].locked is True
