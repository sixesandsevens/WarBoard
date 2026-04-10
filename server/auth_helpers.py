from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

from fastapi import HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse

try:
    from passlib.context import CryptContext  # type: ignore
except Exception:  # pragma: no cover - fallback used in minimal/offline envs
    CryptContext = None  # type: ignore

SESSION_COOKIE = "warhamster_sid"
LEGACY_SESSION_COOKIE = "warboard_sid"


class PBKDF2Context:
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
    else PBKDF2Context()
)


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def get_user_from_request(req: Request, get_user_by_sid_fn):
    sid = req.cookies.get(SESSION_COOKIE, "") or req.cookies.get(LEGACY_SESSION_COOKIE, "")
    return get_user_by_sid_fn(sid)


def require_user(req: Request, get_user_by_sid_fn):
    user = get_user_from_request(req, get_user_by_sid_fn)
    if not user:
        raise HTTPException(status_code=401, detail="Login required")
    return user


def ws_user(ws: WebSocket, get_user_by_sid_fn):
    sid = ws.cookies.get(SESSION_COOKIE, "") or ws.cookies.get(LEGACY_SESSION_COOKIE, "")
    return get_user_by_sid_fn(sid)


def cookie_secure(req: Request) -> bool:
    forwarded_proto = req.headers.get("x-forwarded-proto", "")
    if forwarded_proto:
        proto = forwarded_proto.split(",", 1)[0].strip().lower()
        return proto == "https"
    return req.url.scheme == "https"


def auth_success_response(*, req: Request, sid: str, username: str) -> JSONResponse:
    resp = JSONResponse({"ok": True, "username": username})
    resp.set_cookie(
        SESSION_COOKIE,
        sid,
        httponly=True,
        secure=cookie_secure(req),
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
        path="/",
    )
    return resp


def auth_logout_response(*, sid: str, delete_session_fn) -> JSONResponse:
    if sid:
        delete_session_fn(sid)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    resp.delete_cookie(LEGACY_SESSION_COOKIE, path="/")
    return resp
