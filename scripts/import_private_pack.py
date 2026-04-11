#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import os
import shutil
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from sqlmodel import Session

try:
    from PIL import Image, ImageOps, UnidentifiedImageError  # type: ignore
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"Pillow is required for private pack import: {exc}") from exc


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.storage import (  # noqa: E402
    PrivatePackAssetRow,
    count_private_pack_asset_rows,
    create_private_pack,
    delete_private_pack_asset_rows,
    engine,
    get_private_pack_by_slug,
    get_user_by_username,
    grant_private_pack_access,
    init_db,
    utc_now_iso,
)


ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
EXT_TO_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
MAX_ASSET_IMAGE_DIM = 12_000
MAX_ASSET_IMAGE_PIXELS = 36_000_000
THUMB_MAX_DIM = 256
MAX_SKIPPED_PREVIEW = 25
PROGRESS_EVERY = 250
PRIVATE_PACKS_DIR = Path(
    os.getenv("PRIVATE_PACKS_DIR", str(Path(os.getenv("DATA_DIR", "./data")) / "private_packs"))
)


def _normalized_name(path: Path) -> str:
    return path.stem.replace("_", " ").strip()[:120] or "Asset"


def _folder_path(root: Path, file_path: Path) -> str:
    rel_parent = file_path.relative_to(root).parent
    if str(rel_parent) == ".":
        return ""
    return "/".join(rel_parent.parts)


def _read_validate_and_thumb(path: Path) -> tuple[bytes, int, int, bytes]:
    data = path.read_bytes()
    try:
        with Image.open(io.BytesIO(data)) as img:
            img = ImageOps.exif_transpose(img)
            width, height = img.size
            thumb = img.copy()
    except UnidentifiedImageError as exc:
        raise ValueError("unsupported/corrupt image") from exc
    except Exception as exc:
        raise ValueError(f"failed to decode image: {exc}") from exc

    if width < 1 or height < 1:
        raise ValueError("invalid dimensions")
    if width > MAX_ASSET_IMAGE_DIM or height > MAX_ASSET_IMAGE_DIM:
        raise ValueError(f"dimensions exceed {MAX_ASSET_IMAGE_DIM}px max side")
    if int(width) * int(height) > MAX_ASSET_IMAGE_PIXELS:
        raise ValueError(f"pixel count exceeds {MAX_ASSET_IMAGE_PIXELS}")

    if thumb.mode not in ("RGB", "RGBA"):
        thumb = thumb.convert("RGBA")
    resample = Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS
    thumb.thumbnail((THUMB_MAX_DIM, THUMB_MAX_DIM), resample)
    out = io.BytesIO()
    thumb.save(out, format="PNG", optimize=True)
    return data, int(width), int(height), out.getvalue()


def _iter_images(source: Path):
    for p in source.rglob("*"):
        if not p.is_file():
            continue
        ext = p.suffix.lower()
        if ext not in ALLOWED_IMAGE_EXTS:
            continue
        yield p


def wipe_pack_files(pack_dir: Path) -> None:
    originals_dir = pack_dir / "originals"
    thumbs_dir = pack_dir / "thumbs"
    for target in (originals_dir, thumbs_dir):
        if target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True, exist_ok=True)


@contextmanager
def pack_lock(pack_dir: Path):
    import fcntl

    pack_dir.mkdir(parents=True, exist_ok=True)
    lock_path = pack_dir / ".pack.lock"
    with open(lock_path, "w", encoding="utf-8") as fh:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SystemExit(f"Pack is busy: {pack_dir}. Another import/cleanup is already running.") from exc
        fh.write(str(os.getpid()))
        fh.flush()
        try:
            yield
        finally:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Import a server-side private asset pack.")
    parser.add_argument("--owner", required=True, help="Owner username.")
    parser.add_argument("--slug", required=True, help="Pack slug.")
    parser.add_argument("--name", required=True, help="Pack display name.")
    parser.add_argument("--source", required=True, help="Source folder of images.")
    parser.add_argument("--mode", default="copy", choices=["copy"], help="Import mode.")
    parser.add_argument("--grant", nargs="*", default=[], help="Usernames to grant pack access.")
    parser.add_argument("--replace", action="store_true", help="Replace all existing assets in this pack before import.")
    args = parser.parse_args()

    init_db()
    PRIVATE_PACKS_DIR.mkdir(parents=True, exist_ok=True)

    source_dir = Path(args.source).expanduser().resolve()
    if not source_dir.exists() or not source_dir.is_dir():
        raise SystemExit(f"Source folder does not exist or is not a directory: {source_dir}")

    owner = get_user_by_username(str(args.owner).strip())
    if not owner or owner.user_id is None:
        raise SystemExit(f"Owner user not found: {args.owner}")

    slug = str(args.slug).strip()
    if not slug:
        raise SystemExit("Slug is required")

    pack = get_private_pack_by_slug(slug)
    root_rel = f"{slug}/originals"
    thumb_rel = f"{slug}/thumbs"
    if pack is None:
        pack = create_private_pack(
            owner_user_id=owner.user_id,
            slug=slug,
            name=str(args.name).strip()[:120] or slug,
            root_rel=root_rel,
            thumb_rel=thumb_rel,
        )
    elif int(pack.owner_user_id) != int(owner.user_id):
        raise SystemExit(
            f"Pack '{slug}' already exists with different owner_user_id={pack.owner_user_id} (expected {owner.user_id})"
        )

    if pack.pack_id is None:
        raise SystemExit("Failed to resolve pack_id")

    pack_dir = PRIVATE_PACKS_DIR / slug
    originals_dir = pack_dir / "originals"
    thumbs_dir = pack_dir / "thumbs"
    originals_dir.mkdir(parents=True, exist_ok=True)
    thumbs_dir.mkdir(parents=True, exist_ok=True)

    previous_row_count = count_private_pack_asset_rows(int(pack.pack_id))
    created_count = 0
    processed_count = 0
    removed_count = 0
    skipped: list[str] = []
    grant_missing: list[str] = []
    grant_added: list[str] = []
    source_files = list(_iter_images(source_dir))
    started_at = time.time()

    with pack_lock(pack_dir):
        if args.replace:
            removed_count = delete_private_pack_asset_rows(int(pack.pack_id))
            wipe_pack_files(pack_dir)

        print(f"source_file_count={len(source_files)}", flush=True)

        with Session(engine) as session:
            for src in source_files:
                processed_count += 1
                ext = src.suffix.lower()
                aid = uuid.uuid4().hex
                out_original = originals_dir / f"{aid}{ext}"
                out_thumb = thumbs_dir / f"{aid}_thumb.png"
                try:
                    original_bytes, width, height, thumb_bytes = _read_validate_and_thumb(src)
                    out_original.write_bytes(original_bytes)
                    out_thumb.write_bytes(thumb_bytes)
                except Exception as exc:
                    skipped.append(f"{src}: {exc}")
                    continue

                rel_folder = _folder_path(source_dir, src)
                session.add(
                    PrivatePackAssetRow(
                        asset_id=aid,
                        pack_id=int(pack.pack_id),
                        name=_normalized_name(src),
                        folder_path=rel_folder,
                        tags_json="[]",
                        mime=EXT_TO_MIME.get(ext, "application/octet-stream"),
                        width=int(width),
                        height=int(height),
                        url_original=f"/private-packs/{slug}/originals/{aid}{ext}",
                        url_thumb=f"/private-packs/{slug}/thumbs/{aid}_thumb.png",
                        created_at=utc_now_iso(),
                    )
                )
                created_count += 1
                if created_count % 200 == 0:
                    session.commit()
                if processed_count % PROGRESS_EVERY == 0:
                    elapsed = max(1.0, time.time() - started_at)
                    rate = processed_count / elapsed
                    print(
                        f"progress processed={processed_count}/{len(source_files)} created={created_count} skipped={len(skipped)} rate={rate:.1f}/s",
                        flush=True,
                    )
            session.commit()

    for username in args.grant:
        uname = str(username).strip()
        if not uname:
            continue
        user = get_user_by_username(uname)
        if not user or user.user_id is None:
            grant_missing.append(uname)
            continue
        grant_private_pack_access(int(pack.pack_id), int(user.user_id))
        grant_added.append(uname)

    print(f"pack_slug={slug}")
    print(f"pack_id={pack.pack_id}")
    print(f"replace_mode={int(bool(args.replace))}")
    print(f"removed_count={removed_count}")
    print(f"wiped_files={int(bool(args.replace))}")
    print(f"previous_row_count={previous_row_count}")
    print(f"created_count={created_count}")
    print(f"skipped_count={len(skipped)}")
    if skipped:
        print("skipped_examples:")
        for row in skipped[:MAX_SKIPPED_PREVIEW]:
            print(f"  - {row}")
    if grant_added:
        print("granted_users=" + ", ".join(grant_added))
    if grant_missing:
        print("unknown_users=" + ", ".join(grant_missing))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
