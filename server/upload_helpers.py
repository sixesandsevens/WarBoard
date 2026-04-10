from __future__ import annotations

import io
import posixpath
import time
import uuid
import zipfile
from pathlib import Path
from typing import BinaryIO, Callable

from fastapi import HTTPException, UploadFile

try:
    from PIL import Image, ImageOps, UnidentifiedImageError  # type: ignore
except Exception:  # pragma: no cover - fallback keeps app booting without Pillow
    Image = None  # type: ignore
    ImageOps = None  # type: ignore
    UnidentifiedImageError = Exception  # type: ignore

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


def safe_zip_member_path(raw_name: str) -> tuple[str, str]:
    name = str(raw_name or "").replace("\\", "/").strip()
    norm = posixpath.normpath(name)
    if not norm or norm in (".", "/") or norm.startswith("/") or norm.startswith("../") or "/../" in norm:
        return "", ""
    folder = posixpath.dirname(norm)
    if folder in (".", "/"):
        folder = ""
    base = posixpath.basename(norm)
    return folder.strip("/"), base


def background_upload_ext(upload: UploadFile) -> str:
    ctype = str(upload.content_type or "").strip().lower()
    if ctype in CONTENT_TYPE_TO_EXT:
        return CONTENT_TYPE_TO_EXT[ctype]
    ext = Path(str(upload.filename or "")).suffix.lower()
    if ext in ALLOWED_BACKGROUND_EXTS:
        return ext
    raise HTTPException(status_code=400, detail="Unsupported image type")


def image_mime_from_ext(ext: str) -> str:
    return EXT_TO_IMAGE_MIME.get(str(ext or "").lower(), "application/octet-stream")


def asset_image_meta_and_thumb(data: bytes) -> tuple[int, int, bytes, str]:
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


def save_asset_upload(
    *,
    data: bytes,
    thumb_bytes: bytes,
    user_id: int,
    asset_id: str,
    ext: str,
    thumb_ext: str,
    uploads_dir: Path,
    asset_uploads_dir: Path,
) -> tuple[str, str]:
    user_dir = asset_uploads_dir / str(user_id)
    thumb_dir = user_dir / "thumbs"
    user_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)
    out_path = user_dir / f"{asset_id}{ext}"
    thumb_path = thumb_dir / f"{asset_id}{thumb_ext}"
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
    rel = out_path.relative_to(uploads_dir)
    thumb_rel = thumb_path.relative_to(uploads_dir)
    return "/uploads/" + "/".join(rel.parts), "/uploads/" + "/".join(thumb_rel.parts)


def save_background_upload(
    *,
    data: bytes,
    room_id: str,
    ext: str,
    uploads_dir: Path,
    bg_uploads_dir: Path,
    safe_room_id_fn: Callable[[str], str],
) -> tuple[str, int]:
    safe_room_id = safe_room_id_fn(room_id)
    if not safe_room_id:
        raise HTTPException(status_code=400, detail="Invalid room id")
    room_dir = bg_uploads_dir / safe_room_id
    room_dir.mkdir(parents=True, exist_ok=True)
    file_name = f"{int(time.time())}-{uuid.uuid4().hex[:10]}{ext}"
    out_path = room_dir / file_name
    try:
        out_path.write_bytes(data)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to save upload: {e}") from e
    rel = out_path.relative_to(uploads_dir)
    return "/uploads/" + "/".join(rel.parts), len(data)


def import_asset_zip(
    *,
    fileobj: BinaryIO,
    user_id: int,
    shared_tags: list[str],
    uploads_dir: Path,
    asset_uploads_dir: Path,
    max_asset_upload_bytes: int,
    max_zip_asset_files: int,
    max_zip_total_uncompressed_bytes: int,
    create_asset_record_fn: Callable[..., object],
) -> tuple[list[dict[str, object]], list[str]]:
    user_dir = asset_uploads_dir / str(user_id)
    user_dir.mkdir(parents=True, exist_ok=True)
    created: list[dict[str, object]] = []
    skipped: list[str] = []
    total_uncompressed = 0
    try:
        with zipfile.ZipFile(fileobj) as zf:
            infos = [i for i in zf.infolist() if not i.is_dir()]
            if len(infos) > max_zip_asset_files:
                raise HTTPException(status_code=400, detail=f"Too many files in zip (max {max_zip_asset_files})")
            for info in infos:
                folder_path, base = safe_zip_member_path(info.filename)
                if not base:
                    skipped.append(info.filename)
                    continue
                ext = Path(base).suffix.lower()
                if ext not in ALLOWED_BACKGROUND_EXTS:
                    skipped.append(info.filename)
                    continue
                total_uncompressed += max(0, int(info.file_size or 0))
                if total_uncompressed > max_zip_total_uncompressed_bytes:
                    raise HTTPException(status_code=400, detail="Zip expands beyond allowed size")
                if info.file_size > max_asset_upload_bytes:
                    skipped.append(info.filename)
                    continue
                try:
                    content = zf.read(info)
                except Exception:
                    skipped.append(info.filename)
                    continue
                if len(content) > max_asset_upload_bytes:
                    skipped.append(info.filename)
                    continue
                try:
                    width, height, thumb_bytes, thumb_ext = asset_image_meta_and_thumb(content)
                except HTTPException:
                    skipped.append(info.filename)
                    continue
                asset_id = uuid.uuid4().hex
                try:
                    url_path, thumb_url_path = save_asset_upload(
                        data=content,
                        thumb_bytes=thumb_bytes,
                        user_id=user_id,
                        asset_id=asset_id,
                        ext=ext,
                        thumb_ext=thumb_ext,
                        uploads_dir=uploads_dir,
                        asset_uploads_dir=asset_uploads_dir,
                    )
                except HTTPException:
                    skipped.append(info.filename)
                    continue
                display_name = Path(base).stem.replace("_", " ").strip()[:120] or "Asset"
                create_asset_record_fn(
                    asset_id=asset_id,
                    uploader_user_id=user_id,
                    name=display_name,
                    folder_path=folder_path,
                    tags=shared_tags,
                    mime=image_mime_from_ext(ext),
                    width=width,
                    height=height,
                    url_original=url_path,
                    url_thumb=thumb_url_path,
                )
                created.append(
                    {
                        "asset_id": asset_id,
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
    return created, skipped
