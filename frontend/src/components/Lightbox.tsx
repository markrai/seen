import { useEffect, useState, useRef } from 'react';
import { XMarkIcon, ChevronLeftIcon, ChevronRightIcon, MagnifyingGlassPlusIcon, MagnifyingGlassMinusIcon, ArrowsPointingOutIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import type { Asset } from '../types';
import { media, assetApi } from '../lib/api';
import { isVideo } from '../lib/utils';

interface LightboxProps {
  asset: Asset;
  currentIndex: number;
  total?: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onDelete?: (id: number) => void;
  videoState?: { currentTime: number; isPlaying: boolean } | null;
  onVideoStateChange?: (state: { currentTime: number; isPlaying: boolean }) => void;
}

export default function Lightbox({ asset, currentIndex, total, onNavigate, onClose, onDelete, videoState, onVideoStateChange }: LightboxProps) {
  // Validate props
  if (!asset) {
    console.error('Lightbox: asset is required');
    return null;
  }
  const totalCount = total ?? 1;
  if (totalCount <= 0) {
    console.error('Lightbox: total asset count is zero');
    return null;
  }
  if (currentIndex < 0 || currentIndex >= totalCount) {
    console.error(`Lightbox: currentIndex ${currentIndex} is out of bounds for total ${totalCount}`);
    return null;
  }
  
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [showSaveButton, setShowSaveButton] = useState(false);
  const [saveButtonOpacity, setSaveButtonOpacity] = useState(1);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const saveButtonTimerRef = useRef<NodeJS.Timeout | null>(null);
  const saveButtonFadeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isVideoFile = isVideo(asset.mime);

  // Reset zoom, position, and rotation when asset changes
  useEffect(() => {
    setZoom(1);
    setPosition({ x: 0, y: 0 });
    setRotation(0);
    setIsLoading(true);
    setShowSaveButton(false);
    setSaveButtonOpacity(1);
    if (saveButtonTimerRef.current) {
      clearTimeout(saveButtonTimerRef.current);
      saveButtonTimerRef.current = null;
    }
    if (saveButtonFadeTimerRef.current) {
      clearTimeout(saveButtonFadeTimerRef.current);
      saveButtonFadeTimerRef.current = null;
    }
  }, [asset.id]);

  // Show save button for 3 seconds after rotation changes, then fade out slowly
  useEffect(() => {
    // Clear any existing timers
    if (saveButtonTimerRef.current) {
      clearTimeout(saveButtonTimerRef.current);
      saveButtonTimerRef.current = null;
    }
    if (saveButtonFadeTimerRef.current) {
      clearTimeout(saveButtonFadeTimerRef.current);
      saveButtonFadeTimerRef.current = null;
    }

    // Only show button if rotation is not 0 and it's not a video
    if (rotation !== 0 && !isVideoFile) {
      setShowSaveButton(true);
      setSaveButtonOpacity(1);
      
      // Start fade out after 3 seconds
      saveButtonTimerRef.current = setTimeout(() => {
        // Fade out over 2 seconds
        setSaveButtonOpacity(0);
        saveButtonFadeTimerRef.current = setTimeout(() => {
          setShowSaveButton(false);
          setSaveButtonOpacity(1);
          saveButtonFadeTimerRef.current = null;
        }, 2000);
        saveButtonTimerRef.current = null;
      }, 3000);
    } else {
      setShowSaveButton(false);
      setSaveButtonOpacity(1);
    }

    // Cleanup on unmount or when rotation changes
    return () => {
      if (saveButtonTimerRef.current) {
        clearTimeout(saveButtonTimerRef.current);
        saveButtonTimerRef.current = null;
      }
      if (saveButtonFadeTimerRef.current) {
        clearTimeout(saveButtonFadeTimerRef.current);
        saveButtonFadeTimerRef.current = null;
      }
    };
  }, [rotation, isVideoFile]);

  // Check if image/video is already loaded (cached) after src changes
  useEffect(() => {
    // Use requestAnimationFrame to check after the DOM has updated
    const checkLoaded = () => {
      if (isVideoFile && videoRef.current) {
        // Check if video has loaded data
        if (videoRef.current.readyState >= 2) { // HAVE_CURRENT_DATA or higher
          setIsLoading(false);
          return;
        }
        // Also check if the src matches (video might be from cache)
        if (videoRef.current.src && videoRef.current.src.includes(String(asset.id))) {
          // If video element exists and src matches, it might be cached
          // Wait a bit and check again
          setTimeout(() => {
            if (videoRef.current && videoRef.current.readyState >= 2) {
              setIsLoading(false);
            }
          }, 50);
        }
      } else if (!isVideoFile && imageRef.current) {
        // Check if image is complete and has valid dimensions
        if (imageRef.current.complete && imageRef.current.naturalWidth > 0) {
          setIsLoading(false);
          return;
        }
        // Also check if the src matches (image might be from cache)
        if (imageRef.current.src && imageRef.current.src.includes(String(asset.id))) {
          // If image element exists and src matches, check if it's already loaded
          if (imageRef.current.complete) {
            setIsLoading(false);
          }
        }
      }
    };
    
    // Check immediately and after a short delay
    requestAnimationFrame(checkLoaded);
    const timer = setTimeout(checkLoaded, 50);
    
    return () => clearTimeout(timer);
  }, [asset.id, isVideoFile]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input field
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (onDelete) {
          e.preventDefault();
          onDelete(asset.id);
        }
      } else if (e.key === 'ArrowLeft' && currentIndex > 0) {
        e.preventDefault();
        onNavigate(currentIndex - 1);
      } else if (e.key === 'ArrowRight' && currentIndex < totalCount - 1) {
        e.preventDefault();
        onNavigate(currentIndex + 1);
      } else if (e.key === '+' || e.key === '=') {
        setZoom((z) => Math.min(z + 0.25, 5));
      } else if (e.key === '-') {
        setZoom((z) => Math.max(z - 0.25, 0.5));
      } else if (e.key === '0') {
        setZoom(1);
        setPosition({ x: 0, y: 0 });
      } else if (e.key === 'f' || e.key === 'F') {
        // 'f' key to exit fullscreen (close lightbox)
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, totalCount, onClose, onNavigate, onDelete, asset.id]);

  // Mouse wheel zoom
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        setZoom((z) => Math.max(0.5, Math.min(5, z + delta)));
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener('wheel', handleWheel, { passive: false });
      return () => container.removeEventListener('wheel', handleWheel);
    }
  }, []);

  // Mouse drag for panning when zoomed
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && zoom > 1) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Touch gestures for mobile
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const touchDistanceRef = useRef<number | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() };
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchDistanceRef.current = Math.sqrt(dx * dx + dy * dy);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchDistanceRef.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const scale = distance / touchDistanceRef.current;
      setZoom((z) => Math.max(0.5, Math.min(5, z * scale)));
      touchDistanceRef.current = distance;
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (e.changedTouches.length === 1 && touchStartRef.current) {
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartRef.current.x;
      const dy = touch.clientY - touchStartRef.current.y;
      const dt = Date.now() - touchStartRef.current.time;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Swipe detection (fast, horizontal movement)
      if (dt < 300 && distance > 50 && Math.abs(dx) > Math.abs(dy)) {
        if (dx > 0 && currentIndex > 0) {
          onNavigate(currentIndex - 1);
        } else if (dx < 0 && currentIndex < totalCount - 1) {
          onNavigate(currentIndex + 1);
        }
      }
    }
    touchStartRef.current = null;
    touchDistanceRef.current = null;
  };

  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex < totalCount - 1;

  // Handle saving orientation to disk
  const handleSaveOrientation = async () => {
    try {
      await assetApi.saveOrientation(asset.id, rotation);
      setShowSaveButton(false);
      setSaveButtonOpacity(1);
      if (saveButtonTimerRef.current) {
        clearTimeout(saveButtonTimerRef.current);
        saveButtonTimerRef.current = null;
      }
      if (saveButtonFadeTimerRef.current) {
        clearTimeout(saveButtonFadeTimerRef.current);
        saveButtonFadeTimerRef.current = null;
      }
    } catch (error) {
      console.error('Failed to save orientation:', error);
      alert(error instanceof Error ? error.message : 'Failed to save orientation to disk');
    }
  };

  // Safely get media URLs with error handling
  let imageUrl: string;
  let videoUrl: string;
  try {
    imageUrl = media.previewUrl(asset.id, asset.sha256);
    videoUrl = media.videoUrl(asset.id);
  } catch (error) {
    console.error('Lightbox: Error generating media URLs', error, asset);
    return (
      <div className="fixed inset-0 z-50 bg-black/95 backdrop-blur-sm flex items-center justify-center">
        <div className="text-white text-center">
          <p className="text-lg mb-2">Error loading media</p>
          <p className="text-sm opacity-75 mb-4">Failed to generate URL for asset {asset.id}</p>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/95 backdrop-blur-sm flex items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      ref={containerRef}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
        aria-label="Close"
      >
        <XMarkIcon className="w-6 h-6" />
      </button>

      {/* Navigation buttons */}
      {canGoPrev && (
        <button
          onClick={() => onNavigate(currentIndex - 1)}
          className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
          aria-label="Previous"
        >
          <ChevronLeftIcon className="w-6 h-6" />
        </button>
      )}

      {canGoNext && (
        <button
          onClick={() => onNavigate(currentIndex + 1)}
          className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
          aria-label="Next"
        >
          <ChevronRightIcon className="w-6 h-6" />
        </button>
      )}

      {/* Zoom and rotation controls */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2 p-2 rounded-lg bg-black/50 backdrop-blur-sm">
        <button
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
          className="p-1.5 rounded hover:bg-white/10 text-white transition-colors"
          aria-label="Zoom out"
          disabled={zoom <= 0.5}
        >
          <MagnifyingGlassMinusIcon className="w-5 h-5" />
        </button>
        <span className="text-white text-sm min-w-[3rem] text-center">{Math.round(zoom * 100)}%</span>
        <button
          onClick={() => setZoom((z) => Math.min(5, z + 0.25))}
          className="p-1.5 rounded hover:bg-white/10 text-white transition-colors"
          aria-label="Zoom in"
          disabled={zoom >= 5}
        >
          <MagnifyingGlassPlusIcon className="w-5 h-5" />
        </button>
        {zoom !== 1 && (
          <button
            onClick={() => {
              setZoom(1);
              setPosition({ x: 0, y: 0 });
            }}
            className="p-1.5 rounded hover:bg-white/10 text-white transition-colors ml-2"
            aria-label="Reset zoom"
          >
            <ArrowsPointingOutIcon className="w-5 h-5" />
          </button>
        )}
        {!isVideoFile && (
          <>
            <div className="h-6 w-px bg-white/30 mx-1" />
            <button
              onClick={() => setRotation((r) => (r - 90) % 360)}
              className="p-1.5 rounded hover:bg-white/10 text-white transition-colors"
              aria-label="Rotate left"
              title="Rotate left (90°)"
            >
              <ArrowPathIcon className="w-5 h-5" style={{ transform: 'scaleX(-1)' }} />
            </button>
            <button
              onClick={() => setRotation((r) => (r + 90) % 360)}
              className="p-1.5 rounded hover:bg-white/10 text-white transition-colors"
              aria-label="Rotate right"
              title="Rotate right (90°)"
            >
              <ArrowPathIcon className="w-5 h-5" />
            </button>
            {rotation !== 0 && (
              <button
                onClick={() => setRotation(0)}
                className="p-1.5 rounded hover:bg-white/10 text-white transition-colors ml-2"
                aria-label="Reset rotation"
                title="Reset rotation"
              >
                <span className="text-xs">0°</span>
              </button>
            )}
            {/* Save to disk button - appears for 3 seconds after rotation, then fades out */}
            {showSaveButton && (
              <div className="ml-2">
                <button
                  onClick={handleSaveOrientation}
                  className="px-2 py-1 text-xs text-white border border-white/50 rounded hover:border-white/80 transition-opacity"
                  style={{ opacity: saveButtonOpacity, transitionDuration: '2000ms' }}
                  aria-label="Save orientation to disk"
                >
                  Save to disk
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Image counter */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-full bg-black/50 backdrop-blur-sm text-white text-sm">
        {currentIndex + 1} / {totalCount}
      </div>

      {/* Media content */}
      <div
        className="relative w-full h-full flex items-center justify-center overflow-hidden"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
      >
        {isVideoFile ? (
          <video
            ref={videoRef}
            src={videoUrl}
            type={(() => {
              // For browser-incompatible formats (like AVI), the backend will transcode to MP4
              // So we should use 'video/mp4' as the type to match what's actually being served
              const mime = asset.mime || 'video/mp4';
              if (mime === 'video/x-msvideo' || mime === 'video/avi' || 
                  mime === 'video/x-ms-wmv' || mime === 'video/quicktime' ||
                  mime === 'video/x-matroska' || mime === 'video/x-flv') {
                return 'video/mp4'; // Backend will transcode these to MP4
              }
              return mime;
            })()}
            controls
            autoPlay={videoState?.isPlaying ?? false}
            crossOrigin="anonymous"
            className="max-w-full max-h-full object-contain"
            onError={(e) => {
              const video = e.currentTarget;
              const error = video.error;
              if (error) {
                console.error('Lightbox: Failed to load video', {
                  assetId: asset.id,
                  code: error.code,
                  message: error.message,
                  networkState: video.networkState,
                  readyState: video.readyState,
                  src: video.src,
                  mime: asset.mime
                });
              } else {
                console.error('Lightbox: Failed to load video', asset.id, e);
              }
              setIsLoading(false);
            }}
            onLoadedData={() => {
              setIsLoading(false);
              // Restore video state when loaded
              if (videoRef.current && videoState) {
                videoRef.current.currentTime = videoState.currentTime;
                if (videoState.isPlaying) {
                  videoRef.current.play().catch(() => {
                    // Ignore play errors (e.g., autoplay blocked)
                  });
                }
              }
            }}
            onCanPlay={() => {
              setIsLoading(false);
              // Restore video state when can play
              if (videoRef.current && videoState && videoRef.current.currentTime === 0) {
                videoRef.current.currentTime = videoState.currentTime;
                if (videoState.isPlaying) {
                  videoRef.current.play().catch(() => {
                    // Ignore play errors
                  });
                }
              }
            }}
            onLoadedMetadata={() => {
              setIsLoading(false);
              // Restore video state when metadata loaded
              if (videoRef.current && videoState) {
                videoRef.current.currentTime = videoState.currentTime;
                if (videoState.isPlaying) {
                  videoRef.current.play().catch(() => {
                    // Ignore play errors
                  });
                }
              }
            }}
            onTimeUpdate={() => {
              // Update state as video plays
              if (videoRef.current && onVideoStateChange) {
                onVideoStateChange({
                  currentTime: videoRef.current.currentTime,
                  isPlaying: !videoRef.current.paused,
                });
              }
            }}
            onPlay={() => {
              if (videoRef.current && onVideoStateChange) {
                onVideoStateChange({
                  currentTime: videoRef.current.currentTime,
                  isPlaying: true,
                });
              }
            }}
            onPause={() => {
              if (videoRef.current && onVideoStateChange) {
                onVideoStateChange({
                  currentTime: videoRef.current.currentTime,
                  isPlaying: false,
                });
              }
            }}
          />
        ) : (
          <img
            ref={imageRef}
            src={imageUrl}
            alt={asset.filename || 'Image'}
            className="max-w-full max-h-full object-contain select-none"
            style={{
              transform: `translate(${position.x}px, ${position.y}px) scale(${zoom}) rotate(${rotation}deg)`,
              transition: isDragging ? 'none' : 'transform 0.2s ease-out',
            }}
            onLoad={() => setIsLoading(false)}
            onError={(e) => {
              console.error('Lightbox: Failed to load image', asset.id, e);
              setIsLoading(false);
            }}
            draggable={false}
          />
        )}

        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}

