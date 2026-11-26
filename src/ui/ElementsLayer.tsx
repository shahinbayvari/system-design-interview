import { memo } from 'react';
import type { CanvasElement } from '../domain/canvasDoc';
import { arrowHead, connectorGeometry, pathFromPoints, wrapText, type ConnectorGeometry } from '../domain/geometry';
import { findComponent } from '../domain/palette';

const STROKE = '#334155';
const TEXT = '#0f172a';

export function connectorFor(e: CanvasElement, byId: Map<string, CanvasElement>): ConnectorGeometry | null {
  const a = e.from ? byId.get(e.from) : undefined;
  const b = e.to ? byId.get(e.to) : undefined;
  if (!a || !b) return null;
  return connectorGeometry(a, b, e.connectorStyle ?? 'straight');
}

export function describe(e: CanvasElement): string {
  const def = findComponent(e.componentType);
  const kind = def?.label ?? { node: 'Box', connector: 'Connector', stroke: 'Drawing', text: 'Text', sticky: 'Sticky note' }[e.kind];
  return e.label && e.kind !== 'stroke' ? `${kind}: ${e.label}` : kind;
}

function Lines({ label, cx, y0, lineH, maxChars, maxLines, anchor = 'middle', fill = TEXT, size = 14 }: {
  label: string; cx: number; y0: number; lineH: number; maxChars: number; maxLines: number; anchor?: 'middle' | 'start'; fill?: string; size?: number;
}) {
  const lines = wrapText(label, maxChars, maxLines);
  return (
    <text x={cx} y={y0} textAnchor={anchor} fontSize={size} fill={fill} fontFamily="system-ui, sans-serif" pointerEvents="none">
      {lines.map((l, i) => <tspan key={i} x={cx} dy={i === 0 ? 0 : lineH}>{l}</tspan>)}
    </text>
  );
}

function Shape({ e }: { e: CanvasElement }) {
  const def = findComponent(e.componentType);
  const shape = def?.shape ?? 'rect';
  const { x, y, w, h } = e;
  const fill = e.fill ?? '#ffffff';
  const common = { fill, stroke: STROKE, strokeWidth: 1.5 };
  const boundary = e.componentType === 'boundary';
  switch (shape) {
    case 'ellipse':
    case 'cloud':
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
    case 'round':
      return <rect x={x} y={y} width={w} height={h} rx={Math.min(h / 2, 22)} {...common} />;
    case 'cylinder': {
      const ry = Math.min(14, h / 5);
      return (
        <g {...common}>
          <path d={`M${x},${y + ry} A${w / 2},${ry} 0 0 1 ${x + w},${y + ry} L${x + w},${y + h - ry} A${w / 2},${ry} 0 0 1 ${x},${y + h - ry} Z`} />
          <ellipse cx={x + w / 2} cy={y + ry} rx={w / 2} ry={ry} />
        </g>
      );
    }
    case 'hex': {
      const i = Math.min(w * 0.15, 22);
      return <polygon points={`${x + i},${y} ${x + w - i},${y} ${x + w},${y + h / 2} ${x + w - i},${y + h} ${x + i},${y + h} ${x},${y + h / 2}`} {...common} />;
    }
    case 'queue':
      return (
        <g {...common}>
          <rect x={x} y={y} width={w} height={h} rx={10} />
          <line x1={x + w * 0.2} y1={y} x2={x + w * 0.2} y2={y + h} />
          <line x1={x + w * 0.8} y1={y} x2={x + w * 0.8} y2={y + h} />
        </g>
      );
    default:
      return <rect x={x} y={y} width={w} height={h} rx={4} {...common} strokeDasharray={boundary ? '8 5' : undefined} fillOpacity={boundary ? 0.5 : 1} />;
  }
}

function ElementView({ e, byId, hideLabel }: { e: CanvasElement; byId: Map<string, CanvasElement>; hideLabel: boolean }) {
  const { x, y, w, h } = e;
  switch (e.kind) {
    case 'node': {
      const def = findComponent(e.componentType);
      const boundary = e.componentType === 'boundary';
      const maxChars = (w - 16) / 7.4;
      const maxLines = Math.max(1, Math.floor((h - 14) / 17));
      return (
        <g>
          <Shape e={e} />
          {def?.badge && <text x={x + 6} y={y + 12} fontSize={9} fontWeight={700} fill="#475569" pointerEvents="none" fontFamily="system-ui, sans-serif">{def.badge}</text>}
          {!hideLabel && (boundary
            ? <Lines label={e.label} cx={x + 10} y0={y + 22} lineH={17} maxChars={maxChars} maxLines={2} anchor="start" />
            : <Lines label={e.label} cx={x + w / 2} y0={y + h / 2 - ((Math.min(wrapText(e.label, maxChars, maxLines).length, maxLines) - 1) * 17) / 2 + 5} lineH={17} maxChars={maxChars} maxLines={maxLines} />)}
        </g>
      );
    }
    case 'text':
      return (
        <g>
          <rect x={x} y={y} width={w} height={h} fill="transparent" />
          {!hideLabel && <Lines label={e.label} cx={x} y0={y + 20} lineH={18} maxChars={Math.max(w, 40) / 8} maxLines={Math.max(1, Math.floor(h / 18))} anchor="start" fill={e.color ?? TEXT} size={16} />}
        </g>
      );
    case 'sticky':
      return (
        <g>
          <rect x={x + 3} y={y + 4} width={w} height={h} fill="#00000022" />
          <rect x={x} y={y} width={w} height={h} fill={e.fill ?? '#fef08a'} stroke="#ca8a04" strokeWidth={1} />
          {!hideLabel && <Lines label={e.label} cx={x + 10} y0={y + 24} lineH={18} maxChars={(w - 20) / 7.4} maxLines={Math.max(1, Math.floor((h - 16) / 18))} anchor="start" />}
        </g>
      );
    case 'stroke': {
      const pts = e.points ?? [];
      const width = e.lineWidth ?? 3;
      return (
        <path
          d={pathFromPoints(pts)}
          fill="none"
          stroke={e.color ?? TEXT}
          strokeWidth={e.highlighter ? width * 4 : width}
          strokeOpacity={e.highlighter ? 0.35 : 1}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
    case 'connector': {
      const g = connectorFor(e, byId);
      if (!g) return null;
      const color = e.color ?? STROKE;
      const lw = e.lineWidth ?? 2;
      return (
        <g>
          <path d={g.d} fill="none" stroke="transparent" strokeWidth={Math.max(14, lw + 10)} />
          <path d={g.d} fill="none" stroke={color} strokeWidth={lw} strokeDasharray={e.dashed ? '8 6' : undefined} />
          {e.arrowEnd && <polygon points={arrowHead(g.end, g.endAngle, 8 + lw * 2)} fill={color} />}
          {e.arrowStart && <polygon points={arrowHead(g.start, g.startAngle, 8 + lw * 2)} fill={color} />}
          {e.label && !hideLabel && (
            <g pointerEvents="none">
              <rect x={g.mid.x - (e.label.length * 7.2) / 2 - 4} y={g.mid.y - 11} width={e.label.length * 7.2 + 8} height={20} rx={4} fill="#ffffff" stroke="#cbd5e1" />
              <text x={g.mid.x} y={g.mid.y + 4} fontSize={12} textAnchor="middle" fill={TEXT} fontFamily="system-ui, sans-serif">{e.label}</text>
            </g>
          )}
        </g>
      );
    }
  }
}

export const ElementsLayer = memo(function ElementsLayer({ elements, hideLabelOf }: { elements: CanvasElement[]; hideLabelOf?: string | null }) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  return (
    <g>
      {elements.map((e) => (
        <g key={e.id} data-eid={e.id} role="img" aria-label={describe(e)}>
          <ElementView e={e} byId={byId} hideLabel={hideLabelOf === e.id} />
        </g>
      ))}
    </g>
  );
});
