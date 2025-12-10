import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { CheckIcon } from '@heroicons/react/24/solid';
import type { Asset, Paginated } from '../types';
import { media, assetApi, api } from '../lib/api';
import { isVideo, isImage } from '../lib/utils';
import { PlayIcon } from '@heroicons/react/24/solid';
import ContextMenu from './ContextMenu';
import ConfirmDialog from './ConfirmDialog';
import { saveGalleryScroll } from '../lib/scroll';
import { useUIStore } from '../lib/store';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { addAssetsToAlbum, getAlbums, createAlbum, getAlbumsForAsset, removeAssetsFromAlbum, type Album } from '../lib/albums';

interface AssetCardProps {
  asset: Asset;
  index: number;
  sort?: string;
  order?: string;
  filteredAssetIds?: number[]; // Filtered asset IDs for navigation (e.g., assets from the same year when folder view is enabled)
  isSelected?: boolean;
  onSelect?: (id: number, selected: boolean, isCtrlClick?: boolean) => void;
  selectionMode?: boolean;
  onDelete?: (id: number) => void;
  isDragging?: boolean;
  isCtrlPressed?: boolean;
  personId?: number | null;
  selectedIds?: Set<number>; // Set of selected asset IDs for multi-select operations
  isInAlbumsView?: boolean; // Whether this card is being displayed in the Albums view
}

export default function AssetCard({ asset, index, sort, order, filteredAssetIds, isSelected, onSelect, selectionMode, onDelete, isDragging, isCtrlPressed, personId, selectedIds, isInAlbumsView }: AssetCardProps) {
  const location = useLocation();
  const url = media.thumbUrl(asset.id, asset.sha256);
  const preview = media.previewUrl(asset.id, asset.sha256);
  const video = isVideo(asset.mime);
  const image = isImage(asset.mime);
  const isUnsupported = !image && !video;
  const [imageError, setImageError] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [albumMenuPosition, setAlbumMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAssignDialog, setShowAssignDialog] = useState(false);
  const [selectedTargetPersonId, setSelectedTargetPersonId] = useState<number | null>(null);
  const [showAlbumMenu, setShowAlbumMenu] = useState(false);
  const [albumMenuMode, setAlbumMenuMode] = useState<'add' | 'remove'>('add');
  const [albums, setAlbums] = useState<Album[]>([]);
  const [assetAlbums, setAssetAlbums] = useState<Album[]>([]);
  const [isLoadingAlbums, setIsLoadingAlbums] = useState(false);
  const [isCreatingAlbum, setIsCreatingAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState('');
  const [newAlbumDescription, setNewAlbumDescription] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Fetch all persons for the dropdown
  const { data: persons } = useQuery({
    queryKey: ['persons'],
    queryFn: () => api.listPersons(),
    enabled: showAssignDialog,
  });

  // Load albums and check asset album membership when album menu is shown
  useEffect(() => {
    if (showAlbumMenu) {
      const loadAlbums = async () => {
        setIsLoadingAlbums(true);
        try {
          const [loadedAlbums, assetAlbumsData] = await Promise.all([
            getAlbums(),
            getAlbumsForAsset(asset.id)
          ]);
          setAlbums(loadedAlbums);
          setAssetAlbums(assetAlbumsData);
        } catch (error) {
          console.error('Failed to load albums:', error);
        } finally {
          setIsLoadingAlbums(false);
        }
      };
      loadAlbums();
    }
  }, [showAlbumMenu, asset.id]);

  // Load albums for tags when in gallery view and setting is enabled
  const showAlbumTags = useUIStore((s) => s.showAlbumTags);
  const albumTagFontColor = useUIStore((s) => s.albumTagFontColor);
  const albumTagBackgroundColor = useUIStore((s) => s.albumTagBackgroundColor);
  useEffect(() => {
    if (!isInAlbumsView && showAlbumTags) {
      const loadAlbumsForTags = async () => {
        try {
          const assetAlbumsData = await getAlbumsForAsset(asset.id);
          setAssetAlbums(assetAlbumsData);
        } catch (error) {
          console.error('Failed to load albums for tags:', error);
        }
      };
      loadAlbumsForTags();
    } else if (!showAlbumTags || isInAlbumsView) {
      // Clear albums if setting is disabled or in albums view
      setAssetAlbums([]);
    }
  }, [asset.id, showAlbumTags, isInAlbumsView]);

  // Close album menu when clicking outside
  useEffect(() => {
    if (!showAlbumMenu) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Check if click is outside the album menu
      if (!target.closest('[data-album-menu]')) {
        setShowAlbumMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showAlbumMenu]);

  // Merge persons mutation
  const mergeMutation = useMutation({
    mutationFn: (targetPersonId: number) => {
      if (!personId) throw new Error('No source person ID');
      return api.mergePersons(personId, targetPersonId);
    },
    onSuccess: (data, targetPersonId) => {
      // Invalidate queries
      queryClient.invalidateQueries({ queryKey: ['persons'] });
      queryClient.invalidateQueries({ queryKey: ['personAssets'] });
      queryClient.invalidateQueries({ queryKey: ['personFace'] });
      queryClient.invalidateQueries({ queryKey: ['faceProgress'] });
      queryClient.invalidateQueries({ queryKey: ['unassignedFaces'] });
      
      // Close dialog
      setShowAssignDialog(false);
      setSelectedTargetPersonId(null);
      
      // Redirect to the target person's gallery
      navigate(`/gallery?person=${targetPersonId}`);

      const profileCount = data?.profile_refreshed?.face_count;
      const faces = data?.faces_merged ?? 0;
      const msg = profileCount
        ? `Merged ${faces} faces. Profile now tracks ${profileCount}.`
        : `Merged ${faces} faces.`;
      showNotification(msg);
    },
    onError: (error) => {
      alert(`Failed to assign person: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });

  const showNotification = (text: string, variant: 'success' | 'error' = 'success') => {
    const notification = document.createElement('div');
    notification.textContent = text;
    notification.className = `fixed top-4 right-4 ${
      variant === 'success' ? 'bg-green-500' : 'bg-red-500'
    } text-white px-4 py-2 rounded shadow-lg z-50`;
    document.body.appendChild(notification);
    setTimeout(() => {
      document.body.removeChild(notification);
    }, 2500);
  };

  const removeAssetFromPersonCaches = (targetPersonId: number) => {
    const queries = queryClient.getQueriesData<InfiniteData<Paginated<Asset>>>({
      queryKey: ['assets'],
    });
    queries.forEach(([queryKey, data]) => {
      if (!Array.isArray(queryKey)) return;
      if (queryKey[0] !== 'assets') return;
      const params = queryKey[1] as { person_id?: number } | undefined;
      if (!data || params?.person_id !== targetPersonId) return;
      let removed = false;
      const pages = data.pages.map((page) => {
        const filtered = page.items.filter((item) => item.id !== asset.id);
        if (filtered.length !== page.items.length) {
          removed = true;
          return { ...page, items: filtered };
        }
        return page;
      });
      if (removed) {
        queryClient.setQueryData(queryKey, { ...data, pages });
      }
    });
  };

  const handleClick = (e: React.MouseEvent) => {
    // Don't handle click if we're currently dragging (drag selection takes precedence)
    if (isDragging) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Selection and navigation are now handled by the Link's onClick
    // This handler is kept for drag detection
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    // Allow context menu in selection mode only if we're in a person view and have selected items
    if (selectionMode && (!personId || !selectedIds || selectedIds.size === 0)) {
      return; // Don't show context menu in selection mode unless we have person context and selections
    }
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleImageError = () => {
    setImageError(true);
  };

  const handleDownload = async () => {
    try {
      await assetApi.download(asset.id);
    } catch (error) {
      console.error('Download failed:', error);
      alert(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleCopy = async () => {
    try {
      const response = await fetch(media.previewUrl(asset.id, asset.sha256));
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob })
      ]);
      showNotification('Copied to clipboard!');
    } catch (error) {
      console.error('Copy failed:', error);
      alert(`Copy to clipboard failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const showDeleteConfirmation = useUIStore((s) => s.showDeleteConfirmation);
  const deleteOriginalFiles = useUIStore((s) => s.deleteOriginalFiles);

  const handleDeleteClick = () => {
    setContextMenu(null); // Close context menu
    if (showDeleteConfirmation) {
      setShowDeleteConfirm(true);
    } else {
      // Delete immediately without confirmation
      handleDeleteConfirm();
    }
  };

  const handleAssignToPerson = () => {
    setContextMenu(null); // Close context menu
    setShowAssignDialog(true);
  };

  const handleAddToAlbum = () => {
    if (contextMenu) {
      setAlbumMenuPosition({ x: contextMenu.x, y: contextMenu.y });
    }
    setContextMenu(null); // Close context menu
    setAlbumMenuMode('add');
    setShowAlbumMenu(true);
  };

  const handleMoveToAlbum = () => {
    if (contextMenu) {
      setAlbumMenuPosition({ x: contextMenu.x, y: contextMenu.y });
    }
    setContextMenu(null); // Close context menu
    setAlbumMenuMode('add');
    setShowAlbumMenu(true);
  };

  const handleRemoveFromAlbum = async (albumId?: string) => {
    setContextMenu(null);
    
    if (albumId) {
      // Remove from specific album
      try {
        await removeAssetsFromAlbum(albumId, [asset.id]);
        showNotification('Removed from album!');
        // Refresh asset albums
        const updatedAlbums = await getAlbumsForAsset(asset.id);
        setAssetAlbums(updatedAlbums);
        setShowAlbumMenu(false);
      } catch (error) {
        console.error('Failed to remove asset from album:', error);
        alert('Failed to remove asset from album. Please try again.');
      }
    } else {
      // Show album selection for removal
      if (contextMenu) {
        setAlbumMenuPosition({ x: contextMenu.x, y: contextMenu.y });
      }
      setAlbumMenuMode('remove');
      setShowAlbumMenu(true);
    }
  };

  const handleAddToAlbumSelect = async (albumId: string) => {
    try {
      // If in Albums view, remove from all current albums first (Move behavior)
      // If in Gallery view, just add without removing (supports multiple albums)
      if (isInAlbumsView && assetAlbums.length > 0) {
        for (const album of assetAlbums) {
          await removeAssetsFromAlbum(album.id, [asset.id]);
        }
      }
      // Add to new album
      await addAssetsToAlbum(albumId, [asset.id]);
      showNotification(isInAlbumsView && assetAlbums.length > 0 ? 'Moved to album!' : 'Added to album!');
      // Refresh asset albums
      const updatedAlbums = await getAlbumsForAsset(asset.id);
      setAssetAlbums(updatedAlbums);
      setShowAlbumMenu(false);
      setAlbumMenuMode('add');
    } catch (error) {
      console.error('Failed to add asset to album:', error);
      alert('Failed to add asset to album. Please try again.');
    }
  };

  const handleRemoveFromAlbumSelect = async (albumId: string) => {
    try {
      await removeAssetsFromAlbum(albumId, [asset.id]);
      showNotification('Removed from album!');
      // Refresh asset albums
      const updatedAlbums = await getAlbumsForAsset(asset.id);
      setAssetAlbums(updatedAlbums);
      setShowAlbumMenu(false);
      setAlbumMenuMode('add');
    } catch (error) {
      console.error('Failed to remove asset from album:', error);
      alert('Failed to remove asset from album. Please try again.');
    }
  };

  const handleCreateAlbum = async () => {
    if (!newAlbumName.trim()) {
      return;
    }

    try {
      const newAlbum = await createAlbum(newAlbumName.trim(), newAlbumDescription.trim() || undefined);
      
      // If in Albums view, remove from all current albums first (Move behavior)
      // If in Gallery view, just add without removing (supports multiple albums)
      if (isInAlbumsView && assetAlbums.length > 0) {
        for (const album of assetAlbums) {
          await removeAssetsFromAlbum(album.id, [asset.id]);
        }
      }
      
      await addAssetsToAlbum(newAlbum.id, [asset.id]);
      
      // Refresh albums list and asset albums
      const [loadedAlbums, updatedAssetAlbums] = await Promise.all([
        getAlbums(),
        getAlbumsForAsset(asset.id)
      ]);
      setAlbums(loadedAlbums);
      setAssetAlbums(updatedAssetAlbums);

      // Reset form and close menu
      setIsCreatingAlbum(false);
      setNewAlbumName('');
      setNewAlbumDescription('');
      setShowAlbumMenu(false);
      showNotification(isInAlbumsView && assetAlbums.length > 0 ? 'Created album and moved photo!' : 'Created album and added photo!');
    } catch (error) {
      console.error('Failed to create album:', error);
      alert('Failed to create album. Please try again.');
    }
  };
  
  // Get count of selected assets for display
  const selectedCount = selectedIds && selectedIds.size > 0 ? selectedIds.size : 1;

  const handleUnassignFromPerson = async () => {
    if (!personId) return;
    setContextMenu(null);
    
    // Determine which assets to process
    const assetsToProcess = selectedIds && selectedIds.size > 0 
      ? Array.from(selectedIds) 
      : [asset.id];
    
    try {
      let totalFacesUnassigned = 0;
      let successCount = 0;
      let errorCount = 0;
      
      // Process each asset
      for (const assetId of assetsToProcess) {
        try {
          const faces = await api.getAssetFaces(assetId);
          const matches = faces.filter((f) => f.person_id === personId);
          if (matches.length > 0) {
            await Promise.all(matches.map((face) => api.assignFaceToPerson(face.id, null)));
            totalFacesUnassigned += matches.length;
            successCount++;
          }
        } catch (error) {
          console.error(`Failed to unassign faces from asset ${assetId}:`, error);
          errorCount++;
        }
      }
      
      if (totalFacesUnassigned === 0 && successCount === 0) {
        showNotification('No faces to unassign on selected assets', 'error');
        return;
      }
      
      // Invalidate queries
      queryClient.invalidateQueries({ queryKey: ['persons'] });
      queryClient.invalidateQueries({ queryKey: ['personAssets', personId] });
      queryClient.invalidateQueries({ queryKey: ['personFace', personId] });
      queryClient.invalidateQueries({ queryKey: ['faceProgress'] });
      queryClient.invalidateQueries({ queryKey: ['unassignedFaces'] });
      removeAssetFromPersonCaches(personId);
      queryClient.invalidateQueries({ queryKey: ['assets'] });
      
      // Show notification
      const assetCount = assetsToProcess.length;
      let message = `Removed ${totalFacesUnassigned} ${totalFacesUnassigned === 1 ? 'face' : 'faces'} from ${assetCount === 1 ? 'this asset' : `${successCount} ${successCount === 1 ? 'asset' : 'assets'}`}`;
      if (errorCount > 0) {
        message += ` (${errorCount} ${errorCount === 1 ? 'asset' : 'assets'} failed)`;
      }
      showNotification(message, errorCount > 0 ? 'error' : 'success');
    } catch (error) {
      console.error('Unassign failed:', error);
      alert(`Failed to unassign faces: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleAssignConfirm = () => {
    if (selectedTargetPersonId && personId) {
      mergeMutation.mutate(selectedTargetPersonId);
    }
  };

  const handleDeleteConfirm = async () => {
    try {
      const result = await assetApi.delete(asset.id, { permanent: deleteOriginalFiles });
      if (deleteOriginalFiles) {
        const permanentResult = result as { success: boolean; read_only?: boolean; error?: string; path?: string };
        if (!permanentResult.success) {
          if (permanentResult.read_only) {
            alert(
              `Unable to delete "${asset.filename}" from disk because the file is read-only${
                permanentResult.path ? ` (${permanentResult.path})` : ''
              }. Update the file permissions and try again.`
            );
            return;
          }
          throw new Error(permanentResult.error || 'Failed to delete asset.');
        }
      } else {
        const indexResult = result as { success: boolean; error?: string };
        if (!indexResult.success) {
          throw new Error(indexResult.error || 'Failed to remove asset from index.');
        }
      }
      if (onDelete) {
        onDelete(asset.id);
      } else {
        window.location.reload();
      }
    } catch (error) {
      console.error('Delete failed:', error);
      alert(`Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const extension = asset.ext || (asset.filename.includes('.') 
    ? asset.filename.split('.').pop()?.toUpperCase() || ''
    : '');

  const cardContent = (
    <div
      className={`block group rounded-md overflow-hidden bg-zinc-100 dark:bg-zinc-800 border transition-transform ${
        isSelected
          ? 'border-blue-500 ring-2 ring-blue-500'
          : 'border-zinc-200/60 dark:border-zinc-800'
      } ${selectionMode ? 'cursor-pointer' : ''} ${!selectionMode ? 'hover:scale-[1.02]' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <div className="relative aspect-[4/3] bg-zinc-200 dark:bg-zinc-700">
        {/* Selection indicator - only show when CTRL is pressed */}
        {isCtrlPressed && (
          <div
            className={`absolute top-2 left-2 z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${
              isSelected
                ? 'bg-blue-600 border-blue-600'
                : 'bg-white/80 dark:bg-zinc-800/80 border-zinc-300 dark:border-zinc-600'
            }`}
          >
            {isSelected && <CheckIcon className="w-4 h-4 text-white" />}
          </div>
        )}

        {/* Album tags - only show in gallery view when setting is enabled */}
        {!isInAlbumsView && showAlbumTags && assetAlbums.length > 0 && (
          <div className="absolute top-2 right-2 z-10 flex flex-col gap-1 max-w-[40%]">
            {assetAlbums.slice(0, 3).map((album) => (
              <div
                key={album.id}
                className="px-2 py-0.5 rounded text-[10px] font-medium backdrop-blur-sm truncate"
                style={{
                  color: albumTagFontColor,
                  backgroundColor: albumTagBackgroundColor,
                }}
                title={album.name}
              >
                {album.name}
              </div>
            ))}
            {assetAlbums.length > 3 && (
              <div
                className="px-2 py-0.5 rounded text-[10px] font-medium backdrop-blur-sm"
                style={{
                  color: albumTagFontColor,
                  backgroundColor: albumTagBackgroundColor,
                }}
                title={assetAlbums.slice(3).map(a => a.name).join(', ')}
              >
                +{assetAlbums.length - 3} more
              </div>
            )}
          </div>
        )}

        {/* Show extension for unsupported files or when image fails to load */}
        {(isUnsupported || imageError) && extension && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-4xl sm:text-5xl font-bold text-zinc-400 dark:text-zinc-500 select-none">
              .{extension}
            </div>
          </div>
        )}

        {/* Progressive image: small thumb eagerly, preview lazy */}
        {!isUnsupported && !imageError && (
          <>
            <img
              src={url}
              alt={asset.filename}
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover blur-[1px] scale-[1.01]"
              onError={handleImageError}
            />
            <img
              src={preview}
              alt=""
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover opacity-0 group-hover:opacity-100 transition-opacity duration-300"
              onLoad={(e) => (e.currentTarget.style.opacity = '1')}
              onError={handleImageError}
            />
          </>
        )}
        {video && !imageError && (
          <div className="absolute bottom-1 right-1 bg-black/60 text-white rounded px-1.5 py-0.5 text-[11px] flex items-center gap-1">
            <PlayIcon className="size-3" />
            video
          </div>
        )}
      </div>
      <div className="p-2 text-[11px] truncate opacity-80">
        {asset.filename}
      </div>
    </div>
  );

  const handleLinkClick = (e: React.MouseEvent) => {
    // Prevent navigation if we're dragging
    if (isDragging) {
      e.preventDefault();
      return;
    }

    const saveScroll = () => saveGalleryScroll(asset.id);

    // Check if CTRL is pressed (for CTRL+click selection)
    const isCtrlClick = isCtrlPressed || e.ctrlKey || e.metaKey;
    if (isCtrlClick && onSelect) {
      // CTRL+click: prevent navigation and select the item
      e.preventDefault();
      e.stopPropagation();
      onSelect(asset.id, !isSelected, true);
      return;
    }

    // Normal click: navigate to details view
    saveScroll();
  };

  const content = (
    <Link
      to={`/asset/${asset.id}`}
      state={{
        asset,
        index,
        sort,
        order,
        filteredAssetIds,
        from: {
          pathname: location.pathname,
          search: location.search,
          hash: location.hash,
        },
      }}
      onClick={handleLinkClick}
      data-asset-id={asset.id}
    >
      {cardContent}
    </Link>
  );

  return (
    <>
      {content}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => {
            setContextMenu(null);
            setShowAlbumMenu(false);
            setAlbumMenuPosition(null);
            setAlbumMenuMode('add');
          }}
          onDownload={handleDownload}
          onDelete={handleDeleteClick}
          onCopy={handleCopy}
          onAddToAlbum={!isInAlbumsView ? handleAddToAlbum : undefined}
          onMoveToAlbum={isInAlbumsView && assetAlbums.length > 0 ? handleMoveToAlbum : undefined}
          onRemoveFromAlbum={isInAlbumsView && assetAlbums.length > 0 ? () => handleRemoveFromAlbum() : undefined}
          onAssignToPerson={handleAssignToPerson}
          showAssignToPerson={!!personId}
          onUnassignFromPerson={personId ? handleUnassignFromPerson : undefined}
          showUnassignFromPerson={!!personId}
        />
      )}
      
      {/* Album Menu Popup - similar to BulkActions */}
      {showAlbumMenu && albumMenuPosition && (
        <div 
          data-album-menu
          className="fixed z-[60] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg overflow-hidden" 
          style={{ 
            left: `${albumMenuPosition.x}px`, 
            top: `${Math.max(10, albumMenuPosition.y - 250)}px`, 
            width: '256px',
            maxHeight: '400px'
          }}
          onClick={(e) => e.stopPropagation()}
        >
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
                    setShowAlbumMenu(false);
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
                    setShowAlbumMenu(false);
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
                    setShowAlbumMenu(false);
                  }}
                  className="px-3 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-sm transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {albumMenuMode === 'remove' && assetAlbums.length > 0 ? (
                // Show remove from album section
                <>
                  <div className="px-3 py-2 text-xs font-semibold text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
                    Remove from:
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {assetAlbums.map((album) => (
                      <button
                        key={album.id}
                        onClick={() => handleRemoveFromAlbumSelect(album.id)}
                        className="w-full text-left px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-sm"
                      >
                        <div className="font-medium">{album.name}</div>
                        {album.description && (
                          <div className="text-xs text-zinc-500 truncate">{album.description}</div>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                // Show add/move to album section
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
                          onClick={() => handleAddToAlbumSelect(album.id)}
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
            </>
          )}
        </div>
      )}
      {/* Assign to Person Dialog */}
      {showAssignDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/30 dark:bg-black/50" onClick={() => setShowAssignDialog(false)} />
          <div className="relative z-10 w-full max-w-md bg-white dark:bg-zinc-800 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 p-6" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">Assign to Person</h2>
            <div className="mb-4">
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                Select Person
              </label>
              <select
                value={selectedTargetPersonId || ''}
                onChange={(e) => setSelectedTargetPersonId(e.target.value ? parseInt(e.target.value, 10) : null)}
                className="w-full p-2 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                style={{ zIndex: 9999 }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <option value="">-- Select a person --</option>
                {persons && persons.length > 0 ? (
                  persons
                    .filter((p) => p.id !== personId)
                    .sort((a, b) => {
                      const nameA = (a.name || `Person ${a.id}`).toLowerCase();
                      const nameB = (b.name || `Person ${b.id}`).toLowerCase();
                      return nameA.localeCompare(nameB);
                    })
                    .map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name || `Person ${person.id}`}
                      </option>
                    ))
                ) : (
                  <option value="" disabled>Loading persons...</option>
                )}
              </select>
            </div>
            <div className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
              {selectedCount > 1 
                ? `All faces from Person ${personId} (across ${selectedCount} selected ${selectedCount === 1 ? 'asset' : 'assets'}) will be assigned to the selected person. Person ${personId} will be deleted.`
                : `All faces from Person ${personId} will be assigned to the selected person. Person ${personId} will be deleted.`
              }
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowAssignDialog(false);
                  setSelectedTargetPersonId(null);
                }}
                className="px-4 py-2 bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 rounded-md hover:bg-zinc-300 dark:hover:bg-zinc-600 text-sm font-medium"
                disabled={mergeMutation.isPending}
              >
                Cancel
              </button>
              <button
                onClick={handleAssignConfirm}
                disabled={!selectedTargetPersonId || mergeMutation.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
              >
                {mergeMutation.isPending ? 'Assigning...' : 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDeleteConfirm}
        title={deleteOriginalFiles ? 'Delete From Disk' : 'Remove From Seen'}
        message={
          deleteOriginalFiles
            ? `Deleting "${asset.filename}" will remove it from Seen and delete the original file from disk. This cannot be undone.`
            : `Remove "${asset.filename}" from the Seen index? The original file will remain on disk.`
        }
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
      />
    </>
  );
}

