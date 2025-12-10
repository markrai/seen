export interface Asset {
  id: number;
  path: string;
  dirname: string;
  filename: string;
  ext: string;
  size_bytes: number;
  mtime_ns: number;
  ctime_ns: number;
  sha256?: string;
  xxh64?: number;
  taken_at?: number;
  width?: number;
  height?: number;
  duration_ms?: number;
  camera_make?: string;
  camera_model?: string;
  lens_model?: string;
  iso?: number;
  fnumber?: number;
  exposure?: number;
  video_codec?: string;
  mime: string;
  flags: number;
}

export interface Paginated<T> {
  total: number;
  items: T[];
}

export interface SearchMatchCounts {
  filename: number;
  dirname: number;
  path: number;
}

export interface SearchResult extends Paginated<Asset> {
  match_counts?: SearchMatchCounts;
}

export interface QueuesStats {
  discover: number;
  hash: number;
  metadata: number;
  db_write: number;
  thumb: number;
}

export interface ProcessedStats {
  files_total: number;
  files_per_sec: number;
  bytes_total?: number;
  bytes_per_sec?: number;
  mb_per_sec?: number;
}

export interface DiscoveryStats {
  files_discovered?: number;
  rate_files_per_sec?: number;
}

export interface ProcessingStats {
  files_committed?: number;
  bytes_total?: number;
  rate_files_per_sec?: number;
  throughput_mb_per_sec?: number;
  last_completed_elapsed_seconds?: number;
}

export interface CurrentProcessingStats {
  files_committed?: number;
  elapsed_seconds?: number;
  processing_rate_files_per_sec?: number;
}

export interface CurrentScanStats {
  files_discovered?: number;
  files_processed?: number;
  files_per_sec?: number;
  elapsed_seconds?: number;
  status?: string;
}

export interface CompletionStats {
  percentage: number;
}

export type FileTypesResponse = Record<string, number | string[] | Record<string, number>>;

export interface DbStats {
  assets: number;
}

export interface Stats {
  uptime_seconds: number;
  queues: QueuesStats;
  processed: ProcessedStats;
  scan_running?: boolean;
  processing_active?: boolean;
  discovery?: DiscoveryStats;
  processing?: ProcessingStats;
  current_processing?: CurrentProcessingStats;
  current_scan?: CurrentScanStats | null;
  completion?: CompletionStats;
  db: DbStats;
}

export type SortField = 'mtime' | 'taken_at' | 'filename' | 'size_bytes' | 'none';
export type SortOrder = 'asc' | 'desc';

export interface DeleteResponse {
  success: boolean;
  error?: string;
}

export interface PermanentDeleteResponse extends DeleteResponse {
  deleted_from_disk?: boolean;
  read_only?: boolean;
  path?: string | null;
}

export interface BulkPermanentDeleteResult {
  id: number;
  deleted: boolean;
  read_only: boolean;
  path?: string | null;
  error?: string | null;
}

export interface BulkPermanentDeleteResponse {
  success: boolean;
  results: BulkPermanentDeleteResult[];
  read_only_failures: Array<{ id: number; path?: string | null; error?: string | null }>;
}

