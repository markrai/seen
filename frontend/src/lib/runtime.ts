export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as any;
  return (
    window.location?.protocol === 'tauri:' ||
    w.__TAURI__ !== undefined ||
    w.__TAURI_INTERNALS__ !== undefined
  );
}


