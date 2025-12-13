import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStats, usePageVisibility } from '../lib/hooks';
import { formatNumber } from '../lib/utils';
import { StatCardSkeleton } from '../components/LoadingSkeleton';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import PathsManager from '../components/PathsManager';
import * as d3 from 'd3';
import { useUIStore } from '../lib/store';
import type { FileTypesResponse } from '../types';
import {
  RAW_EXTENSIONS,
  FILE_TYPE_EXTENSION_MAP,
  normalizeTypeKey,
} from '../constants/fileTypes';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(1);
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatDurationNoDecimals(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatCompletionTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function Dashboard() {
  const isPageVisible = usePageVisibility();
  const { data: stats, error: statsError, isError: statsIsError } = useStats();
  const { data: fileTypes, isLoading: fileTypesLoading, error: fileTypesError } = useQuery<FileTypesResponse>({
    queryKey: ['fileTypes'],
    queryFn: () => api.fileTypes(),
    enabled: isPageVisible,
    refetchInterval: (query) => (!isPageVisible || query.state.error) ? false : 30000,
    staleTime: 10000, // Consider data fresh for 10 seconds
    placeholderData: (prev) => prev,
  });

  const navigate = useNavigate();
  const { data: perf, isLoading: perfLoading, error: perfError } = useQuery({
    queryKey: ['performance'],
    queryFn: () => api.performance(),
    enabled: isPageVisible,
    refetchInterval: (query) => (!isPageVisible || query.state.error) ? false : 2000,
  });

  const [selectedType, setSelectedType] = useState<string | null>(null);
  const handleBubbleFilter = useCallback(
    (typeKey: string, extensions: string[]) => {
      const normalizedType = normalizeTypeKey(typeKey);
      if (!normalizedType) {
        setSelectedType(null);
        navigate('/gallery');
        return;
      }
      if (selectedType === normalizedType) {
        setSelectedType(null);
        navigate('/gallery');
        return;
      }
      setSelectedType(normalizedType);
      const params = new URLSearchParams();
      params.set('type', normalizedType);
      if (extensions && extensions.length) {
        params.set('ext', extensions.join(','));
      }
      navigate(`/gallery?${params.toString()}`);
    },
    [navigate, selectedType]
  );
  const queryClient = useQueryClient();
  const resetStatsMutation = useMutation({
    mutationFn: () => api.resetStats(),
    onSuccess: () => {
      // Invalidate and refetch stats and performance data
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['performance'] });
      // Clear persisted dashboard values from localStorage
      try {
        localStorage.removeItem('seen_last_scan');
        localStorage.removeItem('seen_last_processing');
        setLastScan(null);
        setLastProcessing(null);
      } catch (e) {
        // Ignore localStorage errors
      }
    },
  });

  const [lastActive, setLastActive] = useState<{
    filesPerSec: number;
    mbPerSec: number;
    status: string;
  } | null>(null);

  const [lastScan, setLastScan] = useState<{
    files: number;
    photos?: number;
    videos?: number;
    rate: number;
    status: string;
  elapsed: number;
  completedAt?: number;
  } | null>(null);

  const [lastProcessing, setLastProcessing] = useState<{
    files: number;
    elapsed: number;
  } | null>(null);

  // Use refs to track previous values instead of state in dependencies
  const lastScanRef = useRef<{
    files: number;
    photos?: number;
    videos?: number;
    rate: number;
    status: string;
  elapsed: number;
  completedAt?: number;
  } | null>(null);
  const lastProcessingRef = useRef<{
    files: number;
    elapsed: number;
  } | null>(null);
  
  // Load persisted values from localStorage on mount
  useEffect(() => {
    try {
      const savedLastScan = localStorage.getItem('seen_last_scan');
      if (savedLastScan) {
        const parsed = JSON.parse(savedLastScan);
        setLastScan(parsed);
        lastScanRef.current = parsed;
      }
      const savedLastProcessing = localStorage.getItem('seen_last_processing');
      if (savedLastProcessing) {
        const parsed = JSON.parse(savedLastProcessing);
        setLastProcessing(parsed);
        lastProcessingRef.current = parsed;
      }
    } catch (e) {
      // Ignore localStorage errors
      console.warn('Failed to load persisted dashboard values:', e);
    }
  }, []);

  // Store last active values when processing, use them when idle
  const prevScanActiveRef = useRef<boolean>(false);
  const prevProcessingActiveRef = useRef<boolean>(false);
  
  // Debounce localStorage writes
  const localStorageDebounceTimeoutRef = useRef<{
    scan: NodeJS.Timeout | null;
    processing: NodeJS.Timeout | null;
  }>({ scan: null, processing: null });

  const [processingElapsedLive, setProcessingElapsedLive] = useState<number | null>(null);
  const processingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const processingStartRef = useRef<{ base: number; startMs: number } | null>(null);
  const [lastDiscoveryActivity, setLastDiscoveryActivity] = useState<number | null>(null);
  const [lastProcessingActivity, setLastProcessingActivity] = useState<number | null>(null);
  const [discoveryActiveFallback, setDiscoveryActiveFallback] = useState(false);
  const [processingActiveFallback, setProcessingActiveFallback] = useState(false);
  const discoveryActivityTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const processingActivityTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const discoveryCountRef = useRef<number | null>(null);
  const processingCountRef = useRef<number | null>(null);

  const backendScanRunning = stats?.scan_running === true;
  const backendProcessingActive = (stats?.scan_running === true) || (stats?.processing_active === true);
  const isScanActive = backendScanRunning || discoveryActiveFallback;
  const isProcessingActive = backendProcessingActive || processingActiveFallback;

  useEffect(() => {
    if (isProcessingActive) {
      const baseElapsed = stats?.current_processing?.elapsed_seconds
        ?? processingStartRef.current?.base
        ?? lastProcessingRef.current?.elapsed
        ?? 0;
      processingStartRef.current = { base: baseElapsed, startMs: Date.now() };
      setProcessingElapsedLive(baseElapsed);
      if (!processingTimerRef.current) {
        processingTimerRef.current = setInterval(() => {
          if (processingStartRef.current) {
            const elapsed = processingStartRef.current.base + (Date.now() - processingStartRef.current.startMs) / 1000;
            setProcessingElapsedLive(elapsed);
          }
        }, 1000);
      }
    } else {
      processingStartRef.current = null;
      if (processingTimerRef.current) {
        clearInterval(processingTimerRef.current);
        processingTimerRef.current = null;
      }
      setProcessingElapsedLive(null);
    }
  }, [isProcessingActive, stats?.current_processing?.elapsed_seconds]);
  useEffect(() => {
    const handleStatsReset = () => {
      setLastScan(null);
      lastScanRef.current = null;
      prevScanActiveRef.current = false;
      setLastProcessing(null);
      lastProcessingRef.current = null;
      prevProcessingActiveRef.current = false;
      setProcessingElapsedLive(null);
      processingStartRef.current = null;
      setSelectedType(null);
      setDiscoveryActiveFallback(false);
      setProcessingActiveFallback(false);
      setLastDiscoveryActivity(null);
      setLastProcessingActivity(null);
      if (processingTimerRef.current) {
        clearInterval(processingTimerRef.current);
        processingTimerRef.current = null;
      }
      if (discoveryActivityTimeoutRef.current) {
        clearTimeout(discoveryActivityTimeoutRef.current);
        discoveryActivityTimeoutRef.current = null;
      }
      if (processingActivityTimeoutRef.current) {
        clearTimeout(processingActivityTimeoutRef.current);
        processingActivityTimeoutRef.current = null;
      }
    };
    window.addEventListener('seen:reset-dashboard-stats', handleStatsReset);
    return () => window.removeEventListener('seen:reset-dashboard-stats', handleStatsReset);
  }, []);
  
  const debouncedLocalStorageWrite = useCallback((key: 'scan' | 'processing', value: any) => {
    // Clear existing timeout
    if (localStorageDebounceTimeoutRef.current[key]) {
      clearTimeout(localStorageDebounceTimeoutRef.current[key]!);
    }
    
    // Set new timeout (debounce for 500ms)
    localStorageDebounceTimeoutRef.current[key] = setTimeout(() => {
      try {
        if (key === 'scan') {
          localStorage.setItem('seen_last_scan', JSON.stringify(value));
        } else {
          localStorage.setItem('seen_last_processing', JSON.stringify(value));
        }
      } catch (e) {
        // Ignore localStorage errors
      }
      localStorageDebounceTimeoutRef.current[key] = null;
    }, 500);
  }, []);

  useEffect(() => {
    if (!stats) return;
    // Prefer explicit discovery counters; fall back to current_scan files_processed.
    const discoveryCount =
      stats.discovery?.files_discovered ??
      stats.current_scan?.files_discovered ??
      stats.current_scan?.files_processed ??
      0;
    if (discoveryCountRef.current !== null && discoveryCount > discoveryCountRef.current) {
      const updatedLastScan = {
        files: discoveryCount,
        photos: lastScanRef.current?.photos,
        videos: lastScanRef.current?.videos,
        rate: stats.current_scan?.files_per_sec ?? lastScanRef.current?.rate ?? 0,
        status: stats.current_scan?.status ?? lastScanRef.current?.status ?? 'completed',
        elapsed: stats.current_scan?.elapsed_seconds ?? lastScanRef.current?.elapsed ?? 0,
        completedAt: Date.now(),
      };
      setLastScan(updatedLastScan);
      lastScanRef.current = updatedLastScan;
      setLastDiscoveryActivity(Date.now());
    }
    discoveryCountRef.current = discoveryCount;
  }, [
    stats,
    stats?.discovery?.files_discovered,
    stats?.current_scan?.files_processed,
    stats?.current_scan?.files_discovered,
    stats?.current_scan?.files_per_sec,
    stats?.current_scan?.elapsed_seconds,
    stats?.current_scan?.status,
  ]);

  useEffect(() => {
    if (!stats) return;
    const processingCount = stats.processing?.files_committed ?? stats.db?.assets ?? 0;
    if (processingCountRef.current !== null && processingCount > processingCountRef.current) {
      setLastProcessingActivity(Date.now());
    }
    processingCountRef.current = processingCount;
  }, [stats?.processing?.files_committed, stats?.db?.assets]);

  useEffect(() => {
    if (lastDiscoveryActivity) {
      setDiscoveryActiveFallback(true);
      if (discoveryActivityTimeoutRef.current) {
        clearTimeout(discoveryActivityTimeoutRef.current);
      }
      discoveryActivityTimeoutRef.current = setTimeout(() => {
        setDiscoveryActiveFallback(false);
        discoveryActivityTimeoutRef.current = null;
      }, 5000);
    }
  }, [lastDiscoveryActivity]);

  useEffect(() => {
    if (lastProcessingActivity) {
      setProcessingActiveFallback(true);
      if (processingActivityTimeoutRef.current) {
        clearTimeout(processingActivityTimeoutRef.current);
      }
      processingActivityTimeoutRef.current = setTimeout(() => {
        setProcessingActiveFallback(false);
        processingActivityTimeoutRef.current = null;
      }, 5000);
    }
  }, [lastProcessingActivity]);
  
  useEffect(() => {
    if (!perf || !stats) return;
    const seenStatus = perf.seen?.status ?? 'completed';
    const isProcessing = backendProcessingActive;
    
    // Only update lastActive when scan is actually running (not just when queued items exist)
    if (backendScanRunning && (stats.processed?.files_per_sec ?? 0) > 0) {
      setLastActive({
        filesPerSec: stats.processed?.files_per_sec ?? 0,
        mbPerSec: stats.processed?.mb_per_sec ?? 0,
        status: seenStatus,
      });
    }
    
    // Only capture scan values when scan is actually running
    if (backendScanRunning && perf.current_scan) {
      const newLastScan = {
        files: perf.current_scan.files_processed,
        photos: perf.current_scan.photos_processed,
        videos: perf.current_scan.videos_processed,
        rate: perf.current_scan.files_per_sec,
        status: perf.current_scan.status ?? seenStatus,
        elapsed: perf.current_scan.elapsed_seconds,
      };
      setLastScan(newLastScan);
      lastScanRef.current = newLastScan;
      prevScanActiveRef.current = true;
      debouncedLocalStorageWrite('scan', newLastScan);
    } else if (prevScanActiveRef.current && !backendScanRunning) {
      prevScanActiveRef.current = false;
      const finalLastScan = lastScanRef.current
        ? {
            ...lastScanRef.current,
            status: lastScanRef.current.status || seenStatus,
            completedAt: lastScanRef.current.completedAt ?? Date.now(),
          }
        : null;
      if (finalLastScan) {
        setLastScan(finalLastScan);
        lastScanRef.current = finalLastScan;
        try {
          if (localStorageDebounceTimeoutRef.current.scan) {
            clearTimeout(localStorageDebounceTimeoutRef.current.scan);
            localStorageDebounceTimeoutRef.current.scan = null;
          }
          localStorage.setItem('seen_last_scan', JSON.stringify(finalLastScan));
        } catch (e) {
          // Ignore localStorage errors
        }
      }
    }

    // Track processing state similar to scan state
    if (isProcessing && stats.current_processing) {
      const newLastProcessing = {
        files: stats.current_processing.files_committed ?? lastProcessingRef.current?.files ?? 0,
        elapsed: stats.current_processing.elapsed_seconds ?? lastProcessingRef.current?.elapsed ?? 0,
      };
      setLastProcessing(newLastProcessing);
      lastProcessingRef.current = newLastProcessing;
      prevProcessingActiveRef.current = true;
      debouncedLocalStorageWrite('processing', newLastProcessing);
    } else if (prevProcessingActiveRef.current && !isProcessing) {
      prevProcessingActiveRef.current = false;
      const finalLastProcessing = (stats.current_processing?.elapsed_seconds !== undefined && stats.current_processing?.files_committed !== undefined)
        ? {
            files: stats.current_processing.files_committed ?? 0,
            elapsed: stats.current_processing.elapsed_seconds ?? 0,
          }
        : lastProcessingRef.current;
      if (finalLastProcessing) {
        setLastProcessing(finalLastProcessing);
        lastProcessingRef.current = finalLastProcessing;
        try {
          if (localStorageDebounceTimeoutRef.current.processing) {
            clearTimeout(localStorageDebounceTimeoutRef.current.processing);
            localStorageDebounceTimeoutRef.current.processing = null;
          }
          localStorage.setItem('seen_last_processing', JSON.stringify(finalLastProcessing));
        } catch (e) {
          // Ignore localStorage errors
        }
      }
    }
  }, [perf, stats, backendProcessingActive, backendScanRunning, debouncedLocalStorageWrite]);
  
  // Cleanup debounce timeouts on unmount
  useEffect(() => {
    return () => {
      if (localStorageDebounceTimeoutRef.current.scan) {
        clearTimeout(localStorageDebounceTimeoutRef.current.scan);
      }
      if (localStorageDebounceTimeoutRef.current.processing) {
        clearTimeout(localStorageDebounceTimeoutRef.current.processing);
      }
    if (processingTimerRef.current) {
      clearInterval(processingTimerRef.current);
      processingTimerRef.current = null;
    }
    if (discoveryActivityTimeoutRef.current) {
      clearTimeout(discoveryActivityTimeoutRef.current);
      discoveryActivityTimeoutRef.current = null;
    }
    if (processingActivityTimeoutRef.current) {
      clearTimeout(processingActivityTimeoutRef.current);
      processingActivityTimeoutRef.current = null;
    }
    };
  }, []);

  const dashboardFontFamily = useUIStore((s) => s.dashboardFontFamily);
  const dashboardFontSize = useUIStore((s) => s.dashboardFontSize);
  
  const getFontFamilyValue = (font: string): string => {
    switch (font) {
      case 'system':
        return 'system-ui, -apple-system, sans-serif';
      case 'sans-serif':
        return 'sans-serif';
      case 'serif':
        return 'serif';
      case 'monospace':
        return 'monospace';
      case 'cursive':
        return 'cursive';
      case 'fantasy':
        return 'fantasy';
      default:
        return 'system-ui, -apple-system, sans-serif';
    }
  };

  // Helper function to get font size class
  const getFontSizeClass = (size: string): string => {
    const sizeMap: Record<string, string> = {
      'xs': 'text-xs',
      'sm': 'text-sm',
      'base': 'text-base',
      'lg': 'text-lg',
      'xl': 'text-xl',
      '2xl': 'text-2xl',
      '3xl': 'text-3xl',
      '4xl': 'text-4xl',
    };
    return sizeMap[size] || 'text-base';
  };

  return (
    <div 
      className={`container-responsive py-3 sm:py-6 space-y-3 sm:space-y-6 ${getFontSizeClass(dashboardFontSize)}`}
      style={{ fontFamily: getFontFamilyValue(dashboardFontFamily) }}
    >

      {statsIsError && statsError && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 text-yellow-700 dark:text-yellow-300 rounded-lg p-4">
          <div className="font-medium">Connection Issue</div>
          <div className="mt-1 text-sm opacity-90">
            {statsError instanceof Error ? statsError.message : String(statsError)}
          </div>
          <div className="mt-2 text-xs opacity-75">
            The app will automatically retry. If this persists, check that the backend is running.
          </div>
        </div>
      )}

      <PathsManager />

      {/* Desktop: Bubble graph on left, 3 cards on right */}
      {/* Mobile: Show bubble graph only */}
      <div className="flex flex-col lg:flex-row gap-3 sm:gap-4">
        {/* Left: Bubble graph (desktop only) */}
        <div className="lg:flex-1 hidden lg:block">
          <section>
            {fileTypesLoading ? (
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-8 bg-white dark:bg-zinc-900 flex items-center justify-center h-64">
                <div className="text-sm text-zinc-500 dark:text-zinc-400">Loading...</div>
              </div>
            ) : fileTypesError ? (
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-8 bg-white dark:bg-zinc-900 flex items-center justify-center h-64">
                <div className="text-sm text-red-500 dark:text-red-400">
                  Error: {fileTypesError instanceof Error ? fileTypesError.message : 'Failed to load file types'}
                </div>
              </div>
            ) : fileTypes && Object.keys(fileTypes).length > 0 ? (
              <FileTypeChart
                data={fileTypes as FileTypesResponse}
                onBubbleFilter={handleBubbleFilter}
                selectedType={selectedType}
              />
            ) : (
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-8 bg-white dark:bg-zinc-900 flex items-center justify-center h-64">
                <div className="text-sm text-zinc-500 dark:text-zinc-400">No data available</div>
              </div>
            )}
          </section>
        </div>

        {/* Right: 3 cards stacked (desktop only) */}
        <div className="lg:w-80 lg:flex-shrink-0 hidden lg:block">
          {perf && stats ? (
            <div className="space-y-3 sm:space-y-4">
              {/* File Discovery Card */}
              <FileDiscoveryCard stats={stats} isScanRunning={isScanActive} lastScan={lastScan} />
              {/* Indexing Progress Card */}
              <ProcessingProgressCard
                stats={stats}
                lastProcessing={lastProcessing}
                processingElapsedLive={processingElapsedLive}
                isProcessingActive={isProcessingActive}
              />
              {/* System Info Card */}
              <SystemInfoCard perf={perf} stats={stats} />
            </div>
          ) : (
            <div className="space-y-3 sm:space-y-4">
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
            </div>
          )}
        </div>
      </div>

      {/* Mobile: Show bubble graph */}
      <div className="lg:hidden">
        <section>
          {fileTypesLoading ? (
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-8 bg-white dark:bg-zinc-900 flex items-center justify-center h-64">
              <div className="text-sm text-zinc-500 dark:text-zinc-400">Loading...</div>
            </div>
          ) : fileTypesError ? (
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-8 bg-white dark:bg-zinc-900 flex items-center justify-center h-64">
              <div className="text-sm text-red-500 dark:text-red-400">
                Error: {fileTypesError instanceof Error ? fileTypesError.message : 'Failed to load file types'}
              </div>
            </div>
          ) : fileTypes && Object.keys(fileTypes).length > 0 ? (
            <FileTypeChart
              data={fileTypes as FileTypesResponse}
              onBubbleFilter={handleBubbleFilter}
              selectedType={selectedType}
            />
          ) : (
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-8 bg-white dark:bg-zinc-900 flex items-center justify-center h-64">
              <div className="text-sm text-zinc-500 dark:text-zinc-400">No data available</div>
            </div>
          )}
        </section>
      </div>

      {/* Performance Section */}
      {perfLoading ? (
        <section>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-8 bg-white dark:bg-zinc-900 flex items-center justify-center h-64">
            <div className="text-sm text-zinc-500 dark:text-zinc-400">Loading performance data...</div>
          </div>
        </section>
      ) : perfError || !perf || !stats ? (
        <section>
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300">
            Error loading performance data: {perfError instanceof Error ? perfError.message : 'Unknown error'}
          </div>
        </section>
      ) : (
        <PerformanceSection
          perf={perf}
          stats={stats}
          lastActive={lastActive}
          lastScan={lastScan}
          lastProcessing={lastProcessing}
          processingElapsedLive={processingElapsedLive}
          isScanActive={isScanActive}
          isProcessingActive={isProcessingActive}
          resetStatsMutation={resetStatsMutation}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 bg-white dark:bg-zinc-900">
      <div className="text-[10px] sm:text-xs opacity-70">{label}</div>
      <div className="text-base sm:text-lg md:text-xl font-semibold mt-0.5 sm:mt-1 tabular-nums break-words">
        {value}{suffix && <span className="text-xs sm:text-sm opacity-70 ml-1">{suffix}</span>}
      </div>
    </div>
  );
}

// Color palette for different file types - vibrant and distinct
const FILE_TYPE_COLORS: Record<string, string> = {
  // Image formats
  'image/jpeg': '#f59e0b',      // Amber - warm, classic photo format
  'image/jpg': '#f59e0b',       // Amber
  'image/png': '#3b82f6',       // Blue - transparency, modern
  'image/webp': '#8b5cf6',      // Purple - modern, efficient
  'image/gif': '#ec4899',       // Pink - animated, fun
  'image/heic': '#06b6d4',      // Cyan - Apple format
  'image/heif': '#06b6d4',      // Cyan
  'image/raw': '#92400e',       // Brown - professional, raw data
  'image/x-raw': '#92400e',     // Brown
  'image/dng': '#92400e',       // Brown
  'image/tiff': '#64748b',      // Slate - professional format
  'image/tif': '#64748b',       // Slate
  'image/bmp': '#475569',       // Dark slate - old format
  
  // Video formats
  'video/mp4': '#ef4444',       // Red - most common video format
  'video/mov': '#f97316',       // Orange - Apple format
  'video/quicktime': '#f97316', // Orange
  'video/x-quicktime': '#f97316', // Orange
  'video/avi': '#dc2626',       // Dark red - older format
  'video/x-msvideo': '#dc2626', // Dark red
  'video/mkv': '#7c3aed',       // Violet - container format
  'video/x-matroska': '#7c3aed', // Violet
  'video/webm': '#10b981',      // Green - web format
  'video/mp4v': '#f43f5e',      // Rose - variant
  'video/mpeg': '#be123c',      // Dark rose
  
  // Audio formats
  'audio/mpeg': '#14b8a6',      // Teal - MP3
  'audio/mp3': '#14b8a6',       // Teal
  'audio/wav': '#0ea5e9',       // Sky blue
  'audio/flac': '#6366f1',      // Indigo - lossless
  'audio/aac': '#22c55e',       // Green
  'audio/ogg': '#84cc16',       // Lime
  'audio/m4a': '#a855f7',       // Fuchsia - Apple format
};


function getColorForFileType(fileType: string): string {
  // Check exact match first
  if (FILE_TYPE_COLORS[fileType]) {
    return FILE_TYPE_COLORS[fileType];
  }
  
  // Check case-insensitive match
  const lowerType = fileType.toLowerCase();
  if (FILE_TYPE_COLORS[lowerType]) {
    return FILE_TYPE_COLORS[lowerType];
  }
  
  // Fallback by category
  if (fileType.startsWith('image/')) {
    // Default colors for unknown image types
    const imageDefaults = ['#f59e0b', '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4'];
    const hash = fileType.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return imageDefaults[hash % imageDefaults.length];
  } else if (fileType.startsWith('video/')) {
    // Default colors for unknown video types
    const videoDefaults = ['#ef4444', '#f97316', '#7c3aed', '#10b981', '#f43f5e'];
    const hash = fileType.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return videoDefaults[hash % videoDefaults.length];
  } else if (fileType.startsWith('audio/')) {
    return '#14b8a6'; // Teal for audio
  } else {
    return '#6b7280'; // Gray for unknown types
  }
}

function formatFileTypeName(fileType: string): string {
  // Remove the prefix and capitalize
  if (fileType.includes('/')) {
    const parts = fileType.split('/');
    const subtype = parts[1].toUpperCase();
    return subtype;
  }
  return fileType.charAt(0).toUpperCase() + fileType.slice(1);
}

type FileTypeChartProps = {
  data: Record<string, number | string[] | Record<string, number>>;
  onBubbleFilter?: (typeKey: string, extensions: string[]) => void;
  selectedType?: string | null;
};

function FileTypeChart({ data, onBubbleFilter, selectedType }: FileTypeChartProps) {
  // Safety check: ensure data is a valid object
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }

  // Extract other_extensions and other_breakdown if present
  const otherExtensionsValue = data.other_extensions;
  const rawExtensions = RAW_EXTENSIONS;
  const otherExtensions = Array.isArray(otherExtensionsValue) 
    ? (otherExtensionsValue as string[]).filter(ext => ext && ext.trim().length > 0 && !rawExtensions.some(rawExt => ext.toLowerCase() === rawExt.toLowerCase()))
    : [];
  const otherBreakdownValue = data.other_breakdown;
  const otherBreakdownRaw = typeof otherBreakdownValue === 'object' && otherBreakdownValue !== null && !Array.isArray(otherBreakdownValue)
    ? (otherBreakdownValue as Record<string, number>)
    : {};
  // Filter out raw file extensions from otherBreakdown
  const otherBreakdown = Object.fromEntries(
    Object.entries(otherBreakdownRaw).filter(([ext]) => 
      !rawExtensions.some(rawExt => ext.toLowerCase() === rawExt.toLowerCase())
    )
  );
  // Filter out other_extensions and other_breakdown from the data for chart
  const chartDataOnly = Object.fromEntries(
    Object.entries(data).filter(([key]) => key !== 'other_extensions' && key !== 'other_breakdown')
  ) as Record<string, number>;

  const getExtensionsForBubble = useCallback((originalName: string): string[] => {
    const normalizedName = originalName.toLowerCase();

    if (normalizedName === 'raw' || normalizedName === 'image/raw' || normalizedName === 'image/x-raw') {
      return Array.isArray(rawExtensions) ? rawExtensions.map((ext) => ext.toLowerCase()) : [];
    }

    if (normalizedName === 'other') {
      const breakdownKeys = typeof otherBreakdown === 'object' && otherBreakdown !== null && !Array.isArray(otherBreakdown)
        ? Object.keys(otherBreakdown)
        : [];
      const combined = Array.from(new Set([
        ...breakdownKeys.map((ext) => ext.toLowerCase()),
        ...(Array.isArray(otherExtensions) ? otherExtensions.map((ext) => ext.toLowerCase()) : []),
      ])).filter(Boolean);
      return combined;
    }

    if (FILE_TYPE_EXTENSION_MAP[normalizedName]) {
      const extensions = FILE_TYPE_EXTENSION_MAP[normalizedName];
      return Array.isArray(extensions) ? extensions.map((ext) => ext.toLowerCase()) : [];
    }

    if (normalizedName.startsWith('audio/')) {
      const audioExtensions = FILE_TYPE_EXTENSION_MAP['audio'] ?? [];
      return Array.isArray(audioExtensions) ? audioExtensions.map((ext) => ext.toLowerCase()) : [];
    }

    if (normalizedName.startsWith('video/') || normalizedName.startsWith('image/')) {
      const subtype = normalizedName.split('/')[1];
      return subtype ? [subtype.toLowerCase()] : [];
    }

    return [];
  }, [otherBreakdown, otherExtensions, rawExtensions]);

  const selectedTypeKey = selectedType ? selectedType.toLowerCase() : null;

  // Prepare data for bubble chart
  const bubbleData = useMemo(() => {
    // Safety check: ensure chartDataOnly is a valid object
    if (!chartDataOnly || typeof chartDataOnly !== 'object' || Array.isArray(chartDataOnly)) {
      return [];
    }
    
    // Get the original other_breakdown (unfiltered) for raw detection
    const otherBreakdownValue = data.other_breakdown;
    const otherBreakdownRaw = typeof otherBreakdownValue === 'object' && otherBreakdownValue !== null && !Array.isArray(otherBreakdownValue)
      ? (otherBreakdownValue as Record<string, number>)
      : {};
    
    // Combine all "other" entries into a single "other" entry
    let combinedOther = 0;
    const otherKeys = ['other', 'image/other', 'video/other'];
    
    // Combine all raw image entries into a single "raw" entry
    let combinedRaw = 0;
    const knownRawKeys = ['image/raw', 'image/x-raw', 'image/dng'];
    // Dynamically find additional raw types by checking if keys contain raw-related strings
    const allRawKeys = Object.keys(chartDataOnly).filter(key => 
      knownRawKeys.includes(key) || 
      (key.startsWith('image/') && rawExtensions.some(ext => key.toLowerCase().includes(ext)))
    );
    
    // Sum up all "other" entries first
    let rawCountInOther = 0;
    otherKeys.forEach(key => {
      if (key in chartDataOnly && typeof chartDataOnly[key] === 'number') {
        combinedOther += chartDataOnly[key] as number;
      }
    });
    
    // Also check other_breakdown for raw file extensions (raw files might be in image/other)
    // If found, add to combinedRaw and subtract from combinedOther to avoid double-counting
    // Use otherBreakdownRaw (unfiltered) to find raw extensions
    if (otherBreakdownRaw && Object.keys(otherBreakdownRaw).length > 0) {
      Object.entries(otherBreakdownRaw).forEach(([ext, count]) => {
        if (rawExtensions.some(rawExt => ext.toLowerCase() === rawExt.toLowerCase())) {
          const rawCount = typeof count === 'number' ? count : 0;
          combinedRaw += rawCount;
          rawCountInOther += rawCount;
        }
      });
      // Subtract raw counts from image/other if it exists
      if ('image/other' in chartDataOnly && typeof chartDataOnly['image/other'] === 'number') {
        combinedOther = Math.max(0, combinedOther - rawCountInOther);
      }
    }
    
    // Sum up all raw image entries from chartDataOnly
    allRawKeys.forEach(key => {
      if (key in chartDataOnly && typeof chartDataOnly[key] === 'number') {
        combinedRaw += chartDataOnly[key] as number;
      }
    });
    
    const filtered = Object.entries(chartDataOnly)
      .filter(([key, value]) => {
        // Filter out all "other" entries (we'll add combined one separately)
        if (otherKeys.includes(key)) {
          return false;
        }
        // Filter out all raw image entries (we'll add combined one separately)
        if (allRawKeys.includes(key)) {
          return false;
        }
        return typeof value === 'number' && value > 0;
      })
      .map(([name, value]) => ({
        name: formatFileTypeName(name),
        value: value as number,
        originalName: name,
        color: getColorForFileType(name),
      }));
    
    const withCombined = filtered.concat(
      // Add combined "raw" entry if it has a value
      combinedRaw > 0 ? [{
        name: 'RAW',
        value: combinedRaw,
        originalName: 'image/raw',
        color: getColorForFileType('image/raw'),
      }] : [],
      // Add combined "other" entry if it has a value
      combinedOther > 0 ? [{
        name: 'OTHER',
        value: combinedOther,
        originalName: 'other',
        color: getColorForFileType('other'),
      }] : []
    );
    
    // Ensure withCombined is an array
    if (!Array.isArray(withCombined)) {
      return [];
    }
    
    // Calculate total for percentage calculation
    const total = withCombined.reduce((sum, item) => sum + item.value, 0);
    
    // Add percentage to each item
    return withCombined.map(item => ({
      ...item,
      percentage: total > 0 ? (item.value / total) * 100 : 0,
    }));
  }, [chartDataOnly, data.other, data.other_breakdown]);

  const bubbleDataWithMeta = useMemo(() => {
    if (!Array.isArray(bubbleData)) {
      return [];
    }
    return bubbleData.map(item => {
      const extensions = getExtensionsForBubble(item.originalName);
      const typeKey = normalizeTypeKey(item.originalName);
      return {
        ...item,
        extensions,
        typeKey,
        isActive: !!selectedTypeKey && typeKey === selectedTypeKey,
      };
    });
  }, [bubbleData, getExtensionsForBubble, selectedTypeKey]);

  // Check if we should show the "Other file types" indicator
  // Show it if we have standalone "other" OR category-specific "other" entries
  const hasImageOther = 'image/other' in chartDataOnly && (chartDataOnly['image/other'] as number) > 0;
  const hasVideoOther = 'video/other' in chartDataOnly && (chartDataOnly['video/other'] as number) > 0;
  const hasStandaloneOther = typeof data.other === 'number' && data.other > 0;
  const hasOther = hasStandaloneOther || hasImageOther || hasVideoOther;

  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef<Map<string, { x: number; y: number; radius: number }>>(new Map());
  const hasInitializedRef = useRef(false);
  const isMobileRef = useRef(false);

  const hasActiveBubble = Boolean(selectedTypeKey);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current || bubbleDataWithMeta.length === 0) {
      if (bubbleDataWithMeta.length === 0 && svgRef.current) {
        d3.select(svgRef.current).selectAll('*').remove();
        positionsRef.current.clear();
        hasInitializedRef.current = false;
      }
      return;
    }

    const svg = d3.select(svgRef.current);
    const container = containerRef.current;
    const width = container.clientWidth;
    const isMobile = width < 640; // sm breakpoint
    isMobileRef.current = isMobile;
    const height = isMobile ? Math.min(width * 0.9, 350) : 400;
    
    svg.attr('width', width).attr('height', height);
    
    // Create tooltip if it doesn't exist
    let tooltip = d3.select(container).select('.bubble-tooltip');
    if (tooltip.empty()) {
      tooltip = d3.select(container)
        .append('div')
        .attr('class', 'bubble-tooltip')
        .style('position', 'absolute')
        .style('pointer-events', 'none')
        .style('opacity', 0)
        .style('background', 'rgba(0, 0, 0, 0.8)')
        .style('color', 'white')
        .style('padding', '8px 12px')
        .style('border-radius', '6px')
        .style('font-size', '12px')
        .style('z-index', '1000')
        .style('transition', 'opacity 0.2s');
    }

    // Calculate bubble sizes based on values
    const maxValue = Math.max(...bubbleDataWithMeta.map(d => d.value));
    const minValue = Math.min(...bubbleDataWithMeta.map(d => d.value));
    const sizeScale = d3.scaleSqrt()
      .domain([minValue, maxValue])
      .range(isMobile ? [15, 60] : [20, 80]);

    // Sort bubbles by value (largest to smallest)
    const sortedBubbles = Array.isArray(bubbleDataWithMeta) 
      ? [...bubbleDataWithMeta].sort((a, b) => b.value - a.value)
      : [];

    let nodes: any[];
    
    if (isMobile) {
      // Mobile: Use packed bubble layout with force simulation
      // Clear positions when switching to mobile to force recalculation
      if (!hasInitializedRef.current || isMobileRef.current === false) {
        positionsRef.current.clear();
      }
      
      nodes = sortedBubbles.map((d) => {
        const radius = sizeScale(d.value);
        const existing = positionsRef.current.get(d.originalName);
        return {
          ...d,
          radius,
          x: existing?.x ?? width / 2,
          y: existing?.y ?? height / 2,
        };
      });

      // Use d3 force simulation for packed bubbles on mobile
      const simulation = d3.forceSimulation(nodes as any)
        .force('x', d3.forceX(width / 2).strength(0.05))
        .force('y', d3.forceY(height / 2).strength(0.05))
        .force('collision', d3.forceCollide().radius((d: any) => d.radius + 3))
        .stop();

      // Run simulation for more iterations to get better packing
      for (let i = 0; i < 150; ++i) simulation.tick();

      // Stop the simulation
      simulation.stop();
    } else {
      // Desktop: Calculate positions in a horizontal line with randomized vertical placement
      // Clear positions when switching to desktop to force recalculation
      if (!hasInitializedRef.current || isMobileRef.current) {
        positionsRef.current.clear();
      }
      
      // Helper function to generate consistent "random" value from string
      const hashString = (str: string): number => {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          const char = str.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash);
      };
      
      nodes = sortedBubbles.map((d, index) => {
        const radius = sizeScale(d.value);
        const existing = positionsRef.current.get(d.originalName);
        
        // Calculate horizontal position
        // Start from left, spacing bubbles with padding
        let x = 0;
        if (index === 0) {
          x = radius + 20; // First bubble: left edge + padding
        } else {
          // Sum up all previous bubble diameters plus padding
          for (let i = 0; i < index; i++) {
            const prevRadius = sizeScale(sortedBubbles[i].value);
            x += prevRadius * 2 + 20; // diameter + padding
          }
          x += radius; // Add current bubble radius
        }
        
        // Randomize vertical position (consistent based on originalName)
        const hash = hashString(d.originalName);
        const maxVerticalOffset = height * 0.25; // Allow up to 25% of height variation
        const verticalOffset = ((hash % 200) / 200 - 0.5) * maxVerticalOffset;
        const baseY = height / 2;
        const y = Math.max(radius + 10, Math.min(height - radius - 10, baseY + verticalOffset));
        
        return {
          ...d,
          radius,
          x: existing?.x ?? x,
          y: existing?.y ?? y,
        };
      });

      // Calculate total width needed and center if needed
      const totalWidth = nodes.reduce((sum, node, index) => {
        if (index === 0) return node.radius * 2 + 20;
        return sum + node.radius * 2 + 20;
      }, 0);
      
      const startX = totalWidth < width ? (width - totalWidth) / 2 : 20;
      
      // Update x positions to center if total width is less than container
      if (totalWidth < width) {
        let currentX = startX;
        nodes.forEach((node, index) => {
          if (index === 0) {
            currentX = startX + node.radius;
          } else {
            const prevRadius = nodes[index - 1].radius;
            currentX += prevRadius + node.radius + 20;
          }
          node.x = currentX;
        });
      }
    }

    // Update positions in ref
    nodes.forEach((node: any) => {
      positionsRef.current.set(node.originalName, {
        x: node.x,
        y: node.y,
        radius: node.radius,
      });
    });
    
    hasInitializedRef.current = true;

    // Update or create bubbles
    const bubbles = svg.selectAll<SVGGElement, any>('g.bubble')
      .data(nodes, (d: any) => d.originalName);

    // Remove bubbles that no longer exist
    bubbles.exit().remove();

    // Enter new bubbles
    const bubblesEnter = bubbles.enter()
      .append('g')
      .attr('class', 'bubble')
      .attr('transform', (d: any) => {
        const pos = positionsRef.current.get(d.originalName);
        return `translate(${pos?.x ?? d.x},${pos?.y ?? d.y})`;
      });

    // Merge enter and update selections
    const bubblesMerged = bubblesEnter.merge(bubbles);

    // Add circles for new bubbles
    const circlesEnter = bubblesEnter.append('circle')
      .attr('r', 0)
      .attr('fill', (d: any) => d.color)
      .attr('opacity', (d: any) => (d.isActive || !hasActiveBubble ? 0.8 : 0.35))
      .attr('stroke', (d: any) => d.color)
      .attr('stroke-width', (d: any) => (d.isActive ? 4 : 2))
      .style('cursor', 'pointer')
      .on('mouseenter', function(event, d: any) {
        const pos = positionsRef.current.get(d.originalName);
        const currentRadius = pos?.radius ?? d.radius;
        d3.select(this)
          .transition()
          .duration(200)
          .attr('opacity', 1)
          .attr('r', currentRadius * 1.1);
        
        // Show tooltip with percentage
        const [mouseX, mouseY] = d3.pointer(event, container);
        tooltip
          .style('left', `${mouseX + 10}px`)
          .style('top', `${mouseY - 10}px`)
          .html(`${d.name}: ${d.percentage.toFixed(1)}%`)
          .transition()
          .duration(200)
          .style('opacity', 1);
      })
      .on('mousemove', function(event, d: any) {
        // Update tooltip position as mouse moves
        const [mouseX, mouseY] = d3.pointer(event, container);
        tooltip
          .style('left', `${mouseX + 10}px`)
          .style('top', `${mouseY - 10}px`);
      })
      .on('mouseleave', function(event, d: any) {
        const pos = positionsRef.current.get(d.originalName);
        const currentRadius = pos?.radius ?? d.radius;
        d3.select(this)
          .transition()
          .duration(200)
          .attr('opacity', d.isActive || !hasActiveBubble ? 0.8 : 0.35)
          .attr('r', currentRadius);
        
        // Hide tooltip
        tooltip
          .transition()
          .duration(200)
          .style('opacity', 0);
      })
      .on('click', function(event, d: any) {
        if (onBubbleFilter) {
          onBubbleFilter(d.originalName, d.extensions ?? []);
        }
      });
    
    circlesEnter
      .transition()
      .duration(300)
      .attr('r', (d: any) => d.radius);

    // Update existing circles (size only, no position change)
    const circlesUpdate = bubbles.select('circle');
    circlesUpdate
      .transition()
      .duration(300)
      .attr('r', (d: any) => {
        const pos = positionsRef.current.get(d.originalName);
        return pos?.radius ?? d.radius;
      })
      .attr('fill', (d: any) => d.color)
      .attr('stroke', (d: any) => d.color)
      .attr('opacity', (d: any) => (d.isActive || !hasActiveBubble ? 0.8 : 0.35))
      .attr('stroke-width', (d: any) => (d.isActive ? 4 : 2));
    
    // Attach event handlers to the actual elements (not the transition)
    circlesUpdate
      .on('mouseenter', function(event, d: any) {
        const pos = positionsRef.current.get(d.originalName);
        const currentRadius = pos?.radius ?? d.radius;
        d3.select(this)
          .transition()
          .duration(200)
          .attr('opacity', 1)
          .attr('r', currentRadius * 1.1);
        
        // Show tooltip with percentage
        const [mouseX, mouseY] = d3.pointer(event, container);
        tooltip
          .style('left', `${mouseX + 10}px`)
          .style('top', `${mouseY - 10}px`)
          .html(`${d.name}: ${d.percentage.toFixed(1)}%`)
          .transition()
          .duration(200)
          .style('opacity', 1);
      })
      .on('mousemove', function(event, d: any) {
        // Update tooltip position as mouse moves
        const [mouseX, mouseY] = d3.pointer(event, container);
        tooltip
          .style('left', `${mouseX + 10}px`)
          .style('top', `${mouseY - 10}px`);
      })
      .on('mouseleave', function(event, d: any) {
        const pos = positionsRef.current.get(d.originalName);
        const currentRadius = pos?.radius ?? d.radius;
        d3.select(this)
          .transition()
          .duration(200)
          .attr('opacity', d.isActive || !hasActiveBubble ? 0.8 : 0.35)
          .attr('r', currentRadius);
        
        // Hide tooltip
        tooltip
          .transition()
          .duration(200)
          .style('opacity', 0);
      })
      .on('click', function(event, d: any) {
        if (onBubbleFilter) {
          onBubbleFilter(d.originalName, d.extensions ?? []);
        }
      });

    // Handle text labels (name) - enter/update pattern
    const labels = bubblesMerged.selectAll<SVGTextElement, any>('text.bubble-label')
      .data((d: any) => [d], (d: any) => d.originalName);
    
    labels.exit().remove();
    
    const labelsEnter = labels.enter()
      .append('text')
      .attr('class', 'bubble-label')
      .attr('text-anchor', 'middle')
      .attr('dy', '.35em')
      .attr('fill', '#fff')
      .attr('font-weight', '600')
      .style('font-family', 'system-ui, -apple-system, sans-serif')
      .style('pointer-events', 'none')
      .style('user-select', 'none')
      .style('opacity', 0);
    
    const labelsMerged = labelsEnter.merge(labels);
    
    labelsMerged
      .text((d: any) => d.name)
      .transition()
      .duration(300)
      .attr('font-size', (d: any) => {
        const pos = positionsRef.current.get(d.originalName);
        return Math.min((pos?.radius ?? d.radius) / 3, 12);
      })
      .style('font-family', 'system-ui, -apple-system, sans-serif')
      .style('opacity', 1);

    // Handle value labels (count) - enter/update pattern
    const counts = bubblesMerged.selectAll<SVGTextElement, any>('text.bubble-count')
      .data((d: any) => [d], (d: any) => d.originalName);
    
    counts.exit().remove();
    
    const countsEnter = counts.enter()
      .append('text')
      .attr('class', 'bubble-count')
      .attr('text-anchor', 'middle')
      .attr('fill', 'currentColor')
      .attr('font-size', 11)
      .style('pointer-events', 'none')
      .style('user-select', 'none')
      .style('opacity', 0);
    
    const countsMerged = countsEnter.merge(counts);
    
    countsMerged
      .text((d: any) => formatNumber(d.value))
      .transition()
      .duration(300)
      .attr('dy', (d: any) => {
        const pos = positionsRef.current.get(d.originalName);
        return (pos?.radius ?? d.radius) + 15;
      })
      .style('opacity', 0.7);

    // Update positions for all bubbles with smooth transition
    bubblesMerged.transition()
      .duration(300)
      .attr('transform', (d: any) => {
        const pos = positionsRef.current.get(d.originalName);
        return `translate(${pos?.x ?? d.x},${pos?.y ?? d.y})`;
      });

    // Cleanup
    return () => {
      // Don't stop simulation on cleanup if we want to keep positions
    };
  }, [bubbleDataWithMeta, hasActiveBubble, onBubbleFilter]);

  if (bubbleDataWithMeta.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-8 bg-white dark:bg-zinc-900 flex items-center justify-center h-64">
        <div className="text-sm text-zinc-500 dark:text-zinc-400">No data available</div>
      </div>
    );
  }

  // Mobile view: show pills/badges
  const [isMobileView, setIsMobileView] = useState(false);
  
  useEffect(() => {
    const checkMobile = () => {
      setIsMobileView(window.innerWidth < 640);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  if (isMobileView) {
    // Sort by value (largest to smallest) for mobile view
    const sortedPills = Array.isArray(bubbleDataWithMeta)
      ? [...bubbleDataWithMeta].sort((a, b) => b.value - a.value)
      : [];
    const hasActiveSelection = Boolean(selectedTypeKey);
    
    return (
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 sm:p-6 bg-white dark:bg-zinc-900">
        <div className="flex flex-wrap gap-2 justify-center">
          {sortedPills.map((item) => (
            <div
              key={item.originalName}
              onClick={() => onBubbleFilter?.(item.originalName, item.extensions ?? [])}
              className={`px-3 py-1.5 rounded-full text-xs sm:text-sm font-medium flex items-center gap-2 cursor-pointer transition`}
              style={{
                backgroundColor: `${item.color}20`,
                color: item.color,
                border: `1px solid ${item.color}40`,
                opacity: item.isActive || !hasActiveSelection ? 1 : 0.5,
              }}
            >
              <span className="font-vibur">{item.name}</span>
              <span className="opacity-70">({formatNumber(item.value)})</span>
            </div>
          ))}
        </div>
        {hasOther && (
        <div className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
          {Object.keys(otherBreakdown).length > 0 ? (
            <div>
              <div className="font-medium mb-2">Other file types:</div>
              <div className="flex flex-wrap gap-2 justify-center">
                {Object.entries(otherBreakdown)
                  .sort(([, a], [, b]) => b - a)
                  .map(([ext, count]) => (
                    <span key={ext} className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800">
                      .{ext}: {formatNumber(count)}
                    </span>
                  ))}
              </div>
            </div>
          ) : otherExtensions.length > 0 ? (
            <div className="text-center">
              (Other includes: {otherExtensions.join(', ')})
            </div>
          ) : (
            <div className="text-center">
              (Other file types)
            </div>
          )}
        </div>
      )}
      </div>
    );
  }

  // Desktop view: show bubble chart
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 sm:p-6 bg-white dark:bg-zinc-900">
      <div ref={containerRef} className="w-full relative" style={{ height: '350px', minHeight: '300px' }}>
        <svg ref={svgRef} className="w-full h-full" />
      </div>
      {hasOther && (
        <div className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
          {Object.keys(otherBreakdown).length > 0 ? (
            <div>
              <div className="font-medium mb-2">Other file types:</div>
              <div className="flex flex-wrap gap-2 justify-center">
                {Object.entries(otherBreakdown)
                  .sort(([, a], [, b]) => b - a)
                  .map(([ext, count]) => (
                    <span key={ext} className="px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800">
                      .{ext}: {formatNumber(count)}
                    </span>
                  ))}
              </div>
            </div>
          ) : otherExtensions.length > 0 ? (
            <div className="text-center">
              (Other includes: {otherExtensions.join(', ')})
            </div>
          ) : (
            <div className="text-center">
              (Other file types)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Card components for desktop sidebar
function FileDiscoveryCard({ stats, isScanRunning, lastScan }: { stats: any; isScanRunning: boolean; lastScan: any }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 bg-white dark:bg-zinc-900">
      <h2 className="text-base sm:text-lg font-semibold mb-2 sm:mb-3 border-b border-zinc-200 dark:border-zinc-800 pb-1.5 sm:pb-2 flex items-center justify-between">
        <span>Discovery</span>
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
            isScanRunning ? 'bg-green-500 text-white' : 'bg-gray-400 text-white'
          }`}
        >
          {isScanRunning ? 'active' : 'idle'}
        </span>
      </h2>
      <div className="space-y-1.5 sm:space-y-2 text-xs sm:text-sm">
        <div className="flex justify-between">
          <span className="text-zinc-600 dark:text-zinc-400">Files Discovered</span>
          <span className="font-semibold">
            {formatNumber(
              stats.discovery?.files_discovered ??
              stats.current_scan?.files_discovered ??
              stats.current_scan?.files_processed ??
              lastScan?.files ??
              0
            )}
            {(() => {
              // Use current scan rate when available, otherwise fall back to last completed scan rate
              const rate = (() => {
                if (typeof stats.current_scan?.files_per_sec === 'number') {
                  return stats.current_scan.files_per_sec;
                }
                if (!isScanRunning && typeof lastScan?.rate === 'number') {
                  return lastScan.rate;
                }
                return stats.processed?.files_per_sec ?? 0;
              })();
              if (rate > 0) {
                let formattedRate: string;
                if (rate >= 1000) {
                  formattedRate = rate.toLocaleString('en-US', { maximumFractionDigits: 1 });
                } else if (rate >= 100) {
                  formattedRate = rate.toFixed(1);
                } else if (rate >= 1) {
                  formattedRate = rate.toFixed(2);
                } else {
                  formattedRate = rate.toFixed(3);
                }
                return (
                  <>
                    {' @ '}
                    <span className="tabular-nums">{formattedRate}</span>
                    <span className="text-xs sm:text-sm opacity-70 ml-1">files/sec</span>
                  </>
                );
              }
              return '';
            })()}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-600 dark:text-zinc-400">
            {stats.current_scan ? 'Current Scan' : lastScan ? 'Completed Scan' : 'Time'}
          </span>
          <span className="font-semibold">
            {(() => {
              if (stats.current_scan) {
                const files = formatNumber(stats.current_scan.files_discovered ?? stats.current_scan.files_processed);
                const time = isScanRunning && stats.current_scan.elapsed_seconds !== undefined
                  ? formatDuration(stats.current_scan.elapsed_seconds)
                  : lastScan?.elapsed !== undefined
                  ? formatDuration(lastScan.elapsed)
                  : '-';
                return (
                  <>
                    {files} files
                    {time !== '-' && (
                      <>
                        {' / '}
                        {time}
                      </>
                    )}
                  </>
                );
              } else if (lastScan) {
                const completedTime = lastScan.completedAt
                  ? formatCompletionTime(lastScan.completedAt)
                  : null;
                const duration = lastScan.elapsed !== undefined
                  ? formatDuration(lastScan.elapsed)
                  : null;
                if (!completedTime && !duration) {
                  return '-';
                }
                return (
                  <>
                    {completedTime ?? '-'}
                    {duration && (
                      <>
                        {' • '}
                        {duration}
                      </>
                    )}
                  </>
                );
              } else {
                return isScanRunning && stats.current_scan?.elapsed_seconds !== undefined
                  ? formatDuration(stats.current_scan.elapsed_seconds)
                  : '-';
              }
            })()}
          </span>
        </div>
      </div>
    </div>
  );
}

function ProcessingProgressCard({ stats, lastProcessing, processingElapsedLive, isProcessingActive }: { stats: any; lastProcessing: { files: number; elapsed: number } | null; processingElapsedLive: number | null; isProcessingActive: boolean }) {
  // Use backend state directly for display, not the fallback
  // This ensures we show completed values immediately when backend says processing is done
  const backendProcessingActive = (stats?.scan_running === true) || (stats?.processing_active === true);
  const isProcessing = backendProcessingActive;
  
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 bg-white dark:bg-zinc-900">
      <h2 className="text-base sm:text-lg font-semibold mb-2 sm:mb-3 border-b border-zinc-200 dark:border-zinc-800 pb-1.5 sm:pb-2 flex items-center justify-between">
        <span>Indexing</span>
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
            isProcessing ? 'bg-green-500 text-white' : 'bg-gray-400 text-white'
          }`}
        >
          {isProcessing ? 'active' : 'idle'}
        </span>
      </h2>
      <div className="space-y-1.5 sm:space-y-2 text-xs sm:text-sm">
        <div className="flex justify-between">
          <span className="text-zinc-600 dark:text-zinc-400">Files Processed</span>
          <span className="font-semibold">
            {(() => {
              const files = formatNumber(stats.processing?.files_committed ?? stats.db?.assets ?? 0);
              const completedElapsed = stats.processing?.last_completed_elapsed_seconds;
              
              let timeSeconds: number | null = null;
              if (isProcessing) {
                if (typeof processingElapsedLive === 'number') {
                  timeSeconds = processingElapsedLive;
                } else if (stats.current_processing?.elapsed_seconds !== undefined) {
                  timeSeconds = stats.current_processing.elapsed_seconds;
                }
              } else if (!isProcessing) {
                if (typeof completedElapsed === 'number' && completedElapsed >= 0) {
                  timeSeconds = completedElapsed;
                } else if (lastProcessing?.elapsed !== undefined) {
                  timeSeconds = lastProcessing.elapsed;
                }
              }
              
              const time = typeof timeSeconds === 'number'
                ? formatDurationNoDecimals(timeSeconds)
                : null;
              
              return (
                <>
                  {files}
                  {time && (
                    <>
                      {' • '}
                      {time}
                    </>
                  )}
                </>
              );
            })()}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-600 dark:text-zinc-400">Data Processed</span>
          <span className="font-semibold">
            {formatBytes(stats.processing?.bytes_total ?? stats.processed?.bytes_total ?? 0)}
            {(() => {
              const throughput = stats.processing?.throughput_mb_per_sec ?? stats.processed?.mb_per_sec ?? 0;
              if (throughput > 0) {
                return ` @ ${throughput.toFixed(2)} MB/s`;
              }
              return '';
            })()}
          </span>
        </div>
        {(() => {
          const filesDiscovered = stats.discovery?.files_discovered ?? stats.processed?.files_total ?? 0;
          const filesCatalogued = stats.processing?.files_committed ?? stats.db?.assets ?? 0;
          const percentage = filesDiscovered > 0 ? Math.min((filesCatalogued / filesDiscovered) * 100, 100) : 0;
          
          if (filesDiscovered > 0) {
            return (
              <div className="pt-2">
                <div className="w-full bg-zinc-200 dark:bg-zinc-700 rounded-full h-2">
                  <div 
                    className="bg-green-600 dark:bg-green-500 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${percentage}%` }}
                  />
                </div>
                <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-1 text-center">
                  {filesCatalogued.toLocaleString()} / {filesDiscovered.toLocaleString()} ({percentage.toFixed(1)}%)
                </div>
              </div>
            );
          }
          return null;
        })()}
      </div>
    </div>
  );
}

function SystemInfoCard({ perf, stats }: { perf: any; stats: any }) {
  const gpuEnabled = perf.gpu_usage.enabled && !perf.gpu_usage.auto_disabled;
  const gpuAutoDisabled = perf.gpu_usage.auto_disabled;
  
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 bg-white dark:bg-zinc-900">
      <h2 className="text-base sm:text-lg font-semibold mb-2 sm:mb-3 border-b border-zinc-200 dark:border-zinc-800 pb-1.5 sm:pb-2">
        System
      </h2>
      <div className="space-y-1.5 sm:space-y-2 text-xs sm:text-sm">
        <div className="flex justify-between">
          <span className="text-zinc-600 dark:text-zinc-400">Processor</span>
          <span className="font-semibold text-xs break-words text-right max-w-[60%]">
            {perf.system_info.cpu_brand !== 'Unknown'
              ? `${perf.system_info.cpu_brand} (${perf.system_info.cpu_cores} cores)`
              : `${perf.system_info.cpu_cores} cores`}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-600 dark:text-zinc-400">Accelerator</span>
          <span
            className={`font-semibold ${
              gpuAutoDisabled
                ? 'text-red-600 dark:text-red-400'
                : gpuEnabled
                  ? 'text-green-600 dark:text-green-400'
                  : ''
            }`}
          >
            {perf.system_info.accel}
            {gpuAutoDisabled ? ' (Auto-disabled)' : gpuEnabled ? ' (GPU)' : ''}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-600 dark:text-zinc-400">Uptime</span>
          <span className="font-semibold">{formatDurationNoDecimals(stats.uptime_seconds)}</span>
        </div>
      </div>
    </div>
  );
}

function PerformanceSection({
  perf,
  stats,
  lastActive,
  lastScan,
  lastProcessing,
  processingElapsedLive,
  isScanActive,
  isProcessingActive,
  resetStatsMutation,
}: {
  perf: any;
  stats: any;
  lastActive: { filesPerSec: number; mbPerSec: number; status: string } | null;
  lastScan: {
    files: number;
    photos?: number;
    videos?: number;
    rate: number;
    status: string;
    elapsed: number;
    completedAt?: number;
  } | null;
  lastProcessing: {
    files: number;
    elapsed: number;
  } | null;
  processingElapsedLive: number | null;
  isScanActive: boolean;
  isProcessingActive: boolean;
  resetStatsMutation: {
    mutate: () => void;
    isPending: boolean;
  };
}) {
  // Use scan_running directly to determine if scan is actually running
  // is_active includes queued items, which can be true even after scan stops
  const backendScanRunning = stats.scan_running === true;
  const backendProcessingActive = stats.scan_running === true || stats.processing_active === true;
  const scanPillActive = isScanActive;
  const processingPillActive = isProcessingActive;
  const isScanRunning = backendScanRunning;
  const gpuEnabled = perf.gpu_usage.enabled && !perf.gpu_usage.auto_disabled;
  const gpuAutoDisabled = perf.gpu_usage.auto_disabled;

  return (
    <section className="space-y-3 sm:space-y-6">
      {/* Hide these 3 cards on desktop (lg:) since they're shown in the sidebar */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-4 lg:hidden">
        {/* File Discovery */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 bg-white dark:bg-zinc-900">
          <h2 className="text-base sm:text-lg font-semibold mb-2 sm:mb-3 border-b border-zinc-200 dark:border-zinc-800 pb-1.5 sm:pb-2 flex items-center justify-between">
            <span>Discovery</span>
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                scanPillActive ? 'bg-green-500 text-white' : 'bg-gray-400 text-white'
              }`}
            >
              {scanPillActive ? 'active' : 'idle'}
            </span>
          </h2>
          <div className="space-y-1.5 sm:space-y-2 text-xs sm:text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Files Discovered</span>
              <span className="font-semibold">
                {formatNumber(stats.discovery?.files_discovered ?? stats.processed?.files_total ?? 0)}
                {(() => {
                  const rate = stats.discovery?.rate_files_per_sec ?? stats.processed.files_per_sec ?? 0;
                  if (rate > 0) {
                    // Format large numbers with commas, show appropriate decimal places
                    let formattedRate: string;
                    if (rate >= 1000) {
                      formattedRate = rate.toLocaleString('en-US', { maximumFractionDigits: 1 });
                    } else if (rate >= 100) {
                      formattedRate = rate.toFixed(1);
                    } else if (rate >= 1) {
                      formattedRate = rate.toFixed(2);
                    } else {
                      formattedRate = rate.toFixed(3);
                    }
                    return (
                      <>
                        {' @ '}
                        <span className="tabular-nums">{formattedRate}</span>
                        <span className="text-xs sm:text-sm opacity-70 ml-1">files/sec</span>
                      </>
                    );
                  }
                  return '';
                })()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">
                {stats.current_scan ? 'Current Scan' : lastScan ? 'Completed Scan' : 'Time'}
              </span>
              <span className="font-semibold">
                {(() => {
                  if (stats.current_scan) {
                    const files = formatNumber(stats.current_scan.files_discovered ?? stats.current_scan.files_processed);
                    const time = isScanRunning && stats.current_scan.elapsed_seconds !== undefined
                      ? formatDuration(stats.current_scan.elapsed_seconds)
                      : lastScan?.elapsed !== undefined
                      ? formatDuration(lastScan.elapsed)
                      : '-';
                    return (
                      <>
                        {files} files
                        {time !== '-' && (
                          <>
                            {' / '}
                            {time}
                          </>
                        )}
                      </>
                    );
                  } else if (lastScan) {
                    const completedTime = lastScan.completedAt
                      ? formatCompletionTime(lastScan.completedAt)
                      : null;
                    const duration = lastScan.elapsed !== undefined
                      ? formatDuration(lastScan.elapsed)
                      : null;
                    if (!completedTime && !duration) {
                      return '-';
                    }
                    return (
                      <>
                        {completedTime ?? '-'}
                        {duration && (
                          <>
                            {' • '}
                            {duration}
                          </>
                        )}
                      </>
                    );
                  } else {
                    // No current scan, just show time
                    return isScanRunning && stats.current_scan?.elapsed_seconds !== undefined
                      ? formatDuration(stats.current_scan.elapsed_seconds)
                      : '-';
                  }
                })()}
              </span>
            </div>
          </div>
        </div>

        {/* Indexing Progress */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 bg-white dark:bg-zinc-900">
          <h2 className="text-base sm:text-lg font-semibold mb-2 sm:mb-3 border-b border-zinc-200 dark:border-zinc-800 pb-1.5 sm:pb-2 flex items-center justify-between">
            <span>Indexing</span>
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                processingPillActive ? 'bg-green-500 text-white' : 'bg-gray-400 text-white'
              }`}
            >
              {processingPillActive ? 'active' : 'idle'}
            </span>
          </h2>
          <div className="space-y-1.5 sm:space-y-2 text-xs sm:text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Files Processed</span>
              <span className="font-semibold">
                {(() => {
                  const files = formatNumber(stats.processing?.files_committed ?? stats.db?.assets ?? 0);
                  const completedElapsed = stats.processing?.last_completed_elapsed_seconds;
                  
                  let timeSeconds: number | null = null;
                  // Use backendProcessingActive for display logic (not the fallback)
                  // This ensures we show completed values immediately when backend says processing is done
                  if (backendProcessingActive) {
                    if (typeof processingElapsedLive === 'number') {
                      timeSeconds = processingElapsedLive;
                    } else if (stats.current_processing?.elapsed_seconds !== undefined) {
                      timeSeconds = stats.current_processing.elapsed_seconds;
                    }
                  } else {
                    if (typeof completedElapsed === 'number' && completedElapsed >= 0) {
                      timeSeconds = completedElapsed;
                    } else if (lastProcessing?.elapsed !== undefined) {
                      timeSeconds = lastProcessing.elapsed;
                    }
                  }

                  const time = typeof timeSeconds === 'number'
                    ? formatDurationNoDecimals(timeSeconds)
                    : null;

                  // Get throughput rate - show average rate when idle (completed processing)
                  const throughput = !backendProcessingActive
                    ? (stats.processing?.throughput_mb_per_sec ?? stats.processed?.mb_per_sec ?? 0)
                    : 0;
                  
                  return (
                    <>
                      {files}
                      {' files'}
                      {time && (
                        <>
                          {' • '}
                          {time}
                        </>
                      )}
                      {!backendProcessingActive && throughput > 0 && (
                        <>
                          {' @ '}
                          {throughput.toFixed(2)}
                          {' MB/s'}
                        </>
                      )}
                    </>
                  );
                })()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Data Processed</span>
              <span className="font-semibold">
                {(() => {
                  const dataBytes = stats.processing?.bytes_total ?? stats.processed?.bytes_total ?? 0;
                  const dataSize = formatBytes(dataBytes);
                  
                  // Get throughput - always show if available (backend provides last completed throughput when idle)
                  const throughput = stats.processing?.throughput_mb_per_sec ?? stats.processed?.mb_per_sec ?? 0;
                  
                  // Get processing rate
                  let processingRate = 0;
                  if (backendProcessingActive && stats.current_processing?.processing_rate_files_per_sec !== undefined) {
                    processingRate = stats.current_processing.processing_rate_files_per_sec;
                  } else if (stats.processing?.rate_files_per_sec !== undefined) {
                    processingRate = stats.processing?.rate_files_per_sec ?? 0;
                  }
                  
                  // Combine data size, throughput, and processing rate with @ symbols
                  // Always show throughput if available (even when idle, backend provides average)
                  let result = dataSize;
                  if (throughput > 0) {
                    result += ` @ ${throughput.toFixed(2)} MB/s`;
                  }
                  if (processingRate > 0) {
                    result += ` @ ${processingRate.toFixed(2)} files/sec`;
                  }
                  return result;
                })()}
              </span>
            </div>
            {(() => {
              const filesDiscovered = stats.discovery?.files_discovered ?? stats.processed?.files_total ?? 0;
              const filesCatalogued = stats.processing?.files_committed ?? stats.db?.assets ?? 0;
              const percentage = filesDiscovered > 0 ? Math.min((filesCatalogued / filesDiscovered) * 100, 100) : 0;
              
              if (filesDiscovered > 0) {
                return (
                  <div className="pt-2">
                    <div className="w-full bg-zinc-200 dark:bg-zinc-700 rounded-full h-2">
                      <div 
                        className="bg-green-600 dark:bg-green-500 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-1 text-center">
                      {filesCatalogued.toLocaleString()} / {filesDiscovered.toLocaleString()} ({percentage.toFixed(1)}%)
                    </div>
                  </div>
                );
              }
              return null;
            })()}
          </div>
        </div>

        {/* System Info */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 bg-white dark:bg-zinc-900">
          <h2 className="text-base sm:text-lg font-semibold mb-2 sm:mb-3 border-b border-zinc-200 dark:border-zinc-800 pb-1.5 sm:pb-2">
            System
          </h2>
          <div className="space-y-1.5 sm:space-y-2 text-xs sm:text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Processor</span>
              <span className="font-semibold text-xs break-words text-right max-w-[60%]">
                {perf.system_info.cpu_brand !== 'Unknown'
                  ? `${perf.system_info.cpu_brand} (${perf.system_info.cpu_cores} cores)`
                  : `${perf.system_info.cpu_cores} cores`}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Accelerator</span>
              <span
                className={`font-semibold ${
                  gpuAutoDisabled
                    ? 'text-red-600 dark:text-red-400'
                    : gpuEnabled
                      ? 'text-green-600 dark:text-green-400'
                      : ''
                }`}
              >
                {perf.system_info.accel}
                {gpuAutoDisabled ? ' (Auto-disabled)' : gpuEnabled ? ' (GPU)' : ''}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Uptime</span>
              <span className="font-semibold">{formatDurationNoDecimals(stats.uptime_seconds)}</span>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}


