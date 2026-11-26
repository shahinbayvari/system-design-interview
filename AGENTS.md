# Instructions for coding agents

## Layout

- `frontend/` - React + TypeScript + Vite app and its tests. Run commands from this folder.
- `backend/` - backend application and its tests (not built yet).
- `docs/` - supporting documentation.
- `openapi.yaml` - the API agreement between frontend and backend. Change it first, then both sides.

## Frontend commands (run in `frontend/`)

```
npm install
npm run dev         # http://localhost:5173, uses the mock backend
npm test            # vitest; must stay green
npm run typecheck
npm run build
```

## Rules

- **All backend calls go through the services layer** (`frontend/src/services/types.ts`). UI code
  must not use `fetch`, WebSocket, `localStorage` for server data, etc. directly. Only
  `frontend/src/main.tsx` chooses which implementation is used.
- Any new backend capability: add it to `openapi.yaml`, to the `Services` interface, to the mock
  (`frontend/src/services/mock/`), and add tests.
- The mock must enforce the same rules a real server would (authorization on every call, op
  validation, hashed tokens). Do not weaken it to make the UI easier.
- Canvas state is the LWW CRDT in `frontend/src/domain/canvasDoc.ts`. Ops must stay idempotent and
  commutative; deletion is the `deleted` field. Add new element fields to `FIELD_SPECS` (validation)
  and to `docs/realtime-protocol.md`.
- Never log or store guest tokens; only their hashes.
- Keep user-visible UI accessible: named controls, visible focus, keyboard operation, color never
  the only cue.
- Run `npm run typecheck` and `npm test` before finishing. For canvas interaction changes, also try
  the app in a browser with two tabs (see `frontend/README.md`), since unit tests do not cover
  pointer interaction.
