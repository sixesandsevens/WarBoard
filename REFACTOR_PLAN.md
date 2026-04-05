# Refactor Plan

Tracking doc for the canvas.js / backend extraction refactor.
Confirm with user before starting each task. Run tests + smoke check after each frontend-impacting task.

---

## Status Key
- `[ ]` not started
- `[~]` in progress
- `[x]` done

---

## Frontend — Phase 1: Split static/canvas.js

| Task | Description | Moved From | Moved To | Tests Run | Smoke Check |
|------|-------------|------------|----------|-----------|-------------|
| 1 | Extract utility helpers | `test_canvas.html` | `static/canvas/utils.js` | [x] | [ ] |
| 2 | Extract HTTP/API helpers | `test_canvas.html` | `static/canvas/api.js` | [ ] | [ ] |
| 3 | Extract websocket lifecycle | `test_canvas.html` | `static/canvas/network.js` | [ ] | [ ] |
| 4 | Extract terrain subsystem | `test_canvas.html` | `static/canvas/terrain.js` | [ ] | [ ] |
| 5 | Extract fog subsystem | `test_canvas.html` | `static/canvas/fog.js` | [ ] | [ ] |
| 6 | Extract asset library/pack UI | `test_canvas.html` | `static/canvas/assets.js` | [ ] | [ ] |
| 7 | Extract session/lobby/room-move UI | `test_canvas.html` | `static/canvas/sessions.js` | [ ] | [ ] |
| 8 | Extract render orchestration | `test_canvas.html` | `static/canvas/render.js` | [ ] | [ ] |
| 9 | Create shared state module | `test_canvas.html` | `static/canvas/state.js` | [ ] | [ ] |
| 10 | Reduce canvas to bootstrap shell | `test_canvas.html` | `static/canvas/index.js` | [ ] | [ ] |

---

## Backend — Phase 2: Clean up server/app.py

| Task | Description | Moved From | Moved To | Tests Run | Smoke Check |
|------|-------------|------------|----------|-----------|-------------|
| 11 | Extract upload/image/ZIP helpers | `server/app.py` | `server/upload_helpers.py` | [ ] | [ ] |
| 12 | Extract auth/session utility helpers | `server/app.py` | `server/auth_helpers.py` | [ ] | [ ] |
| 13 | Extract gameplay-session/room-move helpers | `server/app.py` | `server/session_helpers.py` | [ ] | [ ] |

---

## Persistence — Phase 3: Split server/storage.py

| Task | Description | Moved From | Moved To | Tests Run | Smoke Check |
|------|-------------|------------|----------|-----------|-------------|
| 14 | Extract storage model definitions | `server/storage.py` | `server/storage_models.py` | [ ] | [ ] |
| 15 | Extract DB engine/init/session scaffolding | `server/storage.py` | `server/storage_db.py` | [ ] | [ ] |
| 16 | Extract auth persistence | `server/storage.py` | `server/storage_auth.py` | [ ] | [ ] |
| 17 | Extract room/membership persistence | `server/storage.py` | `server/storage_rooms.py` | [ ] | [ ] |
| 18 | Extract asset/pack persistence | `server/storage.py` | `server/storage_assets.py` | [ ] | [ ] |
| 19 | Extract gameplay-session/snapshot persistence | `server/storage.py` | `server/storage_sessions.py` | [ ] | [ ] |
| 20 | Add storage compatibility surface | new shim | `server/storage.py` (shim) | [ ] | [ ] |

---

## Room Core — Phase 4: Split server/rooms.py event families

| Task | Description | Moved From | Moved To | Tests Run | Smoke Check |
|------|-------------|------------|----------|-----------|-------------|
| 21 | Extract room event family handlers | `server/rooms.py` | `server/room_events/` | [ ] | [ ] |

---

## Documentation — Phase 5/6

| Task | Description | Target File | Done |
|------|-------------|-------------|------|
| 22 | Document websocket/event protocol | `docs/protocol.md` | [ ] |
| 23 | Add architecture doc | `docs/architecture.md` | [ ] |

---

## Notes

- Phase 0 complete: tests passing (163 passed, 2 skipped), smoke checklist verified by user.
- Task 1 complete: 12 pure utility functions extracted to `static/canvas/utils.js`. HTML: 8042 → 7950 lines. Tests still 163/2.
- Frontend source is currently `static/test_canvas.html` (8042 lines inline `<script>`).
- `static/canvas/` directory does not exist yet — will be created in Task 1.
