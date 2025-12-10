import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'react';
import type { Asset } from '../types';
import AssetCard from './AssetCard';
import { useUIStore } from '../lib/store';
import { GalleryGridSkeleton } from './LoadingSkeleton';
import BulkActions from './BulkActions';
import { addAssetsToAlbum } from '../lib/albums';
import { assetApi } from '../lib/api';
import ConfirmDialog from './ConfirmDialog';

export default function GalleryGrid({ assets, onLoadMore, hasMore, onLoadPrevious, hasPrevious, sort, order, isLoading, isFetchingNextPage, onAssetDeleted, mobileColumns, personId, filteredAssetIdsOverride, showRemoveFromAlbum }: {
  assets: Asset[];
  onLoadMore?: () => void;
  hasMore?: boolean;
  onLoadPrevious?: () => void;
  hasPrevious?: boolean;
  sort?: string;
  order?: string;
  isLoading?: boolean;
  isFetchingNextPage?: boolean;
  onAssetDeleted?: (id: number | number[]) => void;
  mobileColumns?: number;
  personId?: number | null;
  filteredAssetIdsOverride?: number[];
  showRemoveFromAlbum?: boolean; // Whether to show "Remove from Album" in bulk actions (only in albums view)
}) {
  // Deduplicate assets by ID to prevent duplicate React keys
  const uniqueAssets = useMemo(() => {
    const seen = new Set<number>();
    return assets.filter(asset => {
      if (seen.has(asset.id)) {
        return false;
      }
      seen.add(asset.id);
      return true;
    });
  }, [assets]);
  
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragEnd, setDragEnd] = useState<{ x: number; y: number } | null>(null);
  const [hasDragged, setHasDragged] = useState(false);
  const [isCtrlPressed, setIsCtrlPressed] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const gridWrapperRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const rafIdRef = useRef<number | null>(null);
  // Track all items that have been selected during the current drag operation
  const dragSelectedIdsRef = useRef<Set<number>>(new Set());
  // Grid container that handles responsive columns
  const gridContainerRef = useRef<HTMLDivElement | null>(null);

  // Bottom sentinel for forward infinite scroll – simple 706ba335-style observer
  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) onLoadMore();
      },
      { rootMargin: '800px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onLoadMore, hasMore]);

  const gridSize = useUIStore((s) => s.gridSize);
  const deleteOriginalFiles = useUIStore((s) => s.deleteOriginalFiles);
  const showDeleteConfirmation = useUIStore((s) => s.showDeleteConfirmation);

  const GAP_PX = 8; // Tailwind gap-2
  const CARD_META_HEIGHT = 72; // padding + filename block + controls

  const [containerWidth, setContainerWidth] = useState(0);
  const [windowWidth, setWindowWidth] = useState<number>(() => (typeof window !== 'undefined' ? window.innerWidth : 0));
  const [virtualRange, setVirtualRange] = useState<{ start: number; end: number }>({ start: 0, end: 40 });

  // Track viewport width for mobile column logic
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Observe the grid wrapper width so we can derive column counts
  useLayoutEffect(() => {
    if (!gridWrapperRef.current || typeof window === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(gridWrapperRef.current);
    return () => observer.disconnect();
  }, []);

  const isMobileView = windowWidth < 640 && mobileColumns !== undefined;

  const { columnCount, columnWidth } = useMemo(() => {
    if (!containerWidth) {
      return { columnCount: 0, columnWidth: gridSize };
    }
    if (isMobileView && mobileColumns) {
      const width = (containerWidth - GAP_PX * (mobileColumns - 1)) / mobileColumns;
      return { columnCount: mobileColumns, columnWidth: width };
    }
    const maxColumns = Math.max(1, Math.floor((containerWidth + GAP_PX) / (gridSize + GAP_PX)));
    const width = maxColumns > 0 ? (containerWidth - GAP_PX * (maxColumns - 1)) / maxColumns : containerWidth;
    return { columnCount: maxColumns || 1, columnWidth: width };
  }, [containerWidth, gridSize, isMobileView, mobileColumns]);

  const rowHeight = useMemo(() => {
    if (!columnWidth) return 0;
    const mediaHeight = columnWidth * 0.75; // aspect-[4/3]
    return mediaHeight + CARD_META_HEIGHT;
  }, [columnWidth]);

  const rowHeightWithGap = rowHeight + GAP_PX;
  const totalRows = columnCount ? Math.ceil(uniqueAssets.length / columnCount) : 0;
  // Disable virtualization to match the stable behavior from commit 706ba335
  // and avoid flicker/jitter when paging through many images.
  const shouldVirtualize = false;

  // Recompute visible range on scroll/resize - throttled to prevent jitter
  useEffect(() => {
    if (!shouldVirtualize || typeof window === 'undefined') {
      setVirtualRange({ start: 0, end: uniqueAssets.length });
      return;
    }

    let rafId: number | null = null;
    let lastUpdateTime = 0;
    let lastScrollY = window.scrollY;
    let isUserScrolling = false;
    let scrollTimeout: NodeJS.Timeout | null = null;
    const MIN_UPDATE_INTERVAL = 16; // ~60fps max update rate

    // Track user scrolling to prevent interference
    const handleScrollStart = () => {
      isUserScrolling = true;
      lastScrollY = window.scrollY;
      
      // Clear any pending scroll timeout
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }
      
      // Mark scrolling as stopped after a delay
      scrollTimeout = setTimeout(() => {
        isUserScrolling = false;
      }, 150);
    };

    const updateRange = () => {
      if (!gridWrapperRef.current || !columnCount) return;
      
      // Track scroll position changes
      const currentScrollY = window.scrollY;
      if (Math.abs(currentScrollY - lastScrollY) > 1) {
        handleScrollStart();
      }
      lastScrollY = currentScrollY;
      
      const now = performance.now();
      if (now - lastUpdateTime < MIN_UPDATE_INTERVAL) {
        // Skip this update if too soon
        return;
      }
      
      // Use requestAnimationFrame to batch layout reads
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      
      rafId = requestAnimationFrame(() => {
        rafId = null;
        lastUpdateTime = performance.now();
        
        const rect = gridWrapperRef.current!.getBoundingClientRect();
        const gridTop = rect.top + window.scrollY;
        const scrollY = window.scrollY;
        const viewportHeight = window.innerHeight;
        const offsetY = scrollY - gridTop;
        const startRow = Math.max(0, Math.floor(offsetY / rowHeightWithGap));
        const visibleRowCount = Math.ceil(viewportHeight / rowHeightWithGap);
        const overscan = 3;
        const startIndex = Math.max(0, startRow * columnCount - overscan * columnCount);
        const endIndex = Math.min(uniqueAssets.length, (startRow + visibleRowCount + overscan) * columnCount);
        setVirtualRange((prev) => {
          // Only update if not currently scrolling to prevent jitter
          if (isUserScrolling && prev.start === startIndex && prev.end === endIndex) {
            return prev;
          }
          if (prev.start === startIndex && prev.end === endIndex) {
            return prev;
          }
          return { start: startIndex, end: endIndex };
        });
      });
    };

    // Initial update
    updateRange();
    
    window.addEventListener('scroll', updateRange, { passive: true });
    window.addEventListener('resize', updateRange);
    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }
      window.removeEventListener('scroll', updateRange);
      window.removeEventListener('resize', updateRange);
    };
  }, [shouldVirtualize, columnCount, rowHeightWithGap, uniqueAssets.length]);

  // Only update virtual range when assets length changes significantly, not on every change
  // This prevents unnecessary layout recalculations that cause jitter
  useEffect(() => {
    if (!shouldVirtualize) return;
    
    // Use requestAnimationFrame to batch this update and prevent layout thrashing
    const rafId = requestAnimationFrame(() => {
      setVirtualRange((prev) => {
        // Only update if the end needs to change significantly
        const newEnd = Math.min(uniqueAssets.length, prev.start + columnCount * 10);
        // Only update if the change is meaningful (more than 1 row difference)
        const rowDiff = Math.abs((newEnd - prev.end) / columnCount);
        if (rowDiff > 1 || newEnd > uniqueAssets.length) {
          return { start: prev.start, end: newEnd };
        }
        return prev;
      });
    });
    
    return () => cancelAnimationFrame(rafId);
  }, [shouldVirtualize, uniqueAssets.length, columnCount]);

  const uniqueAssetIds = useMemo(() => {
    if (filteredAssetIdsOverride) {
      return filteredAssetIdsOverride;
    }
    return uniqueAssets.map((asset) => asset.id);
  }, [uniqueAssets, filteredAssetIdsOverride]);

  const virtualizedAssets = useMemo(() => {
    if (!shouldVirtualize) return uniqueAssets;
    return uniqueAssets.slice(virtualRange.start, virtualRange.end);
  }, [uniqueAssets, shouldVirtualize, virtualRange]);

  useEffect(() => {
    if (!shouldVirtualize) return;
    const visibleIds = new Set(virtualizedAssets.map((asset) => asset.id));
    cardRefs.current.forEach((_, assetId) => {
      if (!visibleIds.has(assetId)) {
        cardRefs.current.delete(assetId);
      }
    });
  }, [shouldVirtualize, virtualizedAssets]);

  const topSpacerHeight = shouldVirtualize && columnCount
    ? Math.max(0, Math.floor(virtualRange.start / columnCount) * rowHeightWithGap)
    : 0;
  const renderedRows = shouldVirtualize && columnCount
    ? Math.ceil(virtualizedAssets.length / columnCount)
    : totalRows;
  const bottomSpacerHeight = shouldVirtualize && columnCount
    ? Math.max(0, totalRows * rowHeightWithGap - topSpacerHeight - renderedRows * rowHeightWithGap)
    : 0;

  // Handle keyboard shortcuts and CTRL key tracking
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Track CTRL key (also CMD on Mac)
      if (e.key === 'Control' || e.key === 'Meta') {
        setIsCtrlPressed(true);
      }

      if (e.key === 'Escape' && selectionMode) {
        setSelectionMode(false);
        setSelectedIds(new Set());
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectionMode && selectedIds.size > 0) {
        e.preventDefault();
        setShowBulkDeleteConfirm(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      // Track CTRL key release (also CMD on Mac)
      if (e.key === 'Control' || e.key === 'Meta') {
        setIsCtrlPressed(false);
      }
    };

    const handleBlur = () => {
      // Reset CTRL state when window loses focus to prevent stuck state
      setIsCtrlPressed(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [selectionMode, selectedIds.size]);

  const handleSelect = useCallback((id: number, selected: boolean, _isCtrlClick: boolean = false) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  // Calculate selection box coordinates
  const getSelectionBox = () => {
    if (!dragStart || !dragEnd) return null;
    const gridRect = gridRef.current?.getBoundingClientRect();
    if (!gridRect) return null;

    const startX = Math.min(dragStart.x, dragEnd.x) - gridRect.left;
    const startY = Math.min(dragStart.y, dragEnd.y) - gridRect.top;
    const width = Math.abs(dragEnd.x - dragStart.x);
    const height = Math.abs(dragEnd.y - dragStart.y);

    return { left: startX, top: startY, width, height };
  };


  // Handle mouse down for drag selection
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start drag selection on left mouse button
    if (e.button !== 0) return;
    
    // Don't start drag if clicking on a button
    const target = e.target as HTMLElement;
    if (target.closest('button')) {
      return;
    }
    
    // Allow drag selection from anywhere in the grid, including cards and links
    // We'll distinguish between click and drag based on movement
    setHasDragged(false);
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setDragEnd({ x: e.clientX, y: e.clientY });
    // Reset the drag selection tracking
    dragSelectedIdsRef.current = new Set();
    if (!selectionMode) {
      setSelectionMode(true);
    }
    // Prevent default to stop link navigation, but we'll restore it if it was just a click
    e.preventDefault();
    e.stopPropagation();
  }, [selectionMode]);

  // Global mouse move handler for drag selection
  useEffect(() => {
    // Function to update selection based on current drag box
    const updateSelectionFromDragBox = (start: { x: number; y: number }, end: { x: number; y: number }) => {
      // Calculate selection box bounds in viewport coordinates
      const selectionLeft = Math.min(start.x, end.x);
      const selectionRight = Math.max(start.x, end.x);
      const selectionTop = Math.min(start.y, end.y);
      const selectionBottom = Math.max(start.y, end.y);
      
      // Find items in the selection box (only consider rendered cards)
      const itemsInBox = new Set<number>();
      cardRefs.current.forEach((card, assetId) => {
        if (!card) return;
        const cardRect = card.getBoundingClientRect();
        
        // Check if card intersects with selection box
        // A card intersects if it's not completely outside the selection box
        const intersects = !(
          cardRect.right < selectionLeft ||
          cardRect.left > selectionRight ||
          cardRect.bottom < selectionTop ||
          cardRect.top > selectionBottom
        );
        
        if (intersects) {
          itemsInBox.add(assetId);
          // Track this item as selected during this drag
          dragSelectedIdsRef.current.add(assetId);
        }
      });
      
      // Update selection state
      // If CTRL is pressed, add to existing selection; otherwise use accumulated drag selection
      if (isCtrlPressed) {
        setSelectedIds((prev) => {
          const newSelected = new Set(prev);
          // Add all items in the selection box
          itemsInBox.forEach((id) => newSelected.add(id));
          return newSelected;
        });
      } else {
        // Use accumulated selection from entire drag operation
        // This ensures items remain selected even when scrolling moves them out of the current box
        setSelectedIds(dragSelectedIdsRef.current);
      }
    };
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!isDragging || !dragStart) return;
      
      // Cancel any pending animation frame
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      
      const currentEnd = { x: e.clientX, y: e.clientY };
      setDragEnd(currentEnd);

      // Check if we've moved enough to distinguish from click
      const dx = Math.abs(e.clientX - dragStart.x);
      const dy = Math.abs(e.clientY - dragStart.y);
      const hasMovedEnough = dx > 5 || dy > 5;
      
      if (hasMovedEnough) {
        setHasDragged(true);
        
        // Use requestAnimationFrame for smooth updates
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          updateSelectionFromDragBox(dragStart, currentEnd);
        });
      }
    };

    // Handle scroll during drag to update selection
    const handleScroll = () => {
      if (!isDragging || !dragStart || !dragEnd) return;
      
      // Cancel any pending animation frame
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      
      // Update selection based on current scroll position
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        updateSelectionFromDragBox(dragStart, dragEnd);
      });
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (isDragging) {
        const wasDrag = hasDragged;
        setIsDragging(false);
        setDragStart(null);
        setDragEnd(null);
        
        // If it was just a click (not a drag), let the browser's native
        // click event fire naturally (no synthetic re-dispatch).
        
        // Reset hasDragged after a short delay
        setTimeout(() => setHasDragged(false), 100);
      }
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleGlobalMouseMove);
      document.addEventListener('mouseup', handleGlobalMouseUp);
      // Listen for scroll events during drag
      window.addEventListener('scroll', handleScroll, { passive: true });
      // Also listen for wheel events (mouse wheel scrolling)
      window.addEventListener('wheel', handleScroll, { passive: true });
      // Prevent text selection during drag
      document.body.style.userSelect = 'none';
    }

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('wheel', handleScroll);
      document.body.style.userSelect = '';
    };
  }, [isDragging, dragStart, dragEnd, uniqueAssets, isCtrlPressed]);

  // Register card refs
  const setCardRef = (id: number, element: HTMLDivElement | null) => {
    if (element) {
      cardRefs.current.set(id, element);
    } else {
      cardRefs.current.delete(id);
    }
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  const handleAddToAlbum = async (albumId: string, assetIds: number[]) => {
    try {
      await addAssetsToAlbum(albumId, assetIds);
    } catch (error) {
      console.error('Failed to add assets to album:', error);
      alert('Failed to add assets to album. Please try again.');
    }
  };

  const handleDelete = (id: number) => {
    if (onAssetDeleted) {
      onAssetDeleted(id);
    } else {
      // Fallback: reload the page
      window.location.reload();
    }
  };

  const handleBulkDelete = async () => {
    const idsToDelete = Array.from(selectedIds);
    if (idsToDelete.length === 0) return;

    try {
      if (deleteOriginalFiles) {
        const result = await assetApi.deletePermanentBulk(idsToDelete);
        const deletedIds = result.results.filter((r) => r.deleted).map((r) => r.id);
        const failures = result.results.filter((r) => !r.deleted);

        if (deletedIds.length && onAssetDeleted) {
          onAssetDeleted(deletedIds);
        }

        if (failures.length) {
          const failureIds = failures.map((f) => f.id);
          const readonlyFailures = failures.filter((f) => f.read_only);
          const formatList = (items: typeof failures) =>
            items
              .map((item) => item.path || `Asset ${item.id}`)
              .join('\n');
          if (readonlyFailures.length) {
            alert(
              `Unable to delete the following files because they are read-only:\n${formatList(readonlyFailures)}`
            );
          } else {
            alert(
              `Failed to delete the following files:\n${formatList(failures)}`
            );
          }
          setSelectedIds(new Set(failureIds));
          setSelectionMode(true);
          return;
        }

        // All deletions succeeded
        setSelectedIds(new Set());
        setSelectionMode(false);
        return;
      }

      await Promise.all(idsToDelete.map((id) => assetApi.delete(id)));
      if (onAssetDeleted) {
        onAssetDeleted(idsToDelete);
      }
      setSelectedIds(new Set());
      setSelectionMode(false);
    } catch (error) {
      console.error('Bulk delete failed:', error);
      alert(`Failed to delete some items: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  useEffect(() => {
    if (!gridContainerRef.current) return;
    
    // Only apply responsive behavior if mobileColumns is provided
    if (mobileColumns === undefined) {
      // Use default gridSize-based layout
      gridContainerRef.current.style.gridTemplateColumns = `repeat(auto-fill, minmax(min(${gridSize}px, 100%), 1fr))`;
      return;
    }
    
    const mediaQuery = window.matchMedia('(min-width: 640px)');
    const updateGrid = () => {
      if (!gridContainerRef.current) return;
      try {
        if (mediaQuery.matches) {
          // Desktop: use gridSize-based layout
          gridContainerRef.current.style.gridTemplateColumns = `repeat(auto-fill, minmax(min(${gridSize}px, 100%), 1fr))`;
        } else {
          // Mobile: use mobileColumns
          gridContainerRef.current.style.gridTemplateColumns = `repeat(${mobileColumns}, minmax(0, 1fr))`;
        }
      } catch (error) {
        console.error('Error updating grid columns:', error);
        // Fallback to default
        gridContainerRef.current.style.gridTemplateColumns = `repeat(auto-fill, minmax(min(${gridSize}px, 100%), 1fr))`;
      }
    };
    
    updateGrid();
    mediaQuery.addEventListener('change', updateGrid);
    return () => mediaQuery.removeEventListener('change', updateGrid);
  }, [mobileColumns, gridSize]);

  return (
    <div>
      <div
        ref={gridRef}
        className="relative select-none"
        onMouseDown={handleMouseDown}
      >
        <div ref={gridWrapperRef}>
          {shouldVirtualize && <div style={{ height: `${topSpacerHeight}px` }} />}
          <div
            ref={gridContainerRef}
            className="grid gap-2"
            style={{
              gridTemplateColumns: mobileColumns !== undefined && isMobileView
                ? `repeat(${mobileColumns}, minmax(0, 1fr))`
                : `repeat(auto-fill, minmax(min(${gridSize}px, 100%), 1fr))`,
            }}
          >
            {virtualizedAssets.map((a, i) => {
              // Calculate index based on position in uniqueAssetIds (the full filtered list)
              // This ensures correct index even when filteredAssetIdsOverride is used
              const actualIndex = uniqueAssetIds.indexOf(a.id);
              return (
                <div
                  key={a.id}
                  ref={(el) => setCardRef(a.id, el)}
                  data-asset-card
                  data-asset-id={a.id}
                  onMouseDown={handleMouseDown}
                >
                  <AssetCard
                    asset={a}
                    index={actualIndex}
                    sort={sort}
                    order={order}
                    filteredAssetIds={uniqueAssetIds}
                    isSelected={selectedIds.has(a.id)}
                    onSelect={(id: number, selected: boolean, isCtrlClick?: boolean) => handleSelect(id, selected, isCtrlClick)}
                    selectionMode={selectionMode}
                    onDelete={handleDelete}
                    isDragging={isDragging && hasDragged}
                    isCtrlPressed={isCtrlPressed}
                    personId={personId}
                    selectedIds={selectedIds}
                    isInAlbumsView={showRemoveFromAlbum}
                  />
                </div>
              );
            })}
          </div>
          {shouldVirtualize && <div style={{ height: `${bottomSpacerHeight}px` }} />}
        </div>

        {/* Selection box overlay */}
        {isDragging && (() => {
          const box = getSelectionBox();
          if (!box) return null;
          return (
            <div
              className="absolute border-2 border-blue-500 bg-blue-500/10 pointer-events-none z-10"
              style={{
                left: `${box.left}px`,
                top: `${box.top}px`,
                width: `${box.width}px`,
                height: `${box.height}px`,
              }}
            />
          );
        })()}
      </div>
      {hasMore && <div ref={sentinelRef} className="h-10" />}

      {selectionMode && (
        <BulkActions
          selectedIds={selectedIds}
          selectedAssetIds={Array.from(selectedIds)}
          onClearSelection={handleClearSelection}
          onAddToAlbum={handleAddToAlbum}
          onDelete={() => {
            if (showDeleteConfirmation) {
              setShowBulkDeleteConfirm(true);
            } else {
              handleBulkDelete();
            }
          }}
          showRemoveFromAlbum={showRemoveFromAlbum}
        />
      )}

      <ConfirmDialog
        isOpen={showBulkDeleteConfirm}
        onClose={() => setShowBulkDeleteConfirm(false)}
        onConfirm={handleBulkDelete}
        title={deleteOriginalFiles ? 'Delete Files From Disk' : 'Remove From Seen'}
        message={
          deleteOriginalFiles
            ? `Permanently delete ${selectedIds.size} ${selectedIds.size === 1 ? 'file' : 'files'} from Seen and from disk? This cannot be undone.`
            : `Remove ${selectedIds.size} ${selectedIds.size === 1 ? 'item' : 'items'} from the Seen index? The original files will remain on disk.`
        }
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
      />
    </div>
  );
}

