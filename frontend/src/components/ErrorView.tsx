export default function ErrorView({ error, onRetry }: { error: any; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded p-3 text-sm">
      <div className="font-medium">Something went wrong</div>
      <div className="mt-1 opacity-90 whitespace-pre-wrap break-words">{msg}</div>
      {onRetry && (
        <button onClick={onRetry} className="mt-2 text-xs underline hover:opacity-80">
          Retry
        </button>
      )}
    </div>
  );
}

