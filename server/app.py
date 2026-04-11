from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import tempfile
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from .auth_helpers import (
    LEGACY_SESSION_COOKIE,
    PASSWORD_CONTEXT,
    SESSION_COOKIE,
    auth_logout_response,
    auth_success_response,
    cookie_secure,
    get_user_from_request,
    hash_key,
    require_user,
    ws_user,
)
from .models import RoomState, WireEvent
from .rooms import RoomManager
from .session_helpers import (
    broadcast_session_event,
    broadcast_session_notice,
    build_session_summary,
    handle_session_control_event,
    room_session_payload,
    session_room_name,
)
from .upload_helpers import (
    ALLOWED_BACKGROUND_EXTS,
    CONTENT_TYPE_TO_EXT,
    EXT_TO_IMAGE_MIME,
    MIME_TO_IMAGE_EXT,
    asset_image_meta_and_thumb,
    background_upload_ext,
    image_mime_from_ext,
    import_asset_zip,
    safe_zip_member_path,
    save_asset_upload,
    save_background_upload,
)
from .storage import (
    add_game_session_member,
    add_membership,
    archive_game_session,
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
    list_assets_for_user_page,
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
    set_room_parent,
    set_game_session_root_room,
    get_game_session_root_room_id,
    update_room_display_name,
    update_room_order,
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

# Static assets (still routed through FastAPI so middleware can protect them)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR), check_dir=False), name="static")
app.mount("/packs", StaticFiles(directory=str(PACKS_DIR), check_dir=False), name="packs")
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR), check_dir=False), name="uploads")

rm = RoomManager()
HEARTBEAT_TIMEOUT_SECONDS = 35.0
LOG = logging.getLogger("warhamster.ws")
HAS_MULTIPART = importlib.util.find_spec("multipart") is not None


def _hash_key(raw: str) -> str:
    return hash_key(raw)


def _safe_pack_id(pack_id: str) -> str:
    cleaned = "".join(ch for ch in (pack_id or "") if ch.isalnum() or ch in ("-", "_"))
    return cleaned.strip()


def _safe_room_id(room_id: str) -> str:
    cleaned = "".join(ch for ch in (room_id or "") if ch.isalnum() or ch in ("-", "_"))
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
    return get_user_from_request(req, get_user_by_sid)


def _require_user(req: Request):
    return require_user(req, get_user_by_sid)


def _ws_user(ws: WebSocket):
    return ws_user(ws, get_user_by_sid)


def _cookie_secure(req: Request) -> bool:
    return cookie_secure(req)


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
    return build_session_summary(
        session_id=session_id,
        user_id=user_id,
        current_room_id=current_room_id,
        get_game_session_fn=get_game_session,
        get_game_session_role_fn=get_game_session_role,
        list_game_session_rooms_fn=list_game_session_rooms,
        list_game_session_members_fn=list_game_session_members,
        get_room_meta_fn=get_room_meta,
        room_online_count_fn=_room_online_count,
    )


def _room_session_payload(room_id: str, user_id: int) -> dict | None:
    return room_session_payload(
        room_id=room_id,
        user_id=user_id,
        get_room_meta_fn=get_room_meta,
        build_session_summary_fn=_build_session_summary,
    )


def _session_room_name(session_id: str, target_room_id: str) -> str | None:
    return session_room_name(
        session_id=session_id,
        target_room_id=target_room_id,
        list_game_session_rooms_fn=list_game_session_rooms,
    )


async def _broadcast_session_event(session_id: str, event: WireEvent, roles: set[str] | None = None) -> None:
    await broadcast_session_event(
        session_id=session_id,
        event=event,
        rm=rm,
        list_game_session_rooms_fn=list_game_session_rooms,
        list_game_session_members_fn=list_game_session_members,
        roles=roles,
    )


async def _broadcast_session_notice(session_id: str, message: str) -> None:
    await broadcast_session_notice(
        session_id=session_id,
        message=message,
        broadcast_session_event_fn=_broadcast_session_event,
    )


def _room_display_name(room_id: str) -> str:
    meta = get_room_meta(room_id)
    if not meta:
        return room_id
    return meta.display_name or meta.name or room_id


async def _handle_session_control_event(event: WireEvent, user, client_id: str) -> WireEvent | None:
    return await handle_session_control_event(
        event=event,
        user=user,
        client_id=client_id,
        get_game_session_role_fn=get_game_session_role,
        session_room_name_fn=_session_room_name,
        broadcast_session_event_fn=_broadcast_session_event,
        broadcast_session_notice_fn=_broadcast_session_notice,
    )


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
    return auth_success_response(req=req, sid=sid, username=user.username)


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
    return auth_success_response(req=req, sid=sid, username=u.username)


@app.post("/api/auth/logout")
def logout(req: Request):
    sid = req.cookies.get(SESSION_COOKIE, "") or req.cookies.get(LEGACY_SESSION_COOKIE, "")
    return auth_logout_response(sid=sid, delete_session_fn=delete_session)


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
def list_assets_api(
    req: Request,
    q: str = "",
    tag: str = "",
    folder: str = "",
    session_id: str = "",
    lite: int = 0,
    limit: int = 0,
    offset: int = 0,
):
    started_at = time.perf_counter()
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    current_session_id = str(session_id or "").strip() or None
    if current_session_id and not get_game_session_role(current_session_id, user.user_id):
        raise HTTPException(status_code=403, detail="Not a member of this session")

    safe_offset = max(0, int(offset or 0))
    safe_limit = max(0, min(int(limit or 0), 500))

    if safe_limit:
        # Real paginated path: SQL does the sorting, counting, and slicing
        assets, total_count, has_more = list_assets_for_user_page(
            user.user_id,
            q=q,
            tag=tag,
            folder=folder,
            limit=safe_limit,
            offset=safe_offset,
            session_id=current_session_id,
        )
    else:
        # No limit requested — fall back to full load (preserves legacy callers)
        assets = list_all_assets_for_user(
            user.user_id, q=q, tag=tag, folder=folder, session_id=current_session_id
        )
        total_count = len(assets)
        has_more = False

    if lite:
        def _lite(asset):
            d = {
                "asset_id": asset.get("asset_id"),
                "name": asset.get("name"),
                "folder_path": asset.get("folder_path", ""),
                "tags": asset.get("tags", []),
                "mime": asset.get("mime"),
                "width": asset.get("width", 0),
                "height": asset.get("height", 0),
                "created_at": asset.get("created_at"),
                "readonly": bool(asset.get("readonly", False)),
                "source": asset.get("source"),
                "pack_id": asset.get("pack_id"),
                "pack_slug": asset.get("pack_slug"),
                "pack_name": asset.get("pack_name"),
                "shared_in_session": bool(asset.get("shared_in_session", False)),
            }
            # Return a direct thumb URL when available to bypass the full auth endpoint.
            # Uploads: /uploads/... (static mount, no Python overhead).
            # Packs: /api/pack-thumbs/... (login-only, no per-asset DB lookup).
            direct_thumb = str(asset.get("thumb_url") or "")
            if direct_thumb:
                d["thumb_url"] = direct_thumb
            else:
                url_thumb = str(asset.get("url_thumb") or "")
                if asset.get("source") == "upload" and url_thumb.startswith("/uploads/"):
                    d["thumb_url"] = url_thumb
            return d
        assets = [_lite(a) for a in assets]

    if req.query_params.get("src") == "assetlib":
        elapsed_ms = (time.perf_counter() - started_at) * 1000.0
        logger.info(
            "assetlib.list user_id=%s session_id=%s count=%s total=%s q=%r folder=%r lite=%s elapsed_ms=%.1f",
            user.user_id,
            current_session_id or "-",
            len(assets),
            total_count,
            q,
            folder,
            int(bool(lite)),
            elapsed_ms,
        )

    next_offset = safe_offset + len(assets) if safe_limit else len(assets)
    return {
        "assets": assets,
        "total_count": total_count,
        "offset": safe_offset,
        "next_offset": next_offset,
        "has_more": has_more,
    }


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
    assetlib_src = req.query_params.get("src") == "assetlib"

    # Any logged-in user can fetch an asset by ID — players need to load assets
    # placed by the GM even if they don't own them. IDs are unguessable UUIDs.
    upload = get_asset_by_id(asset_id)
    if upload:
        rel = str((upload.url_thumb if assetlib_src and upload.url_thumb else upload.url_original) or "")
        if not rel.startswith("/uploads/"):
            raise HTTPException(status_code=404, detail="Asset file not found")
        file_path = UPLOADS_DIR / rel.replace("/uploads/", "", 1)
        if not file_path.exists() or not file_path.is_file():
            resolved_fallback = None
            if assetlib_src and upload.url_original:
                fallback_rel = str(upload.url_original or "")
                if fallback_rel.startswith("/uploads/"):
                    fallback_path = UPLOADS_DIR / fallback_rel.replace("/uploads/", "", 1)
                    if fallback_path.exists() and fallback_path.is_file():
                        resolved_fallback = fallback_path
            if not resolved_fallback:
                raise HTTPException(status_code=404, detail="Asset file not found")
            file_path = resolved_fallback
        if assetlib_src:
            elapsed_ms = (time.perf_counter() - started_at) * 1000.0
            logger.info(
                "assetlib.file type=upload user_id=%s asset_id=%s elapsed_ms=%.1f",
                user.user_id,
                asset_id,
                elapsed_ms,
            )
        return FileResponse(
            str(file_path),
            media_type=upload.mime or image_mime_from_ext(file_path.suffix),
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

    selected_rel = str((pack_asset.url_thumb if assetlib_src and pack_asset.url_thumb else pack_asset.url_original) or "")
    ext = Path(selected_rel).suffix.lower()
    if not ext:
        ext = MIME_TO_IMAGE_EXT.get(str(pack_asset.mime or "").lower(), "")
    if not ext:
        ext = ".bin"
    subdir = "thumbs" if assetlib_src and pack_asset.url_thumb else "originals"
    file_name = Path(selected_rel).name if selected_rel else f"{asset_id}{ext}"
    file_path = PRIVATE_PACKS_DIR / str(pack.slug) / subdir / file_name
    if not file_path.exists() or not file_path.is_file():
        original_ext = Path(str(pack_asset.url_original or "")).suffix.lower() or ext
        fallback_path = PRIVATE_PACKS_DIR / str(pack.slug) / "originals" / f"{asset_id}{original_ext}"
        if not fallback_path.exists() or not fallback_path.is_file():
            raise HTTPException(status_code=404, detail="Asset file not found")
        file_path = fallback_path
    if assetlib_src:
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
        media_type=pack_asset.mime or image_mime_from_ext(ext),
        headers={"Cache-Control": "private, max-age=86400"},
    )


@app.get("/api/pack-thumbs/{pack_slug}/{filename}")
def get_pack_thumb_direct(pack_slug: str, filename: str, req: Request):
    """Lightweight pack thumbnail endpoint — login check only, no per-asset DB lookup.

    The storage layer pre-resolves the thumb filename and pack slug at list time,
    so callers can skip the full /api/assets/file/{id} path for each visible thumbnail.
    Security model: asset IDs embedded in filenames are UUIDs (unguessable); any
    logged-in user may fetch them (same permissive policy as /api/assets/file/{id}).
    """
    _require_user(req)
    # Reject path traversal and characters that don't belong in a slug or filename.
    if (
        ".." in pack_slug or "/" in pack_slug or "\\" in pack_slug
        or ".." in filename or "/" in filename or "\\" in filename
        or not pack_slug or not filename
    ):
        raise HTTPException(status_code=400, detail="Invalid path component")
    file_path = PRIVATE_PACKS_DIR / pack_slug / "thumbs" / filename
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(
        str(file_path),
        media_type=image_mime_from_ext(Path(filename).suffix) or "image/png",
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
        ext = background_upload_ext(file)
        data = await file.read(MAX_ASSET_UPLOAD_BYTES + 1)
        if not data:
            raise HTTPException(status_code=400, detail="Empty upload")
        if len(data) > MAX_ASSET_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Asset too large (max 20MB)")
        width, height, thumb_bytes, thumb_ext = asset_image_meta_and_thumb(data)
        aid = uuid.uuid4().hex
        url_path, thumb_url_path = save_asset_upload(
            data=data,
            thumb_bytes=thumb_bytes,
            user_id=user.user_id,
            asset_id=aid,
            ext=ext,
            thumb_ext=thumb_ext,
            uploads_dir=UPLOADS_DIR,
            asset_uploads_dir=ASSET_UPLOADS_DIR,
        )
        raw_name = name.strip() if name.strip() else Path(str(file.filename or "asset")).stem
        tags_list = [t.strip() for t in tags.split(",") if t.strip()]
        create_asset_record(
            asset_id=aid,
            uploader_user_id=user.user_id,
            name=raw_name[:120] or "Asset",
            folder_path="",
            tags=tags_list[:20],
            mime=image_mime_from_ext(ext),
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
            "mime": image_mime_from_ext(ext),
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
                created, skipped = import_asset_zip(
                    fileobj=tmp,
                    user_id=user.user_id,
                    shared_tags=shared_tags,
                    uploads_dir=UPLOADS_DIR,
                    asset_uploads_dir=ASSET_UPLOADS_DIR,
                    max_asset_upload_bytes=MAX_ASSET_UPLOAD_BYTES,
                    max_zip_asset_files=MAX_ZIP_ASSET_FILES,
                    max_zip_total_uncompressed_bytes=MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES,
                    create_asset_record_fn=create_asset_record,
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
    return {"rooms": list_rooms_for_user(user.user_id)}


@app.post("/api/rooms/{room_id}/join-code")
def ensure_room_join_code_api(room_id: str, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    if not ensure_room_membership_for_user(user.user_id, room_id):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    try:
        return {"join_code": ensure_room_join_code(room_id)}
    except ValueError:
        raise HTTPException(status_code=404, detail="Room not found")


@app.get("/api/my/sessions")
def my_sessions(req: Request):
    user = _require_user(req)
    sessions = list_game_sessions_for_user(user.user_id)
    for session in sessions:
        sid = str(session.get("id") or "")
        session["rooms"] = list_game_session_rooms(sid) if sid else []
    return {"sessions": sessions}


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


@app.delete("/api/sessions/{session_id}")
def delete_session_api(session_id: str, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    if not can_manage_game_session(session_id, user.user_id):
        raise HTTPException(status_code=403, detail="GM or co-GM required")
    if not archive_game_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return {"ok": True}


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
    parent_room_id = str(body.get("parent_room_id") or "").strip() or None
    # Validate parent is in this session
    if parent_room_id:
        parent_meta = get_room_meta(parent_room_id)
        if not parent_meta or parent_meta.session_id != session_id:
            raise HTTPException(status_code=400, detail="parent_room_id must be a room in this session")
    # Default parent to root room if not specified and session has a root
    if not parent_room_id:
        parent_room_id = get_game_session_root_room_id(session_id)
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
                parent_room_id=parent_room_id,
            )
            join_code = candidate
            break
        except Exception:
            continue
    if not join_code:
        raise HTTPException(status_code=500, detail="Failed to create room")
    update_user_last_room(user.user_id, room_id)
    return {"room_id": room_id, "name": name, "join_code": join_code, "session_id": session_id, "parent_room_id": parent_room_id}


@app.get("/api/sessions/{session_id}/tree")
def get_session_tree_api(session_id: str, req: Request):
    user = _require_user(req)
    if user.user_id is None:
        raise HTTPException(status_code=500, detail="Invalid user record")
    if not get_game_session_role(session_id, user.user_id):
        raise HTTPException(status_code=403, detail="Not a member of this session")
    session = get_game_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    rooms = list_game_session_rooms(session_id)
    root_room_id = session.root_room_id
    # Build nested tree from flat list
    by_id = {r["room_id"]: dict(r, children=[]) for r in rooms}
    tree_roots = []
    for r in rooms:
        pid = r.get("parent_room_id")
        node = by_id[r["room_id"]]
        if pid and pid in by_id:
            by_id[pid]["children"].append(node)
        else:
            tree_roots.append(node)
    return {
        "id": session.session_id,
        "name": session.name,
        "root_room_id": root_room_id,
        "rooms": rooms,
        "tree": tree_roots,
    }


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
    meta = get_room_meta(room_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Room not found")
    body = await req.json()
    # name — existing behavior, requires room-level GM auth
    if "name" in body:
        raw = load_room_state_json(room_id)
        if not raw:
            raise HTTPException(status_code=404, detail="Room not found")
        state = RoomState.model_validate_json(raw)
        if not _gm_authorized(state, user.user_id, gm_key):
            raise HTTPException(status_code=403, detail="GM only")
        name = str(body.get("name", "")).strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        ok = update_room_name(room_id, name)
        if not ok:
            raise HTTPException(status_code=404, detail="Room not found")
    # display_name / parent_room_id / room_order — session GM/co-GM only
    hierarchy_keys = {"display_name", "parent_room_id", "room_order"}
    if hierarchy_keys & body.keys():
        session_id = meta.session_id
        if not session_id or not can_manage_game_session(session_id, user.user_id):
            raise HTTPException(status_code=403, detail="Session GM or co-GM required")
        if "display_name" in body:
            display_name = str(body["display_name"] or "").strip()
            if display_name:
                update_room_display_name(room_id, display_name)
        if "parent_room_id" in body:
            new_parent = body["parent_room_id"]
            if new_parent is not None:
                new_parent = str(new_parent).strip() or None
            if not set_room_parent(room_id, new_parent):
                raise HTTPException(status_code=400, detail="Invalid parent_room_id (cycle, wrong session, or not found)")
        if "room_order" in body:
            order = body["room_order"]
            if order is not None:
                update_room_order(room_id, int(order))
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
    await rm.kick_all_and_drop(room_id)
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
        ext = background_upload_ext(file)
        data = await file.read(MAX_BACKGROUND_UPLOAD_BYTES + 1)
        if not data:
            raise HTTPException(status_code=400, detail="Empty upload")
        if len(data) > MAX_BACKGROUND_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Image too large (max 10MB)")
        url_path, byte_count = save_background_upload(
            data=data,
            room_id=room_id,
            ext=ext,
            uploads_dir=UPLOADS_DIR,
            bg_uploads_dir=BG_UPLOADS_DIR,
            safe_room_id_fn=_safe_room_id,
        )
        await file.close()
        return {"url": url_path, "bytes": byte_count}
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
                "room_name": _room_display_name(room_id),
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

    await rm.broadcast(room, WireEvent(type="HELLO", payload={"client_id": client_id, "room_id": room_id, "room_name": _room_display_name(room_id)}))
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
