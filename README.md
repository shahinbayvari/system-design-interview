# System Design Interview Platform (MVP)

Browser-based collaborative whiteboard for live system-design interviews. The whole app runs
**without a backend**: every backend call goes through one services layer, and a complete mock
implementation of it lives in the browser.

```powershell
npm install
npm run dev        # http://localhost:5173
npm test           # 88 tests (vitest)
npm run build      # typecheck + production build
```

## Try it (two tabs = two people)

1. Tab 1: sign in with any email → **New interview** → in the room click **Start interview**.
2. **Share → Create link**. Open the link in a second tab, enter a name, join.
3. Draw, drag, connect, lock candidate editing, tick **Simulate offline** in a tab, end the interview,
   then open the **Review** page.

Tabs of one browser share a mock "server" (localStorage + BroadcastChannel). Sign-in and guest
identity are per tab (sessionStorage) so one browser can play interviewer and candidate.

## The services layer

| File | Role |
| --- | --- |
| `src/services/types.ts` | **The contract.** `Services` = `auth`, `sessions`, `guestLinks`, `join`, `collab` (+ optional `dev`). The UI imports nothing else that talks to a backend. |
| `src/services/index.ts` | React context + `useServices()`. |
| `src/services/mock/backend.ts` | Mock server: authorization on every call, op validation, hashed guest tokens (256-bit), link expiry/revoke/max-uses, capacity, rate limit, audit log, op log + snapshot compaction, final snapshot on end, clear/restore. |
| `src/services/mock/infra.ts` | Storage, cross-tab bus, crypto helpers. All injectable (tests use in-memory ones). |
| `src/main.tsx` | The only place a backend is chosen. |

To go real: implement `Services` over HTTP/WebSocket and swap it in `main.tsx`.

## Collaboration model

`src/domain/canvasDoc.ts` is an operation-based, field-level last-writer-wins CRDT (Lamport clock +
actor tiebreak). Ops are idempotent and commutative, so duplicates and out-of-order delivery are
safe, and concurrent edits to different objects/fields never overwrite each other. Deletes are just
a `deleted` field. `src/collab/syncClient.ts` adds optimistic local edits, an offline queue,
resync-and-merge on reconnect, per-participant undo/redo, and drag gestures (one undo step).
If the server rejects queued changes (e.g. editing was locked meanwhile), the authoritative canvas
is shown and the user is told; server data is never overwritten.

## Not in this build

- Alignment guides, laser pointer, PNG/PDF export (JSON export is included).
- Real email magic links / SSO (mock signs in instantly), teams/orgs, dashboard search/filters.
- Resize handles for multi-selection (use the Width/Height fields), lasso for connectors.
- Mock limits: presence of a crashed tab lingers until reload; all "server" state is
  per-browser localStorage; no real network, so latency/throughput targets are not measured.
- Product decisions left open in the spec are given defaults: prompt visible on join (configurable
  per interview), candidates cannot re-enter an ended interview, only the owner can lock/end,
  timer is display-only.
