from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

from sqlmodel import SQLModel, Field, Session, create_engine, select


def db_url() -> str:
    # Render: mount a disk and set DATA_DIR=/var/data
    # Local dev: DATA_DIR=./data
    data_dir = os.getenv("DATA_DIR", "./data")
    os.makedirs(data_dir, exist_ok=True)
    return f"sqlite:///{os.path.join(data_dir, 'warboard.db')}"


engine = create_engine(db_url(), connect_args={"check_same_thread": False})


class RoomRow(SQLModel, table=True):
    room_id: str = Field(primary_key=True)
    state_json: str
    updated_at: str


class RoomMetaRow(SQLModel, table=True):
    room_id: str = Field(primary_key=True)
    name: str
    created_at: str


class SnapshotRow(SQLModel, table=True):
    snapshot_id: str = Field(primary_key=True)
    room_id: str = Field(index=True)
    label: str
    state_json: str
    created_at: str


def init_db() -> None:
    SQLModel.metadata.create_all(engine)


def load_room_state_json(room_id: str) -> Optional[str]:
    with Session(engine) as s:
        row = s.exec(select(RoomRow).where(RoomRow.room_id == room_id)).first()
        return row.state_json if row else None


def save_room_state_json(room_id: str, state_json: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with Session(engine) as s:
        row = s.get(RoomRow, room_id)
        if row:
            row.state_json = state_json
            row.updated_at = now
        else:
            row = RoomRow(room_id=room_id, state_json=state_json, updated_at=now)
            s.add(row)
        s.commit()


def create_room_record(room_id: str, name: str, state_json: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with Session(engine) as s:
        existing = s.get(RoomMetaRow, room_id)
        if existing:
            raise ValueError("Room already exists")
        s.add(RoomMetaRow(room_id=room_id, name=name, created_at=now))
        s.add(RoomRow(room_id=room_id, state_json=state_json, updated_at=now))
        s.commit()


def list_rooms() -> List[Dict[str, str]]:
    with Session(engine) as s:
        metas = {m.room_id: m for m in s.exec(select(RoomMetaRow)).all()}
        rows = s.exec(select(RoomRow)).all()
        out: List[Dict[str, str]] = []
        for r in rows:
            meta = metas.get(r.room_id)
            out.append(
                {
                    "room_id": r.room_id,
                    "name": meta.name if meta else r.room_id,
                    "created_at": meta.created_at if meta else r.updated_at,
                    "updated_at": r.updated_at,
                }
            )
        out.sort(key=lambda x: x["updated_at"], reverse=True)
        return out


def create_snapshot(room_id: str, label: str, state_json: str) -> str:
    snapshot_id = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()
    with Session(engine) as s:
        s.add(
            SnapshotRow(
                snapshot_id=snapshot_id,
                room_id=room_id,
                label=label,
                state_json=state_json,
                created_at=now,
            )
        )
        s.commit()
    return snapshot_id


def list_snapshots(room_id: str) -> List[Dict[str, str]]:
    with Session(engine) as s:
        snaps = s.exec(select(SnapshotRow).where(SnapshotRow.room_id == room_id)).all()
        out = [
            {"snapshot_id": x.snapshot_id, "room_id": x.room_id, "label": x.label, "created_at": x.created_at}
            for x in snaps
        ]
        out.sort(key=lambda x: x["created_at"], reverse=True)
        return out


def load_snapshot_state_json(room_id: str, snapshot_id: str) -> Optional[str]:
    with Session(engine) as s:
        row = s.get(SnapshotRow, snapshot_id)
        if not row or row.room_id != room_id:
            return None
        return row.state_json
