import { useStats } from '../lib/hooks';
import { secondsToHms, formatNumber } from '../lib/utils';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export default function Footer() {
  const { data } = useStats();
  const location = useLocation();
  const isDashboard = location.pathname === '/' || location.pathname === '/dashboard';
  
  // Fetch health info to get version and database type (fetch once, no polling)
  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    staleTime: Infinity, // Health info doesn't change, fetch once
    refetchInterval: false, // Remove polling
    retry: 1, // Only retry once
  });
  
  return (
    <footer className="border-t border-zinc-200/60 dark:border-zinc-800 mt-6">
      <div className="container-responsive py-3 text-xs flex flex-wrap gap-x-6 gap-y-2 items-center">
        {!isDashboard && (
          <>
            <div>
              Uptime: <span className="tabular-nums">{data ? secondsToHms(data.uptime_seconds) : '—'}</span>
            </div>
            <div>
              Total assets: <span className="tabular-nums">{data ? formatNumber(data.db.assets) : '—'}</span>
            </div>
            <div>
              Queues: disc {data?.queues.discover ?? '—'}, hash {data?.queues.hash ?? '—'}, meta {data?.queues.metadata ?? '—'},
              thumb {data?.queues.thumb ?? '—'}
            </div>
          </>
        )}
        <div className={`${isDashboard ? 'ml-auto' : 'ml-auto'} opacity-70 font-kalam`}>
          {health ? (
            <>version {health.version} {health.database}</>
          ) : (
            <>version 0.9</>
          )}
        </div>
      </div>
    </footer>
  );
}

