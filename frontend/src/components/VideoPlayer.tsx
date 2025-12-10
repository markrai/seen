import { useRef, useState, useEffect } from 'react';
import { PlayIcon, PauseIcon, SpeakerWaveIcon, SpeakerXMarkIcon, ArrowsPointingOutIcon } from '@heroicons/react/24/solid';
import type { Asset } from '../types';
import { media } from '../lib/api';
import { useUIStore } from '../lib/store';

interface VideoPlayerProps {
  asset: Asset;
  className?: string;
  onFullscreen?: () => void;
  onStateChange?: (state: { currentTime: number; isPlaying: boolean }) => void;
  savedState?: { currentTime: number; isPlaying: boolean } | null;
  videoRef?: React.RefObject<HTMLVideoElement>;
}

export default function VideoPlayer({ asset, className = '', onFullscreen, onStateChange, savedState, videoRef: externalVideoRef }: VideoPlayerProps) {
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const videoRef = externalVideoRef || internalVideoRef;
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null);
  const [containerDimensions, setContainerDimensions] = useState<{ width: number; height: number } | null>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const playbackSpeed = useUIStore((s) => s.playbackSpeed);
  const setPlaybackSpeed = useUIStore((s) => s.setPlaybackSpeed);

  // Update container dimensions on resize
  useEffect(() => {
    const updateContainerDimensions = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerDimensions({ width: rect.width, height: rect.height });
      }
    };

    updateContainerDimensions();
    window.addEventListener('resize', updateContainerDimensions);
    return () => window.removeEventListener('resize', updateContainerDimensions);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const updateTime = () => {
      const newTime = video.currentTime;
      setCurrentTime(newTime);
      // Update state for parent component - use video.paused to get current playing state
      if (onStateChange) {
        onStateChange({ currentTime: newTime, isPlaying: !video.paused });
      }
    };
    const updateDuration = () => setDuration(video.duration);
    const handlePlay = () => {
      setIsPlaying(true);
      if (onStateChange) {
        onStateChange({ currentTime: video.currentTime, isPlaying: true });
      }
    };
    const handlePause = () => {
      setIsPlaying(false);
      if (onStateChange) {
        onStateChange({ currentTime: video.currentTime, isPlaying: false });
      }
    };
    const handleEnded = () => {
      setIsPlaying(false);
      if (onStateChange) {
        onStateChange({ currentTime: video.currentTime, isPlaying: false });
      }
    };
    const handleLoadedMetadata = () => {
      setDuration(video.duration);
      setVideoDimensions({ width: video.videoWidth, height: video.videoHeight });
      setIsLoading(false);
    };
    const handleCanPlay = () => {
      setIsLoading(false);
    };
    const handleLoadStart = () => {
      setIsLoading(true);
    };
    const handleError = () => {
      setIsLoading(false);
    };

    video.addEventListener('timeupdate', updateTime);
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('loadstart', handleLoadStart);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);

    // Check if video is already loaded
    if (video.readyState >= 2) {
      setIsLoading(false);
      setVideoDimensions({ width: video.videoWidth, height: video.videoHeight });
    }

    // Apply playback speed when video is ready
    video.playbackRate = playbackSpeed;

    return () => {
      video.removeEventListener('timeupdate', updateTime);
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('loadstart', handleLoadStart);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleError);
    };
  }, [asset.id, playbackSpeed]);

  // Apply playback speed to video element
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed, videoRef]);
  
  // Handle fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Separate effect to handle savedState restoration (only when switching from fullscreen)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !savedState) return;
    
    // Only restore if we have a meaningful saved position (> 0.5 seconds) 
    // and the video is currently at or near the start (to avoid interfering with normal playback)
    if (savedState.currentTime > 0.5 && video.currentTime < 0.5 && video.readyState >= 2) {
      video.currentTime = savedState.currentTime;
      if (savedState.isPlaying) {
        video.play().catch(() => {
          // Ignore play errors
        });
      }
    }
  }, [savedState]);
  
  const handleFullscreen = async () => {
    const container = containerRef.current;
    if (!container) return;

    try {
      if (!document.fullscreenElement) {
        // Enter fullscreen - use the container so we keep our custom controls
        await container.requestFullscreen();
      } else {
        // Exit fullscreen
        await document.exitFullscreen();
      }
    } catch (error) {
      console.error('Fullscreen error:', error);
      // Fallback to opening lightbox if fullscreen API fails
      if (onFullscreen) {
        onFullscreen();
      }
    }
  };

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;

    // Use video.paused to check actual state, not isPlaying state which might be stale
    if (video.paused) {
      try {
        await video.play();
      } catch (error) {
        console.error('Error playing video:', error);
      }
    } else {
      video.pause();
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;

    const newTime = parseFloat(e.target.value);
    video.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;

    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    video.volume = newVolume;
    setIsMuted(newVolume === 0);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;

    if (isMuted) {
      video.volume = volume || 0.5;
      setIsMuted(false);
    } else {
      video.volume = 0;
      setIsMuted(true);
    }
  };

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  const formatPlaybackSpeed = (speed: number) => {
    // Format as "1x", "1.5x", "2x", etc.
    if (speed === 1) return '1x';
    if (speed % 1 === 0) return `${speed}x`;
    return `${speed.toFixed(1)}x`;
  };

  const handlePlaybackSpeedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newSpeed = parseFloat(e.target.value);
    setPlaybackSpeed(newSpeed);
  };

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 3000);
  };

  const handleMouseLeave = () => {
    if (isPlaying) {
      setShowControls(false);
    }
  };

  // Calculate video style to fit within container while preserving aspect ratio
  const getVideoStyle = () => {
    if (!videoDimensions || !containerDimensions) {
      return { 
        width: '100%', 
        height: 'auto',
        objectFit: 'contain' as const,
      };
    }

    const videoAspect = videoDimensions.width / videoDimensions.height;
    const containerAspect = containerDimensions.width / containerDimensions.height;
    const isPortrait = videoDimensions.height > videoDimensions.width;
    
    // Calculate max dimensions based on viewport (80% of viewport height, full container width)
    const maxHeight = Math.min(containerDimensions.height, window.innerHeight * 0.8);
    const maxWidth = containerDimensions.width;

    // Calculate the size that fits within both maxWidth and maxHeight while preserving aspect ratio
    let displayWidth = maxWidth;
    let displayHeight = displayWidth / videoAspect;

    // If calculated height exceeds max height, scale down by height instead
    if (displayHeight > maxHeight) {
      displayHeight = maxHeight;
      displayWidth = displayHeight * videoAspect;
    }

    return {
      width: `${displayWidth}px`,
      height: `${displayHeight}px`,
      maxWidth: '100%',
      maxHeight: `${maxHeight}px`,
      objectFit: 'contain' as const,
    };
  };

  return (
    <div
      ref={containerRef}
      className={`relative bg-black ${isFullscreen ? '' : 'rounded-md overflow-hidden'} flex items-center justify-center ${className}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={isFullscreen ? {
        width: '100vw',
        height: '100vh',
      } : {
        minHeight: '400px', 
        maxHeight: '80vh',
        width: '100%',
        height: 'auto',
      }}
    >
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-white text-lg z-20">
          Loading...
        </div>
      )}
      <video
        ref={videoRef}
        src={media.videoUrl(asset.id)}
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
        style={isFullscreen ? { width: '100vw', height: '100vh', objectFit: 'contain' } : getVideoStyle()}
        onClick={(e) => {
          e.stopPropagation();
          togglePlay();
        }}
        controls={false}
        preload="metadata"
        crossOrigin="anonymous"
        className={`${isLoading ? 'opacity-0' : 'opacity-100 transition-opacity duration-300'} cursor-pointer`}
        onError={(e) => {
          const video = e.currentTarget;
          const error = video.error;
          if (error) {
            console.error('Video playback error:', {
              code: error.code,
              message: error.message,
              networkState: video.networkState,
              readyState: video.readyState,
              src: video.src,
              mime: asset.mime
            });
          } else {
            console.error('Video playback error (no error object):', e);
          }
          setIsLoading(false);
        }}
        onLoadStart={() => {
          console.log('Video load started:', media.videoUrl(asset.id), 'MIME:', asset.mime);
        }}
        onCanPlay={() => {
          console.log('Video can play:', media.videoUrl(asset.id));
        }}
      />

      {/* Controls overlay */}
      <div
        className={`absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0'
        } pointer-events-none`}
      >
        {/* Play/Pause button - hide while loading */}
        {!isLoading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <button
              onClick={(e) => {
                e.stopPropagation();
                togglePlay();
              }}
              className="p-4 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors backdrop-blur-sm pointer-events-auto"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <PauseIcon className="w-12 h-12" />
              ) : (
                <PlayIcon className="w-12 h-12" />
              )}
            </button>
          </div>
        )}

        {/* Bottom controls bar */}
        <div className="absolute bottom-0 left-0 right-0 p-4 space-y-2 pointer-events-none">
          {/* Progress bar */}
          <div className="flex items-center gap-2 pointer-events-auto">
            <span className="text-white text-xs tabular-nums min-w-[3rem]">
              {formatTime(currentTime)}
            </span>
            <input
              type="range"
              min="0"
              max={duration || 0}
              value={currentTime}
              onChange={handleSeek}
              className="flex-1 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-blue-600"
              style={{
                background: `linear-gradient(to right, #3b82f6 0%, #3b82f6 ${(currentTime / duration) * 100}%, rgba(255,255,255,0.2) ${(currentTime / duration) * 100}%, rgba(255,255,255,0.2) 100%)`,
              }}
            />
            <span className="text-white text-xs tabular-nums min-w-[3rem]">
              {formatTime(duration)}
            </span>
          </div>

          {/* Volume and controls */}
          <div className="flex items-center gap-2 pointer-events-auto">
            <button
              onClick={toggleMute}
              className="p-1.5 rounded hover:bg-white/10 text-white transition-colors"
              aria-label={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? (
                <SpeakerXMarkIcon className="w-5 h-5" />
              ) : (
                <SpeakerWaveIcon className="w-5 h-5" />
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              className="w-20 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <input
              type="range"
              min="1"
              max="4"
              step="0.25"
              value={playbackSpeed}
              onChange={handlePlaybackSpeedChange}
              className="w-20 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <span className="text-white text-xs min-w-[2.5rem]">
              {formatPlaybackSpeed(playbackSpeed)}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <div className="text-white text-xs">
                {asset.filename}
              </div>
              <button
                onClick={handleFullscreen}
                className="p-1.5 rounded hover:bg-white/10 text-white transition-colors"
                aria-label={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              >
                <ArrowsPointingOutIcon className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

