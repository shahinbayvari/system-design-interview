// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServicesContext } from '../src/services';
import { createMockServices } from '../src/services/mock';
import { App } from '../src/ui/App';
import { Lobby } from '../src/ui/Lobby';
import { ElementsLayer } from '../src/ui/ElementsLayer';
import type { CanvasElement } from '../src/domain/canvasDoc';
import { ownerWithSession, makeWorld } from './helpers';

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = '';
  window.sessionStorage.clear();
});

describe('Lobby', () => {
  it('shows a clear error for a revoked link and never the join form', async () => {
    const w = makeWorld();
    const o = await ownerWithSession(w);
    const { token, link } = await o.s.guestLinks.create(o.session.id);
    await o.s.guestLinks.revoke(o.session.id, link.id);
    render(<ServicesContext.Provider value={w.tab().s}><Lobby token={token} /></ServicesContext.Provider>);
    expect(await screen.findByRole('alert')).toHaveTextContent(/revoked/i);
    expect(screen.queryByLabelText(/display name/i)).toBeNull();
  });

  it('asks for a display name and the privacy acknowledgement before joining, then stores the identity', async () => {
    const w = makeWorld();
    const o = await ownerWithSession(w, 'Design Twitter');
    const { token } = await o.s.guestLinks.create(o.session.id);
    render(<ServicesContext.Provider value={w.tab().s}><Lobby token={token} /></ServicesContext.Provider>);
    expect(await screen.findByRole('heading', { name: 'Design Twitter' })).toBeInTheDocument();
    expect(screen.getByText(/saved automatically/i)).toBeInTheDocument();
    const join = screen.getByRole('button', { name: /join interview/i });
    expect(join).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByLabelText(/canvas activity is saved/i));
    expect(join).toBeEnabled();
    fireEvent.click(join);
    await waitFor(() => expect(window.location.hash).toBe(`#/room/${o.session.id}`));
    expect(JSON.parse(window.sessionStorage.getItem(`sdi.guest.${o.session.id}`)!).sessionId).toBe(o.session.id);
  });
});

describe('App (runs entirely on the mock services)', () => {
  it('signs an interviewer in, creates an interview and lists it on the dashboard', async () => {
    const services = createMockServices();
    render(<ServicesContext.Provider value={services}><App /></ServicesContext.Provider>);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'host@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByRole('heading', { name: 'Interviews' })).toBeInTheDocument();
    expect(screen.getByText(/no interviews yet/i)).toBeInTheDocument();

    await services.sessions.create({ title: 'Design YouTube' });
    cleanup();
    render(<ServicesContext.Provider value={services}><App /></ServicesContext.Provider>);
    expect(await screen.findByText('Design YouTube')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });

  it('shows validation errors from the services layer', async () => {
    const services = createMockServices();
    render(<ServicesContext.Provider value={services}><App /></ServicesContext.Provider>);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'nope' } });
    const form = screen.getByRole('button', { name: /sign in/i }).closest('form')!;
    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid email/i);
  });
});

describe('ElementsLayer', () => {
  const els: CanvasElement[] = [
    { id: 'a', kind: 'node', componentType: 'relational-db', x: 0, y: 0, w: 110, h: 90, z: 1, label: 'Users <script>alert(1)</script>' },
    { id: 'b', kind: 'node', componentType: 'service', x: 300, y: 0, w: 140, h: 72, z: 2, label: 'API' },
    { id: 'c', kind: 'connector', from: 'a', to: 'b', connectorStyle: 'elbow', arrowEnd: true, label: 'HTTPS', x: 0, y: 0, w: 0, h: 0, z: 3 },
    { id: 'd', kind: 'stroke', points: [[0, 0], [5, 5]], x: 0, y: 0, w: 0, h: 0, z: 4, label: '' },
  ];
  it('renders accessible, escaped output for every element kind', () => {
    const { container } = render(<svg><ElementsLayer elements={els} /></svg>);
    expect(container.querySelectorAll('[data-eid]')).toHaveLength(4);
    expect(container.querySelector('script')).toBeNull(); // text is escaped, never parsed as HTML
    expect(screen.getByLabelText(/Relational DB: Users/)).toBeInTheDocument();
    expect(screen.getByLabelText('Connector: HTTPS')).toBeInTheDocument();
    expect(container.textContent).toContain('HTTPS');
  });
  it('omits connectors whose endpoint no longer exists', () => {
    const { container } = render(<svg><ElementsLayer elements={els.filter((e) => e.id !== 'b')} /></svg>);
    expect(container.querySelector('polygon')).toBeNull();
  });
});
