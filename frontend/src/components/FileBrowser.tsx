import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { FolderIcon, DocumentIcon, ChevronRightIcon, ChevronLeftIcon } from '@heroicons/react/24/outline';

interface FileBrowserProps {
  currentPath: string;
  onPathSelect: (path: string) => void;
  onClose: () => void;
}

export default function FileBrowser({ currentPath, onPathSelect, onClose }: FileBrowserProps) {
  const normalizePath = (path?: string) => {
    if (!path || path.trim() === '') return '/';
    return path.startsWith('/') ? path : `/${path}`;
  };

  const initialPath = normalizePath(currentPath);

  const [selectedPath, setSelectedPath] = useState<string>(initialPath);
  const [pathHistory, setPathHistory] = useState<string[]>([initialPath]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['browse', selectedPath],
    queryFn: () => api.browseDirectory(normalizePath(selectedPath)),
    enabled: true,
  });

  const handleNavigate = (path: string) => {
    setPathHistory([...pathHistory, path]);
    setSelectedPath(path);
  };

  const handleBack = () => {
    if (pathHistory.length > 1) {
      const newHistory = [...pathHistory];
      newHistory.pop();
      const previousPath = newHistory[newHistory.length - 1];
      setPathHistory(newHistory);
      setSelectedPath(previousPath);
    }
  };

  const handleSelect = () => {
    onPathSelect(selectedPath);
    onClose();
  };

  const handleEntryClick = (entry: { name: string; path: string; is_dir: boolean }) => {
    if (entry.is_dir) {
      handleNavigate(entry.path);
    }
  };

  // Handle ESC key to close
  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const canGoBack = pathHistory.length > 1;
  const currentDisplayPath = data?.path || selectedPath;
  const entries = Array.isArray((data as any)?.entries) ? (data as any).entries : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 dark:bg-black/70" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col m-4" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Select Folder</h2>
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              ✕
            </button>
          </div>
          <div className="flex items-center gap-2">
            {canGoBack && (
              <button
                onClick={handleBack}
                className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
                title="Go back"
              >
                <ChevronLeftIcon className="size-5" />
              </button>
            )}
            <div className="flex-1 px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">
              {currentDisplayPath}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {isLoading && (
            <div className="flex items-center justify-center py-8 text-zinc-500 dark:text-zinc-400">
              Loading...
            </div>
          )}

          {error && (
            <div className="text-red-600 dark:text-red-400 text-sm py-4">
              Error: {error instanceof Error ? error.message : 'Failed to load directory'}
            </div>
          )}

          {!isLoading && !error && data && (
            <div className="space-y-1">
              {entries.length === 0 ? (
                <div className="text-zinc-500 dark:text-zinc-400 text-sm py-8 text-center">
                  This folder is empty
                </div>
              ) : (
                entries.map((entry) => (
                  <button
                    key={entry.path}
                    onClick={() => handleEntryClick(entry)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-left transition-colors"
                  >
                    {entry.is_dir ? (
                      <FolderIcon className="size-5 text-blue-500 flex-shrink-0" />
                    ) : (
                      <DocumentIcon className="size-5 text-zinc-400 flex-shrink-0" />
                    )}
                    <span className="flex-1 text-sm font-mono text-zinc-700 dark:text-zinc-300 truncate">
                      {entry.name}
                    </span>
                    {entry.is_dir && (
                      <ChevronRightIcon className="size-4 text-zinc-400 flex-shrink-0" />
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSelect}
            disabled={!data}
            className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Select This Folder
          </button>
        </div>
      </div>
    </div>
  );
}

