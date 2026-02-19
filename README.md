# WarBoard

A lightweight real-time battlemap board with WebSocket rooms, token movement, drawing tools, snapshots, and GM controls.

## Local Run

1. Create and activate a virtual environment.
2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Start the server:

```bash
uvicorn server.app:app --host 0.0.0.0 --port 8000 --reload
```

4. Open the canvas client:

- `http://localhost:8000/static/test_canvas.html`

## Data Directory

SQLite storage is controlled by `DATA_DIR`.

- Default: `./data`
- Example override:

```bash
DATA_DIR=/tmp/warboard-data uvicorn server.app:app --reload
```

## GM Key

- GM claim uses `?gm_key=...` on the WebSocket URL.
- Server stores only `gm_key_hash` (SHA-256), never the raw key.
- Sensitive state excludes GM hash from `STATE_SYNC` payloads.

## APIs

- `POST /api/rooms`
- `GET /api/rooms`
- `POST /api/rooms/{id}/snapshots`
- `GET /api/rooms/{id}/snapshots`
- `POST /api/rooms/{id}/restore/{snapshot_id}`
- `GET /api/rooms/{id}/export`
- `POST /api/rooms/{id}/import`
