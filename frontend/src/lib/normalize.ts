import type { Stats } from '../types';

function asNumber(v: any, fallback: number = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asBool(v: any, fallback: boolean = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function asString(v: any, fallback: string = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asRecord(v: any): Record<string, any> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

export function normalizeStats(input: any): Stats {
  const obj = asRecord(input);
  const queues = asRecord(obj.queues);
  const processed = asRecord(obj.processed);
  const db = asRecord(obj.db);
  const discovery = asRecord(obj.discovery);
  const processing = asRecord(obj.processing);
  const currentProcessing = asRecord(obj.current_processing);
  const currentScanRaw = obj.current_scan;
  const currentScan = currentScanRaw === null ? null : asRecord(currentScanRaw);
  const completion = asRecord(obj.completion);

  return {
    uptime_seconds: asNumber(obj.uptime_seconds, 0),
    queues: {
      discover: asNumber(queues.discover, 0),
      hash: asNumber(queues.hash, 0),
      metadata: asNumber(queues.metadata, 0),
      db_write: asNumber(queues.db_write, 0),
      thumb: asNumber(queues.thumb, 0),
    },
    processed: {
      files_total: asNumber(processed.files_total, 0),
      files_per_sec: asNumber(processed.files_per_sec, 0),
      bytes_total: asNumber(processed.bytes_total, 0),
      bytes_per_sec: asNumber(processed.bytes_per_sec, 0),
      mb_per_sec: asNumber(processed.mb_per_sec, 0),
    },
    scan_running: asBool(obj.scan_running, false),
    processing_active: asBool(obj.processing_active, false),
    discovery: Object.keys(discovery).length
      ? {
          files_discovered: asNumber(discovery.files_discovered, 0),
          rate_files_per_sec: asNumber(discovery.rate_files_per_sec, 0),
          last_completed_elapsed_seconds: asNumber(discovery.last_completed_elapsed_seconds, 0),
        }
      : undefined,
    processing: Object.keys(processing).length
      ? {
          files_committed: asNumber(processing.files_committed, 0),
          bytes_total: asNumber(processing.bytes_total, 0),
          rate_files_per_sec: asNumber(processing.rate_files_per_sec, 0),
          throughput_mb_per_sec: asNumber(processing.throughput_mb_per_sec, 0),
          last_completed_elapsed_seconds: asNumber(processing.last_completed_elapsed_seconds, 0),
        }
      : undefined,
    current_processing: Object.keys(currentProcessing).length
      ? {
          files_committed: asNumber(currentProcessing.files_committed, 0),
          elapsed_seconds: asNumber(currentProcessing.elapsed_seconds, 0),
          processing_rate_files_per_sec: asNumber(currentProcessing.processing_rate_files_per_sec, 0),
        }
      : undefined,
    current_scan:
      currentScanRaw === null
        ? null
        : Object.keys(currentScan).length
          ? {
              files_discovered: asNumber(currentScan.files_discovered, 0),
              files_processed: asNumber(currentScan.files_processed, 0),
              files_per_sec: asNumber(currentScan.files_per_sec, 0),
              elapsed_seconds: asNumber(currentScan.elapsed_seconds, 0),
              status: asString(currentScan.status, ''),
            }
          : undefined,
    completion: Object.keys(completion).length
      ? {
          percentage: asNumber(completion.percentage, 0),
        }
      : undefined,
    db: {
      assets: asNumber(db.assets, 0),
    },
  };
}

export type PerformanceResponse = {
  seen: {
    files_per_sec: number;
    current_rate: number;
    mb_per_sec: number;
    status: string;
    is_active: boolean;
  };
  system_info: {
    cpu_cores: number;
    cpu_brand: string;
    accel: string;
    note?: string;
  };
  gpu_usage: {
    enabled: boolean;
    accel: string;
    jobs_gpu: number;
    jobs_cpu: number;
    consecutive_failures: number;
    auto_disabled: boolean;
  };
  typical_ranges: Record<string, { files_per_sec: string; note: string }>;
  current_scan?: {
    files_processed: number;
    files_per_sec: number;
    elapsed_seconds: number;
    status: string;
    photos_processed?: number;
    videos_processed?: number;
  };
  notes: string[];
};

export function normalizePerformance(input: any): PerformanceResponse {
  const obj = asRecord(input);
  const seen = asRecord(obj.seen);
  const system = asRecord(obj.system_info);
  const gpu = asRecord(obj.gpu_usage);
  const typical = asRecord(obj.typical_ranges);
  const currentScan = asRecord(obj.current_scan);
  const notesRaw = obj.notes;

  const normalized: PerformanceResponse = {
    seen: {
      files_per_sec: asNumber(seen.files_per_sec, 0),
      current_rate: asNumber(seen.current_rate, 0),
      mb_per_sec: asNumber(seen.mb_per_sec, 0),
      status: asString(seen.status, 'idle'),
      is_active: asBool(seen.is_active, false),
    },
    system_info: {
      cpu_cores: asNumber(system.cpu_cores, 0),
      cpu_brand: asString(system.cpu_brand, 'Unknown'),
      accel: asString(system.accel, 'CPU'),
      note: asString(system.note, ''),
    },
    gpu_usage: {
      enabled: asBool(gpu.enabled, false),
      accel: asString(gpu.accel, asString(system.accel, 'CPU')),
      jobs_gpu: asNumber(gpu.jobs_gpu, 0),
      jobs_cpu: asNumber(gpu.jobs_cpu, 0),
      consecutive_failures: asNumber(gpu.consecutive_failures, 0),
      auto_disabled: asBool(gpu.auto_disabled, false),
    },
    typical_ranges:
      typical && typeof typical === 'object' && !Array.isArray(typical)
        ? (typical as Record<string, { files_per_sec: string; note: string }>)
        : {},
    notes: Array.isArray(notesRaw) ? notesRaw.filter((n) => typeof n === 'string') : [],
    ...(Object.keys(currentScan).length
      ? {
          current_scan: {
            files_processed: asNumber(currentScan.files_processed, 0),
            files_per_sec: asNumber(currentScan.files_per_sec, 0),
            elapsed_seconds: asNumber(currentScan.elapsed_seconds, 0),
            status: asString(currentScan.status, 'idle'),
            photos_processed:
              currentScan.photos_processed === undefined ? undefined : asNumber(currentScan.photos_processed, 0),
            videos_processed:
              currentScan.videos_processed === undefined ? undefined : asNumber(currentScan.videos_processed, 0),
          },
        }
      : {}),
  };

  return normalized;
}


