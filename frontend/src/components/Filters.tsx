import { useState } from 'react';

export interface SearchFilters {
  from?: string;
  to?: string;
  camera_make?: string;
  camera_model?: string;
}

export default function Filters({ value, onChange }: { value: SearchFilters; onChange: (v: SearchFilters) => void }) {
  const [local, setLocal] = useState<SearchFilters>(value);

  function apply() {
    onChange(local);
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
      <input
        type="date"
        value={local.from || ''}
        onChange={(e) => setLocal({ ...local, from: e.target.value })}
        className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        placeholder="From"
      />
      <input
        type="date"
        value={local.to || ''}
        onChange={(e) => setLocal({ ...local, to: e.target.value })}
        className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        placeholder="To"
      />
      <input
        value={local.camera_make || ''}
        onChange={(e) => setLocal({ ...local, camera_make: e.target.value })}
        className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        placeholder="Camera make"
      />
      <input
        value={local.camera_model || ''}
        onChange={(e) => setLocal({ ...local, camera_model: e.target.value })}
        className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
        placeholder="Camera model"
      />
      <div className="col-span-full flex justify-end">
        <button onClick={apply} className="px-3 py-1.5 rounded-md bg-zinc-900 text-white dark:bg-white dark:text-black text-xs">
          Apply Filters
        </button>
      </div>
    </div>
  );
}

