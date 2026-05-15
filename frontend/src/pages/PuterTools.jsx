import { useCallback, useEffect, useState } from 'react';
import { Bot, Cloud, FileText, LogIn, LogOut, RefreshCw, User, Zap } from 'lucide-react';
import PuterOCRUpload from '../components/PuterOCRUpload';
import PuterChatAssistant from '../components/PuterChatAssistant';
import PuterStoragePanel from '../components/PuterStoragePanel';
import { isPuterAvailable, isPuterSignedIn, loadPuter } from '../services/puterService';
import { signIn, signOut, getUser, isSignedIn } from '../services/puterAuth';

function StatusBadge({ ok, label }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${ok ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-green-500' : 'bg-gray-400'}`} />
      {label}
    </span>
  );
}

export default function PuterTools() {
  const [tab, setTab] = useState('ocr');
  const [puterReady, setPuterReady] = useState(isPuterAvailable());
  const [signedIn, setSignedIn] = useState(isPuterSignedIn());
  const [puterUser, setPuterUser] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  const refreshStatus = useCallback(async () => {
    setPuterReady(isPuterAvailable());
    const si = isPuterSignedIn();
    setSignedIn(si);
    if (si) {
      try {
        const u = await getUser();
        setPuterUser(u);
      } catch {
        setPuterUser(null);
      }
    } else {
      setPuterUser(null);
    }
  }, []);

  useEffect(() => {
    loadPuter()
      .then(() => refreshStatus())
      .catch(() => setPuterReady(false));
  }, [refreshStatus]);

  const handleSignIn = async () => {
    setAuthBusy(true);
    setAuthError('');
    try {
      await signIn();
      await refreshStatus();
    } catch (e) {
      setAuthError(e.message || 'Sign in failed');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    setAuthBusy(true);
    try {
      await signOut();
      await refreshStatus();
    } catch {
      // ignore
    } finally {
      setAuthBusy(false);
    }
  };

  const tabs = [
    { id: 'ocr', label: 'OCR', icon: FileText },
    { id: 'chat', label: 'AI Chat', icon: Bot },
    { id: 'storage', label: 'Cloud Storage', icon: Cloud },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-theme-border bg-theme-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-600 to-indigo-600 text-white flex items-center justify-center shadow-sm">
              <Zap size={20} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-theme-fg">Puter Cloud Tools</h2>
              <p className="text-[10px] text-theme-fg-muted">AI, OCR, cloud storage — no API keys needed</p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge ok={puterReady} label={puterReady ? 'SDK loaded' : 'SDK loading…'} />
            <StatusBadge ok={signedIn} label={signedIn ? `Signed in${puterUser?.username ? ` (${puterUser.username})` : ''}` : 'Not signed in'} />

            {signedIn ? (
              <button
                type="button"
                className="btn-secondary text-xs inline-flex items-center gap-1"
                onClick={handleSignOut}
                disabled={authBusy}
              >
                <LogOut size={13} /> Sign out of Puter
              </button>
            ) : (
              <button
                type="button"
                className="btn-primary text-xs inline-flex items-center gap-1"
                onClick={handleSignIn}
                disabled={authBusy}
              >
                <LogIn size={13} /> {authBusy ? 'Signing in…' : 'Sign in to Puter'}
              </button>
            )}

            <button type="button" className="btn-secondary text-xs px-2 py-1" onClick={refreshStatus} title="Refresh status">
              <RefreshCw size={13} />
            </button>
          </div>
        </div>

        {authError && (
          <div className="mb-3 text-[10px] text-red-600 font-semibold">{authError}</div>
        )}

        <div className="flex gap-1 border-b border-theme-border">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                className={`px-3 py-2 text-xs font-semibold inline-flex items-center gap-1.5 border-b-2 transition-colors ${
                  active
                    ? 'border-theme-primary text-theme-primary'
                    : 'border-transparent text-theme-fg-muted hover:text-theme-fg hover:border-theme-border'
                }`}
                onClick={() => setTab(t.id)}
              >
                <Icon size={14} /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === 'ocr' && <PuterOCRUpload />}
      {tab === 'chat' && <PuterChatAssistant />}
      {tab === 'storage' && <PuterStoragePanel />}

      <div className="rounded-xl border border-theme-border bg-theme-card p-4">
        <h4 className="text-xs font-bold text-theme-fg mb-2">About Puter integration</h4>
        <div className="text-[10px] text-theme-fg-muted space-y-1">
          <p>Puter provides free AI, OCR, and cloud storage without needing API keys. Each user covers their own usage via their Puter account.</p>
          <p><strong>OCR:</strong> Upload an invoice, PO, DN, or packing list. Puter AI extracts text, then parses structured fields (PO/SO/DN numbers, vendor, customer, line items). Edit results before saving.</p>
          <p><strong>AI Chat:</strong> Ask about warehouse processes, SAP integration, delivery notes, stock management. Attach images for document analysis.</p>
          <p><strong>Cloud Storage:</strong> Upload and manage files in Puter cloud. Files are tied to your Puter account (not GoDam backend). Use for document backup, OCR archives, and sharing.</p>
          <p><strong>Mobile:</strong> These tools work in mobile browsers and PWA. For the native Expo app, Puter AI is available via a WebView bridge.</p>
          <p><strong>Privacy:</strong> Puter does not require your own API keys. Your GoDam backend auth and database are not affected by Puter features.</p>
        </div>
      </div>
    </div>
  );
}
