import { useState, useMemo, useEffect, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { PlusIcon, PencilIcon, TrashIcon, ChevronRightIcon, ChevronDownIcon, FolderIcon } from '@heroicons/react/24/outline';
import {
  getAlbums,
  createAlbum,
  updateAlbum,
  deleteAlbum,
  type Album,
} from '../lib/albums';
import { useAssetsInfinite } from '../lib/hooks';
import GalleryGrid from '../components/GalleryGrid';
import { useAdaptivePageSize } from '../lib/adaptiveLoading';
import { useUIStore, type FontFamily } from '../lib/store';

const ALBUMS_EXPANDED_KEY = 'nazr.albums.expanded';

export default function AlbumsPage() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingAlbumId, setEditingAlbumId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const { pageSize: adaptivePageSize } = useAdaptivePageSize();
  const albumHeadingFontFamily = useUIStore((s) => s.albumHeadingFontFamily);
  const albumHeadingFontSize = useUIStore((s) => s.albumHeadingFontSize);
  
  // Helper function to get font family value
  const getFontFamilyValue = (font: FontFamily): string => {
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
      case 'yellowtail':
        return "'Yellowtail', cursive";
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
  
  // Track which albums are expanded - restore from sessionStorage on mount
  const [expandedAlbums, setExpandedAlbums] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = sessionStorage.getItem(ALBUMS_EXPANDED_KEY);
        if (stored) {
          const albumIds = JSON.parse(stored) as string[];
          return new Set(albumIds);
        }
      } catch {
        // ignore storage errors
      }
    }
    return new Set();
  });

  // Persist expanded albums to sessionStorage whenever it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const albumIdsArray = Array.from(expandedAlbums);
        if (albumIdsArray.length > 0) {
          sessionStorage.setItem(ALBUMS_EXPANDED_KEY, JSON.stringify(albumIdsArray));
        } else {
          sessionStorage.removeItem(ALBUMS_EXPANDED_KEY);
        }
      } catch {
        // ignore storage errors
      }
    }
  }, [expandedAlbums]);

  // Load albums on mount
  useEffect(() => {
    const loadAlbums = async () => {
      try {
        setIsLoading(true);
        const loadedAlbums = await getAlbums();
        setAlbums(loadedAlbums);
      } catch (error) {
        console.error('Failed to load albums:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadAlbums();
  }, []);

  // Fetch all assets to display in albums
  const {
    data: assetsData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useAssetsInfinite({ sort: 'mtime', order: 'desc', pageSize: adaptivePageSize });
  const allAssets = assetsData?.pages.flatMap((p) => p.items) ?? [];
  const assetMap = useMemo(() => {
    const map = new Map<number, typeof allAssets[0]>();
    allAssets.forEach((asset) => map.set(asset.id, asset));
    return map;
  }, [allAssets]);

  // Load additional pages if any expanded album references unseen assets
  useEffect(() => {
    if (expandedAlbums.size === 0 || !hasNextPage || isFetchingNextPage) return;
    const loadedIds = new Set(allAssets.map((asset) => asset.id));
    const missingIds = new Set<number>();
    albums.forEach((album) => {
      if (expandedAlbums.has(album.id)) {
        album.assetIds.forEach((id) => {
          if (!loadedIds.has(id)) {
            missingIds.add(id);
          }
        });
      }
    });
    if (missingIds.size > 0) {
      fetchNextPage();
    }
  }, [expandedAlbums, albums, allAssets, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleCreate = () => {
    setIsCreating(true);
    setEditingAlbumId(null);
    setEditName('');
    setEditDescription('');
  };

  const handleEdit = (album: Album) => {
    setEditingAlbumId(album.id);
    setIsEditing(true);
    setIsCreating(false);
    setEditName(album.name);
    setEditDescription(album.description || '');
  };

  const handleSave = async () => {
    if (isCreating) {
      if (editName.trim()) {
        try {
          const newAlbum = await createAlbum(editName.trim(), editDescription.trim() || undefined);
          const loadedAlbums = await getAlbums();
          setAlbums(loadedAlbums);
          setIsCreating(false);
          setEditName('');
          setEditDescription('');
        } catch (error) {
          console.error('Failed to create album:', error);
          alert('Failed to create album. Please try again.');
        }
      }
    } else if (isEditing && editingAlbumId) {
      if (editName.trim()) {
        try {
          await updateAlbum(editingAlbumId, {
            name: editName.trim(),
            description: editDescription.trim() || undefined,
          });
          const loadedAlbums = await getAlbums();
          setAlbums(loadedAlbums);
          setIsEditing(false);
          setEditingAlbumId(null);
          setEditName('');
          setEditDescription('');
        } catch (error) {
          console.error('Failed to update album:', error);
          alert('Failed to update album. Please try again.');
        }
      }
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this album?')) {
      try {
        await deleteAlbum(id);
        const loadedAlbums = await getAlbums();
        setAlbums(loadedAlbums);
        // Remove from expanded set if it was expanded
        setExpandedAlbums((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } catch (error) {
        console.error('Failed to delete album:', error);
        alert('Failed to delete album. Please try again.');
      }
    }
  };

  const toggleAlbumExpanded = (albumId: string, event?: React.MouseEvent) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    setExpandedAlbums((prev) => {
      const next = new Set(prev);
      if (next.has(albumId)) {
        next.delete(albumId);
      } else {
        next.add(albumId);
      }
      return next;
    });
  };

  return (
    <div className="container-responsive py-6 space-y-4">
      <div className="flex items-center justify-end">
        <button
          onClick={handleCreate}
          className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm transition-colors flex items-center gap-2"
        >
          <PlusIcon className="w-4 h-4" />
          New Album
        </button>
      </div>

      {(isCreating || isEditing) && (
        <div className="p-3 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 space-y-2">
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Album name"
            className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
            autoFocus
          />
          <textarea
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm resize-none"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              className="flex-1 px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => {
                setIsCreating(false);
                setIsEditing(false);
                setEditingAlbumId(null);
                setEditName('');
                setEditDescription('');
              }}
              className="px-3 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-sm transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-8 text-sm text-zinc-500">
          Loading albums...
        </div>
      ) : albums.length === 0 && !isCreating ? (
        <div className="text-center py-8 text-sm text-zinc-500">
          No albums yet. Create one to get started.
        </div>
      ) : (
        (() => {
          const albumCount = albums.length;
          // Desktop: use 5 columns (like gallery folders), Mobile: 2 columns
          const desktopColumns = 5;
          const gridId = `albums-grid-${desktopColumns}`;
          
          return (
            <>
              <style dangerouslySetInnerHTML={{ __html: `
                @media (min-width: 640px) {
                  .${gridId} {
                    grid-template-columns: repeat(${desktopColumns}, minmax(0, 1fr)) !important;
                  }
                }
              `}} />
              <div
                className={`grid gap-3 sm:gap-4 ${gridId}`}
                style={{
                  gridTemplateColumns: `repeat(2, minmax(0, 1fr))`,
                }}
              >
                {albums.map((album) => {
                  const isExpanded = expandedAlbums.has(album.id);
                  const albumAssets = album.assetIds.map((id) => assetMap.get(id)).filter(Boolean) as typeof allAssets;
                  return (
                    <Fragment key={album.id}>
                      <div className="space-y-2">
                        {/* Album folder card */}
                        <div
                          onClick={(e) => toggleAlbumExpanded(album.id, e)}
                          className="flex flex-col gap-2 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg p-3 border border-zinc-200 dark:border-zinc-700 transition-colors"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {isExpanded ? (
                              <ChevronDownIcon className="w-4 h-4 sm:w-5 sm:h-5 text-zinc-600 dark:text-zinc-400 flex-shrink-0" />
                            ) : (
                              <ChevronRightIcon className="w-4 h-4 sm:w-5 sm:h-5 text-zinc-600 dark:text-zinc-400 flex-shrink-0" />
                            )}
                            <FolderIcon className="w-5 h-5 sm:w-6 sm:h-6 text-blue-500 dark:text-blue-400 flex-shrink-0" />
                            <h2 
                              className={`${getFontSizeClass(albumHeadingFontSize)} font-semibold text-zinc-900 dark:text-zinc-100 flex-1 min-w-0 truncate`}
                              style={{ fontFamily: getFontFamilyValue(albumHeadingFontFamily) }}
                            >
                              {album.name}
                            </h2>
                          </div>
                          {album.description && (
                            <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 line-clamp-2">
                              {album.description}
                            </p>
                          )}
                          <div className="flex items-center justify-between">
                            <span className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400">
                              {album.assetIds.length} {album.assetIds.length === 1 ? 'item' : 'items'}
                            </span>
                            <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => handleEdit(album)}
                                className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                                title="Edit"
                              >
                                <PencilIcon className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDelete(album.id)}
                                className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors text-red-600 dark:text-red-400"
                                title="Delete"
                              >
                                <TrashIcon className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                      {/* Expanded content - spans all columns */}
                      {isExpanded && (
                        <div 
                          className="col-span-full mt-2"
                          style={{
                            gridColumn: '1 / -1',
                            scrollMarginTop: '0',
                            scrollMarginBottom: '0',
                          }}
                          tabIndex={-1}
                        >
                          {albumAssets.length > 0 ? (
                            <GalleryGrid 
                              assets={albumAssets} 
                              hasMore={false}
                              mobileColumns={2}
                              sort="mtime"
                              order="desc"
                              filteredAssetIdsOverride={album.assetIds}
                              showRemoveFromAlbum={true}
                            />
                          ) : (
                            <div className="text-center py-12 text-sm text-zinc-500">
                              This album is empty. Add assets from the gallery or search.
                            </div>
                          )}
                        </div>
                      )}
                    </Fragment>
                  );
                })}
              </div>
            </>
          );
        })()
      )}
    </div>
  );
}

