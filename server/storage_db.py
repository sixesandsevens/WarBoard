from __future__ import annotations

import os
import sqlite3

from sqlmodel import SQLModel, create_engine


def db_url() -> str:
    # Render: mount a disk and set DATA_DIR=/var/data
    # Local dev: DATA_DIR=./data
    data_dir = os.getenv("DATA_DIR", "./data")
    os.makedirs(data_dir, exist_ok=True)
    new_path = os.path.join(data_dir, "warhamster.db")
    legacy_path = os.path.join(data_dir, "warboard.db")
    # Preserve existing data when upgrading an existing deployment.
    db_path = legacy_path if (not os.path.exists(new_path) and os.path.exists(legacy_path)) else new_path
    return f"sqlite:///{db_path}"


engine = create_engine(db_url(), connect_args={"check_same_thread": False, "timeout": 3.0})


def _sqlite_conn() -> sqlite3.Connection:
    # engine.url is like sqlite:////path/to/db
    url = str(engine.url)
    assert url.startswith("sqlite:///")
    path = url.replace("sqlite:///", "", 1)
    return sqlite3.connect(path, timeout=3.0)


def _column_exists(conn: sqlite3.Connection, table: str, col: str) -> bool:
    cur = conn.execute(f"PRAGMA table_info({table})")
    return any(row[1] == col for row in cur.fetchall())


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?;", (table,))
    return cur.fetchone() is not None


def init_db() -> None:
    """
    Creates tables and performs tiny SQLite "migrations" for new columns.

    We intentionally keep this lightweight (no Alembic) for MVP.
    """
    SQLModel.metadata.create_all(engine)

    # Add columns to existing RoomMetaRow table if upgrading from earlier versions.
    try:
        conn = _sqlite_conn()
        # Harden SQLite behavior for concurrent web requests.
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=3000;")
        conn.execute("PRAGMA foreign_keys=OFF;")
        # RoomMetaRow table name defaults to "roommetarow"
        table = "roommetarow"
        if _table_exists(conn, table):
            if not _column_exists(conn, table, "owner_user_id"):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN owner_user_id INTEGER;")
            if not _column_exists(conn, table, "join_code"):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN join_code TEXT;")
                conn.execute(f"CREATE UNIQUE INDEX IF NOT EXISTS ix_roommetarow_join_code ON {table}(join_code);")
            if not _column_exists(conn, table, "session_id"):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN session_id TEXT;")
                conn.execute(f"CREATE INDEX IF NOT EXISTS ix_roommetarow_session_id ON {table}(session_id);")
            if not _column_exists(conn, table, "display_name"):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN display_name TEXT;")
            if not _column_exists(conn, table, "room_order"):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN room_order INTEGER;")
            if not _column_exists(conn, table, "archived"):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN archived BOOLEAN DEFAULT 0;")
        user_table = "userrow"
        if _table_exists(conn, user_table):
            if not _column_exists(conn, user_table, "last_room_id"):
                conn.execute(f"ALTER TABLE {user_table} ADD COLUMN last_room_id TEXT;")
                conn.execute(f"CREATE INDEX IF NOT EXISTS ix_userrow_last_room_id ON {user_table}(last_room_id);")
        asset_table = "assetrow"
        if _table_exists(conn, asset_table):
            if not _column_exists(conn, asset_table, "folder_path"):
                conn.execute(f"ALTER TABLE {asset_table} ADD COLUMN folder_path TEXT DEFAULT '';")
            # Indexes for paginated ORDER BY created_at DESC queries
            conn.execute(
                f"CREATE INDEX IF NOT EXISTS ix_assetrow_uploader_created "
                f"ON {asset_table}(uploader_user_id, created_at DESC);"
            )
            conn.execute(
                f"CREATE INDEX IF NOT EXISTS ix_assetrow_created "
                f"ON {asset_table}(created_at DESC);"
            )
        pack_asset_table = "privatepackassetrow"
        if _table_exists(conn, pack_asset_table):
            # Index for paginated ORDER BY created_at DESC queries across pack assets
            conn.execute(
                f"CREATE INDEX IF NOT EXISTS ix_privatepackassetrow_pack_created "
                f"ON {pack_asset_table}(pack_id, created_at DESC);"
            )
            conn.execute(
                f"CREATE INDEX IF NOT EXISTS ix_privatepackassetrow_created "
                f"ON {pack_asset_table}(created_at DESC);"
            )
        conn.commit()
    except Exception:
        # If anything goes sideways here, we don't want startup to fail; the app
        # can still run and new DBs will be fine.
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass
