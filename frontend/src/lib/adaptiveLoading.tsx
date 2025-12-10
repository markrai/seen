import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PAGE_SIZE_TIERS } from './config';

export type PageSizeTier = keyof typeof PAGE_SIZE_TIERS;

interface AdaptiveLoadingDebugState {
  pageSizeOverride: number | null;
  setPageSizeOverride: (value: number | null) => void;
  reevaluateMs: number;
  setReevaluateMs: (value: number) => void;
  disableLongTaskObserver: boolean;
  setDisableLongTaskObserver: (value: boolean) => void;
}

interface AdaptiveLoadingContextValue {
  tier: PageSizeTier;
  pageSize: number;
  isManual: boolean;
  longTaskDowngrades: number;
  setManualTier: (tier: PageSizeTier | null) => void;
  debug?: AdaptiveLoadingDebugState;
}

const ADAPTIVE_OVERRIDE_KEY = 'nazr.pageSizeTier';
const HYSTERESIS_STREAK = 2;
const REEVALUATE_MS = 30_000;
const ADAPTIVE_DEBUG_PAGE_SIZE_KEY = 'nazr.debug.pageSizeOverride';
const ADAPTIVE_DEBUG_REEVALUATE_MS_KEY = 'nazr.debug.reevaluateMs';
const ADAPTIVE_DEBUG_DISABLE_LONGTASK_KEY = 'nazr.debug.disableLongTaskObserver';

const AdaptiveLoadingContext = createContext<AdaptiveLoadingContextValue | null>(null);

function readOverride(): PageSizeTier | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage?.getItem(ADAPTIVE_OVERRIDE_KEY) as PageSizeTier | null;
  if (!raw) return null;
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : null;
}

function writeOverride(value: PageSizeTier | null) {
  if (typeof window === 'undefined') return;
  if (value) {
    window.localStorage?.setItem(ADAPTIVE_OVERRIDE_KEY, value);
  } else {
    window.localStorage?.removeItem(ADAPTIVE_OVERRIDE_KEY);
  }
}

function readDebugNumber(key: string): number | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage?.getItem(key);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function writeDebugNumber(key: string, value: number | null) {
  if (typeof window === 'undefined') return;
  if (value == null) {
    window.localStorage?.removeItem(key);
  } else {
    window.localStorage?.setItem(key, String(value));
  }
}

function readDebugBoolean(key: string): boolean {
  if (typeof window === 'undefined') return false;
  const raw = window.localStorage?.getItem(key);
  return raw === '1';
}

function writeDebugBoolean(key: string, value: boolean) {
  if (typeof window === 'undefined') return;
  if (!value) {
    window.localStorage?.removeItem(key);
  } else {
    window.localStorage?.setItem(key, '1');
  }
}

function sampleDeviceScore(): number {
  if (typeof navigator === 'undefined') return 0;
  const deviceMemory = (navigator as any).deviceMemory as number | undefined;
  const cores = navigator.hardwareConcurrency ?? 4;
  const connection = (navigator as any).connection?.effectiveType as string | undefined;
  const pointerIsCoarse =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer:coarse)').matches;

  let score = 0;

  if (deviceMemory !== undefined) {
    if (deviceMemory >= 12) score += 2.5;
    else if (deviceMemory >= 8) score += 1.5;
    else if (deviceMemory <= 4) score -= 1.5;
  }

  if (cores >= 12) score += 2;
  else if (cores >= 8) score += 1;
  else if (cores <= 4) score -= 1.5;

  if (pointerIsCoarse) score -= 0.5;

  if (connection) {
    if (connection === 'slow-2g' || connection === '2g') score -= 2;
    else if (connection === '3g') score -= 1;
    else if (connection === '4g') score += 0.5;
  }

  if (typeof window !== 'undefined') {
    const width = window.innerWidth;
    if (width >= 2560) score += 0.5;
  }

  return score;
}

function tierFromScore(score: number): PageSizeTier {
  if (score >= 2) return 'high';
  if (score <= -1) return 'low';
  return 'medium';
}

export function AdaptiveLoadingProvider({ children }: { children: ReactNode }) {
  const [manualTier, setManualTierState] = useState<PageSizeTier | null>(() => readOverride());
  const [autoTier, setAutoTier] = useState<PageSizeTier>(() => tierFromScore(sampleDeviceScore()));
  const [longTaskDowngrades, setLongTaskDowngrades] = useState(0);

  const [debugPageSizeOverride, setDebugPageSizeOverrideState] = useState<number | null>(() =>
    import.meta.env?.DEV ? readDebugNumber(ADAPTIVE_DEBUG_PAGE_SIZE_KEY) : null,
  );
  const [debugReevaluateMs, setDebugReevaluateMsState] = useState<number>(() =>
    import.meta.env?.DEV
      ? readDebugNumber(ADAPTIVE_DEBUG_REEVALUATE_MS_KEY) ?? REEVALUATE_MS
      : REEVALUATE_MS,
  );
  const [debugDisableLongTaskObserver, setDebugDisableLongTaskObserverState] = useState<boolean>(
    () => (import.meta.env?.DEV ? readDebugBoolean(ADAPTIVE_DEBUG_DISABLE_LONGTASK_KEY) : false),
  );

  const hysteresisRef = useRef<{ candidate: PageSizeTier; streak: number } | null>(null);
  const resolvedTier = manualTier ?? autoTier;
  const pageSize = debugPageSizeOverride ?? PAGE_SIZE_TIERS[resolvedTier];

  const setDebugPageSizeOverride = useCallback((value: number | null) => {
    if (!import.meta.env?.DEV) return;
    setDebugPageSizeOverrideState(value);
    writeDebugNumber(ADAPTIVE_DEBUG_PAGE_SIZE_KEY, value);
  }, []);

  const setDebugReevaluateMs = useCallback((value: number) => {
    if (!import.meta.env?.DEV) return;
    const normalized = value > 0 ? value : REEVALUATE_MS;
    setDebugReevaluateMsState(normalized);
    writeDebugNumber(ADAPTIVE_DEBUG_REEVALUATE_MS_KEY, normalized);
  }, []);

  const setDebugDisableLongTaskObserver = useCallback((value: boolean) => {
    if (!import.meta.env?.DEV) return;
    setDebugDisableLongTaskObserverState(value);
    writeDebugBoolean(ADAPTIVE_DEBUG_DISABLE_LONGTASK_KEY, value);
  }, []);

  const applyTierChange = useCallback(
    (next: PageSizeTier, reason: string) => {
      setAutoTier(next);
      if (import.meta.env?.DEV) {
        console.info('[AdaptiveLoading] tier change', { next, reason });
      }
    },
    [],
  );

  const pushTierCandidate = useCallback(
    (candidate: PageSizeTier, reason: string) => {
      if (manualTier) return;
      setAutoTier((current) => {
        if (candidate === current) {
          hysteresisRef.current = null;
          return current;
        }
        if (hysteresisRef.current && hysteresisRef.current.candidate === candidate) {
          const streak = hysteresisRef.current.streak + 1;
          hysteresisRef.current = { candidate, streak };
          if (streak >= HYSTERESIS_STREAK) {
            hysteresisRef.current = null;
            applyTierChange(candidate, reason);
            return candidate;
          }
          return current;
        }
        hysteresisRef.current = { candidate, streak: 1 };
        return current;
      });
    },
    [applyTierChange, manualTier],
  );

  const reevaluate = useCallback(
    (reason: string) => {
      if (manualTier) return;
      const score = sampleDeviceScore();
      const candidate = tierFromScore(score);
      pushTierCandidate(candidate, reason);
    },
    [manualTier, pushTierCandidate],
  );

  useEffect(() => {
    if (manualTier) return;
    reevaluate('init');
    const interval = setInterval(() => reevaluate('interval'), debugReevaluateMs);
    const handleVisibility = () => {
      if (!document.hidden) {
        reevaluate('visibility');
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [manualTier, reevaluate, debugReevaluateMs]);

  useEffect(() => {
    if (manualTier) return;
    const handleResize = () => reevaluate('resize');
    if (typeof window === 'undefined') return;
    window.addEventListener('resize', handleResize);

    const pointerQuery = window.matchMedia?.('(pointer:coarse)');
    const pointerHandler = () => reevaluate('pointer-change');
    pointerQuery?.addEventListener
      ? pointerQuery.addEventListener('change', pointerHandler)
      : pointerQuery?.addListener(pointerHandler);

    const connection = (navigator as any).connection;
    const connectionHandler = () => reevaluate('connection-change');
    connection?.addEventListener?.('change', connectionHandler);

    return () => {
      window.removeEventListener('resize', handleResize);
      pointerQuery?.removeEventListener
        ? pointerQuery.removeEventListener('change', pointerHandler)
        : pointerQuery?.removeListener?.(pointerHandler);
      connection?.removeEventListener?.('change', connectionHandler);
    };
  }, [manualTier, reevaluate]);

  useEffect(() => {
    if (manualTier) return;
    if (debugDisableLongTaskObserver) return;
    if (typeof PerformanceObserver === 'undefined') return;
    const downgrade = () => {
      setLongTaskDowngrades((count) => count + 1);
      setAutoTier((current) => {
        const next = current === 'high' ? 'medium' : current === 'medium' ? 'low' : current;
        if (next !== current) {
          if (import.meta.env?.DEV) {
            console.info('[AdaptiveLoading] long-task downgrade', { from: current, to: next });
          }
          return next;
        }
        return current;
      });
    };
    const observer = new PerformanceObserver((list) => {
      const now = Date.now();
      const longEntries = list.getEntries().filter((entry) => entry.duration >= 80);
      if (longEntries.length === 0) return;
      const recentLongTasks = longEntries.filter((entry) => now - entry.startTime < 10_000);
      if (recentLongTasks.length >= 5) {
        downgrade();
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
    return () => observer.disconnect();
  }, [manualTier, debugDisableLongTaskObserver]);

  const setManualTier = useCallback(
    (tier: PageSizeTier | null) => {
      writeOverride(tier);
      setManualTierState(tier);
      if (!tier) {
        reevaluate('manual-reset');
      } else if (import.meta.env?.DEV) {
        console.info('[AdaptiveLoading] manual tier', tier);
      }
    },
    [reevaluate],
  );

  const value = useMemo<AdaptiveLoadingContextValue>(
    () => ({
      tier: resolvedTier,
      pageSize,
      isManual: manualTier !== null,
      longTaskDowngrades,
      setManualTier,
      debug: import.meta.env?.DEV
        ? {
            pageSizeOverride: debugPageSizeOverride,
            setPageSizeOverride: setDebugPageSizeOverride,
            reevaluateMs: debugReevaluateMs,
            setReevaluateMs: setDebugReevaluateMs,
            disableLongTaskObserver: debugDisableLongTaskObserver,
            setDisableLongTaskObserver: setDebugDisableLongTaskObserver,
          }
        : undefined,
    }),
    [
      resolvedTier,
      pageSize,
      manualTier,
      longTaskDowngrades,
      setManualTier,
      debugPageSizeOverride,
      setDebugPageSizeOverride,
      debugReevaluateMs,
      setDebugReevaluateMs,
      debugDisableLongTaskObserver,
      setDebugDisableLongTaskObserver,
    ],
  );

  return (
    <AdaptiveLoadingContext.Provider value={value}>
      {children}
    </AdaptiveLoadingContext.Provider>
  );
}

export function useAdaptiveLoading() {
  const ctx = useContext(AdaptiveLoadingContext);
  if (!ctx) {
    throw new Error('useAdaptiveLoading must be used within AdaptiveLoadingProvider');
  }
  return ctx;
}

export function useAdaptivePageSize() {
  const ctx = useAdaptiveLoading();
  return {
    pageSize: ctx.pageSize,
    tier: ctx.tier,
    isManual: ctx.isManual,
    setManualTier: ctx.setManualTier,
  };
}
