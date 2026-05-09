import { useCallback, useEffect, useState } from 'react';
import { Smartphone, Download, RefreshCw } from 'lucide-react';
import { adminMobileAppApi } from '../services/api';

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function MobileApps() {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setErr('');
      const data = await adminMobileAppApi.getInfo();
      setInfo(data);
    } catch (e) {
      setInfo(null);
      setErr(e.response?.data?.error || e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onDownload = async () => {
    try {
      setDownloading(true);
      setErr('');
      await adminMobileAppApi.downloadApk();
    } catch (e) {
      const msg =
        e.message ||
        e.response?.data?.error ||
        e.response?.data?.detail ||
        (typeof e.response?.data === 'string' ? e.response.data : null) ||
        'Download failed';
      setErr(msg);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-2">
        <Smartphone className="w-8 h-8 text-theme-fg-muted" />
        <h1 className="text-xl font-semibold tracking-tight">Mobile Apps</h1>
      </div>
      <p className="text-sm text-theme-fg-muted mb-6">
        Admin-only download for the Android release. The APK is built with the production API base URL embedded in the
        bundle (Expo <code className="text-xs">EXPO_PUBLIC_API_URL</code>).
      </p>

      <div className="rounded-lg border border-theme-border bg-theme-card p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-theme-accent text-theme-accent-fg text-sm font-medium disabled:opacity-50"
            onClick={load}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-theme-border text-sm font-medium disabled:opacity-50"
            onClick={onDownload}
            disabled={loading || downloading || !info?.available}
          >
            <Download className="w-4 h-4" />
            {downloading ? 'Downloading…' : 'Download APK'}
          </button>
        </div>

        {err ? <p className="text-sm text-red-600 dark:text-red-400">{err}</p> : null}

        {loading ? (
          <p className="text-sm text-theme-fg-muted">Loading…</p>
        ) : info ? (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-theme-fg-muted">Status</dt>
              <dd className="font-medium">{info.available ? 'Ready' : 'Not deployed'}</dd>
            </div>
            {info.available ? (
              <>
                <div>
                  <dt className="text-theme-fg-muted">File</dt>
                  <dd className="font-mono text-xs break-all">{info.filename}</dd>
                </div>
                <div>
                  <dt className="text-theme-fg-muted">Size</dt>
                  <dd>{formatBytes(info.sizeBytes)}</dd>
                </div>
                <div>
                  <dt className="text-theme-fg-muted">Updated (server)</dt>
                  <dd className="text-xs">{info.updatedAt ? new Date(info.updatedAt).toLocaleString() : '—'}</dd>
                </div>
              </>
            ) : null}
            <div className="sm:col-span-2">
              <dt className="text-theme-fg-muted">Documented API base (build-time)</dt>
              <dd className="font-mono text-xs break-all">{info.embeddedApiBase || '— (set MOBILE_APP_EMBEDDED_API_BASE on server for label)'}</dd>
            </div>
            {!info.available && info.message ? (
              <div className="sm:col-span-2 text-xs text-theme-fg-muted">{info.message}</div>
            ) : null}
          </dl>
        ) : null}
      </div>
    </div>
  );
}
