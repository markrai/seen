import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient, useQueries } from '@tanstack/react-query';
import { api, media } from '../lib/api';
import { Link } from 'react-router-dom';
import { PencilIcon, TrashIcon, PlayIcon, XMarkIcon, Cog6ToothIcon, StopIcon, SparklesIcon, BarsArrowDownIcon } from '@heroicons/react/24/outline';
import ConfirmDialog from '../components/ConfirmDialog';
import { Loading } from '../components/Loading';
import ErrorView from '../components/ErrorView';
import { useUIStore } from '../lib/store';
import { usePageVisibility } from '../lib/hooks';

interface Person {
  id: number;
  name: string | null;
  created_at: number;
}

const PERSON_PLACEHOLDER_REGEX = /^person\s+\d+$/i;
const PEOPLE_SORT_KEY = 'nazr.people.sortBy';

const isPlaceholderName = (person: Person) => {
  const rawName = person.name?.trim();
  return !rawName || PERSON_PLACEHOLDER_REGEX.test(rawName);
};

const getPlaceholderNumber = (person: Person) => {
  const match = person.name?.match(/person\s+(\d+)/i);
  return match ? parseInt(match[1], 10) : person.id;
};

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

const comparePersonsByName = (a: Person, b: Person) => {
  const aPlaceholder = isPlaceholderName(a);
  const bPlaceholder = isPlaceholderName(b);

  if (aPlaceholder !== bPlaceholder) {
    return aPlaceholder ? 1 : -1;
  }

  if (aPlaceholder && bPlaceholder) {
    return getPlaceholderNumber(a) - getPlaceholderNumber(b);
  }

  const nameA = (a.name || `Person ${a.id}`).toLowerCase();
  const nameB = (b.name || `Person ${b.id}`).toLowerCase();
  return nameA.localeCompare(nameB);
};

export default function PeoplePage() {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [personToDelete, setPersonToDelete] = useState<number | null>(null);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'detection' | 'smartMerge' | 'exclusions'>('detection');
  const [activePreset, setActivePreset] = useState<'preset1' | 'preset2' | 'preset3' | 'preset4' | 'preset5' | 'custom' | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [excludedExtensions, setExcludedExtensions] = useState<Set<string>>(new Set());
  const [draggedPersonId, setDraggedPersonId] = useState<number | null>(null);
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeSource, setMergeSource] = useState<Person | null>(null);
  const [mergeTarget, setMergeTarget] = useState<Person | null>(null);
  const [mergeSourceCount, setMergeSourceCount] = useState<number>(0);
  const [mergeTargetCount, setMergeTargetCount] = useState<number>(0);
  const [mergeSourceFaceId, setMergeSourceFaceId] = useState<number | null>(null);
  const [mergeTargetFaceId, setMergeTargetFaceId] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'photos'>(() => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem(PEOPLE_SORT_KEY);
        if (stored === 'name' || stored === 'photos') {
          return stored;
        }
      } catch {
        // ignore storage errors
      }
    }
    return 'name';
  });
  const [faceContextMenu, setFaceContextMenu] = useState<{ faceId: number; x: number; y: number } | null>(null);
  const [assignFaceId, setAssignFaceId] = useState<number | null>(null);
  const [selectedAssignPersonId, setSelectedAssignPersonId] = useState<number | null>(null);
  const [mergeStatus, setMergeStatus] = useState<string | null>(null);
  const smartMergeLevel = useUIStore((s) => s.smartMergeLevel);
  const setSmartMergeLevel = useUIStore((s) => s.setSmartMergeLevel);
  const queryClient = useQueryClient();
  const isPageVisible = usePageVisibility();

  // Close modal with ESC key
  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && settingsOpen) {
        setSettingsOpen(false);
      }
    };

    if (settingsOpen) {
      document.addEventListener('keydown', handleEsc);
      // Prevent body scroll when modal is open
      document.body.style.overflow = 'hidden';
      return () => {
        document.removeEventListener('keydown', handleEsc);
        document.body.style.overflow = 'unset';
      };
    }
  }, [settingsOpen]);

  useEffect(() => {
    if (!faceContextMenu) return;
    const handleClose = () => setFaceContextMenu(null);
    window.addEventListener('click', handleClose);
    window.addEventListener('contextmenu', handleClose);
    return () => {
      window.removeEventListener('click', handleClose);
      window.removeEventListener('contextmenu', handleClose);
    };
  }, [faceContextMenu]);

  useEffect(() => {
    if (!mergeStatus) return;
    const timer = setTimeout(() => setMergeStatus(null), 6000);
    return () => clearTimeout(timer);
  }, [mergeStatus]);

  const { data: persons, isLoading, error } = useQuery({
    queryKey: ['persons'],
    queryFn: () => api.listPersons(),
    enabled: isPageVisible,
    refetchInterval: (query) => (!isPageVisible || query.state.error) ? false : 30000,
    retry: false,
  });

  // Fetch asset counts for all persons when sorting by photos
  const assetCountQueries = useQueries({
    queries: persons && sortBy === 'photos' ? persons.map((person) => ({
      queryKey: ['personAssets', person.id],
      queryFn: () => api.getPersonAssets(person.id),
      staleTime: 30000, // Cache for 30 seconds
    })) : [],
  });

  // Create a map of person ID to asset count
  const assetCountMap = useMemo(() => {
    if (!persons || sortBy !== 'photos') return new Map<number, number>();
    const map = new Map<number, number>();
    persons.forEach((person, index) => {
      const assets = assetCountQueries[index]?.data;
      map.set(person.id, assets?.length || 0);
    });
    return map;
  }, [persons, assetCountQueries, sortBy]);

  // Sort persons based on selected sort option
  const sortedPersons = useMemo(() => {
    if (!persons) return [];
    const sorted = [...persons];

    if (sortBy === 'name') {
      sorted.sort(comparePersonsByName);
    } else if (sortBy === 'photos') {
      sorted.sort((a, b) => {
        const countA = assetCountMap.get(a.id) || 0;
        const countB = assetCountMap.get(b.id) || 0;
        // Sort descending (most photos first)
        return countB - countA;
      });
    }
    return sorted;
  }, [persons, sortBy, assetCountMap]);

  const dropdownPersons = useMemo(() => {
    if (!persons) return [];
    return [...persons].sort(comparePersonsByName);
  }, [persons]);

  const { data: faceStatus, error: faceStatusError } = useQuery({
    queryKey: ['faceDetectionStatus'],
    queryFn: () => api.faceDetectionStatus(),
    refetchInterval: (query) => (!isPageVisible || query.state.error) ? false : 2000,
    enabled: isPageVisible,
    retry: false,
  });

  const { data: faceProgress } = useQuery({
    queryKey: ['faceProgress'],
    queryFn: () => api.faceProgress(),
    refetchInterval: (query) => (!isPageVisible || query.state.error) ? false : 10000,
    enabled: isPageVisible,
    retry: false,
  });

  const { data: unassigned } = useQuery({
    queryKey: ['unassignedFaces'],
    queryFn: () => api.unassignedFaces(0, 60),
    refetchInterval: (query) => (!isPageVisible || query.state.error) ? false : 15000,
    enabled: isPageVisible,
    retry: false,
  });

  const { data: faceSettings } = useQuery({
    queryKey: ['faceSettings'],
    queryFn: () => api.getFaceSettings(),
    enabled: isPageVisible,
    retry: false,
  });

  const detectFacesMutation = useMutation({
    mutationFn: () => api.detectFaces(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['faceDetectionStatus'] });
      queryClient.invalidateQueries({ queryKey: ['faceProgress'] });
    },
  });

  const stopFaceDetectionMutation = useMutation({
    mutationFn: () => api.stopFaceDetection(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['faceDetectionStatus'] });
      queryClient.invalidateQueries({ queryKey: ['faceProgress'] });
    },
  });

  const clearFacialDataMutation = useMutation({
    mutationFn: () => api.clearFacialData(),
    onSuccess: () => {
      queryClient.setQueryData(['persons'], []);
      queryClient.invalidateQueries({ queryKey: ['persons'] });
      queryClient.invalidateQueries({ queryKey: ['faceProgress'] });
      queryClient.invalidateQueries({ queryKey: ['unassignedFaces'] });
      queryClient.removeQueries({ queryKey: ['personAssets'] });
      queryClient.removeQueries({ queryKey: ['personFace'] });
      setClearDialogOpen(false);
    },
  });

  const updatePersonMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string | null }) => api.updatePerson(id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['persons'] });
      setEditingId(null);
      setEditingName('');
    },
  });

  const deletePersonMutation = useMutation({
    mutationFn: (id: number) => api.deletePerson(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['persons'] });
      setDeleteDialogOpen(false);
      setPersonToDelete(null);
    },
  });

  const mergePersonsMutation = useMutation({
    mutationFn: ({ sourceId, targetId }: { sourceId: number; targetId: number }) => api.mergePersons(sourceId, targetId),
    onSuccess: (data, variables) => {
      const sourceLabel =
        mergeSource?.name || (mergeSource ? `Person ${mergeSource.id}` : `Person ${variables.sourceId}`);
      const target =
        persons?.find((p) => p.id === variables.targetId) || mergeTarget || { id: variables.targetId, name: null, created_at: 0 };
      const targetLabel = target.name || `Person ${target.id}`;
      const mergedCount = data?.faces_merged ?? 0;
      const profileCount = data?.profile_refreshed?.face_count;
      const statusMessage = profileCount
        ? `Merged ${sourceLabel} into ${targetLabel} (${mergedCount} faces). Profile now tracks ${profileCount} faces.`
        : `Merged ${sourceLabel} into ${targetLabel} (${mergedCount} faces).`;
      setMergeStatus(statusMessage);
      queryClient.invalidateQueries({ queryKey: ['persons'] });
      queryClient.invalidateQueries({ queryKey: ['personAssets', variables.targetId] });
      queryClient.invalidateQueries({ queryKey: ['personFace', variables.targetId] });
      queryClient.invalidateQueries({ queryKey: ['faceProgress'] });
      queryClient.invalidateQueries({ queryKey: ['unassignedFaces'] });
      setMergeDialogOpen(false);
      setMergeSource(null);
      setMergeTarget(null);
      setMergeSourceFaceId(null);
      setMergeTargetFaceId(null);
      setDraggedPersonId(null);
      setDropTargetId(null);
    },
  });

  const assignFaceMutation = useMutation({
    mutationFn: ({ faceId, personId }: { faceId: number; personId: number }) => api.assignFaceToPerson(faceId, personId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unassignedFaces'] });
      queryClient.invalidateQueries({ queryKey: ['persons'] });
      queryClient.invalidateQueries({ queryKey: ['faceProgress'] });
      setAssignFaceId(null);
      setSelectedAssignPersonId(null);
    },
    onError: (error) => {
      alert(`Failed to assign face: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });

  // Get threshold based on level (1-5)
  const getSmartMergeThreshold = () => {
    switch (smartMergeLevel) {
      case 1:
        return 0.40; // Most relaxed - only extremely similar faces
      case 2:
        return 0.45; // Relaxed - very similar faces
      case 3:
        return 0.50; // Default - balanced
      case 4:
        return 0.55; // Aggressive - similar faces
      case 5:
        return 0.60; // Most aggressive - liberal merging
      default:
        return 0.50; // Default threshold
    }
  };

  const smartMergeMutation = useMutation({
    mutationFn: () => api.smartMergePersons(getSmartMergeThreshold()),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['persons'] });
      queryClient.invalidateQueries({ queryKey: ['faceProgress'] });
      queryClient.invalidateQueries({ queryKey: ['unassignedFaces'] });
      // Show success message
      const message = `Smart merge completed: ${data.persons_merged} ${data.persons_merged === 1 ? 'person' : 'persons'} merged, ${data.faces_merged} ${data.faces_merged === 1 ? 'face' : 'faces'} combined. ${data.remaining_persons} ${data.remaining_persons === 1 ? 'person' : 'persons'} remaining.`;
      console.log(message);
      // Show notification
      const notification = document.createElement('div');
      notification.textContent = message;
      notification.className = 'fixed top-4 right-4 bg-green-500 text-white px-4 py-2 rounded shadow-lg z-50';
      document.body.appendChild(notification);
      setTimeout(() => {
        document.body.removeChild(notification);
      }, 5000);
    },
    onError: (error) => {
      const message = `Smart merge failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error(message);
      const notification = document.createElement('div');
      notification.textContent = message;
      notification.className = 'fixed top-4 right-4 bg-red-500 text-white px-4 py-2 rounded shadow-lg z-50';
      document.body.appendChild(notification);
      setTimeout(() => {
        document.body.removeChild(notification);
      }, 5000);
    },
  });

  const updateFaceSettingsMutation = useMutation({
    mutationFn: (settings: {
      confidence_threshold?: number;
      nms_iou_threshold?: number;
      cluster_epsilon?: number;
      min_cluster_size?: number;
      min_samples?: number;
      excluded_extensions?: string[];
    }) => api.updateFaceSettings(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['faceSettings'] });
    },
  });

  // Local state for settings form - MUST be before any early returns
  const [localSettings, setLocalSettings] = useState({
    confidence_threshold: 0.20,
    nms_iou_threshold: 0.4,
    cluster_epsilon: 0.55,
    min_cluster_size: 3,
    min_samples: 2,
  });

  // Presets definition - MUST be before any early returns
  const presets = {
    preset1: {
      name: 'High Precision',
      description: 'Very strict detection and clustering. Only high-confidence faces are detected and grouped. Best for minimizing false positives.',
      settings: {
        confidence_threshold: 0.35,
        nms_iou_threshold: 0.5,
        cluster_epsilon: 0.45,
        min_cluster_size: 4,
        min_samples: 3,
      },
    },
    preset2: {
      name: 'Default',
      description: 'Default settings optimized for most use cases. Good balance between detection accuracy and clustering quality.',
      settings: {
        confidence_threshold: 0.20,
        nms_iou_threshold: 0.4,
        cluster_epsilon: 0.55,
        min_cluster_size: 3,
        min_samples: 2,
      },
    },
    preset3: {
      name: 'Liberal',
      description: 'More relaxed detection and clustering. Detects more faces and groups them more liberally. Best for ensuring no faces are missed.',
      settings: {
        confidence_threshold: 0.15,
        nms_iou_threshold: 0.35,
        cluster_epsilon: 0.65,
        min_cluster_size: 2,
        min_samples: 1,
      },
    },
    preset4: {
      name: 'Maximum Detection',
      description: 'Most aggressive settings. Detects as many faces as possible and groups them very loosely. May include false positives.',
      settings: {
        confidence_threshold: 0.10,
        nms_iou_threshold: 0.3,
        cluster_epsilon: 0.75,
        min_cluster_size: 2,
        min_samples: 1,
      },
    },
    preset5: {
      name: 'Conservative',
      description: 'Medium-high confidence with moderate clustering. Cautious approach that reduces false positives while still detecting most faces.',
      settings: {
        confidence_threshold: 0.25,
        nms_iou_threshold: 0.45,
        cluster_epsilon: 0.50,
        min_cluster_size: 3,
        min_samples: 2,
      },
    },
  };

  const findMatchingPreset = (settings: typeof localSettings): 'preset1' | 'preset2' | 'preset3' | 'preset4' | 'preset5' | 'custom' | null => {
    for (const [key, preset] of Object.entries(presets)) {
      const presetSettings = preset.settings;
      if (
        Math.abs(settings.confidence_threshold - presetSettings.confidence_threshold) < 0.01 &&
        Math.abs(settings.nms_iou_threshold - presetSettings.nms_iou_threshold) < 0.01 &&
        Math.abs(settings.cluster_epsilon - presetSettings.cluster_epsilon) < 0.01 &&
        settings.min_cluster_size === presetSettings.min_cluster_size &&
        settings.min_samples === presetSettings.min_samples
      ) {
        return key as 'preset1' | 'preset2' | 'preset3' | 'preset4' | 'preset5';
      }
    }
    return 'custom';
  };

  // Update local settings when API settings change
  useEffect(() => {
    if (faceSettings) {
      const loadedSettings = {
        confidence_threshold: faceSettings.confidence_threshold ?? 0.20,
        nms_iou_threshold: faceSettings.nms_iou_threshold ?? 0.4,
        cluster_epsilon: faceSettings.cluster_epsilon ?? 0.55,
        min_cluster_size: faceSettings.min_cluster_size ?? 3,
        min_samples: faceSettings.min_samples ?? 2,
      };
      setLocalSettings(loadedSettings);
      
      // Load excluded extensions
      if (faceSettings.excluded_extensions) {
        setExcludedExtensions(new Set(faceSettings.excluded_extensions));
      } else {
        // Default: exclude all except jpg, jpeg, png, webp, heic, heif, tiff, tif
        const allImageExts = [
          'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'tif', 'heic', 'heif',
          'raw', 'cr2', 'nef', 'orf', 'sr2', 'arw', 'dng', 'rw2', 'raf', 'pef',
          'srw', '3fr', 'x3f', 'mrw', 'mef', 'mos', 'erf', 'dcr', 'kdc', 'fff',
          'iiq', 'rwl', 'r3d', 'ari', 'bay', 'cap', 'data', 'dcs', 'drf', 'eip',
          'k25', 'mdc', 'nrw', 'obm', 'ptx', 'pxn', 'rwz', 'srf', 'crw'
        ];
        const defaultAllowed = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'tiff', 'tif'];
        const defaultExcluded = allImageExts.filter(ext => !defaultAllowed.includes(ext));
        setExcludedExtensions(new Set(defaultExcluded));
      }
      
      setIsInitialLoad(true);
      // Mark initial load as complete after a brief delay
      setTimeout(() => setIsInitialLoad(false), 100);
    }
  }, [faceSettings]);

  // Update active preset when local settings change (from API or manual adjustment)
  useEffect(() => {
    const matchedPreset = findMatchingPreset(localSettings);
    setActivePreset(matchedPreset);
  }, [localSettings]);

  // Auto-save settings when they change (debounced) - skip on initial load
  // MUST be before any early returns
  useEffect(() => {
    if (isInitialLoad) return;

    const timeoutId = setTimeout(() => {
      updateFaceSettingsMutation.mutate({
        ...localSettings,
        excluded_extensions: Array.from(excludedExtensions),
      });
    }, 500); // Debounce for 500ms

    return () => clearTimeout(timeoutId);
  }, [localSettings, excludedExtensions, isInitialLoad]);

  const handleStartEdit = (person: Person) => {
    setEditingId(person.id);
    setEditingName(person.name || '');
  };

  const handleSaveEdit = () => {
    if (editingId !== null) {
      updatePersonMutation.mutate({ id: editingId, name: editingName.trim() || null });
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingName('');
  };

  const showDeleteConfirmation = useUIStore((s) => s.showDeleteConfirmation);

  const handleDeleteClick = (id: number) => {
    if (showDeleteConfirmation) {
      setPersonToDelete(id);
      setDeleteDialogOpen(true);
    } else {
      // Delete immediately without confirmation
      deletePersonMutation.mutate(id);
    }
  };

  const handleDeleteConfirm = () => {
    if (personToDelete !== null) {
      deletePersonMutation.mutate(personToDelete);
    }
  };

  const handleDetectFaces = () => {
    // Toggle directly enables/disables - no confirmation needed
    detectFacesMutation.mutate();
  };

  const handleClearClick = () => {
    if (isProcessing) return;
    setClearDialogOpen(true);
  };

  const handleClearConfirm = () => {
    clearFacialDataMutation.mutate();
  };

  // Drag and drop handlers - MUST be before any early returns
  const handleDragStart = (personId: number) => {
    setDraggedPersonId(personId);
  };

  const handleDragEnd = () => {
    setDraggedPersonId(null);
    setDropTargetId(null);
  };

  const handleDragOver = (e: React.DragEvent, personId: number) => {
    e.preventDefault();
    if (draggedPersonId !== null && draggedPersonId !== personId) {
      setDropTargetId(personId);
    }
    
    // Auto-scroll when dragging near viewport edges
    const scrollThreshold = 100; // pixels from edge
    const scrollSpeed = 10; // pixels per scroll
    const viewportHeight = window.innerHeight;
    const mouseY = e.clientY;
    
    if (mouseY < scrollThreshold) {
      // Near top edge - scroll up
      window.scrollBy({ top: -scrollSpeed, behavior: 'auto' });
    } else if (mouseY > viewportHeight - scrollThreshold) {
      // Near bottom edge - scroll down
      window.scrollBy({ top: scrollSpeed, behavior: 'auto' });
    }
  };

  const handleDragLeave = () => {
    setDropTargetId(null);
  };

  const handleDrop = async (e: React.DragEvent, targetPersonId: number) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (draggedPersonId === null || draggedPersonId === targetPersonId) {
      setDraggedPersonId(null);
      setDropTargetId(null);
      return;
    }

    const sourcePerson = persons?.find((p) => p.id === draggedPersonId);
    const targetPerson = persons?.find((p) => p.id === targetPersonId);

    if (!sourcePerson || !targetPerson) {
      setDraggedPersonId(null);
      setDropTargetId(null);
      return;
    }

    // Fetch asset counts and face IDs for both persons
    try {
      const [sourceAssets, targetAssets, sourceFaceId, targetFaceId] = await Promise.all([
        api.getPersonAssets(sourcePerson.id),
        api.getPersonAssets(targetPerson.id),
        api.getPersonFace(sourcePerson.id),
        api.getPersonFace(targetPerson.id),
      ]);
      setMergeSourceCount(sourceAssets.length);
      setMergeTargetCount(targetAssets.length);
      setMergeSourceFaceId(sourceFaceId);
      setMergeTargetFaceId(targetFaceId);
      setMergeSource(sourcePerson);
      setMergeTarget(targetPerson);
      setMergeDialogOpen(true);
    } catch (error) {
      console.error('Error fetching person data:', error);
    }

    setDraggedPersonId(null);
    setDropTargetId(null);
  };

  const handleMergeConfirm = () => {
    if (mergeSource && mergeTarget) {
      mergePersonsMutation.mutate({ sourceId: mergeSource.id, targetId: mergeTarget.id });
    }
  };

  const closeAssignDialog = () => {
    setAssignFaceId(null);
    setSelectedAssignPersonId(null);
  };

  const handleAssignFaceConfirm = () => {
    if (assignFaceId !== null && selectedAssignPersonId !== null) {
      assignFaceMutation.mutate({ faceId: assignFaceId, personId: selectedAssignPersonId });
    }
  };

  const featureError = faceStatusError || error;
  const isFeatureUnavailable = !!featureError && (
    (featureError as any)?.message?.includes('404') ||
    (featureError as any)?.message?.includes('Not Found') ||
    (featureError as any)?.message?.includes('501') ||
    (featureError as any)?.message?.includes('HTTP 404') ||
    (featureError as any)?.message?.includes('HTTP 501')
  );

  if (isLoading) return <Loading />;

  if (isFeatureUnavailable) {
    return (
      <div className="container-responsive py-6">
        <div className="text-center py-12">
          <h1 className="text-2xl font-semibold mb-4">Facial Recognition Not Available</h1>
          <p className="text-zinc-600 dark:text-zinc-400 mb-2">
            The facial recognition feature is not enabled on the backend.
          </p>
          <p className="text-sm text-zinc-500 dark:text-zinc-500 mb-2">
            To enable it, rebuild the backend with the <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">--features facial-recognition</code> flag.
          </p>
          <div className="mt-4 space-y-2">
            <p className="text-xs text-zinc-500 dark:text-zinc-500 font-mono bg-zinc-100 dark:bg-zinc-800 px-3 py-2 rounded block">
              docker compose build --build-arg CARGO_BUILD_FLAGS="--features facial-recognition"
            </p>
            <p className="text-xs text-zinc-400 dark:text-zinc-600 italic">Then restart: docker compose up -d</p>
          </div>
        </div>
      </div>
    );
  }

  if (error && !featureError) return <ErrorView error={error} />;

  const isFaceDetectionEnabled = faceProgress?.enabled || false;
  const queueDepth = faceStatus?.queue_depth || 0;
  const isProcessing = queueDepth > 0;

  const handleSettingsChange = (key: keyof typeof localSettings, value: number) => {
    setLocalSettings((prev) => {
      const newSettings = { ...prev, [key]: value };
      // Check if the new settings match any preset
      const matchedPreset = findMatchingPreset(newSettings);
      setActivePreset(matchedPreset);
      return newSettings;
    });
  };

  const applyPreset = (presetKey: keyof typeof presets) => {
    const preset = presets[presetKey];
    setLocalSettings(preset.settings);
    setActivePreset(presetKey);
  };

  const applyCustom = () => {
    setActivePreset('custom');
  };

  // Get the description for the active preset
  const getActivePresetDescription = () => {
    if (activePreset && activePreset !== 'custom' && activePreset in presets) {
      return presets[activePreset as keyof typeof presets].description;
    } else if (activePreset === 'custom') {
      return 'Custom settings active. Adjust sliders to create your own configuration.';
    }
    return 'Select a preset or adjust sliders to configure face detection settings.';
  };

  return (
    <div className="container-responsive py-6 space-y-6">
      <div className={`flex flex-col sm:flex-row items-stretch sm:items-center gap-3 ${persons && persons.length > 0 ? 'justify-between' : 'justify-end'}`}>
        {/* Sort Dropdown - moved to left */}
        {persons && persons.length > 0 && (
          <div className="flex items-center gap-2">
            <BarsArrowDownIcon className="size-4 text-zinc-600 dark:text-zinc-400" />
              <select
                value={sortBy}
                onChange={(e) => {
                  const newSort = e.target.value as 'name' | 'photos';
                  setSortBy(newSort);
                  if (typeof window !== 'undefined') {
                    try {
                      localStorage.setItem(PEOPLE_SORT_KEY, newSort);
                    } catch {
                      // ignore storage errors
                    }
                  }
                }}
                className="px-2 sm:px-3 py-1.5 sm:py-2 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs sm:text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="name">Sort by Name</option>
                <option value="photos">Sort by # of Photos</option>
              </select>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {isProcessing && (
            <div className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
              Detecting... ({queueDepth})
            </div>
          )}
          {/* Configure Button */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="px-3 sm:px-4 py-1.5 sm:py-2 bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 rounded-md hover:bg-zinc-300 dark:hover:bg-zinc-600 flex items-center gap-1.5 sm:gap-2 text-sm whitespace-nowrap"
            title="Configure Face Detection Settings"
          >
            <Cog6ToothIcon className="size-3.5 sm:size-4" />
            <span className="hidden sm:inline">Configure</span>
            <span className="sm:hidden">Config</span>
          </button>
          {/* Face Detection Toggle */}
          <div className="flex items-center gap-2 px-3 sm:px-4 py-1.5 sm:py-2 bg-zinc-200 dark:bg-zinc-700 rounded-md">
            <span className="text-xs sm:text-sm text-zinc-700 dark:text-zinc-200 whitespace-nowrap">
              Face Detection:
            </span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={isFaceDetectionEnabled}
                onChange={(e) => {
                  if (e.target.checked) {
                    detectFacesMutation.mutate();
                  } else {
                    stopFaceDetectionMutation.mutate();
                  }
                }}
                disabled={detectFacesMutation.isPending || stopFaceDetectionMutation.isPending}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-zinc-300 dark:bg-zinc-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"></div>
              <span className="ml-2 text-xs sm:text-sm text-zinc-700 dark:text-zinc-200 whitespace-nowrap">
                {isFaceDetectionEnabled ? 'Enabled' : 'Disabled'}
              </span>
            </label>
          </div>
          {persons && persons.length >= 2 && (
            <button
              onClick={() => smartMergeMutation.mutate()}
              disabled={smartMergeMutation.isPending || isProcessing}
              className="px-3 sm:px-4 py-1.5 sm:py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 sm:gap-2 text-sm whitespace-nowrap"
              title={isProcessing ? "Cannot merge while face detection is processing files" : "Automatically merge similar persons"}
            >
              <SparklesIcon className="size-3.5 sm:size-4" />
              <span className="hidden sm:inline">{smartMergeMutation.isPending ? 'Merging...' : 'Smart Merge'}</span>
              <span className="sm:hidden">{smartMergeMutation.isPending ? '...' : 'Merge'}</span>
            </button>
          )}
          <button
            onClick={handleClearClick}
            disabled={isProcessing || clearFacialDataMutation.isPending}
            className="px-3 sm:px-4 py-1.5 sm:py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 sm:gap-2 text-sm whitespace-nowrap"
          >
            <XMarkIcon className="size-3.5 sm:size-4" />
            <span className="hidden sm:inline">Clear Data</span>
            <span className="sm:hidden">Clear</span>
          </button>
        </div>
      </div>

      {mergeStatus && (
        <div className="rounded-md border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-100 px-3 py-2 text-sm">
          {mergeStatus}
        </div>
      )}

      {faceProgress && (
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-2.5 sm:p-4 bg-zinc-50 dark:bg-zinc-900">
          <div className="flex flex-wrap items-center gap-x-3 sm:gap-x-6 gap-y-1.5 sm:gap-y-2 text-xs sm:text-sm">
            <div className="flex items-center">
              <span className={`inline-block w-1.5 sm:w-2 h-1.5 sm:h-2 rounded-full mr-1.5 sm:mr-2 ${faceProgress.models_loaded.scrfd && faceProgress.models_loaded.arcface ? 'bg-green-500' : 'bg-yellow-500'}`}></span>
              <span className="hidden sm:inline">Models: SCRFD & ArcFace</span>
              <span className="sm:hidden">Models: SCRFD & ArcFace</span>
            </div>
            <div className="whitespace-nowrap">Faces: <span className="font-medium">{faceProgress.counts.faces_total}</span></div>
            <div className="whitespace-nowrap">People: <span className="font-medium">{faceProgress.counts.persons_total}</span></div>
            <div className="hidden sm:inline whitespace-nowrap">Batch: <span className="font-medium">{faceProgress.thresholds.cluster_batch_size}</span></div>
            <div className="hidden md:inline whitespace-nowrap">Remaining: <span className="font-medium">{faceProgress.thresholds.remaining_to_next_cluster}</span></div>
            {faceProgress.status && (
              <div className={`text-zinc-600 dark:text-zinc-400 text-xs sm:text-sm truncate flex-1 min-w-0 ${
                faceProgress.status === "Collecting more faces before next clustering" ? "animate-pulse-slow" : ""
              }`}>{faceProgress.status}</div>
            )}
          </div>
        </div>
      )}

      {sortedPersons && sortedPersons.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-4">
          {sortedPersons.map((person) => (
            <PersonCard
              key={person.id}
              person={person}
              isEditing={editingId === person.id}
              editingName={editingName}
              onEditingNameChange={setEditingName}
              onStartEdit={() => handleStartEdit(person)}
              onSave={handleSaveEdit}
              onCancel={handleCancelEdit}
              onDelete={() => handleDeleteClick(person.id)}
              isDragTarget={dropTargetId === person.id}
              onDragStart={() => handleDragStart(person.id)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, person.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, person.id)}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-zinc-500 dark:text-zinc-400">
          <p className="text-lg mb-2">No people detected yet</p>
          <p className="text-sm">Click "Start Face Detection" to scan your photos for faces and automatically group them by person.</p>
        </div>
      )}

      {unassigned?.faces && unassigned.faces.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Unassigned Faces</h2>
          <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-1.5 sm:gap-2">
            {unassigned.faces.map((f: any) => (
              <img
                key={f.id}
                src={media.faceThumbUrl(f.id, 160)}
                alt={`Face ${f.id}`}
                className="w-full h-auto rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 cursor-context-menu"
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setFaceContextMenu({ faceId: f.id, x: e.clientX, y: e.clientY });
                }}
                loading="lazy"
              />
            ))}
          </div>
        </div>
      )}

      {faceContextMenu && (
        <div
          className="fixed z-50 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-xl py-1 min-w-[180px]"
          style={{ left: faceContextMenu.x, top: faceContextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              setAssignFaceId(faceContextMenu.faceId);
              setSelectedAssignPersonId(null);
              setFaceContextMenu(null);
            }}
            className="w-full px-4 py-2 text-left text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700 flex items-center gap-2"
          >
            Assign to Person
          </button>
        </div>
      )}

      {assignFaceId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 dark:bg-black/60" onClick={closeAssignDialog} />
          <div className="relative z-10 w-full max-w-md bg-white dark:bg-zinc-800 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold flex-1">Assign Face to Person</h2>
              <img
                src={media.faceThumbUrl(assignFaceId, 96)}
                alt={`Face ${assignFaceId}`}
                className="w-16 h-16 rounded-full border border-zinc-200 dark:border-zinc-700 object-cover"
              />
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Choose an existing person to link this face. The face will no longer appear in the Unassigned list.
            </p>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200 mb-2">Select Person</label>
              <select
                value={selectedAssignPersonId ?? ''}
                onChange={(e) => setSelectedAssignPersonId(e.target.value ? parseInt(e.target.value, 10) : null)}
                className="w-full p-2 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">-- Select a person --</option>
                {dropdownPersons.length > 0 ? (
                  dropdownPersons.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name || `Person ${person.id}`}
                    </option>
                  ))
                ) : (
                  <option value="" disabled>
                    No persons available
                  </option>
                )}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={closeAssignDialog}
                className="px-4 py-2 bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100 rounded-md hover:bg-zinc-300 dark:hover:bg-zinc-600 text-sm font-medium"
                disabled={assignFaceMutation.isPending}
              >
                Cancel
              </button>
              <button
                onClick={handleAssignFaceConfirm}
                disabled={!selectedAssignPersonId || assignFaceMutation.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
              >
                {assignFaceMutation.isPending ? 'Assigning...' : 'Assign'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        onConfirm={handleDeleteConfirm}
        title="Delete Person"
        message="Are you sure you want to delete this person? This will unlink all associated faces but won't delete the face data."
        confirmText="Delete"
        variant="danger"
      />

      <ConfirmDialog
        isOpen={clearDialogOpen}
        onClose={() => setClearDialogOpen(false)}
        onConfirm={handleClearConfirm}
        title="Clear Facial Data"
        message="This will permanently delete all face embeddings and persons from the database. This action cannot be undone. Are you sure?"
        confirmText={clearFacialDataMutation.isPending ? 'Clearing...' : 'Clear All Data'}
        variant="danger"
      />

      {/* Merge Confirmation Dialog */}
      {mergeDialogOpen && mergeSource && mergeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setMergeDialogOpen(false)}
          />
          <div
            className="relative w-full max-w-md bg-white dark:bg-zinc-800 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold mb-4">Merge Persons</h2>
            <div className="space-y-3 mb-6">
              <div className="p-3 bg-zinc-50 dark:bg-zinc-900 rounded-md">
                <div className="flex items-center gap-3">
                  {mergeSourceFaceId && (
                    <img
                      src={media.faceThumbUrl(mergeSourceFaceId, 64)}
                      alt={mergeSource.name || `Person ${mergeSource.id}`}
                      className="w-16 h-16 rounded-full object-cover border-2 border-zinc-200 dark:border-zinc-700 flex-shrink-0"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-zinc-700 dark:text-zinc-300 mb-1">
                      {mergeSource.name || `Person ${mergeSource.id}`}
                    </div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-400">
                      {mergeSourceCount} {mergeSourceCount === 1 ? 'photo' : 'photos'}
                    </div>
                  </div>
                </div>
              </div>
              <div className="text-center text-zinc-500 dark:text-zinc-400 text-sm">↓ will be merged into ↓</div>
              <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-md border border-blue-200 dark:border-blue-800">
                <div className="flex items-center gap-3">
                  {mergeTargetFaceId && (
                    <img
                      src={media.faceThumbUrl(mergeTargetFaceId, 64)}
                      alt={mergeTarget.name || `Person ${mergeTarget.id}`}
                      className="w-16 h-16 rounded-full object-cover border-2 border-blue-200 dark:border-blue-800 flex-shrink-0"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-blue-700 dark:text-blue-300 mb-1">
                      {mergeTarget.name || `Person ${mergeTarget.id}`}
                    </div>
                    <div className="text-xs text-blue-600 dark:text-blue-400">
                      {mergeTargetCount} {mergeTargetCount === 1 ? 'photo' : 'photos'}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
              All faces from the source person will be assigned to the target person. The source person will be deleted.
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setMergeDialogOpen(false)}
                className="px-4 py-2 bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 rounded-md hover:bg-zinc-300 dark:hover:bg-zinc-600 text-sm font-medium"
                disabled={mergePersonsMutation.isPending}
              >
                Cancel
              </button>
              <button
                onClick={handleMergeConfirm}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
                disabled={mergePersonsMutation.isPending}
              >
                {mergePersonsMutation.isPending ? 'Merging...' : 'Merge'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setSettingsOpen(false)}
          />
          {/* Modal Content */}
          <div
            className="relative w-full max-w-sm bg-white dark:bg-zinc-800 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Body */}
            {/* Close button in top-right corner */}
            <div className="absolute top-2 right-2 z-10">
              <button
                onClick={() => setSettingsOpen(false)}
                className="p-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                title="Close (ESC)"
              >
                <XMarkIcon className="size-4" />
              </button>
            </div>
            <div className="p-2.5 space-y-2.5">
              {/* Tab Navigation */}
              <div className="flex border-b border-zinc-200 dark:border-zinc-700 mb-2.5">
                <button
                  onClick={() => setActiveTab('detection')}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    activeTab === 'detection'
                      ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  Detection Settings
                </button>
                <button
                  onClick={() => setActiveTab('smartMerge')}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    activeTab === 'smartMerge'
                      ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  Smart Merge
                </button>
                <button
                  onClick={() => setActiveTab('exclusions')}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    activeTab === 'exclusions'
                      ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  File Types
                </button>
              </div>

              {activeTab === 'detection' && (
                <>
                  {/* Preset Buttons */}
                  <div className="grid grid-cols-6 gap-1.5 pb-2 border-b border-zinc-200 dark:border-zinc-700">
                <button
                  onClick={() => applyPreset('preset1')}
                  className={`px-2 py-1.5 text-[10px] font-medium rounded transition-colors ${
                    activePreset === 'preset1'
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600'
                  }`}
                  title={presets.preset1.description}
                >
                  Preset 1
                </button>
                <button
                  onClick={() => applyPreset('preset2')}
                  className={`px-2 py-1.5 text-[10px] font-medium rounded transition-colors ${
                    activePreset === 'preset2'
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600'
                  }`}
                  title={presets.preset2.description}
                >
                  Default
                </button>
                <button
                  onClick={() => applyPreset('preset3')}
                  className={`px-2 py-1.5 text-[10px] font-medium rounded transition-colors ${
                    activePreset === 'preset3'
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600'
                  }`}
                  title={presets.preset3.description}
                >
                  Preset 3
                </button>
                <button
                  onClick={() => applyPreset('preset4')}
                  className={`px-2 py-1.5 text-[10px] font-medium rounded transition-colors ${
                    activePreset === 'preset4'
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600'
                  }`}
                  title={presets.preset4.description}
                >
                  Preset 4
                </button>
                <button
                  onClick={() => applyPreset('preset5')}
                  className={`px-2 py-1.5 text-[10px] font-medium rounded transition-colors ${
                    activePreset === 'preset5'
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600'
                  }`}
                  title={presets.preset5.description}
                >
                  Preset 5
                </button>
                <button
                  onClick={applyCustom}
                  className={`px-2 py-1.5 text-[10px] font-medium rounded transition-colors ${
                    activePreset === 'custom'
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600'
                  }`}
                  title="Custom settings - manually adjust sliders to create your own configuration"
                >
                  Custom
                </button>
              </div>
              <div>
                <label className="block text-xs text-zinc-600 dark:text-zinc-400 mb-0.5">
                  Confidence Threshold: {localSettings.confidence_threshold.toFixed(2)}
                </label>
                <input
                  type="range"
                  min="0.05"
                  max="0.5"
                  step="0.05"
                  value={localSettings.confidence_threshold}
                  onChange={(e) => handleSettingsChange('confidence_threshold', parseFloat(e.target.value))}
                  className="w-full h-1.5"
                />
                <div className="text-[10px] text-zinc-500 dark:text-zinc-500 mt-0.5">Lower = more faces detected</div>
              </div>
              <div>
                <label className="block text-xs text-zinc-600 dark:text-zinc-400 mb-0.5">
                  NMS IOU Threshold: {localSettings.nms_iou_threshold.toFixed(2)}
                </label>
                <input
                  type="range"
                  min="0.1"
                  max="0.8"
                  step="0.05"
                  value={localSettings.nms_iou_threshold}
                  onChange={(e) => handleSettingsChange('nms_iou_threshold', parseFloat(e.target.value))}
                  className="w-full h-1.5"
                />
                <div className="text-[10px] text-zinc-500 dark:text-zinc-500 mt-0.5">Overlap threshold for duplicate removal</div>
              </div>
              <div>
                <label className="block text-xs text-zinc-600 dark:text-zinc-400 mb-0.5">
                  Cluster Epsilon: {localSettings.cluster_epsilon.toFixed(2)}
                </label>
                <input
                  type="range"
                  min="0.3"
                  max="0.8"
                  step="0.05"
                  value={localSettings.cluster_epsilon}
                  onChange={(e) => handleSettingsChange('cluster_epsilon', parseFloat(e.target.value))}
                  className="w-full h-1.5"
                />
                <div className="text-[10px] text-zinc-500 dark:text-zinc-500 mt-0.5">Distance threshold for clustering (lower = stricter)</div>
              </div>
              <div>
                <label className="block text-xs text-zinc-600 dark:text-zinc-400 mb-0.5">
                  Min Cluster Size: {localSettings.min_cluster_size}
                </label>
                <input
                  type="range"
                  min="2"
                  max="10"
                  step="1"
                  value={localSettings.min_cluster_size}
                  onChange={(e) => handleSettingsChange('min_cluster_size', parseInt(e.target.value))}
                  className="w-full h-1.5"
                />
                <div className="text-[10px] text-zinc-500 dark:text-zinc-500 mt-0.5">Minimum faces per person cluster</div>
              </div>
              <div>
                <label className="block text-xs text-zinc-600 dark:text-zinc-400 mb-0.5">
                  Min Samples: {localSettings.min_samples}
                </label>
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={localSettings.min_samples}
                  onChange={(e) => handleSettingsChange('min_samples', parseInt(e.target.value))}
                  className="w-full h-1.5"
                />
                <div className="text-[10px] text-zinc-500 dark:text-zinc-500 mt-0.5">Neighborhood density for clustering</div>
              </div>
              {/* Footer with preset description */}
              <div className="pt-2 border-t border-zinc-200 dark:border-zinc-700">
                <div className="text-[10px] text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {getActivePresetDescription()}
                </div>
              </div>
                </>
              )}

              {activeTab === 'smartMerge' && (
                <div className="space-y-4">
                  {/* Smart Merge Level */}
                  <div>
                    <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 block">
                      Smart Merge Aggressiveness
                    </label>
                    <div className="space-y-4">
                      {/* Slider */}
                      <div className="px-2">
                        <input
                          type="range"
                          min="1"
                          max="5"
                          step="1"
                          value={smartMergeLevel}
                          onChange={(e) => setSmartMergeLevel(Number(e.target.value))}
                          className="w-full h-2 bg-zinc-200 dark:bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
                          style={{
                            background: `linear-gradient(to right, rgb(37 99 235) 0%, rgb(37 99 235) ${((smartMergeLevel - 1) / 4) * 100}%, rgb(161 161 170) ${((smartMergeLevel - 1) / 4) * 100}%, rgb(161 161 170) 100%)`
                          }}
                        />
                        <div className="flex justify-between mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">
                          <span>Most Relaxed</span>
                          <span>Most Aggressive</span>
                        </div>
                        <div className="flex justify-between mt-0.5 text-[9px] text-zinc-400 dark:text-zinc-500">
                          <span>1</span>
                          <span>2</span>
                          <span>3</span>
                          <span>4</span>
                          <span>5</span>
                        </div>
                      </div>
                      
                      {/* Current Setting Description */}
                      <div className="p-3 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                        <div className="text-sm font-medium text-blue-900 dark:text-blue-100 mb-1">
                          Level {smartMergeLevel}: {getSmartMergeDescription(smartMergeLevel).name}
                        </div>
                        <div className="text-xs text-blue-700 dark:text-blue-300">
                          {getSmartMergeDescription(smartMergeLevel).description}
                        </div>
                        <div className="text-[10px] text-blue-600 dark:text-blue-400 mt-1">
                          Threshold: {getSmartMergeDescription(smartMergeLevel).threshold}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'exclusions' && (
                <div className="space-y-3">
                  <div className="text-xs text-zinc-600 dark:text-zinc-400 mb-2">
                    Uncheck file extensions you want to exclude from face detection. By default, only common photo formats are processed.
                  </div>
                  <div className="max-h-[60vh] overflow-y-auto grid grid-cols-2 gap-x-2 gap-y-1.5">
                    {[
                      { label: 'JPG', ext: 'jpg' },
                      { label: 'JPEG', ext: 'jpeg' },
                      { label: 'PNG', ext: 'png' },
                      { label: 'GIF', ext: 'gif' },
                      { label: 'BMP', ext: 'bmp' },
                      { label: 'WebP', ext: 'webp' },
                      { label: 'TIFF', ext: 'tiff' },
                      { label: 'TIF', ext: 'tif' },
                      { label: 'HEIC', ext: 'heic' },
                      { label: 'HEIF', ext: 'heif' },
                      { label: 'RAW', ext: 'raw' },
                      { label: 'CR2 (Canon)', ext: 'cr2' },
                      { label: 'NEF (Nikon)', ext: 'nef' },
                      { label: 'ORF (Olympus)', ext: 'orf' },
                      { label: 'SR2 (Sony)', ext: 'sr2' },
                      { label: 'ARW (Sony)', ext: 'arw' },
                      { label: 'DNG', ext: 'dng' },
                      { label: 'RW2 (Panasonic)', ext: 'rw2' },
                      { label: 'RAF (Fuji)', ext: 'raf' },
                      { label: 'PEF (Pentax)', ext: 'pef' },
                      { label: 'SRW (Samsung)', ext: 'srw' },
                      { label: '3FR (Hasselblad)', ext: '3fr' },
                      { label: 'X3F (Sigma)', ext: 'x3f' },
                      { label: 'MRW (Minolta)', ext: 'mrw' },
                      { label: 'MEF (Mamiya)', ext: 'mef' },
                      { label: 'MOS (Leaf)', ext: 'mos' },
                      { label: 'ERF (Epson)', ext: 'erf' },
                      { label: 'DCR (Kodak)', ext: 'dcr' },
                      { label: 'KDC (Kodak)', ext: 'kdc' },
                      { label: 'FFF (Hasselblad)', ext: 'fff' },
                      { label: 'IIQ (Phase One)', ext: 'iiq' },
                      { label: 'RWL (Leica)', ext: 'rwl' },
                      { label: 'R3D (Red)', ext: 'r3d' },
                      { label: 'ARI (ARRIRAW)', ext: 'ari' },
                      { label: 'BAY (Casio)', ext: 'bay' },
                      { label: 'CAP (Phase One)', ext: 'cap' },
                      { label: 'DATA (Phase One)', ext: 'data' },
                      { label: 'DCS (Kodak)', ext: 'dcs' },
                      { label: 'DRF (Kodak)', ext: 'drf' },
                      { label: 'EIP (Phase One)', ext: 'eip' },
                      { label: 'K25 (Kodak)', ext: 'k25' },
                      { label: 'MDC (Minolta)', ext: 'mdc' },
                      { label: 'NRW (Nikon)', ext: 'nrw' },
                      { label: 'OBM (Phase One)', ext: 'obm' },
                      { label: 'PTX (Pentax)', ext: 'ptx' },
                      { label: 'PXN (Logitech)', ext: 'pxn' },
                      { label: 'RWZ (Rawzor)', ext: 'rwz' },
                      { label: 'SRF (Sony)', ext: 'srf' },
                      { label: 'CRW (Canon)', ext: 'crw' },
                    ].map(({ label, ext }) => {
                      const isExcluded = excludedExtensions.has(ext);
                      return (
                        <label
                          key={ext}
                          className="flex items-center gap-2 p-1.5 rounded hover:bg-zinc-50 dark:hover:bg-zinc-700/50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={!isExcluded}
                            onChange={(e) => {
                              const newExcluded = new Set(excludedExtensions);
                              if (e.target.checked) {
                                newExcluded.delete(ext);
                              } else {
                                newExcluded.add(ext);
                              }
                              setExcludedExtensions(newExcluded);
                            }}
                            className="w-4 h-4 text-blue-600 border-zinc-300 rounded focus:ring-blue-500 dark:border-zinc-600 dark:bg-zinc-700"
                          />
                          <span className="text-xs text-zinc-900 dark:text-zinc-100">{label}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="pt-2 border-t border-zinc-200 dark:border-zinc-700 text-[10px] text-zinc-500 dark:text-zinc-400">
                    {49 - Array.from(excludedExtensions).length} included, {Array.from(excludedExtensions).length} excluded
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PersonCard({
  person,
  isEditing,
  editingName,
  onEditingNameChange,
  onStartEdit,
  onSave,
  onCancel,
  onDelete,
  isDragTarget,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  person: Person;
  isEditing: boolean;
  editingName: string;
  onEditingNameChange: (name: string) => void;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  isDragTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { data: assets } = useQuery({
    queryKey: ['personAssets', person.id],
    queryFn: () => api.getPersonAssets(person.id),
  });

  const { data: faceId } = useQuery({
    queryKey: ['personFace', person.id],
    queryFn: () => api.getPersonFace(person.id),
    enabled: !isEditing,
  });

  const assetCount = assets?.length || 0;
  const displayName = person.name || `Person ${person.id}`;

  return (
    <div
      draggable={!isEditing}
      onDragStart={!isEditing ? onDragStart : undefined}
      onDragEnd={!isEditing ? onDragEnd : undefined}
      onDragOver={!isEditing ? onDragOver : undefined}
      onDragLeave={!isEditing ? onDragLeave : undefined}
      onDrop={!isEditing ? onDrop : undefined}
      className={`border rounded-lg p-4 hover:shadow-md transition-all cursor-move ${
        isDragTarget
          ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/20 shadow-lg scale-105'
          : 'border-zinc-200 dark:border-zinc-800'
      } ${isEditing ? 'cursor-default' : ''}`}
    >
      <div className="flex items-start gap-3 mb-3">
        {!isEditing && faceId && (
          <div className="flex-shrink-0">
            {assetCount > 0 ? (
              <Link
                to={`/gallery?person=${person.id}`}
                onClick={(e) => e.stopPropagation()}
                className="block"
                title="View photos"
              >
                <img
                  src={media.faceThumbUrl(faceId, 80)}
                  alt={displayName}
                  className="w-16 h-16 rounded-full object-cover border-2 border-zinc-200 dark:border-zinc-700 hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all cursor-pointer"
                  loading="lazy"
                  onError={(e) => {
                    // Hide image on error
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </Link>
            ) : (
              <img
                src={media.faceThumbUrl(faceId, 80)}
                alt={displayName}
                className="w-16 h-16 rounded-full object-cover border-2 border-zinc-200 dark:border-zinc-700"
                loading="lazy"
                onError={(e) => {
                  // Hide image on error
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            )}
          </div>
        )}
        <div className="flex-1 min-w-0">
          {isEditing ? (
            <div className="flex-1">
              <input
                type="text"
                value={editingName}
                onChange={(e) => onEditingNameChange(e.target.value)}
                placeholder="Enter name"
                className="w-full px-2 py-1 border border-zinc-300 dark:border-zinc-700 rounded bg-white dark:bg-zinc-800 text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSave();
                  else if (e.key === 'Escape') onCancel();
                }}
              />
              <div className="flex gap-2 mt-2">
                <button onClick={onSave} className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Save</button>
                <button onClick={onCancel} className="px-2 py-1 text-xs bg-zinc-200 dark:bg-zinc-700 rounded hover:bg-zinc-300 dark:hover:bg-zinc-600">Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link
                  to={`/gallery?person=${person.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 min-w-0"
                  title="View gallery"
                >
                  <h3 className="font-semibold text-lg truncate hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                    {displayName}
                  </h3>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                    {assetCount} {assetCount === 1 ? 'photo' : 'photos'}
                  </p>
                </Link>
                <div className="flex gap-1 flex-shrink-0">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onStartEdit();
                    }}
                    className="p-1 text-zinc-600 dark:text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400"
                    title="Rename person"
                  >
                    <PencilIcon className="size-4" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete();
                    }}
                    className="p-1 text-zinc-600 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400"
                    title="Delete person"
                  >
                    <TrashIcon className="size-4" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

