from __future__ import annotations

import hashlib
import time
from collections import deque
import asyncio
import uuid

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .models import RoomState, WireEvent
from .rooms import RoomManager
from .storage import (
    create_room_record,
    create_snapshot,
    init_db,
    list_rooms,
    list_snapshots,
    load_snapshot_state_json,
    save_room_state_json,
)

app = FastAPI(title="WarBoard")

# Static test client
app.mount("/static", StaticFiles(directory="static"), name="static")

rm = RoomManager()
HEARTBEAT_TIMEOUT_SECONDS = 35.0


def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _check_gm_key_hash(gm_key: str | None, expected_hash: str | None) -> bool:
    if not gm_key or not expected_hash:
        return False
    return _hash_key(gm_key) == expected_hash


def _gm_authorized(room_state: RoomState, gm_key: str | None) -> bool:
    # If no GM key is configured for this room, allow local management.
    if not room_state.gm_key_hash:
        return True
    return _check_gm_key_hash(gm_key, room_state.gm_key_hash)


@app.on_event("startup")
async def _startup() -> None:
    init_db()


@app.get("/")
def root():
    return {"ok": True, "service": "warboard", "hint": "Open /static/test.html"}


@app.get("/api/rooms/{room_id}/export")
async def export_room(room_id: str, gm_key: str | None = None):
    room = await rm.get_or_create_room(room_id)
    if not _gm_authorized(room.state, gm_key):
        raise HTTPException(status_code=403, detail="GM key required")
    return room.state.model_dump(exclude={"gm_key_hash"})


@app.post("/api/rooms/{room_id}/import")
async def import_room(room_id: str, req: Request, gm_key: str | None = None):
    room = await rm.get_or_create_room(room_id)
    if not _gm_authorized(room.state, gm_key):
        raise HTTPException(status_code=403, detail="GM key required")

    body = await req.json()
    try:
        imported = RoomState.model_validate(body)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid room state: {e}") from e

    imported.room_id = room_id
    imported.gm_key_hash = room.state.gm_key_hash
    room.state = imported
    rm._normalize_order(room.state)
    room.history.clear()
    room.future.clear()
    rm._mark_dirty(room_id, room)
    save_room_state_json(room_id, room.state.model_dump_json())
    await rm.broadcast(room, WireEvent(type="STATE_SYNC", payload=room.state.model_dump(exclude={"gm_key_hash"})))
    return {"ok": True}


@app.post("/api/rooms")
async def create_room(req: Request):
    body = await req.json()
    name = str(body.get("name", "")).strip() or "Untitled Room"
    room_id = str(body.get("room_id", "")).strip() or uuid.uuid4().hex[:8]

    initial = RoomState(room_id=room_id)
    try:
        create_room_record(room_id=room_id, name=name, state_json=initial.model_dump_json())
    except ValueError:
        raise HTTPException(status_code=409, detail="Room already exists")

    return {"room_id": room_id, "name": name}


@app.get("/api/rooms")
def rooms_list():
    return {"rooms": list_rooms()}


@app.post("/api/rooms/{room_id}/snapshots")
async def create_room_snapshot(room_id: str, req: Request, gm_key: str | None = None):
    body = await req.json()
    label = str(body.get("label", "")).strip() or f"Checkpoint {int(time.time())}"
    room = await rm.get_or_create_room(room_id)
    if not _gm_authorized(room.state, gm_key):
        raise HTTPException(status_code=403, detail="GM key required")
    snapshot_id = create_snapshot(room_id=room_id, label=label, state_json=room.state.model_dump_json())
    return {"snapshot_id": snapshot_id, "room_id": room_id, "label": label}


@app.get("/api/rooms/{room_id}/snapshots")
def get_room_snapshots(room_id: str):
    return {"snapshots": list_snapshots(room_id)}


@app.post("/api/rooms/{room_id}/restore/{snapshot_id}")
async def restore_snapshot(room_id: str, snapshot_id: str, req: Request, gm_key: str | None = None):
    _ = await req.body()  # keep consistent POST semantics even with empty body
    room = await rm.get_or_create_room(room_id)
    if not _gm_authorized(room.state, gm_key):
        raise HTTPException(status_code=403, detail="GM key required")

    target_raw = load_snapshot_state_json(room_id, snapshot_id)
    if not target_raw:
        raise HTTPException(status_code=404, detail="Snapshot not found")

    # Auto-checkpoint before restore.
    before_id = create_snapshot(
        room_id=room_id,
        label=f"Auto before restore {snapshot_id}",
        state_json=room.state.model_dump_json(),
    )

    restored = RoomState.model_validate_json(target_raw)
    restored.room_id = room_id
    restored.gm_key_hash = room.state.gm_key_hash
    room.state = restored
    rm._normalize_order(room.state)
    room.history.clear()
    room.future.clear()
    rm._mark_dirty(room_id, room)
    save_room_state_json(room_id, room.state.model_dump_json())
    await rm.broadcast(room, WireEvent(type="STATE_SYNC", payload=room.state.model_dump(exclude={"gm_key_hash"})))
    return {"ok": True, "restored_snapshot_id": snapshot_id, "auto_snapshot_id": before_id}


@app.websocket("/ws/{room_id}")
async def ws_room(ws: WebSocket, room_id: str):
    # client_id comes from query string for now (later: auth)
    client_id = ws.query_params.get("client_id") or f"anon-{int(time.time()*1000)}"
    gm_key = ws.query_params.get("gm_key")
    gm_key_hash = _hash_key(gm_key) if gm_key else None
    await ws.accept()

    room = await rm.connect(room_id, ws)
    rm.attach_client(room, ws, client_id)

    # GM claim model:
    # - First claimer sets gm_key by connecting with ?gm_key=...
    # - Later connections can claim GM only if they provide matching gm_key.
    gm_claimed = False
    if room.state.gm_key_hash is None and gm_key_hash:
        room.state.gm_key_hash = gm_key_hash
        room.state.gm_id = client_id
        gm_claimed = True
    elif room.state.gm_key_hash and gm_key_hash == room.state.gm_key_hash:
        room.state.gm_id = client_id
        gm_claimed = True

    if gm_claimed:
        rm._mark_dirty(room_id, room)  # internal bookkeeping for autosave/version bump

    # Send full state to the connecting client
    await ws.send_text(WireEvent(type="STATE_SYNC", payload=room.state.model_dump(exclude={"gm_key_hash"})).model_dump_json())
    await ws.send_text(
        WireEvent(
            type="HELLO",
            payload={
                "client_id": client_id,
                "room_id": room_id,
                "is_gm": room.state.gm_id == client_id,
                "gm_key_set": bool(room.state.gm_key_hash),
            },
        ).model_dump_json()
    )
    await ws.send_text(rm.presence_event(room).model_dump_json())

    if gm_claimed:
        await rm.broadcast(room, WireEvent(type="STATE_SYNC", payload=room.state.model_dump(exclude={"gm_key_hash"})))

    # Notify others of presence (optional)
    await rm.broadcast(room, WireEvent(type="HELLO", payload={"client_id": client_id, "room_id": room_id}))
    await rm.broadcast(room, rm.presence_event(room))

    move_times: deque[float] = deque()
    erase_times: deque[float] = deque()

    def _allow_rate(kind: str) -> bool:
        now = time.time()
        if kind == "move":
            q = move_times
            limit = 60
        else:
            q = erase_times
            limit = 30
        while q and now - q[0] > 1.0:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True

    try:
        while True:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=HEARTBEAT_TIMEOUT_SECONDS)
            event = WireEvent.model_validate_json(raw)

            if event.type == "HEARTBEAT":
                await ws.send_text(WireEvent(type="HEARTBEAT", payload={"ts": time.time()}).model_dump_json())
                continue

            if event.type == "TOKEN_MOVE" and not bool(event.payload.get("commit", False)):
                if not _allow_rate("move"):
                    continue
            if event.type == "ERASE_AT":
                if not _allow_rate("erase"):
                    continue

            # Apply server-side rules and get accepted/adjusted event
            accepted = await rm.apply_event(room_id, room, event, client_id=client_id)

            if accepted.type == "ERROR":
                await ws.send_text(accepted.model_dump_json())
            else:
                # Echo/broadcast what the server accepted.
                await rm.broadcast(room, accepted)

    except asyncio.TimeoutError:
        try:
            await ws.close(code=1001, reason="heartbeat-timeout")
        except Exception:
            pass
        room_after = await rm.disconnect(room_id, ws)
        if room_after:
            await rm.broadcast(room_after, rm.presence_event(room_after))
    except WebSocketDisconnect:
        room_after = await rm.disconnect(room_id, ws)
        if room_after:
            await rm.broadcast(room_after, rm.presence_event(room_after))
    except Exception as e:
        try:
            await ws.send_text(WireEvent(type="ERROR", payload={"message": str(e)}).model_dump_json())
        finally:
            room_after = await rm.disconnect(room_id, ws)
            if room_after:
                await rm.broadcast(room_after, rm.presence_event(room_after))
