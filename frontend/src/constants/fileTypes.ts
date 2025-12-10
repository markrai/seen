export const RAW_EXTENSIONS = [
  'raw', 'dng', 'nef', 'cr2', 'arw', 'orf', 'raf', 'pef', 'srw', '3fr', 'x3f',
  'mrw', 'mef', 'mos', 'erf', 'dcr', 'rw2', 'rwl', 'r3d', 'ari', 'bay', 'cap',
  'dcs', 'drf', 'eip', 'k25', 'kdc', 'mdc', 'nrw', 'obm', 'ptx', 'pxn', 'rwz',
  'srf', 'crw', 'fff', 'iiq',
];

export const FILE_TYPE_EXTENSION_MAP: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/jpg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'image/heic': ['heic'],
  'image/heif': ['heif'],
  'image/dng': ['dng'],
  'image/tiff': ['tif', 'tiff'],
  'image/tif': ['tif', 'tiff'],
  'image/bmp': ['bmp'],
  'image/raw': RAW_EXTENSIONS,
  'image/x-raw': RAW_EXTENSIONS,
  'video/mp4': ['mp4', 'm4v'],
  'video/mov': ['mov', 'qt'],
  'video/quicktime': ['mov', 'qt'],
  'video/x-quicktime': ['mov', 'qt'],
  'video/avi': ['avi'],
  'video/x-msvideo': ['avi'],
  'video/mkv': ['mkv'],
  'video/x-matroska': ['mkv'],
  'video/webm': ['webm'],
  'video/mp4v': ['mp4v'],
  'video/mpeg': ['mpg', 'mpeg'],
  'audio/mpeg': ['mp3'],
  'audio/mp3': ['mp3'],
  'audio/wav': ['wav'],
  'audio/flac': ['flac'],
  'audio/aac': ['aac'],
  'audio/ogg': ['ogg'],
  'audio/m4a': ['m4a'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'],
};

export type FileTypeFilterOption = {
  value: string;
  label: string;
  extensions: string[];
};

export const FILE_TYPE_FILTER_OPTIONS: FileTypeFilterOption[] = [
  { value: 'image/jpeg', label: 'JPEG', extensions: FILE_TYPE_EXTENSION_MAP['image/jpeg'] },
  { value: 'image/png', label: 'PNG', extensions: FILE_TYPE_EXTENSION_MAP['image/png'] },
  { value: 'image/webp', label: 'WEBP', extensions: FILE_TYPE_EXTENSION_MAP['image/webp'] },
  { value: 'image/gif', label: 'GIF', extensions: FILE_TYPE_EXTENSION_MAP['image/gif'] },
  { value: 'image/heic', label: 'HEIC', extensions: FILE_TYPE_EXTENSION_MAP['image/heic'] },
  { value: 'image/heif', label: 'HEIF', extensions: FILE_TYPE_EXTENSION_MAP['image/heif'] },
  { value: 'image/tiff', label: 'TIFF', extensions: FILE_TYPE_EXTENSION_MAP['image/tiff'] },
  { value: 'image/bmp', label: 'BMP', extensions: FILE_TYPE_EXTENSION_MAP['image/bmp'] },
  { value: 'image/raw', label: 'RAW', extensions: RAW_EXTENSIONS },
  { value: 'video/mp4', label: 'MP4', extensions: FILE_TYPE_EXTENSION_MAP['video/mp4'] },
  { value: 'video/mov', label: 'MOV', extensions: FILE_TYPE_EXTENSION_MAP['video/mov'] },
  { value: 'video/avi', label: 'AVI', extensions: FILE_TYPE_EXTENSION_MAP['video/avi'] },
  { value: 'video/mkv', label: 'MKV', extensions: FILE_TYPE_EXTENSION_MAP['video/mkv'] },
  { value: 'video/webm', label: 'WEBM', extensions: FILE_TYPE_EXTENSION_MAP['video/webm'] },
  { value: 'video/mpeg', label: 'MPEG', extensions: FILE_TYPE_EXTENSION_MAP['video/mpeg'] },
  { value: 'audio/mpeg', label: 'MP3', extensions: FILE_TYPE_EXTENSION_MAP['audio/mpeg'] },
  { value: 'audio/flac', label: 'FLAC', extensions: FILE_TYPE_EXTENSION_MAP['audio/flac'] },
  { value: 'audio/wav', label: 'WAV', extensions: FILE_TYPE_EXTENSION_MAP['audio/wav'] },
  { value: 'audio/aac', label: 'AAC', extensions: FILE_TYPE_EXTENSION_MAP['audio/aac'] },
  { value: 'audio/ogg', label: 'OGG', extensions: FILE_TYPE_EXTENSION_MAP['audio/ogg'] },
];

export function normalizeTypeKey(key: string | null | undefined): string {
  return key ? key.trim().toLowerCase() : '';
}

export function getExtensionsForType(key: string | null | undefined, fallback?: string[]): string[] {
  const normalized = normalizeTypeKey(key);
  if (!normalized) return [];
  if (FILE_TYPE_EXTENSION_MAP[normalized]) {
    return FILE_TYPE_EXTENSION_MAP[normalized];
  }
  return fallback ?? [];
}

export function formatFileTypeLabel(type: string): string {
  if (!type) return 'All file types';
  if (type.includes('/')) {
    const parts = type.split('/');
    const subtype = parts[1].toUpperCase();
    return subtype;
  }
  return type.toUpperCase();
}

