# WebSocket and Event Protocol

This document describes the live room protocol used by the WarBoard client and server.

It focuses on the `WireEvent` envelope exchanged over the room websocket, plus the session-control messages that share the same channel.

## Transport

- Endpoint: `/ws/{room_id}`
- Auth: existing authenticated session cookie is required
- Membership: the user must already be a room member, or be eligible through session membership via `ensure_room_membership_for_user()`
- Optional query param: `gm_key`
  Used only for legacy GM-key room ownership fallback

## Envelope

All websocket messages use the same JSON shape:

```json
{
  "type": "TOKEN_MOVE",
  "payload": {
    "id": "t1",
    "x": 240,
    "y": 180
  },
  "client_id": null,
  "ts": null
}
```

Fields:

- `type`: string event name
- `payload`: object payload for the event
- `client_id`: optional metadata, currently unused by the live room flow
- `ts`: optional metadata, currently unused by the live room flow

## Connection Lifecycle

After a successful websocket connect, the server sends these direct messages to the connecting client:

1. `STATE_SYNC`
2. `HELLO`
3. `PRESENCE`

After that, the server broadcasts to the room:

- `STATE_SYNC` if GM ownership changed during connect
- `HELLO` announcing the new client
- `PRESENCE` with the updated client list

On disconnect, the server broadcasts a fresh `PRESENCE` event if the room remains active.

If a room is deleted while clients are connected, the server sends `SESSION_SYSTEM_NOTICE` and closes those sockets.

## Handshake Payloads

### `STATE_SYNC`

Full authoritative room state snapshot.

Notes:

- `gm_key_hash` is excluded from the payload
- This is the primary resync message after connect, undo, redo, and explicit sync requests

Example:

```json
{
  "type": "STATE_SYNC",
  "payload": {
    "room_id": "abc12345",
    "version": 12,
    "gm_id": "alice",
    "gm_user_id": 1,
    "co_gm_ids": [],
    "co_gm_user_ids": [],
    "allow_players_move": true,
    "allow_all_move": false,
    "lockdown": false,
    "background_mode": "terrain",
    "background_url": null,
    "terrain_seed": 12345,
    "terrain_style": "grassland",
    "layer_visibility": {
      "grid": true,
      "drawings": true,
      "shapes": true,
      "assets": true,
      "tokens": true,
      "interiors": true
    },
    "tokens": {},
    "strokes": {},
    "shapes": {},
    "assets": {},
    "interiors": {},
    "interior_edges": {},
    "draw_order": {
      "strokes": [],
      "shapes": [],
      "assets": [],
      "interiors": []
    },
    "terrain_paint": {
      "base_material_id": null,
      "materials": {},
      "strokes": {},
      "undo_stack": []
    },
    "fog_paint": {
      "enabled": false,
      "default_mode": "clear",
      "strokes": {},
      "undo_stack": []
    }
  }
}
```

### `HELLO`

Direct `HELLO` to the connecting client includes identity and privilege context:

- `client_id`
- `room_id`
- `is_gm`
- `is_co_gm`
- `gm_key_set`
- `username`
- `session`

The broadcast `HELLO` sent to the room is smaller and currently contains:

- `client_id`
- `room_id`

The `session` field is either `null` or a summary object with:

- session id and name
- current user role
- room list with occupancy and join codes
- member list
- current room summary

### `PRESENCE`

Current connected client identities for the room:

- `clients`
- `gm_id`
- `co_gm_ids`
- `room_id`

## Keepalive

Client sends:

```json
{"type":"HEARTBEAT","payload":{}}
```

Server replies:

```json
{"type":"HEARTBEAT","payload":{"ts":1712345678.123}}
```

Behavior:

- websocket reads time out after `35` seconds
- on heartbeat, the server periodically re-checks session validity
- if the session is no longer valid, the socket is closed with code `1008`

## Event Families

The live board protocol is grouped by handler family in `server/room_events/`.

### Sync and history

- `REQ_STATE_SYNC`
  Client asks for a full authoritative state refresh
  Server returns `STATE_SYNC`
- `UNDO`
  GM only
  Server returns `STATE_SYNC`
- `REDO`
  GM only
  Server returns `STATE_SYNC`

### Room settings

- `ROOM_SETTINGS`
  GM only
  Updates:
  `allow_players_move`, `allow_all_move`, `lockdown`, `background_url`, `background_mode`, `terrain_seed`, `terrain_style`, `layer_visibility`
  Server returns normalized `ROOM_SETTINGS`

### Token events

- `TOKEN_CREATE`
- `TOKEN_MOVE`
- `TOKENS_MOVE`
- `TOKEN_DELETE`
- `TOKEN_ASSIGN`
- `TOKEN_RENAME`
- `TOKEN_SET_SIZE`
- `TOKEN_SET_LOCK`
- `TOKEN_SET_GROUP`
- `TOKEN_BADGE_TOGGLE`

Important token rules:

- GM can move and edit any token
- non-GM movement depends on `lockdown`, token `locked`, `allow_all_move`, `allow_players_move`, and token ownership
- `TOKEN_MOVE` rejection is not an `ERROR`
  The server replies with `TOKEN_MOVE` including authoritative coordinates and `rejected: true`
- `TOKENS_MOVE` may partially apply and return:
  `rejected`, `partial`, `rejected_ids`, `move_seq`, `move_client`
- valid badges are:
  `downed`, `poisoned`, `stunned`, `burning`, `bleeding`, `prone`

### Stroke and eraser events

- `STROKE_ADD`
- `STROKE_DELETE`
- `STROKE_SET_LOCK`
- `ERASE_AT`

Notes:

- strokes support `layer` in `map | draw | notes`
- strokes support `layer_band` in `below_assets | above_assets`
- `ERASE_AT` can remove strokes, shapes, and tokens in one request
- non-GM erasing is constrained by creator ownership and lock state

### Shape events

- `SHAPE_ADD`
- `SHAPE_UPDATE`
- `SHAPE_DELETE`
- `SHAPE_SET_LOCK`

Notes:

- shape types are `rect`, `circle`, `line`, `text`
- text shapes require non-empty `text`
- shapes support the same `layer` and `layer_band` concepts as strokes
- `SHAPE_DELETE` for unauthorized players is effectively a no-op response, not a hard error

### Asset instance events

- `ASSET_INSTANCE_CREATE`
- `ASSET_INSTANCE_UPDATE`
- `ASSET_INSTANCE_DELETE`

Notes:

- instance placement is GM-only unless `allow_all_move` is enabled
- `source` may be `upload` or `pack`
- pack-backed instances are normalized to `/api/assets/file/{asset_id}`
- non-GM edits and deletes depend on lockdown, lock state, `allow_all_move`, and creator ownership

### Interior events

- `INTERIOR_ADD`
- `INTERIOR_UPDATE`
- `INTERIOR_DELETE`
- `INTERIOR_SET_LOCK`
- `INTERIOR_EDGE_SET`

Notes:

- GM and co-GM only in v1
- interiors persist room rectangles and edge overrides, not resolved walls
- shared wall suppression is resolved client-side from axis-aligned grid-snapped rectangles
- edge override modes are `auto`, `wall`, `open`, `door`

### Terrain events

- `TERRAIN_STROKE_ADD`
- `TERRAIN_STROKE_UNDO`

Notes:

- GM only
- terrain stroke `op` is `paint` or `erase`
- the server enforces per-stroke point limits and per-room stroke count limits

### Fog events

- `FOG_SET_ENABLED`
- `FOG_RESET`
- `FOG_STROKE_ADD`

Notes:

- GM only
- fog stroke `op` is `cover` or `reveal`
- `FOG_SET_ENABLED` and `FOG_RESET` maintain `default_mode` as `clear` or `covered`

### Co-GM role events

- `COGM_ADD`
- `COGM_REMOVE`
- `COGM_UPDATE`

Notes:

- only the primary GM may manage co-GMs
- the primary GM cannot be added as a co-GM
- server returns `COGM_UPDATE`

### Session room-move control events

These do not go through `RoomManager.apply_event()`. They are intercepted in the websocket endpoint and handled by `server/session_helpers.py`.

Client-initiated:

- `SESSION_ROOM_MOVE_REQUEST`
- `SESSION_ROOM_MOVE_FORCE`
- `SESSION_ROOM_MOVE_ACCEPT`

Server-generated:

- `SESSION_ROOM_MOVE_OFFER`
- `SESSION_ROOM_MOVE_EXECUTE`
- `SESSION_SYSTEM_NOTICE`

Rules:

- only `gm` and `co_gm` may send `SESSION_ROOM_MOVE_REQUEST` or `SESSION_ROOM_MOVE_FORCE`
- only `player` may send `SESSION_ROOM_MOVE_ACCEPT`
- target room must belong to the referenced gameplay session

Behavior:

- `SESSION_ROOM_MOVE_REQUEST`
  Broadcasts `SESSION_ROOM_MOVE_OFFER` to session players
  Also emits a `SESSION_SYSTEM_NOTICE`
- `SESSION_ROOM_MOVE_FORCE`
  Broadcasts `SESSION_ROOM_MOVE_EXECUTE` to session players
  Also emits a `SESSION_SYSTEM_NOTICE`
- `SESSION_ROOM_MOVE_ACCEPT`
  Emits a `SESSION_SYSTEM_NOTICE`

## Error Handling

When an event fails validation or authorization, the server usually replies with:

```json
{
  "type": "ERROR",
  "payload": {
    "message": "Human readable reason"
  }
}
```

Notable exceptions:

- rejected `TOKEN_MOVE` returns `TOKEN_MOVE` with `rejected: true`
- some delete-style operations return a no-op success payload instead of `ERROR`
  Example: empty `STROKE_DELETE`, missing `ASSET_INSTANCE_DELETE`, unauthorized `SHAPE_DELETE`

## Rate Limits

The websocket endpoint applies simple per-socket in-memory limits:

- sync requests:
  `REQ_STATE_SYNC`
  6 events per 30 seconds
- move/update requests:
  `TOKEN_MOVE`, `SHAPE_UPDATE`, `ASSET_INSTANCE_UPDATE`, `INTERIOR_UPDATE`
  60 events per second
- erase requests:
  `ERASE_AT`
  30 events per second
- create requests:
  `TOKEN_CREATE`, `STROKE_ADD`, `SHAPE_ADD`, `ASSET_INSTANCE_CREATE`, `INTERIOR_ADD`, `FOG_STROKE_ADD`
  20 events per second

Rate-limited requests receive:

```json
{"type":"ERROR","payload":{"message":"rate limited"}}
```

## Current Event Type List

Declared in [server/models.py](/home/sixesandsevens/Projects/WarBoard/server/models.py):

- `HEARTBEAT`
- `REQ_STATE_SYNC`
- `HELLO`
- `PRESENCE`
- `STATE_SYNC`
- `ROOM_SETTINGS`
- `UNDO`
- `REDO`
- `TOKEN_CREATE`
- `TOKEN_MOVE`
- `TOKENS_MOVE`
- `TOKEN_DELETE`
- `TOKEN_RENAME`
- `TOKEN_SET_SIZE`
- `TOKEN_ASSIGN`
- `TOKEN_SET_LOCK`
- `TOKEN_SET_GROUP`
- `TOKEN_BADGE_TOGGLE`
- `STROKE_ADD`
- `STROKE_DELETE`
- `STROKE_SET_LOCK`
- `ERASE_AT`
- `SHAPE_ADD`
- `SHAPE_UPDATE`
- `SHAPE_DELETE`
- `SHAPE_SET_LOCK`
- `ASSET_INSTANCE_CREATE`
- `ASSET_INSTANCE_UPDATE`
- `ASSET_INSTANCE_DELETE`
- `INTERIOR_ADD`
- `INTERIOR_UPDATE`
- `INTERIOR_DELETE`
- `INTERIOR_SET_LOCK`
- `INTERIOR_EDGE_SET`
- `TERRAIN_STROKE_ADD`
- `TERRAIN_STROKE_UNDO`
- `FOG_STATE_SYNC`
- `FOG_STROKE_ADD`
- `FOG_RESET`
- `FOG_SET_ENABLED`
- `COGM_ADD`
- `COGM_REMOVE`
- `COGM_UPDATE`
- `SESSION_ROOM_MOVE_REQUEST`
- `SESSION_ROOM_MOVE_FORCE`
- `SESSION_ROOM_MOVE_OFFER`
- `SESSION_ROOM_MOVE_EXECUTE`
- `SESSION_ROOM_MOVE_ACCEPT`
- `SESSION_SYSTEM_NOTICE`
- `ERROR`

## Notes and Gaps

- `FOG_STATE_SYNC` is declared in `EventType` but is not currently emitted by the websocket server
- the protocol is intentionally authoritative
  Clients may send optimistic updates, but the server remains the source of truth
- most board mutation success cases are broadcast back to all room sockets, including the initiating client
