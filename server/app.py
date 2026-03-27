from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import importlib.util
import io
import json
import logging
import os
import posixpath
import secrets
import tempfile
import time
import uuid
import zipfile
from collections import deque
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
try:
    from PIL import Image, ImageOps, UnidentifiedImageError  # type: ignore
except Exception:  # pragma: no cover - fallback keeps app booting without Pillow
    Image = None  # type: ignore
    ImageOps = None  # type: ignore
    UnidentifiedImageError = Exception  # type: ignore
try:
    from passlib.context import CryptContext  # type: ignore
except Exception:  # pragma: no cover - fallback used in minimal/offline envs
    CryptContext = None  # type: ignore

from .models import RoomState, WireEvent
from .rooms import RoomManager
from .storage import (
    add_game_session_member,
    add_membership,
    assign_room_to_game_session,
    can_manage_game_session,
    create_asset_record,
    create_game_session,
    create_room_in_game_session,
    create_room_record,
    create_session,
    create_snapshot,
    create_user,
    delete_asset_record,
    delete_room_record,
    delete_session,
    ensure_room_join_code,
    ensure_room_membership_for_user,
    get_game_session,
    get_game_session_role,
    get_room_meta,
    get_pack_asset_by_asset_id,
    get_private_pack_by_id,
    get_asset_by_id,
    get_asset_for_user,
    get_user_by_sid,
    get_user_by_username,
    init_db,
    is_member,
    list_all_assets_for_user,
    list_game_session_members,
    list_game_session_rooms,
    list_game_session_shared_packs,
    list_game_sessions_for_user,
    list_private_packs_for_user,
    list_room_member_user_ids,
    list_assets_for_user,
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
    user_has_pack_access,
    set_game_session_shared_pack,
)

app = FastAPI(title="WarHamster")
logger = logging.getLogger("warhamster")
BASE_DIR = Path(__file__).resolve().parent.parent
PACKS_DIR = BASE_DIR / "packs"
STATIC_DIR = BASE_DIR / "static"
UPLOADS_DIR = BASE_DIR / "data" / "uploads"
PRIVATE_PACKS_DIR = Path(
    os.getenv("PRIVATE_PACKS_DIR", str(Path(os.getenv("DATA_DIR", "./data")) / "private_packs"))
)
BG_UPLOADS_DIR = UPLOADS_DIR / "backgrounds"
ASSET_UPLOADS_DIR = UPLOADS_DIR / "assets"
MAX_BACKGROUND_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_ASSET_UPLOAD_BYTES = 20 * 1024 * 1024


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        val = int(raw)
    except ValueError:
        return default
    return val if val > 0 else default


# ZIP import limits are intentionally configurable for large GM asset packs.
MAX_ZIP_UPLOAD_BYTES = _env_int("MAX_ZIP_UPLOAD_BYTES", 512 * 1024 * 1024)
MAX_ZIP_ASSET_FILES = _env_int("MAX_ZIP_ASSET_FILES", 2000)
MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = _env_int("MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES", 1024 * 1024 * 1024)
ASSET_THUMB_MAX_DIM = 256
MAX_ASSET_IMAGE_DIM = 12_000
MAX_ASSET_IMAGE_PIXELS = 36_000_000
ALLOWED_BACKGROUND_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
CONTENT_TYPE_TO_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
EXT_TO_IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
MIME_TO_IMAGE_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

# Static assets (still routed through FastAPI so middleware can protect them)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR), check_dir=False), name="static")
app.mount("/packs", StaticFiles(directory=str(PACKS_DIR), check_dir=False), name="packs")
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR), check_dir=False), name="uploads")

rm = RoomManager()
HEARTBEAT_TIMEOUT_SECONDS = 35.0
SESSION_COOKIE = "warhamster_sid"
LEGACY_SESSION_COOKIE = "warboard_sid"


class _PBKDF2Context:
    """Compatibility fallback when passlib isn't available."""

    _ITERATIONS = 260_000

    def hash(self, password: str) -> str:
        salt = secrets.token_bytes(16)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, self._ITERATIONS)
        return "pbkdf2_sha256${}${}${}".format(
            self._ITERATIONS,
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(dk).decode("ascii"),
        )

    def verify_and_update(self, password: str, stored_hash: str) -> tuple[bool, None]:
        try:
            algo, iter_s, salt_b64, digest_b64 = stored_hash.split("$", 3)
            if algo != "pbkdf2_sha256":
                return False, None
            iterations = int(iter_s)
            salt = base64.b64decode(salt_b64.encode("ascii"))
            expected = base64.b64decode(digest_b64.encode("ascii"))
        except (ValueError, IndexError):
            return False, None
        got = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(got, expected), None


PASSWORD_CONTEXT = (
    CryptContext(schemes=["argon2", "bcrypt"], deprecated="auto")
    if CryptContext is not None
    else _PBKDF2Context()
)
LOG = logging.getLogger("warhamster.ws")
HAS_MULTIPART = importlib.util.find_spec("multipart") is not None


def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _safe_pack_id(pack_id: str) -> str:
    cleaned = "".join(ch for ch in (pack_id or "") if ch.isalnum() or ch in ("-", "_"))
    return cleaned.strip()


def _safe_room_id(room_id: str) -> str:
    cleaned = "".join(ch for ch in (room_id or "") if ch.isalnum() or ch in ("-", "_"))
    return cleaned.strip()


def _safe_zip_member_path(raw_name: str) -> tuple[str, str]:
    # Normalize zip paths and reject traversal/absolute paths.
    name = str(raw_name or "").replace("\\", "/").strip()
    norm = posixpath.normpath(name)
    if not norm or norm in (".", "/") or norm.startswith("/") or norm.startswith("../") or "/../" in norm:
        return "", ""
    folder = posixpath.dirname(norm)
    if folder in (".", "/"):
        folder = ""
    base = posixpath.basename(norm)
    return folder.strip("/"), base


def _background_upload_ext(upload: UploadFile) -> str:
    ctype = str(upload.content_type or "").strip().lower()
    if ctype in CONTENT_TYPE_TO_EXT:
        return CONTENT_TYPE_TO_EXT[ctype]
    ext = Path(str(upload.filename or "")).suffix.lower()
    if ext in ALLOWED_BACKGROUND_EXTS:
        return ext
    raise HTTPException(status_code=400, detail="Unsupported image type")


def _image_mime_from_ext(ext: str) -> str:
    return EXT_TO_IMAGE_MIME.get(str(ext or "").lower(), "application/octet-stream")


def _asset_image_meta_and_thumb(data: bytes) -> tuple[int, int, bytes, str]:
    if Image is None:
        raise HTTPException(status_code=503, detail="Asset upload unavailable: Pillow not installed")
    try:
        with Image.open(io.BytesIO(data)) as img:
            if ImageOps is not None:
                img = ImageOps.exif_transpose(img)
            width, height = img.size
            thumb = img.copy()
    except UnidentifiedImageError:
        raise HTTPException(status_code=400, detail="Unsupported or corrupt image file")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read image: {e}") from e

    if width < 1 or height < 1:
        raise HTTPException(status_code=400, detail="Invalid image dimensions")
    if width > MAX_ASSET_IMAGE_DIM or height > MAX_ASSET_IMAGE_DIM:
        raise HTTPException(
            status_code=400,
            detail=f"Image dimensions exceed limit ({MAX_ASSET_IMAGE_DIM}px max side)",
        )
    if int(width) * int(height) > MAX_ASSET_IMAGE_PIXELS:
        raise HTTPException(
            status_code=400,
            detail=f"Image pixel count exceeds limit ({MAX_ASSET_IMAGE_PIXELS} max)",
        )

    if thumb.mode not in ("RGB", "RGBA"):
        thumb = thumb.convert("RGBA")
    if hasattr(Image, "Resampling"):
        resample = Image.Resampling.LANCZOS
    else:  # Pillow < 9.1
        resample = Image.LANCZOS
    thumb.thumbnail((ASSET_THUMB_MAX_DIM, ASSET_THUMB_MAX_DIM), resample)

    has_alpha = "A" in thumb.getbands()
    if has_alpha:
        out = io.BytesIO()
        thumb.save(out, format="PNG", optimize=True)
        return int(width), int(height), out.getvalue(), ".png"

    try:
        out = io.BytesIO()
        thumb.save(out, format="WEBP", quality=82, method=6)
        return int(width), int(height), out.getvalue(), ".webp"
    except Exception:
        out = io.BytesIO()
        thumb.save(out, format="PNG", optimize=True)
        return int(width), int(height), out.getvalue(), ".png"


def _load_pack_manifest(pack_id: str) -> dict:
    safe_id = _safe_pack_id(pack_id)
    if not safe_id:
        raise HTTPException(status_code=400, detail="Invalid pack id")
    manifest_path = PACKS_DIR / safe_id / "manifest.json"
    if not manifest_path.exists() or not manifest_path.is_file():
        raise HTTPException(status_code=404, detail="Pack not found")
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=500, detail=f"Failed to load manifest: {e}") from e
    if not isinstance(raw, dict):
        raise HTTPException(status_code=500, detail="Invalid pack manifest structure")
    if not isinstance(raw.get("tokens"), list):
        raw["tokens"] = []
    raw["pack_id"] = str(raw.get("pack_id") or safe_id)
    return raw


def _pack_manifest_path(pack_id: str) -> Path:
    safe_id = _safe_pack_id(pack_id)
    if not safe_id:
        raise HTTPException(status_code=400, detail="Invalid pack id")
    manifest_path = PACKS_DIR / safe_id / "manifest.json"
    if not manifest_path.exists() or not manifest_path.is_file():
        raise HTTPException(status_code=404, detail="Pack not found")
    return manifest_path


def _pack_cache_headers() -> dict:
    return {"Cache-Control": "public, max-age=3600"}


def _manifest_etag(manifest_path: Path) -> str:
    st = manifest_path.stat()
    return f'W/"{int(st.st_mtime)}-{st.st_size}"'


def _get_user_from_request(req: Request):
    sid = req.cookies.get(SESSION_COOKIE, "") or req.cookies.get(LEGACY_SESSION_COOKIE, "")
    return get_user_by_sid(sid)


def _require_user(req: Request):
    user = _get_user_from_request(req)
    if not user:
        raise HTTPException(status_code=401, detail="Login required")
    return user


def _ws_user(ws: WebSocket):
    sid = ws.cookies.get(SESSION_COOKIE, "") or ws.cookies.get(LEGACY_SESSION_COOKIE, "")
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


def _room_online_count(room_id: str) -> int:
    room = rm._rooms.get(room_id)
    return len(room.client_counts) if room else 0


def _build_session_summary(session_id: str, user_id: int, current_room_id: str | None = None) -> dict | None:
    session = get_game_session(session_id)
    if not session:
        return None
    role = get_game_session_role(session_id, user_id)
    if not role:
        return None
    rooms = []
    for room in list_game_session_rooms(session_id):
        room_id = str(room.get("room_id") or "")
        rooms.append(
            {
                "id": room_id,
                "display_name": room.get("display_name") or room.get("name") or room_id,
                "join_code": room.get("join_code") or "",
                "room_order": room.get("room_order"),
                "occupancy_count": _room_online_count(room_id),
                "is_current": room_id == current_room_id,
            }
        )
    members = []
    for member in list_game_session_members(session_id):
        members.append(
            {
                "user_id": member.get("user_id"),
                "username": member.get("username"),
                "role": member.get("role"),
            }
        )
    current_room = None
    if current_room_id:
        meta = get_room_meta(current_room_id)
        if meta:
            current_room = {"id": current_room_id, "display_name": meta.display_name or meta.name}
    return {
        "id": session.session_id,
        "name": session.name,
        "user_role": role,
        "rooms": rooms,
        "members": members,
        "current_room": current_room,
    }


def _room_session_payload(room_id: str, user_id: int) -> dict | None:
    meta = get_room_meta(room_id)
    if not meta or not meta.session_id:
        return None
    return _build_session_summary(meta.session_id, user_id, room_id)


def _session_room_name(session_id: str, target_room_id: str) -> str | None:
    for room in list_game_session_rooms(session_id):
        if str(room.get("room_id") or "") == target_room_id:
            return str(room.get("display_name") or room.get("name") or target_room_id)
    return None


async def _broadcast_session_event(session_id: str, event: WireEvent, roles: set[str] | None = None) -> None:
    session_rooms = {str(room.get("room_id") or "") for room in list_game_session_rooms(session_id)}
    if not session_rooms:
        return
    members_by_username = {
        str(member.get("username") or ""): str(member.get("role") or "player")
        for member in list_game_session_members(session_id)
    }
    sockets = []
    message = event.model_dump_json()
    for room_id, live_room in list(rm._rooms.items()):
        if room_id not in session_rooms:
            continue
        for ws in list(live_room.sockets):
            username = str(live_room.socket_to_client.get(ws) or "")
            role = members_by_username.get(username)
            if not role:
                continue
            if roles is not None and role not in roles:
                continue
            sockets.append(ws)
    if not sockets:
        return
    await asyncio.gather(*(ws.send_text(message) for ws in sockets), return_exceptions=True)


async def _broadcast_session_notice(session_id: str, message: str) -> None:
    await _broadcast_session_event(
        session_id,
        WireEvent(type="SESSION_SYSTEM_NOTICE", payload={"scope": "session", "message": message}),
    )


async def _handle_session_control_event(event: WireEvent, user, client_id: str) -> WireEvent | None:
    session_id = str(event.payload.get("session_id") or "").strip()
    target_room_id = str(event.payload.get("target_room_id") or "").strip()
    if not session_id or not target_room_id:
        return WireEvent(type="ERROR", payload={"message": "session_id and target_room_id are required"})
    if user.user_id is None:
        return WireEvent(type="ERROR", payload={"message": "Invalid user"})
    target_room_name = _session_room_name(session_id, target_room_id)
    if not target_room_name:
        return WireEvent(type="ERROR", payload={"message": "Target room is not in this session"})
    role = get_game_session_role(session_id, user.user_id)
    if not role:
        return WireEvent(type="ERROR", payload={"message": "Not a member of this session"})
    message = str(event.payload.get("message") or "").strip()
    requested_by = user.username or client_id

    if event.type in {"SESSION_ROOM_MOVE_REQUEST", "SESSION_ROOM_MOVE_FORCE"}:
        if role not in {"gm", "co_gm"}:
            return WireEvent(type="ERROR", payload={"message": "Only GM or co-GM can move players"})
        outgoing_type = "SESSION_ROOM_MOVE_OFFER" if event.type == "SESSION_ROOM_MOVE_REQUEST" else "SESSION_ROOM_MOVE_EXECUTE"
        await _broadcast_session_event(
            session_id,
            WireEvent(
                type=outgoing_type,
                payload={
                    "session_id": session_id,
                    "target_room_id": target_room_id,
                    "target_room_name": target_room_name,
                    "requested_by": requested_by,
                    "message": message,
                },
            ),
            roles={"player"},
        )
        if event.type == "SESSION_ROOM_MOVE_REQUEST":
            await _broadcast_session_notice(session_id, f"{requested_by} requested that players join {target_room_name}.")
        else:
            await _broadcast_session_notice(session_id, f"{requested_by} moved players to {target_room_name}.")
        return None

    if event.type == "SESSION_ROOM_MOVE_ACCEPT":
        if role != "player":
            return WireEvent(type="ERROR", payload={"message": "Only players can accept room move offers"})
        await _broadcast_session_notice(session_id, f"{requested_by} accepted room move to {target_room_name}.")
        return None

    return WireEvent(type="ERROR", payload={"message": "Unhandled session control event"})


@app.on_event("startup")
async def _startup() -> None:
    init_db()
    BG_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    ASSET_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    PRIVATE_PACKS_DIR.mkdir(parents=True, exist_ok=True)


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
    if path in ("/", "/favicon.ico") or path in ("/static/canvas.html", "/static/canvas.js", "/static/canvas.css") or path.startswith("/static/canvas/") or path.startswith("/static/login") or path.startswith("/static/auth/") or path.startswith("/packs/"):
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

    resp = await call_next(request)
    # Large pack/static payloads should be cacheable in browsers/CDNs.
    if path.startswith("/packs/") and "cache-control" not in resp.headers:
        resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


# ----------------------------- Pages ------------------------------------------

@app.get("/")
def root(req: Request):
    return RedirectResponse(url="/static/canvas.html", status_code=307)


@app.head("/")
def root_head() -> Response:
    return Response(status_code=200)


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
    return RedirectResponse(url=f"/static/canvas.html?room={room_id}", status_code=302)


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
    except (ValueError, TypeError):
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
    sid = req.cookies.get(SESSION_COOKIE, "") or req.cookies.get(LEGACY_SESSION_COOKIE, "")
    if sid:
        delete_session(sid)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    resp.delete_cookie(LEGACY_SESSION_COOKIE, path="/")
    return resp


# ----------------------------- Packs API --------------------------------------

@app.get("/api/packs")
def list_packs_api(req: Request):
    if not PACKS_DIR.exists():
        return JSONResponse({"packs": []}, headers=_pack_cache_headers())

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
    return JSONResponse({"packs": packs}, headers=_pack_cache_headers())


@app.get("/api/packs/{pack_id}")
def get_pack_api(pack_id: str, req: Request):
    manifest_path = _pack_manifest_path(pack_id)
    etag = _manifest_etag(manifest_path)
    if req.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={**_pack_cache_headers(), "ETag": etag})
    manifest = _load_pack_manifest(pack_id)
    return JSONResponse(manifest, headers={**_pack_cache_headers(), "ETag": etag})


# ----------------------------- Asset Library API ------------------------------

@app.get("/api/assets")
def list_assets_api(req: Request, q: str = "", tag: str = "", folder: str = "", session_id: str = ""):
    started_at = time.perf_counter()
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    current_session_id = str(session_id or "").strip() or None
    if current_session_id and not get_game_session_role(current_session_id, user.user_id):
        raise HTTPException(status_code=403, detail="Not a member of this session")
    assets = list_all_assets_for_user(user.user_id, q=q, tag=tag, folder=folder, session_id=current_session_id)
    if req.query_params.get("src") == "assetlib":
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        logger.info(
            "assetlib.list user_id=%s session_id=%s count=%s q=%r folder=%r elapsed_ms=%.1f",
            user.user_id,
            current_session_id or "-",
            len(assets),
            q,
            folder,
            elapsed_ms,
        )
    return {"assets": assets}


@app.get("/api/private-packs")
def list_private_packs_api(req: Request, session_id: str = ""):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    current_session_id = str(session_id or "").strip() or None
    if current_session_id and not get_game_session_role(current_session_id, user.user_id):
        raise HTTPException(status_code=403, detail="Not a member of this session")
    return {"packs": list_private_packs_for_user(user.user_id, session_id=current_session_id)}


@app.get("/api/assets/file/{asset_id}")
def get_asset_file_api(asset_id: str, req: Request):
    started_at = time.perf_counter()
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")

    # Any logged-in user can fetch an asset by ID — players need to load assets
    # placed by the GM even if they don't own them. IDs are unguessable UUIDs.
    upload = get_asset_by_id(asset_id)
    if upload:
        rel = str(upload.url_original or "")
        if not rel.startswith("/uploads/"):
            raise HTTPException(status_code=404, detail="Asset file not found")
        file_path = UPLOADS_DIR / rel.replace("/uploads/", "", 1)
        if not file_path.exists() or not file_path.is_file():
            raise HTTPException(status_code=404, detail="Asset file not found")
        if req.query_params.get("src") == "assetlib":
            elapsed_ms = (time.perf_counter() - started_at) * 1000.0
            logger.info(
                "assetlib.file type=upload user_id=%s asset_id=%s elapsed_ms=%.1f",
                user.user_id,
                asset_id,
                elapsed_ms,
            )
        return FileResponse(
            str(file_path),
            media_type=upload.mime or _image_mime_from_ext(file_path.suffix),
            headers={"Cache-Control": "private, max-age=86400"},
        )

    pack_asset = get_pack_asset_by_asset_id(asset_id)
    if not pack_asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    # No entitlement check here — any logged-in user can fetch a pack asset by ID.
    # Players need to see private pack assets placed on maps by the GM even if they
    # don't have the pack in their own library. The asset_id is an unguessable UUID.
    # Entitlement is enforced at the library listing layer, not the file-serve layer.
    pack = get_private_pack_by_id(int(pack_asset.pack_id))
    if not pack:
        raise HTTPException(status_code=404, detail="Pack not found")

    ext = Path(str(pack_asset.url_original or "")).suffix.lower()
    if not ext:
        ext = MIME_TO_IMAGE_EXT.get(str(pack_asset.mime or "").lower(), "")
    if not ext:
        ext = ".bin"
    file_path = PRIVATE_PACKS_DIR / str(pack.slug) / "originals" / f"{asset_id}{ext}"
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Asset file not found")
    if req.query_params.get("src") == "assetlib":
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        logger.info(
            "assetlib.file type=pack user_id=%s asset_id=%s pack_slug=%s elapsed_ms=%.1f",
            user.user_id,
            asset_id,
            pack.slug,
            elapsed_ms,
        )
    return FileResponse(
        str(file_path),
        media_type=pack_asset.mime or _image_mime_from_ext(ext),
        headers={"Cache-Control": "private, max-age=86400"},
    )


if HAS_MULTIPART:
    @app.post("/api/assets/upload")
    async def upload_asset_api(
        req: Request,
        file: UploadFile = File(...),
        name: str = Form(""),
        tags: str = Form(""),
    ):
        user = _require_user(req)
        if user.user_id is None:
            raise HTTPException(status_code=500, detail="Invalid user record")
        ext = _background_upload_ext(file)
        data = await file.read(MAX_ASSET_UPLOAD_BYTES + 1)
        if not data:
            raise HTTPException(status_code=400, detail="Empty upload")
        if len(data) > MAX_ASSET_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Asset too large (max 20MB)")
        width, height, thumb_bytes, thumb_ext = _asset_image_meta_and_thumb(data)
        aid = uuid.uuid4().hex
        user_dir = ASSET_UPLOADS_DIR / str(user.user_id)
        thumb_dir = user_dir / "thumbs"
        user_dir.mkdir(parents=True, exist_ok=True)
        thumb_dir.mkdir(parents=True, exist_ok=True)
        file_name = f"{aid}{ext}"
        thumb_name = f"{aid}{thumb_ext}"
        out_path = user_dir / file_name
        thumb_path = thumb_dir / thumb_name
        try:
            out_path.write_bytes(data)
            thumb_path.write_bytes(thumb_bytes)
        except OSError as e:
            try:
                if out_path.exists():
                    out_path.unlink()
            except OSError:
                pass
            try:
                if thumb_path.exists():
                    thumb_path.unlink()
            except OSError:
                pass
            raise HTTPException(status_code=500, detail=f"Failed to save upload: {e}") from e
        rel = out_path.relative_to(UPLOADS_DIR)
        thumb_rel = thumb_path.relative_to(UPLOADS_DIR)
        url_path = "/uploads/" + "/".join(rel.parts)
        thumb_url_path = "/uploads/" + "/".join(thumb_rel.parts)
        raw_name = name.strip() if name.strip() else Path(str(file.filename or "asset")).stem
        tags_list = [t.strip() for t in tags.split(",") if t.strip()]
        create_asset_record(
            asset_id=aid,
            uploader_user_id=user.user_id,
            name=raw_name[:120] or "Asset",
            folder_path="",
            tags=tags_list[:20],
            mime=_image_mime_from_ext(ext),
            width=width,
            height=height,
            url_original=url_path,
            url_thumb=thumb_url_path,
        )
        await file.close()
        return {
            "asset_id": aid,
            "name": raw_name[:120] or "Asset",
            "tags": tags_list[:20],
            "width": width,
            "height": height,
            "url_original": url_path,
            "url_thumb": thumb_url_path,
            "mime": _image_mime_from_ext(ext),
        }

    @app.post("/api/assets/upload-zip")
    async def upload_asset_zip_api(
        req: Request,
        file: UploadFile = File(...),
        tags: str = Form(""),
    ):
        user = _require_user(req)
        if user.user_id is None:
            raise HTTPException(status_code=500, detail="Invalid user record")
        fname = str(file.filename or "").lower()
        if not fname.endswith(".zip"):
            raise HTTPException(status_code=400, detail="Expected a .zip file")
        shared_tags = [t.strip() for t in tags.split(",") if t.strip()][:20]
        user_dir = ASSET_UPLOADS_DIR / str(user.user_id)
        user_dir.mkdir(parents=True, exist_ok=True)
        created: list[dict[str, object]] = []
        skipped: list[str] = []
        total_uncompressed = 0
        # Stream upload into a temp file to avoid buffering the full ZIP in RAM
        try:
            with tempfile.TemporaryFile() as tmp:
                bytes_written = 0
                while True:
                    chunk = await file.read(65536)
                    if not chunk:
                        break
                    bytes_written += len(chunk)
                    if bytes_written > MAX_ZIP_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail=f"ZIP too large (max {MAX_ZIP_UPLOAD_BYTES // (1024 * 1024)}MB)")
                    tmp.write(chunk)
                if bytes_written == 0:
                    raise HTTPException(status_code=400, detail="Empty upload")
                tmp.seek(0)
                with zipfile.ZipFile(tmp) as zf:
                    infos = [i for i in zf.infolist() if not i.is_dir()]
                    if len(infos) > MAX_ZIP_ASSET_FILES:
                        raise HTTPException(status_code=400, detail=f"Too many files in zip (max {MAX_ZIP_ASSET_FILES})")
                    for info in infos:
                        folder_path, base = _safe_zip_member_path(info.filename)
                        if not base:
                            skipped.append(info.filename)
                            continue
                        ext = Path(base).suffix.lower()
                        if ext not in ALLOWED_BACKGROUND_EXTS:
                            skipped.append(info.filename)
                            continue
                        total_uncompressed += max(0, int(info.file_size or 0))
                        if total_uncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES:
                            raise HTTPException(status_code=400, detail="Zip expands beyond allowed size")
                        if info.file_size > MAX_ASSET_UPLOAD_BYTES:
                            skipped.append(info.filename)
                            continue
                        try:
                            content = zf.read(info)
                        except Exception:
                            skipped.append(info.filename)
                            continue
                        # Guard against zip bombs that under-report file_size in headers
                        if len(content) > MAX_ASSET_UPLOAD_BYTES:
                            skipped.append(info.filename)
                            continue
                        try:
                            width, height, thumb_bytes, thumb_ext = _asset_image_meta_and_thumb(content)
                        except HTTPException:
                            skipped.append(info.filename)
                            continue
                        aid = uuid.uuid4().hex
                        thumb_dir = user_dir / "thumbs"
                        thumb_dir.mkdir(parents=True, exist_ok=True)
                        out_path = user_dir / f"{aid}{ext}"
                        thumb_path = thumb_dir / f"{aid}{thumb_ext}"
                        try:
                            out_path.write_bytes(content)
                            thumb_path.write_bytes(thumb_bytes)
                        except OSError:
                            try:
                                if out_path.exists():
                                    out_path.unlink()
                            except OSError:
                                pass
                            try:
                                if thumb_path.exists():
                                    thumb_path.unlink()
                            except OSError:
                                pass
                            skipped.append(info.filename)
                            continue
                        rel = out_path.relative_to(UPLOADS_DIR)
                        thumb_rel = thumb_path.relative_to(UPLOADS_DIR)
                        url_path = "/uploads/" + "/".join(rel.parts)
                        thumb_url_path = "/uploads/" + "/".join(thumb_rel.parts)
                        display_name = Path(base).stem.replace("_", " ").strip()[:120] or "Asset"
                        create_asset_record(
                            asset_id=aid,
                            uploader_user_id=user.user_id,
                            name=display_name,
                            folder_path=folder_path,
                            tags=shared_tags,
                            mime=_image_mime_from_ext(ext),
                            width=width,
                            height=height,
                            url_original=url_path,
                            url_thumb=thumb_url_path,
                        )
                        created.append(
                            {
                                "asset_id": aid,
                                "name": display_name,
                                "folder_path": folder_path,
                                "width": width,
                                "height": height,
                                "url_original": url_path,
                                "url_thumb": thumb_url_path,
                            }
                        )
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid zip: {e}") from e
        await file.close()
        if not created:
            raise HTTPException(status_code=400, detail="No supported image files found in zip")
        return {
            "created_count": len(created),
            "created": created[:200],
            "skipped_count": len(skipped),
            "skipped": skipped[:200],
        }
else:
    @app.post("/api/assets/upload")
    async def upload_asset_unavailable(req: Request):
        _ = req
        raise HTTPException(status_code=503, detail="Asset upload unavailable: python-multipart not installed")

    @app.post("/api/assets/upload-zip")
    async def upload_asset_zip_unavailable(req: Request):
        _ = req
        raise HTTPException(status_code=503, detail="Asset zip upload unavailable: python-multipart not installed")


@app.delete("/api/assets/{asset_id}")
def delete_asset_api(asset_id: str, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    assets = list_assets_for_user(user.user_id)
    target = next((a for a in assets if a.get("asset_id") == asset_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Asset not found")
    deleted = delete_asset_record(asset_id, user.user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Asset not found")
    rel = str(target.get("url_original") or "")
    if rel.startswith("/uploads/"):
        local_path = UPLOADS_DIR / rel.replace("/uploads/", "", 1)
        try:
            if local_path.exists():
                local_path.unlink()
        except OSError as e:
            LOG.warning("Failed to delete asset file %s: %s", local_path, e)
    thumb_rel = str(target.get("url_thumb") or "")
    if thumb_rel.startswith("/uploads/"):
        thumb_local_path = UPLOADS_DIR / thumb_rel.replace("/uploads/", "", 1)
        try:
            if thumb_local_path.exists():
                thumb_local_path.unlink()
        except OSError as e:
            LOG.warning("Failed to delete asset thumbnail %s: %s", thumb_local_path, e)
    return {"ok": True}


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


@app.get("/api/my/sessions")
def my_sessions(req: Request):
    user = _require_user(req)
    return {"sessions": list_game_sessions_for_user(user.user_id)}


@app.post("/api/sessions")
async def create_session_api(req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    body = await req.json()
    name = str(body.get("name") or "").strip() or "Untitled Session"
    session = create_game_session(name, user.user_id)
    room_id = str(body.get("room_id") or "").strip() or None
    if room_id:
        meta = get_room_meta(room_id)
        if not meta:
            raise HTTPException(status_code=404, detail="Room not found")
        if meta.owner_user_id != user.user_id:
            raise HTTPException(status_code=403, detail="Only the room owner can attach it to a session")
        if not assign_room_to_game_session(room_id, session.session_id, display_name=meta.name):
            raise HTTPException(status_code=400, detail="Failed to attach room to session")
        for member_user_id in list_room_member_user_ids(room_id):
            role = "gm" if member_user_id == user.user_id else "player"
            add_game_session_member(session.session_id, member_user_id, role)
    return _build_session_summary(session.session_id, user.user_id, room_id)


@app.post("/api/rooms/{room_id}/attach-session")
async def attach_room_to_session_api(room_id: str, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    meta = get_room_meta(room_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Room not found")
    if meta.owner_user_id != user.user_id:
        raise HTTPException(status_code=403, detail="Only the room owner can attach it to a session")
    body = await req.json()
    name = str(body.get("name") or "").strip() or f"{meta.name} Session"
    session = create_game_session(name, user.user_id)
    if not assign_room_to_game_session(room_id, session.session_id, display_name=meta.name):
        raise HTTPException(status_code=400, detail="Failed to attach room to session")
    for member_user_id in list_room_member_user_ids(room_id):
        role = "gm" if member_user_id == user.user_id else "player"
        add_game_session_member(session.session_id, member_user_id, role)
    return _build_session_summary(session.session_id, user.user_id, room_id)


@app.get("/api/sessions/{session_id}")
def get_session_api(session_id: str, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    payload = _build_session_summary(session_id, user.user_id, user.last_room_id)
    if not payload:
        raise HTTPException(status_code=404, detail="Session not found")
    return payload


@app.get("/api/sessions/{session_id}/rooms")
def get_session_rooms_api(session_id: str, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    if not get_game_session_role(session_id, user.user_id):
        raise HTTPException(status_code=403, detail="Not a member of this session")
    return {"rooms": list_game_session_rooms(session_id)}


@app.post("/api/sessions/{session_id}/rooms")
async def create_session_room_api(session_id: str, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    if not can_manage_game_session(session_id, user.user_id):
        raise HTTPException(status_code=403, detail="GM or co-GM required")
    body = await req.json()
    name = str(body.get("name") or "").strip() or "Untitled Room"
    room_id = uuid.uuid4().hex[:8]
    join_code = None
    for _ in range(20):
        candidate = ensure_unique_join_code()
        try:
            initial = RoomState(room_id=room_id, gm_id=None, gm_user_id=user.user_id)
            create_room_in_game_session(
                session_id=session_id,
                created_by_user_id=user.user_id,
                room_id=room_id,
                name=name,
                state_json=initial.model_dump_json(),
                join_code=candidate,
            )
            join_code = candidate
            break
        except Exception:
            continue
    if not join_code:
        raise HTTPException(status_code=500, detail="Failed to create room")
    update_user_last_room(user.user_id, room_id)
    return {"room_id": room_id, "name": name, "join_code": join_code, "session_id": session_id}


@app.get("/api/sessions/{session_id}/members")
def get_session_members_api(session_id: str, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    if not get_game_session_role(session_id, user.user_id):
        raise HTTPException(status_code=403, detail="Not a member of this session")
    return {"members": list_game_session_members(session_id)}


@app.get("/api/sessions/{session_id}/shared-packs")
def get_session_shared_packs_api(session_id: str, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    if not get_game_session_role(session_id, user.user_id):
        raise HTTPException(status_code=403, detail="Not a member of this session")
    return {"packs": list_game_session_shared_packs(session_id)}


@app.post("/api/sessions/{session_id}/shared-packs/{pack_id}")
def share_session_pack_api(session_id: str, pack_id: int, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    if not can_manage_game_session(session_id, user.user_id):
        raise HTTPException(status_code=403, detail="GM or co-GM required")
    if not user_has_pack_access(user.user_id, pack_id):
        raise HTTPException(status_code=403, detail="You do not have access to that pack")
    if not set_game_session_shared_pack(session_id, pack_id, True, shared_by_user_id=user.user_id):
        raise HTTPException(status_code=404, detail="Session or pack not found")
    return {"ok": True, "packs": list_game_session_shared_packs(session_id)}


@app.delete("/api/sessions/{session_id}/shared-packs/{pack_id}")
def unshare_session_pack_api(session_id: str, pack_id: int, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    if not can_manage_game_session(session_id, user.user_id):
        raise HTTPException(status_code=403, detail="GM or co-GM required")
    if not set_game_session_shared_pack(session_id, pack_id, False, shared_by_user_id=user.user_id):
        raise HTTPException(status_code=404, detail="Session or pack not found")
    return {"ok": True, "packs": list_game_session_shared_packs(session_id)}


@app.post("/api/rooms")
async def create_room(req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    body = await req.json()
    name = str(body.get("name", "")).strip() or "Untitled Room"
    session_id = str(body.get("session_id") or "").strip() or None
    room_id = uuid.uuid4().hex[:8]

    join_code = None
    for _ in range(20):
        candidate = ensure_unique_join_code()
        try:
            initial = RoomState(room_id=room_id, gm_id=None, gm_user_id=user.user_id)
            if session_id:
                if not can_manage_game_session(session_id, user.user_id):
                    raise HTTPException(status_code=403, detail="GM or co-GM required")
                create_room_in_game_session(
                    session_id=session_id,
                    created_by_user_id=user.user_id,
                    room_id=room_id,
                    name=name,
                    state_json=initial.model_dump_json(),
                    join_code=candidate,
                )
            else:
                create_room_record(room_id=room_id, name=name, state_json=initial.model_dump_json(), owner_user_id=user.user_id, join_code=candidate)
                add_membership(user.user_id, room_id, role="owner")
            join_code = candidate
            break
        except HTTPException:
            raise
        except Exception:
            continue
    if not join_code:
        raise HTTPException(status_code=500, detail="Failed to create room")

    update_user_last_room(user.user_id, room_id)
    return {"room_id": room_id, "name": name, "join_code": join_code, "session_id": session_id}


def ensure_unique_join_code() -> str:
    # generate_join_code is inside storage; reusing via ensure_room_join_code would need room_id.
    # We'll just generate candidates here and let the unique index be the guard.
    import secrets as _secrets
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    core = "".join(_secrets.choice(alphabet) for _ in range(6))
    return f"WHAM-{core}"


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
    meta = get_room_meta(room_id)
    if meta and meta.session_id:
        add_game_session_member(meta.session_id, user.user_id, role="player")
    touch_membership(user.user_id, room_id)
    update_user_last_room(user.user_id, room_id)
    return {"room_id": room_id, "session_id": meta.session_id if meta else None}


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


if HAS_MULTIPART:
    @app.post("/api/rooms/{room_id}/background-upload")
    async def upload_room_background(room_id: str, req: Request, file: UploadFile = File(...), gm_key: str | None = None):
        user = _require_user(req)
        if user.user_id is None:
            raise HTTPException(status_code=500, detail="Invalid user record")
        if not is_member(user.user_id, room_id):
            raise HTTPException(status_code=403, detail="Not a member of this room")
        raw = load_room_state_json(room_id)
        if not raw:
            raise HTTPException(status_code=404, detail="Room not found")
        state = RoomState.model_validate_json(raw)
        if not _gm_authorized(state, user.user_id, gm_key):
            raise HTTPException(status_code=403, detail="GM only")
        ext = _background_upload_ext(file)
        safe_room_id = _safe_room_id(room_id)
        if not safe_room_id:
            raise HTTPException(status_code=400, detail="Invalid room id")
        room_dir = BG_UPLOADS_DIR / safe_room_id
        room_dir.mkdir(parents=True, exist_ok=True)
        data = await file.read(MAX_BACKGROUND_UPLOAD_BYTES + 1)
        if not data:
            raise HTTPException(status_code=400, detail="Empty upload")
        if len(data) > MAX_BACKGROUND_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Image too large (max 10MB)")
        file_name = f"{int(time.time())}-{uuid.uuid4().hex[:10]}{ext}"
        out_path = room_dir / file_name
        try:
            out_path.write_bytes(data)
        except OSError as e:
            raise HTTPException(status_code=500, detail=f"Failed to save upload: {e}") from e
        rel = out_path.relative_to(UPLOADS_DIR)
        url_path = "/uploads/" + "/".join(rel.parts)
        await file.close()
        return {"url": url_path, "bytes": len(data)}
else:
    @app.post("/api/rooms/{room_id}/background-upload")
    async def upload_room_background_unavailable(room_id: str, req: Request, gm_key: str | None = None):
        _ = room_id, req, gm_key
        raise HTTPException(status_code=503, detail="Background upload unavailable: python-multipart not installed")


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
    if not ensure_room_membership_for_user(user.user_id, room_id):
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
                "is_co_gm": client_id in room.state.co_gm_ids,
                "gm_key_set": bool(room.state.gm_key_hash),
                "username": user.username,
                "session": _room_session_payload(room_id, user.user_id),
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
    req_sync_times: deque[float] = deque()
    create_times: deque[float] = deque()

    def _allow_rate(kind: str) -> bool:
        now = time.time()
        if kind == "move":
            q = move_times
            limit = 60
            window = 1.0
        elif kind == "erase":
            q = erase_times
            limit = 30
            window = 1.0
        elif kind == "create":
            q = create_times
            limit = 20
            window = 1.0
        else:
            q = req_sync_times
            limit = 6
            window = 30.0
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True

    session_sid = ws.cookies.get(SESSION_COOKIE, "") or ws.cookies.get(LEGACY_SESSION_COOKIE, "")
    last_session_check = time.time()
    SESSION_RECHECK_SECONDS = 300.0

    try:
        while True:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=HEARTBEAT_TIMEOUT_SECONDS)
            event = WireEvent.model_validate_json(raw)
            log_msg = "ws_in room=%s client=%s type=%s gm=%s conns=%d"
            log_args = (room_id, client_id, event.type, room.state.gm_id or "", len(room.sockets))
            if event.type == "HEARTBEAT":
                LOG.debug(log_msg, *log_args)
            elif event.type == "TOKEN_MOVE" and not bool(event.payload.get("commit", False)):
                LOG.debug(log_msg, *log_args)
            else:
                LOG.info(log_msg, *log_args)

            if event.type == "HEARTBEAT":
                now = time.time()
                if now - last_session_check >= SESSION_RECHECK_SECONDS:
                    last_session_check = now
                    if not get_user_by_sid(session_sid):
                        await ws.close(code=1008)
                        return
                await ws.send_text(WireEvent(type="HEARTBEAT", payload={"ts": time.time()}).model_dump_json())
                continue

            if event.type in {"SESSION_ROOM_MOVE_REQUEST", "SESSION_ROOM_MOVE_FORCE", "SESSION_ROOM_MOVE_ACCEPT"}:
                session_out = await _handle_session_control_event(event, user, client_id)
                if session_out and session_out.type == "ERROR":
                    await ws.send_text(session_out.model_dump_json())
                continue

            if event.type == "REQ_STATE_SYNC" and not _allow_rate("sync"):
                await ws.send_text(WireEvent(type="ERROR", payload={"message": "rate limited"}).model_dump_json())
                continue

            if event.type in ("TOKEN_MOVE", "SHAPE_UPDATE", "ASSET_INSTANCE_UPDATE", "ERASE_AT") and not _allow_rate("erase" if event.type == "ERASE_AT" else "move"):
                await ws.send_text(WireEvent(type="ERROR", payload={"message": "rate limited"}).model_dump_json())
                continue

            if event.type in ("TOKEN_CREATE", "STROKE_ADD", "SHAPE_ADD", "ASSET_INSTANCE_CREATE", "FOG_STROKE_ADD") and not _allow_rate("create"):
                await ws.send_text(WireEvent(type="ERROR", payload={"message": "rate limited"}).model_dump_json())
                continue

            out = await rm.apply_event(room_id, room, event, client_id, user.user_id)
            if out.type == "ERROR":
                await ws.send_text(out.model_dump_json())
            else:
                await rm.broadcast(room, out)

    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    finally:
        try:
            room_after = await rm.disconnect(room_id, ws)
            if room_after:
                await rm.broadcast(room_after, rm.presence_event(room_after))
        except Exception:
            pass
