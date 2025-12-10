import { useIsFetching } from '@tanstack/react-query';
import { useAdaptiveLoading } from '../lib/adaptiveLoading';

export default function AdaptiveDebugPanel() {
  if (!import.meta.env?.DEV) return null;

  const { tier, pageSize, isManual, longTaskDowngrades, debug } = useAdaptiveLoading();
  const fetchingAll = useIsFetching();
  const fetchingAssets = useIsFetching({ queryKey: ['assets'] });

  return (
    <div className="fixed bottom-4 right-4 z-[60] text-[11px] bg-black/70 text-white px-3 py-2 rounded-md shadow-lg space-y-1">
      <div className="font-semibold tracking-wide uppercase text-[10px] text-blue-200">
        Adaptive Debug
      </div>
      <div>
        Tier:{' '}
        <span className="font-medium">
          {tier}
        </span>
        {isManual ? ' (manual)' : ''}
      </div>
      <div>Page size: {pageSize}</div>
      <div>
        Fetch in-flight: {fetchingAssets}/{fetchingAll}
      </div>
      <div>Long-task downgrades: {longTaskDowngrades}</div>

      {debug && (
        <div className="mt-2 pt-2 border-t border-white/10 space-y-1 text-[10px]">
          <div className="font-semibold tracking-wide uppercase text-[9px] text-emerald-200">
            Controls
          </div>
          <label className="flex items-center gap-1">
            <span className="whitespace-nowrap">Override page size</span>
            <input
              type="number"
              min={1}
              className="w-16 bg-black/40 border border-white/20 rounded px-1 py-0.5 text-[10px]"
              value={debug.pageSizeOverride ?? ''}
              onChange={(e) => {
                const raw = e.target.value;
                if (!raw) {
                  debug.setPageSizeOverride(null);
                  return;
                }
                const next = Number(raw);
                if (!Number.isFinite(next) || next <= 0) {
                  debug.setPageSizeOverride(null);
                  return;
                }
                debug.setPageSizeOverride(Math.round(next));
              }}
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="whitespace-nowrap">Re-evaluate (ms)</span>
            <input
              type="number"
              min={1000}
              step={1000}
              className="w-20 bg-black/40 border border-white/20 rounded px-1 py-0.5 text-[10px]"
              value={debug.reevaluateMs}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (!Number.isFinite(next) || next <= 0) return;
                debug.setReevaluateMs(next);
              }}
            />
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={debug.disableLongTaskObserver}
              onChange={(e) => debug.setDisableLongTaskObserver(e.target.checked)}
            />
            <span className="whitespace-nowrap">Disable long-task downgrades</span>
          </label>
        </div>
      )}
    </div>
  );
}

