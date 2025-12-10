import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { TrashIcon, PlusIcon, FolderOpenIcon, PlayIcon, PauseIcon } from '@heroicons/react/24/outline';
import ConfirmDialog from './ConfirmDialog';
import FileBrowser from './FileBrowser';
import { useUIStore } from '../lib/store';
import { usePageVisibility } from '../lib/hooks';

export default function PathsManager() {
  const queryClient = useQueryClient();
  const [newPath, setNewPath] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [pathToDelete, setPathToDelete] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [pathStatuses, setPathStatuses] = useState<Record<string, { scanning: boolean; watcher_paused: boolean; watching: boolean }>>({});
  const isPageVisible = usePageVisibility();

  // Allow enabling the backend-powered file browser (/browse) explicitly.
  // This is primarily for Docker/WSL, but can be used in any build where the
  // backend exposes /browse and paths are meaningful on that host.
  const fileBrowserEnv = typeof import.meta !== 'undefined' 
    ? (import.meta as any)?.env?.VITE_ENABLE_FILE_BROWSER 
    : undefined;
  // Default to enabling the backend-powered browser when /browse is available.
  const isFileBrowserEnabled = fileBrowserEnv !== undefined
    ? (fileBrowserEnv === '1' || String(fileBrowserEnv || '').toLowerCase() === 'true')
    : true;

  const { data: pathsData = [], isLoading } = useQuery({
    queryKey: ['scanPaths'],
    queryFn: () => api.getScanPaths(),
    enabled: isPageVisible,
    refetchInterval: (query) => (!isPageVisible || query.state.error) ? false : 30000,
  });

  // Handle both old format (string[]) and new format (Array<{path, is_default, host_path}>)
  const paths = pathsData.map((item) => 
    typeof item === 'string' ? { path: item, is_default: false, host_path: null } : item
  );

  // Fetch path statuses for all paths
  useEffect(() => {
    const fetchStatuses = async () => {
      const statusPromises = paths.map(async (item) => {
        try {
          const status = await api.getPathStatus(item.path);
          return { path: item.path, status };
        } catch (error) {
          // If status fetch fails, assume path is not active
          return { path: item.path, status: { scanning: false, watcher_paused: false, watching: false } };
        }
      });
      const results = await Promise.all(statusPromises);
      const statusMap: Record<string, { scanning: boolean; watcher_paused: boolean; watching: boolean }> = {};
      results.forEach(({ path, status }) => {
        statusMap[path] = status;
      });
      setPathStatuses(statusMap);
    };

    if (paths.length > 0 && isPageVisible) {
      fetchStatuses();
      // Poll for status updates every 2 seconds
      const interval = setInterval(fetchStatuses, 2000);
      return () => clearInterval(interval);
    }
  }, [paths, isPageVisible]);

  // Start browser from /host to show mounted directories in Docker/WSL setups.
  // For non-Docker backends this can still be used if /host (or another root)
  // is meaningful on that system.
  const defaultRootPath = '/host';

  const addPathMutation = useMutation({
    mutationFn: (path: string) => api.addScanPath(path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scanPaths'] });
      setNewPath('');
    },
  });

  const removePathMutation = useMutation({
    mutationFn: (path: string) => api.removeScanPath(path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scanPaths'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['fileTypes'] });
      queryClient.invalidateQueries({ queryKey: ['assets'] });
      setDeleteDialogOpen(false);
      setPathToDelete(null);
    },
  });

  const scanPathMutation = useMutation({
    mutationFn: (path: string) => api.scanPath(path),
    onSuccess: (_, path) => {
      // Update local status immediately to show pause button
      setPathStatuses(prev => ({
        ...prev,
        [path]: { scanning: true, watcher_paused: false, watching: true }
      }));
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      // Also refresh all path statuses to ensure consistency
      paths.forEach(async (item) => {
        try {
          const status = await api.getPathStatus(item.path);
          setPathStatuses(prev => ({ ...prev, [item.path]: status }));
        } catch (error) {
          // Ignore errors
        }
      });
    },
  });

  const pausePathMutation = useMutation({
    mutationFn: (path: string) => api.pausePath(path),
    onSuccess: (_, path) => {
      // Update local status immediately
      setPathStatuses(prev => ({
        ...prev,
        [path]: { scanning: false, watcher_paused: true, watching: true }
      }));
      queryClient.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  const handleAddPath = () => {
    if (newPath.trim()) {
      addPathMutation.mutate(newPath.trim());
    }
  };

  const runAllMutation = useMutation({
    mutationFn: async () => {
      for (const item of paths) {
        const status = pathStatuses[item.path];
        const isActive = status?.scanning || (status?.watching && !status?.watcher_paused);
        if (isActive) {
          continue;
        }
        try {
          await api.scanPath(item.path);
          setPathStatuses(prev => ({
            ...prev,
            [item.path]: { scanning: true, watcher_paused: false, watching: true }
          }));
        } catch (error) {
          console.error('Failed to run scan for path', item.path, error);
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['scanPaths'] });
    },
  });

  const showDeleteConfirmation = useUIStore((s) => s.showDeleteConfirmation);

  const handleDeleteClick = (path: string) => {
    if (showDeleteConfirmation) {
      setPathToDelete(path);
      setDeleteDialogOpen(true);
    } else {
      // Delete immediately without confirmation
      removePathMutation.mutate(path);
    }
  };

  const handleDeleteConfirm = () => {
    if (pathToDelete) {
      removePathMutation.mutate(pathToDelete);
    }
  };

  const handleBrowseClick = async () => {
    // If the backend-powered file browser is enabled, prefer it. This works for
    // Docker/WSL and any environment where /browse is available.
    if (isFileBrowserEnabled) {
      setBrowserOpen(true);
      return;
    }

    // Otherwise, try the Tauri native folder picker (desktop builds).
    try {
      const { open } = await import(/* @vite-ignore */ '@tauri-apps/api/dialog');
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Folder to Scan',
      });

      if (selected && typeof selected === 'string') {
        setNewPath(selected);
        return;
      }
      return;
    } catch (error) {
      console.error('Tauri dialog not available:', error);

      // As a last resort, fall back to manual entry.
      alert(
        'Folder picker is not available in this build.\n\n' +
        'Please type an absolute path manually (e.g., C:\\\\Users\\\\YourName\\\\Pictures on Windows or /photos in Docker).'
      );
    }
  };

  const handlePathSelected = (path: string) => {
    const trimmed = path?.trim();
    setNewPath(trimmed || '');
    setBrowserOpen(false);
    // Automatically add when selected from the browser, bypassing stale state
    if (trimmed) {
      addPathMutation.mutate(trimmed);
    }
  };

  const handlePlayPauseClick = (path: string) => {
    const status = pathStatuses[path];
    const isActive = status?.scanning || (status?.watching && !status?.watcher_paused);
    
    if (isActive) {
      // Pause: stop scanning and pause watcher
      pausePathMutation.mutate(path);
    } else {
      // Play: start scanning
      scanPathMutation.mutate(path);
    }
  };

  return (
    <section>
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 sm:p-4 bg-white dark:bg-zinc-900">
        {/* Add new path */}
        <div className="flex gap-2 mb-3 sm:mb-4 flex-nowrap">
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleAddPath();
              }
            }}
            placeholder="Enter path to scan (e.g., /photos/subfolder)"
            className="w-48 sm:flex-1 px-2.5 sm:px-3 py-1.5 sm:py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm outline-none focus:border-blue-500"
            disabled={addPathMutation.isPending}
          />
          <button
            onClick={handleBrowseClick}
            disabled={addPathMutation.isPending}
            className="px-2 sm:px-4 py-1.5 sm:py-2 border border-zinc-300 dark:border-zinc-700 rounded-md hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 sm:gap-2 text-sm flex-shrink-0"
            title="Browse folders"
          >
            <FolderOpenIcon className="size-4" />
            <span className="hidden sm:inline">Browse</span>
          </button>
          <div className="flex gap-2 flex-shrink-0">
            <button
              onClick={handleAddPath}
              disabled={!newPath.trim() || addPathMutation.isPending}
              className="px-2 sm:px-4 py-1.5 sm:py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 sm:gap-2 text-sm"
            >
              <PlusIcon className="size-4" />
              <span className="hidden sm:inline">Add</span>
            </button>
            <button
              onClick={() => runAllMutation.mutate()}
              disabled={runAllMutation.isPending || paths.length === 0}
              className="px-2 sm:px-4 py-1.5 sm:py-2 bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm whitespace-nowrap"
            >
              {runAllMutation.isPending ? 'Running...' : 'Run All'}
            </button>
          </div>
        </div>

        {/* Paths list */}
        {isLoading ? (
          <div className="text-sm text-zinc-500 dark:text-zinc-400">Loading paths...</div>
        ) : paths.length === 0 ? (
          <div className="text-sm text-zinc-500 dark:text-zinc-400">No paths configured. Add a path to start scanning.</div>
        ) : (
          <div className="space-y-2">
            {paths.map((item) => (
              <div
                key={item.path}
                className="flex items-center justify-between p-2 sm:p-3 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50"
              >
                <div className="flex flex-col gap-1 flex-1 min-w-0 mr-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs sm:text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">
                      {item.host_path || item.path}
                    </span>
                    {item.is_default && (
                      <span className="px-1.5 py-0.5 text-[10px] sm:text-xs font-medium rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex-shrink-0">
                        Default
                      </span>
                    )}
                  </div>
                  {item.host_path && (
                    <span className="text-[10px] sm:text-xs text-zinc-500 dark:text-zinc-400 font-mono break-all">
                      Mounted on container as: {item.path}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 sm:gap-2">
                  <button
                    onClick={() => handlePlayPauseClick(item.path)}
                    disabled={scanPathMutation.isPending || pausePathMutation.isPending}
                    className={`p-1.5 sm:p-2 rounded-md transition-colors flex-shrink-0 disabled:opacity-50 ${
                      pathStatuses[item.path]?.scanning || (pathStatuses[item.path]?.watching && !pathStatuses[item.path]?.watcher_paused)
                        ? 'text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/20'
                        : 'text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20'
                    }`}
                    title={
                      pathStatuses[item.path]?.scanning || (pathStatuses[item.path]?.watching && !pathStatuses[item.path]?.watcher_paused)
                        ? 'Pause scanning and watcher for this path'
                        : pathStatuses[item.path]?.watching && pathStatuses[item.path]?.watcher_paused
                        ? 'Resume scanning for this path'
                        : 'Start scanning this path'
                    }
                  >
                    {pathStatuses[item.path]?.scanning || (pathStatuses[item.path]?.watching && !pathStatuses[item.path]?.watcher_paused) ? (
                      <PauseIcon className="size-4 sm:size-5" />
                    ) : (
                      <PlayIcon className="size-4 sm:size-5" />
                    )}
                  </button>
                  <button
                    onClick={() => handleDeleteClick(item.path)}
                    disabled={removePathMutation.isPending}
                    className="p-1.5 sm:p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors flex-shrink-0 disabled:opacity-50"
                    title="Remove path and delete all assets from this path"
                  >
                    <TrashIcon className="size-4 sm:size-5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {addPathMutation.isError && (
          <div className="mt-3 text-xs sm:text-sm text-red-600 dark:text-red-400">
            Error: {addPathMutation.error instanceof Error ? addPathMutation.error.message : 'Failed to add path'}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={deleteDialogOpen}
        onClose={() => {
          setDeleteDialogOpen(false);
          setPathToDelete(null);
        }}
        onConfirm={handleDeleteConfirm}
        title="Remove Scan Path"
        message={
          pathToDelete
            ? `Are you sure you want to remove the path "${pathToDelete}"? This will permanently delete ALL assets from this path. This action cannot be undone.`
            : ''
        }
        confirmText={removePathMutation.isPending ? 'Removing...' : 'Remove Path'}
        variant="danger"
      />

      {browserOpen && isFileBrowserEnabled && (
        <FileBrowser
          currentPath={defaultRootPath}
          onPathSelect={handlePathSelected}
          onClose={() => setBrowserOpen(false)}
        />
      )}
    </section>
  );
}

