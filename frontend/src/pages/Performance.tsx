import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useStats, usePageVisibility } from '../lib/hooks';
import { formatNumber } from '../lib/utils';
import { useState, useEffect } from 'react';

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

function getStatusClass(status: string): string {
  if (status === 'excellent') return 'bg-green-500 text-white';
  if (status === 'good') return 'bg-blue-500 text-white';
  if (status === 'average') return 'bg-yellow-500 text-white';
  if (status === 'slow') return 'bg-red-500 text-white';
  return 'bg-gray-500 text-white';
}

function getStatusText(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export default function Performance() {
  const { data: stats } = useStats();
  const isPageVisible = usePageVisibility();
  const { data: perf, isLoading, error } = useQuery({
    queryKey: ['performance'],
    queryFn: () => api.performance(),
    enabled: isPageVisible,
    refetchInterval: (query) => (!isPageVisible || query.state.error) ? false : 2000,
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
  } | null>(null);

  // Store last active values when processing, use them when idle
  useEffect(() => {
    if (perf && stats) {
      if (perf.seen.is_active && stats.processed.files_per_sec > 0) {
        setLastActive({
          filesPerSec: stats.processed.files_per_sec,
          mbPerSec: stats.processed.mb_per_sec || 0,
          status: perf.seen.status,
        });
      }
      if (perf.current_scan) {
        setLastScan({
          files: perf.current_scan.files_processed,
          photos: perf.current_scan.photos_processed,
          videos: perf.current_scan.videos_processed,
          rate: perf.current_scan.files_per_sec,
          status: perf.current_scan.status,
          elapsed: perf.current_scan.elapsed_seconds,
        });
      }
    }
  }, [perf, stats]);

  if (isLoading) {
    return (
      <div className="container-responsive py-6">
        <div className="text-center py-12">Loading performance data...</div>
      </div>
    );
  }

  if (error || !perf || !stats) {
    return (
      <div className="container-responsive py-6">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg p-4">
          Error loading performance data: {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      </div>
    );
  }

  const isActive = perf.seen.is_active;
  const currentRate = perf.seen.current_rate;
  const currentStatus = perf.seen.status;

  // Use last active values when idle
  const displayFilesPerSec = isActive
    ? stats.processed.files_per_sec
    : lastActive?.filesPerSec || stats.processed.files_per_sec;
  const displayMbPerSec = isActive
    ? stats.processed.mb_per_sec || 0
    : lastActive?.mbPerSec || stats.processed.mb_per_sec || 0;
  const displayStatus = isActive ? currentStatus : lastActive?.status || currentStatus;

  // Parse range strings for comparison
  function parseRange(rangeStr: string): number {
    if (rangeStr.includes('+')) {
      return parseFloat(rangeStr.replace('+', ''));
    }
    if (rangeStr.includes('-')) {
      const parts = rangeStr.split('-');
      return (parseFloat(parts[0]) + parseFloat(parts[1])) / 2;
    }
    return parseFloat(rangeStr) || 0;
  }

  // Build comparison entries
  const comparisonEntries = [
    {
      name: 'Seen (You)',
      rate: isActive ? currentRate : 0,
      display: isActive ? currentRate.toFixed(2) : '0.00',
      note: perf.seen.status,
      isSeen: true,
    },
    ...(typeof perf.typical_ranges === 'object' && perf.typical_ranges !== null && !Array.isArray(perf.typical_ranges)
      ? Object.entries(perf.typical_ranges).map(([name, data]) => ({
          name:
            name === 'synology_ds220_plus'
              ? 'Synology DiskStation DS220+'
              : name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' '),
          rate: parseRange(data.files_per_sec),
          display: data.files_per_sec,
          note: data.note,
          isSeen: false,
        }))
      : []),
  ].sort((a, b) => b.rate - a.rate);

  const gpuEnabled = perf.gpu_usage.enabled && !perf.gpu_usage.auto_disabled;
  const gpuAutoDisabled = perf.gpu_usage.auto_disabled;

  return (
    <div className="container-responsive py-3 sm:py-6 space-y-3 sm:space-y-6">
      <h1 className="text-xl sm:text-2xl font-semibold">Performance</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
        {/* Overall Performance */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 bg-white dark:bg-zinc-900">
          <h2 className="text-base sm:text-lg font-semibold mb-2 sm:mb-3 border-b border-zinc-200 dark:border-zinc-800 pb-1.5 sm:pb-2">
            Overall Performance
          </h2>
          <div className="space-y-1.5 sm:space-y-2 text-xs sm:text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Files Processed</span>
              <span className="font-semibold text-lg">{formatNumber(stats.processed.files_total)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Files/Second</span>
              <span className="font-semibold text-lg">{displayFilesPerSec.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Data Processed</span>
              <span className="font-semibold">{formatBytes(stats.processed.bytes_total)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Throughput</span>
              <span className="font-semibold">{displayMbPerSec.toFixed(2)} MB/s</span>
            </div>
            <div className="flex justify-between items-center pt-2">
              <span className="text-zinc-600 dark:text-zinc-400">Status</span>
              <span
                className={`px-3 py-1 rounded-full text-xs font-semibold ${getStatusClass(displayStatus)}`}
              >
                {getStatusText(displayStatus)}
              </span>
            </div>
          </div>
        </div>

        {/* Current/Last Scan */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 bg-white dark:bg-zinc-900">
          <h2 className="text-base sm:text-lg font-semibold mb-2 sm:mb-3 border-b border-zinc-200 dark:border-zinc-800 pb-1.5 sm:pb-2">
            {isActive && perf.current_scan ? '🔄 Current Scan' : '🕓 Last Scan'}
          </h2>
          {isActive && perf.current_scan ? (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-600 dark:text-zinc-400">Files Processed</span>
                <span className="font-semibold text-lg">{formatNumber(perf.current_scan.files_processed)}</span>
              </div>
              {perf.current_scan.photos_processed !== undefined && (
                <div className="flex justify-between">
                  <span className="text-zinc-600 dark:text-zinc-400">Photos</span>
                  <span className="font-semibold">{formatNumber(perf.current_scan.photos_processed)}</span>
                </div>
              )}
              {perf.current_scan.videos_processed !== undefined && (
                <div className="flex justify-between">
                  <span className="text-zinc-600 dark:text-zinc-400">Videos</span>
                  <span className="font-semibold">{formatNumber(perf.current_scan.videos_processed)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-zinc-600 dark:text-zinc-400">Files/Second</span>
                <span className="font-semibold text-lg">{perf.current_scan.files_per_sec.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-600 dark:text-zinc-400">Elapsed Time</span>
                <span className="font-semibold">{formatDuration(perf.current_scan.elapsed_seconds)}</span>
              </div>
              <div className="flex justify-between items-center pt-2">
                <span className="text-zinc-600 dark:text-zinc-400">Status</span>
                <span
                  className={`px-3 py-1 rounded-full text-xs font-semibold ${getStatusClass(perf.current_scan.status)}`}
                >
                  {getStatusText(perf.current_scan.status)}
                </span>
              </div>
            </div>
          ) : lastScan ? (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-600 dark:text-zinc-400">Files Processed</span>
                <span className="font-semibold text-lg">{formatNumber(lastScan.files)}</span>
              </div>
              {lastScan.photos !== undefined && (
                <div className="flex justify-between">
                  <span className="text-zinc-600 dark:text-zinc-400">Photos</span>
                  <span className="font-semibold">{formatNumber(lastScan.photos)}</span>
                </div>
              )}
              {lastScan.videos !== undefined && (
                <div className="flex justify-between">
                  <span className="text-zinc-600 dark:text-zinc-400">Videos</span>
                  <span className="font-semibold">{formatNumber(lastScan.videos)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-zinc-600 dark:text-zinc-400">Files/Second</span>
                <span className="font-semibold text-lg">{lastScan.rate.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-600 dark:text-zinc-400">Scan Time</span>
                <span className="font-semibold">{formatDuration(lastScan.elapsed)}</span>
              </div>
              <div className="flex justify-between items-center pt-2">
                <span className="text-zinc-600 dark:text-zinc-400">Status</span>
                <span
                  className={`px-3 py-1 rounded-full text-xs font-semibold ${getStatusClass(lastScan.status)}`}
                >
                  {getStatusText(lastScan.status)}
                </span>
              </div>
            </div>
          ) : (
            <div className="text-center text-zinc-500 dark:text-zinc-400 py-4">No previous scans</div>
          )}
        </div>

        {/* Queue Status */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 bg-white dark:bg-zinc-900">
          <h2 className="text-lg font-semibold mb-3 border-b border-zinc-200 dark:border-zinc-800 pb-2">
            Queue Status
          </h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Discover</span>
              <span className="font-semibold">{stats.queues.discover}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Hash</span>
              <span className="font-semibold">{stats.queues.hash}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Metadata</span>
              <span className="font-semibold">{stats.queues.metadata}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">DB Write</span>
              <span className="font-semibold">{stats.queues.db_write}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Thumbnail</span>
              <span className="font-semibold">{stats.queues.thumb}</span>
            </div>
          </div>
        </div>

        {/* System Info */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 bg-white dark:bg-zinc-900">
          <h2 className="text-lg font-semibold mb-3 border-b border-zinc-200 dark:border-zinc-800 pb-2">
            System Info
          </h2>
          <div className="space-y-2 text-sm">
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
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">Assets in DB</span>
              <span className="font-semibold">{formatNumber(stats.db.assets)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Performance Comparison Table */}
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 lg:p-6 bg-white dark:bg-zinc-900 overflow-x-auto">
        <h2 className="text-base sm:text-lg font-semibold mb-2 sm:mb-4 border-b border-zinc-200 dark:border-zinc-800 pb-1.5 sm:pb-2">
          Performance Comparison
        </h2>
        <div className="mb-2 sm:mb-4 p-2 sm:p-3 bg-blue-50 dark:bg-blue-900/20 rounded text-xs sm:text-sm text-zinc-600 dark:text-zinc-400">
          <strong>System:</strong> {perf.system_info.cpu_cores} CPU cores detected
          <br />
          <span className="italic">{perf.system_info.note}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs sm:text-sm min-w-[500px]">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="text-left p-2 sm:p-3 bg-zinc-50 dark:bg-zinc-800 font-semibold text-xs sm:text-sm">Solution</th>
                <th className="text-left p-2 sm:p-3 bg-zinc-50 dark:bg-zinc-800 font-semibold text-xs sm:text-sm">Files/Second</th>
                <th className="text-left p-2 sm:p-3 bg-zinc-50 dark:bg-zinc-800 font-semibold text-xs sm:text-sm">Notes</th>
              </tr>
            </thead>
            <tbody>
              {comparisonEntries.map((entry, idx) => (
                <tr
                  key={idx}
                  className={`border-b border-zinc-200 dark:border-zinc-800 ${
                    entry.isSeen ? 'bg-blue-50 dark:bg-blue-900/20 font-semibold' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  <td className="p-2 sm:p-3 text-xs sm:text-sm">{entry.name}</td>
                  <td className="p-2 sm:p-3 text-xs sm:text-sm">{entry.display}</td>
                  <td className="p-2 sm:p-3 text-xs sm:text-sm">
                    {entry.isSeen ? (
                      <>
                        <span
                          className={`px-2 py-1 rounded-full text-xs font-semibold ${getStatusClass(entry.note)}`}
                        >
                          {getStatusText(entry.note)}
                        </span>
                        {gpuAutoDisabled && (
                          <span className="ml-2 text-red-600 dark:text-red-400 text-xs font-semibold">
                            (GPU Auto-disabled)
                          </span>
                        )}
                        {gpuEnabled && !gpuAutoDisabled && (
                          <span className="ml-2 text-green-600 dark:text-green-400 text-xs font-semibold">(GPU)</span>
                        )}
                        {!isActive && (
                          <span className="ml-2 text-zinc-500 dark:text-zinc-400 text-xs">(Idle)</span>
                        )}
                      </>
                    ) : (
                      <span className="text-zinc-600 dark:text-zinc-400 text-sm">{entry.note}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 sm:mt-4 text-xs sm:text-sm text-zinc-600 dark:text-zinc-400">
          <strong>Notes:</strong>
          <ul className="list-disc list-inside mt-2 space-y-1">
            {Array.isArray(perf.notes) ? perf.notes.map((note, idx) => (
              <li key={idx}>{note}</li>
            )) : null}
          </ul>
        </div>
      </div>
    </div>
  );
}
