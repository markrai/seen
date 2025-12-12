import { create } from 'zustand';

type Theme = 'system' | 'light' | 'dark';
export type DefaultScreen = 'dashboard' | 'gallery' | 'search' | 'albums' | 'people';
export type FontFamily = 'system' | 'serif' | 'sans-serif' | 'monospace' | 'cursive' | 'fantasy' | 'yellowtail';
export type FontSize = 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';

interface UIState {
  gridSize: number; // min tile width
  setGridSize: (px: number) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  showDeleteConfirmation: boolean;
  setShowDeleteConfirmation: (show: boolean) => void;
  defaultScreen: DefaultScreen;
  setDefaultScreen: (screen: DefaultScreen) => void;
  dashboardFontFamily: FontFamily;
  setDashboardFontFamily: (font: FontFamily) => void;
  dashboardFontSize: FontSize;
  setDashboardFontSize: (size: FontSize) => void;
  yearsMonthsFontFamily: FontFamily;
  setYearsMonthsFontFamily: (font: FontFamily) => void;
  yearsMonthsFontSize: FontSize;
  setYearsMonthsFontSize: (size: FontSize) => void;
  albumHeadingFontFamily: FontFamily;
  setAlbumHeadingFontFamily: (font: FontFamily) => void;
  albumHeadingFontSize: FontSize;
  setAlbumHeadingFontSize: (size: FontSize) => void;
  playbackSpeed: number;
  setPlaybackSpeed: (speed: number) => void;
  prioritizeFolderStructure: boolean;
  setPrioritizeFolderStructure: (value: boolean) => void;
  prioritizeFilenameDate: boolean;
  setPrioritizeFilenameDate: (value: boolean) => void;
  deleteOriginalFiles: boolean;
  setDeleteOriginalFiles: (value: boolean) => void;
  smartMergeLevel: number; // 1-5, where 3 is default (middle)
  setSmartMergeLevel: (level: number) => void;
  isFetching: boolean;
  setIsFetching: (value: boolean) => void;
  showAlbumTags: boolean;
  setShowAlbumTags: (show: boolean) => void;
  albumTagFontColor: string;
  setAlbumTagFontColor: (color: string) => void;
  albumTagBackgroundColor: string;
  setAlbumTagBackgroundColor: (color: string) => void;
}

const THEME_KEY = 'seen.theme';
const GRID_KEY = 'seen.gridSize';
const DELETE_CONFIRM_KEY = 'seen.showDeleteConfirmation';
const DEFAULT_SCREEN_KEY = 'seen.defaultScreen';
const DASHBOARD_FONT_KEY = 'seen.dashboardFontFamily';
const DASHBOARD_FONT_SIZE_KEY = 'seen.dashboardFontSize';
const YEARS_MONTHS_FONT_KEY = 'seen.yearsMonthsFontFamily';
const YEARS_MONTHS_FONT_SIZE_KEY = 'seen.yearsMonthsFontSize';
const ALBUM_HEADING_FONT_KEY = 'seen.albumHeadingFontFamily';
const ALBUM_HEADING_FONT_SIZE_KEY = 'seen.albumHeadingFontSize';
const PLAYBACK_SPEED_KEY = 'seen.playbackSpeed';
const PRIORITIZE_FOLDER_STRUCTURE_KEY = 'seen.prioritizeFolderStructure';
const PRIORITIZE_FILENAME_DATE_KEY = 'seen.prioritizeFilenameDate';
const DELETE_ORIGINALS_KEY = 'seen.deleteOriginalFiles';
const SMART_MERGE_MODE_KEY = 'seen.smartMergeMode';
const SHOW_ALBUM_TAGS_KEY = 'seen.showAlbumTags';
const ALBUM_TAG_FONT_COLOR_KEY = 'seen.albumTagFontColor';
const ALBUM_TAG_BACKGROUND_COLOR_KEY = 'seen.albumTagBackgroundColor';

function sanitizeHexColor(color: string, fallback: string): string {
  if (!color) return fallback;
  // If color has alpha (#RRGGBBAA), drop alpha; accept only #RRGGBB
  if (color.startsWith('#') && color.length === 9) {
    return color.slice(0, 7);
  }
  // Accept valid #RRGGBB
  if (color.startsWith('#') && color.length === 7) {
    return color;
  }
  return fallback;
}

// Module-level variable to track system theme listener
let systemThemeListener: ((e: MediaQueryListEvent) => void) | null = null;

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  if (typeof window === 'undefined') return;
  
  const root = document.documentElement;
  
  // Remove dark class first
  root.classList.remove('dark');
  
  // Apply the theme
  if (theme === 'system') {
    // Apply system preference - only add 'dark' class if system prefers dark
    const systemTheme = getSystemTheme();
    if (systemTheme === 'dark') {
      root.classList.add('dark');
    }
  } else if (theme === 'dark') {
    root.classList.add('dark');
  }
  // else: theme === 'light' - dark class already removed above
}

export const useUIStore = create<UIState>((set, get) => {
  // Initialize theme from localStorage
  const initialTheme = (localStorage.getItem(THEME_KEY) as Theme) || 'system';
  
  // Apply theme immediately on store creation
  if (typeof window !== 'undefined') {
    applyTheme(initialTheme);
    
    // Set up system theme listener if needed
    if (initialTheme === 'system') {
      systemThemeListener = (e: MediaQueryListEvent) => {
        const currentTheme = get().theme;
        if (currentTheme === 'system') {
          const root = document.documentElement;
          if (e.matches) {
            root.classList.add('dark');
          } else {
            root.classList.remove('dark');
          }
        }
      };
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', systemThemeListener);
    }
  }
  
  return {
    gridSize: Number(localStorage.getItem(GRID_KEY) || 200),
    setGridSize: (px) => {
      localStorage.setItem(GRID_KEY, String(px));
      set({ gridSize: px });
    },
    theme: initialTheme,
    setTheme: (t) => {
      localStorage.setItem(THEME_KEY, t);
      applyTheme(t);
      set({ theme: t });
      
      // Update system theme listener
      if (typeof window !== 'undefined') {
        if (systemThemeListener) {
          window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', systemThemeListener);
        }
        
        if (t === 'system') {
          systemThemeListener = (e: MediaQueryListEvent) => {
            const root = document.documentElement;
            if (e.matches) {
              root.classList.add('dark');
            } else {
              root.classList.remove('dark');
            }
          };
          window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', systemThemeListener);
        } else {
          systemThemeListener = null;
        }
      }
    },
    showDeleteConfirmation: localStorage.getItem(DELETE_CONFIRM_KEY) !== 'false',
    setShowDeleteConfirmation: (show) => {
      localStorage.setItem(DELETE_CONFIRM_KEY, String(show));
      set({ showDeleteConfirmation: show });
    },
    defaultScreen: (localStorage.getItem(DEFAULT_SCREEN_KEY) as DefaultScreen) || 'dashboard',
    setDefaultScreen: (screen) => {
      localStorage.setItem(DEFAULT_SCREEN_KEY, screen);
      set({ defaultScreen: screen });
    },
    dashboardFontFamily: (localStorage.getItem(DASHBOARD_FONT_KEY) as FontFamily) || 'system',
    setDashboardFontFamily: (font) => {
      localStorage.setItem(DASHBOARD_FONT_KEY, font);
      set({ dashboardFontFamily: font });
    },
    dashboardFontSize: (localStorage.getItem(DASHBOARD_FONT_SIZE_KEY) as FontSize) || 'base',
    setDashboardFontSize: (size) => {
      localStorage.setItem(DASHBOARD_FONT_SIZE_KEY, size);
      set({ dashboardFontSize: size });
    },
    yearsMonthsFontFamily: (localStorage.getItem(YEARS_MONTHS_FONT_KEY) as FontFamily) || 'system',
    setYearsMonthsFontFamily: (font) => {
      localStorage.setItem(YEARS_MONTHS_FONT_KEY, font);
      set({ yearsMonthsFontFamily: font });
    },
    yearsMonthsFontSize: (localStorage.getItem(YEARS_MONTHS_FONT_SIZE_KEY) as FontSize) || 'base',
    setYearsMonthsFontSize: (size) => {
      localStorage.setItem(YEARS_MONTHS_FONT_SIZE_KEY, size);
      set({ yearsMonthsFontSize: size });
    },
    albumHeadingFontFamily: (localStorage.getItem(ALBUM_HEADING_FONT_KEY) as FontFamily) || 'yellowtail',
    setAlbumHeadingFontFamily: (font) => {
      localStorage.setItem(ALBUM_HEADING_FONT_KEY, font);
      set({ albumHeadingFontFamily: font });
    },
    albumHeadingFontSize: (localStorage.getItem(ALBUM_HEADING_FONT_SIZE_KEY) as FontSize) || 'base',
    setAlbumHeadingFontSize: (size) => {
      localStorage.setItem(ALBUM_HEADING_FONT_SIZE_KEY, size);
      set({ albumHeadingFontSize: size });
    },
    playbackSpeed: Number(localStorage.getItem(PLAYBACK_SPEED_KEY) || 1.0),
    setPlaybackSpeed: (speed) => {
      localStorage.setItem(PLAYBACK_SPEED_KEY, String(speed));
      set({ playbackSpeed: speed });
    },
    prioritizeFolderStructure: localStorage.getItem(PRIORITIZE_FOLDER_STRUCTURE_KEY) !== null 
      ? localStorage.getItem(PRIORITIZE_FOLDER_STRUCTURE_KEY) === 'true' 
      : true,
    setPrioritizeFolderStructure: (value) => {
      localStorage.setItem(PRIORITIZE_FOLDER_STRUCTURE_KEY, String(value));
      set({ prioritizeFolderStructure: value });
    },
    prioritizeFilenameDate: localStorage.getItem(PRIORITIZE_FILENAME_DATE_KEY) !== null 
      ? localStorage.getItem(PRIORITIZE_FILENAME_DATE_KEY) === 'true' 
      : true,
    setPrioritizeFilenameDate: (value) => {
      localStorage.setItem(PRIORITIZE_FILENAME_DATE_KEY, String(value));
      set({ prioritizeFilenameDate: value });
    },
    deleteOriginalFiles: localStorage.getItem(DELETE_ORIGINALS_KEY) === 'true',
    setDeleteOriginalFiles: (value) => {
      localStorage.setItem(DELETE_ORIGINALS_KEY, String(value));
      set({ deleteOriginalFiles: value });
    },
    smartMergeLevel: Number(localStorage.getItem(SMART_MERGE_MODE_KEY) || 4),
    setSmartMergeLevel: (level) => {
      const clampedLevel = Math.max(1, Math.min(5, level)); // Ensure 1-5 range
      localStorage.setItem(SMART_MERGE_MODE_KEY, String(clampedLevel));
      set({ smartMergeLevel: clampedLevel });
    },
    isFetching: false,
    setIsFetching: (value) => {
      set({ isFetching: value });
    },
    showAlbumTags: localStorage.getItem(SHOW_ALBUM_TAGS_KEY) === 'true',
    setShowAlbumTags: (show) => {
      localStorage.setItem(SHOW_ALBUM_TAGS_KEY, String(show));
      set({ showAlbumTags: show });
    },
    albumTagFontColor: sanitizeHexColor(localStorage.getItem(ALBUM_TAG_FONT_COLOR_KEY) || '', '#ffffff'),
    setAlbumTagFontColor: (color) => {
      const safe = sanitizeHexColor(color, '#ffffff');
      localStorage.setItem(ALBUM_TAG_FONT_COLOR_KEY, safe);
      set({ albumTagFontColor: safe });
    },
    albumTagBackgroundColor: sanitizeHexColor(localStorage.getItem(ALBUM_TAG_BACKGROUND_COLOR_KEY) || '', '#000000'),
    setAlbumTagBackgroundColor: (color) => {
      const safe = sanitizeHexColor(color, '#000000');
      localStorage.setItem(ALBUM_TAG_BACKGROUND_COLOR_KEY, safe);
      set({ albumTagBackgroundColor: safe });
    },
  };
});

