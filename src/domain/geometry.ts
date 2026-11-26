import type { CanvasElement, ConnectorStyle } from './canvasDoc';

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const GRID = 20;

export function snap(v: number, grid = GRID): number {
  return Math.round(v / grid) * grid;
}

export function centerOf(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function normalizeRect(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

export function pointInRect(p: Pt, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function strokeBounds(points: [number, number][]): Rect {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function boundsOf(e: CanvasElement): Rect {
  return e.kind === 'stroke' ? strokeBounds(e.points ?? []) : { x: e.x, y: e.y, w: e.w, h: e.h };
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** True when `p` is within `tol` of the polyline. */
export function nearStroke(p: Pt, points: [number, number][], tol: number): boolean {
  if (points.length === 0) return false;
  if (points.length === 1) return Math.hypot(p.x - points[0][0], p.y - points[0][1]) <= tol;
  for (let i = 1; i < points.length; i++) {
    const a = { x: points[i - 1][0], y: points[i - 1][1] };
    const b = { x: points[i][0], y: points[i][1] };
    if (distToSegment(p, a, b) <= tol) return true;
  }
  return false;
}

/** Point where the ray from the rect's centre towards `target` leaves the rect. */
export function borderPoint(r: Rect, target: Pt): Pt {
  const c = centerOf(r);
  const dx = target.x - c.x, dy = target.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx === 0 ? Infinity : r.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : r.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

export interface ConnectorGeometry {
  d: string;
  start: Pt;
  end: Pt;
  /** Direction (radians) the line travels when arriving at `end`. */
  endAngle: number;
  /** Direction (radians) the line travels when arriving at `start` if traversed backwards. */
  startAngle: number;
  mid: Pt;
}

export function connectorGeometry(a: Rect, b: Rect, style: ConnectorStyle): ConnectorGeometry {
  const ca = centerOf(a), cb = centerOf(b);
  if (style === 'straight') {
    const start = borderPoint(a, cb), end = borderPoint(b, ca);
    const ang = Math.atan2(end.y - start.y, end.x - start.x);
    return {
      d: `M${start.x},${start.y} L${end.x},${end.y}`,
      start, end, endAngle: ang, startAngle: ang + Math.PI,
      mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    };
  }
  const horizontal = Math.abs(cb.x - ca.x) * (a.h + b.h) >= Math.abs(cb.y - ca.y) * (a.w + b.w);
  let start: Pt, end: Pt;
  if (horizontal) {
    const right = cb.x >= ca.x;
    start = { x: right ? a.x + a.w : a.x, y: ca.y };
    end = { x: right ? b.x : b.x + b.w, y: cb.y };
  } else {
    const down = cb.y >= ca.y;
    start = { x: ca.x, y: down ? a.y + a.h : a.y };
    end = { x: cb.x, y: down ? b.y : b.y + b.h };
  }
  if (style === 'elbow') {
    if (horizontal) {
      const mx = (start.x + end.x) / 2;
      return {
        d: `M${start.x},${start.y} L${mx},${start.y} L${mx},${end.y} L${end.x},${end.y}`,
        start, end,
        endAngle: end.x >= mx ? 0 : Math.PI,
        startAngle: mx >= start.x ? Math.PI : 0,
        mid: { x: mx, y: (start.y + end.y) / 2 },
      };
    }
    const my = (start.y + end.y) / 2;
    return {
      d: `M${start.x},${start.y} L${start.x},${my} L${end.x},${my} L${end.x},${end.y}`,
      start, end,
      endAngle: end.y >= my ? Math.PI / 2 : -Math.PI / 2,
      startAngle: my >= start.y ? -Math.PI / 2 : Math.PI / 2,
      mid: { x: (start.x + end.x) / 2, y: my },
    };
  }
  // curved
  const k = horizontal ? Math.abs(end.x - start.x) / 2 : Math.abs(end.y - start.y) / 2;
  const sx = horizontal ? Math.sign(end.x - start.x) || 1 : 0;
  const sy = horizontal ? 0 : Math.sign(end.y - start.y) || 1;
  const c1 = { x: start.x + sx * k, y: start.y + sy * k };
  const c2 = { x: end.x - sx * k, y: end.y - sy * k };
  return {
    d: `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`,
    start, end,
    endAngle: Math.atan2(sy, sx),
    startAngle: Math.atan2(-sy, -sx),
    mid: {
      x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
      y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
    },
  };
}

/** Polygon points for an arrowhead whose tip is at `tip` and which points along `angle`. */
export function arrowHead(tip: Pt, angle: number, size = 12): string {
  const spread = Math.PI / 7;
  const p1 = { x: tip.x - size * Math.cos(angle - spread), y: tip.y - size * Math.sin(angle - spread) };
  const p2 = { x: tip.x - size * Math.cos(angle + spread), y: tip.y - size * Math.sin(angle + spread) };
  return `${tip.x},${tip.y} ${p1.x},${p1.y} ${p2.x},${p2.y}`;
}

export function pathFromPoints(points: [number, number][]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0][0]},${points[0][1]} l0.01,0`;
  return 'M' + points.map(([x, y]) => `${x},${y}`).join(' L');
}

export function resizeRect(
  r: Rect,
  handle: 'nw' | 'ne' | 'sw' | 'se',
  dx: number,
  dy: number,
  minW: number,
  minH: number,
): Rect {
  let { x, y, w, h } = r;
  if (handle.includes('e')) w = Math.max(minW, r.w + dx);
  if (handle.includes('s')) h = Math.max(minH, r.h + dy);
  if (handle.includes('w')) { w = Math.max(minW, r.w - dx); x = r.x + r.w - w; }
  if (handle.includes('n')) { h = Math.max(minH, r.h - dy); y = r.y + r.h - h; }
  return { x, y, w, h };
}

/** Greedy word-wrap used for labels inside shapes (approximate monospace metrics). */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const out: string[] = [];
  const cap = Math.max(1, Math.floor(maxChars));
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (w.length > cap) {
        if (line) { out.push(line); line = ''; }
        out.push(w.slice(0, cap));
        w = w.slice(cap);
      }
      if (!line) line = w;
      else if ((line + ' ' + w).length <= cap) line += ' ' + w;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  if (out.length > maxLines) {
    const cut = out.slice(0, Math.max(1, maxLines));
    const last = cut[cut.length - 1];
    cut[cut.length - 1] = last.length >= cap ? last.slice(0, cap - 1) + '…' : last + '…';
    return cut;
  }
  return out;
}

export interface Viewport {
  tx: number;
  ty: number;
  k: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/** Viewport that fits `bounds` into a width x height screen with padding. */
export function fitViewport(bounds: Rect | null, width: number, height: number, pad = 60): Viewport {
  if (!bounds || (bounds.w === 0 && bounds.h === 0)) return { tx: width / 2, ty: height / 2, k: 1 };
  const k = clampZoom(Math.min((width - pad * 2) / Math.max(bounds.w, 1), (height - pad * 2) / Math.max(bounds.h, 1), 1.5));
  const c = centerOf(bounds);
  return { k, tx: width / 2 - c.x * k, ty: height / 2 - c.y * k };
}

export function unionBounds(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
