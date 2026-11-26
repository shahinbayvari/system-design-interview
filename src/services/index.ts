import { createContext, useContext } from 'react';
import type { Services } from './types';

export * from './types';

/**
 * The app obtains its backend ONLY through this context. Swap the provider's value for a real
 * HTTP/WebSocket implementation of `Services` to leave the mock behind.
 */
export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesContext.Provider is missing');
  return s;
}
