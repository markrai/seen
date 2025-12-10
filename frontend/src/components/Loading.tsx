export function Loading({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="py-10 text-center text-sm opacity-70">
      <div className="animate-pulse">{label}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-16 text-center text-sm opacity-70">{children}</div>;
}

