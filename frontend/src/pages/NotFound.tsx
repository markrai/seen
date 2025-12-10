import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="container-responsive py-16 text-center">
      <div className="text-2xl font-semibold mb-2">404 — Not Found</div>
      <div className="opacity-70">The page you are looking for doesn’t exist.</div>
      <div className="mt-4">
        <Link to="/" className="px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700">Go Home</Link>
      </div>
    </div>
  );
}

