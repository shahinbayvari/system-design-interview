/**
 * Canvas collaboration document.
 *
 * Operation-based, field-level last-writer-wins (LWW) registers keyed by
 * (elementId, field) and ordered by a Lamport clock with an actor-id tiebreak.
 * Properties required by the spec:
 *  - commutative / idempotent: ops may arrive out of order or duplicated
 *  - concurrent edits to different objects (or different fields) never overwrite each other
 *  - deletion is just the `deleted` field, so it merges like any other field
 */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface Clock {
  t: number;
  a: string;
}

export interface CanvasOp {
  /** Client operation id (unique per op). */
  id: string;
  elementId: string;
  clock: Clock;
  fields: Record<string, Json>;
}

interface Reg {
  v: Json;
  c: Clock;
}

export interface DocState {
  schemaVersion: number;
  elements: Record<string, Record<string, Reg>>;
}

export const SCHEMA_VERSION = 1;

export type ElementKind = 'node' | 'connector' | 'stroke' | 'text' | 'sticky';
export type ConnectorStyle = 'straight' | 'elbow' | 'curved';

export interface CanvasElement {
  id: string;
  kind: ElementKind;
  /** Palette component type for nodes (e.g. "relational-db"). */
  componentType?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  label: string;
  description?: string;
  fill?: string;
  color?: string;
  groupId?: string | null;
  createdBy?: string;
  // connectors
  from?: string;
  to?: string;
  connectorStyle?: ConnectorStyle;
  arrowStart?: boolean;
  arrowEnd?: boolean;
  dashed?: boolean;
  lineWidth?: number;
  // strokes
  points?: [number, number][];
  highlighter?: boolean;
}

/** Limits enforced by `validateOp` (and therefore by the server). */
export const LIMITS = {
  maxOpsPerMessage: 500,
  maxTextLength: 2000,
  maxPointsPerStroke: 5000,
  maxElements: 5000,
  maxCoordinate: 1e7,
};

type FieldSpec = (v: Json) => boolean;
const num: FieldSpec = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIMITS.maxCoordinate;
const str = (max: number): FieldSpec => (v) => typeof v === 'string' && v.length <= max;
const optStr = (max: number): FieldSpec => (v) => v === null || str(max)(v);
const bool: FieldSpec = (v) => typeof v === 'boolean';
const oneOf = (...xs: string[]): FieldSpec => (v) => typeof v === 'string' && xs.includes(v);

export const FIELD_SPECS: Record<string, FieldSpec> = {
  kind: oneOf('node', 'connector', 'stroke', 'text', 'sticky'),
  componentType: optStr(64),
  x: num,
  y: num,
  w: (v) => num(v) && (v as number) >= 0,
  h: (v) => num(v) && (v as number) >= 0,
  z: num,
  label: str(LIMITS.maxTextLength),
  description: optStr(LIMITS.maxTextLength),
  fill: optStr(32),
  color: optStr(32),
  groupId: optStr(64),
  createdBy: optStr(64),
  deleted: bool,
  from: optStr(64),
  to: optStr(64),
  connectorStyle: oneOf('straight', 'elbow', 'curved'),
  arrowStart: bool,
  arrowEnd: bool,
  dashed: bool,
  lineWidth: (v) => num(v) && (v as number) >= 1 && (v as number) <= 32,
  highlighter: bool,
  points: (v) =>
    Array.isArray(v) &&
    v.length <= LIMITS.maxPointsPerStroke &&
    v.every((p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1])),
};

/** Returns an error string, or null when the op is structurally valid. */
export function validateOp(op: unknown): string | null {
  if (!op || typeof op !== 'object') return 'op must be an object';
  const o = op as Partial<CanvasOp>;
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 64) return 'bad op id';
  if (typeof o.elementId !== 'string' || o.elementId.length === 0 || o.elementId.length > 64) return 'bad element id';
  if (!o.clock || typeof o.clock.t !== 'number' || !Number.isFinite(o.clock.t) || typeof o.clock.a !== 'string') {
    return 'bad clock';
  }
  if (!o.fields || typeof o.fields !== 'object' || Array.isArray(o.fields)) return 'bad fields';
  for (const [k, v] of Object.entries(o.fields)) {
    const spec = FIELD_SPECS[k];
    if (!spec) return `unsupported field "${k}"`;
    if (!spec(v as Json)) return `invalid value for "${k}"`;
  }
  return null;
}

function cmp(a: Clock, b: Clock): number {
  return a.t !== b.t ? a.t - b.t : a.a < b.a ? -1 : a.a > b.a ? 1 : 0;
}

export class CanvasDoc {
  private elements = new Map<string, Map<string, Reg>>();
  private lamport = 0;
  private cache: CanvasElement[] | null = null;

  constructor(public readonly actor: string, state?: DocState) {
    if (state) this.mergeState(state);
  }

  static fromState(actor: string, state: DocState): CanvasDoc {
    return new CanvasDoc(actor, state);
  }

  /** Apply a (possibly remote, duplicated or out-of-order) op. Returns true if state changed. */
  apply(op: CanvasOp): boolean {
    this.lamport = Math.max(this.lamport, op.clock.t);
    let regs = this.elements.get(op.elementId);
    let changed = false;
    for (const [field, value] of Object.entries(op.fields)) {
      if (!regs) {
        regs = new Map();
        this.elements.set(op.elementId, regs);
      }
      const cur = regs.get(field);
      if (!cur || cmp(op.clock, cur.c) > 0) {
        regs.set(field, { v: value, c: op.clock });
        changed = true;
      }
    }
    if (changed) this.cache = null;
    return changed;
  }

  /** Applies ops and returns only those that changed state. */
  applyMany(ops: CanvasOp[]): CanvasOp[] {
    return ops.filter((o) => this.apply(o));
  }

  /** Create + apply a local op. */
  local(elementId: string, fields: Record<string, Json>, opId?: string): CanvasOp {
    this.lamport += 1;
    const op: CanvasOp = {
      id: opId ?? `${this.actor}:${this.lamport}:${elementId}`,
      elementId,
      clock: { t: this.lamport, a: this.actor },
      fields,
    };
    this.apply(op);
    return op;
  }

  mergeState(state: DocState): void {
    for (const [id, regs] of Object.entries(state.elements)) {
      for (const [field, r] of Object.entries(regs)) {
        this.apply({ id: `state:${id}:${field}`, elementId: id, clock: r.c, fields: { [field]: r.v } });
      }
    }
  }

  serialize(): DocState {
    const elements: DocState['elements'] = {};
    for (const [id, regs] of this.elements) {
      elements[id] = Object.fromEntries([...regs].map(([k, r]) => [k, { v: r.v, c: { ...r.c } }]));
    }
    return { schemaVersion: SCHEMA_VERSION, elements };
  }

  /** Raw field values (including `deleted`) or undefined if element unknown. */
  rawFields(id: string): Record<string, Json> | undefined {
    const regs = this.elements.get(id);
    if (!regs) return undefined;
    return Object.fromEntries([...regs].map(([k, r]) => [k, r.v]));
  }

  get(id: string): CanvasElement | undefined {
    return this.visible().find((e) => e.id === id);
  }

  /** Visible elements ordered by z (then id for determinism). */
  visible(): CanvasElement[] {
    if (this.cache) return this.cache;
    const out: CanvasElement[] = [];
    for (const [id, regs] of this.elements) {
      const f = Object.fromEntries([...regs].map(([k, r]) => [k, r.v])) as Record<string, Json>;
      if (f.deleted === true || typeof f.kind !== 'string') continue;
      out.push({ x: 0, y: 0, w: 0, h: 0, z: 0, label: '', ...(f as object), id } as CanvasElement);
    }
    out.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));
    this.cache = out;
    return out;
  }

  /** Number of visible elements. */
  count(): number {
    return this.visible().length;
  }

  /** Number of known element ids (visible or not). */
  knownCount(): number {
    return this.elements.size;
  }

  maxZ(): number {
    return this.visible().reduce((m, e) => Math.max(m, e.z), 0);
  }

  minZ(): number {
    return this.visible().reduce((m, e) => Math.min(m, e.z), 0);
  }
}

/** Convenience for tests / equality: visible elements as plain JSON. */
export function snapshotOf(doc: CanvasDoc): string {
  return JSON.stringify(doc.visible());
}
