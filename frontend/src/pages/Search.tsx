import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSearchInfinite } from '../lib/hooks';
import GalleryGrid from '../components/GalleryGrid';
import AdvancedFilters, { type AdvancedFilters as AdvancedFiltersType } from '../components/AdvancedFilters';
import type { Asset } from '../types';
import { useAdaptivePageSize } from '../lib/adaptiveLoading';

export default function SearchPage() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const { pageSize: adaptivePageSize } = useAdaptivePageSize();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const filenameSectionRef = useRef<HTMLHeadingElement>(null);
  const dirnameSectionRef = useRef<HTMLHeadingElement>(null);
  const pathSectionRef = useRef<HTMLHeadingElement>(null);
  const [filters, setFilters] = useState<AdvancedFiltersType>({
    from: params.get('from') || undefined,
    to: params.get('to') || undefined,
    camera_make: params.get('camera_make') || undefined,
    camera_model: params.get('camera_model') || undefined,
    minSize: params.get('minSize') ? Number(params.get('minSize')) : undefined,
    maxSize: params.get('maxSize') ? Number(params.get('maxSize')) : undefined,
    fileTypes: params.get('fileTypes')?.split(',') || undefined,
    platformType: params.get('platformType') || undefined,
  });

  // Keep local filters state in sync with URL query params so that
  // advanced filters stay consistent when the search box or navigation
  // changes the URL outside of the AdvancedFilters component.
  useEffect(() => {
    setFilters({
      from: params.get('from') || undefined,
      to: params.get('to') || undefined,
      camera_make: params.get('camera_make') || undefined,
      camera_model: params.get('camera_model') || undefined,
      minSize: params.get('minSize') ? Number(params.get('minSize')) : undefined,
      maxSize: params.get('maxSize') ? Number(params.get('maxSize')) : undefined,
      fileTypes: params.get('fileTypes')?.split(',') || undefined,
      platformType: params.get('platformType') || undefined,
    });
  }, [search, params]);

  const qParams = {
    q: params.get('q') || '',
    from: params.get('from') || undefined,
    to: params.get('to') || undefined,
    camera_make: params.get('camera_make') || undefined,
    camera_model: params.get('camera_model') || undefined,
    platformType: params.get('platformType') || undefined,
    pageSize: adaptivePageSize,
  };
  const rq = useSearchInfinite(qParams);
  const [deletedIds, setDeletedIds] = useState<Set<number>>(new Set());
  const allItems = (rq.data?.pages.flatMap((p) => p.items) ?? []).filter(a => !deletedIds.has(a.id));
  
  // Get match counts from the first page (they're the same across all pages)
  const matchCounts = rq.data?.pages[0]?.match_counts;

  // Helper function to determine match type (mirrors backend priority logic)
  const getMatchType = useCallback((asset: Asset, query: string): 'filename' | 'dirname' | 'path' => {
    if (!query) return 'path';
    const lowerQuery = query.toLowerCase();
    // Check filename first (priority 1)
    if (asset.filename.toLowerCase().includes(lowerQuery)) {
      return 'filename';
    }
    // Then check dirname (priority 2)
    if (asset.dirname.toLowerCase().includes(lowerQuery)) {
      return 'dirname';
    }
    // Finally check path (priority 3) - only if actually in path
    if (asset.path.toLowerCase().includes(lowerQuery)) {
      return 'path';
    }
    // If FTS5 matched but we can't find it in filename, dirname, or path,
    // it might be a tokenization issue - default to path for now
    return 'path';
  }, []);

  // Client-side filtering for size and file type
  const filteredItems = useMemo(() => {
    return allItems.filter((item: Asset) => {
      // Size filter
      if (filters.minSize && item.size_bytes < filters.minSize) return false;
      if (filters.maxSize && item.size_bytes > filters.maxSize) return false;

      // File type filter
      if (filters.fileTypes && filters.fileTypes.length > 0) {
        const matchesType = filters.fileTypes.some((type) => {
          if (type.includes('/')) {
            return item.mime.startsWith(type);
          }
          return item.mime.includes(type);
        });
        if (!matchesType) return false;
      }

      return true;
    });
  }, [allItems, filters.minSize, filters.maxSize, filters.fileTypes]);

  // Group filtered items by match type
  const groupedResults = useMemo(() => {
    if (!qParams.q) {
      // If no query, return single group with all items
      return [{ type: 'path' as const, items: filteredItems }];
    }

    const trimmedQuery = qParams.q.trim();
    const hasWildcards = trimmedQuery.includes('*') || trimmedQuery.includes('?');
    let hasTextTerms = false;
    let textOnlyQuery = trimmedQuery;

    if (hasWildcards) {
      const tokens = trimmedQuery.split(/\s+/);
      const textTokens = tokens.filter((t) => !t.includes('*') && !t.includes('?'));
      hasTextTerms = textTokens.length > 0;
      textOnlyQuery = textTokens.join(' ');
    }

    // For pure wildcard queries (e.g. "*.jpg", "*.*"), the backend handles
    // all matching logic. Client-side substring checks would incorrectly
    // drop results because filenames/paths don't literally contain "*".
    // In this case, just show all filtered items in a single group.
    if (hasWildcards && !hasTextTerms) {
      return [{ type: 'filename' as const, items: filteredItems }];
    }

    const groups: { type: 'filename' | 'dirname' | 'path'; items: Asset[] }[] = [
      { type: 'filename', items: [] },
      { type: 'dirname', items: [] },
      { type: 'path', items: [] },
    ];

    // When both text and wildcard patterns are present (e.g. "vacation *.jpg"),
    // use only the text portion for grouping logic. Wildcards are already
    // enforced server-side via filename GLOB filters.
    const groupingQuery = hasWildcards && hasTextTerms ? textOnlyQuery : trimmedQuery;

    filteredItems.forEach((item) => {
      const matchType = getMatchType(item, groupingQuery);
      // Only add to group if we actually found a match in one of the fields
      // If FTS5 matched but we can't find it in filename/dirname/path, skip it
      // (This handles FTS5 tokenization edge cases)
      if (matchType === 'path') {
        // Double-check that path actually contains the query
        const lowerQuery = groupingQuery.toLowerCase();
        if (item.path.toLowerCase().includes(lowerQuery)) {
          const group = groups.find(g => g.type === 'path');
          if (group) {
            group.items.push(item);
          }
        }
        // If path doesn't contain query, skip this item (FTS5 false positive)
      } else {
        const group = groups.find(g => g.type === matchType);
        if (group) {
          group.items.push(item);
        }
      }
    });

    // Return only groups that have items, maintaining order: filename, dirname, path
    return groups.filter(g => g.items.length > 0);
  }, [filteredItems, qParams.q, getMatchType]);

  // Extract unique cameras and models from all items
  const availableCameras = useMemo(() => {
    const cameras = new Set<string>();
    allItems.forEach((item: Asset) => {
      if (item.camera_make) cameras.add(item.camera_make);
    });
    return Array.from(cameras).sort();
  }, [allItems]);

  const availableModels = useMemo(() => {
    const models = new Set<string>();
    allItems.forEach((item: Asset) => {
      if (item.camera_model && (!filters.camera_make || item.camera_make === filters.camera_make)) {
        models.add(item.camera_model);
      }
    });
    return Array.from(models).sort();
  }, [allItems, filters.camera_make]);

  const handleFiltersChange = useCallback((newFilters: AdvancedFiltersType) => {
    setFilters(newFilters);
    // Auto-apply server-side filters, client-side will be applied in filteredItems
    const p = new URLSearchParams();
    const q = params.get('q');
    if (q) p.set('q', q);
    if (newFilters.from) p.set('from', newFilters.from);
    if (newFilters.to) p.set('to', newFilters.to);
    if (newFilters.camera_make) p.set('camera_make', newFilters.camera_make);
    if (newFilters.camera_model) p.set('camera_model', newFilters.camera_model);
    if (newFilters.minSize) p.set('minSize', String(newFilters.minSize));
    if (newFilters.maxSize) p.set('maxSize', String(newFilters.maxSize));
    if (newFilters.fileTypes && newFilters.fileTypes.length > 0) {
      p.set('fileTypes', newFilters.fileTypes.join(','));
    }
    if (newFilters.platformType) p.set('platformType', newFilters.platformType);
    navigate(`/search?${p.toString()}`);
  }, [params, navigate]);

  const handleFiltersClear = useCallback(() => {
    const p = new URLSearchParams();
    const q = params.get('q');
    if (q) p.set('q', q);
    navigate(`/search?${p.toString()}`);
  }, [params, navigate]);

  const scrollToSection = useCallback((type: 'filename' | 'dirname' | 'path') => {
    const ref = type === 'filename' ? filenameSectionRef : type === 'dirname' ? dirnameSectionRef : pathSectionRef;
    if (ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  return (
    <div className="container-responsive py-6 space-y-4">
      <AdvancedFilters
        value={filters}
        onChange={handleFiltersChange}
        onClear={handleFiltersClear}
        availableCameras={availableCameras}
        availableModels={availableModels}
      />

      {filteredItems.length !== allItems.length && (
        <div className="text-sm text-zinc-500">
          Showing {filteredItems.length} of {allItems.length} results
        </div>
      )}

      {qParams.q && groupedResults.length > 0 && (
        <div className="flex justify-end">
          <div className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-400 space-x-3">
            {groupedResults.map((group) => {
              const totalCount = matchCounts ? (
                group.type === 'filename' ? matchCounts.filename :
                group.type === 'dirname' ? matchCounts.dirname :
                matchCounts.path
              ) : null;
              const displayCount = totalCount !== null ? totalCount : group.items.length;
              
              return (
                <button
                  key={group.type}
                  onClick={() => scrollToSection(group.type)}
                  className="hover:text-blue-600 dark:hover:text-blue-400 hover:underline cursor-pointer transition-colors"
                >
                  {group.type === 'filename' && `In Filename (${displayCount})`}
                  {group.type === 'dirname' && `In Directory (${displayCount})`}
                  {group.type === 'path' && `In Path (${displayCount})`}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {groupedResults.map((group, idx) => (
        <div key={group.type} className="space-y-4">
          {qParams.q && (
            <h2 
              ref={group.type === 'filename' ? filenameSectionRef : group.type === 'dirname' ? dirnameSectionRef : pathSectionRef}
              className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 border-b border-zinc-200 dark:border-zinc-800 pb-2"
            >
              {(() => {
                const totalCount = matchCounts ? (
                  group.type === 'filename' ? matchCounts.filename :
                  group.type === 'dirname' ? matchCounts.dirname :
                  matchCounts.path
                ) : null;
                const displayCount = totalCount !== null ? totalCount : group.items.length;
                
                return (
                  <>
                    {group.type === 'filename' && `In Filename (${displayCount})`}
                    {group.type === 'dirname' && `In Directory (${displayCount})`}
                    {group.type === 'path' && `In Path (${displayCount})`}
                  </>
                );
              })()}
            </h2>
          )}
          <GalleryGrid
            assets={group.items}
            onLoadMore={idx === groupedResults.length - 1 ? () => rq.hasNextPage && rq.fetchNextPage() : undefined}
            hasMore={idx === groupedResults.length - 1 ? !!rq.hasNextPage : false}
            isLoading={!rq.data && !filteredItems.length}
            onAssetDeleted={(idOrIds) => {
              setDeletedIds(prev => {
                const next = new Set(prev);
                const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
                ids.forEach(id => next.add(id));
                return next;
              });
              setTimeout(() => rq.refetch(), 500);
            }}
          />
        </div>
      ))}
    </div>
  );
}

