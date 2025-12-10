import { useEffect, useState } from 'react';

interface TimelineProps {
  items: string[];
  onItemClick: (item: string) => void;
  itemRefsMap: Map<string, HTMLDivElement>;
  formatLabel?: (item: string) => string;
}

export default function Timeline({ items, onItemClick, itemRefsMap, formatLabel }: TimelineProps) {
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  // Track which item is currently in view and scroll position
  useEffect(() => {
    const handleScroll = () => {
      const viewportTop = window.scrollY;
      const viewportBottom = viewportTop + window.innerHeight;
      const viewportCenter = viewportTop + window.innerHeight / 2;

      // Show timeline after scrolling down a bit (e.g., 200px)
      setIsVisible(viewportTop > 200);

      // Find the item that is closest to the viewport center
      let closestItem: string | null = null;
      let closestDistance = Infinity;

      items.forEach((item) => {
        const element = itemRefsMap.get(item);
        if (element) {
          const rect = element.getBoundingClientRect();
          const elementTop = rect.top + window.scrollY;
          const elementBottom = elementTop + rect.height;
          const elementCenter = elementTop + rect.height / 2;

          // Check if the item section is in view
          if (elementTop <= viewportBottom && elementBottom >= viewportTop) {
            const distance = Math.abs(elementCenter - viewportCenter);
            if (distance < closestDistance) {
              closestDistance = distance;
              closestItem = item;
            }
          }
        }
      });

      setActiveItem(closestItem);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll(); // Initial check

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, [items, itemRefsMap]);

  // Don't show anything if no active item
  if (!activeItem) {
    return null;
  }

  const displayLabel = formatLabel ? formatLabel(activeItem) : activeItem;

  return (
    <div 
      className={`fixed right-4 top-1/2 -translate-y-1/2 z-30 hidden lg:block transition-opacity duration-300 ${
        isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      <button
        onClick={() => onItemClick(activeItem)}
        className="px-4 py-2 text-sm font-medium rounded-md transition-all
          border border-zinc-400 dark:border-zinc-600
          text-zinc-700 dark:text-zinc-300 bg-white dark:bg-zinc-900
          hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800
          shadow-lg font-mrs-sheppards"
        title={`Currently viewing ${displayLabel}. Click to scroll to top.`}
      >
        {displayLabel}
      </button>
    </div>
  );
}

