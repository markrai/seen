import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryProvider, queryClient } from './lib/hooks';
import { AdaptiveLoadingProvider } from './lib/adaptiveLoading';
import './index.css';
import App from './App.tsx';

// Theme is initialized in the store itself, no need to call initThemeFromStore separately

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider client={queryClient}>
      <AdaptiveLoadingProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      </AdaptiveLoadingProvider>
    </QueryProvider>
  </StrictMode>,
);
