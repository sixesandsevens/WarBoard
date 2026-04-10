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
| 1 | Extract utility helpers | `static/canvas.js` | `static/canvas/utils.js` | [x] | [x] |
| 2 | Extract HTTP/API helpers | `static/canvas.js` | `static/canvas/api.js` | [x] | [x] |
| 3 | Extract websocket lifecycle | `static/canvas.js` | `static/canvas/network.js` | [x] | [x] |
| 4 | Extract terrain subsystem | `static/canvas.js` | `static/canvas/terrain.js` | [x] | [x] |
| 5 | Extract fog subsystem | `static/canvas.js` | `static/canvas/fog.js` | [x] | [x] |
| 6 | Extract asset library/pack UI | `static/canvas.js` | `static/canvas/assets.js` | [x] | [ ] |
| 7 | Extract session/lobby/room-move UI | `static/canvas.js` | `static/canvas/sessions.js` | [x] | [ ] |
| 8 | Extract render orchestration | `static/canvas.js` | `static/canvas/render.js` | [x] | [ ] |
| 9 | Create shared state module | `static/canvas.js` | `static/canvas/state.js` | [x] | [ ] |
| 10 | Reduce canvas to bootstrap shell | `static/canvas.js` | `static/canvas/index.js` | [x] | [ ] |

---

## Backend — Phase 2: Clean up server/app.py

| Task | Description | Moved From | Moved To | Tests Run | Smoke Check |
|------|-------------|------------|----------|-----------|-------------|
| 11 | Extract upload/image/ZIP helpers | `server/app.py` | `server/upload_helpers.py` | [x] | [ ] |
| 12 | Extract auth/session utility helpers | `server/app.py` | `server/auth_helpers.py` | [x] | [ ] |
| 13 | Extract gameplay-session/room-move helpers | `server/app.py` | `server/session_helpers.py` | [x] | [ ] |

---

## Persistence — Phase 3: Split server/storage.py

| Task | Description | Moved From | Moved To | Tests Run | Smoke Check |
|------|-------------|------------|----------|-----------|-------------|
| 14 | Extract storage model definitions | `server/storage.py` | `server/storage_models.py` | [x] | [ ] |
| 15 | Extract DB engine/init/session scaffolding | `server/storage.py` | `server/storage_db.py` | [x] | [ ] |
| 16 | Extract auth persistence | `server/storage.py` | `server/storage_auth.py` | [x] | [ ] |
| 17 | Extract room/membership persistence | `server/storage.py` | `server/storage_rooms.py` | [x] | [ ] |
| 18 | Extract asset/pack persistence | `server/storage.py` | `server/storage_assets.py` | [x] | [ ] |
| 19 | Extract gameplay-session/snapshot persistence | `server/storage.py` | `server/storage_sessions.py` | [x] | [ ] |
| 20 | Add storage compatibility surface | new shim | `server/storage.py` (shim) | [x] | [ ] |

---

## Room Core — Phase 4: Split server/rooms.py event families

| Task | Description | Moved From | Moved To | Tests Run | Smoke Check |
|------|-------------|------------|----------|-----------|-------------|
| 21 | Extract room event family handlers | `server/rooms.py` | `server/room_events/` | [x] | [ ] |

---

## Documentation — Phase 5/6

| Task | Description | Target File | Done |
|------|-------------|-------------|------|
| 22 | Document websocket/event protocol | `docs/protocol.md` | [x] |
| 23 | Add architecture doc | `docs/architecture.md` | [x] |

---

## Notes

- Phase 0 complete: tests passing (163 passed, 2 skipped), smoke checklist verified by user.
- Latest git version has `static/canvas.js` already split from `static/canvas.html`. Working from this.
- Task 1 complete: 13 pure utility functions extracted to `static/canvas/utils.js`. canvas.js: 8979 → 8846 lines. Tests: 211 passed, 2 skipped.
