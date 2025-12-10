import { Routes, Route, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef } from 'react';
import Header from './components/Header';
import Footer from './components/Footer';
import Dashboard from './pages/Dashboard';
import Gallery from './pages/Gallery';
import SearchPage from './pages/Search';
import AlbumsPage from './pages/Albums';
import PeoplePage from './pages/People';
import AssetDetail from './pages/AssetDetail';
import NotFound from './pages/NotFound';
import { useUIStore } from './lib/store';

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const defaultScreen = useUIStore((s) => s.defaultScreen);
  const hasRedirected = useRef(false);

  // Disable browser's automatic scroll restoration
  useEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  }, []);

  // Redirect to default screen only on initial load when on root path
  useEffect(() => {
    if (!hasRedirected.current && location.pathname === '/' && defaultScreen !== 'dashboard') {
      hasRedirected.current = true;
      navigate(`/${defaultScreen}`, { replace: true });
    }
  }, [location.pathname, defaultScreen, navigate]);

  return (
    <div className="min-h-full flex flex-col">
      <Header />
      <main className="flex-1">
        <Routes>
          <Route element={<PageLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="gallery" element={<Gallery />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="albums" element={<AlbumsPage />} />
            <Route path="people" element={<PeoplePage />} />
            <Route path="asset/:id" element={<AssetDetail />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </main>
      <Footer />
    </div>
  );
}

function PageLayout() {
  return <Outlet />;
}
