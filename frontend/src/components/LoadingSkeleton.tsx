export function AssetCardSkeleton() {
  return (
    <div className="rounded-md overflow-hidden bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/60 dark:border-zinc-800 animate-pulse">
      <div className="aspect-[4/3] bg-zinc-200 dark:bg-zinc-700" />
      <div className="p-2 space-y-1">
        <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded w-3/4" />
      </div>
    </div>
  );
}

export function GalleryGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
      {Array.from({ length: count }).map((_, i) => (
        <AssetCardSkeleton key={i} />
      ))}
    </div>
  );
}

export function StatCardSkeleton() {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 bg-white dark:bg-zinc-900 animate-pulse">
      <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded w-1/2 mb-2" />
      <div className="h-6 bg-zinc-200 dark:bg-zinc-700 rounded w-3/4" />
    </div>
  );
}

export function MetadataPanelSkeleton() {
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 divide-y divide-zinc-200 dark:divide-zinc-700 animate-pulse">
      <div className="p-3 space-y-2">
        <div className="h-4 bg-zinc-200 dark:bg-zinc-700 rounded w-1/3" />
        <div className="grid grid-cols-2 gap-2">
          <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded" />
          <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded" />
          <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded" />
          <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded" />
        </div>
      </div>
    </div>
  );
}

