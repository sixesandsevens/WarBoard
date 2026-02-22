from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from passlib.context import CryptContext

from .models import RoomState, WireEvent
from .rooms import RoomManager
from .storage import (
    add_membership,
    create_room_record,
    create_session,
    create_snapshot,
    create_user,
    delete_room_record,
    delete_session,
    ensure_room_join_code,
    get_room_meta,
    get_user_by_sid,
    get_user_by_username,
    init_db,
    is_member,
    list_rooms_for_user,
    list_snapshots,
    load_room_state_json,
    load_snapshot_state_json,
    room_id_from_join_code,
    save_room_state_json,
    touch_membership,
    update_user_last_room,
    update_user_password_hash,
    update_room_name,
)

app = FastAPI(title="WarBoard")
BASE_DIR = Path(__file__).resolve().parent.parent
PACKS_DIR = BASE_DIR / "packs"
STATIC_DIR = BASE_DIR / "static"

# Static assets (still routed through FastAPI so middleware can protect them)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR), check_dir=False), name="static")
app.mount("/packs", StaticFiles(directory=str(PACKS_DIR), check_dir=False), name="packs")

rm = RoomManager()
HEARTBEAT_TIMEOUT_SECONDS = 35.0
SESSION_COOKIE = "warboard_sid"
PASSWORD_CONTEXT = CryptContext(schemes=["argon2", "bcrypt"], deprecated="auto")


def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _safe_pack_id(pack_id: str) -> str:
    cleaned = "".join(ch for ch in (pack_id or "") if ch.isalnum() or ch in ("-", "_"))
    return cleaned.strip()


def _load_pack_manifest(pack_id: str) -> dict:
    safe_id = _safe_pack_id(pack_id)
    if not safe_id:
        raise HTTPException(status_code=400, detail="Invalid pack id")
    manifest_path = PACKS_DIR / safe_id / "manifest.json"
    if not manifest_path.exists() or not manifest_path.is_file():
        raise HTTPException(status_code=404, detail="Pack not found")
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load manifest: {e}") from e
    if not isinstance(raw, dict):
        raise HTTPException(status_code=500, detail="Invalid pack manifest structure")
    if not isinstance(raw.get("tokens"), list):
        raw["tokens"] = []
    raw["pack_id"] = str(raw.get("pack_id") or safe_id)
    return raw


def _get_user_from_request(req: Request):
    sid = req.cookies.get(SESSION_COOKIE, "")
    return get_user_by_sid(sid)


def _require_user(req: Request):
    user = _get_user_from_request(req)
    if not user:
        raise HTTPException(status_code=401, detail="Login required")
    return user


def _ws_user(ws: WebSocket):
    sid = ws.cookies.get(SESSION_COOKIE, "")
    return get_user_by_sid(sid)


def _cookie_secure(req: Request) -> bool:
    # Prefer reverse-proxy signal when present (e.g., nginx terminates TLS).
    forwarded_proto = req.headers.get("x-forwarded-proto", "")
    if forwarded_proto:
        proto = forwarded_proto.split(",", 1)[0].strip().lower()
        return proto == "https"
    # Local dev runs on http://127.0.0.1; secure cookies there break ws:// auth.
    return req.url.scheme == "https"


def _room_owner_user_id(room_id: str) -> Optional[int]:
    meta = get_room_meta(room_id)
    return meta.owner_user_id if meta else None


def _is_owner(user_id: int, room_id: str) -> bool:
    return _room_owner_user_id(room_id) == user_id


def _gm_authorized(room_state: RoomState, user_id: Optional[int], gm_key: str | None) -> bool:
    # Owner is always GM.
    if user_id is not None and _is_owner(user_id, room_state.room_id):
        return True
    # Legacy/shared GM key.
    if not room_state.gm_key_hash:
        return False
    if not gm_key:
        return False
    return _hash_key(gm_key) == room_state.gm_key_hash


@app.on_event("startup")
async def _startup() -> None:
    init_db()


# ----------------------------- Auth middleware --------------------------------

@app.middleware("http")
async def auth_gate(request: Request, call_next):
    """
    Require login for almost everything.
    - Allow: /api/auth/*, /static/login.html and its assets, ACME/letsencrypt.
    - For API calls: return 401 JSON.
    - For browser navigations: redirect to /static/login.html?next=...
    """
    path = request.url.path

    # Always allow auth endpoints and ACME.
    if path.startswith("/api/auth/") or path.startswith("/.well-known/acme-challenge/"):
        return await call_next(request)

    # Public board + minimal unauth static for offline single-session mode.
    if path == "/" or path == "/static/test_canvas.html" or path.startswith("/static/login") or path.startswith("/static/auth/") or path.startswith("/packs/"):
        return await call_next(request)

    # Public pack metadata for token library in offline mode.
    if path == "/api/packs" or path.startswith("/api/packs/"):
        return await call_next(request)

    user = _get_user_from_request(request)
    if not user:
        # API callers get JSON 401
        if path.startswith("/api/") or path.startswith("/ws/"):
            return JSONResponse({"detail": "Login required"}, status_code=401)
        nxt = request.url.path
        if request.url.query:
            nxt = f"{nxt}?{request.url.query}"
        return RedirectResponse(url=f"/static/login.html?next={nxt}", status_code=302)

    return await call_next(request)


# ----------------------------- Pages ------------------------------------------

@app.get("/")
def root(req: Request):
    # Offline-first landing: board loads immediately without auth.
    return FileResponse(str(STATIC_DIR / "test_canvas.html"))


@app.get("/app")
def app_dashboard(req: Request):
    _require_user(req)
    return FileResponse(str(STATIC_DIR / "app.html"))


@app.get("/join/{code}")
def join_link(code: str, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    room_id = room_id_from_join_code(code)
    if not room_id:
        raise HTTPException(status_code=404, detail="Invalid join code")
    add_membership(user.user_id, room_id, role="player")
    touch_membership(user.user_id, room_id)
    update_user_last_room(user.user_id, room_id)
    return RedirectResponse(url=f"/static/test_canvas.html?room={room_id}", status_code=302)


# ----------------------------- Auth API ---------------------------------------

@app.get("/api/me")
def me(req: Request):
    user = _require_user(req)
    return {"user_id": user.user_id, "username": user.username, "last_room_id": user.last_room_id}


@app.post("/api/auth/register")
async def register(req: Request):
    body = await req.json()
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    if not username or not password:
        raise HTTPException(status_code=400, detail="username and password required")
    if len(username) < 3 or len(username) > 32:
        raise HTTPException(status_code=400, detail="username must be 3-32 chars")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="password must be >= 8 chars")

    try:
        user = create_user(username=username, password_hash=PASSWORD_CONTEXT.hash(password))
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Failed to create user")

    sid = create_session(user.user_id)
    resp = JSONResponse({"ok": True, "username": user.username})
    resp.set_cookie(
        SESSION_COOKIE,
        sid,
        httponly=True,
        secure=_cookie_secure(req),
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
        path="/",
    )
    return resp


@app.post("/api/auth/login")
async def login(req: Request):
    body = await req.json()
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    u = get_user_by_username(username)
    if not u:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    try:
        verified, replacement_hash = PASSWORD_CONTEXT.verify_and_update(password, u.password_hash)
    except Exception:
        verified, replacement_hash = False, None
    if not verified:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if u.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    if replacement_hash:
        update_user_password_hash(u.user_id, replacement_hash)
    sid = create_session(u.user_id)
    resp = JSONResponse({"ok": True, "username": u.username})
    resp.set_cookie(
        SESSION_COOKIE,
        sid,
        httponly=True,
        secure=_cookie_secure(req),
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
        path="/",
    )
    return resp


@app.post("/api/auth/logout")
def logout(req: Request):
    sid = req.cookies.get(SESSION_COOKIE, "")
    if sid:
        delete_session(sid)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp


# ----------------------------- Packs API --------------------------------------

@app.get("/api/packs")
def list_packs_api(req: Request):
    if not PACKS_DIR.exists():
        return {"packs": []}

    packs = []
    for entry in sorted(PACKS_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir():
            continue
        manifest_path = entry / "manifest.json"
        if not manifest_path.exists():
            continue
        try:
            manifest = _load_pack_manifest(entry.name)
        except HTTPException:
            continue
        packs.append(
            {
                "pack_id": manifest["pack_id"],
                "name": str(manifest.get("name") or manifest["pack_id"]),
                "author": str(manifest.get("author") or ""),
                "license": str(manifest.get("license") or ""),
                "version": str(manifest.get("version") or ""),
                "token_count": len(manifest.get("tokens") or []),
            }
        )
    return {"packs": packs}


@app.get("/api/packs/{pack_id}")
def get_pack_api(pack_id: str, req: Request):
    return _load_pack_manifest(pack_id)


# ----------------------------- Rooms API --------------------------------------

@app.get("/api/my/rooms")
def my_rooms(req: Request):
    user = _require_user(req)
    rooms = list_rooms_for_user(user.user_id)
    # Ensure join_code exists for rooms the user can see (owner might have created earlier)
    for r in rooms:
        if not r.get("join_code"):
            try:
                r["join_code"] = ensure_room_join_code(r["room_id"])
            except Exception:
                r["join_code"] = ""
    return {"rooms": rooms}


@app.post("/api/rooms")
async def create_room(req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    body = await req.json()
    name = str(body.get("name", "")).strip() or "Untitled Room"
    room_id = uuid.uuid4().hex[:8]

    join_code = None
    # allocate unique join_code
    # create_room_record enforces uniqueness via index; try a few times.
    for _ in range(20):
        candidate = ensure_unique_join_code()
        try:
            # Persist immutable GM identity; display gm_id is claimed by active WS session.
            initial = RoomState(room_id=room_id, gm_id=None, gm_user_id=user.user_id)
            create_room_record(room_id=room_id, name=name, state_json=initial.model_dump_json(), owner_user_id=user.user_id, join_code=candidate)
            join_code = candidate
            break
        except Exception:
            # retry candidate
            continue
    if not join_code:
        raise HTTPException(status_code=500, detail="Failed to create room")

    add_membership(user.user_id, room_id, role="owner")
    update_user_last_room(user.user_id, room_id)
    return {"room_id": room_id, "name": name, "join_code": join_code}


def ensure_unique_join_code() -> str:
    # generate_join_code is inside storage; reusing via ensure_room_join_code would need room_id.
    # We'll just generate candidates here and let the unique index be the guard.
    import secrets as _secrets
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    core = "".join(_secrets.choice(alphabet) for _ in range(6))
    return f"WARB-{core}"


@app.post("/api/join")
async def join_room(req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    body = await req.json()
    code = str(body.get("code") or "").strip().upper()
    room_id = room_id_from_join_code(code)
    if not room_id:
        raise HTTPException(status_code=404, detail="Invalid join code")
    add_membership(user.user_id, room_id, role="player")
    touch_membership(user.user_id, room_id)
    update_user_last_room(user.user_id, room_id)
    return {"room_id": room_id}


@app.get("/api/rooms/{room_id}/snapshots")
def snapshots(room_id: str, req: Request):
    user = _require_user(req)
    if not is_member(user.user_id, room_id):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    touch_membership(user.user_id, room_id)
    return {"snapshots": list_snapshots(room_id)}


@app.post("/api/rooms/{room_id}/snapshots")
async def save_snapshot(room_id: str, req: Request, gm_key: str | None = None):
    user = _require_user(req)
    if not is_member(user.user_id, room_id):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    raw = load_room_state_json(room_id)
    if not raw:
        raise HTTPException(status_code=404, detail="Room not found")
    state = RoomState.model_validate_json(raw)
    if not _gm_authorized(state, user.user_id, gm_key):
        raise HTTPException(status_code=403, detail="GM only")
    body = await req.json()
    label = str(body.get("label") or "Snapshot").strip() or "Snapshot"
    snap_id = create_snapshot(room_id, label, raw)
    return {"snapshot_id": snap_id}


@app.get("/api/snapshots/{snapshot_id}")
def get_snapshot(snapshot_id: str, req: Request):
    user = _require_user(req)
    raw = load_snapshot_state_json(snapshot_id)
    if not raw:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    st = RoomState.model_validate_json(raw)
    if not is_member(user.user_id, st.room_id):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    touch_membership(user.user_id, st.room_id)
    return st.model_dump(exclude={"gm_key_hash"})


@app.patch("/api/rooms/{room_id}")
async def rename_room(room_id: str, req: Request, gm_key: str | None = None):
    user = _require_user(req)
    if not is_member(user.user_id, room_id):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    raw = load_room_state_json(room_id)
    if not raw:
        raise HTTPException(status_code=404, detail="Room not found")
    state = RoomState.model_validate_json(raw)
    if not _gm_authorized(state, user.user_id, gm_key):
        raise HTTPException(status_code=403, detail="GM only")
    body = await req.json()
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    ok = update_room_name(room_id, name)
    if not ok:
        raise HTTPException(status_code=404, detail="Room not found")
    return {"ok": True}


@app.delete("/api/rooms/{room_id}")
async def delete_room(room_id: str, req: Request, gm_key: str | None = None):
    user = _require_user(req)
    raw = load_room_state_json(room_id)
    if not raw:
        raise HTTPException(status_code=404, detail="Room not found")
    state = RoomState.model_validate_json(raw)
    if not _gm_authorized(state, user.user_id, gm_key):
        raise HTTPException(status_code=403, detail="GM only")
    delete_room_record(room_id)
    return {"ok": True}


# ----------------------------- WebSocket --------------------------------------

@app.websocket("/ws/{room_id}")
async def ws_room(ws: WebSocket, room_id: str):
    user = _ws_user(ws)
    if not user:
        await ws.close(code=1008)
        return
    if user.user_id is None:
        await ws.close(code=1008)
        return

    # membership guard
    if not is_member(user.user_id, room_id):
        await ws.close(code=1008)
        return

    gm_key = ws.query_params.get("gm_key")
    await ws.accept()

    client_id = user.username  # authoritative identity
    touch_membership(user.user_id, room_id)
    update_user_last_room(user.user_id, room_id)

    room = await rm.connect(room_id, ws)
    rm.attach_client(room, ws, client_id)

    # Owner automatically becomes GM for this room, otherwise fall back to GM key model.
    gm_claimed = False
    if _is_owner(user.user_id, room_id):
        if room.state.gm_user_id != user.user_id or room.state.gm_id != client_id:
            room.state.gm_id = client_id
            room.state.gm_user_id = user.user_id
            gm_claimed = True
    else:
        if room.state.gm_key_hash is None and gm_key:
            room.state.gm_key_hash = _hash_key(gm_key)
            room.state.gm_id = client_id
            room.state.gm_user_id = user.user_id
            gm_claimed = True
        elif room.state.gm_key_hash and gm_key and _hash_key(gm_key) == room.state.gm_key_hash:
            room.state.gm_id = client_id
            room.state.gm_user_id = user.user_id
            gm_claimed = True

    if gm_claimed:
        rm._mark_dirty(room_id, room)

    await ws.send_text(WireEvent(type="STATE_SYNC", payload=room.state.model_dump(exclude={"gm_key_hash"})).model_dump_json())
    await ws.send_text(
        WireEvent(
            type="HELLO",
            payload={
                "client_id": client_id,
                "room_id": room_id,
                "is_gm": room.state.gm_user_id == user.user_id or room.state.gm_id == client_id,
                "gm_key_set": bool(room.state.gm_key_hash),
                "username": user.username,
            },
        ).model_dump_json()
    )
    await ws.send_text(rm.presence_event(room).model_dump_json())

    if gm_claimed:
        await rm.broadcast(room, WireEvent(type="STATE_SYNC", payload=room.state.model_dump(exclude={"gm_key_hash"})))

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

            if event.type in ("TOKEN_MOVE", "ERASE_AT") and not _allow_rate("move" if event.type == "TOKEN_MOVE" else "erase"):
                await ws.send_text(WireEvent(type="ERROR", payload={"message": "rate limited"}).model_dump_json())
                continue

            out = await rm.apply_event(room_id, room, event, client_id, user.user_id)
            if out.type == "ERROR":
                await ws.send_text(out.model_dump_json())
            else:
                await rm.broadcast(room, out)
                # Presence can change (ownership/lock, etc.), so keep it simple.
                if out.type in ("HELLO", "TOKEN_DELETE", "TOKEN_CREATE", "TOKEN_SET_OWNER", "TOKEN_LOCK", "TOKEN_UNLOCK"):
                    await rm.broadcast(room, rm.presence_event(room))

    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    finally:
        try:
            room_after = await rm.disconnect(room_id, ws)
            if room_after:
                await rm.broadcast(room_after, rm.presence_event(room_after))
        except Exception:
            pass
