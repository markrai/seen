import { useState, useEffect, useRef } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import JSZip from 'jszip';

interface BurstCaptureProps {
  videoElement: HTMLVideoElement | null;
  isOpen: boolean;
  onClose: () => void;
  onResume: (wasPlaying: boolean) => void;
  assetFilename: string;
}

interface CapturedFrame {
  dataUrl: string;
  index: number;
  blob: Blob;
}

export default function BurstCapture({ videoElement, isOpen, onClose, onResume, assetFilename }: BurstCaptureProps) {
  const [capturedFrames, setCapturedFrames] = useState<CapturedFrame[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wasPlayingRef = useRef<boolean>(false);
  const hasCapturedRef = useRef<boolean>(false);

  useEffect(() => {
    if (isOpen && videoElement && !hasCapturedRef.current && !isCapturing) {
      hasCapturedRef.current = true;
      captureBurst();
    }
    // Reset when closing
    if (!isOpen) {
      setCapturedFrames([]);
      setSelectedIndices(new Set());
      hasCapturedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, videoElement]);

  const captureBurst = async () => {
    if (!videoElement) return;
    
    setIsCapturing(true);
    const frames: CapturedFrame[] = [];
    
    // Ensure video has crossOrigin set for canvas export
    // This must be set before the video loads, but we'll set it here as a fallback
    if (!videoElement.crossOrigin || videoElement.crossOrigin !== 'anonymous') {
      // If video hasn't loaded yet, we can set it directly
      if (videoElement.readyState === 0) {
        videoElement.crossOrigin = 'anonymous';
      } else {
        // Video already loaded - need to reload with crossOrigin
        const currentSrc = videoElement.src;
        const currentTime = videoElement.currentTime;
        videoElement.crossOrigin = 'anonymous';
        videoElement.src = '';
        await new Promise(resolve => setTimeout(resolve, 50));
        videoElement.src = currentSrc;
        // Wait for video to reload
        await new Promise(resolve => {
          const onCanPlay = () => {
            videoElement.removeEventListener('canplay', onCanPlay);
            // Restore playback position
            videoElement.currentTime = currentTime;
            resolve(null);
          };
          videoElement.addEventListener('canplay', onCanPlay);
          // Timeout fallback
          setTimeout(() => {
            videoElement.removeEventListener('canplay', onCanPlay);
            resolve(null);
          }, 5000);
        });
      }
    }
    
    // Create a canvas for capturing frames
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setIsCapturing(false);
      return;
    }

    // Pause the video
    wasPlayingRef.current = !videoElement.paused;
    const originalTime = videoElement.currentTime;
    videoElement.pause();

    try {
      // Capture first frame immediately (no delay)
      ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
      const firstBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to create blob'));
          }
        }, 'image/jpeg', 0.95);
      });
      const firstDataUrl = canvas.toDataURL('image/jpeg', 0.95);
      frames.push({ dataUrl: firstDataUrl, index: 0, blob: firstBlob });

      // Capture remaining 4 frames at 150ms intervals
      for (let i = 1; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 150));
        videoElement.currentTime = originalTime + (i * 0.15);
        
        // Wait for video to seek and update
        await new Promise(resolve => {
          const onSeeked = () => {
            videoElement.removeEventListener('seeked', onSeeked);
            resolve(null);
          };
          videoElement.addEventListener('seeked', onSeeked);
        });

        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Failed to create blob'));
            }
          }, 'image/jpeg', 0.95);
        });
        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        frames.push({ dataUrl, index: i, blob });
      }

      // Restore video to original position
      videoElement.currentTime = originalTime;
      await new Promise(resolve => {
        const onSeeked = () => {
          videoElement.removeEventListener('seeked', onSeeked);
          resolve(null);
        };
        videoElement.addEventListener('seeked', onSeeked);
      });

      setCapturedFrames(frames);
      // Select all frames by default
      setSelectedIndices(new Set(frames.map((_, i) => i)));
    } catch (error) {
      console.error('Error capturing burst:', error);
      alert('Failed to capture frames');
      // Restore video state
      videoElement.currentTime = originalTime;
      if (wasPlayingRef.current) {
        videoElement.play().catch(() => {});
      }
      onClose();
    } finally {
      setIsCapturing(false);
    }
  };

  const toggleSelection = (index: number) => {
    setSelectedIndices(prev => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };

  const handleSave = async () => {
    if (selectedIndices.size === 0) {
      alert('Please select at least one frame');
      return;
    }

    setIsSaving(true);
    try {
      const selectedFrames = capturedFrames.filter((_, i) => selectedIndices.has(i));
      const baseName = assetFilename.replace(/\.[^/.]+$/, '') || 'frame';

      if (selectedFrames.length === 1) {
        // Single file - download directly
        const frame = selectedFrames[0];
        const url = URL.createObjectURL(frame.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseName}_${frame.index + 1}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        // Multiple files - create zip
        const zip = new JSZip();
        selectedFrames.forEach((frame, idx) => {
          zip.file(`${baseName}_${frame.index + 1}.jpg`, frame.blob);
        });

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseName}_burst.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      // Close and resume
      handleCancel();
    } catch (error) {
      console.error('Error saving frames:', error);
      alert('Failed to save frames');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setCapturedFrames([]);
    setSelectedIndices(new Set());
    onResume(wasPlayingRef.current);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-white dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700 px-6 py-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Capture Burst</h2>
          <button
            onClick={handleCancel}
            className="p-2 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-400"
            aria-label="Close"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          {isCapturing ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                <p className="text-zinc-600 dark:text-zinc-400">Capturing frames...</p>
              </div>
            </div>
          ) : capturedFrames.length > 0 ? (
            <>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
                Select the frames you want to save. Click on a frame to toggle selection.
              </p>
              <div className="grid grid-cols-5 gap-4 mb-6">
                {capturedFrames.map((frame, index) => (
                  <div
                    key={index}
                    onClick={() => toggleSelection(index)}
                    className={`relative cursor-pointer rounded-md overflow-hidden border-2 transition-all ${
                      selectedIndices.has(index)
                        ? 'border-blue-500 ring-2 ring-blue-500 ring-offset-2'
                        : 'border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'
                    }`}
                  >
                    <img
                      src={frame.dataUrl}
                      alt={`Frame ${index + 1}`}
                      className="w-full h-auto"
                    />
                    <div className="absolute top-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
                      {index + 1}
                    </div>
                    {selectedIndices.has(index) && (
                      <div className="absolute top-2 right-2 bg-blue-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold">
                        ✓
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between pt-4 border-t border-zinc-200 dark:border-zinc-700">
                <div className="text-sm text-zinc-600 dark:text-zinc-400">
                  {selectedIndices.size} of {capturedFrames.length} selected
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={handleCancel}
                    className="px-4 py-2 rounded-md border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={selectedIndices.size === 0 || isSaving}
                    className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white transition-colors flex items-center gap-2"
                  >
                    {isSaving ? (
                      <>
                        <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        <span>Saving...</span>
                      </>
                    ) : (
                      <span>Save {selectedIndices.size === 1 ? 'Frame' : 'Frames'}</span>
                    )}
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

