import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, ChevronRightIcon, ArrowsPointingOutIcon } from '@heroicons/react/24/outline';
import { media, assetApi } from '../lib/api';
import { useAssetsInfinite, useSearchInfinite } from '../lib/hooks';
import { isVideo } from '../lib/utils';
import type { Asset } from '../types';
import Lightbox from '../components/Lightbox';
import ErrorBoundary from '../components/ErrorBoundary';
import MetadataPanel from '../components/MetadataPanel';
import VideoPlayer from '../components/VideoPlayer';
import ConfirmDialog from '../components/ConfirmDialog';
import BurstCapture from '../components/BurstCapture';
import { useUIStore } from '../lib/store';
import { organizeAssets } from '../lib/assetOrganization';
import { useAdaptivePageSize } from '../lib/adaptiveLoading';

function ImageWithLoading({ src, alt, onFullscreen }: { src: string; alt: string; onFullscreen?: () => void }) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [showFullscreenButton, setShowFullscreenButton] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [containerDimensions, setContainerDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setHasError(false);
    
    // Check if image is already loaded (cached)
    const checkLoaded = () => {
      if (imageRef.current) {
        if (imageRef.current.complete && imageRef.current.naturalHeight !== 0) {
          setIsLoading(false);
          setImageDimensions({
            width: imageRef.current.naturalWidth,
            height: imageRef.current.naturalHeight,
          });
          return;
        }
      }
      // Use requestAnimationFrame to check after the DOM has updated
      requestAnimationFrame(() => {
        if (imageRef.current) {
          if (imageRef.current.complete && imageRef.current.naturalHeight !== 0) {
            setIsLoading(false);
            setImageDimensions({
              width: imageRef.current.naturalWidth,
              height: imageRef.current.naturalHeight,
            });
          }
        }
      });
    };
    
    // Check immediately and after a short delay
    checkLoaded();
    const timeoutId = setTimeout(checkLoaded, 100);
    
    return () => clearTimeout(timeoutId);
  }, [src]);

  // Update container dimensions on resize
  useEffect(() => {
    const updateContainerDimensions = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerDimensions({ width: rect.width, height: rect.height });
      }
    };

    updateContainerDimensions();
    window.addEventListener('resize', updateContainerDimensions);
    window.addEventListener('orientationchange', updateContainerDimensions);
    return () => {
      window.removeEventListener('resize', updateContainerDimensions);
      window.removeEventListener('orientationchange', updateContainerDimensions);
    };
  }, []);

  // Calculate image style to fit within container while preserving aspect ratio
  const getImageStyle = () => {
    if (!imageDimensions || !containerDimensions) {
      return { 
        width: '100%', 
        height: 'auto',
        objectFit: 'contain' as const,
      };
    }

    const imageAspect = imageDimensions.width / imageDimensions.height;
    const isPortrait = imageDimensions.height > imageDimensions.width;
    
    // Calculate max dimensions based on viewport (80% of viewport height, full container width)
    const maxHeight = Math.min(containerDimensions.height, window.innerHeight * 0.8);
    const maxWidth = containerDimensions.width;

    // Calculate the size that fits within both maxWidth and maxHeight while preserving aspect ratio
    let displayWidth = maxWidth;
    let displayHeight = displayWidth / imageAspect;

    // If calculated height exceeds max height, scale down by height instead
    if (displayHeight > maxHeight) {
      displayHeight = maxHeight;
      displayWidth = displayHeight * imageAspect;
    }

    return {
      width: `${displayWidth}px`,
      height: `${displayHeight}px`,
      maxWidth: '100%',
      maxHeight: `${maxHeight}px`,
      objectFit: 'contain' as const,
    };
  };

  const handleImageLoad = () => {
    setIsLoading(false);
    if (imageRef.current) {
      setImageDimensions({
        width: imageRef.current.naturalWidth,
        height: imageRef.current.naturalHeight,
      });
    }
  };

  return (
    <div 
      ref={containerRef}
      className="relative w-full flex items-center justify-center"
      onMouseEnter={() => setShowFullscreenButton(true)}
      onMouseLeave={() => setShowFullscreenButton(false)}
      style={{
        minHeight: '400px',
        maxHeight: '80vh',
        width: '100%',
      }}
    >
      {isLoading && !hasError && (
        <div className="absolute inset-0 flex items-center justify-center text-white text-lg z-10 bg-black">
          Loading...
        </div>
      )}
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        style={getImageStyle()}
        className={`${isLoading ? 'opacity-0' : 'opacity-100 transition-opacity duration-300'}`}
        onLoad={handleImageLoad}
        onError={() => {
          setIsLoading(false);
          setHasError(true);
        }}
      />
      {onFullscreen && !isLoading && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (onFullscreen) {
              onFullscreen();
            }
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          className={`absolute bottom-4 right-4 p-2 rounded bg-black/50 hover:bg-black/70 text-white transition-all z-30 ${
            showFullscreenButton ? 'opacity-100' : 'opacity-70'
          }`}
          aria-label="Fullscreen"
          title="Fullscreen"
          style={{ pointerEvents: 'auto', cursor: 'pointer' }}
        >
          <ArrowsPointingOutIcon className="w-5 h-5" />
        </button>
      )}
    </div>
  );
}

type AssetDetailLocationState = {
  asset?: Asset;
  index?: number;
  sort?: string;
  order?: string;
  filteredAssetIds?: number[]; // Filtered asset IDs for navigation (e.g., assets from the same year when folder view is enabled)
  from?: {
    pathname: string;
    search?: string;
    hash?: string;
  };
};

export default function AssetDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const loc = useLocation();
  const state = loc.state as AssetDetailLocationState | null;
  const { pageSize: adaptivePageSize } = useAdaptivePageSize();
  const asset = state?.asset;
  const fromLocation = state?.from;
  const isFromSearch = fromLocation?.pathname?.startsWith('/search') ?? false;
  const searchParams = useMemo(
    () => (fromLocation?.search ? new URLSearchParams(fromLocation.search) : null),
    [fromLocation?.search],
  );
  const searchQuery = isFromSearch && searchParams ? searchParams.get('q') || '' : '';
  const searchFrom = searchParams?.get('from') || undefined;
  const searchTo = searchParams?.get('to') || undefined;
  const searchCameraMake = searchParams?.get('camera_make') || undefined;
  const searchCameraModel = searchParams?.get('camera_model') || undefined;
  const searchPlatformType = searchParams?.get('platformType') || undefined;
  const searchMinSizeRaw = searchParams?.get('minSize') || undefined;
  const searchMinSize = searchMinSizeRaw ? Number(searchMinSizeRaw) : undefined;
  const searchMaxSizeRaw = searchParams?.get('maxSize') || undefined;
  const searchMaxSize = searchMaxSizeRaw ? Number(searchMaxSizeRaw) : undefined;
  const searchFileTypesRaw = searchParams?.get('fileTypes') || undefined;
  const searchFileTypes = searchFileTypesRaw
    ? searchFileTypesRaw.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined;
  
  // Extract person_id from the source URL if coming from a person-filtered gallery
  const personIdFromSource = useMemo(() => {
    if (fromLocation?.search) {
      const params = new URLSearchParams(fromLocation.search);
      const personParam = params.get('person');
      if (personParam) {
        const parsed = parseInt(personParam, 10);
        if (!isNaN(parsed)) {
          return parsed;
        }
      }
    }
    return undefined;
  }, [fromLocation?.search]);
  
  const returnPath = useMemo(() => {
    if (!fromLocation?.pathname) {
      return null;
    }
    return `${fromLocation.pathname}${fromLocation.search ?? ''}${fromLocation.hash ?? ''}`;
  }, [fromLocation?.pathname, fromLocation?.search, fromLocation?.hash]);

  const goBackToSource = useCallback(() => {
    if (returnPath) {
      nav(returnPath, { replace: true });
      return;
    }
    if (window.history.length > 1) {
      nav(-1);
      return;
    }
    nav('/gallery');
  }, [nav, returnPath]);
  const [showLightbox, setShowLightbox] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(state?.index ?? 0);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [assetToDelete, setAssetToDelete] = useState<Asset | null>(null);
  const [isExtractingAudio, setIsExtractingAudio] = useState(false);
  const [videoState, setVideoState] = useState<{ currentTime: number; isPlaying: boolean } | null>(null);
  const [showBurstCapture, setShowBurstCapture] = useState(false);
  const [pendingNavigationAfterDelete, setPendingNavigationAfterDelete] = useState<{ deletedId: number; originalIndex: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  
  // Fetch assets for navigation. When opened from the Search page,
  // use the search result set (including filters). Otherwise fall
  // back to the global gallery listing.
  const sort = (state?.sort as any) || 'none';
  const order = (state?.order as any) || 'desc';
  const isSearchContext = isFromSearch && !!searchQuery;

  const { data: assetsData, refetch: refetchAssets } = useAssetsInfinite({
    sort,
    order,
    // Use the same adaptive page size as Gallery so navigation
    // in AssetDetail sees the exact same paginated asset set.
    pageSize: adaptivePageSize,
    person_id: personIdFromSource,
    enabled: !isSearchContext,
  });

  const { data: searchData, refetch: refetchSearch } = useSearchInfinite({
    q: searchQuery,
    from: searchFrom,
    to: searchTo,
    camera_make: searchCameraMake,
    camera_model: searchCameraModel,
    platformType: searchPlatformType,
    // Match Search page page size so detail view reuses
    // the same search result ordering and pages.
    pageSize: adaptivePageSize,
    enabled: isSearchContext,
  });

  const [deletedAssetIds, setDeletedAssetIds] = useState<Set<number>>(new Set());

  const baseAssets = isSearchContext
    ? (searchData?.pages.flatMap((p) => p.items) ?? [])
    : (assetsData?.pages.flatMap((p) => p.items) ?? []);

  const filteredForSearch = isSearchContext
    ? baseAssets.filter((item) => {
        if (searchMinSize !== undefined && item.size_bytes < searchMinSize) return false;
        if (searchMaxSize !== undefined && item.size_bytes > searchMaxSize) return false;

        if (searchFileTypes && searchFileTypes.length > 0) {
          const matchesType = searchFileTypes.some((type) => {
            if (type.includes('/')) {
              return item.mime.startsWith(type);
            }
            return item.mime.includes(type);
          });
          if (!matchesType) return false;
        }

        return true;
      })
    : baseAssets;

  const rawAssets = filteredForSearch.filter((a) => !deletedAssetIds.has(a.id));
  
  // Apply organization settings to get the same order as Gallery/Search
  const prioritizeFolderStructure = useUIStore((s) => s.prioritizeFolderStructure);
  const prioritizeFilenameDate = useUIStore((s) => s.prioritizeFilenameDate);
  const allAssets = useMemo(() => {
    return organizeAssets(rawAssets, prioritizeFolderStructure, prioritizeFilenameDate, sort, order);
  }, [rawAssets, prioritizeFolderStructure, prioritizeFilenameDate, sort, order]);
  
  // Use filtered asset IDs for navigation if provided (e.g., when folder view is enabled and grouped by year)
  // Otherwise, use all assets
  const navigationAssets = useMemo(() => {
    if (state?.filteredAssetIds && state.filteredAssetIds.length > 0) {
      const lookup = new Map(allAssets.map((asset) => [asset.id, asset]));
      // Only include assets that are in the filtered list, preserving the order of filteredAssetIds
      const ordered = state.filteredAssetIds
        .map((id) => lookup.get(id))
        .filter((asset): asset is Asset => Boolean(asset));
      // Return assets in the order specified by filteredAssetIds
      // If some assets aren't loaded yet, they won't be in the navigation list
      // but the counter will still show the correct total (filteredAssetIds.length)
      return ordered;
    }
    return allAssets;
  }, [state?.filteredAssetIds, allAssets]);
  
  // Get total count from API response, fallback to loaded count
  const totalAssets = (isSearchContext ? searchData?.pages[0]?.total : assetsData?.pages[0]?.total) ?? allAssets.length;

  // Fetch asset by ID if not in state or cache
  const assetId = id ? parseInt(id, 10) : null;
  const assetFromCache = asset || (assetId ? allAssets.find(a => a.id === assetId) : null);
  const shouldFetchAsset = assetId && !assetFromCache && !deletedAssetIds.has(assetId);
  const { data: fetchedAsset, isLoading: isLoadingAsset } = useQuery({
    queryKey: ['asset', assetId],
    queryFn: () => assetId ? assetApi.get(assetId) : Promise.reject(new Error('No asset ID')),
    enabled: shouldFetchAsset,
    staleTime: 60000, // Cache for 1 minute
  });

  // Use fetched asset if available, otherwise use cached asset
  const currentAsset = fetchedAsset || assetFromCache;

  // Find the current index in the navigation assets (filtered or all)
  const currentNavigationIndex = useMemo(() => {
    if (!currentAsset) return 0;
    
    // If we have filteredAssetIds and an index from state, use that index
    // (it's based on the full filtered list, not just loaded assets)
    if (state?.filteredAssetIds && state.index !== undefined) {
      // Validate that the index is within bounds
      const maxIndex = state.filteredAssetIds.length - 1;
      if (state.index >= 0 && state.index <= maxIndex) {
        return state.index;
      }
      // If index is out of bounds, try to find the asset in the filtered list
      const indexInFiltered = state.filteredAssetIds.indexOf(currentAsset.id);
      if (indexInFiltered >= 0) {
        return indexInFiltered;
      }
    }
    
    // Fallback: try to find the asset in navigationAssets
    const index = navigationAssets.findIndex(a => a.id === currentAsset.id);
    if (index >= 0) {
      return index;
    }
    
    // Last resort: use state.index if available, or 0
    const fallback = state?.index ?? 0;
    if (navigationAssets.length === 0) {
      return 0;
    }
    return Math.min(Math.max(0, fallback), navigationAssets.length - 1);
  }, [currentAsset, navigationAssets, state?.index, state?.filteredAssetIds]);

  // Update currentIndex when navigation assets or current asset changes
  useEffect(() => {
    setCurrentIndex(currentNavigationIndex);
  }, [currentNavigationIndex]);

  // Define handleNavigate before it's used in useEffect
  const handleNavigate = useCallback((newIndex: number) => {
    // If we have filteredAssetIds, we can navigate to any index in that range
    // even if the asset isn't in navigationAssets yet (it will be fetched)
    if (state?.filteredAssetIds && newIndex >= 0 && newIndex < state.filteredAssetIds.length) {
      const targetAssetId = state.filteredAssetIds[newIndex];
      // Check if asset is in navigationAssets (loaded)
      const assetInList = navigationAssets.find(a => a.id === targetAssetId);
      if (assetInList && !deletedAssetIds.has(targetAssetId)) {
        // Asset is loaded, navigate to it
        setCurrentIndex(newIndex);
        nav(`/asset/${targetAssetId}`, {
          state: {
            asset: assetInList,
            index: newIndex,
            sort,
            order,
            filteredAssetIds: state.filteredAssetIds,
            from: fromLocation,
          },
          replace: true,
        });
      } else if (!deletedAssetIds.has(targetAssetId)) {
        // Asset not loaded yet, navigate to it anyway (it will be fetched)
        setCurrentIndex(newIndex);
        nav(`/asset/${targetAssetId}`, {
          state: {
            index: newIndex,
            sort,
            order,
            filteredAssetIds: state.filteredAssetIds,
            from: fromLocation,
          },
          replace: true,
        });
      }
      return;
    }
    
    // Fallback to original logic when no filteredAssetIds
    if (newIndex >= 0 && newIndex < navigationAssets.length) {
      const newAsset = navigationAssets[newIndex];
      if (newAsset && !deletedAssetIds.has(newAsset.id)) {
        setCurrentIndex(newIndex);
        nav(`/asset/${newAsset.id}`, {
          state: {
            asset: newAsset,
            index: newIndex,
            sort,
            order,
            filteredAssetIds: state?.filteredAssetIds,
            from: fromLocation,
          },
          replace: true,
        });
      }
    }
  }, [navigationAssets, deletedAssetIds, nav, sort, order, fromLocation, state?.filteredAssetIds]);

  const showDeleteConfirmation = useUIStore((s) => s.showDeleteConfirmation);
  const deleteOriginalFiles = useUIStore((s) => s.deleteOriginalFiles);

  const handleDeleteConfirm = useCallback(async (assetId?: number) => {
    const idToDelete = assetId || assetToDelete?.id || (currentAsset?.id);
    if (!idToDelete) return;
    
    try {
      const result = await assetApi.delete(idToDelete, { permanent: deleteOriginalFiles });
      if (deleteOriginalFiles) {
        const permanentResult = result as { success: boolean; read_only?: boolean; error?: string; path?: string };
        if (!permanentResult.success) {
          if (permanentResult.read_only) {
            alert(
              `Unable to delete "${
                assetToDelete?.filename || idToDelete
              }" from disk because the file is read-only${
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

      setShowDeleteConfirm(false);
      setAssetToDelete(null);
      
      // Mark asset as deleted
      setDeletedAssetIds(prev => new Set([...prev, idToDelete]));
      
      // If we deleted the current asset, set pending navigation and trigger refetch
      if (idToDelete === currentAsset?.id) {
        // Set pending navigation to trigger navigation after refetch completes
        // Store the original index so we can navigate to the correct next item
        setPendingNavigationAfterDelete({ deletedId: idToDelete, originalIndex: currentIndex });
      }
      
      // Refetch assets/search to get updated list from server
      if (isSearchContext) {
        refetchSearch();
      } else {
        refetchAssets();
      }
    } catch (error) {
      console.error('Delete failed:', error);
      alert(`Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [assetToDelete, currentAsset, navigationAssets, currentIndex, nav, refetchAssets, refetchSearch, sort, order, fromLocation, goBackToSource, isSearchContext, deleteOriginalFiles, state?.filteredAssetIds]);

  // Define handleDeleteClick before it's used in useEffect
  const handleDeleteClick = useCallback((id: number) => {
    // First try to use the current asset if it matches
    const assetToDeleteLocal = (currentAsset && currentAsset.id === id) ? currentAsset : allAssets.find(a => a.id === id);
    if (assetToDeleteLocal) {
      if (showDeleteConfirmation) {
        setAssetToDelete(assetToDeleteLocal);
        setShowDeleteConfirm(true);
      } else {
        // Delete immediately without confirmation
        handleDeleteConfirm(id);
      }
    } else {
      // If asset not found, try to create a minimal asset object from the ID
      console.warn('Asset not found for deletion, using ID only:', id);
      if (showDeleteConfirmation) {
        setAssetToDelete({ id } as Asset);
        setShowDeleteConfirm(true);
      } else {
        // Delete immediately without confirmation
        handleDeleteConfirm(id);
      }
    }
  }, [allAssets, currentAsset, showDeleteConfirmation, handleDeleteConfirm]);

  // Handle asset deletion navigation
  useEffect(() => {
    if (currentAsset) {
      // Only navigate away if asset is explicitly marked as deleted
      // Don't navigate if assets are still loading (navigationAssets might be empty initially)
      if (deletedAssetIds.has(currentAsset.id)) {
        // Asset was deleted, navigate to next or previous, or back to gallery
        if (navigationAssets.length === 0) {
          goBackToSource();
        } else {
          // When an asset is deleted, we want to navigate to the next asset in the sequence
          // Use filteredAssetIds to find the correct next asset, not navigationAssets
          // (which might not be updated yet)
          let nextAssetId: number | null = null;
          let nextIndex = currentIndex;
          
          if (state?.filteredAssetIds && state.filteredAssetIds.length > 0) {
            // Find the deleted asset's index in the filtered list
            const deletedIndexInFiltered = state.filteredAssetIds.indexOf(currentAsset.id);
            
            if (deletedIndexInFiltered >= 0) {
              // Find the next asset in the filtered list (skip the deleted one)
              // Try the asset at deletedIndexInFiltered + 1, or if that's the end, use deletedIndexInFiltered - 1
              if (deletedIndexInFiltered < state.filteredAssetIds.length - 1) {
                // There's a next asset in the filtered list
                nextAssetId = state.filteredAssetIds[deletedIndexInFiltered + 1];
                nextIndex = deletedIndexInFiltered; // After deletion, this becomes the new index
              } else if (deletedIndexInFiltered > 0) {
                // We're at the end, go to the previous asset
                nextAssetId = state.filteredAssetIds[deletedIndexInFiltered - 1];
                nextIndex = deletedIndexInFiltered - 1;
              }
            }
          } else {
            // No filteredAssetIds, use navigationAssets
            if (currentIndex < navigationAssets.length) {
              // Stay at the same index (which now points to the next asset)
              nextAssetId = navigationAssets[currentIndex].id;
              nextIndex = currentIndex;
            } else if (navigationAssets.length > 0) {
              // Beyond the end, go to the last asset
              nextAssetId = navigationAssets[navigationAssets.length - 1].id;
              nextIndex = navigationAssets.length - 1;
            }
          }
          
          if (nextAssetId !== null) {
            // Find the asset in navigationAssets or allAssets
            const nextAsset = navigationAssets.find(a => a.id === nextAssetId) 
              || allAssets.find(a => a.id === nextAssetId);
            
            if (nextAsset) {
              // Create updated filteredAssetIds without the deleted asset
              const updatedFilteredIds = state?.filteredAssetIds 
                ? state.filteredAssetIds.filter(id => id !== currentAsset.id)
                : undefined;
              
              nav(`/asset/${nextAsset.id}`, {
                state: {
                  asset: nextAsset,
                  index: nextIndex,
                  sort,
                  order,
                  filteredAssetIds: updatedFilteredIds,
                  from: fromLocation,
                },
                replace: true,
              });
            } else {
              goBackToSource();
            }
          } else {
            goBackToSource();
          }
        }
      }
    }
  }, [currentAsset, navigationAssets, allAssets, currentIndex, nav, sort, order, deletedAssetIds, goBackToSource, state?.filteredAssetIds, fromLocation]);

  // Handle navigation after deletion and refetch completes
  useEffect(() => {
    if (!pendingNavigationAfterDelete) return;
    
    const { deletedId, originalIndex } = pendingNavigationAfterDelete;
    
    // Wait for navigationAssets to update (should not contain deleted asset)
    // Check that we have assets and the deleted asset is not in the list
    if (navigationAssets.length > 0 && !navigationAssets.some(a => a.id === deletedId)) {
      // Navigate to the asset that was next in sequence
      // After deletion, the item that was at originalIndex + 1 is now at originalIndex
      // If we were at the end, navigate to the last item
      const nextIndex = originalIndex < navigationAssets.length ? originalIndex : Math.max(0, navigationAssets.length - 1);
      
      if (nextIndex >= 0 && nextIndex < navigationAssets.length) {
        const nextAsset = navigationAssets[nextIndex];
        // Make sure we're not navigating to the deleted asset (shouldn't happen, but safety check)
        if (nextAsset && nextAsset.id !== deletedId) {
          nav(`/asset/${nextAsset.id}`, {
            state: {
              asset: nextAsset,
              index: nextIndex,
              sort,
              order,
              filteredAssetIds: state?.filteredAssetIds,
              from: fromLocation,
            },
            replace: true,
          });
          // Clear pending navigation
          setPendingNavigationAfterDelete(null);
          return;
        }
      }
      
      // If we can't navigate to next/prev, go back to gallery
      goBackToSource();
      setPendingNavigationAfterDelete(null);
    }
  }, [pendingNavigationAfterDelete, navigationAssets, nav, sort, order, fromLocation, goBackToSource, state?.filteredAssetIds]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'Escape') {
        // If lightbox is open, close it first
        if (showLightbox) {
          setShowLightbox(false);
        } else {
          e.preventDefault();
          goBackToSource();
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Only handle delete if lightbox is not open (lightbox handles its own delete)
        if (!showLightbox && currentAsset) {
          e.preventDefault();
          handleDeleteClick(currentAsset.id);
        }
      } else if (e.key === 'ArrowLeft' && !showLightbox && currentAsset) {
        // Use currentIndex which is already synced with navigationAssets
        // Check against filteredAssetIds length if available, otherwise navigationAssets length
        const maxIndex = state?.filteredAssetIds ? state.filteredAssetIds.length : navigationAssets.length;
        if (maxIndex > 0 && currentIndex > 0) {
          e.preventDefault();
          handleNavigate(currentIndex - 1);
        }
      } else if (e.key === 'ArrowRight' && !showLightbox && currentAsset) {
        // Use currentIndex which is already synced with navigationAssets
        // Check against filteredAssetIds length if available, otherwise navigationAssets length
        const maxIndex = state?.filteredAssetIds ? state.filteredAssetIds.length : navigationAssets.length;
        if (maxIndex > 0 && currentIndex >= 0 && currentIndex < maxIndex - 1) {
          e.preventDefault();
          handleNavigate(currentIndex + 1);
        }
      } else if (e.key === ' ' && !showLightbox && currentAsset && isVideo(currentAsset.mime)) {
        // Spacebar to play/pause video
        e.preventDefault();
        const video = videoRef.current;
        if (video) {
          if (video.paused) {
            video.play().catch((err) => {
              console.error('Error playing video:', err);
            });
          } else {
            video.pause();
          }
        }
      } else if (e.key === 'f' || e.key === 'F') {
        // 'f' key to toggle fullscreen (open/close lightbox)
        e.preventDefault();
        if (showLightbox) {
          // Close lightbox if open
          setShowLightbox(false);
        } else if (currentAsset) {
          // Open lightbox if closed
          // currentIndex is already synced with navigationAssets via useEffect
          setShowLightbox(true);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showLightbox, goBackToSource, navigationAssets, handleNavigate, currentAsset, handleDeleteClick, videoRef, currentIndex]);

  // Show loading state while fetching asset
  if (shouldFetchAsset && isLoadingAsset) {
    return (
      <div className="container-responsive py-10 text-center opacity-70">
        Loading asset {id}...
      </div>
    );
  }

  // Show error if asset not found
  if (!currentAsset) {
    return (
      <div className="container-responsive py-10 text-center opacity-70">
        Unable to load asset {id}. The asset may have been deleted or does not exist.
        <div className="mt-3">
          <button onClick={goBackToSource} className="px-3 py-2 rounded border border-zinc-300 dark:border-zinc-700">Go Back</button>
        </div>
      </div>
    );
  }

  // Determine navigation capabilities
  // If we have filteredAssetIds, use that for bounds checking (allows navigation even if not all assets are loaded)
  // Otherwise, use navigationAssets.length
  const totalForNavigation = state?.filteredAssetIds ? state.filteredAssetIds.length : navigationAssets.length;
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < totalForNavigation - 1;

  return (
    <>
      <div className="container-responsive py-2 sm:py-4 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-3 sm:gap-4">
        <div className="relative">
          {/* Navigation buttons */}
          {canGoPrev && (
            <button
              onClick={() => handleNavigate(currentIndex - 1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors shadow-lg"
              aria-label="Previous"
            >
              <ChevronLeftIcon className="w-6 h-6" />
            </button>
          )}

          {canGoNext && (
            <button
              onClick={() => handleNavigate(currentIndex + 1)}
              className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors shadow-lg"
              aria-label="Next"
            >
              <ChevronRightIcon className="w-6 h-6" />
            </button>
          )}

          {/* Image counter */}
          {(navigationAssets.length > 1 || (state?.filteredAssetIds && state.filteredAssetIds.length > 1)) && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full bg-black/50 backdrop-blur-sm text-white text-sm">
              {currentIndex + 1} / {state?.filteredAssetIds ? state.filteredAssetIds.length : (totalAssets > 0 ? totalAssets : navigationAssets.length)}
            </div>
          )}

          {isVideo(currentAsset.mime) ? (
            <VideoPlayer 
              asset={currentAsset} 
              className="border border-zinc-200 dark:border-zinc-800" 
              onFullscreen={() => setShowLightbox(true)}
              onStateChange={setVideoState}
              savedState={videoState}
              videoRef={videoRef}
            />
          ) : (
            <div
              className="rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-black relative"
            >
              <ImageWithLoading 
                src={media.previewUrl(currentAsset.id, currentAsset.sha256)} 
                alt={currentAsset.filename}
                onFullscreen={() => setShowLightbox(true)}
              />
            </div>
          )}
        </div>
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <MetadataPanel asset={currentAsset} />
          <div className="mt-3 space-y-2">
            {isVideo(currentAsset.mime) && (
              <>
                <button
                  onClick={async () => {
                    if (isExtractingAudio) return;
                    setIsExtractingAudio(true);
                    try {
                      await assetApi.extractAudioMp3(currentAsset.id);
                    } catch (err) {
                      console.error('Extract audio failed:', err);
                      alert(`Extract audio failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
                    } finally {
                      setIsExtractingAudio(false);
                    }
                  }}
                  disabled={isExtractingAudio}
                  className="w-full px-3 py-2 rounded-md bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 disabled:cursor-not-allowed text-white text-sm transition-colors flex items-center justify-center gap-2"
                >
                  {isExtractingAudio ? (
                    <>
                      <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      <span>Extracting...</span>
                    </>
                  ) : (
                    <span>Extract Audio</span>
                  )}
                </button>
                <button
                  onClick={() => setShowBurstCapture(true)}
                  className="w-full px-3 py-2 rounded-md bg-purple-600 hover:bg-purple-700 text-white text-sm transition-colors"
                >
                  Capture Burst
                </button>
              </>
            )}
            <button
              onClick={() => {
                if (currentAsset?.id) {
                  handleDeleteClick(currentAsset.id);
                } else {
                  console.error('Cannot delete: asset or asset.id is undefined', currentAsset);
                }
              }}
              disabled={!currentAsset?.id}
              className="w-full px-3 py-2 rounded-md bg-red-600 hover:bg-red-700 disabled:bg-red-400 disabled:cursor-not-allowed text-white text-sm transition-colors"
            >
              Delete
            </button>
          </div>
        </aside>
      </div>

      {showLightbox && currentAsset && (() => {
        const actualIndex = currentIndex;
        const assetToShow = currentAsset;
        const totalNavigation = navigationAssets.length || totalAssets || 1;

        if (!assetToShow) return null;

        return (
          <ErrorBoundary
            fallback={
              <div className="fixed inset-0 z-50 bg-black/95 backdrop-blur-sm flex items-center justify-center">
                <div className="text-white text-center">
                  <p className="text-lg mb-2">Error loading lightbox</p>
                  <button
                    onClick={() => setShowLightbox(false)}
                    className="px-4 py-2 rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            }
          >
            <Lightbox
              asset={assetToShow}
              currentIndex={actualIndex}
              total={totalNavigation}
              onClose={() => setShowLightbox(false)}
              onNavigate={handleNavigate}
              onDelete={handleDeleteClick}
              videoState={isVideo(assetToShow.mime) ? videoState : undefined}
              onVideoStateChange={isVideo(assetToShow.mime) ? setVideoState : undefined}
            />
          </ErrorBoundary>
        );
      })()}

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => {
          setShowDeleteConfirm(false);
          setAssetToDelete(null);
        }}
        onConfirm={() => handleDeleteConfirm()}
        title={deleteOriginalFiles ? 'Delete From Disk' : 'Remove From Seen'}
        message={
          deleteOriginalFiles
            ? `This will delete "${assetToDelete?.filename ?? 'this asset'}" from Seen and remove the original file from disk. This cannot be undone.`
            : `Remove "${assetToDelete?.filename ?? 'this asset'}" from the Seen index? The original file stays on disk.`
        }
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
      />

      {isVideo(currentAsset.mime) && (
        <BurstCapture
          videoElement={videoRef.current}
          isOpen={showBurstCapture}
          onClose={() => setShowBurstCapture(false)}
          onResume={(wasPlaying) => {
            if (videoRef.current && wasPlaying) {
              videoRef.current.play().catch(() => {});
            }
          }}
          assetFilename={currentAsset.filename}
        />
      )}
    </>
  );
}

