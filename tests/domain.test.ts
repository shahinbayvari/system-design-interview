import { describe, expect, it } from 'vitest';
import {
  arrowHead, borderPoint, clampZoom, connectorGeometry, fitViewport, nearStroke, normalizeRect, pathFromPoints,
  rectsIntersect, resizeRect, snap, strokeBounds, unionBounds, wrapText, MAX_ZOOM, MIN_ZOOM,
} from '../src/domain/geometry';
import { canEdit } from '../src/domain/permissions';
import { CATEGORIES, findComponent, PALETTE } from '../src/domain/palette';
import { matchRoute } from '../src/ui/router';
import { formatTimer, mmss } from '../src/ui/timer';

describe('geometry', () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };
  const b = { x: 300, y: 0, w: 100, h: 50 };

  it('snaps to the grid', () => {
    expect(snap(29)).toBe(20);
    expect(snap(31)).toBe(40);
    expect(snap(-9, 10)).toBe(-10);
  });

  it('computes border points on the facing side', () => {
    expect(borderPoint(a, { x: 500, y: 25 })).toEqual({ x: 100, y: 25 });
    expect(borderPoint(a, { x: 50, y: -500 })).toEqual({ x: 50, y: 0 });
  });

  it('builds straight, elbow and curved connectors between facing sides', () => {
    const s = connectorGeometry(a, b, 'straight');
    expect(s.start).toEqual({ x: 100, y: 25 });
    expect(s.end).toEqual({ x: 300, y: 25 });
    expect(s.endAngle).toBeCloseTo(0);
    const e = connectorGeometry(a, { ...b, y: 100 }, 'elbow');
    expect(e.d).toBe('M100,25 L200,25 L200,125 L300,125');
    const c = connectorGeometry(a, b, 'curved');
    expect(c.d).toContain(' C');
    expect(c.mid.x).toBeCloseTo(200);
  });

  it('chooses the vertical axis for vertically stacked elements', () => {
    const g = connectorGeometry(a, { x: 0, y: 300, w: 100, h: 50 }, 'elbow');
    expect(g.start).toEqual({ x: 50, y: 50 });
    expect(g.end).toEqual({ x: 50, y: 300 });
    expect(g.endAngle).toBeCloseTo(Math.PI / 2);
  });

  it('follows elements: moving a target changes the connector path', () => {
    const before = connectorGeometry(a, b, 'straight');
    const after = connectorGeometry(a, { ...b, y: 400 }, 'straight');
    expect(after.d).not.toBe(before.d);
  });

  it('produces an arrowhead polygon with its tip at the target', () => {
    expect(arrowHead({ x: 10, y: 10 }, 0).startsWith('10,10 ')).toBe(true);
  });

  it('hit-tests freehand strokes for the eraser', () => {
    const pts: [number, number][] = [[0, 0], [100, 0]];
    expect(nearStroke({ x: 50, y: 4 }, pts, 5)).toBe(true);
    expect(nearStroke({ x: 50, y: 20 }, pts, 5)).toBe(false);
    expect(nearStroke({ x: 1, y: 1 }, [[0, 0]], 3)).toBe(true);
    expect(nearStroke({ x: 1, y: 1 }, [], 3)).toBe(false);
  });

  it('computes bounds, intersections and union', () => {
    expect(strokeBounds([[1, 5], [9, 2]])).toEqual({ x: 1, y: 2, w: 8, h: 3 });
    expect(normalizeRect({ x: 10, y: 10 }, { x: 0, y: 4 })).toEqual({ x: 0, y: 4, w: 10, h: 6 });
    expect(rectsIntersect(a, { x: 90, y: 40, w: 50, h: 50 })).toBe(true);
    expect(rectsIntersect(a, b)).toBe(false);
    expect(unionBounds([a, b])).toEqual({ x: 0, y: 0, w: 400, h: 50 });
    expect(unionBounds([])).toBeNull();
  });

  it('resizes with minimums and from any corner', () => {
    expect(resizeRect(a, 'se', 50, 20, 60, 40)).toEqual({ x: 0, y: 0, w: 150, h: 70 });
    expect(resizeRect(a, 'se', -500, -500, 60, 40)).toEqual({ x: 0, y: 0, w: 60, h: 40 });
    expect(resizeRect(a, 'nw', 20, 10, 60, 40)).toEqual({ x: 20, y: 10, w: 80, h: 40 });
  });

  it('wraps and truncates labels', () => {
    expect(wrapText('one two three four', 8, 5)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('abcdefghij', 4, 5)).toEqual(['abcd', 'efgh', 'ij']);
    const t = wrapText('a b c d e f g h', 3, 2);
    expect(t).toHaveLength(2);
    expect(t[1].endsWith('…')).toBe(true);
  });

  it('fits the viewport and clamps zoom', () => {
    const v = fitViewport({ x: 0, y: 0, w: 400, h: 200 }, 1000, 600);
    expect(v.k).toBeGreaterThan(0);
    expect(200 * v.k + v.ty).toBeLessThan(600);
    expect(fitViewport(null, 800, 600)).toEqual({ tx: 400, ty: 300, k: 1 });
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
  });

  it('serialises freehand points as a vector path', () => {
    expect(pathFromPoints([[0, 0], [1, 1], [2, 0]])).toBe('M0,0 L1,1 L2,0');
    expect(pathFromPoints([])).toBe('');
  });
});

describe('palette', () => {
  it('covers every required category and component', () => {
    expect(CATEGORIES).toEqual(['General', 'Data', 'Messaging', 'Network', 'Compute', 'AI']);
    for (const t of [
      'relational-db', 'nosql-db', 'cache', 'object-storage', 'data-warehouse', 'queue', 'event-stream', 'pubsub',
      'client', 'browser-client', 'api-gateway', 'load-balancer', 'cdn', 'external-api', 'server', 'worker', 'function',
      'container', 'llm', 'embedding-model', 'vector-db', 'agent', 'rectangle', 'ellipse', 'rounded', 'boundary', 'icon',
    ]) expect(findComponent(t), t).toBeDefined();
  });
  it('has unique stable types and sensible minimums', () => {
    expect(new Set(PALETTE.map((p) => p.type)).size).toBe(PALETTE.length);
    for (const p of PALETTE) { expect(p.w).toBeGreaterThanOrEqual(p.minW); expect(p.h).toBeGreaterThanOrEqual(p.minH); }
  });
});

describe('permissions', () => {
  const live = { state: 'live' as const, candidateEditingEnabled: true };
  it('follows the permissions matrix', () => {
    expect(canEdit('owner', live)).toBe(true);
    expect(canEdit('interviewer', live)).toBe(true);
    expect(canEdit('candidate', live)).toBe(true);
    expect(canEdit('observer', live)).toBe(false);
  });
  it('lock and lifecycle only affect candidates (and ended/archived affect everyone)', () => {
    expect(canEdit('candidate', { ...live, candidateEditingEnabled: false })).toBe(false);
    expect(canEdit('owner', { ...live, candidateEditingEnabled: false })).toBe(true);
    expect(canEdit('candidate', { state: 'draft', candidateEditingEnabled: true })).toBe(false);
    expect(canEdit('owner', { state: 'draft', candidateEditingEnabled: true })).toBe(true);
    for (const state of ['ended', 'archived'] as const) {
      expect(canEdit('owner', { state, candidateEditingEnabled: true })).toBe(false);
      expect(canEdit('candidate', { state, candidateEditingEnabled: true })).toBe(false);
    }
  });
});

describe('routing & timer', () => {
  it('matches routes', () => {
    expect(matchRoute('/')).toEqual({ name: 'dashboard' });
    expect(matchRoute('#/new')).toEqual({ name: 'new' });
    expect(matchRoute('/join/abc_DEF-1')).toEqual({ name: 'join', token: 'abc_DEF-1' });
    expect(matchRoute('/room/s1/')).toEqual({ name: 'room', id: 's1' });
    expect(matchRoute('/review/s1')).toEqual({ name: 'review', id: 's1' });
    expect(matchRoute('/nope')).toEqual({ name: 'notfound' });
  });
  it('formats the display-only timer', () => {
    const base = { durationMinutes: 45, endedAt: null as string | null };
    const start = '2026-08-03T12:00:00Z';
    const at = (s: number) => Date.parse(start) + s * 1000;
    expect(formatTimer({ ...base, state: 'draft', startedAt: null }, 0)).toBe('Not started');
    expect(formatTimer({ ...base, state: 'live', startedAt: start }, at(60))).toBe('44:00 left');
    expect(formatTimer({ ...base, state: 'live', startedAt: start }, at(45 * 60 + 5))).toBe('00:05 over');
    expect(formatTimer({ ...base, state: 'ended', startedAt: start, endedAt: '2026-08-03T12:10:00Z' }, at(9999))).toBe('Ran 10:00');
    expect(mmss(3725)).toBe('1:02:05');
  });
});
