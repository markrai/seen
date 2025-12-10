import type { Asset, SortField, SortOrder } from '../types';
import { extractYearMonthFromPath, extractYearMonthFromFilename } from './folderStructure';

/**
 * Extracts a sortable timestamp from an asset using the priority order:
 * 1. Filename date (if prioritizeFilenameDate is enabled)
 * 2. Folder structure date (if prioritizeFolderStructure is enabled)
 * 3. Metadata dates (taken_at or mtime_ns), with priority based on the selected sort field
 *
 * @param asset - The asset to extract date from
 * @param prioritizeFilenameDate - Whether to prioritize filename dates
 * @param prioritizeFolderStructure - Whether to prioritize folder structure dates
 * @param sort - Current sort field ('none' | 'mtime' | 'taken_at' | ...)
 * @returns Timestamp in milliseconds, or null if no valid date found
 */
function extractSortableDate(
  asset: Asset,
  prioritizeFilenameDate: boolean,
  prioritizeFolderStructure: boolean,
  sort: SortField = 'none'
): number | null {
  // Priority 1: Filename date
  if (prioritizeFilenameDate) {
    const filenameDate = extractYearMonthFromFilename(asset.filename);
    if (filenameDate) {
      // Create a timestamp for the first day of that month
      // This ensures consistent sorting within the same month
      const date = new Date(filenameDate.year, filenameDate.month - 1, 1);
      if (!isNaN(date.getTime())) {
        return date.getTime();
      }
    }
  }

  // Priority 2: Folder structure date
  if (prioritizeFolderStructure) {
    const folderDate = extractYearMonthFromPath(asset.path);
    if (folderDate) {
      // Create a timestamp for the first day of that month
      const date = new Date(folderDate.year, folderDate.month - 1, 1);
      if (!isNaN(date.getTime())) {
        return date.getTime();
      }
    }
  }

  // Priority 3: Metadata dates
  // Adjust priority based on the requested sort field so that
  // "Modified" and "Date Taken" behave as expected.
  const timestamps: number[] = [];

  const pushTakenAt = () => {
    if (asset.taken_at && asset.taken_at > 0) {
      timestamps.push(asset.taken_at * 1000); // seconds -> ms
    }
  };

  const pushMtime = () => {
    if (asset.mtime_ns && asset.mtime_ns > 0) {
      timestamps.push(asset.mtime_ns / 1_000_000); // ns -> ms
    }
  };

  if (sort === 'mtime') {
    // For "Modified", prefer mtime, then taken_at
    pushMtime();
    pushTakenAt();
  } else if (sort === 'taken_at') {
    // For "Date Taken", prefer taken_at, then mtime
    pushTakenAt();
    pushMtime();
  } else {
    // For "none" or other values, keep previous behavior:
    // prefer taken_at, then mtime
    pushTakenAt();
    pushMtime();
  }

  for (const timestamp of timestamps) {
    if (timestamp >= 0 && timestamp <= 4102444800000) {
      return timestamp;
    }
  }

  return null;
}

/**
 * Organizes/sorts assets by applying folder structure and filename date prioritization
 * for date-based views, while still respecting non-date sort fields when organization
 * settings are disabled.
 *
 * @param assets - Array of assets to organize
 * @param prioritizeFolderStructure - Whether to prioritize folder structure dates
 * @param prioritizeFilenameDate - Whether to prioritize filename dates
 * @param sort - Sort field
 * @param order - Sort order ('asc' or 'desc')
 * @returns Organized and sorted array of assets
 */
export function organizeAssets(
  assets: Asset[],
  prioritizeFolderStructure: boolean,
  prioritizeFilenameDate: boolean,
  sort: SortField = 'none',
  order: SortOrder = 'desc'
): Asset[] {
  if (!assets.length) return assets;

  const isDateSort = sort === 'none' || sort === 'mtime' || sort === 'taken_at';
  const shouldOrganizeByDate =
    isDateSort && (prioritizeFolderStructure || prioritizeFilenameDate);

  // If sort is "none" AND no organization settings, return assets in their original order
  if (sort === 'none' && !shouldOrganizeByDate) {
    return assets;
  }

  // When organization settings are disabled and a non-date sort field is selected,
  // respect the explicit sort choice (e.g. filename, size_bytes) without applying
  // additional date-based organization.
  if (!shouldOrganizeByDate && (sort === 'filename' || sort === 'size_bytes')) {
    const sorted = [...assets];
    sorted.sort((a, b) => {
      let cmp = 0;
      if (sort === 'filename') {
        const aName = a.filename.toLocaleLowerCase();
        const bName = b.filename.toLocaleLowerCase();
        if (aName < bName) cmp = -1;
        else if (aName > bName) cmp = 1;
        else cmp = 0;
      } else if (sort === 'size_bytes') {
        const aSize = a.size_bytes ?? 0;
        const bSize = b.size_bytes ?? 0;
        cmp = aSize - bSize;
      }
      return order === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }

  // Date-based organization path. This is used when:
  // - Organization settings are enabled, OR
  // - A date-based sort field is selected (mtime/taken_at/none)
  const assetsWithDates = assets.map((asset) => ({
    asset,
    date: extractSortableDate(asset, prioritizeFilenameDate, prioritizeFolderStructure, sort),
  }));

  // Separate assets with valid dates from those without
  const withDates = assetsWithDates.filter((item) => item.date !== null);
  const withoutDates = assetsWithDates.filter((item) => item.date === null);

  // Sort assets with dates
  const sortedWithDates = withDates.sort((a, b) => {
    if (a.date === null || b.date === null) return 0;
    const diff = a.date - b.date;
    return order === 'asc' ? diff : -diff;
  });

  // For assets without dates, fall back to original sort order
  // (they'll be appended at the end)
  const sortedWithoutDates = withoutDates.map((item) => item.asset);

  // Combine: assets with dates (sorted) + assets without dates (in original order)
  return sortedWithDates.map((item) => item.asset).concat(sortedWithoutDates);
}

