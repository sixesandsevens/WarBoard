#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import sys
from contextlib import contextmanager
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.storage import (  # noqa: E402
    count_private_pack_asset_rows,
    delete_private_pack_asset_rows,
    delete_private_pack_row,
    get_private_pack_by_slug,
    init_db,
)


PRIVATE_PACKS_DIR = Path(
    os.getenv("PRIVATE_PACKS_DIR", str(Path(os.getenv("DATA_DIR", "./data")) / "private_packs"))
).resolve()


def _safe_pack_dir(slug: str) -> Path:
    cleaned = str(slug or "").strip()
    if not cleaned or cleaned in {".", ".."} or "/" in cleaned or "\\" in cleaned:
        raise SystemExit(f"Refusing suspicious slug: {slug!r}")
    pack_dir = (PRIVATE_PACKS_DIR / cleaned).resolve()
    try:
        pack_dir.relative_to(PRIVATE_PACKS_DIR)
    except ValueError as exc:
        raise SystemExit(f"Refusing to operate outside private pack root: {pack_dir}") from exc
    return pack_dir


def _wipe_pack_files(pack_dir: Path) -> None:
    for name in ("originals", "thumbs"):
        target = (pack_dir / name).resolve()
        try:
            target.relative_to(pack_dir)
        except ValueError as exc:
            raise SystemExit(f"Unsafe delete target: {target}") from exc
        if target.exists():
            shutil.rmtree(target)


@contextmanager
def _pack_lock(pack_dir: Path):
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
    parser = argparse.ArgumentParser(description="Clear asset rows and optional files for a private pack.")
    parser.add_argument("--slug", required=True, help="Private pack slug.")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be deleted without changing anything.")
    parser.add_argument("--delete-files", action="store_true", help="Delete originals/ and thumbs/ for this pack.")
    parser.add_argument("--delete-pack-row", action="store_true", help="Delete the privatepackrow after asset rows are removed.")
    args = parser.parse_args()

    init_db()
    pack = get_private_pack_by_slug(str(args.slug).strip())
    if not pack or pack.pack_id is None:
        raise SystemExit(f"Private pack not found: {args.slug}")

    pack_dir = _safe_pack_dir(str(pack.slug))
    asset_row_count = count_private_pack_asset_rows(int(pack.pack_id))

    print(f"pack_id={pack.pack_id}")
    print(f"slug={pack.slug}")
    print(f"name={pack.name}")
    print(f"asset_row_count={asset_row_count}")
    print(f"pack_dir={pack_dir}")
    print(f"delete_files={int(bool(args.delete_files))}")
    print(f"delete_pack_row={int(bool(args.delete_pack_row))}")

    if args.dry_run:
        print("dry_run=1")
        return 0

    with _pack_lock(pack_dir):
        removed_rows = delete_private_pack_asset_rows(int(pack.pack_id))
        print(f"removed_rows={removed_rows}")

        if args.delete_files:
            _wipe_pack_files(pack_dir)
            print("deleted_files=1")
        else:
            print("deleted_files=0")

        if args.delete_pack_row:
            deleted_pack_row = int(bool(delete_private_pack_row(int(pack.pack_id))))
            print(f"deleted_pack_row={deleted_pack_row}")
        else:
            print("deleted_pack_row=0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
