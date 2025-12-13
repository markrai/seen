import type { Asset } from '../types';
import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react';
import { useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import { useAssetsInfinite, useStats } from '../lib/hooks';
import GalleryGrid from '../components/GalleryGrid';
import { useGalleryScrollRestoration } from '../lib/scroll';
import Timeline from '../components/Timeline';
import { Squares2X2Icon, ChevronRightIcon, ChevronDownIcon, FolderIcon } from '@heroicons/react/24/outline';
import { useUIStore, type FontFamily } from '../lib/store';
import { extractYearMonthFromPath, extractYearMonthFromFilename } from '../lib/folderStructure';
import { organizeAssets } from '../lib/assetOrganization';
import { useAdaptivePageSize } from '../lib/adaptiveLoading';
import {
  FILE_TYPE_FILTER_OPTIONS,
  normalizeTypeKey,
  formatFileTypeLabel,
} from '../constants/fileTypes';

type GroupBy = 'none' | 'years' | 'months';
type GallerySort = 'mtime' | 'taken_at' | 'filename' | 'size_bytes' | 'none';

const GALLERY_SORT_KEY = 'nazr.gallery.sort';
const GALLERY_ORDER_KEY = 'nazr.gallery.order';
const GALLERY_GROUPBY_KEY = 'nazr.gallery.groupBy';
const GALLERY_FOLDERS_KEY = 'nazr.gallery.showFolders';
const GALLERY_FOLDER_MONTHS_KEY = 'nazr.gallery.showFolderMonths';
const GALLERY_TYPE_KEY = 'nazr.gallery.type';
const GALLERY_EXT_KEY = 'nazr.gallery.ext';
const GALLERY_EXPANDED_YEARS_KEY = 'nazr.gallery.expandedYears';

export default function Gallery() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { pageSize: adaptivePageSize } = useAdaptivePageSize();

  // Resolve sort/order/groupBy from URL first, then fall back to persisted preferences in localStorage.
  const rawSortParam = searchParams.get('sort') as GallerySort | null;
  const rawOrderParam = searchParams.get('order') as 'asc' | 'desc' | null;
  const rawGroupByParam = searchParams.get('groupBy') as GroupBy | null;

  const sortParam: GallerySort = (() => {
    if (rawSortParam) return rawSortParam;
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(GALLERY_SORT_KEY) as GallerySort | null;
        if (stored === 'mtime' || stored === 'taken_at' || stored === 'filename' || stored === 'size_bytes' || stored === 'none') {
          return stored;
        }
      } catch {
        // ignore storage errors
      }
    }
    return 'none';
  })();

  const orderParam: 'asc' | 'desc' = (() => {
    if (rawOrderParam === 'asc' || rawOrderParam === 'desc') return rawOrderParam;
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(GALLERY_ORDER_KEY);
        if (stored === 'asc' || stored === 'desc') {
          return stored;
        }
      } catch {
        // ignore
      }
    }
    return 'desc';
  })();

  const groupByParam: GroupBy = (() => {
    if (rawGroupByParam === 'none' || rawGroupByParam === 'years' || rawGroupByParam === 'months') {
      return rawGroupByParam;
    }
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(GALLERY_GROUPBY_KEY) as GroupBy | null;
        if (stored === 'none' || stored === 'years' || stored === 'months') {
          return stored;
        }
      } catch {
        // ignore
      }
    }
    // Default experience: grouped by years
    return 'years';
  })();
  const personParam = searchParams.get('person');
  const personId = personParam ? parseInt(personParam, 10) : null;

  let typeParam = searchParams.get('type');
  let extParam = searchParams.get('ext');

  // Persisted file-type filter: only used when URL doesn't specify one.
  if (!typeParam && typeof window !== 'undefined') {
    try {
      const storedType = localStorage.getItem(GALLERY_TYPE_KEY);
      if (storedType) {
        typeParam = storedType;
      }
    } catch {
      // ignore
    }
  }
  if (!extParam && typeof window !== 'undefined') {
    try {
      const storedExt = localStorage.getItem(GALLERY_EXT_KEY);
      if (storedExt) {
        extParam = storedExt;
      }
    } catch {
      // ignore
    }
  }
  const normalizedTypeParam = normalizeTypeKey(typeParam);
  const selectedFilterOption = useMemo(
    () => FILE_TYPE_FILTER_OPTIONS.find((opt) => opt.value === normalizedTypeParam) ?? null,
    [normalizedTypeParam]
  );
  const customExtensions = useMemo(() => {
    if (!extParam) return [];
    return extParam
      .split(',')
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext.length > 0);
  }, [extParam]);
  const activeExtensions = useMemo(() => {
    if (selectedFilterOption && selectedFilterOption.extensions.length > 0) {
      return selectedFilterOption.extensions;
    }
    return customExtensions;
  }, [selectedFilterOption, customExtensions]);
  const hasTypeFilter = (selectedFilterOption && selectedFilterOption.extensions.length > 0) || customExtensions.length > 0;
  const dropdownValue = selectedFilterOption ? selectedFilterOption.value : normalizedTypeParam;
  const activeFilterLabel = selectedFilterOption
    ? selectedFilterOption.label
    : customExtensions.length > 0
    ? `Custom: ${customExtensions.map((ext) => `.${ext}`).join(', ')}`
    : null;
  
  const [sort, setSort] = useState<GallerySort>(sortParam);
  const [order, setOrder] = useState<'asc' | 'desc'>(orderParam);
  const [groupBy, setGroupBy] = useState<GroupBy>(groupByParam);
  const [mobileColumns, setMobileColumns] = useState<number>(2); // Default to 2 columns on mobile
  const [showFolders, setShowFolders] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem(GALLERY_FOLDERS_KEY) === 'true';
    } catch {
      return false;
    }
  }); // Toggle for folder view when grouping by years
  const [showFolderMonths, setShowFolderMonths] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem(GALLERY_FOLDER_MONTHS_KEY) === 'true';
    } catch {
      return false;
    }
  });
  // Get years/months font from store
  const yearsMonthsFontFamily = useUIStore((s) => s.yearsMonthsFontFamily);
  const yearsMonthsFontSize = useUIStore((s) => s.yearsMonthsFontSize);
  
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

  // Track which years are expanded - restore from sessionStorage on mount
  const [expandedYears, setExpandedYears] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = sessionStorage.getItem(GALLERY_EXPANDED_YEARS_KEY);
        if (stored) {
          const years = JSON.parse(stored) as string[];
          return new Set(years);
        }
      } catch {
        // ignore storage errors
      }
    }
    return new Set();
  });

  // Persist expanded years to sessionStorage whenever it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const yearsArray = Array.from(expandedYears);
        if (yearsArray.length > 0) {
          sessionStorage.setItem(GALLERY_EXPANDED_YEARS_KEY, JSON.stringify(yearsArray));
        } else {
          sessionStorage.removeItem(GALLERY_EXPANDED_YEARS_KEY);
        }
      } catch {
        // ignore storage errors
      }
    }
  }, [expandedYears]);
  const prioritizeFolderStructure = useUIStore((s) => s.prioritizeFolderStructure);
  const prioritizeFilenameDate = useUIStore((s) => s.prioritizeFilenameDate);
  
  // When organization settings are enabled and sort is 'none', use 'mtime' for backend query
  // This ensures backend returns data roughly sorted by date, which frontend will then refine
  const effectiveSort = useMemo(() => {
    if (sort === 'none' && (prioritizeFolderStructure || prioritizeFilenameDate)) {
      return 'mtime' as const;
    }
    return sort;
  }, [sort, prioritizeFolderStructure, prioritizeFilenameDate]);
  
  const clearTypeFilter = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.delete('type');
    params.delete('ext');
    setSearchParams(params, { replace: true });
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem(GALLERY_TYPE_KEY);
        localStorage.removeItem(GALLERY_EXT_KEY);
      } catch {
        // ignore
      }
    }
  }, [searchParams, setSearchParams]);
  const handleTypeFilterChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams);
      if (!value) {
        params.delete('type');
        params.delete('ext');
        if (typeof window !== 'undefined') {
          try {
            localStorage.removeItem(GALLERY_TYPE_KEY);
            localStorage.removeItem(GALLERY_EXT_KEY);
          } catch {
            // ignore
          }
        }
      } else {
        params.set('type', value);
        const option = FILE_TYPE_FILTER_OPTIONS.find((opt) => opt.value === value);
        if (option && option.extensions.length > 0) {
          params.set('ext', option.extensions.join(','));
          if (typeof window !== 'undefined') {
            try {
              localStorage.setItem(GALLERY_TYPE_KEY, value);
              localStorage.setItem(GALLERY_EXT_KEY, option.extensions.join(','));
            } catch {
              // ignore
            }
          }
        } else {
          params.delete('ext');
          if (typeof window !== 'undefined') {
            try {
              localStorage.setItem(GALLERY_TYPE_KEY, value);
              localStorage.removeItem(GALLERY_EXT_KEY);
            } catch {
              // ignore
            }
          }
        }
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  // Sync URL params on mount and keep localStorage updated
  useEffect(() => {
    if (sortParam !== sort) setSort(sortParam);
    if (orderParam !== order) setOrder(orderParam);
    if (groupByParam !== groupBy) setGroupBy(groupByParam);

    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(GALLERY_SORT_KEY, sortParam);
        localStorage.setItem(GALLERY_ORDER_KEY, orderParam);
        localStorage.setItem(GALLERY_GROUPBY_KEY, groupByParam);
      } catch {
        // ignore
      }
    }
  }, [sortParam, orderParam, groupByParam]);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, fetchPreviousPage, hasPreviousPage, isFetchingPreviousPage, refetch } = useAssetsInfinite({ 
    sort: effectiveSort, 
    order,
    person_id: personId || undefined,
    pageSize: adaptivePageSize,
  });
  
  // Update global fetching state for header indicator
  const setIsFetching = useUIStore((s) => s.setIsFetching);
  const isFetching = isFetchingNextPage || isFetchingPreviousPage;
  useEffect(() => {
    setIsFetching(isFetching);
    // Cleanup: reset fetching state when component unmounts
    return () => {
      setIsFetching(false);
    };
  }, [isFetching, setIsFetching]);
  
  // Monitor asset count changes from stats to auto-refresh gallery
  const { data: stats } = useStats();
  const prevAssetCountRef = useRef<number | null>(null);
  const refetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  useEffect(() => {
    if (!stats?.db?.assets) return;
    
    const currentCount = stats.db?.assets ?? 0;
    const prevCount = prevAssetCountRef.current;
    
    // If count changed, schedule a refetch (debounced)
    if (prevCount !== null && currentCount !== prevCount) {
      // Clear any pending refetch
      if (refetchTimeoutRef.current) {
        clearTimeout(refetchTimeoutRef.current);
      }
      
      // Debounce refetch to avoid rapid updates
      refetchTimeoutRef.current = setTimeout(() => {
        refetch();
        refetchTimeoutRef.current = null;
      }, 1000); // Wait 1 second after change detected
    }
    
    // Update the ref
    prevAssetCountRef.current = currentCount;
    
    // Cleanup timeout on unmount
    return () => {
      if (refetchTimeoutRef.current) {
        clearTimeout(refetchTimeoutRef.current);
      }
    };
  }, [stats?.db?.assets, refetch]);
  
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const yearRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const monthRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const groupedSentinelRef = useRef<HTMLDivElement>(null);

  const handleLoadMore = useCallback(() => {
    if (!isFetchingNextPage) {
      return fetchNextPage();
    }
    return Promise.resolve();
  }, [isFetchingNextPage, fetchNextPage]);

  const handleLoadPrevious = useCallback(() => {
    if (!isFetchingPreviousPage) {
      fetchPreviousPage();
    }
  }, [isFetchingPreviousPage, fetchPreviousPage]);

  const handleAssetsRemoved = useCallback((idOrIds: number | number[]) => {
    setDeletedIds((prev) => {
      const next = new Set(prev);
      const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
      ids.forEach((id) => next.add(id));
      return next;
    });
    setTimeout(() => refetch(), 500);
  }, [refetch]);

  const updateShowFolderMonths = useCallback((value: boolean) => {
    setShowFolderMonths(value);
    if (typeof window !== 'undefined') {
      try {
        if (value) {
          localStorage.setItem(GALLERY_FOLDER_MONTHS_KEY, String(value));
        } else {
          localStorage.removeItem(GALLERY_FOLDER_MONTHS_KEY);
        }
      } catch {
        // ignore storage failures
      }
    }
  }, []);

  const updateShowFolders = useCallback((value: boolean) => {
    // When turning folders off, collapse all expanded folders to avoid deep content jumps
    if (!value) {
      setExpandedYears(new Set());
      // Clear from sessionStorage
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.removeItem(GALLERY_EXPANDED_YEARS_KEY);
        } catch {
          // ignore
        }
      }
      updateShowFolderMonths(false);
    }

    setShowFolders(value);

    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(GALLERY_FOLDERS_KEY, String(value));
      } catch {
        // ignore storage failures
      }
    }

    // When turning folders off, scroll back to the top of the gallery
    if (!value) {
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const absoluteTop = rect.top + window.pageYOffset;
        const target = Math.max(absoluteTop - 16, 0);
        window.scrollTo({ top: target, behavior: 'smooth' });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  }, [updateShowFolderMonths]);
  
  // Filter out deleted items and deduplicate by ID - use useMemo to ensure re-render when deletedIds changes
  const baseItemsRaw = useMemo(() => {
    const allItems = (data?.pages.flatMap((p) => p.items) ?? []).filter(a => !deletedIds.has(a.id));
    // Deduplicate by ID (keep first occurrence)
    const seen = new Set<number>();
    return allItems.filter(asset => {
      if (seen.has(asset.id)) {
        return false;
      }
      seen.add(asset.id);
      return true;
    });
  }, [data, deletedIds]);

  // Apply organization settings to get consistent ordering
  const baseItems = useMemo(() => {
    return organizeAssets(baseItemsRaw, prioritizeFolderStructure, prioritizeFilenameDate, sort, order);
  }, [baseItemsRaw, prioritizeFolderStructure, prioritizeFilenameDate, sort, order]);

  const items = useMemo(() => {
    if (!hasTypeFilter || activeExtensions.length === 0) {
      return baseItems;
    }
    const allowed = new Set(activeExtensions.map((ext) => ext.toLowerCase()));
    return baseItems.filter((asset) => asset.ext && allowed.has(asset.ext.toLowerCase()));
  }, [baseItems, activeExtensions, hasTypeFilter]);


  // Centralized scroll restoration aligned with 2780d9e
  useGalleryScrollRestoration({
    containerRef,
    itemsReady: !!data && items.length > 0,
    locationKey: location.key,
  });

  // Group items by date
  const groupedItems = useMemo(() => {
    if (groupBy === 'none') {
      return null;
    }

    const groups = new Map<string, typeof items>();
    
    items.forEach((asset) => {
      let year: number | null = null;
      let month: number | null = null;

      // Priority 1: If prioritizeFilenameDate is enabled, try to extract from filename first
      if (prioritizeFilenameDate) {
        const filenameDate = extractYearMonthFromFilename(asset.filename);
        if (filenameDate) {
          year = filenameDate.year;
          month = filenameDate.month;
        }
      }

      // Priority 2: If filename didn't provide date and prioritizeFolderStructure is enabled, try to extract from path
      if ((year === null || month === null) && prioritizeFolderStructure) {
        const folderDate = extractYearMonthFromPath(asset.path);
        if (folderDate) {
          year = folderDate.year;
          month = folderDate.month;
        }
      }

      // Priority 3: If neither filename nor folder structure provided date, fall back to metadata
      if (year === null || month === null) {
        // Use taken_at if available, otherwise use mtime_ns
        // taken_at is in seconds (Unix timestamp)
        // mtime_ns is in nanoseconds (seconds * 1_000_000_000 + nanoseconds)
        let timestamp: number;
        if (asset.taken_at && asset.taken_at > 0) {
          // taken_at is in seconds, convert to milliseconds
          timestamp = asset.taken_at * 1000;
        } else if (asset.mtime_ns && asset.mtime_ns > 0) {
          // mtime_ns is in nanoseconds, convert to milliseconds
          // Divide by 1_000_000 to convert nanoseconds to milliseconds
          timestamp = asset.mtime_ns / 1_000_000;
        } else {
          // Skip assets with no valid date
          return;
        }
        
        // Ensure timestamp is reasonable (between 1970 and 2100)
        if (timestamp < 0 || timestamp > 4102444800000) { // Jan 1, 2100 in ms
          return;
        }
        
        const date = new Date(timestamp);
        
        // Validate date
        if (isNaN(date.getTime())) {
          // Skip invalid dates
          return;
        }
        
        year = date.getFullYear();
        month = date.getMonth() + 1;
      }

      // Validate year and month
      if (year === null || month === null || isNaN(year) || year < 1900 || year > 2100 || isNaN(month) || month < 1 || month > 12) {
        // Skip invalid dates
        return;
      }
      
      let groupKey: string;
      if (groupBy === 'years') {
        groupKey = year.toString();
      } else if (groupBy === 'months') {
        // Format: "2024-01" for January 2024
        groupKey = `${year}-${String(month).padStart(2, '0')}`;
      } else {
        return;
      }

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(asset);
    });

    // Sort items within each group using the same organization logic
    // This ensures items within groups are in the same order as AssetDetail navigation
    groups.forEach((groupItems, groupKey) => {
      const sorted = organizeAssets(groupItems, prioritizeFolderStructure, prioritizeFilenameDate, sort, order);
      groups.set(groupKey, sorted);
    });

    // Sort groups based on order parameter
    // For years/months: 'desc' = newest first (2025, 2024, ...), 'asc' = oldest first (2022, 2023, ...)
    const parseGroup = (key: string) => {
      // handle 'YYYY' or 'YYYY-MM'
      const parts = key.split('-');
      const year = parseInt(parts[0], 10);
      const month = parts.length === 2 ? parseInt(parts[1], 10) : null;
      return { year: isNaN(year) ? null : year, month: isNaN(month as any) ? null : month } as { year: number | null; month: number | null };
    };

    const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
      const aKey = a[0];
      const bKey = b[0];
      const aParsed = parseGroup(aKey);
      const bParsed = parseGroup(bKey);

      // If both have valid years, compare years first
      if (aParsed.year !== null && bParsed.year !== null) {
        if (aParsed.year !== bParsed.year) {
          const cmp = aParsed.year - bParsed.year;
          return order === 'asc' ? cmp : -cmp;
        }

        // If grouping by months and both have months, compare months
        if (aParsed.month !== null && bParsed.month !== null) {
          const cmp = aParsed.month - bParsed.month;
          return order === 'asc' ? cmp : -cmp;
        }

        // If months are missing or equal, preserve insertion order (stable)
        return 0;
      }

      // Fallback to string comparison
      const cmp = aKey.localeCompare(bKey);
      return order === 'asc' ? cmp : -cmp;
    });

    return sortedGroups;
  }, [items, groupBy, prioritizeFolderStructure, prioritizeFilenameDate, sort, order]);

  const updateSort = (newSort: typeof sort) => {
    setSort(newSort);
    const params = new URLSearchParams(searchParams);
    params.set('sort', newSort);
    setSearchParams(params, { replace: true });
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(GALLERY_SORT_KEY, newSort);
      } catch {
        // ignore
      }
    }
  };

  const updateOrder = (newOrder: typeof order) => {
    setOrder(newOrder);
    const params = new URLSearchParams(searchParams);
    params.set('order', newOrder);
    setSearchParams(params, { replace: true });
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(GALLERY_ORDER_KEY, newOrder);
      } catch {
        // ignore
      }
    }
  };

  const updateGroupBy = (newGroupBy: GroupBy) => {
    // Clear expanded years when switching away from years grouping
    if (newGroupBy !== 'years' && groupBy === 'years') {
      setExpandedYears(new Set());
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.removeItem(GALLERY_EXPANDED_YEARS_KEY);
        } catch {
          // ignore
        }
      }
    }
    
    setGroupBy(newGroupBy);
    const params = new URLSearchParams(searchParams);
    if (newGroupBy === 'none') {
      params.delete('groupBy');
      setShowFolders(false); // Reset folders toggle when switching away from years
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem(GALLERY_FOLDERS_KEY, 'false');
        } catch {
          // ignore
        }
      }
    } else {
      params.set('groupBy', newGroupBy);
    }
    setSearchParams(params, { replace: true });
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(GALLERY_GROUPBY_KEY, newGroupBy);
      } catch {
        // ignore
      }
    }
  };

  const toggleYearExpanded = useCallback((yearKey: string, event?: React.MouseEvent) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    // Simply toggle the expanded state - let the browser handle scrolling naturally
    // This prevents conflicts and jittery scroll behavior
    setExpandedYears((prev) => {
      const next = new Set(prev);
      if (next.has(yearKey)) {
        next.delete(yearKey);
      } else {
        next.add(yearKey);
      }
      return next;
    });
  }, []);

  // Format group label
  const formatGroupLabel = (key: string) => {
    if (groupBy === 'years') {
      return key;
    } else if (groupBy === 'months') {
      const [year, month] = key.split('-');
      const date = new Date(parseInt(year), parseInt(month) - 1);
      return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
    }
    return key;
  };

  // Get years list for timeline (only when grouping by years)
  const years = useMemo(() => {
    if (groupBy !== 'years' || !groupedItems) {
      return [];
    }
    return groupedItems.map(([year]) => year);
  }, [groupBy, groupedItems]);

  // Get months list for timeline (only when grouping by months)
  const months = useMemo(() => {
    if (groupBy !== 'months' || !groupedItems) {
      return [];
    }
    return groupedItems.map(([month]) => month);
  }, [groupBy, groupedItems]);

  // Handle year click from the floating timeline.
  // When "Folders" are enabled, we treat years as folder containers and should NOT
  // auto-scroll into the expanded content (to avoid jumping to the end of the folder).
  // In that case we simply align the year heading to the top and leave the user in control.
  const handleYearClick = (year: string) => {
    const element = yearRefsMap.current.get(year);
    if (!element) return;

    if (groupBy === 'years' && showFolders) {
      // Only bring the year heading itself into view; avoid jumping deep into the folder.
      const rect = element.getBoundingClientRect();
      const absoluteTop = rect.top + window.pageYOffset;
      const scrollTarget = Math.max(absoluteTop - 80, 0); // small top margin for clarity
      window.scrollTo({ top: scrollTarget, behavior: 'smooth' });
    } else {
      // Original behavior for non-folder views.
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Handle month click - scroll to that month section
  const handleMonthClick = (month: string) => {
    const element = monthRefsMap.current.get(month);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Create a ref callback for year sections
  const setYearRef = (year: string) => (element: HTMLDivElement | null) => {
    if (element) {
      yearRefsMap.current.set(year, element);
    } else {
      yearRefsMap.current.delete(year);
    }
  };

  // Create a ref callback for month sections
  const setMonthRef = (month: string) => (element: HTMLDivElement | null) => {
    if (element) {
      monthRefsMap.current.set(month, element);
    } else {
      monthRefsMap.current.delete(month);
    }
  };

  // Format month label for timeline
  // Escape key to exit person view
  useEffect(() => {
    if (!personId) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        navigate('/people');
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [personId, navigate]);

  const formatMonthLabel = (monthKey: string) => {
    try {
      const parts = monthKey.split('-');
      if (parts.length !== 2) {
        return monthKey; // Fallback to raw key if format is unexpected
      }
      const [year, month] = parts;
      const yearNum = parseInt(year, 10);
      const monthNum = parseInt(month, 10);
      if (isNaN(yearNum) || isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
        return monthKey; // Fallback to raw key if invalid
      }
      const date = new Date(yearNum, monthNum - 1);
      if (isNaN(date.getTime())) {
        return monthKey; // Fallback if date is invalid
      }
      return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
    } catch (error) {
      console.error('Error formatting month label:', error, monthKey);
      return monthKey; // Fallback to raw key on any error
    }
  };

  // Infinite scroll for grouped view (forward) – align with 2780d9e (no reverse paging here)
  useEffect(() => {
    if (groupBy === 'none' || !hasNextPage) return;
    const el = groupedSentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !isFetchingNextPage) {
            fetchNextPage();
          }
        }
      },
      { rootMargin: '800px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [groupBy, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div ref={containerRef} className="container-responsive py-3 sm:py-6 space-y-3 sm:space-y-4">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-2">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 text-xs sm:text-sm sm:ml-auto">
          <label className="flex items-center gap-1 whitespace-nowrap">
            <span className="hidden sm:inline">Group by</span>
            <span className="sm:hidden">Group</span>
            <select value={groupBy} onChange={(e) => updateGroupBy(e.target.value as GroupBy)} className="px-1.5 sm:px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 text-xs sm:text-sm">
              <option value="none">None</option>
              <option value="years">Years</option>
              <option value="months">Months</option>
            </select>
          </label>
          {groupBy === 'years' && (
            <label className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="text-xs sm:text-sm text-zinc-700 dark:text-zinc-300">Folders:</span>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={showFolders}
                  onChange={(e) => updateShowFolders(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-10 h-5 bg-zinc-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-zinc-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-zinc-600 peer-checked:bg-blue-600"></div>
              </label>
            </label>
          )}
          {groupBy === 'years' && showFolders && (
            <label className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="text-xs sm:text-sm text-zinc-700 dark:text-zinc-300">Show Months:</span>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={showFolderMonths}
                  onChange={(e) => updateShowFolderMonths(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-10 h-5 bg-zinc-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-zinc-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-zinc-600 peer-checked:bg-blue-600"></div>
              </label>
            </label>
          )}
          <label className="flex items-center gap-1 whitespace-nowrap">
            Sort
            <select value={sort} onChange={(e) => updateSort(e.target.value as any)} className="px-1.5 sm:px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 text-xs sm:text-sm">
              <option value="none">None</option>
              <option value="mtime">Modified</option>
              <option value="taken_at">Date Taken</option>
              <option value="filename">Filename</option>
              <option value="size_bytes">Size</option>
            </select>
          </label>
          <select 
            value={order} 
            onChange={(e) => updateOrder(e.target.value as any)} 
            className="px-1.5 sm:px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 text-xs sm:text-sm"
          >
            <option value="desc">Desc</option>
            <option value="asc">Asc</option>
          </select>
        <label className="flex items-center gap-1 whitespace-nowrap">
          File type
          <select
            value={dropdownValue || ''}
            onChange={(e) => handleTypeFilterChange(e.target.value)}
            className="px-1.5 sm:px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 text-xs sm:text-sm"
          >
            <option value="">All types</option>
            {FILE_TYPE_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {dropdownValue &&
              dropdownValue.length > 0 &&
              !FILE_TYPE_FILTER_OPTIONS.some((opt) => opt.value === dropdownValue) && (
                <option value={dropdownValue}>{formatFileTypeLabel(dropdownValue)}</option>
              )}
          </select>
        </label>
        </div>
      </div>

    {hasTypeFilter && items.length === 0 && (
      <div className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400">
        No items match the selected file type filter.
      </div>
    )}

      {/* Mobile Grid Slider - only visible on mobile */}
      <div className="sm:hidden flex items-center gap-2.5 py-2 px-1 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
        <Squares2X2Icon className="w-4 h-4 text-zinc-500 dark:text-zinc-400 flex-shrink-0" />
        <input
          type="range"
          min="1"
          max="4"
          step="1"
          value={mobileColumns}
          onChange={(e) => setMobileColumns(Number(e.target.value))}
          className="flex-1 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
          style={{
            background: `linear-gradient(to right, rgb(37 99 235) 0%, rgb(37 99 235) ${((mobileColumns - 1) / 3) * 100}%, rgb(161 161 170) ${((mobileColumns - 1) / 3) * 100}%, rgb(161 161 170) 100%)`
          }}
        />
        <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300 min-w-[3.5rem] text-right">
          {mobileColumns === 1 ? 'Single' : `${mobileColumns} cols`}
        </div>
      </div>

      {groupBy === 'none' ? (
        <GalleryGrid
          mobileColumns={mobileColumns}
          assets={items}
          onLoadMore={handleLoadMore}
          hasMore={!!hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          sort={sort}
          order={order}
          isLoading={!data && !items.length}
          onAssetDeleted={handleAssetsRemoved}
          personId={personId}
        />
      ) : groupedItems ? (
        <>
          {groupBy === 'years' && years.length > 0 && (
            <Timeline
              items={years}
              onItemClick={handleYearClick}
              itemRefsMap={yearRefsMap.current}
            />
          )}
          {groupBy === 'months' && months.length > 0 && (
            <Timeline
              items={months}
              onItemClick={handleMonthClick}
              itemRefsMap={monthRefsMap.current}
              formatLabel={formatMonthLabel}
            />
          )}
          <div className="space-y-8">
            {groupBy === 'years' && showFolders ? (
              // Folder grid view: display folders in a grid
              // Mobile: 2 columns, Desktop: dynamic columns based on number of years
              (() => {
                const yearCount = groupedItems.length;
                // Desktop: calculate columns (min 3, max 6, based on year count)
                const desktopColumns = Math.min(Math.max(3, Math.ceil(yearCount / 2)), 6);
                const gridId = `folder-grid-${desktopColumns}`;
                
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
                      {groupedItems.map(([groupKey, groupItems]) => {
                        const isExpanded = expandedYears.has(groupKey);
                        const monthGroups = showFolderMonths
                          ? buildFolderMonthGroups(
                              groupItems,
                              groupKey,
                              prioritizeFolderStructure,
                              prioritizeFilenameDate,
                              order,
                            )
                          : null;
                        return (
                          <Fragment key={groupKey}>
                            <div
                              ref={setYearRef(groupKey)}
                              className="space-y-2"
                            >
                              {/* Folder card */}
                              <div
                                onClick={(e) => toggleYearExpanded(groupKey, e)}
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
                                    className={`${getFontSizeClass(yearsMonthsFontSize)} font-semibold text-zinc-900 dark:text-zinc-100 flex-1 min-w-0`}
                                    style={{ fontFamily: getFontFamilyValue(yearsMonthsFontFamily) }}
                                  >
                                    {formatGroupLabel(groupKey)}
                                  </h2>
                                </div>
                                <span className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400">
                                  {groupItems.length} {groupItems.length === 1 ? 'photo' : 'photos'}
                                </span>
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
                                {showFolderMonths && monthGroups
                                  ? (
                                    <div className="space-y-4">
                                      {monthGroups.map(([monthKey, monthAssets]) => (
                                        <div key={`${groupKey}-${monthKey}`} className="space-y-2">
                                          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                                            {formatMonthLabel(monthKey)}
                                          </h3>
                                          <GalleryGrid
                                            assets={monthAssets}
                                            onLoadMore={undefined}
                                            hasMore={false}
                                            sort={sort}
                                            order={order}
                                            isLoading={false}
                                            mobileColumns={mobileColumns}
                                            onAssetDeleted={handleAssetsRemoved}
                                            personId={personId}
                                            filteredAssetIdsOverride={monthAssets.map(asset => asset.id)}
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <GalleryGrid
                                      assets={groupItems}
                                      onLoadMore={undefined}
                                      hasMore={false}
                                      sort={sort}
                                      order={order}
                                      isLoading={false}
                                      mobileColumns={mobileColumns}
                                      onAssetDeleted={handleAssetsRemoved}
                                      personId={personId}
                                      filteredAssetIdsOverride={groupItems.map(asset => asset.id)}
                                    />
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
            ) : (
              // Normal list view
              groupedItems.map(([groupKey, groupItems]) => {
                const isExpanded = expandedYears.has(groupKey);
                const isYearGroup = groupBy === 'years';
                const showAsFolder = isYearGroup && showFolders;
                const monthGroups = showFolderMonths && showAsFolder
                  ? buildFolderMonthGroups(
                      groupItems,
                      groupKey,
                      prioritizeFolderStructure,
                      prioritizeFilenameDate,
                      order,
                    )
                  : null;
                
                return (
                  <div
                    key={groupKey}
                    ref={groupBy === 'years' ? setYearRef(groupKey) : groupBy === 'months' ? setMonthRef(groupKey) : undefined}
                    className="space-y-4"
                  >
                    {showAsFolder ? (
                      // Folder view: clickable folder header
                      <div
                        onClick={() => toggleYearExpanded(groupKey)}
                        className="flex items-center gap-2 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg p-2 -ml-2 transition-colors"
                      >
                        {isExpanded ? (
                          <ChevronDownIcon className="w-5 h-5 text-zinc-600 dark:text-zinc-400 flex-shrink-0" />
                        ) : (
                          <ChevronRightIcon className="w-5 h-5 text-zinc-600 dark:text-zinc-400 flex-shrink-0" />
                        )}
                        <FolderIcon className="w-6 h-6 text-blue-500 dark:text-blue-400 flex-shrink-0" />
                        <h2 
                          className={`${getFontSizeClass(yearsMonthsFontSize)} font-semibold text-zinc-900 dark:text-zinc-100`}
                          style={{ fontFamily: getFontFamilyValue(yearsMonthsFontFamily) }}
                        >
                          {formatGroupLabel(groupKey)}
                        </h2>
                        <span className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 ml-auto">
                          {groupItems.length} {groupItems.length === 1 ? 'photo' : 'photos'}
                        </span>
                      </div>
                    ) : (
                      // Normal view: regular heading
                      <h2 
                        className={`${getFontSizeClass(yearsMonthsFontSize)} font-semibold text-zinc-900 dark:text-zinc-100 border-b border-zinc-200 dark:border-zinc-800 pb-1.5 sm:pb-2`}
                        style={{ fontFamily: getFontFamilyValue(yearsMonthsFontFamily) }}
                      >
                        {formatGroupLabel(groupKey)}
                      </h2>
                    )}
                    {(!showAsFolder || isExpanded) && (
                      showFolderMonths && monthGroups ? (
                        <div className="space-y-4">
                          {monthGroups.map(([monthKey, monthAssets]) => (
                            <div key={`${groupKey}-${monthKey}`} className="space-y-2">
                              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                                {formatMonthLabel(monthKey)}
                              </h3>
                              <GalleryGrid
                                assets={monthAssets}
                                onLoadMore={undefined}
                                hasMore={false}
                                sort={sort}
                                order={order}
                                isLoading={false}
                                mobileColumns={mobileColumns}
                                onAssetDeleted={handleAssetsRemoved}
                                personId={personId}
                                filteredAssetIdsOverride={showAsFolder ? monthAssets.map(asset => asset.id) : undefined}
                              />
                            </div>
                          ))}
                        </div>
                      ) : (
                        <GalleryGrid
                          assets={groupItems}
                          onLoadMore={undefined}
                          hasMore={false}
                          sort={sort}
                          order={order}
                          isLoading={false}
                          mobileColumns={mobileColumns}
                          onAssetDeleted={handleAssetsRemoved}
                          personId={personId}
                          filteredAssetIdsOverride={showAsFolder ? groupItems.map(asset => asset.id) : undefined}
                        />
                      )
                    )}
                  </div>
                );
              })
            )}
          </div>
          {/* Sentinel for infinite scroll when grouping is enabled */}
          {hasNextPage && <div ref={groupedSentinelRef} className="h-10" />}
        </>
      ) : null}
    </div>
  );
}

type DateParts = { year: number | null; month: number | null };

function inferAssetYearMonth(
  asset: Asset,
  prioritizeFolderStructure: boolean,
  prioritizeFilenameDate: boolean,
): DateParts {
  let year: number | null = null;
  let month: number | null = null;

  if (prioritizeFilenameDate) {
    const filenameDate = extractYearMonthFromFilename(asset.filename);
    if (filenameDate) {
      year = filenameDate.year;
      month = filenameDate.month;
    }
  }

  if ((year === null || month === null) && prioritizeFolderStructure) {
    const folderDate = extractYearMonthFromPath(asset.path);
    if (folderDate) {
      if (year === null) year = folderDate.year;
      if (month === null) month = folderDate.month;
    }
  }

  const applyTimestamp = (timestamp: number | undefined, type: 'seconds' | 'nanoseconds') => {
    if (!timestamp) return;
    const date = type === 'seconds' ? new Date(timestamp * 1000) : new Date(timestamp / 1_000_000);
    if (Number.isNaN(date.getTime())) return;
    if (year === null) year = date.getFullYear();
    if (month === null) month = date.getMonth() + 1;
  };

  if (year === null || month === null) {
    applyTimestamp(asset.taken_at, 'seconds');
  }
  if (year === null || month === null) {
    applyTimestamp(asset.mtime_ns, 'nanoseconds');
  }

  if (month !== null) {
    month = Math.min(12, Math.max(1, month));
  }

  return { year, month };
}

function buildFolderMonthGroups(
  assets: Asset[],
  yearKey: string,
  prioritizeFolderStructure: boolean,
  prioritizeFilenameDate: boolean,
  order: 'asc' | 'desc',
): Array<[string, Asset[]]> {
  const fallbackYear = Number.isFinite(parseInt(yearKey, 10)) ? parseInt(yearKey, 10) : null;
  const groups = new Map<string, Asset[]>();

  assets.forEach((asset) => {
    const parts = inferAssetYearMonth(asset, prioritizeFolderStructure, prioritizeFilenameDate);
    const resolvedYear = parts.year ?? fallbackYear;
    const resolvedMonth = parts.month ?? 1;
    const yearPrefix = resolvedYear ?? 'unknown';
    const key = `${yearPrefix}-${resolvedMonth}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(asset);
  });

  const sortValue = (key: string) => {
    const [yr, mo] = key.split('-');
    const yearNum = parseInt(yr, 10);
    const monthNum = parseInt(mo, 10);
    if (Number.isNaN(yearNum) || Number.isNaN(monthNum)) return Number.MIN_SAFE_INTEGER;
    return yearNum * 100 + monthNum;
  };

  return Array.from(groups.entries()).sort((a, b) => {
    const delta = sortValue(a[0]) - sortValue(b[0]);
    return order === 'desc' ? -delta : delta;
  });
}

