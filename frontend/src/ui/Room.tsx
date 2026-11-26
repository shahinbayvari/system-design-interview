import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { addNode } from '../collab/actions';
import { SyncClient } from '../collab/syncClient';
import type { ConnectorStyle } from '../domain/canvasDoc';
import { errorMessage } from '../domain/errors';
import { boundsOf, clampZoom, fitViewport, snap, unionBounds, type Viewport } from '../domain/geometry';
import { CATEGORIES, PALETTE, STICKY_COLORS, SWATCHES } from '../domain/palette';
import type { User } from '../domain/types';
import { useServices } from '../services';
import { CanvasView, type PenSettings, type Tool } from './CanvasView';
import { Confirm, downloadText, useNotice } from './common';
import { clearGuest, loadGuest, saveGuest } from './guestStore';
import { RightPanel } from './RightPanel';
import { navigate } from './router';
import { ShareDialog } from './ShareDialog';
import { formatTimer } from './timer';

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function Room({ sessionId, user }: { sessionId: string; user: User | null }) {
  const { collab } = useServices();
  const [client, setClient] = useState<SyncClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const userId = user?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    let c: SyncClient | null = null;
    setError(null);
    (async () => {
      try {
        let cred = loadGuest(sessionId);
        if (cred) {
          try {
            cred = await collab.refreshCredential(cred);
            saveGuest(cred);
          } catch (e) {
            clearGuest(sessionId);
            cred = null;
            if (!userId) throw e;
          }
        }
        if (!cred) {
          if (!userId) throw new Error('Open the interview link you were sent in order to join.');
          cred = await collab.getAccess(sessionId);
        }
        const conn = await collab.connect(cred);
        if (cancelled) { conn.disconnect(); return; }
        c = new SyncClient(conn);
        setClient(c);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    })();
    const onHide = () => c?.close();
    window.addEventListener('pagehide', onHide);
    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', onHide);
      c?.close();
      setClient(null);
    };
  }, [collab, sessionId, userId]);

  if (error) {
    return (
      <main className="card narrow">
        <h1>Can't open this interview</h1>
        <p className="error" role="alert">{error}</p>
        {user && <a href="#/">Back to dashboard</a>}
      </main>
    );
  }
  if (!client) return <p className="center muted">Connecting…</p>;
  return <RoomView client={client} user={user} />;
}

const TOOLS: { tool: Tool; label: string; glyph: string; key: string; edit: boolean }[] = [
  { tool: 'select', label: 'Select', glyph: '↖', key: 'V', edit: false },
  { tool: 'hand', label: 'Pan (hand)', glyph: '✋', key: 'H', edit: false },
  { tool: 'pen', label: 'Pen', glyph: '✎', key: 'P', edit: true },
  { tool: 'highlighter', label: 'Highlighter', glyph: '▮', key: 'M', edit: true },
  { tool: 'eraser', label: 'Eraser', glyph: '⌫', key: 'E', edit: true },
  { tool: 'text', label: 'Text', glyph: 'T', key: 'T', edit: true },
  { tool: 'sticky', label: 'Sticky note', glyph: '▤', key: 'N', edit: true },
  { tool: 'connector', label: 'Connector', glyph: '⤳', key: 'C', edit: true },
];

function RoomView({ client, user }: { client: SyncClient; user: User | null }) {
  const services = useServices();
  const version = useSyncExternalStore(client.subscribe, client.getVersion);
  const { node: toast, run } = useNotice();
  const now = useNow();

  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<string[]>([]);
  const [vp, setVp] = useState<Viewport>({ tx: 0, ty: 0, k: 1 });
  const [snapOn, setSnapOn] = useState(true);
  const [pen, setPen] = useState<PenSettings>({ color: SWATCHES[0], width: 3 });
  const [stickyColor, setStickyColor] = useState(STICKY_COLORS[0]);
  const [connectorStyle, setConnectorStyle] = useState<ConnectorStyle>('straight');
  const [editing, setEditing] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [confirm, setConfirm] = useState<'end' | 'clear' | null>(null);
  const [offlineSim, setOfflineSim] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const fitted = useRef(false);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const elements = client.elements;
  useEffect(() => {
    if (fitted.current || size.w < 50) return;
    fitted.current = true;
    setVp(fitViewport(unionBounds(elements.map(boundsOf)), size.w, size.h));
  }, [size, elements]);

  // Drop selections whose elements vanished (deleted by a peer).
  useEffect(() => {
    const alive = selection.filter((id) => client.doc.get(id));
    if (alive.length !== selection.length) setSelection(alive);
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = client.session;
  const owner = client.role === 'owner';
  const canEdit = client.canEdit;
  const people = [{ participantId: client.me, displayName: `${client.myName} (you)`, role: client.role, color: '#0f172a' }, ...client.presence.values()];

  const zoomBy = (f: number) => {
    const k = clampZoom(vp.k * f);
    const cx = size.w / 2, cy = size.h / 2;
    setVp({ k, tx: cx - ((cx - vp.tx) / vp.k) * k, ty: cy - ((cy - vp.ty) / vp.k) * k });
  };

  const addComponent = (type: string) => {
    const def = PALETTE.find((p) => p.type === type)!;
    // fan new components out around the view centre so they don't stack on top of each other
    const n = elements.filter((e) => e.kind === 'node').length;
    const dx = ((n % 3) - 1) * 200, dy = ((Math.floor(n / 3) % 3) - 1) * 120;
    const cx = (size.w / 2 - vp.tx) / vp.k, cy = (size.h / 2 - vp.ty) / vp.k;
    const id = addNode(client, def, snap(cx - def.w / 2 + dx), snap(cy - def.h / 2 + dy));
    if (id) { setSelection([id]); setTool('select'); }
    setPaletteOpen(false);
  };

  let editStatus: { text: string; kind: 'ok' | 'warn' } = { text: 'Editing enabled', kind: 'ok' };
  if (client.role === 'observer') editStatus = { text: 'View only (observer)', kind: 'warn' };
  else if (s.state === 'ended') editStatus = { text: 'Interview ended: read-only', kind: 'warn' };
  else if (s.state === 'archived') editStatus = { text: 'Archived: read-only', kind: 'warn' };
  else if (!canEdit && client.role === 'candidate') {
    editStatus = { text: s.state === 'draft' ? 'Waiting for the interviewer to start' : 'Editing is locked by the interviewer', kind: 'warn' };
  }

  if (client.removed) {
    return (
      <main className="card narrow">
        <h1>You were removed from this interview</h1>
        <p className="muted">The interviewer removed you. If this is a mistake, ask them for a new link.</p>
        {user && <a href="#/">Back to dashboard</a>}
      </main>
    );
  }

  const statusLabel = { connected: 'Connected', reconnecting: 'Reconnecting…', offline: 'Offline' }[client.status];

  return (
    <div className="room">
      <header className="topbar">
        <h1 className="room-title" title={s.title}>{s.title}</h1>
        <span className={`pill conn-${client.status}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden /> {statusLabel}
          {client.pendingCount > 0 && ` · ${client.pendingCount} unsynced`}
        </span>
        <span className={`pill edit-${editStatus.kind}`}>{editStatus.text}</span>
        <span className="timer" aria-label="Interview timer">{formatTimer(s, now)}</span>
        <ul className="people" aria-label="Participants">
          {people.map((p) => (
            <li key={p.participantId} title={`${p.displayName} · ${p.role}`}>
              <span className="avatar" style={{ background: p.color }} aria-hidden>{p.displayName.trim()[0]?.toUpperCase()}</span>
              <span className="pname">{p.displayName}<small> {p.role}</small></span>
            </li>
          ))}
        </ul>
        <span className="grow" />

        {services.dev && (
          <label className="check dev" title="Demo only: simulates losing your connection">
            <input type="checkbox" checked={offlineSim} onChange={(e) => { setOfflineSim(e.target.checked); services.dev!.setOnline(!e.target.checked); }} />
            <span>Simulate offline</span>
          </label>
        )}

        {owner && (
          <div className="owner-controls">
            <button onClick={() => setShareOpen(true)}>Share</button>
            {s.state === 'draft' && <button className="btn-primary" onClick={() => run(() => services.sessions.start(s.id), 'Interview started.')}>Start interview</button>}
            {s.state === 'ended' && <button onClick={() => run(() => services.sessions.reopen(s.id), 'Interview reopened.')}>Reopen</button>}
            <button aria-pressed={!s.candidateEditingEnabled} onClick={() => run(() => services.sessions.setCandidateEditing(s.id, !s.candidateEditingEnabled))}>
              {s.candidateEditingEnabled ? 'Lock candidate editing' : 'Unlock candidate editing'}
            </button>
            <button aria-pressed={!s.cursorsVisible} onClick={() => run(() => services.sessions.update(s.id, { cursorsVisible: !s.cursorsVisible }))}>
              {s.cursorsVisible ? 'Hide cursors' : 'Show cursors'}
            </button>
            <div className="menu-wrap">
              <button aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>More ▾</button>
              {menuOpen && (
                <div className="menu" role="menu">
                  <button role="menuitem" onClick={async () => { setMenuOpen(false); const j = await run(() => services.sessions.exportCanvasJson(s.id)); if (j) downloadText(`${s.title.replace(/\W+/g, '-')}.json`, j); }}>Export canvas as JSON</button>
                  <button role="menuitem" onClick={() => { setMenuOpen(false); void run(() => services.sessions.restoreClearedCanvas(s.id), 'Canvas restored.'); }}>Restore last cleared canvas</button>
                  <button role="menuitem" onClick={() => { setMenuOpen(false); navigate(`/review/${s.id}`); }}>Open review page</button>
                  <hr />
                  <button role="menuitem" className="btn-danger" disabled={s.state === 'ended'} onClick={() => { setMenuOpen(false); setConfirm('clear'); }}>Clear canvas…</button>
                </div>
              )}
            </div>
            <span className="sep" aria-hidden />
            <button className="btn-danger" disabled={s.state !== 'live'} onClick={() => setConfirm('end')}>End interview</button>
          </div>
        )}
        {!owner && user && <button onClick={() => navigate('/')}>Dashboard</button>}
      </header>

      {toast}
      {client.notice && (
        <div className="banner warn" role="alert">
          {client.notice} <button onClick={() => client.clearNotice()}>Dismiss</button>
        </div>
      )}
      {s.state === 'ended' && (
        <div className="banner" role="status">
          This interview has ended and the canvas is read-only. {user && <a href={`#/review/${s.id}`}>Open review</a>}
        </div>
      )}

      <div className="body">
        <nav className="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              className={tool === t.tool ? 'tool active' : 'tool'}
              aria-label={t.label}
              aria-pressed={tool === t.tool}
              title={`${t.label} (${t.key})`}
              disabled={t.edit && !canEdit}
              onClick={() => setTool(t.tool)}
            >
              <span aria-hidden>{t.glyph}</span>
            </button>
          ))}
          <button
            className={paletteOpen ? 'tool active' : 'tool'}
            aria-label="Component library"
            aria-expanded={paletteOpen}
            title="Components"
            disabled={!canEdit}
            onClick={() => setPaletteOpen(!paletteOpen)}
          >
            <span aria-hidden>▦</span>
          </button>
          {paletteOpen && (
            <div className="palette" role="dialog" aria-label="Component library">
              {CATEGORIES.map((c) => (
                <section key={c}>
                  <h3>{c}</h3>
                  <div className="palette-grid">
                    {PALETTE.filter((p) => p.category === c).map((p) => (
                      <button key={p.type} onClick={() => addComponent(p.type)} title={p.label}>
                        <span className="chip" style={{ background: p.fill }} aria-hidden>{p.badge || '▢'}</span>
                        {p.label}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </nav>

        <div className="stage" ref={stageRef}>
          {(tool === 'pen' || tool === 'highlighter' || tool === 'sticky' || tool === 'connector') && (
            <div className="tool-options" role="group" aria-label="Tool options">
              {(tool === 'pen' || tool === 'highlighter') && (
                <>
                  {SWATCHES.map((c) => (
                    <button key={c} className="swatch" style={{ background: c }} aria-label={`Color ${c}`} aria-pressed={pen.color === c} onClick={() => setPen({ ...pen, color: c })} />
                  ))}
                  <select aria-label="Stroke width" value={pen.width} onChange={(e) => setPen({ ...pen, width: Number(e.target.value) })}>
                    {[2, 3, 5, 8].map((w) => <option key={w} value={w}>{w}px</option>)}
                  </select>
                </>
              )}
              {tool === 'sticky' && STICKY_COLORS.map((c) => (
                <button key={c} className="swatch" style={{ background: c }} aria-label={`Sticky color ${c}`} aria-pressed={stickyColor === c} onClick={() => setStickyColor(c)} />
              ))}
              {tool === 'connector' && (
                <>
                  <select aria-label="Connector style" value={connectorStyle} onChange={(e) => setConnectorStyle(e.target.value as ConnectorStyle)}>
                    <option value="straight">Straight</option>
                    <option value="elbow">Elbow</option>
                    <option value="curved">Curved</option>
                  </select>
                  <span className="muted small">Drag from one element to another</span>
                </>
              )}
            </div>
          )}

          <CanvasView
            client={client}
            version={version}
            tool={tool}
            setTool={setTool}
            selection={selection}
            setSelection={setSelection}
            vp={vp}
            setVp={setVp}
            snapOn={snapOn}
            pen={pen}
            stickyColor={stickyColor}
            connectorStyle={connectorStyle}
            editing={editing}
            setEditing={setEditing}
          />

          <div className="bottombar" role="toolbar" aria-label="View controls">
            <button aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!client.canUndo || !canEdit} onClick={() => client.undo()}>↶</button>
            <button aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!client.canRedo || !canEdit} onClick={() => client.redo()}>↷</button>
            <span className="sep" aria-hidden />
            <button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>−</button>
            <span className="zoom" aria-live="off">{Math.round(vp.k * 100)}%</span>
            <button aria-label="Zoom in" onClick={() => zoomBy(1.2)}>+</button>
            <button onClick={() => setVp(fitViewport(unionBounds(elements.map(boundsOf)), size.w, size.h))}>Fit</button>
            <button onClick={() => setVp({ tx: size.w / 2, ty: size.h / 2, k: 1 })}>Reset view</button>
            <label className="check"><input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} /><span>Snap to grid</span></label>
          </div>
        </div>

        <RightPanel client={client} version={version} selection={selection} setSelection={setSelection} />
      </div>

      {shareOpen && <ShareDialog sessionId={s.id} onClose={() => setShareOpen(false)} />}
      {confirm === 'end' && (
        <Confirm
          title="End interview?"
          body="The canvas becomes read-only for everyone and a final snapshot is saved. You can reopen the interview later."
          confirmLabel="End interview"
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); void run(() => services.sessions.end(s.id), 'Interview ended.'); }}
        />
      )}
      {confirm === 'clear' && (
        <Confirm
          title="Clear the canvas?"
          body="Every element is removed for all participants. The previous canvas is kept so you can restore it from the More menu."
          confirmLabel="Clear canvas"
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); void run(() => services.sessions.clearCanvas(s.id), 'Canvas cleared.'); }}
        />
      )}
    </div>
  );
}
