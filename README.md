# WarHamster

WarHamster is a FastAPI + WebSocket virtual tabletop focused on lightweight real-time battlemap play.

The project currently ships as:
- a Python backend (`server/`) for auth, rooms, persistence, and realtime sync,
- a browser canvas client (`static/canvas.html`),
- a lobby/dashboard (`static/app.html`) and login/register UI (`static/login.html`),
- SQLite-backed persistence under `DATA_DIR`.

## Current Capabilities

- Account auth with session cookies (`register`, `login`, `logout`, `me`).
- Lobby flow for creating rooms and joining by code (`WHAM-XXXXXX`).
- Membership-gated rooms over WebSocket (`/ws/{room_id}`).
- Owner/GM authorization model:
  - room owner is always GM,
  - legacy shared `gm_key` is still supported.
- Realtime state sync for:
  - tokens,
  - freehand strokes,
  - shapes (including text),
  - placed image assets,
  - scene/background/grid + layer visibility settings.
- Undo/redo and autosave of room state.
- Snapshots (create/list/fetch snapshot payload).
- Asset library:
  - per-user uploads,
  - ZIP bulk import with limits/validation,
  - private pack assets merged into user library.

## Project Layout

- `server/app.py`: FastAPI app, auth gate middleware, HTTP routes, WebSocket endpoint.
- `server/rooms.py`: room lifecycle, event application, authorization, autosave/history.
- `server/storage.py`: SQLModel schema + SQLite persistence helpers.
- `server/models.py`: Pydantic wire/state models.
- `static/canvas.html`: main board UI.
- `static/app.html`: room lobby/dashboard.
- `static/login.html`, `static/login.js`, `static/login.css`: auth UI.
- `scripts/import_private_pack.py`: import server-side private pack assets.
- `scripts/backfill_asset_thumbs.py`: rebuild missing thumbnails/metadata.
- `tests/`: HTTP + storage + realtime room behavior tests.

## Requirements

- Python 3.10+

Install runtime deps:

```bash
pip install -r requirements.txt
```

Install dev/test deps:

```bash
pip install -r requirements-dev.txt
```

## Run Locally

```bash
uvicorn server.app:app --host 0.0.0.0 --port 8000 --reload
```

Open:
- `http://localhost:8000/static/login.html` (recommended start)
- `http://localhost:8000/app` (lobby, requires login)
- `http://localhost:8000/static/canvas.html` (board client)

### Default Local Flow

1. Register or log in.
2. Create a room from `/app`.
3. Share the join link (`/join/{join_code}`) with players.
4. Everyone enters the board URL for that room and connects via WebSocket.

## Configuration

### `DATA_DIR`

Directory for SQLite DB and uploads.

- Default: `./data`
- DB path: `${DATA_DIR}/warhamster.db` (existing deployments automatically reuse the legacy DB filename)
- Upload roots include:
  - `${DATA_DIR}/uploads/backgrounds`
  - `${DATA_DIR}/uploads/assets`
  - `${DATA_DIR}/private_packs` (unless overridden)

Example:

```bash
DATA_DIR=/tmp/warhamster-data uvicorn server.app:app --reload
```

### `PRIVATE_PACKS_DIR`

Overrides private-pack filesystem root.

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

## Auth + Access Model

- Most routes require login via session cookie (`warhamster_sid`).
- Public paths include:
  - `/api/auth/*`
  - `/api/packs`, `/api/packs/{pack_id}`
  - `/static/login*`, `/static/canvas.html`, `/packs/*`
- Room operations are membership-protected.
- GM-only operations require room ownership or valid `gm_key`.

## HTTP API (Implemented)

### Auth

- `GET /api/me`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`

### Packs and Assets

- `GET /api/packs`
- `GET /api/packs/{pack_id}`
- `GET /api/assets`
- `GET /api/assets/file/{asset_id}`
- `POST /api/assets/upload` (multipart; requires `python-multipart`)
- `POST /api/assets/upload-zip` (multipart; requires `python-multipart`)
- `DELETE /api/assets/{asset_id}`

### Rooms and Membership

- `GET /api/my/rooms`
- `POST /api/rooms`
- `POST /api/join`
- `PATCH /api/rooms/{room_id}`
- `DELETE /api/rooms/{room_id}`
- `POST /api/rooms/{room_id}/background-upload` (multipart; GM-only)

### Snapshots

- `GET /api/rooms/{room_id}/snapshots`
- `POST /api/rooms/{room_id}/snapshots`
- `GET /api/snapshots/{snapshot_id}`

### WebSocket

- `WS /ws/{room_id}`

Client sends JSON envelopes:

```json
{"type":"EVENT_NAME","payload":{}}
```

Implemented event families include:
- sync/lifecycle: `REQ_STATE_SYNC`, `STATE_SYNC`, `HELLO`, `PRESENCE`, `HEARTBEAT`
- room config: `ROOM_SETTINGS`, `UNDO`, `REDO`
- tokens: `TOKEN_CREATE`, `TOKEN_MOVE`, `TOKENS_MOVE`, `TOKEN_DELETE`, `TOKEN_RENAME`, `TOKEN_SET_SIZE`, `TOKEN_ASSIGN`, `TOKEN_SET_LOCK`, `TOKEN_SET_GROUP`, `TOKEN_BADGE_TOGGLE`
- drawing/shapes: `STROKE_ADD`, `STROKE_DELETE`, `STROKE_SET_LOCK`, `ERASE_AT`, `SHAPE_ADD`, `SHAPE_UPDATE`, `SHAPE_DELETE`, `SHAPE_SET_LOCK`
- map assets: `ASSET_INSTANCE_CREATE`, `ASSET_INSTANCE_UPDATE`, `ASSET_INSTANCE_DELETE`
- errors: `ERROR`

Server includes per-client rate limiting for high-frequency operations.

## Testing

Run all tests:

```bash
pytest
```

Test suites cover:
- storage layer behavior,
- HTTP route behavior (auth, room CRUD, snapshots, asset file serving),
- room event logic and permissions.

## Notes

- The frontend is currently plain HTML/CSS/JS files, not a bundled SPA framework.
- SQLite migrations are lightweight and handled at startup in `init_db()`.
- This is a single-process in-memory room manager; running multiple worker processes requires additional shared realtime infrastructure.
