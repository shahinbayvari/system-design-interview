import type { Services } from '../types';
import { MockBackend, type MockOptions } from './backend';
import { broadcastChannelBus, webStore } from './infra';

export { MockBackend } from './backend';
export type { MockOptions } from './backend';
export * from './infra';

export function createMockServices(opts: MockOptions = {}): Services {
  return new MockBackend(opts).services;
}

/**
 * Browser wiring: the "server" database lives in localStorage and tabs talk through a
 * BroadcastChannel, so several tabs of the same browser behave like several participants.
 * Sign-in state is per tab (sessionStorage) so one browser can play interviewer + candidate.
 */
export function createBrowserMockServices(): Services {
  return createMockServices({
    store: webStore(window.localStorage),
    authStore: webStore(window.sessionStorage),
    bus: broadcastChannelBus(),
    latencyMs: 40,
  });
}
