import { isTauriRuntime } from './runtime';

export const API_BASE_URL: string =
  (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ||
  // In Tauri, backend runs as sidecar on localhost:9161
  // In web mode, use same-origin if served with backend, otherwise localhost:9161
  (isTauriRuntime()
    ? 'http://localhost:9161/api'
    : (typeof window !== 'undefined'
      ? `${window.location.origin.replace(/\/$/, '')}/api`
      : 'http://localhost:9161/api'));

export const APP_NAME = 'Seen';
export const DEFAULT_PAGE_SIZE = 200;
export const STATS_POLL_MS = 2000;

export const PAGE_SIZE_TIERS = {
  low: 120,
  medium: 200,
  high: 320,
} as const;

