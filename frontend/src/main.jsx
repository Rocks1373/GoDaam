import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import App from './App.jsx';
import AppErrorBoundary from './components/AppErrorBoundary.jsx';
import './styles/themes.css'; /* Semantic color + elevation tokens (must load before app CSS). */

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
      <Toaster richColors position="top-right" closeButton />
    </AppErrorBoundary>
  </StrictMode>
);
