import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addConnector, addSticky, addStroke, addText, copyElements, deleteElements, duplicate,
  expandGroups, group, moveBy, paste, setProps, ungroup,
} from '../collab/actions';
import type { Change, SyncClient } from '../collab/syncClient';
import type { CanvasElement, ConnectorStyle, Json } from '../domain/canvasDoc';
import {
  boundsOf, clampZoom, GRID, nearStroke, normalizeRect, pathFromPoints, rectsIntersect, resizeRect, snap,
  type Pt, type Rect, type Viewport,
} from '../domain/geometry';
import { findComponent } from '../domain/palette';
import { connectorFor, describe, ElementsLayer } from './ElementsLayer';

export type Tool = 'select' | 'hand' | 'pen' | 'highlighter' | 'eraser' | 'text' | 'sticky' | 'connector';

export interface PenSettings {
  color: string;
  width: number;
}

interface Props {
  client: SyncClient;
  /** Changes whenever the client's state changes (forces re-render). */
  version: number;
  tool: Tool;
  setTool: (t: Tool) => void;
  selection: string[];
  setSelection: (ids: string[]) => void;
  vp: Viewport;
  setVp: (v: Viewport) => void;
  snapOn: boolean;
  pen: PenSettings;
  stickyColor: string;
  connectorStyle: ConnectorStyle;
  editing: string | null;
  setEditing: (id: string | null) => void;
}

type Drag =
  | { type: 'pan'; sx: number; sy: number; tx: number; ty: number }
  | {
      type: 'move'; start: Pt; ids: string[]; orig: Map<string, CanvasElement>; ref: CanvasElement; last: number;
      gesture: ReturnType<SyncClient['beginGesture']>; moved: boolean;
    }
  | {
      type: 'resize'; id: string; handle: 'nw' | 'ne' | 'sw' | 'se'; start: Pt; orig: Rect; last: number;
      gesture: ReturnType<SyncClient['beginGesture']>; minW: number; minH: number;
    }
  | { type: 'marquee'; start: Pt; additive: boolean }
  | { type: 'draw'; pts: [number, number][] }
  | { type: 'erase' }
  | { type: 'connect'; from: string };

type Overlay =
  | { kind: 'marquee'; rect: Rect }
  | { kind: 'draw'; pts: [number, number][] }
  | { kind: 'connect'; from: Pt; to: Pt }
  | null;

const HANDLE = 10;
const THROTTLE_MS = 40;

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function CanvasView(props: Props) {
  const { client, tool, setTool, selection, setSelection, vp, setVp, snapOn, pen, stickyColor, connectorStyle, editing, setEditing } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const spaceDown = useRef(false);
  const lastPresence = useRef(0);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [panning, setPanning] = useState(false);

  const elements = client.elements;
  const byId = useMemo(() => new Map(elements.map((e) => [e.id, e])), [elements]);
  const canEdit = client.canEdit;

  const toWorld = (cx: number, cy: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - vp.tx) / vp.k, y: (cy - r.top - vp.ty) / vp.k };
  };

  // Share selection with peers.
  useEffect(() => { client.sendPresence({ selection }); }, [client, selection]);

  // Non-passive wheel: ctrl/cmd = zoom around cursor, otherwise pan.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const k = clampZoom(vp.k * Math.exp(-e.deltaY * 0.01));
        const cx = e.clientX - r.left, cy = e.clientY - r.top;
        setVp({ k, tx: cx - ((cx - vp.tx) / vp.k) * k, ty: cy - ((cy - vp.ty) / vp.k) * k });
      } else {
        setVp({ ...vp, tx: vp.tx - e.deltaX, ty: vp.ty - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [vp, setVp]);

  const sn = (v: number) => (snapOn ? snap(v) : v);

  // ------------------------------------------------------------ pointer handling
  const onPointerDown = (e: React.PointerEvent) => {
    wrapRef.current?.focus();
    if (editing) return;
    const target = e.target as Element;
    if (e.button === 1 || (e.button === 0 && (tool === 'hand' || spaceDown.current))) {
      drag.current = { type: 'pan', sx: e.clientX, sy: e.clientY, tx: vp.tx, ty: vp.ty };
      setPanning(true);
      svgRef.current!.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const w = toWorld(e.clientX, e.clientY);
    const eid = target.closest('[data-eid]')?.getAttribute('data-eid') ?? null;
    const handle = target.getAttribute('data-handle') as 'nw' | 'ne' | 'sw' | 'se' | null;
    svgRef.current!.setPointerCapture(e.pointerId);

    if (handle && selection.length === 1 && canEdit) {
      const el = byId.get(selection[0]);
      if (el) {
        const def = findComponent(el.componentType);
        drag.current = {
          type: 'resize', id: el.id, handle, start: w, orig: { x: el.x, y: el.y, w: el.w, h: el.h }, last: 0,
          gesture: client.beginGesture([el.id]), minW: def?.minW ?? 40, minH: def?.minH ?? 24,
        };
      }
      return;
    }

    switch (tool) {
      case 'select': {
        if (eid) {
          if (e.shiftKey && selection.includes(eid)) {
            setSelection(selection.filter((s) => s !== eid));
            return;
          }
          const base = selection.includes(eid) ? selection : e.shiftKey ? [...selection, eid] : [eid];
          const ids = expandGroups(client, base);
          setSelection(ids);
          const movable = ids.filter((id) => {
            const el = byId.get(id);
            return el && el.kind !== 'connector';
          });
          if (canEdit && movable.length > 0) {
            const orig = new Map(movable.map((id) => [id, byId.get(id)!]));
            const ref = [...orig.values()].find((o) => o.kind !== 'stroke') ?? [...orig.values()][0];
            drag.current = { type: 'move', start: w, ids: movable, orig, ref, last: 0, gesture: client.beginGesture(movable), moved: false };
          }
        } else {
          if (!e.shiftKey) setSelection([]);
          drag.current = { type: 'marquee', start: w, additive: e.shiftKey };
        }
        break;
      }
      case 'pen':
      case 'highlighter':
        if (!canEdit) return;
        drag.current = { type: 'draw', pts: [[w.x, w.y]] };
        setOverlay({ kind: 'draw', pts: [[w.x, w.y]] });
        break;
      case 'eraser':
        if (!canEdit) return;
        drag.current = { type: 'erase' };
        eraseAt(w);
        break;
      case 'text':
      case 'sticky': {
        if (!canEdit) return;
        const id = tool === 'text' ? addText(client, sn(w.x), sn(w.y)) : addSticky(client, sn(w.x - 80), sn(w.y - 60), stickyColor);
        if (id) { setSelection([id]); setEditing(id); }
        setTool('select');
        break;
      }
      case 'connector': {
        if (!canEdit || !eid) return;
        const el = byId.get(eid);
        if (el && el.kind !== 'connector' && el.kind !== 'stroke') {
          drag.current = { type: 'connect', from: eid };
          setOverlay({ kind: 'connect', from: { x: el.x + el.w / 2, y: el.y + el.h / 2 }, to: w });
        }
        break;
      }
    }
  };

  const eraseAt = (w: Pt) => {
    const tol = 8 / vp.k;
    for (const el of elements) {
      if (el.kind === 'stroke' && nearStroke(w, el.points ?? [], tol + (el.lineWidth ?? 3) / 2)) deleteElements(client, [el.id]);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const w = toWorld(e.clientX, e.clientY);
    const now = performance.now();
    if (now - lastPresence.current > 50) {
      lastPresence.current = now;
      client.sendPresence({ cursor: { x: w.x, y: w.y } });
    }
    const d = drag.current;
    if (!d) return;
    switch (d.type) {
      case 'pan':
        setVp({ ...vp, tx: d.tx + e.clientX - d.sx, ty: d.ty + e.clientY - d.sy });
        break;
      case 'move': {
        let dx = w.x - d.start.x, dy = w.y - d.start.y;
        if (!d.moved && Math.hypot(dx, dy) * vp.k < 3) return;
        d.moved = true;
        if (snapOn) {
          dx = snap(d.ref.x + dx) - d.ref.x;
          dy = snap(d.ref.y + dy) - d.ref.y;
        }
        if (now - d.last < THROTTLE_MS) return;
        d.last = now;
        d.gesture.update(moveChanges(d.orig, dx, dy));
        break;
      }
      case 'resize': {
        if (now - d.last < THROTTLE_MS) return;
        d.last = now;
        const r = resizeRect(d.orig, d.handle, w.x - d.start.x, w.y - d.start.y, d.minW, d.minH);
        d.gesture.update([{ id: d.id, fields: { x: sn(r.x), y: sn(r.y), w: Math.max(d.minW, sn(r.w)), h: Math.max(d.minH, sn(r.h)) } }]);
        break;
      }
      case 'marquee':
        setOverlay({ kind: 'marquee', rect: normalizeRect(d.start, w) });
        break;
      case 'draw': {
        const last = d.pts[d.pts.length - 1];
        if (Math.hypot(w.x - last[0], w.y - last[1]) * vp.k < 2) return;
        d.pts.push([Math.round(w.x * 10) / 10, Math.round(w.y * 10) / 10]);
        setOverlay({ kind: 'draw', pts: [...d.pts] });
        break;
      }
      case 'erase':
        eraseAt(w);
        break;
      case 'connect': {
        const el = byId.get(d.from);
        if (el) setOverlay({ kind: 'connect', from: { x: el.x + el.w / 2, y: el.y + el.h / 2 }, to: w });
        break;
      }
    }
  };

  const moveChanges = (orig: Map<string, CanvasElement>, dx: number, dy: number): Change[] =>
    [...orig.values()].map((o): Change =>
      o.kind === 'stroke'
        ? { id: o.id, fields: { points: (o.points ?? []).map(([x, y]) => [x + dx, y + dy]) as Json } }
        : { id: o.id, fields: { x: o.x + dx, y: o.y + dy } },
    );

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setOverlay(null);
    setPanning(false);
    if (!d) return;
    const w = toWorld(e.clientX, e.clientY);
    switch (d.type) {
      case 'move': {
        if (d.moved) {
          let dx = w.x - d.start.x, dy = w.y - d.start.y;
          if (snapOn) { dx = snap(d.ref.x + dx) - d.ref.x; dy = snap(d.ref.y + dy) - d.ref.y; }
          d.gesture.update(moveChanges(d.orig, dx, dy)); // exact final position
        }
        d.gesture.end();
        break;
      }
      case 'resize': {
        const r = resizeRect(d.orig, d.handle, w.x - d.start.x, w.y - d.start.y, d.minW, d.minH);
        d.gesture.update([{ id: d.id, fields: { x: sn(r.x), y: sn(r.y), w: Math.max(d.minW, sn(r.w)), h: Math.max(d.minH, sn(r.h)) } }]);
        d.gesture.end();
        break;
      }
      case 'marquee': {
        const rect = normalizeRect(d.start, w);
        if (rect.w < 3 && rect.h < 3) break;
        const hit = elements.filter((el) => el.kind !== 'connector' && rectsIntersect(rect, boundsOf(el))).map((el) => el.id);
        setSelection(expandGroups(client, d.additive ? [...new Set([...selection, ...hit])] : hit));
        break;
      }
      case 'draw': {
        addStroke(client, d.pts, pen.color, pen.width, tool === 'highlighter');
        break;
      }
      case 'connect': {
        const eid = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest('[data-eid]')?.getAttribute('data-eid');
        if (eid && eid !== d.from) {
          const id = addConnector(client, d.from, eid, connectorStyle);
          if (id) { setSelection([id]); setTool('select'); }
        }
        break;
      }
      default:
        break;
    }
  };

  // ------------------------------------------------------------ keyboard
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isTyping(e.target)) return;
    if (e.key === ' ') { spaceDown.current = true; e.preventDefault(); return; }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod) {
      if (key === 'z') { e.preventDefault(); e.shiftKey ? client.redo() : client.undo(); return; }
      if (key === 'y') { e.preventDefault(); client.redo(); return; }
      if (key === 'c') { copyElements(client, selection); return; }
      if (key === 'v') { e.preventDefault(); const ids = paste(client); if (ids.length) setSelection(ids); return; }
      if (key === 'd') { e.preventDefault(); const ids = duplicate(client, selection); if (ids.length) setSelection(ids); return; }
      if (key === 'g') { e.preventDefault(); e.shiftKey ? ungroup(client, selection) : group(client, selection); return; }
      if (key === 'a') { e.preventDefault(); setSelection(elements.filter((x) => x.kind !== 'connector').map((x) => x.id)); return; }
      return;
    }
    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        if (selection.length) { e.preventDefault(); deleteElements(client, selection); setSelection([]); }
        return;
      case 'Escape':
        setSelection([]); setTool('select'); setEditing(null);
        return;
      case 'Enter':
      case 'F2':
        if (selection.length === 1 && canEdit) { e.preventDefault(); setEditing(selection[0]); }
        return;
      case 'Tab': {
        if (elements.length === 0) return;
        e.preventDefault();
        const i = elements.findIndex((x) => x.id === selection[0]);
        const next = (i + (e.shiftKey ? -1 : 1) + elements.length) % elements.length;
        setSelection([elements[i === -1 ? (e.shiftKey ? elements.length - 1 : 0) : next].id]);
        return;
      }
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!selection.length) return;
        e.preventDefault();
        const step = e.shiftKey ? GRID * 2 : GRID / 2;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        moveBy(client, selection, dx, dy);
        return;
      }
    }
    const tools: Record<string, Tool> = { v: 'select', h: 'hand', p: 'pen', m: 'highlighter', e: 'eraser', t: 'text', n: 'sticky', c: 'connector' };
    if (tools[key] && !e.altKey) setTool(tools[key]);
  };
  const onKeyUp = (e: React.KeyboardEvent) => { if (e.key === ' ') spaceDown.current = false; };

  // ------------------------------------------------------------ overlays
  const editingEl = editing ? byId.get(editing) : undefined;
  const editRect = (() => {
    if (!editingEl) return null;
    let r: Rect;
    if (editingEl.kind === 'connector') {
      const g = connectorFor(editingEl, byId);
      if (!g) return null;
      r = { x: g.mid.x - 70, y: g.mid.y - 14, w: 140, h: 28 };
    } else r = { x: editingEl.x, y: editingEl.y, w: Math.max(editingEl.w, 100), h: Math.max(editingEl.h, 34) };
    return { left: r.x * vp.k + vp.tx, top: r.y * vp.k + vp.ty, width: r.w * vp.k, height: r.h * vp.k };
  })();
  const editDone = useRef(false);
  useEffect(() => { editDone.current = false; }, [editing]);
  const finishEdit = (value: string | null) => {
    if (editDone.current || !editingEl) return;
    editDone.current = true;
    if (value !== null && value !== editingEl.label) setProps(client, [editingEl.id], { label: value });
    setEditing(null);
    wrapRef.current?.focus();
  };

  const selectedEls = selection.map((id) => byId.get(id)).filter((x): x is CanvasElement => !!x);
  const single = selectedEls.length === 1 ? selectedEls[0] : null;
  const showHandles = !!single && canEdit && (single.kind === 'node' || single.kind === 'sticky' || single.kind === 'text');
  const hs = HANDLE / vp.k;
  const cursorsVisible = client.session.cursorsVisible;
  const cls = `canvas-wrap tool-${tool} ${panning ? 'panning' : ''} ${canEdit ? '' : 'readonly'}`;

  return (
    <div className={cls} ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown} onKeyUp={onKeyUp} aria-label="Interview canvas. Tab cycles elements, arrows move, Enter edits label, Delete removes.">
      <svg
        ref={svgRef}
        className="canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => client.sendPresence({ cursor: null })}
        onDoubleClick={(e) => {
          const id = (e.target as Element).closest('[data-eid]')?.getAttribute('data-eid');
          if (id && canEdit && tool === 'select') { setSelection([id]); setEditing(id); }
        }}
      >
        <defs>
          <pattern id="grid" width={GRID * vp.k} height={GRID * vp.k} x={vp.tx} y={vp.ty} patternUnits="userSpaceOnUse">
            <circle cx={1} cy={1} r={1} fill="#cbd5e1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="#ffffff" />
        <rect width="100%" height="100%" fill="url(#grid)" />
        <g transform={`translate(${vp.tx} ${vp.ty}) scale(${vp.k})`}>
          <ElementsLayer elements={elements} hideLabelOf={editing} />

          {/* my selection */}
          {selectedEls.map((el) => {
            if (el.kind === 'connector') {
              const g = connectorFor(el, byId);
              return g ? <path key={el.id} d={g.d} fill="none" stroke="#2563eb" strokeOpacity={0.35} strokeWidth={8} pointerEvents="none" /> : null;
            }
            const b = boundsOf(el);
            return <rect key={el.id} x={b.x - 4} y={b.y - 4} width={b.w + 8} height={b.h + 8} fill="none" stroke="#2563eb" strokeWidth={1.5 / vp.k} strokeDasharray={`${6 / vp.k} ${4 / vp.k}`} pointerEvents="none" />;
          })}
          {showHandles && single && (['nw', 'ne', 'sw', 'se'] as const).map((h) => (
            <rect
              key={h}
              data-handle={h}
              x={(h.includes('w') ? single.x : single.x + single.w) - hs / 2}
              y={(h.includes('n') ? single.y : single.y + single.h) - hs / 2}
              width={hs}
              height={hs}
              fill="#ffffff"
              stroke="#2563eb"
              strokeWidth={1.5 / vp.k}
              style={{ cursor: h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize' }}
            />
          ))}

          {/* peers' selections (labelled, so colour is not the only cue) */}
          {[...client.presence.values()].map((p) =>
            p.selection.map((id) => {
              const el = byId.get(id);
              if (!el || el.kind === 'connector') return null;
              const b = boundsOf(el);
              return (
                <g key={`${p.participantId}:${id}`} pointerEvents="none">
                  <rect x={b.x - 6} y={b.y - 6} width={b.w + 12} height={b.h + 12} fill="none" stroke={p.color} strokeWidth={2 / vp.k} strokeDasharray={`${2 / vp.k} ${3 / vp.k}`} />
                  <text x={b.x - 6} y={b.y - 10 / vp.k} fontSize={11 / vp.k} fill={p.color} fontWeight={700} fontFamily="system-ui, sans-serif">{p.displayName}</text>
                </g>
              );
            }),
          )}

          {/* previews */}
          {overlay?.kind === 'marquee' && <rect pointerEvents="none" x={overlay.rect.x} y={overlay.rect.y} width={overlay.rect.w} height={overlay.rect.h} fill="#2563eb22" stroke="#2563eb" strokeWidth={1 / vp.k} />}
          {overlay?.kind === 'draw' && (
            <path pointerEvents="none" d={pathFromPoints(overlay.pts)} fill="none" stroke={pen.color} strokeWidth={tool === 'highlighter' ? pen.width * 4 : pen.width}
              strokeOpacity={tool === 'highlighter' ? 0.35 : 1} strokeLinecap="round" strokeLinejoin="round" />
          )}
          {overlay?.kind === 'connect' && <line pointerEvents="none" x1={overlay.from.x} y1={overlay.from.y} x2={overlay.to.x} y2={overlay.to.y} stroke="#2563eb" strokeWidth={2 / vp.k} strokeDasharray={`${6 / vp.k} ${4 / vp.k}`} />}

          {/* remote cursors */}
          {cursorsVisible && [...client.presence.values()].map((p) => p.cursor && (
            <g key={p.participantId} transform={`translate(${p.cursor.x} ${p.cursor.y}) scale(${1 / vp.k})`} pointerEvents="none">
              <path d="M0,0 L0,16 L4,12 L7,19 L10,18 L7,11 L12,11 Z" fill={p.color} stroke="#fff" strokeWidth={1} />
              <rect x={12} y={14} width={p.displayName.length * 7 + 10} height={18} rx={4} fill={p.color} />
              <text x={17} y={27} fontSize={11} fill="#fff" fontWeight={600} fontFamily="system-ui, sans-serif">{p.displayName}</text>
            </g>
          ))}
        </g>
      </svg>

      {editingEl && editRect && (
        <textarea
          className="inline-edit"
          style={editRect}
          autoFocus
          defaultValue={editingEl.label}
          aria-label="Edit label"
          maxLength={2000}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => finishEdit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); finishEdit(null); }
            else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit((e.target as HTMLTextAreaElement).value); }
          }}
        />
      )}

      <div className="sr-only" aria-live="polite">
        {selectedEls.length === 0 ? '' : selectedEls.length === 1 ? `Selected ${describe(selectedEls[0])}` : `${selectedEls.length} elements selected`}
      </div>
    </div>
  );
}
