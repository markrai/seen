import { useState, useEffect } from 'react';
import { XMarkIcon, FunnelIcon } from '@heroicons/react/24/outline';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';

export interface AdvancedFilters {
  from?: string;
  to?: string;
  camera_make?: string;
  camera_model?: string;
  minSize?: number;
  maxSize?: number;
  fileTypes?: string[];
  platformType?: string;
}

interface AdvancedFiltersProps {
  value: AdvancedFilters;
  onChange: (filters: AdvancedFilters) => void;
  onClear: () => void;
  availableCameras?: string[];
  availableModels?: string[];
}

const FILE_TYPES = [
  { value: 'image/jpeg', label: 'JPEG' },
  { value: 'image/png', label: 'PNG' },
  { value: 'image/gif', label: 'GIF' },
  { value: 'image/webp', label: 'WebP' },
  { value: 'image/tiff', label: 'TIFF' },
  { value: 'video/mp4', label: 'MP4' },
  { value: 'video/quicktime', label: 'MOV' },
  { value: 'video/x-msvideo', label: 'AVI' },
];

const SIZE_UNITS = [
  { value: 1, label: 'B' },
  { value: 1024, label: 'KB' },
  { value: 1024 * 1024, label: 'MB' },
  { value: 1024 * 1024 * 1024, label: 'GB' },
];

const PLATFORM_TYPES = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'pxl', label: 'Google Pixel' },
];

export default function AdvancedFilters({
  value,
  onChange,
  onClear,
  availableCameras = [],
  availableModels = [],
}: AdvancedFiltersProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [localFilters, setLocalFilters] = useState<AdvancedFilters>(value);
  const [minSizeUnit, setMinSizeUnit] = useState(1024 * 1024); // MB
  const [maxSizeUnit, setMaxSizeUnit] = useState(1024 * 1024 * 1024); // GB

  useEffect(() => {
    setLocalFilters(value);
  }, [value]);

  const hasActiveFilters = Boolean(
    localFilters.from ||
    localFilters.to ||
    localFilters.camera_make ||
    localFilters.camera_model ||
    localFilters.minSize ||
    localFilters.maxSize ||
    (localFilters.fileTypes && localFilters.fileTypes.length > 0) ||
    localFilters.platformType
  );

  const handleApply = () => {
    onChange(localFilters);
    setIsOpen(false);
  };

  const handleClear = () => {
    const cleared = {
      from: undefined,
      to: undefined,
      camera_make: undefined,
      camera_model: undefined,
      minSize: undefined,
      maxSize: undefined,
      fileTypes: undefined,
      platformType: undefined,
    };
    setLocalFilters(cleared);
    onChange(cleared);
    onClear();
  };

  const toggleFileType = (type: string) => {
    const current = localFilters.fileTypes || [];
    const updated = current.includes(type)
      ? current.filter((t) => t !== type)
      : [...current, type];
    setLocalFilters({ ...localFilters, fileTypes: updated });
  };

  const togglePlatformType = (type: string) => {
    setLocalFilters({
      ...localFilters,
      platformType: localFilters.platformType === type ? undefined : type,
    });
  };

  const formatSize = (bytes: number, unit: number) => {
    return (bytes / unit).toFixed(1);
  };

  const parseSize = (value: string, unit: number) => {
    const num = parseFloat(value);
    return isNaN(num) ? undefined : Math.round(num * unit);
  };

  return (
    <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-3 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
      >
        <div className="flex items-center gap-2">
          <FunnelIcon className="w-5 h-5" />
          <span className="font-medium">Advanced Filters</span>
          {hasActiveFilters && (
            <span className="px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-xs">
              Active
            </span>
          )}
        </div>
        {isOpen ? (
          <ChevronUpIcon className="w-5 h-5 text-zinc-500" />
        ) : (
          <ChevronDownIcon className="w-5 h-5 text-zinc-500" />
        )}
      </button>

      {isOpen && (
        <div className="p-4 space-y-4 border-t border-zinc-200 dark:border-zinc-700">
          {/* Date Range */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Date Range</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">From</label>
                <input
                  type="date"
                  value={localFilters.from || ''}
                  onChange={(e) => setLocalFilters({ ...localFilters, from: e.target.value || undefined })}
                  className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">To</label>
                <input
                  type="date"
                  value={localFilters.to || ''}
                  onChange={(e) => setLocalFilters({ ...localFilters, to: e.target.value || undefined })}
                  className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
                />
              </div>
            </div>
          </div>

          {/* Camera */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Camera</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">Make</label>
                {availableCameras.length > 0 ? (
                  <select
                    value={localFilters.camera_make || ''}
                    onChange={(e) => setLocalFilters({ ...localFilters, camera_make: e.target.value || undefined })}
                    className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
                  >
                    <option value="">All</option>
                    {availableCameras.map((cam) => (
                      <option key={cam} value={cam}>
                        {cam}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={localFilters.camera_make || ''}
                    onChange={(e) => setLocalFilters({ ...localFilters, camera_make: e.target.value || undefined })}
                    placeholder="Camera make"
                    className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
                  />
                )}
              </div>
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">Model</label>
                {availableModels.length > 0 ? (
                  <select
                    value={localFilters.camera_model || ''}
                    onChange={(e) => setLocalFilters({ ...localFilters, camera_model: e.target.value || undefined })}
                    className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
                  >
                    <option value="">All</option>
                    {availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={localFilters.camera_model || ''}
                    onChange={(e) => setLocalFilters({ ...localFilters, camera_model: e.target.value || undefined })}
                    placeholder="Camera model"
                    className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
                  />
                )}
              </div>
            </div>
          </div>

          {/* File Size */}
          <div className="space-y-2">
            <label className="text-sm font-medium">File Size</label>
            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label className="text-xs text-zinc-500">Min</label>
                  <select
                    value={minSizeUnit}
                    onChange={(e) => setMinSizeUnit(Number(e.target.value))}
                    className="ml-auto px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-xs"
                  >
                    {SIZE_UNITS.map((u) => (
                      <option key={u.value} value={u.value}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  type="number"
                  step="0.1"
                  value={localFilters.minSize ? formatSize(localFilters.minSize, minSizeUnit) : ''}
                  onChange={(e) =>
                    setLocalFilters({
                      ...localFilters,
                      minSize: parseSize(e.target.value, minSizeUnit),
                    })
                  }
                  placeholder="0"
                  className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
                />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label className="text-xs text-zinc-500">Max</label>
                  <select
                    value={maxSizeUnit}
                    onChange={(e) => setMaxSizeUnit(Number(e.target.value))}
                    className="ml-auto px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-xs"
                  >
                    {SIZE_UNITS.map((u) => (
                      <option key={u.value} value={u.value}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  type="number"
                  step="0.1"
                  value={localFilters.maxSize ? formatSize(localFilters.maxSize, maxSizeUnit) : ''}
                  onChange={(e) =>
                    setLocalFilters({
                      ...localFilters,
                      maxSize: parseSize(e.target.value, maxSizeUnit),
                    })
                  }
                  placeholder="No limit"
                  className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent text-sm"
                />
              </div>
            </div>
          </div>

          {/* File Types */}
          <div className="space-y-2">
            <label className="text-sm font-medium">File Types</label>
            <div className="flex flex-wrap gap-2">
              {FILE_TYPES.map((type) => (
                <button
                  key={type.value}
                  onClick={() => toggleFileType(type.value)}
                  className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                    localFilters.fileTypes?.includes(type.value)
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  {type.label}
                </button>
              ))}
            </div>
          </div>

          {/* Platform Types */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Platform Types</label>
            <div className="flex flex-wrap gap-2">
              {PLATFORM_TYPES.map((platform) => (
                <button
                  key={platform.value}
                  onClick={() => togglePlatformType(platform.value)}
                  className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                    localFilters.platformType === platform.value
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  {platform.label}
                </button>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2 border-t border-zinc-200 dark:border-zinc-700">
            <button
              onClick={handleApply}
              className="flex-1 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm transition-colors"
            >
              Apply Filters
            </button>
            {hasActiveFilters && (
              <button
                onClick={handleClear}
                className="px-4 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-sm transition-colors flex items-center gap-2"
              >
                <XMarkIcon className="w-4 h-4" />
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

