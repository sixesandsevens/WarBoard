from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..models import Point, Shape, Stroke, WireEvent

if TYPE_CHECKING:
    from ..rooms import Room, RoomManager


ERASER_HIT_RADIUS_DEFAULT = 18.0
MAX_CANVAS_COORD = 1_000_000.0
MAX_STROKE_POINTS = 10_000
MAX_STROKE_WIDTH = 100.0


def apply_stroke_event(
    manager: "RoomManager",
    room_id: str,
    room: "Room",
    event_type: str,
    payload: dict,
    client_id: str,
    user_id: Optional[int],
) -> WireEvent:
    if event_type == "STROKE_ADD":
        sid = payload.get("id")
        pts = payload.get("points", [])
        color = payload.get("color", "#ffffff")
        width = max(0.5, min(MAX_STROKE_WIDTH, float(payload.get("width", 3.0))))
        layer = payload.get("layer", "draw")
        if layer not in ("map", "draw", "notes"):
            layer = "draw"
        layer_band = payload.get("layer_band", "below_assets")
        if layer_band not in ("below_assets", "above_assets"):
            layer_band = "below_assets"

        if not sid or not isinstance(pts, list) or len(pts) < 2:
            return WireEvent(type="ERROR", payload={"message": "Invalid stroke"})
        if len(pts) > MAX_STROKE_POINTS:
            return WireEvent(type="ERROR", payload={"message": f"Stroke exceeds maximum point count ({MAX_STROKE_POINTS})"})

        stroke = Stroke(
            id=sid,
            points=[Point(x=float(pp["x"]), y=float(pp["y"])) for pp in pts if "x" in pp and "y" in pp],
            color=color,
            width=width,
            creator_id=client_id,
            locked=bool(payload.get("locked", False)),
            layer=layer,
            layer_band=layer_band,
        )

        if len(stroke.points) < 2:
            return WireEvent(type="ERROR", payload={"message": "Stroke too short"})

        manager._push_history(room)
        room.state.strokes[sid] = stroke
        manager._append_order(room.state, "strokes", sid)
        manager._mark_dirty(room_id, room)
        return WireEvent(
            type="STROKE_ADD",
            payload={
                "id": sid,
                "points": [{"x": pt.x, "y": pt.y} for pt in stroke.points],
                "color": stroke.color,
                "width": stroke.width,
                "locked": stroke.locked,
                "layer": stroke.layer,
                "layer_band": stroke.layer_band,
            },
        )

    if event_type == "STROKE_DELETE":
        ids = payload.get("ids")
        if not isinstance(ids, list):
            sid = payload.get("id")
            ids = [sid] if sid else []
        existing = []
        for sid in ids:
            stroke = room.state.strokes.get(sid)
            if not stroke:
                continue
            if manager.can_delete_stroke(room, user_id, client_id, stroke):
                existing.append(sid)
        if not existing:
            return WireEvent(type="STROKE_DELETE", payload={"ids": []})
        manager._push_history(room)
        for sid in existing:
            room.state.strokes.pop(sid, None)
            manager._remove_order(room.state, "strokes", sid)
        manager._mark_dirty(room_id, room)
        return WireEvent(type="STROKE_DELETE", payload={"ids": existing})

    if event_type == "STROKE_SET_LOCK":
        if not manager._is_gm(room, user_id, client_id):
            return WireEvent(type="ERROR", payload={"message": "Only GM can lock strokes"})
        sid = payload.get("id")
        stroke = room.state.strokes.get(sid)
        if not stroke:
            return WireEvent(type="ERROR", payload={"message": "Unknown stroke", "id": sid})
        manager._push_history(room)
        stroke.locked = bool(payload.get("locked", False))
        room.state.strokes[sid] = stroke
        manager._mark_dirty(room_id, room)
        return WireEvent(type="STROKE_SET_LOCK", payload={"id": sid, "locked": stroke.locked})

    if event_type == "ERASE_AT":
        if room.state.lockdown:
            return WireEvent(type="ERROR", payload={"message": "Lockdown is enabled"})
        is_gm = manager._is_gm(room, user_id, client_id)

        cx = float(payload.get("x", 0))
        cy = float(payload.get("y", 0))
        radius = float(payload.get("r", ERASER_HIT_RADIUS_DEFAULT))
        erase_shapes = bool(payload.get("erase_shapes", False))
        erase_tokens = bool(payload.get("erase_tokens", True))

        stroke_ids = []
        for sid, stroke in list(room.state.strokes.items()):
            if stroke.locked and not is_gm:
                continue
            if not is_gm and stroke.creator_id != client_id:
                continue
            if manager._stroke_hits_circle(stroke, cx, cy, radius):
                stroke_ids.append(sid)

        shape_ids = []
        if erase_shapes:
            for sid, shape in list(room.state.shapes.items()):
                if shape.locked and not is_gm:
                    continue
                if not is_gm and shape.creator_id != client_id:
                    continue
                if manager._shape_hits_circle(shape, cx, cy, radius):
                    shape_ids.append(sid)

        token_ids = []
        if erase_tokens:
            for token_id, token in list(room.state.tokens.items()):
                if token.locked and not is_gm:
                    continue
                if not is_gm and token.creator_id != client_id:
                    continue
                if manager._token_hits_circle(token, cx, cy, radius):
                    token_ids.append(token_id)

        if not stroke_ids and not shape_ids and not token_ids:
            return WireEvent(type="ERASE_AT", payload={"stroke_ids": [], "shape_ids": [], "token_ids": []})

        manager._push_history(room)
        for sid in stroke_ids:
            room.state.strokes.pop(sid, None)
            manager._remove_order(room.state, "strokes", sid)
        for sid in shape_ids:
            room.state.shapes.pop(sid, None)
            manager._remove_order(room.state, "shapes", sid)
        for token_id in token_ids:
            room.state.tokens.pop(token_id, None)

        manager._mark_dirty(room_id, room)
        return WireEvent(type="ERASE_AT", payload={"stroke_ids": stroke_ids, "shape_ids": shape_ids, "token_ids": token_ids})

    return WireEvent(type="ERROR", payload={"message": f"Unhandled stroke event: {event_type}"})


def apply_shape_event(
    manager: "RoomManager",
    room_id: str,
    room: "Room",
    event_type: str,
    payload: dict,
    client_id: str,
    user_id: Optional[int],
) -> WireEvent:
    if event_type == "SHAPE_ADD":
        sid = payload.get("id")
        shape_type = payload.get("type")
        if shape_type not in ("rect", "circle", "line", "text"):
            return WireEvent(type="ERROR", payload={"message": "Invalid shape type"})
        layer = payload.get("layer", "draw")
        if layer not in ("map", "draw", "notes"):
            layer = "draw"
        layer_band = payload.get("layer_band", "below_assets")
        if layer_band not in ("below_assets", "above_assets"):
            layer_band = "below_assets"
        text_val = None
        font_size = float(payload.get("font_size", 20.0))
        if shape_type == "text":
            text_val = str(payload.get("text", "")).strip()
            if not text_val:
                return WireEvent(type="ERROR", payload={"message": "Text is required"})
            font_size = max(8.0, min(96.0, font_size))

        def _clamp_coord(value: float) -> float:
            return max(-MAX_CANVAS_COORD, min(MAX_CANVAS_COORD, value))

        shape = Shape(
            id=sid,
            type=shape_type,
            x1=_clamp_coord(float(payload.get("x1", 0))),
            y1=_clamp_coord(float(payload.get("y1", 0))),
            x2=_clamp_coord(float(payload.get("x2", 0))),
            y2=_clamp_coord(float(payload.get("y2", 0))),
            color=payload.get("color", "#ffffff"),
            width=max(0.5, min(MAX_STROKE_WIDTH, float(payload.get("width", 3.0)))),
            creator_id=client_id,
            text=text_val,
            font_size=font_size,
            fill=bool(payload.get("fill", False)),
            locked=bool(payload.get("locked", False)),
            layer=layer,
            layer_band=layer_band,
        )
        manager._push_history(room)
        room.state.shapes[sid] = shape
        manager._append_order(room.state, "shapes", sid)
        manager._mark_dirty(room_id, room)
        return WireEvent(type="SHAPE_ADD", payload=shape.model_dump())

    if event_type == "SHAPE_UPDATE":
        sid = payload.get("id")
        shape = room.state.shapes.get(sid)
        if not shape:
            return WireEvent(type="ERROR", payload={"message": "Unknown shape", "id": sid})
        if not manager.can_edit_shape(room, user_id, client_id, shape):
            return WireEvent(type="ERROR", payload={"message": "Not allowed to edit shape", "id": sid})

        if bool(payload.get("commit", False)):
            manager._push_history(room)

        changed = False
        for key in ("x1", "y1", "x2", "y2"):
            if key in payload:
                val = max(-MAX_CANVAS_COORD, min(MAX_CANVAS_COORD, float(payload.get(key))))
                setattr(shape, key, val)
                changed = True

        if "color" in payload:
            shape.color = str(payload.get("color") or shape.color)
            changed = True

        if shape.type == "text":
            if "text" in payload:
                txt = str(payload.get("text") or "").strip()
                if not txt:
                    return WireEvent(type="ERROR", payload={"message": "Text is required"})
                shape.text = txt
                changed = True
            if "font_size" in payload:
                try:
                    font_size = float(payload.get("font_size"))
                except (TypeError, ValueError):
                    return WireEvent(type="ERROR", payload={"message": "Invalid font size"})
                shape.font_size = max(8.0, min(96.0, font_size))
                changed = True

        if changed:
            room.state.shapes[sid] = shape
            manager._mark_dirty(room_id, room)
        response_payload = shape.model_dump()
        if "commit" in payload:
            response_payload["commit"] = bool(payload.get("commit", False))
        if "move_seq" in payload:
            response_payload["move_seq"] = payload.get("move_seq")
        if "move_client" in payload:
            response_payload["move_client"] = payload.get("move_client")
        return WireEvent(type="SHAPE_UPDATE", payload=response_payload)

    if event_type == "SHAPE_SET_LOCK":
        if not manager._is_gm(room, user_id, client_id):
            return WireEvent(type="ERROR", payload={"message": "Only GM can lock shapes"})
        sid = payload.get("id")
        shape = room.state.shapes.get(sid)
        if not shape:
            return WireEvent(type="ERROR", payload={"message": "Unknown shape", "id": sid})
        manager._push_history(room)
        shape.locked = bool(payload.get("locked", False))
        room.state.shapes[sid] = shape
        manager._mark_dirty(room_id, room)
        return WireEvent(type="SHAPE_SET_LOCK", payload={"id": sid, "locked": shape.locked})

    if event_type == "SHAPE_DELETE":
        sid = payload.get("id")
        shape = room.state.shapes.get(sid)
        if shape and manager.can_delete_shape(room, user_id, client_id, shape):
            manager._push_history(room)
            room.state.shapes.pop(sid, None)
            manager._remove_order(room.state, "shapes", sid)
            manager._mark_dirty(room_id, room)
        return WireEvent(type="SHAPE_DELETE", payload={"id": sid})

    return WireEvent(type="ERROR", payload={"message": f"Unhandled shape event: {event_type}"})
