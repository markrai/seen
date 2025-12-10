import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { MagnifyingGlassIcon, Cog6ToothIcon } from '@heroicons/react/24/outline';
import SettingsModal from './SettingsModal';
import { useUIStore } from '../lib/store';

export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const [q, setQ] = useState(params.get('q') || '');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setQ(params.get('q') || '');
  }, [search]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const isFetching = useUIStore((s) => s.isFetching);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Preserve existing query params (including advanced filters) when searching,
    // but update the q parameter to the new query.
    const current = new URLSearchParams(search);
    if (q) {
      current.set('q', q);
    } else {
      current.delete('q');
    }
    const qs = current.toString();
    navigate(qs ? `/search?${qs}` : '/search');
  };

  const isActive = (path: string) => {
    if (path === '/') {
      return location.pathname === '/' || location.pathname === '';
    }
    return location.pathname.startsWith(path);
  };

  const linkClass = (path: string) => {
    const baseClass = "py-1 transition-colors";
    if (isActive(path)) {
      return `${baseClass} text-blue-600 dark:text-blue-400 font-kalam-bold`;
    }
    return `${baseClass} hover:text-blue-600 dark:hover:text-blue-400 font-kalam`;
  };

  return (
    <header className="border-b border-zinc-200/60 dark:border-zinc-800 sticky top-0 bg-white/70 dark:bg-zinc-900/70 backdrop-blur z-40">
      <div className="container-responsive min-h-14 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 py-2 sm:py-0">
        <Link to="/" className="hidden sm:flex items-center mr-2 sm:mr-4 flex-shrink-0 relative">
          <img
            src="/seen.png"
            alt="Seen"
            className="h-8 w-auto dark:invert dark:brightness-0 dark:contrast-200"
            onError={(e) => {
              // Hide the broken image
              const target = e.target as HTMLImageElement;
              target.style.display = 'none';
            }}
          />
          {/* Fetching indicator dot */}
          <div
            className={`absolute top-1/2 right-0 w-1.5 h-1.5 rounded-full transition-colors ${
              isFetching ? 'bg-green-500' : 'bg-zinc-400 dark:bg-zinc-600'
            }`}
            title={isFetching ? 'Fetching...' : 'Idle'}
            style={{ transform: 'translate(60%, 65%)' }}
          />
        </Link>
        <div className="flex items-center justify-between">
          <nav className="flex sm:hidden gap-0.5 sm:gap-1.5 text-xs overflow-x-auto flex-1 min-w-0">
            <Link to="/" className={`${linkClass('/')} whitespace-nowrap px-1`}>Dashboard</Link>
            <Link to="/gallery" className={`${linkClass('/gallery')} whitespace-nowrap px-1`}>Gallery</Link>
            <Link to="/search" className={`${linkClass('/search')} whitespace-nowrap px-1`}>Search</Link>
            <Link to="/albums" className={`${linkClass('/albums')} whitespace-nowrap px-1`}>Albums</Link>
            <Link to="/people" className={`${linkClass('/people')} whitespace-nowrap px-1`}>People</Link>
            <Link to="/" className="ml-auto flex-shrink-0">
              <img
                src="/seen.png"
                alt="Seen"
                className="h-[1.2rem] w-auto dark:invert dark:brightness-0 dark:contrast-200"
                onError={(e) => {
                  // Hide the broken image
                  const target = e.target as HTMLImageElement;
                  target.style.display = 'none';
                }}
              />
            </Link>
          </nav>
        </div>
        <nav className="hidden sm:flex gap-4 text-sm">
          <Link to="/" className={`${linkClass('/')} px-2`}>Dashboard</Link>
          <Link to="/gallery" className={`${linkClass('/gallery')} px-2`}>Gallery</Link>
          <Link to="/search" className={`${linkClass('/search')} px-2`}>Search</Link>
          <Link to="/albums" className={`${linkClass('/albums')} px-2`}>Albums</Link>
          <Link to="/people" className={`${linkClass('/people')} px-2`}>People</Link>
        </nav>
        <form onSubmit={onSubmit} className="flex items-center gap-1.5 sm:gap-2 w-full sm:ml-auto sm:max-w-xl">
          <div className="relative flex-1 min-w-0">
            <MagnifyingGlassIcon className="absolute left-2 top-1/2 -translate-y-1/2 size-4 sm:size-5 text-zinc-400" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              placeholder="Search..."
              className="w-full pl-8 sm:pl-9 pr-2 sm:pr-3 py-1.5 sm:py-2 rounded-md bg-zinc-100 dark:bg-zinc-800 outline-none border border-transparent focus:border-blue-500 text-xs sm:text-sm sm:text-base"
            />
          </div>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            className="p-1.5 sm:p-2 rounded-md border border-zinc-200 dark:border-zinc-700 flex-shrink-0 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <Cog6ToothIcon className="size-4 sm:size-5" />
          </button>
        </form>
      </div>
      <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}

