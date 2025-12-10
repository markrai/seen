import { useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon, DocumentDuplicateIcon, ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import type { Asset } from '../types';
import { media, assetApi } from '../lib/api';

interface MetadataPanelProps {
  asset: Asset;
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function Section({ title, children, defaultOpen = false }: SectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-zinc-200 dark:border-zinc-700 last:border-b-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-2 sm:p-3 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
      >
        <span className="font-medium text-xs sm:text-sm">{title}</span>
        {isOpen ? (
          <ChevronUpIcon className="w-5 h-5 text-zinc-500" />
        ) : (
          <ChevronDownIcon className="w-5 h-5 text-zinc-500" />
        )}
      </button>
      {isOpen && (
        <div className="px-2 sm:px-3 pb-2 sm:pb-3 space-y-1.5 sm:space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}

function MetadataRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-x-2 sm:gap-x-4 gap-y-1 text-xs sm:text-sm">
      <div className="opacity-70 truncate">{label}</div>
      <div className="truncate" title={typeof value === 'string' ? value : undefined}>
        {value || <span className="opacity-50">—</span>}
      </div>
    </div>
  );
}

function formatBytes(bytes: number, decimals = 1) {
  if (!+bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatDate(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString();
}

function formatExposure(exposure: number) {
  if (exposure < 1) {
    return `1/${Math.round(1 / exposure)}s`;
  }
  return `${exposure.toFixed(1)}s`;
}

export default function MetadataPanel({ asset }: MetadataPanelProps) {
  const handleCopyPath = () => {
    navigator.clipboard.writeText(asset.path);
  };

  const handleDownload = async () => {
    try {
      await assetApi.download(asset.id);
    } catch (error) {
      console.error('Download failed:', error);
      alert(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 divide-y divide-zinc-200 dark:divide-zinc-700">
      {/* Quick Actions */}
      <div className="p-2 sm:p-3 flex gap-1.5 sm:gap-2">
        <button
          onClick={handleCopyPath}
          className="flex-1 px-2 sm:px-3 py-1.5 sm:py-2 rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs sm:text-sm transition-colors flex items-center justify-center gap-1.5 sm:gap-2"
          title="Copy file path"
        >
          <DocumentDuplicateIcon className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
          <span className="hidden sm:inline">Copy Path</span>
          <span className="sm:hidden">Copy</span>
        </button>
        <button
          onClick={handleDownload}
          className="flex-1 px-2 sm:px-3 py-1.5 sm:py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs sm:text-sm transition-colors flex items-center justify-center gap-1.5 sm:gap-2"
        >
          <ArrowDownTrayIcon className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
          <span className="hidden sm:inline">Download</span>
          <span className="sm:hidden">DL</span>
        </button>
      </div>

      {/* File Information */}
      <Section title="File Information" defaultOpen={true}>
        <MetadataRow label="Filename" value={asset.filename} />
        <MetadataRow label="Path" value={<span className="font-mono text-xs">{asset.path}</span>} />
        <MetadataRow label="Type" value={asset.mime} />
        <MetadataRow label="Size" value={formatBytes(asset.size_bytes)} />
        {asset.width && asset.height && (
          <MetadataRow label="Dimensions" value={`${asset.width} × ${asset.height} pixels`} />
        )}
        <MetadataRow label="Modified" value={formatDate(asset.mtime_ns / 1_000_000_000)} />
        <MetadataRow label="Created" value={formatDate(asset.ctime_ns / 1_000_000_000)} />
        {asset.taken_at && (
          <MetadataRow label="Date Taken" value={formatDate(asset.taken_at)} />
        )}
        {asset.duration_ms && (
          <MetadataRow
            label="Duration"
            value={`${Math.floor(asset.duration_ms / 1000 / 60)}:${String(Math.floor((asset.duration_ms / 1000) % 60)).padStart(2, '0')}`}
          />
        )}
      </Section>

      {/* Camera & Lens */}
      {(asset.camera_make || asset.camera_model || asset.lens_model) && (
        <Section title="Camera & Lens">
          {asset.camera_make && (
            <MetadataRow label="Camera Make" value={asset.camera_make} />
          )}
          {asset.camera_model && (
            <MetadataRow label="Camera Model" value={asset.camera_model} />
          )}
          {asset.lens_model && (
            <MetadataRow label="Lens" value={asset.lens_model} />
          )}
        </Section>
      )}

      {/* Exposure Settings */}
      {(asset.iso || asset.fnumber || asset.exposure) && (
        <Section title="Exposure Settings">
          {asset.iso && (
            <MetadataRow label="ISO" value={asset.iso} />
          )}
          {asset.fnumber && (
            <MetadataRow label="Aperture" value={`f/${asset.fnumber}`} />
          )}
          {asset.exposure && (
            <MetadataRow label="Shutter Speed" value={formatExposure(asset.exposure)} />
          )}
        </Section>
      )}

      {/* Technical Details */}
      <Section title="Technical Details">
        <MetadataRow label="File Extension" value={asset.ext} />
        <MetadataRow label="Directory" value={asset.dirname} />
        {asset.sha256 && (
          <MetadataRow
            label="SHA256"
            value={<span className="font-mono text-xs break-all">{asset.sha256}</span>}
          />
        )}
        {asset.xxh64 && (
          <MetadataRow label="XXH64" value={asset.xxh64.toString()} />
        )}
        <MetadataRow label="Flags" value={asset.flags.toString()} />
      </Section>
    </div>
  );
}

