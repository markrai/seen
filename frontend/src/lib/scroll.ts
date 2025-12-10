import { useEffect, useLayoutEffect, useRef } from 'react';

const SCROLL_POS_KEY = 'galleryScrollPosition';
const SCROLL_TO_ID_KEY = 'galleryScrollToId';

export function setManualScrollRestoration() {
  if ('scrollRestoration' in window.history) {
    try {
      window.history.scrollRestoration = 'manual';
    } catch {
      // no-op
    }
  }
}

export function saveGalleryScroll(targetAssetId?: number) {
  const y = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
  try {
    sessionStorage.setItem(SCROLL_POS_KEY, String(y));
    if (typeof targetAssetId === 'number') {
      sessionStorage.setItem(SCROLL_TO_ID_KEY, String(targetAssetId));
    }
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

function scrollToY(y: number) {
  window.scrollTo({ top: y, left: 0, behavior: 'auto' });
  document.documentElement.scrollTop = y;
  if (document.body) document.body.scrollTop = y;
}

function scrollElementIntoMiddle(el: Element) {
  const rect = el.getBoundingClientRect();
  const absoluteTop = rect.top + window.pageYOffset;
  const middle = absoluteTop - window.innerHeight / 2 + rect.height / 2;
  scrollToY(middle);
}

export function useGalleryScrollRestoration(opts: {
  containerRef: React.RefObject<HTMLElement | null>;
  itemsReady: boolean; // true when items for the grid are rendered/populated
  locationKey: string; // unique per navigation, from useLocation().key
}) {
  const { containerRef, itemsReady, locationKey } = opts;
  const restoredForKeyRef = useRef<string | null>(null);

  // First, attempt an immediate lock to prevent jump to top on mount
  useLayoutEffect(() => {
    if (restoredForKeyRef.current === locationKey) return;
    const raw = sessionStorage.getItem(SCROLL_POS_KEY);
    if (raw != null) {
      setManualScrollRestoration();
      const y = parseInt(raw, 10);
      if (!Number.isNaN(y)) {
        scrollToY(y);
      }
    }
  }, [locationKey]);

  useEffect(() => {
    if (restoredForKeyRef.current === locationKey) return;

    const posRaw = sessionStorage.getItem(SCROLL_POS_KEY);
    if (posRaw == null) return; // nothing to restore

    setManualScrollRestoration();
    const y = parseInt(posRaw, 10);
    const idRaw = sessionStorage.getItem(SCROLL_TO_ID_KEY);
    const targetId = idRaw ? parseInt(idRaw, 10) : null;

    const tryRestore = () => {
      // Prefer target element if present
      if (targetId) {
        const el = document.querySelector(`[data-asset-id="${targetId}"]`);
        if (el) {
          scrollElementIntoMiddle(el);
          return true;
        }
      }
      // Fallback to Y position
      if (!Number.isNaN(y)) {
        scrollToY(y);
        return true;
      }
      return false;
    };

    const finalize = () => {
      restoredForKeyRef.current = locationKey;
      try {
        sessionStorage.removeItem(SCROLL_POS_KEY);
        sessionStorage.removeItem(SCROLL_TO_ID_KEY);
      } catch {
        // ignore
      }
    };

    // If items are ready, attempt immediately and with a couple of retries
    if (itemsReady) {
      let done = false;
      const attempt = () => {
        if (!done && tryRestore()) {
          done = true;
          finalize();
        }
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          attempt();
          setTimeout(attempt, 50);
          setTimeout(attempt, 200);
          setTimeout(attempt, 500);
        });
      });
      return;
    }

    // Otherwise, observe the container for children to appear
    const container = containerRef.current;
    if (!container) return;
    let done = false;
    const observer = new MutationObserver(() => {
      if (done) return;
      if (tryRestore()) {
        done = true;
        finalize();
        observer.disconnect();
      }
    });
    observer.observe(container, { childList: true, subtree: true });

    // Fallback timer
    const t = setTimeout(() => {
      if (!done && tryRestore()) {
        done = true;
        finalize();
      }
      observer.disconnect();
    }, 1500);

    return () => {
      observer.disconnect();
      clearTimeout(t);
    };
  }, [itemsReady, containerRef, locationKey]);
}

export const ScrollKeys = {
  position: SCROLL_POS_KEY,
  toId: SCROLL_TO_ID_KEY,
};

