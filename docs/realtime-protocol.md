# Real-time collaboration protocol

REST endpoints live in [`openapi.yaml`](../openapi.yaml). Canvas editing and presence use a
WebSocket. The frontend's `CollabConnection` / `ServerEvent` types in
`frontend/src/services/types.ts` are the source of truth for the shapes below.

## Handshake

1. Get a `CollabCredential` (`POST /join/{token}` for guests, `POST /sessions/{id}/collab-credentials`
   for signed-in users, or `/collab-credentials/refresh`).
2. Open the socket and send `join_room` with the credential.
3. Server replies `room_joined`: `participant`, `role`, `session` (a `RoomSession`), `snapshot`
   (a `DocState`) and the current `presence` list.

## Messages

Every message carries a protocol version and a correlation or operation id.

| Direction | Type | Payload |
| --- | --- | --- |
| client -> server | `document_update` | `ops: CanvasOp[]` (max 500) |
| client -> server | `presence_update` | `cursor`, `selection` (ephemeral, never stored) |
| client -> server | `resync` | requests the authoritative snapshot (after reconnect or a rejected edit) |
| client -> server | `ping` | |
| server -> client | `document_update` | ops applied by others (changed ops only) |
| server -> client | `presence_update` / `presence_gone` | a participant's cursor and selection / left |
| server -> client | `session_updated` | new `RoomSession` (start, end, lock, prompt reveal, cursors) |
| server -> client | `removed` | participant was removed; socket closes |
| server -> client | `error` | `code` from `ErrorCode`, e.g. `EDITING_LOCKED`, `INVALID_OP` |
| server -> client | `pong` | |

## Server rules (per update, not per connection)

- Re-check credential, removal, role, session state and candidate lock on **every**
  `document_update`. Candidates may edit only while the session is `live` and editing is enabled;
  observers never; nobody once `ended` or `archived`.
- Validate every op: id lengths, finite clocks, whitelisted fields only, text <= 2000 chars,
  strokes <= 5000 points, coordinates within +/-1e7, total elements <= 5000, <= 500 ops per message.
- Apply ops idempotently; log and fan out only ops that changed state. Persist at least every 2 s,
  compacting the log into snapshots.

## Allowed element fields

`kind` (node, connector, stroke, text, sticky), `componentType`, `x`, `y`, `w`, `h`, `z`, `label`,
`description`, `fill`, `color`, `groupId`, `createdBy`, `deleted`, `from`, `to`, `connectorStyle`
(straight, elbow, curved), `arrowStart`, `arrowEnd`, `dashed`, `lineWidth` (1-32), `highlighter`,
`points` (array of `[x, y]`).

## Conflict resolution

Each `(elementId, field)` is a last-writer-wins register ordered by `(clock.t, clock.a)`. Servers
keep their own actor id and advance their clock past anything they have seen. A client that is
rejected resets to the server snapshot and tells the user; a client that reconnects merges the
server snapshot (merge is commutative) and flushes its queued ops.
