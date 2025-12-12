import { Dialog, Transition } from '@headlessui/react';
import { Fragment, useState } from 'react';
import { MoonIcon, SunIcon, ComputerDesktopIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useUIStore, type DefaultScreen, type FontFamily, type FontSize } from '../lib/store';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import ConfirmDialog from './ConfirmDialog';
import { useStats } from '../lib/hooks';

// Helper function to get smart merge description
function getSmartMergeDescription(level: number): { name: string; description: string; threshold: string } {
  switch (level) {
    case 1:
      return {
        name: 'Most Relaxed',
        description: 'Only merges persons with extremely similar faces. Very conservative approach that minimizes false merges.',
        threshold: '0.40'
      };
    case 2:
      return {
        name: 'Relaxed',
        description: 'Merges only very similar persons. Conservative approach that reduces the chance of incorrect merges.',
        threshold: '0.45'
      };
    case 3:
      return {
        name: 'Default',
        description: 'Balanced merging that combines similar persons while avoiding false positives. Recommended for most use cases.',
        threshold: '0.50'
      };
    case 4:
      return {
        name: 'Aggressive',
        description: 'Merges similar persons more liberally. Useful when you have many duplicate persons that should be combined.',
        threshold: '0.55'
      };
    case 5:
      return {
        name: 'Most Aggressive',
        description: 'Very liberal merging that combines persons with similar but not identical faces. May merge some false positives.',
        threshold: '0.60'
      };
    default:
      return {
        name: 'Default',
        description: 'Balanced merging that combines similar persons while avoiding false positives.',
        threshold: '0.50'
      };
  }
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const defaultScreen = useUIStore((s) => s.defaultScreen);
  const setDefaultScreen = useUIStore((s) => s.setDefaultScreen);
  const dashboardFontFamily = useUIStore((s) => s.dashboardFontFamily);
  const setDashboardFontFamily = useUIStore((s) => s.setDashboardFontFamily);
  const dashboardFontSize = useUIStore((s) => s.dashboardFontSize);
  const setDashboardFontSize = useUIStore((s) => s.setDashboardFontSize);
  const yearsMonthsFontFamily = useUIStore((s) => s.yearsMonthsFontFamily);
  const setYearsMonthsFontFamily = useUIStore((s) => s.setYearsMonthsFontFamily);
  const yearsMonthsFontSize = useUIStore((s) => s.yearsMonthsFontSize);
  const setYearsMonthsFontSize = useUIStore((s) => s.setYearsMonthsFontSize);
  const albumHeadingFontFamily = useUIStore((s) => s.albumHeadingFontFamily);
  const setAlbumHeadingFontFamily = useUIStore((s) => s.setAlbumHeadingFontFamily);
  const albumHeadingFontSize = useUIStore((s) => s.albumHeadingFontSize);
  const setAlbumHeadingFontSize = useUIStore((s) => s.setAlbumHeadingFontSize);
  const showDeleteConfirmation = useUIStore((s) => s.showDeleteConfirmation);
  const setShowDeleteConfirmation = useUIStore((s) => s.setShowDeleteConfirmation);
  const prioritizeFolderStructure = useUIStore((s) => s.prioritizeFolderStructure);
  const setPrioritizeFolderStructure = useUIStore((s) => s.setPrioritizeFolderStructure);
  const prioritizeFilenameDate = useUIStore((s) => s.prioritizeFilenameDate);
  const setPrioritizeFilenameDate = useUIStore((s) => s.setPrioritizeFilenameDate);
  const deleteOriginalFiles = useUIStore((s) => s.deleteOriginalFiles);
  const setDeleteOriginalFiles = useUIStore((s) => s.setDeleteOriginalFiles);
  const smartMergeLevel = useUIStore((s) => s.smartMergeLevel);
  const setSmartMergeLevel = useUIStore((s) => s.setSmartMergeLevel);
  const showAlbumTags = useUIStore((s) => s.showAlbumTags);
  const setShowAlbumTags = useUIStore((s) => s.setShowAlbumTags);
  const albumTagFontColor = useUIStore((s) => s.albumTagFontColor);
  const setAlbumTagFontColor = useUIStore((s) => s.setAlbumTagFontColor);
  const albumTagBackgroundColor = useUIStore((s) => s.albumTagBackgroundColor);
  const setAlbumTagBackgroundColor = useUIStore((s) => s.setAlbumTagBackgroundColor);
  const [activeTab, setActiveTab] = useState<'general' | 'tags' | 'fonts' | 'organization' | 'about'>('general');
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearSuccess, setClearSuccess] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState(false);
  const queryClient = useQueryClient();
  const { data: stats } = useStats();
  // Only fetch health when modal is open (shares query with Footer)
  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health(),
    enabled: isOpen, // Only fetch when modal is open
    staleTime: Infinity, // Health info doesn't change
    refetchInterval: false, // No polling
  });
  
  // Reset stats mutation
  const resetStatsMutation = useMutation({
    mutationFn: () => api.resetStats(),
    onSuccess: () => {
      setResetSuccess(true);
      // Invalidate and refetch stats and performance data
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['performance'] });
      // Clear persisted dashboard values from localStorage
      try {
        localStorage.removeItem('seen_last_scan');
        localStorage.removeItem('seen_last_processing');
      } catch (e) {
        // Ignore localStorage errors
      }
      window.dispatchEvent(new CustomEvent('seen:reset-dashboard-stats'));
      // Reset success state after 3 seconds
      setTimeout(() => {
        setResetSuccess(false);
      }, 3000);
    },
  });
  
  const isScanRunning = stats?.scan_running === true;

  // Check if there's any data to clear
  const hasData = stats?.db?.assets ? stats.db.assets > 0 : false;

  // Reset success state when modal closes
  const handleClose = () => {
    setClearSuccess(false);
    setClearError(null);
    setResetSuccess(false);
    onClose();
  };

  const clearAllDataMutation = useMutation({
    mutationFn: () => api.clearAllData(),
    onSuccess: () => {
      setClearDialogOpen(false);
      setClearError(null);
      setClearSuccess(true);
      // Invalidate queries after showing success state
      // Use a small delay to ensure success state is visible first
      setTimeout(() => {
        // Reset stats and performance-related queries so dashboard shows fresh zeroed values
        queryClient.invalidateQueries({ queryKey: ['stats'] });
        queryClient.invalidateQueries({ queryKey: ['performance'] });
        queryClient.invalidateQueries({ queryKey: ['fileTypes'] });
        // Also clear any cached assets/search results so counts/throughput match the empty DB
        queryClient.invalidateQueries({ queryKey: ['assets'] as any });
        queryClient.invalidateQueries({ queryKey: ['search'] as any });
      }, 100);
      // Reset success state after 3 seconds
      setTimeout(() => {
        setClearSuccess(false);
      }, 3000);
    },
    onError: (error: Error) => {
      setClearError(error.message || 'Failed to clear data. Please try again.');
      // Keep dialog open so user can see the error
    },
  });

  const handleThemeChange = () => {
    setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system');
  };

  const ThemeIcon = theme === 'system' ? ComputerDesktopIcon : theme === 'light' ? SunIcon : MoonIcon;

  const getFontFamilyValue = (font: FontFamily): string => {
    switch (font) {
      case 'system':
        return 'system-ui, -apple-system, sans-serif';
      case 'sans-serif':
        return 'sans-serif';
      case 'serif':
        return 'serif';
      case 'monospace':
        return 'monospace';
      case 'cursive':
        return 'cursive';
      case 'fantasy':
        return 'fantasy';
      case 'yellowtail':
        return "'Yellowtail', cursive";
      default:
        return 'system-ui, -apple-system, sans-serif';
    }
  };

  return (
    <>
      <Transition show={isOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50" onClose={handleClose}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-black/30 dark:bg-black/50" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
              >
                <Dialog.Panel className="w-full max-w-md transform overflow-hidden rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl transition-all flex flex-col max-h-[90vh]">
                  <div className="p-6 pb-0 flex-shrink-0">
                    <div className="flex items-center justify-between mb-6">
                      <Dialog.Title className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                        Settings
                      </Dialog.Title>
                      <button
                        onClick={handleClose}
                        className="p-1 rounded-md text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                      >
                        <XMarkIcon className="size-5" />
                      </button>
                    </div>

                    {/* Tabs */}
                    <div className="flex border-b border-zinc-200 dark:border-zinc-800 mb-6">
                      <button
                        onClick={() => setActiveTab('general')}
                        className={`px-4 py-2 text-sm font-medium transition-colors ${
                          activeTab === 'general'
                            ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                            : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                        }`}
                      >
                        General
                      </button>
                      <button
                        onClick={() => setActiveTab('tags')}
                        className={`px-4 py-2 text-sm font-medium transition-colors ${
                          activeTab === 'tags'
                            ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                            : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                        }`}
                      >
                        Tags
                      </button>
                      <button
                        onClick={() => setActiveTab('fonts')}
                        className={`px-4 py-2 text-sm font-medium transition-colors ${
                          activeTab === 'fonts'
                            ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                            : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                        }`}
                      >
                        Fonts
                      </button>
                      <button
                        onClick={() => setActiveTab('organization')}
                        className={`px-4 py-2 text-sm font-medium transition-colors ${
                          activeTab === 'organization'
                            ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                            : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                        }`}
                      >
                        Organization
                      </button>
                      <button
                        onClick={() => setActiveTab('about')}
                        className={`px-4 py-2 text-sm font-medium transition-colors ${
                          activeTab === 'about'
                            ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                            : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                        }`}
                      >
                        About
                      </button>
                    </div>
                  </div>

                    <div className="px-6 pb-6 overflow-y-auto flex-1 space-y-4">
                      {activeTab === 'general' && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* Column 1 */}
                          <div className="space-y-4">
                            {/* Theme Toggle */}
                            <div>
                              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">
                                Theme
                              </label>
                              <button
                                onClick={handleThemeChange}
                                className="w-full flex items-center justify-between p-2 rounded-md border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                              >
                                <div className="flex items-center gap-2">
                                  <ThemeIcon className="size-3.5 text-zinc-600 dark:text-zinc-400" />
                                  <span className="text-xs text-zinc-900 dark:text-zinc-100">
                                    {theme === 'system' ? 'System' : theme === 'light' ? 'Light' : 'Dark'}
                                  </span>
                                </div>
                                <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                                  {theme === 'system' ? 'Follows system preference' : theme === 'light' ? 'Light mode' : 'Dark mode'}
                                </span>
                              </button>
                            </div>

                            {/* Default Screen */}
                            <div>
                              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">
                                Default Screen
                              </label>
                              <select
                                value={defaultScreen}
                                onChange={(e) => setDefaultScreen(e.target.value as DefaultScreen)}
                                className="w-full p-2 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                              >
                                <option value="dashboard">Dashboard</option>
                                <option value="gallery">Gallery</option>
                                <option value="search">Search</option>
                                <option value="albums">Albums</option>
                                <option value="people">People</option>
                              </select>
                              <p className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                                The screen to show when the app first loads.
                              </p>
                            </div>

                            {/* Reset Dashboard Stats */}
                            <div>
                              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">
                                Dashboard Statistics
                              </label>
                              <button
                                onClick={() => resetStatsMutation.mutate()}
                                disabled={resetStatsMutation.isPending || isScanRunning || resetSuccess}
                                className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-xs font-medium ${
                                  resetSuccess
                                    ? 'bg-green-600 text-white hover:bg-green-700'
                                    : 'bg-blue-600 text-white hover:bg-blue-700'
                                }`}
                                title={isScanRunning ? "Cannot reset stats while scan is running" : "Reset dashboard performance statistics"}
                              >
                                {resetSuccess ? (
                                  <>
                                    <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                    </svg>
                                    <span>Stats Reset</span>
                                  </>
                                ) : resetStatsMutation.isPending ? (
                                  'Resetting...'
                                ) : (
                                  'Reset Dashboard Stats'
                                )}
                              </button>
                              <p className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                                Reset performance statistics (files discovered, files catalogued, rates, etc.) on the dashboard. This does not delete any data from the database.
                              </p>
                            </div>
                          </div>

                          {/* Column 2 */}
                          <div className="space-y-4">
                            {/* Delete Confirmation Toggle */}
                            <div>
                              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">
                                Delete Confirmation
                              </label>
                              <div className="flex items-center justify-between p-2 rounded-md border border-zinc-200 dark:border-zinc-700">
                                <span className="text-xs text-zinc-900 dark:text-zinc-100">
                                  Show confirmation dialog when deleting
                                </span>
                                <label className="relative inline-flex items-center cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={showDeleteConfirmation}
                                    onChange={(e) => setShowDeleteConfirmation(e.target.checked)}
                                    className="sr-only peer"
                                  />
                                  <div className="w-10 h-5 bg-zinc-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-zinc-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-zinc-600 peer-checked:bg-blue-600"></div>
                                </label>
                              </div>
                              <p className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                                When disabled, items will be deleted immediately without confirmation.
                              </p>
                            </div>

                            {/* Delete Originals Toggle */}
                            <div>
                              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">
                                Delete Original Files
                              </label>
                              <div className="flex items-center justify-between p-2 rounded-md border border-zinc-200 dark:border-zinc-700">
                                <span className="text-xs text-zinc-900 dark:text-zinc-100">
                                  Remove files from disk when deleting
                                </span>
                                <label className="relative inline-flex items-center cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={deleteOriginalFiles}
                                    onChange={(e) => setDeleteOriginalFiles(e.target.checked)}
                                    className="sr-only peer"
                                  />
                                  <div className="w-10 h-5 bg-zinc-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-zinc-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-zinc-600 peer-checked:bg-blue-600"></div>
                                </label>
                              </div>
                              <p className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                                Default behavior keeps the original file on disk. Enable this to also delete the source file and generated previews.
                              </p>
                            </div>

                            {/* Clear Data */}
                            <div>
                              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">
                                Data Management
                              </label>
                              <button
                                onClick={() => {
                                  setClearDialogOpen(true);
                                  setClearSuccess(false);
                                  setClearError(null);
                                }}
                                disabled={clearAllDataMutation.isPending || (!hasData && !clearSuccess)}
                                className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-xs font-medium ${
                                  clearSuccess
                                    ? 'bg-green-600 text-white hover:bg-green-700'
                                    : !hasData
                                    ? 'bg-zinc-400 dark:bg-zinc-600 text-white cursor-not-allowed'
                                    : 'bg-red-600 text-white hover:bg-red-700'
                                }`}
                              >
                                {clearSuccess ? (
                                  <>
                                    <svg className="size-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                    </svg>
                                    <span>All data cleared</span>
                                  </>
                                ) : !hasData ? (
                                  <>
                                    <XMarkIcon className="size-3.5" />
                                    <span>No data to clear</span>
                                  </>
                                ) : (
                                  <>
                                    <XMarkIcon className="size-3.5" />
                                    <span>Clear All Data</span>
                                  </>
                                )}
                              </button>
                              {clearError && (
                                <p className="mt-0.5 text-[10px] text-red-600 dark:text-red-400">
                                  {clearError}
                                </p>
                              )}
                              <p className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                                Permanently delete all assets, faces, and persons from the database.
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {activeTab === 'tags' && (
                        <>
                          {/* Show Album Tags Toggle */}
                          <div>
                            <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 block">
                              Show Album Tags
                            </label>
                            <div className="flex items-center justify-between p-3 rounded-md border border-zinc-200 dark:border-zinc-700">
                              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                                Display album names on photos in the gallery view
                              </span>
                              <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={showAlbumTags}
                                  onChange={(e) => setShowAlbumTags(e.target.checked)}
                                  className="sr-only peer"
                                />
                                <div className="w-11 h-6 bg-zinc-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-zinc-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-zinc-600 peer-checked:bg-blue-600"></div>
                              </label>
                            </div>
                            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                              When enabled, photos in the gallery will show small tags with album names in the top right corner. Tags are stacked when photos are in multiple albums.
                            </p>
                          </div>

                          {/* Tag Styling */}
                          {showAlbumTags && (
                            <div>
                              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 block">
                                Album Tags Styling
                              </label>
                              <div className="grid grid-cols-3 gap-4 items-center">
                                {/* Preview */}
                                <div className="p-3 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 relative" style={{ minHeight: '60px' }}>
                                  <div className="absolute top-2 right-2">
                                    <div
                                      className="px-2 py-0.5 rounded text-[10px] font-medium backdrop-blur-sm"
                                      style={{
                                        color: albumTagFontColor,
                                        backgroundColor: albumTagBackgroundColor,
                                      }}
                                    >
                                      Sample Album
                                    </div>
                                  </div>
                                  <p className="text-[10px] text-zinc-500 dark:text-zinc-400 absolute bottom-2 left-2">
                                    Preview
                                  </p>
                                </div>

                                {/* Font Color */}
                                <div className="flex items-center gap-2">
                                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                                    Font Color:
                                  </label>
                                  <input
                                    type="color"
                                    value={albumTagFontColor}
                                    onChange={(e) => setAlbumTagFontColor(e.target.value)}
                                    className="w-12 h-10 rounded border border-zinc-200 dark:border-zinc-700 cursor-pointer"
                                  />
                                </div>

                                {/* Background Color */}
                                <div className="flex items-center gap-2">
                                  <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                                    Background:
                                  </label>
                                  <input
                                    type="color"
                                    value={albumTagBackgroundColor}
                                    onChange={(e) => setAlbumTagBackgroundColor(e.target.value)}
                                    className="w-12 h-10 rounded border border-zinc-200 dark:border-zinc-700 cursor-pointer"
                                  />
                                </div>
                              </div>
                            </div>
                          )}
                        </>
                      )}

                      {activeTab === 'fonts' && (
                        <>
                          {/* Dashboard Stats Font */}
                          <div>
                            <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 block">
                              Dashboard Stats Font
                            </label>
                            <div className="grid grid-cols-2 gap-3">
                              <select
                                value={dashboardFontFamily}
                                onChange={(e) => setDashboardFontFamily(e.target.value as FontFamily)}
                                className="w-full p-3 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                style={{ fontFamily: getFontFamilyValue(dashboardFontFamily) }}
                              >
                                <option value="system" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>System</option>
                                <option value="sans-serif" style={{ fontFamily: 'sans-serif' }}>Sans-serif</option>
                                <option value="serif" style={{ fontFamily: 'serif' }}>Serif</option>
                                <option value="monospace" style={{ fontFamily: 'monospace' }}>Monospace</option>
                                <option value="cursive" style={{ fontFamily: 'cursive' }}>Cursive</option>
                                <option value="fantasy" style={{ fontFamily: 'fantasy' }}>Fantasy</option>
                                <option value="yellowtail" style={{ fontFamily: "'Yellowtail', cursive" }}>Yellowtail</option>
                              </select>
                              <select
                                value={dashboardFontSize}
                                onChange={(e) => setDashboardFontSize(e.target.value as FontSize)}
                                className="w-full p-3 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                              >
                                <option value="xs">Extra Small</option>
                                <option value="sm">Small</option>
                                <option value="base">Base</option>
                                <option value="lg">Large</option>
                                <option value="xl">Extra Large</option>
                                <option value="2xl">2X Large</option>
                                <option value="3xl">3X Large</option>
                                <option value="4xl">4X Large</option>
                              </select>
                            </div>
                            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                              Font family for dashboard stats text.
                            </p>
                          </div>

                          {/* Years & Months Font */}
                          <div>
                            <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 block">
                              Years & Months
                            </label>
                            <div className="grid grid-cols-2 gap-3">
                              <select
                                value={yearsMonthsFontFamily}
                                onChange={(e) => setYearsMonthsFontFamily(e.target.value as FontFamily)}
                                className="w-full p-3 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                style={{ fontFamily: getFontFamilyValue(yearsMonthsFontFamily) }}
                              >
                                <option value="system" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>System</option>
                                <option value="sans-serif" style={{ fontFamily: 'sans-serif' }}>Sans-serif</option>
                                <option value="serif" style={{ fontFamily: 'serif' }}>Serif</option>
                                <option value="monospace" style={{ fontFamily: 'monospace' }}>Monospace</option>
                                <option value="cursive" style={{ fontFamily: 'cursive' }}>Cursive</option>
                                <option value="fantasy" style={{ fontFamily: 'fantasy' }}>Fantasy</option>
                                <option value="yellowtail" style={{ fontFamily: "'Yellowtail', cursive" }}>Yellowtail</option>
                              </select>
                              <select
                                value={yearsMonthsFontSize}
                                onChange={(e) => setYearsMonthsFontSize(e.target.value as FontSize)}
                                className="w-full p-3 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                              >
                                <option value="xs">Extra Small</option>
                                <option value="sm">Small</option>
                                <option value="base">Base</option>
                                <option value="lg">Large</option>
                                <option value="xl">Extra Large</option>
                                <option value="2xl">2X Large</option>
                                <option value="3xl">3X Large</option>
                                <option value="4xl">4X Large</option>
                              </select>
                            </div>
                            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                              Font family for year and month labels in the gallery view.
                            </p>
                          </div>

                          {/* Album Heading Font */}
                          <div>
                            <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 block">
                              Album Heading
                            </label>
                            <div className="grid grid-cols-2 gap-3">
                              <select
                                value={albumHeadingFontFamily}
                                onChange={(e) => setAlbumHeadingFontFamily(e.target.value as FontFamily)}
                                className="w-full p-3 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                style={{ fontFamily: getFontFamilyValue(albumHeadingFontFamily) }}
                              >
                                <option value="system" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>System</option>
                                <option value="sans-serif" style={{ fontFamily: 'sans-serif' }}>Sans-serif</option>
                                <option value="serif" style={{ fontFamily: 'serif' }}>Serif</option>
                                <option value="monospace" style={{ fontFamily: 'monospace' }}>Monospace</option>
                                <option value="cursive" style={{ fontFamily: 'cursive' }}>Cursive</option>
                                <option value="fantasy" style={{ fontFamily: 'fantasy' }}>Fantasy</option>
                                <option value="yellowtail" style={{ fontFamily: "'Yellowtail', cursive" }}>Yellowtail</option>
                              </select>
                              <select
                                value={albumHeadingFontSize}
                                onChange={(e) => setAlbumHeadingFontSize(e.target.value as FontSize)}
                                className="w-full p-3 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                              >
                                <option value="xs">Extra Small</option>
                                <option value="sm">Small</option>
                                <option value="base">Base</option>
                                <option value="lg">Large</option>
                                <option value="xl">Extra Large</option>
                                <option value="2xl">2X Large</option>
                                <option value="3xl">3X Large</option>
                                <option value="4xl">4X Large</option>
                              </select>
                            </div>
                            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                              Font family for album names in the albums view.
                            </p>
                          </div>
                        </>
                      )}

                      {activeTab === 'organization' && (
                        <>
                          {/* Prioritize Folder Structure Toggle */}
                          <div>
                            <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 block">
                              Prioritize Folder Structure over Metadata
                            </label>
                            <div className="flex items-center justify-between p-3 rounded-md border border-zinc-200 dark:border-zinc-700">
                              <span className="text-sm text-zinc-900 dark:text-zinc-100">
                                Organize photos based on folder structure
                              </span>
                              <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={prioritizeFolderStructure}
                                  onChange={(e) => setPrioritizeFolderStructure(e.target.checked)}
                                  className="sr-only peer"
                                />
                                <div className="w-11 h-6 bg-zinc-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-zinc-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-zinc-600 peer-checked:bg-blue-600"></div>
                              </label>
                            </div>
                            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                              When enabled, photos will be grouped by year and month extracted from folder paths (e.g., /2025/01/, /2025/January/) instead of using metadata dates. Recognizes numeric patterns (01-12) and month names (January, Jan, etc.).
                            </p>
                          </div>

                          {/* Prioritize by Filename Sub-toggle */}
                          {prioritizeFolderStructure && (
                            <div className="ml-4 mt-4">
                              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 block">
                                Prioritize by Filename
                              </label>
                              <div className="flex items-center justify-between p-3 rounded-md border border-zinc-200 dark:border-zinc-700">
                                <span className="text-sm text-zinc-900 dark:text-zinc-100">
                                  Extract date from filename first
                                </span>
                                <label className="relative inline-flex items-center cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={prioritizeFilenameDate}
                                    onChange={(e) => setPrioritizeFilenameDate(e.target.checked)}
                                    className="sr-only peer"
                                  />
                                  <div className="w-11 h-6 bg-zinc-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-zinc-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-zinc-600 peer-checked:bg-blue-600"></div>
                                </label>
                              </div>
                              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                                When enabled, dates found in filenames (e.g., 2025-01-15_photo.jpg, IMG_20250115.jpg) will take priority over folder structure. Recognizes formats: YYYY-MM-DD, YYYYMMDD, YYYY-MM, DD-MM-YYYY, MM-DD-YYYY.
                              </p>
                            </div>
                          )}
                        </>
                      )}

                      {activeTab === 'about' && (
                        <>
                          <div className="relative">
                            {/* Watermark logo background */}
                            <div 
                              className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-10 dark:opacity-100"
                              style={{
                                backgroundImage: 'url(/seen.png)',
                                backgroundRepeat: 'no-repeat',
                                backgroundPosition: 'center top',
                                backgroundSize: '80%',
                                minHeight: '200px',
                                top: '-20px'
                              }}
                            />
                            
                            {/* Content on top */}
                            <div className="relative z-10">
                              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
                                Attributions
                              </h3>
                              
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              {/* Frontend Libraries */}
                              <div>
                                <h4 className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-2 uppercase tracking-wide">
                                  Frontend
                                </h4>
                                <div className="space-y-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                                  <div>@headlessui/react - UI components</div>
                                  <div>@heroicons/react - Icon library</div>
                                  <div>@tanstack/react-query - Data fetching and caching</div>
                                  <div>d3 - Data visualization</div>
                                  <div>jszip - ZIP file handling</div>
                                  <div>react - UI framework</div>
                                  <div>react-dom - React DOM renderer</div>
                                  <div>react-router-dom - Routing</div>
                                  <div>recharts - Chart library</div>
                                  <div>zustand - State management</div>
                                  <div>tailwindcss - CSS framework</div>
                                  <div>vite - Build tool</div>
                                  <div>typescript - Type safety</div>
                                </div>
                              </div>

                              {/* Backend Libraries */}
                              <div>
                                <h4 className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-2 uppercase tracking-wide">
                                  Backend
                                </h4>
                                <div className="space-y-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                                  {Array.isArray(health?.backend_libraries) && health.backend_libraries.length > 0 ? (
                                    health.backend_libraries.map((lib: string, idx: number) => (
                                      <div key={idx}>{lib}</div>
                                    ))
                                  ) : (
                                    <div className="text-zinc-400 dark:text-zinc-500">Loading...</div>
                                  )}
                                </div>
                              </div>
                            </div>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition>

      <ConfirmDialog
        isOpen={clearDialogOpen}
        onClose={() => {
          if (!clearAllDataMutation.isPending) {
            setClearDialogOpen(false);
            setClearSuccess(false);
            setClearError(null);
          }
        }}
        onConfirm={() => {
          if (clearError) {
            // If there's an error, close the dialog
            setClearDialogOpen(false);
            setClearError(null);
            return;
          }
          if (!clearAllDataMutation.isPending) {
            setClearError(null);
            clearAllDataMutation.mutate();
          }
        }}
        title="Clear All Data"
        message={
          clearError
            ? `Error: ${clearError}\n\nPlease close this dialog and try again.`
            : "This will permanently delete ALL assets, faces, and persons from the database. This action cannot be undone. Are you sure you want to start from scratch?"
        }
        confirmText={
          clearError
            ? 'Close'
            : clearAllDataMutation.isPending
            ? 'Clearing...'
            : 'Clear All Data'
        }
        variant="danger"
        preventAutoClose={!!clearError || clearAllDataMutation.isPending}
      />
    </>
  );
}

