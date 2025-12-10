import { useState, useEffect } from 'react';
import { XMarkIcon, FolderPlusIcon, TrashIcon, ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import { addAssetsToAlbum, getAlbums, createAlbum, getAlbumsForAsset, removeAssetsFromAlbum, type Album } from '../lib/albums';

interface BulkActionsProps {
  selectedIds: Set<number>;
  selectedAssetIds?: number[]; // Array of selected asset IDs for album checking
  onClearSelection: () => void;
  onAddToAlbum?: (albumId: string, assetIds: number[]) => void;
  onDelete?: () => void;
  showRemoveFromAlbum?: boolean; // Whether to show "Remove from Album" button (only in albums view)
}

export default function BulkActions({ selectedIds, selectedAssetIds, onClearSelection, onAddToAlbum, onDelete, showRemoveFromAlbum = false }: BulkActionsProps) {
  const [showAlbumMenu, setShowAlbumMenu] = useState(false);
  const [showRemoveMenu, setShowRemoveMenu] = useState(false);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [assetsInAlbums, setAssetsInAlbums] = useState<Map<number, Album[]>>(new Map());
  const [isCreatingAlbum, setIsCreatingAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState('');
  const [newAlbumDescription, setNewAlbumDescription] = useState('');
  const count = selectedIds.size;
  const assetIdsArray = selectedAssetIds || Array.from(selectedIds);
  const hasAssetsInAlbums = Array.from(assetsInAlbums.values()).some(albums => albums.length > 0);

  // Load albums and check album membership for selected assets
  useEffect(() => {
    const loadAlbums = async () => {
      try {
        const loadedAlbums = await getAlbums();
        setAlbums(loadedAlbums);
        
        // Check which assets are in which albums
        const albumMap = new Map<number, Album[]>();
        for (const assetId of assetIdsArray) {
          try {
            const assetAlbums = await getAlbumsForAsset(assetId);
            if (assetAlbums.length > 0) {
              albumMap.set(assetId, assetAlbums);
            }
          } catch (error) {
            console.error(`Failed to get albums for asset ${assetId}:`, error);
          }
        }
        setAssetsInAlbums(albumMap);
      } catch (error) {
        console.error('Failed to load albums:', error);
      }
    };
    loadAlbums();
  }, [assetIdsArray.join(',')]);

  const handleAddToAlbum = async (albumId: string) => {
    const assetIds = Array.from(selectedIds);
    
    // If in Albums view (showRemoveFromAlbum is true), remove from all current albums first (Move behavior)
    // If in Gallery view, just add without removing (supports multiple albums)
    if (showRemoveFromAlbum && hasAssetsInAlbums) {
      for (const assetId of assetIds) {
        const assetAlbums = assetsInAlbums.get(assetId) || [];
        for (const album of assetAlbums) {
          try {
            await removeAssetsFromAlbum(album.id, [assetId]);
          } catch (error) {
            console.error(`Failed to remove asset ${assetId} from album ${album.id}:`, error);
          }
        }
      }
    }
    
    if (onAddToAlbum) {
      onAddToAlbum(albumId, assetIds);
    } else {
      try {
        await addAssetsToAlbum(albumId, assetIds);
      } catch (error) {
        console.error('Failed to add assets to album:', error);
        alert('Failed to add assets to album. Please try again.');
        return;
      }
    }
    setShowAlbumMenu(false);
    onClearSelection();
  };

  const handleRemoveFromAlbum = async (albumId: string) => {
    const assetIds = Array.from(selectedIds);
    try {
      await removeAssetsFromAlbum(albumId, assetIds);
      // Refresh album membership
      const albumMap = new Map<number, Album[]>();
      for (const assetId of assetIdsArray) {
        try {
          const assetAlbums = await getAlbumsForAsset(assetId);
          if (assetAlbums.length > 0) {
            albumMap.set(assetId, assetAlbums);
          }
        } catch (error) {
          console.error(`Failed to get albums for asset ${assetId}:`, error);
        }
      }
      setAssetsInAlbums(albumMap);
      setShowRemoveMenu(false);
    } catch (error) {
      console.error('Failed to remove assets from album:', error);
      alert('Failed to remove assets from album. Please try again.');
    }
  };

  const handleCreateAlbum = async () => {
    if (!newAlbumName.trim()) {
      return;
    }

    try {
      const assetIds = Array.from(selectedIds);
      
      // If in Albums view (showRemoveFromAlbum is true), remove from all current albums first (Move behavior)
      // If in Gallery view, just add without removing (supports multiple albums)
      if (showRemoveFromAlbum && hasAssetsInAlbums) {
        for (const assetId of assetIds) {
          const assetAlbums = assetsInAlbums.get(assetId) || [];
          for (const album of assetAlbums) {
            try {
              await removeAssetsFromAlbum(album.id, [assetId]);
            } catch (error) {
              console.error(`Failed to remove asset ${assetId} from album ${album.id}:`, error);
            }
          }
        }
      }
      
      // Create the album
      const newAlbum = await createAlbum(newAlbumName.trim(), newAlbumDescription.trim() || undefined);
      
      // Add selected photos to the newly created album
      if (onAddToAlbum) {
        onAddToAlbum(newAlbum.id, assetIds);
      } else {
        await addAssetsToAlbum(newAlbum.id, assetIds);
      }

      // Refresh albums list
      const loadedAlbums = await getAlbums();
      setAlbums(loadedAlbums);

      // Reset form and close menu
      setIsCreatingAlbum(false);
      setNewAlbumName('');
      setNewAlbumDescription('');
      setShowAlbumMenu(false);
      onClearSelection();
    } catch (error) {
      console.error('Failed to create album:', error);
      alert('Failed to create album. Please try again.');
    }
  };

  if (count === 0) return null;

  return (
    <div className="fixed bottom-2 sm:bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-1rem)]">
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg p-2 sm:p-3 flex flex-wrap items-center gap-1.5 sm:gap-3">
        <span className="text-xs sm:text-sm font-medium whitespace-nowrap">
          {count} {count === 1 ? 'item' : 'items'}
        </span>

        <div className="relative">
          <button
            onClick={() => {
              setShowAlbumMenu(!showAlbumMenu);
              setShowRemoveMenu(false);
            }}
            className="px-2 sm:px-3 py-1 sm:py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs sm:text-sm transition-colors flex items-center gap-1.5 sm:gap-2"
          >
            {showRemoveFromAlbum && hasAssetsInAlbums ? (
              <>
                <ArrowRightCircleIcon className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
                <span className="hidden sm:inline">Move to Album</span>
                <span className="sm:hidden">Move</span>
              </>
            ) : (
              <>
                <FolderPlusIcon className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
                <span className="hidden sm:inline">Add to Album</span>
                <span className="sm:hidden">Album</span>
              </>
            )}
          </button>

          {showAlbumMenu && (
            <div className="absolute bottom-full left-0 mb-2 w-64 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg overflow-hidden">
              {isCreatingAlbum ? (
                <div className="p-3 space-y-2">
                  <input
                    type="text"
                    value={newAlbumName}
                    onChange={(e) => setNewAlbumName(e.target.value)}
                    placeholder="Album name"
                    className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleCreateAlbum();
                      } else if (e.key === 'Escape') {
                        setIsCreatingAlbum(false);
                        setNewAlbumName('');
                        setNewAlbumDescription('');
                      }
                    }}
                  />
                  <textarea
                    value={newAlbumDescription}
                    onChange={(e) => setNewAlbumDescription(e.target.value)}
                    placeholder="Description (optional)"
                    rows={2}
                    className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm resize-none"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setIsCreatingAlbum(false);
                        setNewAlbumName('');
                        setNewAlbumDescription('');
                      }
                    }}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleCreateAlbum}
                      className="flex-1 px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm transition-colors"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setIsCreatingAlbum(false);
                        setNewAlbumName('');
                        setNewAlbumDescription('');
                      }}
                      className="px-3 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-sm transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => setIsCreatingAlbum(true)}
                    className="w-full text-left px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-sm border-b border-zinc-200 dark:border-zinc-800"
                  >
                    <div className="font-medium text-blue-600 dark:text-blue-400">+ Create new album</div>
                  </button>
                  {albums.length > 0 ? (
                    <div className="max-h-64 overflow-y-auto">
                      {albums.map((album) => (
                        <button
                          key={album.id}
                          onClick={() => handleAddToAlbum(album.id)}
                          className="w-full text-left px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-sm"
                        >
                          <div className="font-medium">{album.name}</div>
                          {album.description && (
                            <div className="text-xs text-zinc-500 truncate">{album.description}</div>
                          )}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          )}
        </div>

        {hasAssetsInAlbums && showRemoveFromAlbum && (
          <div className="relative">
            <button
              onClick={() => {
                setShowRemoveMenu(!showRemoveMenu);
                setShowAlbumMenu(false);
              }}
              className="px-2 sm:px-3 py-1 sm:py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs sm:text-sm transition-colors flex items-center gap-1.5 sm:gap-2"
            >
              <FolderPlusIcon className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
              <span className="hidden sm:inline">Remove from Album</span>
              <span className="sm:hidden">Remove</span>
            </button>

            {showRemoveMenu && (
              <div className="absolute bottom-full left-0 mb-2 w-64 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg overflow-hidden">
                <div className="max-h-64 overflow-y-auto">
                  {albums.filter(album => {
                    // Show albums that contain any of the selected assets
                    return Array.from(assetsInAlbums.entries()).some(([assetId, assetAlbums]) => 
                      selectedIds.has(assetId) && assetAlbums.some(a => a.id === album.id)
                    );
                  }).map((album) => (
                    <button
                      key={album.id}
                      onClick={() => handleRemoveFromAlbum(album.id)}
                      className="w-full text-left px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-sm"
                    >
                      <div className="font-medium">{album.name}</div>
                      {album.description && (
                        <div className="text-xs text-zinc-500 truncate">{album.description}</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {onDelete && (
          <button
            onClick={onDelete}
            className="px-2 sm:px-3 py-1 sm:py-1.5 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 text-xs sm:text-sm transition-colors flex items-center gap-1.5 sm:gap-2"
          >
            <TrashIcon className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
            <span className="hidden sm:inline">Delete</span>
            <span className="sm:hidden">Del</span>
          </button>
        )}

        <button
          onClick={onClearSelection}
          className="px-2 sm:px-3 py-1 sm:py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs sm:text-sm transition-colors flex items-center gap-1.5 sm:gap-2"
        >
          <XMarkIcon className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
          Clear
        </button>
      </div>
    </div>
  );
}

