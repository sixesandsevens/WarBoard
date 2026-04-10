# Architecture Overview

This document describes the current high-level architecture of WarBoard after the refactor passes in `REFACTOR_PLAN.md`.

It is meant to answer three questions quickly:

1. Where does a given responsibility live now?
2. How does data move through the system?
3. Where should new work go without collapsing the boundaries we just created?

## System Shape

WarBoard is a FastAPI application with:

- HTTP routes for auth, rooms, assets, sessions, and uploads
- a websocket room channel for real-time board collaboration
- SQLite persistence through SQLModel
- a browser client built from modular plain JavaScript files loaded by `static/canvas.html`

At a high level:

```text
Browser UI
  -> HTTP APIs for auth, rooms, uploads, assets, sessions
  -> WebSocket /ws/{room_id} for live board events

FastAPI app
  -> helper modules for auth, uploads, session control
  -> RoomManager for live in-memory room state
  -> storage shim for persistence APIs

Storage shim
  -> storage_db / storage_auth / storage_rooms / storage_assets / storage_sessions
  -> SQLModel models + SQLite engine
```

## Backend Modules

### `server/app.py`

The main FastAPI entrypoint.

Responsibilities:

- create and configure the FastAPI app
- mount static directories
- define HTTP routes
- host the websocket endpoint at `/ws/{room_id}`
- bridge route code to helpers, room manager, and storage APIs

Design note:

- `server/app.py` now acts primarily as composition and transport glue
- domain logic that was previously embedded here has been extracted into helper modules

### `server/auth_helpers.py`

Auth/session transport helpers used by HTTP and websocket entrypoints.

Responsibilities:

- cookie naming and cookie security logic
- password hashing utilities
- request and websocket user resolution
- auth response helpers

### `server/upload_helpers.py`

Upload and image-processing helpers.

Responsibilities:

- background upload validation
- asset upload validation
- ZIP import helpers
- image metadata and thumbnail generation
- path safety for extracted assets

### `server/session_helpers.py`

Gameplay-session helper logic that is not itself persistence.

Responsibilities:

- build session summary payloads for the client
- room/session display helpers
- broadcast session-scoped messages across active rooms
- handle session room-move control messages

This module is the transport/business-logic counterpart to the persistence functions in `server/storage_sessions.py`.

### `server/rooms.py`

Owns live in-memory room state and websocket event orchestration.

Responsibilities:

- room lifecycle in memory
- socket registration and presence tracking
- autosave scheduling
- permission helpers for GM/player capabilities
- event dispatch for live board mutations

Important design point:

- `RoomManager` is still the central coordinator
- event-family logic has been extracted into `server/room_events/`
- shared helpers remain on `RoomManager` so the extracted handlers can stay behavior-preserving instead of re-architecting state access

### `server/room_events/`

Event-family modules extracted from `server/rooms.py`.

Current layout:

- `history.py`
  `UNDO`, `REDO`
- `tokens.py`
  token create/move/delete/edit/group/badge flows
- `settings.py`
  room settings and terrain/background toggles
- `drawing.py`
  strokes, shapes, eraser
- `assets.py`
  placed asset instances on the board
- `environment.py`
  terrain paint and fog-of-war
- `roles.py`
  co-GM management

These modules are intentionally thin procedural handlers that operate on `RoomManager` and `Room` objects passed in from `server/rooms.py`.

## Persistence Layer

### `server/storage.py`

Compatibility surface for the rest of the app.

Responsibilities:

- preserve the old import surface used by routes, tests, and helpers
- expose model classes and storage functions from one stable module
- sync the currently active `engine` into extracted storage modules before delegating

This is now intentionally a shim, not the primary home of persistence logic.

### `server/storage_models.py`

SQLModel table definitions.

Current model families:

- room state and room metadata
- snapshots
- users and sessions
- gameplay sessions and session membership
- room membership
- uploaded assets
- private packs and entitlements
- session-shared pack links

### `server/storage_db.py`

Database bootstrap and SQLite-specific setup.

Responsibilities:

- database URL creation
- SQLModel engine creation
- lightweight schema initialization and SQLite migration shims

### `server/storage_auth.py`

Persistence for:

- users
- password updates
- session creation/deletion
- user lookup by session id

### `server/storage_rooms.py`

Persistence for:

- room state JSON
- room metadata
- join codes
- room membership
- room lists per user

### `server/storage_assets.py`

Persistence for:

- uploaded asset records
- private pack records
- private pack entitlements
- asset library listing and filtering

This module takes session-sharing collaborators as injected callables where needed, which keeps session-sharing ownership in the session storage module.

### `server/storage_sessions.py`

Persistence for:

- gameplay sessions
- session membership and roles
- session rooms
- snapshots
- session-shared private packs

This module is the persistence-side owner of session and snapshot behavior.

## Shared Data Models

### `server/models.py`

Defines the application’s shared Pydantic models.

Important models:

- `WireEvent`
  websocket envelope
- `RoomState`
  authoritative board state
- `Token`
- `Stroke`
- `Shape`
- `AssetInstance`
- `TerrainPaintState`, `TerrainStroke`
- `FogPaintState`, `FogStroke`

`RoomState` is the center of the live collaboration model. It is:

- stored in memory while a room is active
- serialized to JSON for persistence
- sent to clients via `STATE_SYNC`

## Frontend Modules

The canvas client is still plain JavaScript, but it is no longer a single monolith.

### Entry files

- `static/canvas.html`
  UI shell and script loading order
- `static/canvas.js`
  compatibility/bootstrap shell
- `static/canvas/index.js`
  main app orchestration and remaining top-level glue

### Split modules

- `static/canvas/state.js`
  shared client-side mutable state
- `static/canvas/api.js`
  HTTP helpers and asset URL normalization
- `static/canvas/network.js`
  websocket lifecycle and network coordination
- `static/canvas/render.js`
  render orchestration
- `static/canvas/assets.js`
  asset library and related UI logic
- `static/canvas/sessions.js`
  auth/session/lobby/room-move client flows
- `static/canvas/terrain.js`
  terrain subsystem
- `static/canvas/fog.js`
  fog subsystem
- `static/canvas/utils.js`
  general utilities and UI helpers

The frontend remains global-script based, which keeps the runtime model simple, but the fault lines are now much more explicit.

## Runtime Flows

### 1. HTTP request flow

Typical path:

```text
Browser
  -> FastAPI route in server/app.py
  -> helper module(s) if needed
  -> storage shim
  -> storage domain module
  -> SQLite / SQLModel
```

Examples:

- login/register:
  `app.py` -> `auth_helpers.py` + `storage_auth.py`
- room create/join/rename/delete:
  `app.py` -> `storage_rooms.py` and `storage_sessions.py`
- asset upload/import:
  `app.py` -> `upload_helpers.py` -> `storage_assets.py`

### 2. WebSocket room flow

Typical path:

```text
Browser
  -> /ws/{room_id}
  -> app.py websocket endpoint
  -> RoomManager
  -> room_events handler
  -> RoomState mutation
  -> broadcast authoritative event
```

Key details:

- room membership is checked before accepting the socket
- `RoomManager` loads or creates the room state
- the client receives `STATE_SYNC`, `HELLO`, and `PRESENCE`
- incoming board events are dispatched by family
- successful mutations are broadcast to the room
- autosave writes the full `RoomState` JSON back to persistence

### 3. Session room-move flow

This is separate from normal board mutation dispatch.

Path:

```text
Browser websocket event
  -> app.py websocket endpoint
  -> session_helpers.handle_session_control_event()
  -> broadcasts session-scoped move offer / force / notice
```

This keeps session-control messaging from getting mixed into board-state mutation handlers.

### 4. Persistence flow for active rooms

Active rooms are in-memory first.

Path:

```text
load_room_state_json()
  -> RoomManager keeps RoomState in memory
  -> event handlers mutate RoomState
  -> autosave debounce
  -> save_room_state_json()
```

This means:

- websocket interactions are fast and local to memory
- persistence is eventual over a short debounce window
- the database is the durable snapshot, not the live source of truth during a connected session

## Architectural Boundaries

These are the boundaries the refactor established and that future work should try to preserve.

### `app.py` should stay transport-oriented

Good fits:

- request parsing
- route wiring
- websocket handshake
- calling helpers and storage functions

Avoid adding:

- large chunks of upload processing
- session-control business logic
- persistence implementation details
- room mutation logic

### `rooms.py` should stay orchestration-oriented

Good fits:

- room lifecycle
- shared permission helpers
- autosave and presence behavior
- dispatch to event-family handlers

Avoid adding:

- new giant inline event families
- persistence-specific DB logic
- HTTP concerns

### `storage.py` should stay a compatibility surface

Good fits:

- preserving stable imports
- forwarding to storage submodules
- re-exporting models and functions

Avoid adding:

- new raw SQLModel implementation blocks
- large domain-specific persistence logic directly in the shim

### `room_events/` should own mutation families

When adding a new websocket event, the preferred home is:

- existing family module if it clearly belongs there
- a new event-family module if it introduces a new concern

### Frontend modules should follow feature seams, not convenience

Examples:

- rendering work goes to `render.js`
- websocket behavior goes to `network.js`
- session UI and room-move UX go to `sessions.js`
- asset library and asset-specific UI go to `assets.js`

## Testing and Safety Rails

The refactor has been anchored by these suites:

- `tests/test_storage.py`
- `tests/test_rooms.py`
- `tests/test_app_http.py`

These tests cover:

- storage behavior and compatibility surface
- room event handling and permissions
- HTTP routes and websocket integration behavior

For frontend-impacting work, there is also a manual smoke checklist tracked in `REFACTOR_PLAN.md`.

## Current Tradeoffs

The current architecture is intentionally pragmatic.

What it optimizes for:

- preserving behavior during extraction
- keeping the import surface stable
- making major code regions easier to navigate
- avoiding a large redesign while the system is still moving

What remains intentionally imperfect:

- the frontend is still global-script based rather than module-bundled
- `RoomManager` still exposes internal helper methods used by event modules
- `server/storage.py` remains a shim instead of disappearing entirely
- some protocol details are documented rather than enforced by stricter typed payload models

Those tradeoffs are acceptable for the current stage because they keep the system understandable while reducing monolith pressure.

## Where To Extend Next

Good extension points:

- new persistence logic:
  add it to the appropriate `storage_*` module and re-export via `storage.py`
- new websocket board event:
  add it to the right `room_events/*` module and dispatch from `RoomManager.apply_event()`
- new session-control websocket behavior:
  add it to `session_helpers.py`
- new upload/import behavior:
  add it to `upload_helpers.py`
- new client feature around a clear subsystem:
  extend the corresponding `static/canvas/*` module rather than `index.js`
