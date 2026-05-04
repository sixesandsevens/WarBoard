# WarHamster

WarHamster is a FastAPI + WebSocket virtual tabletop focused on lightweight, real-time battlemap play.

It is intentionally not a big framework. The goal is to get a board up quickly, move tokens, sketch over it, and keep remote tabletop nights running.

## What Ships In This Repo

- Python backend (`server/`) for auth, rooms, persistence, uploads, and realtime sync
- Browser client (`static/canvas.html`) for the board UI
- Lobby/dashboard (`static/app.html`) plus login/register UI (`static/login.html`)
- SQLite-backed persistence under `DATA_DIR`

## Current Capabilities

- Account auth with session cookies (`register`, `login`, `logout`, `me`)
- Lobby flow for creating rooms and joining by code (`WHAM-XXXXXX`)
- Membership-gated rooms over WebSocket (`/ws/{room_id}`)
- Owner/GM authorization model:
  - room owner is always GM
  - legacy shared `gm_key` is still supported
- Realtime state sync for:
  - tokens
  - freehand strokes
  - shapes (including text)
  - placed image assets
  - scene/background/grid + layer visibility settings
- Undo/redo and autosave of room state
- Snapshots (create/list/fetch snapshot payload)
- Asset library:
  - per-user uploads
  - ZIP bulk import with limits/validation
  - optional private pack assets merged into the user library

## Run Locally

Requirements: Python 3.10+

```bash
pip install -r requirements.txt
uvicorn server.app:app --host 0.0.0.0 --port 8000 --reload
```

Open:

- `http://localhost:8000/static/login.html` (recommended start)
- `http://localhost:8000/app` (lobby, requires login)
- `http://localhost:8000/static/canvas.html` (board client)

Default flow:

1. Register or log in.
2. Create a room from `/app`.
3. Share the join link (`/join/{join_code}`) with players.
4. Everyone opens the board URL and connects via WebSocket.

## Configuration

### `DATA_DIR`

Directory for SQLite DB and uploads.

- Default: `./data`
- DB path: `${DATA_DIR}/warhamster.db`

Example:

```bash
DATA_DIR=/tmp/warhamster-data uvicorn server.app:app --reload
```

### `PRIVATE_PACKS_DIR`

Overrides the private-pack filesystem root (if you use private packs).

```bash
PRIVATE_PACKS_DIR=/srv/warhamster/private_packs uvicorn server.app:app --reload
```

### Upload/Import Limits

Environment-tunable ZIP limits:

- `MAX_ZIP_UPLOAD_BYTES` (default `512MB`)
- `MAX_ZIP_ASSET_FILES` (default `2000`)
- `MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES` (default `1GB`)

Other fixed defaults in code:

- single background upload: `10MB`
- single asset upload: `20MB`

## Project Layout

- `server/app.py`: FastAPI app, auth gate middleware, HTTP routes, WebSocket endpoint
- `server/rooms.py`: room lifecycle, event application, authorization, autosave/history
- `server/storage.py`: SQLModel schema + SQLite persistence helpers
- `server/models.py`: Pydantic wire/state models
- `static/canvas.html`: main board UI
- `static/app.html`: room lobby/dashboard
- `static/login.html`, `static/login.js`, `static/login.css`: auth UI
- `scripts/import_private_pack.py`: import server-side private pack assets
- `scripts/backfill_asset_thumbs.py`: rebuild missing thumbnails/metadata
- `tests/`: HTTP + storage + realtime room behavior tests

## Testing

```bash
pip install -r requirements-dev.txt
pytest
```

## Notes

- The frontend is currently plain HTML/CSS/JS files (not a bundled SPA).
- The room manager is in-memory in a single process; multi-worker deployments would need shared realtime infrastructure.
