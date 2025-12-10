import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api';
import { DEFAULT_PAGE_SIZE, STATS_POLL_MS } from './config';
import type { Asset, Paginated, Stats, SearchResult } from '../types';

// Configure QueryClient with retry logic and better error handling
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retry on network errors with exponential backoff
      retry: (failureCount, error: any) => {
        // Don't retry on connection refused (backend not running)
        if (error instanceof Error && (
          error.message.includes('ERR_CONNECTION_REFUSED') ||
          error.message.includes('Failed to fetch') ||
          error.message.includes('Cannot connect')
        )) {
          return false;
        }
        // Don't retry on 4xx errors (client errors)
        if (error instanceof Error && error.message.includes('HTTP 4')) {
          return false;
        }
        // Only retry once for network errors to reduce noise
        return failureCount < 1;
      },
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      // Refetch on window focus for better recovery
      refetchOnWindowFocus: true,
      // Don't show stale data for too long
      staleTime: 3000,
      // Allow cache to be garbage collected quickly to keep memory low
      gcTime: 30 * 1000,
      // Keep previous data while refetching to avoid flicker
      placeholderData: (previousData) => previousData,
    },
  },
});
export const QueryProvider = QueryClientProvider;

export function usePageVisibility() {
  const [isVisible, setIsVisible] = useState(() => {
    if (typeof document === 'undefined') return true;
    return !document.hidden;
  });

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibility = () => setIsVisible(!document.hidden);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  return isVisible;
}

export function useStats() {
  const isVisible = usePageVisibility();
  return useQuery<Stats>({
    queryKey: ['stats'],
    queryFn: api.stats,
    enabled: isVisible,
    refetchInterval: (query) => {
      if (!isVisible || query.state.error) return false;
      return STATS_POLL_MS;
    },
    retry: 1, // Reduce retries
  });
}

export function useAssetsInfinite(params: {
  sort?: 'mtime' | 'taken_at' | 'filename' | 'size_bytes' | 'none';
  order?: 'asc' | 'desc';
  pageSize?: number;
  person_id?: number;
  enabled?: boolean;
}) {
  const isVisible = usePageVisibility();
  const { enabled: enabledInput, ...queryParams } = params;
  const pageSize = queryParams.pageSize ?? DEFAULT_PAGE_SIZE;
  const enabled = (enabledInput ?? true) && isVisible;
  return useInfiniteQuery<Paginated<Asset>>({
    // Exclude the `enabled` flag from the cache key so different
    // callers (Gallery vs. AssetDetail) with the same logical
    // parameters share the same data.
    queryKey: ['assets', queryParams],
    initialPageParam: 0,
    enabled,
    staleTime: 5_000,
    gcTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: ({ pageParam }) =>
      api.assets({
        offset: pageParam as number,
        limit: pageSize,
        sort: queryParams.sort,
        order: queryParams.order,
        person_id: queryParams.person_id,
      }),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((acc, p) => acc + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    getPreviousPageParam: (firstPage, allPages) => {
      // With offset-based pagination, we start at offset 0
      // The first page in allPages (index 0) was loaded with initialPageParam (0)
      // When we fetch previous pages, they get prepended, so the first page changes
      
      // Calculate the offset of the first page in allPages
      // If allPages.length === 1, we only have the initial page at offset 0
      if (allPages.length === 1) {
        return undefined; // Can't go back from offset 0
      }
      
      // Calculate cumulative offset up to (but not including) the first page
      // This tells us what offset the first page is at
      let firstPageOffset = 0;
      for (let i = 0; i < allPages.length - 1; i++) {
        firstPageOffset += allPages[i].items.length;
      }
      
      // If first page is at offset 0, we can't go back
      if (firstPageOffset <= 0) {
        return undefined;
      }
      
      // Calculate the previous page offset (one pageSize before the first page)
      const previousOffset = Math.max(0, firstPageOffset - pageSize);
      return previousOffset;
    },
  });
}

export function useSearchInfinite(params: {
  q: string;
  from?: string;
  to?: string;
  camera_make?: string;
  camera_model?: string;
  platformType?: string;
  pageSize?: number;
  enabled?: boolean;
}) {
  const isVisible = usePageVisibility();
  const { enabled: enabledInput, ...queryParams } = params;
  const pageSize = queryParams.pageSize ?? DEFAULT_PAGE_SIZE;
  const enabled = (enabledInput ?? true) && isVisible;
  return useInfiniteQuery<SearchResult>({
    // Exclude `enabled` from the cache key so Search and
    // AssetDetail share the same search result pages when
    // their logical parameters match.
    queryKey: ['search', queryParams],
    initialPageParam: 0,
    enabled: enabled && !!queryParams.q,
    staleTime: 5_000,
    gcTime: 30_000,
    refetchOnWindowFocus: false,
    queryFn: ({ pageParam }) =>
      api.search({ ...queryParams, offset: pageParam as number, limit: pageSize }),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((acc, p) => acc + p.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });
}

