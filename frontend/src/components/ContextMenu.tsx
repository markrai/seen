import { useEffect, useRef } from 'react';
import { ArrowDownTrayIcon, TrashIcon, ClipboardDocumentIcon, UserPlusIcon, FolderPlusIcon, ArrowRightCircleIcon } from '@heroicons/react/24/outline';

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onAddToAlbum?: () => void;
  onMoveToAlbum?: () => void;
  onRemoveFromAlbum?: () => void;
  onAssignToPerson?: () => void;
  showAssignToPerson?: boolean;
  onUnassignFromPerson?: () => void;
  showUnassignFromPerson?: boolean;
}

export default function ContextMenu({
  x,
  y,
  onClose,
  onDownload,
  onDelete,
  onCopy,
  onAddToAlbum,
  onMoveToAlbum,
  onRemoveFromAlbum,
  onAssignToPerson,
  showAssignToPerson,
  onUnassignFromPerson,
  showUnassignFromPerson,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input field or textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'w' || e.key === 'W') {
        // W key - Download
        e.preventDefault();
        onDownload();
        onClose();
      } else if (e.key === 'c' || e.key === 'C') {
        // C key - Copy to Clipboard
        e.preventDefault();
        onCopy();
        onClose();
      } else if (e.key === 'd' || e.key === 'D') {
        // D key - Delete
        e.preventDefault();
        onDelete();
        onClose();
      }
    };

    // Close on outside click
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose, onDownload, onCopy, onDelete]);

  // Adjust position if menu would go off screen
  const [adjustedX, adjustedY] = (() => {
    if (!menuRef.current) return [x, y];
    const rect = menuRef.current.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    
    let newX = x;
    let newY = y;
    
    if (x + rect.width > windowWidth) {
      newX = windowWidth - rect.width - 10;
    }
    if (y + rect.height > windowHeight) {
      newY = windowHeight - rect.height - 10;
    }
    
    return [newX, newY];
  })();

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 min-w-[180px]"
      style={{ left: `${adjustedX}px`, top: `${adjustedY}px` }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDownload();
          onClose();
        }}
        className="w-full px-4 py-2 text-left text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center justify-between gap-2"
      >
        <div className="flex items-center gap-2">
          <ArrowDownTrayIcon className="w-4 h-4" />
          Download
        </div>
        <kbd className="px-1.5 py-0.5 text-xs font-semibold text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded">W</kbd>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onCopy();
          onClose();
        }}
        className="w-full px-4 py-2 text-left text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center justify-between gap-2"
      >
        <div className="flex items-center gap-2">
          <ClipboardDocumentIcon className="w-4 h-4" />
          Copy to Clipboard
        </div>
        <kbd className="px-1.5 py-0.5 text-xs font-semibold text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded">C</kbd>
      </button>
      {onAddToAlbum && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAddToAlbum();
            // Don't close the menu - the album popup will handle that
          }}
          className="w-full px-4 py-2 text-left text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
        >
          <FolderPlusIcon className="w-4 h-4" />
          Add to Album
        </button>
      )}
      {onMoveToAlbum && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onMoveToAlbum();
            // Don't close the menu - the album popup will handle that
          }}
          className="w-full px-4 py-2 text-left text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
        >
          <ArrowRightCircleIcon className="w-4 h-4" />
          Move to Album
        </button>
      )}
      {onRemoveFromAlbum && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemoveFromAlbum();
            // Don't close the menu - the album popup will handle that
          }}
          className="w-full px-4 py-2 text-left text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
        >
          <FolderPlusIcon className="w-4 h-4" />
          Remove from Album
        </button>
      )}
      {showAssignToPerson && onAssignToPerson && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAssignToPerson();
            onClose();
          }}
          className="w-full px-4 py-2 text-left text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
        >
          <UserPlusIcon className="w-4 h-4" />
          Assign to Person
        </button>
      )}
      {showUnassignFromPerson && onUnassignFromPerson && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onUnassignFromPerson();
            onClose();
          }}
          className="w-full px-4 py-2 text-left text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
        >
          Unassign from Person
        </button>
      )}
      <div className="border-t border-zinc-200 dark:border-zinc-700 my-1" />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
          onClose();
        }}
        className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center justify-between gap-2"
      >
        <div className="flex items-center gap-2">
          <TrashIcon className="w-4 h-4" />
          Delete
        </div>
        <kbd className="px-1.5 py-0.5 text-xs font-semibold text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded">D</kbd>
      </button>
    </div>
  );
}

