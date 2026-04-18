from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from sqlmodel import Session, desc, select

from . import storage_db
from .storage_models import AuditLogRow

engine = storage_db.engine


def set_engine(value) -> None:
    global engine
    engine = value


def append_audit_log(
    *,
    actor_user_id: Optional[int],
    action: str,
    target_type: str,
    target_id: str,
    summary: str,
    before: Optional[Dict[str, Any]],
    after: Optional[Dict[str, Any]],
    now_iso: str,
) -> AuditLogRow:
    row = AuditLogRow(
        actor_user_id=actor_user_id,
        action=str(action or "").strip(),
        target_type=str(target_type or "").strip(),
        target_id=str(target_id or "").strip(),
        summary=str(summary or "").strip(),
        before_json=json.dumps(before or {}, separators=(",", ":"), sort_keys=True),
        after_json=json.dumps(after or {}, separators=(",", ":"), sort_keys=True),
        created_at=now_iso,
    )
    with Session(engine) as s:
        s.add(row)
        s.commit()
        s.refresh(row)
        return row


def list_audit_logs(
    *,
    limit: int = 100,
    actor_user_id: Optional[int] = None,
    target_type: str = "",
    target_id: str = "",
    action: str = "",
) -> List[Dict[str, Any]]:
    safe_limit = max(1, min(int(limit or 100), 500))
    with Session(engine) as s:
        stmt = select(AuditLogRow)
        if actor_user_id is not None:
            stmt = stmt.where(AuditLogRow.actor_user_id == actor_user_id)
        target_type = str(target_type or "").strip()
        if target_type:
            stmt = stmt.where(AuditLogRow.target_type == target_type)
        target_id = str(target_id or "").strip()
        if target_id:
            stmt = stmt.where(AuditLogRow.target_id == target_id)
        action = str(action or "").strip()
        if action:
            stmt = stmt.where(AuditLogRow.action.startswith(action))
        rows = s.exec(stmt.order_by(desc(AuditLogRow.created_at)).limit(safe_limit)).all()
    out: List[Dict[str, Any]] = []
    for row in rows:
        try:
            before = json.loads(row.before_json or "{}")
        except (TypeError, ValueError):
            before = {}
        try:
            after = json.loads(row.after_json or "{}")
        except (TypeError, ValueError):
            after = {}
        out.append(
            {
                "audit_id": row.audit_id,
                "actor_user_id": row.actor_user_id,
                "action": row.action,
                "target_type": row.target_type,
                "target_id": row.target_id,
                "summary": row.summary,
                "before": before,
                "after": after,
                "created_at": row.created_at,
            }
        )
    return out
