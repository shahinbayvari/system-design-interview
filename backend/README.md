# Backend

Not built yet. The frontend currently runs against an in-browser mock of the whole backend
(`frontend/src/services/mock/`).

A backend here must implement [`../openapi.yaml`](../openapi.yaml) and the WebSocket protocol in
[`../docs/realtime-protocol.md`](../docs/realtime-protocol.md). The mock in
`frontend/src/services/mock/backend.ts` is the executable reference for the rules (permissions,
validation, link handling, snapshots, audit events), and `frontend/tests/services.test.ts` is a
ready-made list of behaviours to reproduce.

Keep backend tests in this folder, next to the code.
