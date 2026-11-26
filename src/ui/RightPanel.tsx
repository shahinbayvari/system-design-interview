import {
  addConnector, bringToFront, deleteElements, duplicate, group, sendToBack, setProps, ungroup,
} from '../collab/actions';
import type { SyncClient } from '../collab/syncClient';
import type { CanvasElement, ConnectorStyle } from '../domain/canvasDoc';
import { findComponent, STICKY_COLORS, SWATCHES } from '../domain/palette';
import { CommitInput } from './common';
import { describe } from './ElementsLayer';

function Swatches({ value, colors, onPick, label, disabled }: { value: string | undefined; colors: string[]; onPick: (c: string) => void; label: string; disabled: boolean }) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="swatches" role="group" aria-label={label}>
        {colors.map((c) => (
          <button
            key={c}
            className="swatch"
            style={{ background: c }}
            aria-label={`${label} ${c}`}
            aria-pressed={value === c}
            disabled={disabled}
            onClick={() => onPick(c)}
          />
        ))}
      </div>
    </div>
  );
}

function NumField({ label, value, min, disabled, onCommit }: { label: string; value: number; min: number; disabled: boolean; onCommit: (n: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        key={value}
        type="number"
        min={min}
        defaultValue={Math.round(value)}
        disabled={disabled}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && Math.round(n) !== Math.round(value)) onCommit(Math.max(min, n));
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

export function RightPanel({ client, selection, setSelection }: {
  client: SyncClient; version: number; selection: string[]; setSelection: (ids: string[]) => void;
}) {
  const els = selection.map((id) => client.doc.get(id)).filter((e): e is CanvasElement => !!e);
  const ed = client.canEdit;
  const prompt = client.session.prompt;

  if (els.length === 0) {
    return (
      <aside className="panel" aria-label="Interview prompt">
        <details open>
          <summary><strong>Interview prompt</strong></summary>
          {prompt === null ? (
            <p className="muted">The prompt will appear once the interviewer starts the interview.</p>
          ) : prompt ? (
            <p className="prompt">{prompt}</p>
          ) : (
            <p className="muted">No problem statement was provided.</p>
          )}
        </details>
        <p className="muted small">Select an element to edit its properties.</p>
      </aside>
    );
  }

  const one = els.length === 1 ? els[0] : null;
  const ids = els.map((e) => e.id);
  const set = (fields: Record<string, string | number | boolean | null>) => setProps(client, ids, fields);
  const nodes = client.elements.filter((e) => (e.kind === 'node' || e.kind === 'text' || e.kind === 'sticky') && e.id !== one?.id);
  const def = findComponent(one?.componentType);

  return (
    <aside className="panel" aria-label="Properties">
      <h2 className="panel-title">{one ? describe(one) : `${els.length} elements`}</h2>
      {!ed && <p className="muted small">Read-only: you can't change this right now.</p>}

      {one && one.kind !== 'stroke' && (
        <CommitInput label="Label" value={one.label} disabled={!ed} maxLength={2000} onCommit={(v) => set({ label: v })} />
      )}
      {one?.kind === 'node' && (
        <CommitInput label="Description" value={one.description ?? ''} multiline disabled={!ed} maxLength={2000} onCommit={(v) => set({ description: v })} />
      )}

      {one && (one.kind === 'node' || one.kind === 'sticky' || one.kind === 'text') && (
        <>
          <div className="row">
            <NumField label="Width" value={one.w} min={def?.minW ?? 40} disabled={!ed} onCommit={(n) => set({ w: n })} />
            <NumField label="Height" value={one.h} min={def?.minH ?? 24} disabled={!ed} onCommit={(n) => set({ h: n })} />
          </div>
          {one.kind !== 'text' && (
            <Swatches label="Fill" value={one.fill} colors={one.kind === 'sticky' ? STICKY_COLORS : [...new Set([def?.fill ?? '#ffffff', '#ffffff', '#dbeafe', '#dcfce7', '#fee2e2', '#fef9c3', '#ede9fe'])]} onPick={(c) => set({ fill: c })} disabled={!ed} />
          )}
          {one.kind === 'text' && <Swatches label="Text color" value={one.color} colors={SWATCHES} onPick={(c) => set({ color: c })} disabled={!ed} />}
          <label className="field">
            <span>Connect to…</span>
            <select
              value=""
              disabled={!ed || nodes.length === 0}
              onChange={(e) => {
                const id = addConnector(client, one.id, e.target.value);
                if (id) setSelection([id]);
              }}
            >
              <option value="">Choose a target</option>
              {nodes.map((n) => <option key={n.id} value={n.id}>{n.label || describe(n)}</option>)}
            </select>
          </label>
        </>
      )}

      {one?.kind === 'connector' && (
        <>
          <label className="field">
            <span>Style</span>
            <select value={one.connectorStyle ?? 'straight'} disabled={!ed} onChange={(e) => set({ connectorStyle: e.target.value as ConnectorStyle })}>
              <option value="straight">Straight</option>
              <option value="elbow">Elbow</option>
              <option value="curved">Curved</option>
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={!!one.arrowStart} disabled={!ed} onChange={(e) => set({ arrowStart: e.target.checked })} /><span>Arrowhead at start</span></label>
          <label className="check"><input type="checkbox" checked={!!one.arrowEnd} disabled={!ed} onChange={(e) => set({ arrowEnd: e.target.checked })} /><span>Arrowhead at end</span></label>
          <label className="check"><input type="checkbox" checked={!!one.dashed} disabled={!ed} onChange={(e) => set({ dashed: e.target.checked })} /><span>Dashed line</span></label>
          <label className="field">
            <span>Line width</span>
            <select value={one.lineWidth ?? 2} disabled={!ed} onChange={(e) => set({ lineWidth: Number(e.target.value) })}>
              <option value={1}>Thin</option>
              <option value={2}>Medium</option>
              <option value={4}>Thick</option>
            </select>
          </label>
          <Swatches label="Color" value={one.color} colors={['#334155', ...SWATCHES.slice(1)]} onPick={(c) => set({ color: c })} disabled={!ed} />
          <button
            disabled={!ed}
            onClick={() => set({ from: one.to ?? null, to: one.from ?? null })}
          >
            Reverse direction
          </button>
        </>
      )}

      {one?.kind === 'stroke' && (
        <>
          <Swatches label="Color" value={one.color} colors={SWATCHES} onPick={(c) => set({ color: c })} disabled={!ed} />
          <label className="field">
            <span>Width</span>
            <select value={one.lineWidth ?? 3} disabled={!ed} onChange={(e) => set({ lineWidth: Number(e.target.value) })}>
              {[2, 3, 5, 8].map((w) => <option key={w} value={w}>{w}px</option>)}
            </select>
          </label>
        </>
      )}

      <div className="btn-grid" role="group" aria-label="Arrange">
        <button disabled={!ed} onClick={() => { const n = duplicate(client, ids); if (n.length) setSelection(n); }}>Duplicate</button>
        <button disabled={!ed || els.filter((e) => e.kind !== 'connector').length < 2} onClick={() => group(client, ids)}>Group</button>
        <button disabled={!ed || !els.some((e) => e.groupId)} onClick={() => ungroup(client, ids)}>Ungroup</button>
        <button disabled={!ed} onClick={() => bringToFront(client, ids)}>Bring to front</button>
        <button disabled={!ed} onClick={() => sendToBack(client, ids)}>Send to back</button>
        <button className="btn-danger" disabled={!ed} onClick={() => { deleteElements(client, ids); setSelection([]); }}>Delete</button>
      </div>
    </aside>
  );
}
