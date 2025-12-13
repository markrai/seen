import { API_BASE_URL, DEFAULT_PAGE_SIZE } from './config';
import { normalizePerformance, normalizeStats, type PerformanceResponse } from './normalize';
import type {
  Asset,
  Paginated,
  SortField,
  SortOrder,
  Stats,
  FileTypesResponse,
  SearchResult,
  DeleteResponse,
  PermanentDeleteResponse,
  BulkPermanentDeleteResponse,
} from '../types';

function withBase(path: string) {
  if (path.startsWith('http')) return path;
  return `${API_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = init?.signal ? null : new AbortController();
  const timeoutId = controller ? setTimeout(() => controller.abort(), 30000) : null;
  try {
    const res = await fetch(withBase(path), {
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
      // WebView2 can be aggressive with caching even when the server is dynamic.
      // For API JSON requests we want freshness (stats, assets, paths, etc.).
      // Callers can override by passing `cache` in init.
      cache: init?.cache ?? 'no-store',
      ...init,
      signal: init?.signal || controller?.signal,
    });
    if (timeoutId) clearTimeout(timeoutId);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${res.statusText}${text ? `\n${text}` : ''}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return (await res.json()) as T;
    return (await res.blob()) as unknown as T;
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    if (error instanceof TypeError && error.message === 'Failed to fetch') {
      const apiUrl = withBase(path);
      throw new Error(
        `Cannot connect to API at ${apiUrl}. ` +
        `Please ensure the backend is running and accessible. ` +
        `If using Docker, check that the container is running with: docker ps`
      );
    }
    if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted'))) {
      throw new Error(`Request to ${withBase(path)} timed out after 30 seconds`);
    }
    throw error;
  }
}

export const api = {
  // Faces (unassigned list)
  unassignedFaces: (offset: number = 0, limit: number = 60) =>
    request<{ faces: Array<{ id: number; asset_id: number; bbox: any; confidence: number }> }>(
      `/faces/unassigned?offset=${offset}&limit=${limit}`
    ),
  assignFaceToPerson: (faceId: number, personId: number | null) =>
    request<{ success: boolean }>(`/faces/${faceId}/assign`, {
      method: 'POST',
      body: JSON.stringify({ person_id: personId }),
    }),

  // Health and stats
  health: () => request<{ status: string; version: string; database: string; backend_libraries: string[] }>('/health'),
  stats: async () => normalizeStats(await request<any>('/stats')),
  fileTypes: () => request<FileTypesResponse>('/file-types'),
  performance: async (): Promise<PerformanceResponse> =>
    normalizePerformance(await request<any>('/performance')),

  // Assets
  assets: (params: {
    offset?: number;
    limit?: number;
    sort?: SortField;
    order?: SortOrder;
    person_id?: number;
  } = {}) => {
    const u = new URL(withBase('/assets'));
    const { offset = 0, limit = DEFAULT_PAGE_SIZE, sort = 'none', order = 'desc', person_id } = params;
    u.searchParams.set('offset', String(offset));
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('sort', sort);
    u.searchParams.set('order', order);
    if (person_id !== undefined) {
      u.searchParams.set('person_id', String(person_id));
    }
    return request<Paginated<Asset>>(u.toString());
  },

  search: (params: {
    q: string;
    from?: string;
    to?: string;
    camera_make?: string;
    camera_model?: string;
    platformType?: string;
    offset?: number;
    limit?: number;
  }) => {
    const u = new URL(withBase('/assets/search'));
    u.searchParams.set('q', params.q);
    if (params.from) u.searchParams.set('from', params.from);
    if (params.to) u.searchParams.set('to', params.to);
    if (params.camera_make) u.searchParams.set('camera_make', params.camera_make);
    if (params.camera_model) u.searchParams.set('camera_model', params.camera_model);
    if (params.platformType) u.searchParams.set('platform_type', params.platformType);
    u.searchParams.set('offset', String(params.offset ?? 0));
    u.searchParams.set('limit', String(params.limit ?? DEFAULT_PAGE_SIZE));
    return request<SearchResult>(u.toString());
  },

  getScanPaths: async () => {
    // Backend is expected to return an array, but be defensive:
    // - some older builds returned { paths: [...] }
    // - some reverse proxies might wrap payloads
    const res = await request<any>('/paths');
    if (Array.isArray(res)) return res as Array<{ path: string; is_default: boolean; host_path?: string | null }>;
    if (res && typeof res === 'object' && Array.isArray((res as any).paths)) {
      return (res as any).paths as Array<{ path: string; is_default: boolean; host_path?: string | null }>;
    }
    return [];
  },
  addScanPath: (path: string) =>
    request<{ success: boolean; message: string }>('/paths', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  removeScanPath: (path: string) =>
    request<{ success: boolean; path_removed: boolean; assets_deleted: number; faces_deleted: number; message: string }>(
      `/paths?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' }
    ),
  scanPath: (path: string) =>
    request<{ success: boolean; message: string }>(
      '/paths/scan',
      { method: 'POST', body: JSON.stringify({ path }) }
    ),
  pausePath: (path: string) =>
    request<{ success: boolean; message: string }>(
      '/paths/pause',
      { method: 'POST', body: JSON.stringify({ path }) }
    ),
  resumePath: (path: string) =>
    request<{ success: boolean; message: string }>(
      '/paths/resume',
      { method: 'POST', body: JSON.stringify({ path }) }
    ),
  getPathStatus: (path: string) => {
    const url = `/paths/status?path=${encodeURIComponent(path)}`;
    return request<{ scanning: boolean; watcher_paused: boolean; watching: boolean }>(url);
  },
  browseDirectory: (path?: string) => {
    const url = path ? `/browse?path=${encodeURIComponent(path)}` : '/browse';
    return request<any>(url).then((res) => {
      // Be defensive: if a proxy strips JSON content-type, `request()` may return a Blob.
      // Also guard against unexpected shapes.
      if (!res || typeof res !== 'object' || Array.isArray(res)) {
        return { path: path ?? '/', entries: [] as Array<{ name: string; path: string; is_dir: boolean }> };
      }
      const entries = Array.isArray((res as any).entries) ? (res as any).entries : [];
      const safeEntries = entries.filter((e: any) =>
        e && typeof e === 'object' && typeof e.name === 'string' && typeof e.path === 'string'
      );
      return {
        path: typeof (res as any).path === 'string' ? (res as any).path : (path ?? '/'),
        entries: safeEntries as Array<{ name: string; path: string; is_dir: boolean }>,
      };
    });
  },
  clearAllData: () =>
    request<{ success: boolean; assets_deleted: number; faces_deleted: number; persons_deleted: number; message: string }>(
      '/clear',
      { method: 'DELETE' }
    ),
  resetStats: () =>
    request<{ success: boolean; message: string }>(
      '/stats/reset',
      { method: 'POST' }
    ),

  // Face recognition APIs
  detectFaces: () => request<{ status: string; message: string }>('/faces/detect', { method: 'POST' }),
  stopFaceDetection: () => request<{ status: string; message: string }>('/faces/stop', { method: 'POST' }),
  faceDetectionStatus: () => request<{ enabled: boolean; queue_depth: number }>('/faces/status'),
  faceProgress: () =>
    request<{
      enabled: boolean;
      queue_depth: number;
      models_loaded: { scrfd: boolean; arcface: boolean };
      counts: { faces_total: number; persons_total: number; assets_with_faces: number };
      thresholds: { cluster_batch_size: number; remaining_to_next_cluster: number };
      status: string;
    }>('/faces/progress'),
  clearFacialData: () =>
    request<{ success: boolean; faces_deleted: number; persons_deleted: number; message: string }>(
      '/faces/clear',
      { method: 'DELETE' }
    ),

  // Persons
  listPersons: () => request<Array<{ id: number; name: string | null; created_at: number }>>('/persons'),
  getPerson: (id: number) => request<{ id: number; name: string | null; created_at: number }>(`/persons/${id}`),
  getPersonAssets: (id: number) =>
    request<{ asset_ids: number[] }>(`/persons/${id}/assets`).then((res) => res.asset_ids),
  getPersonFace: (id: number) =>
    request<{ face_id: number }>(`/persons/${id}/face`).then((res) => res.face_id).catch(() => null),
  updatePerson: (id: number, name: string | null) =>
    request<{ success: boolean }>(`/persons/${id}`, { method: 'POST', body: JSON.stringify({ name }) }),
  deletePerson: (id: number) => request<{ success: boolean }>(`/persons/${id}`, { method: 'DELETE' }),
  mergePersons: (sourceId: number, targetId: number) =>
    request<{
      success: boolean;
      faces_merged: number;
      moved_face_ids: number[];
      profile_refreshed?: { person_id: number; face_count: number; centroid_dim: number } | null;
    }>(`/persons/merge`, {
      method: 'POST',
      body: JSON.stringify({ source_person_id: sourceId, target_person_id: targetId }),
    }),
  refreshPersonProfile: (personId: number) =>
    request<{
      success: boolean;
      profile: { person_id: number; face_count: number; centroid_dim: number } | null;
    }>(`/faces/recluster/person/${personId}`, {
      method: 'POST',
    }),

  // Faces for an asset
  getAssetFaces: (id: number) =>
    request<Array<{ id: number; person_id: number | null; bbox_json: string; confidence: number }>>(
      `/assets/${id}/faces`
    ),

  // Face settings
  getFaceSettings: () =>
    request<{
      confidence_threshold?: number;
      nms_iou_threshold?: number;
      cluster_epsilon?: number;
      min_cluster_size?: number;
      min_samples?: number;
      excluded_extensions?: string[];
    }>('/faces/settings'),
  updateFaceSettings: (settings: {
    confidence_threshold?: number;
    nms_iou_threshold?: number;
    cluster_epsilon?: number;
    min_cluster_size?: number;
    min_samples?: number;
    excluded_extensions?: string[];
  }) =>
    request<{ status: string }>('/faces/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  smartMergePersons: (threshold?: number) =>
    request<{ success: boolean; persons_merged: number; faces_merged: number; remaining_persons: number }>(
      `/faces/smart-merge${threshold ? `?threshold=${threshold}` : ''}`,
      { method: 'POST' }
    ),
};

export const media = {
  faceThumbUrl: (faceId: number, size: number = 160) =>
    withBase(`/faces/${faceId}/thumb?size=${size}`),
  thumbUrl: (id: number, version?: string) =>
    withBase(version ? `/thumb/${id}?v=${version}` : `/thumb/${id}`),
  previewUrl: (id: number, version?: string) =>
    withBase(version ? `/preview/${id}?v=${version}` : `/preview/${id}`),
  videoUrl: (id: number) => withBase(`/asset/${id}/video`),
  downloadUrl: (id: number) => withBase(`/asset/${id}/download`),
  audioMp3Url: (id: number) => withBase(`/asset/${id}/audio.mp3`),
};

export const assetApi = {
  get: (id: number) => request<Asset>(`/asset/${id}`),

  download: async (id: number) => {
    const url = media.downloadUrl(id);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    const contentDisposition = response.headers.get('Content-Disposition');
    const filenameMatch = contentDisposition?.match(/filename=\"?([^\"]+)\"?/);
    a.download = filenameMatch ? filenameMatch[1] : `asset-${id}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(downloadUrl);
  },

  delete: async (
    id: number,
    options?: { permanent?: boolean }
  ): Promise<DeleteResponse | PermanentDeleteResponse> => {
    const permanent = options?.permanent === true;
    const url = withBase(permanent ? `/asset/${id}/permanent` : `/asset/${id}`);
    const response = await fetch(url, { method: 'DELETE' });
    const text = await response.text().catch(() => '');
    let data: DeleteResponse | PermanentDeleteResponse = { success: response.ok };
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { success: response.ok, error: text };
      }
    }
    if (!response.ok) {
      if (permanent && response.status === 409) {
        return data;
      }
      const errorMessage =
        (data as DeleteResponse).error ||
        `Delete failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ''}`;
      throw new Error(errorMessage);
    }
    return data;
  },

  deletePermanentBulk: async (ids: number[]): Promise<BulkPermanentDeleteResponse> => {
    const url = withBase('/assets/permanent');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
      const text = await response.text().catch(() => '');
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // ignore parse errors, will handle below
      }
    }
    if (!response.ok && response.status !== 409) {
      const message =
        (parsed && typeof parsed.error === 'string')
          ? parsed.error
          : `Bulk delete failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ''}`;
      throw new Error(message);
    }
    const data: BulkPermanentDeleteResponse = {
      success: Boolean(parsed?.success ?? response.ok),
      results: Array.isArray(parsed?.results) ? parsed.results : [],
      read_only_failures: Array.isArray(parsed?.read_only_failures) ? parsed.read_only_failures : [],
    };
    return data;
  },

  extractAudioMp3: async (id: number) => {
    const url = media.audioMp3Url(id);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let errorMessage = `Audio extract failed: ${response.status} ${response.statusText}`;
        if (text) {
          try {
            const json = JSON.parse(text);
            errorMessage = json.error || json.details || errorMessage;
          } catch {
            errorMessage += `\n${text}`;
          }
        }
        throw new Error(errorMessage);
      }
      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      const cd = response.headers.get('Content-Disposition');
      const match = cd?.match(/filename=\"?([^\";]+)\"?/);
      a.download = match ? match[1] : `audio-${id}.mp3`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Audio extraction timed out after 10 minutes');
      }
      throw error;
    }
  },

  saveOrientation: async (id: number, rotation: number): Promise<{ success: boolean; error?: string }> => {
    const url = withBase(`/asset/${id}/orientation`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rotation }),
    });
    const text = await response.text().catch(() => '');
    let data: { success: boolean; error?: string } = { success: response.ok };
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { success: response.ok, error: text || 'Unknown error' };
      }
    }
    if (!response.ok) {
      throw new Error(data.error || `Save orientation failed: ${response.status} ${response.statusText}`);
    }
    return data;
  },

  // Albums
  listAlbums: () => request<Array<{
    id: number;
    name: string;
    description?: string;
    asset_ids: number[];
    created_at: number;
    updated_at: number;
  }>>('/albums'),

  getAlbum: (id: number) => request<{
    id: number;
    name: string;
    description?: string;
    asset_ids: number[];
    created_at: number;
    updated_at: number;
  }>(`/albums/${id}`),

  createAlbum: (name: string, description?: string) =>
    request<{
      id: number;
      name: string;
      description?: string;
      asset_ids: number[];
      created_at: number;
      updated_at: number;
    }>('/albums', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),

  updateAlbum: (id: number, name?: string, description?: string) =>
    request<{
      id: number;
      name: string;
      description?: string;
      asset_ids: number[];
      created_at: number;
      updated_at: number;
    }>(`/albums/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name, description }),
    }),

  deleteAlbum: (id: number) =>
    request<{ success: boolean }>(`/albums/${id}`, {
      method: 'DELETE',
    }),

  addAssetsToAlbum: (id: number, assetIds: number[]) =>
    request<{
      id: number;
      name: string;
      description?: string;
      asset_ids: number[];
      created_at: number;
      updated_at: number;
    }>(`/albums/${id}/assets`, {
      method: 'POST',
      body: JSON.stringify({ asset_ids: assetIds }),
    }),

  removeAssetsFromAlbum: (id: number, assetIds: number[]) =>
    request<{
      id: number;
      name: string;
      description?: string;
      asset_ids: number[];
      created_at: number;
      updated_at: number;
    }>(`/albums/${id}/assets`, {
      method: 'DELETE',
      body: JSON.stringify({ asset_ids: assetIds }),
    }),

  getAlbumsForAsset: (assetId: number) =>
    request<number[]>(`/albums/for-asset/${assetId}`),
};
