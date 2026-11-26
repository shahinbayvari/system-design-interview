import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'new' }
  | { name: 'join'; token: string }
  | { name: 'room'; id: string }
  | { name: 'review'; id: string }
  | { name: 'notfound' };

export function matchRoute(path: string): Route {
  const p = path.replace(/^#/, '').split('?')[0].replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'dashboard' };
  if (p === '/new') return { name: 'new' };
  let m = /^\/join\/([^/]+)$/.exec(p);
  if (m) return { name: 'join', token: decodeURIComponent(m[1]) };
  m = /^\/room\/([^/]+)$/.exec(p);
  if (m) return { name: 'room', id: decodeURIComponent(m[1]) };
  m = /^\/review\/([^/]+)$/.exec(p);
  if (m) return { name: 'review', id: decodeURIComponent(m[1]) };
  return { name: 'notfound' };
}

function subscribe(fn: () => void) {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return matchRoute(hash.slice(1));
}

export function navigate(path: string) {
  window.location.hash = path;
}

export function joinUrl(token: string): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#/join/${encodeURIComponent(token)}`;
}
