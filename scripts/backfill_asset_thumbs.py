#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
from pathlib import Path

from sqlmodel import Session, select

try:
    from PIL import Image, ImageOps, UnidentifiedImageError  # type: ignore
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"Pillow is required for backfill: {exc}") from exc

from server.storage import AssetRow, engine


BASE_DIR = Path(__file__).resolve().parent.parent
UPLOADS_DIR = BASE_DIR / "data" / "uploads"
THUMB_MAX_DIM = 256


def local_path_from_upload_url(url: str) -> Path | None:
    rel = str(url or "")
    if not rel.startswith("/uploads/"):
        return None
    return UPLOADS_DIR / rel.replace("/uploads/", "", 1)


def upload_url_from_local_path(path: Path) -> str:
    rel = path.relative_to(UPLOADS_DIR)
    return "/uploads/" + "/".join(rel.parts)


def build_thumb(original_bytes: bytes) -> tuple[int, int, bytes, str]:
    try:
        with Image.open(io.BytesIO(original_bytes)) as img:
            img = ImageOps.exif_transpose(img)
            width, height = img.size
            thumb = img.copy()
    except UnidentifiedImageError:
        raise ValueError("unsupported/corrupt image")

    if width < 1 or height < 1:
        raise ValueError("invalid image dimensions")
    if thumb.mode not in ("RGB", "RGBA"):
        thumb = thumb.convert("RGBA")

    if hasattr(Image, "Resampling"):
        resample = Image.Resampling.LANCZOS
    else:
        resample = Image.LANCZOS
    thumb.thumbnail((THUMB_MAX_DIM, THUMB_MAX_DIM), resample)

    try:
        out = io.BytesIO()
        thumb.save(out, format="WEBP", quality=82, method=6)
        return int(width), int(height), out.getvalue(), ".webp"
    except Exception:
        out = io.BytesIO()
        thumb.save(out, format="PNG", optimize=True)
        return int(width), int(height), out.getvalue(), ".png"


def needs_backfill(row: AssetRow) -> bool:
    if int(row.width or 0) <= 0 or int(row.height or 0) <= 0:
        return True
    if not str(row.url_thumb or "").strip():
        return True
    if str(row.url_thumb) == str(row.url_original):
        return True
    thumb_path = local_path_from_upload_url(str(row.url_thumb or ""))
    if thumb_path is None or not thumb_path.exists():
        return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill asset dimensions and thumbnail URLs/files.")
    parser.add_argument("--limit", type=int, default=0, help="Maximum assets to process (0 = no limit).")
    parser.add_argument("--dry-run", action="store_true", help="Show what would change without writing files/db.")
    args = parser.parse_args()

    processed = 0
    updated = 0
    skipped = 0
    missing = 0

    with Session(engine) as session:
        rows = session.exec(select(AssetRow)).all()
        for row in rows:
            if args.limit and processed >= args.limit:
                break
            if not needs_backfill(row):
                continue
            processed += 1

            original_path = local_path_from_upload_url(str(row.url_original or ""))
            if original_path is None or not original_path.exists():
                missing += 1
                continue

            try:
                original_bytes = original_path.read_bytes()
                width, height, thumb_bytes, thumb_ext = build_thumb(original_bytes)
            except Exception:
                skipped += 1
                continue

            thumb_dir = original_path.parent / "thumbs"
            thumb_path = thumb_dir / f"{row.asset_id}{thumb_ext}"
            thumb_url = upload_url_from_local_path(thumb_path)

            if not args.dry_run:
                thumb_dir.mkdir(parents=True, exist_ok=True)
                thumb_path.write_bytes(thumb_bytes)
                row.width = int(width)
                row.height = int(height)
                row.url_thumb = thumb_url
                session.add(row)
            updated += 1

        if not args.dry_run and updated:
            session.commit()

    print(
        f"backfill complete: processed={processed} updated={updated} "
        f"missing_original={missing} skipped_invalid={skipped} dry_run={args.dry_run}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
