/** High-level canvas editing operations built on `SyncClient.mutate`. */
import type { CanvasElement, ConnectorStyle, Json } from '../domain/canvasDoc';
import { newId } from '../domain/id';
import type { ComponentDef } from '../domain/palette';
import { STICKY_COLORS } from '../domain/palette';
import type { SyncClient, Change } from './syncClient';

const base = (c: SyncClient) => ({ createdBy: c.me, z: c.doc.maxZ() + 1 });

export function addNode(c: SyncClient, def: ComponentDef, x: number, y: number): string | null {
  const id = newId();
  const ok = c.mutate([{
    id,
    fields: {
      kind: 'node', componentType: def.type, x, y, w: def.w, h: def.h,
      label: def.label, description: '', fill: def.fill, ...base(c),
      // boundaries sit behind whatever they group
      ...(def.type === 'boundary' ? { z: c.doc.minZ() - 1 } : {}),
    },
  }]);
  return ok ? id : null;
}

export function addText(c: SyncClient, x: number, y: number, label = 'Text'): string | null {
  const id = newId();
  const ok = c.mutate([{ id, fields: { kind: 'text', x, y, w: 120, h: 32, label, color: '#0f172a', ...base(c) } }]);
  return ok ? id : null;
}

export function addSticky(c: SyncClient, x: number, y: number, color = STICKY_COLORS[0]): string | null {
  const id = newId();
  const ok = c.mutate([{ id, fields: { kind: 'sticky', x, y, w: 160, h: 120, label: 'Note', fill: color, ...base(c) } }]);
  return ok ? id : null;
}

export function addConnector(
  c: SyncClient,
  from: string,
  to: string,
  style: ConnectorStyle = 'straight',
): string | null {
  if (from === to) return null;
  const a = c.doc.get(from), b = c.doc.get(to);
  if (!a || !b || a.kind === 'connector' || b.kind === 'connector' || a.kind === 'stroke' || b.kind === 'stroke') return null;
  const id = newId();
  const ok = c.mutate([{
    id,
    fields: {
      kind: 'connector', from, to, connectorStyle: style, arrowStart: false, arrowEnd: true,
      dashed: false, lineWidth: 2, color: '#334155', label: '', x: 0, y: 0, w: 0, h: 0, ...base(c),
    },
  }]);
  return ok ? id : null;
}

export function addStroke(
  c: SyncClient,
  points: [number, number][],
  color: string,
  lineWidth: number,
  highlighter = false,
): string | null {
  if (points.length === 0) return null;
  const id = newId();
  const ok = c.mutate([{
    id,
    fields: { kind: 'stroke', points, color, lineWidth, highlighter, x: 0, y: 0, w: 0, h: 0, label: '', ...base(c) },
  }]);
  return ok ? id : null;
}

/** Connectors attached to any of `ids`. */
export function connectorsOf(c: SyncClient, ids: Iterable<string>): CanvasElement[] {
  const set = new Set(ids);
  return c.elements.filter((e) => e.kind === 'connector' && (set.has(e.from ?? '') || set.has(e.to ?? '')));
}

export function deleteElements(c: SyncClient, ids: string[]): boolean {
  const all = new Set(ids);
  for (const k of connectorsOf(c, ids)) all.add(k.id);
  return c.mutate([...all].map((id) => ({ id, fields: { deleted: true } })));
}

export function moveBy(c: SyncClient, ids: string[], dx: number, dy: number): boolean {
  const changes: Change[] = [];
  for (const id of ids) {
    const e = c.doc.get(id);
    if (!e || e.kind === 'connector') continue;
    if (e.kind === 'stroke') {
      changes.push({ id, fields: { points: (e.points ?? []).map(([x, y]) => [x + dx, y + dy]) as Json } });
    } else {
      changes.push({ id, fields: { x: e.x + dx, y: e.y + dy } });
    }
  }
  return c.mutate(changes);
}

export function setProps(c: SyncClient, ids: string[], fields: Record<string, Json>): boolean {
  return c.mutate(ids.map((id) => ({ id, fields })));
}

// ---- clipboard / duplicate

let clipboard: CanvasElement[] = [];

export function copyElements(c: SyncClient, ids: string[]) {
  const set = new Set(ids);
  const picked = c.elements.filter((e) => set.has(e.id));
  // include connectors whose both endpoints are copied
  const inner = c.elements.filter((e) => e.kind === 'connector' && set.has(e.from ?? '') && set.has(e.to ?? ''));
  clipboard = JSON.parse(JSON.stringify([...new Map([...picked, ...inner].map((e) => [e.id, e])).values()]));
}

export function hasClipboard() {
  return clipboard.length > 0;
}

/** Paste clipboard content offset by (dx, dy). Returns the new element ids. */
export function paste(c: SyncClient, dx = 24, dy = 24): string[] {
  if (clipboard.length === 0) return [];
  const idMap = new Map<string, string>();
  const groupMap = new Map<string, string>();
  for (const e of clipboard) idMap.set(e.id, newId());
  const z0 = c.doc.maxZ();
  const changes: Change[] = clipboard.map((e, i) => {
    const { id, ...rest } = e;
    const f: Record<string, Json> = { ...(rest as unknown as Record<string, Json>), createdBy: c.me, z: z0 + 1 + i };
    if (e.kind === 'stroke') f.points = (e.points ?? []).map(([x, y]) => [x + dx, y + dy]) as Json;
    else if (e.kind !== 'connector') { f.x = e.x + dx; f.y = e.y + dy; }
    if (e.kind === 'connector') { f.from = idMap.get(e.from ?? '') ?? null; f.to = idMap.get(e.to ?? '') ?? null; }
    if (e.groupId) {
      if (!groupMap.has(e.groupId)) groupMap.set(e.groupId, newId());
      f.groupId = groupMap.get(e.groupId)!;
    }
    return { id: idMap.get(id)!, fields: f };
  });
  return c.mutate(changes) ? changes.map((x) => x.id) : [];
}

export function duplicate(c: SyncClient, ids: string[]): string[] {
  copyElements(c, ids);
  return paste(c);
}

// ---- grouping & layers

export function group(c: SyncClient, ids: string[]): string | null {
  const members = ids.filter((id) => {
    const e = c.doc.get(id);
    return e && e.kind !== 'connector';
  });
  if (members.length < 2) return null;
  const gid = newId();
  return c.mutate(members.map((id) => ({ id, fields: { groupId: gid } }))) ? gid : null;
}

export function ungroup(c: SyncClient, ids: string[]): boolean {
  const members = ids.filter((id) => c.doc.get(id)?.groupId);
  return c.mutate(members.map((id) => ({ id, fields: { groupId: null } })));
}

export function bringToFront(c: SyncClient, ids: string[]): boolean {
  const top = c.doc.maxZ();
  return c.mutate(ids.map((id, i) => ({ id, fields: { z: top + 1 + i } })));
}

export function sendToBack(c: SyncClient, ids: string[]): boolean {
  const bottom = c.doc.minZ();
  return c.mutate(ids.map((id, i) => ({ id, fields: { z: bottom - ids.length + i } })));
}

/** Expands a selection so that grouped elements are selected together. */
export function expandGroups(c: SyncClient, ids: string[]): string[] {
  const groups = new Set(ids.map((id) => c.doc.get(id)?.groupId).filter((g): g is string => !!g));
  if (groups.size === 0) return ids;
  const out = new Set(ids);
  for (const e of c.elements) if (e.groupId && groups.has(e.groupId)) out.add(e.id);
  return [...out];
}
