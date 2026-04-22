"""
Tests for geometry persistence, openings, and authority.

Covers:
- GEOMETRY_ADD / UPDATE / DELETE round-trips
- Opening persistence and round-trip through server
- wall_path acceptance with 2 points
- Full-state STATE_SYNC includes geometry with openings
- Non-GM rejection
- Old rooms without openings/edges still load safely
"""
from __future__ import annotations

import pytest

from server.models import GeometryObject, GeometryOpening, Point, RoomState, WireEvent
from server.rooms import Room, RoomManager


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_event(type_: str, **payload) -> WireEvent:
    return WireEvent(type=type_, payload=payload)


async def apply(rm, room, room_id, event_type, client_id="gm", user_id=1, **payload):
    event = make_event(event_type, **payload)
    return await rm.apply_event(room_id, room, event, client_id, user_id)


async def apply_as_player(rm, room, room_id, event_type, **payload):
    event = make_event(event_type, **payload)
    return await rm.apply_event(room_id, room, event, "player", 2)


def _rect_outer(n=4):
    """Simple square polygon with n points."""
    pts = [{"x": 0, "y": 0}, {"x": 100, "y": 0}, {"x": 100, "y": 100}, {"x": 0, "y": 100}]
    return pts[:n] if n <= 4 else pts + [{"x": float(i), "y": 50.0} for i in range(4, n)]


def _opening(edge_index=0, t0=0.3, t1=0.7, kind="door", op_id="op1"):
    return {
        "id": op_id,
        "edgeIndex": edge_index,
        "t0": t0,
        "t1": t1,
        "kind": kind,
        "createdBy": "gm",
        "createdAt": 1234567890.0,
    }


def _seam(seam_key="seam|geo1,geo2|0,0|100,0", mode="open", seam_id="seam1"):
    return {
        "id": seam_id,
        "seamKey": seam_key,
        "mode": mode,
        "createdBy": "gm",
        "updatedAt": 1234567890.0,
    }


# ---------------------------------------------------------------------------
# GEOMETRY_ADD — basic
# ---------------------------------------------------------------------------

class TestGeometryAdd:
    async def test_gm_can_add_room_geometry(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "GEOMETRY_ADD",
                             id="geo1", kind="room", outer=_rect_outer(), closed=True)
        assert result.type == "GEOMETRY_ADD"
        assert "geo1" in room.state.geometry
        assert room.state.geometry["geo1"].kind == "room"

    async def test_add_cave_geometry(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "GEOMETRY_ADD",
                             id="geo1", kind="cave", outer=_rect_outer(), closed=True)
        assert result.type == "GEOMETRY_ADD"
        assert room.state.geometry["geo1"].kind == "cave"

    async def test_add_wall_path_two_points(self, gm_room):
        """wall_path must be accepted with 2 outer points."""
        rm, room, room_id = gm_room
        outer = [{"x": 0, "y": 0}, {"x": 100, "y": 0}]
        result = await apply(rm, room, room_id, "GEOMETRY_ADD",
                             id="wp1", kind="wall_path", outer=outer, closed=False)
        assert result.type == "GEOMETRY_ADD"
        assert "wp1" in room.state.geometry

    async def test_add_wall_path_one_point_rejected(self, gm_room):
        rm, room, room_id = gm_room
        outer = [{"x": 0, "y": 0}]
        result = await apply(rm, room, room_id, "GEOMETRY_ADD",
                             id="wp1", kind="wall_path", outer=outer, closed=False)
        assert result.type == "ERROR"
        assert "wp1" not in room.state.geometry

    async def test_add_room_two_points_rejected(self, gm_room):
        rm, room, room_id = gm_room
        outer = [{"x": 0, "y": 0}, {"x": 100, "y": 0}]
        result = await apply(rm, room, room_id, "GEOMETRY_ADD",
                             id="geo1", kind="room", outer=outer, closed=True)
        assert result.type == "ERROR"
        assert "geo1" not in room.state.geometry

    async def test_non_gm_cannot_add_geometry(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply_as_player(rm, room, room_id, "GEOMETRY_ADD",
                                       id="geo1", kind="room", outer=_rect_outer(), closed=True)
        assert result.type == "ERROR"
        assert "geo1" not in room.state.geometry

    async def test_add_pushes_history(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True)
        assert len(room.history) == 1

    async def test_add_missing_id_rejected(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "GEOMETRY_ADD",
                             id="", kind="room", outer=_rect_outer(), closed=True)
        assert result.type == "ERROR"

    async def test_add_payload_includes_id_and_kind(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "GEOMETRY_ADD",
                             id="geo1", kind="cave", outer=_rect_outer(), closed=True)
        assert result.payload["id"] == "geo1"
        assert result.payload["kind"] == "cave"

    async def test_add_style_persisted(self, gm_room):
        rm, room, room_id = gm_room
        style = {"fillMode": "pattern", "edgeThickness": 3}
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True, style=style)
        assert room.state.geometry["geo1"].style["edgeThickness"] == 3

    async def test_add_z_index_persisted(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True, zIndex=-1)
        assert room.state.geometry["geo1"].z_index == -1

    async def test_add_visible_false_persisted(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True, visible=False)
        assert room.state.geometry["geo1"].visible is False

    async def test_add_locked_persisted(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True, locked=True)
        assert room.state.geometry["geo1"].locked is True


# ---------------------------------------------------------------------------
# GEOMETRY_ADD — openings persistence
# ---------------------------------------------------------------------------

class TestGeometryAddOpenings:
    async def test_add_with_opening_persisted(self, gm_room):
        rm, room, room_id = gm_room
        op = _opening(edge_index=0, t0=0.3, t1=0.7, kind="door")
        result = await apply(rm, room, room_id, "GEOMETRY_ADD",
                             id="geo1", kind="room", outer=_rect_outer(), closed=True,
                             openings=[op])
        assert result.type == "GEOMETRY_ADD"
        obj = room.state.geometry["geo1"]
        assert len(obj.openings) == 1
        assert obj.openings[0].edge_index == 0
        assert obj.openings[0].t0 == pytest.approx(0.3)
        assert obj.openings[0].t1 == pytest.approx(0.7)
        assert obj.openings[0].kind == "door"

    async def test_add_dump_includes_openings(self, gm_room):
        rm, room, room_id = gm_room
        op = _opening(edge_index=1, t0=0.2, t1=0.6, kind="gap")
        result = await apply(rm, room, room_id, "GEOMETRY_ADD",
                             id="geo1", kind="room", outer=_rect_outer(), closed=True,
                             openings=[op])
        ops = result.payload.get("openings", [])
        assert len(ops) == 1
        assert ops[0]["edgeIndex"] == 1
        assert ops[0]["kind"] == "gap"

    async def test_add_opening_out_of_range_edge_dropped(self, gm_room):
        """Opening with edgeIndex >= edge count must be silently dropped."""
        rm, room, room_id = gm_room
        op = _opening(edge_index=99, t0=0.3, t1=0.7)
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True,
                    openings=[op])
        obj = room.state.geometry["geo1"]
        assert len(obj.openings) == 0

    async def test_add_opening_invalid_t_range_dropped(self, gm_room):
        rm, room, room_id = gm_room
        op = _opening(edge_index=0, t0=0.8, t1=0.2)  # t0 > t1
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True,
                    openings=[op])
        assert len(room.state.geometry["geo1"].openings) == 0

    async def test_add_multiple_openings_persisted(self, gm_room):
        rm, room, room_id = gm_room
        ops = [
            _opening(edge_index=0, t0=0.2, t1=0.5, op_id="op1"),
            _opening(edge_index=1, t0=0.3, t1=0.6, kind="gap", op_id="op2"),
        ]
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True,
                    openings=ops)
        obj = room.state.geometry["geo1"]
        assert len(obj.openings) == 2


# ---------------------------------------------------------------------------
# GEOMETRY_UPDATE
# ---------------------------------------------------------------------------

class TestGeometryUpdate:
    async def _seed(self, rm, room, room_id, geo_id="geo1"):
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id=geo_id, kind="room", outer=_rect_outer(), closed=True)
        return geo_id

    async def test_update_outer(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed(rm, room, room_id)
        new_outer = [{"x": 0, "y": 0}, {"x": 200, "y": 0}, {"x": 200, "y": 200}, {"x": 0, "y": 200}]
        result = await apply(rm, room, room_id, "GEOMETRY_UPDATE",
                             id="geo1", outer=new_outer)
        assert result.type == "GEOMETRY_UPDATE"
        assert room.state.geometry["geo1"].outer[1].x == 200

    async def test_update_nonexistent_geometry_returns_error(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "GEOMETRY_UPDATE",
                             id="nonexistent", kind="cave")
        assert result.type == "ERROR"

    async def test_non_gm_cannot_update(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed(rm, room, room_id)
        result = await apply_as_player(rm, room, room_id, "GEOMETRY_UPDATE",
                                       id="geo1", kind="cave")
        assert result.type == "ERROR"
        assert room.state.geometry["geo1"].kind == "room"  # unchanged

    async def test_update_z_index(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed(rm, room, room_id)
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", zIndex=-5)
        assert room.state.geometry["geo1"].z_index == -5

    async def test_update_pushes_history(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed(rm, room, room_id)
        h_before = len(room.history)
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", zIndex=2)
        assert len(room.history) == h_before + 1


# ---------------------------------------------------------------------------
# GEOMETRY_UPDATE — opening persistence
# ---------------------------------------------------------------------------

class TestGeometryUpdateOpenings:
    async def _seed(self, rm, room, room_id, geo_id="geo1"):
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id=geo_id, kind="room", outer=_rect_outer(), closed=True)
        return geo_id

    async def test_update_adds_opening(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed(rm, room, room_id)
        op = _opening(edge_index=0, t0=0.3, t1=0.7, kind="door")
        result = await apply(rm, room, room_id, "GEOMETRY_UPDATE",
                             id="geo1", openings=[op])
        assert result.type == "GEOMETRY_UPDATE"
        obj = room.state.geometry["geo1"]
        assert len(obj.openings) == 1
        assert obj.openings[0].kind == "door"

    async def test_update_replaces_openings(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed(rm, room, room_id)
        op1 = _opening(edge_index=0, t0=0.2, t1=0.5, op_id="op1")
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", openings=[op1])
        op2 = _opening(edge_index=1, t0=0.3, t1=0.6, kind="gap", op_id="op2")
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", openings=[op2])
        obj = room.state.geometry["geo1"]
        assert len(obj.openings) == 1
        assert obj.openings[0].id == "op2"

    async def test_update_clears_openings(self, gm_room):
        rm, room, room_id = gm_room
        await self._seed(rm, room, room_id)
        op = _opening()
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", openings=[op])
        assert len(room.state.geometry["geo1"].openings) == 1
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", openings=[])
        assert len(room.state.geometry["geo1"].openings) == 0

    async def test_update_opening_roundtrip_dump(self, gm_room):
        """Opening must appear in the broadcast payload after update."""
        rm, room, room_id = gm_room
        await self._seed(rm, room, room_id)
        op = _opening(edge_index=2, t0=0.1, t1=0.9, kind="arch")
        result = await apply(rm, room, room_id, "GEOMETRY_UPDATE",
                             id="geo1", openings=[op])
        ops = result.payload.get("openings", [])
        assert len(ops) == 1
        assert ops[0]["edgeIndex"] == 2
        assert ops[0]["kind"] == "arch"
        assert ops[0]["t0"] == pytest.approx(0.1)
        assert ops[0]["t1"] == pytest.approx(0.9)

    async def test_opening_survives_unrelated_update(self, gm_room):
        """Opening must not be cleared when updating an unrelated field."""
        rm, room, room_id = gm_room
        await self._seed(rm, room, room_id)
        op = _opening()
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", openings=[op])
        # Now update only zIndex — openings should survive
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", zIndex=3)
        assert len(room.state.geometry["geo1"].openings) == 1


# ---------------------------------------------------------------------------
# GEOMETRY_DELETE
# ---------------------------------------------------------------------------

class TestGeometryDelete:
    async def test_delete_removes_geometry(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True)
        result = await apply(rm, room, room_id, "GEOMETRY_DELETE", id="geo1")
        assert result.type == "GEOMETRY_DELETE"
        assert "geo1" not in room.state.geometry

    async def test_delete_nonexistent_is_idempotent(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "GEOMETRY_DELETE", id="does-not-exist")
        assert result.type == "GEOMETRY_DELETE"

    async def test_non_gm_cannot_delete(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True)
        result = await apply_as_player(rm, room, room_id, "GEOMETRY_DELETE", id="geo1")
        assert result.type == "ERROR"
        assert "geo1" in room.state.geometry

    async def test_delete_pushes_history(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True)
        h_before = len(room.history)
        await apply(rm, room, room_id, "GEOMETRY_DELETE", id="geo1")
        assert len(room.history) == h_before + 1


# ---------------------------------------------------------------------------
# State sync (REQ_STATE_SYNC) — geometry with openings survives reconnect
# ---------------------------------------------------------------------------

class TestGeometryStateSync:
    async def test_state_sync_includes_geometry(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True)
        sync = await apply(rm, room, room_id, "REQ_STATE_SYNC")
        assert sync.type == "STATE_SYNC"
        assert "geo1" in sync.payload["geometry"]

    async def test_state_sync_geometry_has_correct_kind(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="cave", outer=_rect_outer(), closed=True)
        sync = await apply(rm, room, room_id, "REQ_STATE_SYNC")
        geo_data = sync.payload["geometry"]["geo1"]
        assert geo_data["kind"] == "cave"

    async def test_state_sync_preserves_openings(self, gm_room):
        """Opening punched via GEOMETRY_UPDATE must survive a reconnect (STATE_SYNC)."""
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True)
        op = _opening(edge_index=0, t0=0.25, t1=0.75, kind="door", op_id="door1")
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", openings=[op])

        sync = await apply(rm, room, room_id, "REQ_STATE_SYNC")
        geo_data = sync.payload["geometry"]["geo1"]
        # model_dump produces snake_case for nested Pydantic models
        openings = geo_data.get("openings", [])
        assert len(openings) == 1
        # model_dump uses snake_case field names
        op_data = openings[0]
        assert op_data.get("edge_index") == 0 or op_data.get("edgeIndex") == 0
        assert op_data.get("kind") == "door"

    async def test_state_sync_preserves_z_index(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True, zIndex=-3)
        sync = await apply(rm, room, room_id, "REQ_STATE_SYNC")
        geo_data = sync.payload["geometry"]["geo1"]
        assert geo_data.get("z_index") == -3 or geo_data.get("zIndex") == -3

    async def test_state_sync_empty_geometry_on_fresh_room(self, gm_room):
        rm, room, room_id = gm_room
        sync = await apply(rm, room, room_id, "REQ_STATE_SYNC")
        assert sync.payload["geometry"] == {}

    async def test_state_sync_preserves_geometry_seams(self, gm_room):
        rm, room, room_id = gm_room
        seam = _seam()
        result = await apply(rm, room, room_id, "GEOMETRY_SEAM_SET", **seam)
        assert result.type == "GEOMETRY_SEAM_SET"
        sync = await apply(rm, room, room_id, "REQ_STATE_SYNC")
        seam_data = sync.payload["geometry_seams"][seam["seamKey"]]
        assert seam_data.get("mode") == "open"
        assert seam_data.get("seam_key") == seam["seamKey"] or seam_data.get("seamKey") == seam["seamKey"]

    async def test_old_room_without_openings_loads_safely(self):
        """A GeometryObject saved without openings/edges defaults to empty lists."""
        obj = GeometryObject(
            id="legacy",
            kind="room",
            outer=[Point(x=0, y=0), Point(x=100, y=0), Point(x=100, y=100), Point(x=0, y=100)],
            closed=True,
        )
        assert obj.openings == []
        assert obj.edges == []


# ---------------------------------------------------------------------------
# Opening metadata preservation
# ---------------------------------------------------------------------------

class TestOpeningMetadata:
    async def test_opening_created_by_preserved(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True)
        op = _opening()
        op["createdBy"] = "alice"
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", openings=[op])
        assert room.state.geometry["geo1"].openings[0].created_by == "alice"

    async def test_opening_created_at_preserved(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True)
        op = _opening()
        op["createdAt"] = 9_999_999.5
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", openings=[op])
        assert room.state.geometry["geo1"].openings[0].created_at == pytest.approx(9_999_999.5)

    async def test_gap_opening_kind_preserved(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True)
        op = _opening(kind="gap")
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", openings=[op])
        assert room.state.geometry["geo1"].openings[0].kind == "gap"

    async def test_invalid_opening_kind_defaults_to_door(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True)
        op = _opening(kind="portcullis")  # not valid
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="geo1", openings=[op])
        obj = room.state.geometry["geo1"]
        if obj.openings:
            assert obj.openings[0].kind == "door"


# ---------------------------------------------------------------------------
# Seam override persistence
# ---------------------------------------------------------------------------

class TestGeometrySeams:
    async def test_gm_can_set_geometry_seam_override(self, gm_room):
        rm, room, room_id = gm_room
        seam = _seam()
        result = await apply(rm, room, room_id, "GEOMETRY_SEAM_SET", **seam)
        assert result.type == "GEOMETRY_SEAM_SET"
        assert seam["seamKey"] in room.state.geometry_seams
        assert room.state.geometry_seams[seam["seamKey"]].mode == "open"

    async def test_geometry_seam_set_non_gm_rejected(self, gm_room):
        rm, room, room_id = gm_room
        seam = _seam()
        result = await apply_as_player(rm, room, room_id, "GEOMETRY_SEAM_SET", **seam)
        assert result.type == "ERROR"
        assert seam["seamKey"] not in room.state.geometry_seams

    async def test_geometry_seam_can_toggle_back_to_wall(self, gm_room):
        rm, room, room_id = gm_room
        seam = _seam(mode="open")
        await apply(rm, room, room_id, "GEOMETRY_SEAM_SET", **seam)
        result = await apply(rm, room, room_id, "GEOMETRY_SEAM_SET", **_seam(mode="wall"))
        assert result.type == "GEOMETRY_SEAM_SET"
        assert room.state.geometry_seams[seam["seamKey"]].mode == "wall"


# ---------------------------------------------------------------------------
# Edges persistence
# ---------------------------------------------------------------------------

class TestGeometryEdges:
    async def test_add_with_edges_persisted(self, gm_room):
        rm, room, room_id = gm_room
        edges = [{"index": 0, "role": "open", "renderMode": "clean_stroke"}]
        result = await apply(rm, room, room_id, "GEOMETRY_ADD",
                             id="geo1", kind="room", outer=_rect_outer(), closed=True,
                             edges=edges)
        assert result.type == "GEOMETRY_ADD"
        obj = room.state.geometry["geo1"]
        assert len(obj.edges) == 1
        assert obj.edges[0].role == "open"

    async def test_add_dump_includes_edges(self, gm_room):
        rm, room, room_id = gm_room
        edges = [{"index": 1, "role": "boundary", "renderMode": "rough_stroke"}]
        result = await apply(rm, room, room_id, "GEOMETRY_ADD",
                             id="geo1", kind="room", outer=_rect_outer(), closed=True,
                             edges=edges)
        edge_data = result.payload.get("edges", [])
        assert len(edge_data) == 1
        assert edge_data[0]["role"] == "boundary"
        assert edge_data[0]["renderMode"] == "rough_stroke"

    async def test_update_edges(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="geo1", kind="room", outer=_rect_outer(), closed=True)
        edges = [{"index": 0, "role": "open", "renderMode": "hidden"}]
        result = await apply(rm, room, room_id, "GEOMETRY_UPDATE",
                             id="geo1", edges=edges)
        assert result.type == "GEOMETRY_UPDATE"
        assert room.state.geometry["geo1"].edges[0].render_mode == "hidden"


# ---------------------------------------------------------------------------
# Rectangle-drag room convergence — new rectangle rooms are geometry rooms
# ---------------------------------------------------------------------------

def _rectangle_outer(x=0, y=0, w=144, h=144):
    """Four corners in consistent winding order, as createRectangleRoomGeometry emits."""
    return [
        {"x": x,     "y": y},
        {"x": x + w, "y": y},
        {"x": x + w, "y": y + h},
        {"x": x,     "y": y + h},
    ]


class TestRectangleRoomGeometry:
    async def test_rectangle_room_accepted_as_geometry(self, gm_room):
        """A 4-corner closed room polygon is accepted as a geometry room."""
        rm, room, room_id = gm_room
        result = await apply(rm, room, room_id, "GEOMETRY_ADD",
                             id="rect1", kind="room",
                             outer=_rectangle_outer(), closed=True)
        assert result.type == "GEOMETRY_ADD"
        assert "rect1" in room.state.geometry

    async def test_rectangle_room_is_closed(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="rect1", kind="room",
                    outer=_rectangle_outer(), closed=True)
        assert room.state.geometry["rect1"].closed is True

    async def test_rectangle_room_has_four_corners(self, gm_room):
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="rect1", kind="room",
                    outer=_rectangle_outer(x=72, y=72, w=144, h=216), closed=True)
        obj = room.state.geometry["rect1"]
        assert len(obj.outer) == 4

    async def test_rectangle_room_corner_values_preserved(self, gm_room):
        rm, room, room_id = gm_room
        outer = _rectangle_outer(x=72, y=144, w=288, h=144)
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="rect1", kind="room", outer=outer, closed=True)
        pts = room.state.geometry["rect1"].outer
        xs = {p.x for p in pts}
        ys = {p.y for p in pts}
        assert xs == {72.0, 72.0 + 288.0}
        assert ys == {144.0, 144.0 + 144.0}

    async def test_rectangle_room_survives_state_sync(self, gm_room):
        """Rectangle-created geometry room must round-trip through STATE_SYNC."""
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="rect1", kind="room",
                    outer=_rectangle_outer(), closed=True)
        sync = await apply(rm, room, room_id, "REQ_STATE_SYNC")
        assert "rect1" in sync.payload["geometry"]
        assert sync.payload["geometry"]["rect1"]["kind"] == "room"

    async def test_rectangle_room_accepts_door_opening(self, gm_room):
        """A door opening can be punched into a rectangle-created geometry room."""
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="rect1", kind="room",
                    outer=_rectangle_outer(), closed=True)
        op = _opening(edge_index=0, t0=0.3, t1=0.7, kind="door", op_id="door1")
        result = await apply(rm, room, room_id, "GEOMETRY_UPDATE",
                             id="rect1", openings=[op])
        assert result.type == "GEOMETRY_UPDATE"
        assert len(room.state.geometry["rect1"].openings) == 1
        assert room.state.geometry["rect1"].openings[0].kind == "door"

    async def test_rectangle_room_door_survives_reconnect(self, gm_room):
        """Door on a rectangle room must persist through STATE_SYNC (reconnect path)."""
        rm, room, room_id = gm_room
        await apply(rm, room, room_id, "GEOMETRY_ADD",
                    id="rect1", kind="room",
                    outer=_rectangle_outer(), closed=True)
        op = _opening(edge_index=2, t0=0.2, t1=0.8, kind="door", op_id="door2")
        await apply(rm, room, room_id, "GEOMETRY_UPDATE", id="rect1", openings=[op])
        sync = await apply(rm, room, room_id, "REQ_STATE_SYNC")
        geo_data = sync.payload["geometry"]["rect1"]
        openings = geo_data.get("openings", [])
        assert len(openings) == 1
        op_data = openings[0]
        assert op_data.get("edge_index") == 2 or op_data.get("edgeIndex") == 2

    async def test_rectangle_room_non_gm_rejected(self, gm_room):
        rm, room, room_id = gm_room
        result = await apply_as_player(rm, room, room_id, "GEOMETRY_ADD",
                                       id="rect1", kind="room",
                                       outer=_rectangle_outer(), closed=True)
        assert result.type == "ERROR"
        assert "rect1" not in room.state.geometry

    async def test_legacy_interiors_still_load_after_convergence(self):
        """Old rooms with interior data load safely — geometry convergence is forward-only."""
        from server.models import InteriorRoom
        interior = InteriorRoom(id="old1", x=0, y=0, w=144, h=144, style="wood")
        state = RoomState(room_id="legacy-room", interiors={"old1": interior})
        assert "old1" in state.interiors
        assert state.geometry == {}
