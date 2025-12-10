export const API_BASE_URL: string =
  (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ||
  // Default to same-origin backend API when served together with the backend
  (typeof window !== 'undefined'
    ? `${window.location.origin.replace(/\/$/, '')}/api`
    : 'http://localhost:9161/api');

export const APP_NAME = 'Seen';
export const DEFAULT_PAGE_SIZE = 200;
export const STATS_POLL_MS = 2000;

export const PAGE_SIZE_TIERS = {
  low: 120,
  medium: 200,
  high: 320,
} as const;

