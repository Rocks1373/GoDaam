import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { Toaster } from 'sonner';
import App from './App.jsx';
import AppErrorBoundary from './components/AppErrorBoundary.jsx';
import './styles/themes.css'; /* Semantic color + elevation tokens (must load before app CSS). */

const googleClientId = import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID || '';

const appTree = (
  <AppErrorBoundary>
    <App />
    <Toaster richColors position="top-right" closeButton />
  </AppErrorBoundary>
);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {googleClientId ? <GoogleOAuthProvider clientId={googleClientId}>{appTree}</GoogleOAuthProvider> : appTree}
  </StrictMode>
);
