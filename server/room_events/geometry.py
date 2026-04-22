from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..models import GeometryEdge, GeometryObject, GeometryOpening, GeometrySeamOverride, Point, WireEvent

if TYPE_CHECKING:
    from ..rooms import Room, RoomManager

_VALID_KINDS = {"room", "cave", "wall_path"}
_VALID_OPENING_KINDS = {"door", "window", "arch", "gap"}
_VALID_EDGE_ROLES = {"wall", "open", "boundary"}
_VALID_RENDER_MODES = {"clean_stroke", "rough_stroke", "rock_wall", "hidden"}
_VALID_SEAM_MODES = {"wall", "open"}


def _parse_points(raw: object) -> list[Point]:
    if not isinstance(raw, list):
        return []
    pts = []
    for p in raw:
        if isinstance(p, dict):
            try:
                pts.append(Point(x=float(p.get("x", 0)), y=float(p.get("y", 0))))
            except (TypeError, ValueError):
                pass
    return pts


def _parse_openings(raw: object, edge_count: int) -> list[GeometryOpening]:
    if not isinstance(raw, list):
        return []
    openings = []
    seen_ids: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            op_id = str(item.get("id") or "").strip()
            if not op_id or op_id in seen_ids:
                continue
            # Accept both camelCase (wire) and snake_case (model_dump)
            edge_index = int(item.get("edgeIndex") or item.get("edge_index") or 0)
            if edge_count > 0 and (edge_index < 0 or edge_index >= edge_count):
                continue
            t0 = float(item.get("t0") or 0)
            t1 = float(item.get("t1") or 0)
            if not (0 <= t0 < t1 <= 1):
                continue
            kind = str(item.get("kind") or "door")
            if kind not in _VALID_OPENING_KINDS:
                kind = "door"
            seen_ids.add(op_id)
            openings.append(GeometryOpening(
                id=op_id,
                edge_index=edge_index,
                t0=t0,
                t1=t1,
                kind=kind,
                asset_id=str(item["assetId"]) if item.get("assetId") else None,
                swing=str(item["swing"]) if item.get("swing") else None,
                created_by=str(item.get("createdBy") or item.get("created_by") or ""),
                created_at=float(item.get("createdAt") or item.get("created_at") or 0),
            ))
        except (TypeError, ValueError, KeyError):
            continue
    return openings


def _parse_edges(raw: object, edge_count: int) -> list[GeometryEdge]:
    if not isinstance(raw, list):
        return []
    edges = []
    seen: set[int] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("index") or 0)
            if idx in seen:
                continue
            if edge_count > 0 and (idx < 0 or idx >= edge_count):
                continue
            role = str(item.get("role") or "wall")
            if role not in _VALID_EDGE_ROLES:
                role = "wall"
            # Accept both camelCase (wire) and snake_case (model_dump)
            render_mode = str(item.get("renderMode") or item.get("render_mode") or "clean_stroke")
            if render_mode not in _VALID_RENDER_MODES:
                render_mode = "clean_stroke"
            thickness_raw = item.get("thickness")
            thickness = float(thickness_raw) if thickness_raw is not None else None
            seen.add(idx)
            edges.append(GeometryEdge(
                index=idx,
                role=role,
                render_mode=render_mode,
                thickness=thickness,
            ))
        except (TypeError, ValueError, KeyError):
            continue
    return edges


def apply_geometry_event(
    manager: "RoomManager",
    room_id: str,
    room: "Room",
    event_type: str,
    payload: dict,
    client_id: str,
    user_id: Optional[int],
) -> WireEvent:
    if not manager._is_gm(room, user_id, client_id):
        return WireEvent(type="ERROR", payload={"message": "Not allowed"})

    if event_type == "GEOMETRY_ADD":
        geo_id = str(payload.get("id") or "").strip()
        if not geo_id:
            return WireEvent(type="ERROR", payload={"message": "Missing geometry id"})
        kind = str(payload.get("kind") or "cave").strip()
        if kind not in _VALID_KINDS:
            kind = "cave"
        outer = _parse_points(payload.get("outer"))
        closed = bool(payload.get("closed", True))
        # wall_path can have 2 points; room/cave require 3+
        min_pts = 2 if kind == "wall_path" else 3
        if len(outer) < min_pts:
            return WireEvent(type="ERROR", payload={"message": f"Geometry '{kind}' requires at least {min_pts} outer points"})
        edge_count = len(outer) if closed else max(0, len(outer) - 1)
        manager._push_history(room)
        obj = GeometryObject(
            id=geo_id,
            kind=kind,
            outer=outer,
            closed=closed,
            openings=_parse_openings(payload.get("openings"), edge_count),
            edges=_parse_edges(payload.get("edges"), edge_count),
            style=dict(payload.get("style") or {}),
            created_by=str(payload.get("createdBy") or client_id),
            created_at=float(payload.get("createdAt") or 0),
            updated_at=float(payload.get("updatedAt") or 0),
            locked=bool(payload.get("locked", False)),
            visible=bool(payload.get("visible", True)),
            z_index=int(payload.get("zIndex") or 0),
        )
        room.state.geometry[obj.id] = obj
        manager._mark_dirty(room_id, room)
        return WireEvent(type="GEOMETRY_ADD", payload=_dump(obj))

    if event_type == "GEOMETRY_UPDATE":
        geo_id = str(payload.get("id") or "").strip()
        obj = room.state.geometry.get(geo_id)
        if not obj:
            return WireEvent(type="ERROR", payload={"message": "Geometry not found"})
        manager._push_history(room)
        if "kind" in payload:
            k = str(payload["kind"]).strip()
            if k in _VALID_KINDS:
                obj.kind = k
        if "outer" in payload:
            pts = _parse_points(payload["outer"])
            min_pts = 2 if obj.kind == "wall_path" else 3
            if len(pts) >= min_pts:
                obj.outer = pts
        if "closed" in payload:
            obj.closed = bool(payload["closed"])
        # Recompute edge count after any outer/closed change for opening validation
        edge_count = len(obj.outer) if obj.closed else max(0, len(obj.outer) - 1)
        if "openings" in payload:
            obj.openings = _parse_openings(payload["openings"], edge_count)
        if "edges" in payload:
            obj.edges = _parse_edges(payload["edges"], edge_count)
        if "style" in payload and isinstance(payload["style"], dict):
            obj.style = dict(payload["style"])
        if "locked" in payload:
            obj.locked = bool(payload["locked"])
        if "visible" in payload:
            obj.visible = bool(payload["visible"])
        if "zIndex" in payload:
            obj.z_index = int(payload["zIndex"])
        if "updatedAt" in payload:
            obj.updated_at = float(payload["updatedAt"])
        room.state.geometry[obj.id] = obj
        manager._mark_dirty(room_id, room)
        return WireEvent(type="GEOMETRY_UPDATE", payload=_dump(obj))

    if event_type == "GEOMETRY_DELETE":
        geo_id = str(payload.get("id") or "").strip()
        if geo_id not in room.state.geometry:
            return WireEvent(type="GEOMETRY_DELETE", payload={"id": geo_id})
        manager._push_history(room)
        room.state.geometry.pop(geo_id, None)
        manager._mark_dirty(room_id, room)
        return WireEvent(type="GEOMETRY_DELETE", payload={"id": geo_id})

    if event_type == "GEOMETRY_SEAM_SET":
        seam_key = str(payload.get("seamKey") or payload.get("seam_key") or "").strip()
        override_id = str(payload.get("id") or seam_key).strip()
        mode = str(payload.get("mode") or "wall").strip()
        if not seam_key:
            return WireEvent(type="ERROR", payload={"message": "Missing seam key"})
        if mode not in _VALID_SEAM_MODES:
            return WireEvent(type="ERROR", payload={"message": f"Invalid seam mode: {mode}"})
        manager._push_history(room)
        seam = GeometrySeamOverride(
            id=override_id or seam_key,
            seam_key=seam_key,
            mode=mode,
            created_by=str(payload.get("createdBy") or payload.get("created_by") or client_id),
            updated_at=float(payload.get("updatedAt") or payload.get("updated_at") or 0),
        )
        room.state.geometry_seams[seam.seam_key] = seam
        manager._mark_dirty(room_id, room)
        return WireEvent(type="GEOMETRY_SEAM_SET", payload=_dump_seam(seam))

    return WireEvent(type="ERROR", payload={"message": f"Unhandled geometry event: {event_type}"})


def _dump(obj: GeometryObject) -> dict:
    return {
        "id": obj.id,
        "kind": obj.kind,
        "outer": [{"x": p.x, "y": p.y} for p in obj.outer],
        "closed": obj.closed,
        "openings": [
            {
                "id": op.id,
                "edgeIndex": op.edge_index,
                "t0": op.t0,
                "t1": op.t1,
                "kind": op.kind,
                "assetId": op.asset_id,
                "swing": op.swing,
                "createdBy": op.created_by,
                "createdAt": op.created_at,
            }
            for op in obj.openings
        ],
        "edges": [
            {
                "index": e.index,
                "role": e.role,
                "renderMode": e.render_mode,
                "thickness": e.thickness,
            }
            for e in obj.edges
        ],
        "style": obj.style,
        "createdBy": obj.created_by,
        "createdAt": obj.created_at,
        "updatedAt": obj.updated_at,
        "locked": obj.locked,
        "visible": obj.visible,
        "zIndex": obj.z_index,
    }


def _dump_seam(seam: GeometrySeamOverride) -> dict:
    return {
        "id": seam.id,
        "seamKey": seam.seam_key,
        "mode": seam.mode,
        "createdBy": seam.created_by,
        "updatedAt": seam.updated_at,
    }
