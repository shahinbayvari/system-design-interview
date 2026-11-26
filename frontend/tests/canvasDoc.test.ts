import { describe, expect, it } from 'vitest';
import { CanvasDoc, LIMITS, snapshotOf, validateOp, type CanvasOp } from '../src/domain/canvasDoc';

const node = (id: string, extra: Record<string, never | string | number | boolean> = {}) => ({
  kind: 'node', x: 0, y: 0, w: 100, h: 50, z: 1, label: id, ...extra,
});

function shuffle<T>(xs: T[], seed = 1): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe('CanvasDoc (LWW CRDT)', () => {
  it('creates elements and exposes them sorted by z', () => {
    const d = new CanvasDoc('a');
    d.local('n2', node('n2', { z: 5 }));
    d.local('n1', node('n1', { z: 2 }));
    expect(d.visible().map((e) => e.id)).toEqual(['n1', 'n2']);
    expect(d.count()).toBe(2);
  });

  it('converges regardless of op order and duplication', () => {
    const a = new CanvasDoc('a');
    const b = new CanvasDoc('b');
    const ops: CanvasOp[] = [
      a.local('n1', node('n1')),
      a.local('n1', { x: 10 }),
      b.local('n1', { x: 20 }),
      b.local('n2', node('n2')),
      a.local('n1', { label: 'renamed' }),
      b.local('n2', { deleted: true }),
    ];
    const results = new Set<string>();
    for (let seed = 1; seed <= 25; seed++) {
      const d = new CanvasDoc('c');
      const order = shuffle([...ops, ...ops.slice(0, 3)], seed); // includes duplicates
      d.applyMany(order);
      results.add(snapshotOf(d));
    }
    expect(results.size).toBe(1);
  });

  it('keeps concurrent edits to different elements', () => {
    const base = new CanvasDoc('base');
    const create = base.local('n1', node('n1'));
    const a = new CanvasDoc('a'); a.apply(create);
    const b = new CanvasDoc('b'); b.apply(create);
    const opA = a.local('n1', { label: 'from A' });
    const opB = b.local('n2', node('n2', { label: 'from B' }));
    a.apply(opB); b.apply(opA);
    expect(snapshotOf(a)).toBe(snapshotOf(b));
    expect(a.get('n1')?.label).toBe('from A');
    expect(a.get('n2')?.label).toBe('from B');
  });

  it('keeps concurrent edits to different fields of the same element', () => {
    const a = new CanvasDoc('a');
    const create = a.local('n1', node('n1'));
    const b = new CanvasDoc('b'); b.apply(create);
    const move = a.local('n1', { x: 300, y: 40 });
    const rename = b.local('n1', { label: 'Cache' });
    a.apply(rename); b.apply(move);
    for (const d of [a, b]) {
      expect(d.get('n1')).toMatchObject({ x: 300, y: 40, label: 'Cache' });
    }
  });

  it('resolves same-field conflicts deterministically (higher clock, then actor id)', () => {
    const a = new CanvasDoc('a');
    const b = new CanvasDoc('b');
    const x = a.local('n1', node('n1', { label: 'A' }));
    const y = b.local('n1', node('n1', { label: 'B' })); // same lamport time (1), actor 'b' wins ties
    a.apply(y); b.apply(x);
    expect(a.get('n1')?.label).toBe('B');
    expect(b.get('n1')?.label).toBe('B');
  });

  it('delete is a mergeable field: a later undelete wins, an earlier one loses', () => {
    const a = new CanvasDoc('a');
    const create = a.local('n1', node('n1'));
    const del = a.local('n1', { deleted: true });
    expect(a.count()).toBe(0);
    const undo = a.local('n1', { deleted: false });
    expect(a.count()).toBe(1);
    const late = new CanvasDoc('z');
    late.applyMany([undo, del, create]); // out of order
    expect(late.count()).toBe(1);
  });

  it('apply reports whether state changed', () => {
    const a = new CanvasDoc('a');
    const op = a.local('n1', node('n1'));
    expect(a.apply(op)).toBe(false);
    expect(new CanvasDoc('b').apply(op)).toBe(true);
  });

  it('round-trips through serialize / fromState and merges snapshots', () => {
    const a = new CanvasDoc('a');
    a.local('n1', node('n1'));
    a.local('n1', { x: 99 });
    const b = CanvasDoc.fromState('b', a.serialize());
    expect(snapshotOf(b)).toBe(snapshotOf(a));
    const c = new CanvasDoc('c');
    c.local('n9', node('n9'));
    c.mergeState(a.serialize());
    expect(c.count()).toBe(2);
    // a Lamport clock advanced past everything it merged
    expect(c.local('n1', { x: 1 }).clock.t).toBeGreaterThan(2);
  });

  it('reports max/min z for layer ordering', () => {
    const a = new CanvasDoc('a');
    a.local('n1', node('n1', { z: 3 }));
    a.local('n2', node('n2', { z: -2 }));
    expect([a.maxZ(), a.minZ()]).toEqual([3, -2]);
  });
});

describe('validateOp', () => {
  const ok = (): CanvasOp => ({ id: 'op1', elementId: 'e1', clock: { t: 1, a: 'x' }, fields: node('e1') });

  it('accepts a well-formed op', () => {
    expect(validateOp(ok())).toBeNull();
  });
  it('rejects unknown fields (no arbitrary payloads)', () => {
    expect(validateOp({ ...ok(), fields: { evil: '<script>' } })).toMatch(/unsupported/);
  });
  it('rejects wrong types, bad enums, non-finite and huge numbers', () => {
    expect(validateOp({ ...ok(), fields: { x: 'a' } })).toMatch(/invalid/);
    expect(validateOp({ ...ok(), fields: { kind: 'iframe' } })).toMatch(/invalid/);
    expect(validateOp({ ...ok(), fields: { x: Infinity } })).toMatch(/invalid/);
    expect(validateOp({ ...ok(), fields: { x: LIMITS.maxCoordinate * 2 } })).toMatch(/invalid/);
    expect(validateOp({ ...ok(), fields: { w: -5 } })).toMatch(/invalid/);
  });
  it('rejects over-long text and oversized strokes', () => {
    expect(validateOp({ ...ok(), fields: { label: 'x'.repeat(LIMITS.maxTextLength + 1) } })).toMatch(/invalid/);
    const pts = Array.from({ length: LIMITS.maxPointsPerStroke + 1 }, (_, i) => [i, i]);
    expect(validateOp({ ...ok(), fields: { points: pts } })).toMatch(/invalid/);
    expect(validateOp({ ...ok(), fields: { points: [[1, 2], [3]] } })).toMatch(/invalid/);
  });
  it('rejects malformed envelopes', () => {
    expect(validateOp(null)).toBeTruthy();
    expect(validateOp({ ...ok(), id: '' })).toBeTruthy();
    expect(validateOp({ ...ok(), clock: { t: NaN, a: 'x' } })).toBeTruthy();
    expect(validateOp({ ...ok(), fields: [] })).toBeTruthy();
  });
  it('stores text verbatim (rendering is escaped by React/SVG, never injected as HTML)', () => {
    const d = new CanvasDoc('a');
    d.local('n1', node('n1', { label: '<img src=x onerror=alert(1)>' }));
    expect(d.get('n1')?.label).toBe('<img src=x onerror=alert(1)>');
  });
});
