import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, Download, File, FileText, FolderPlus, Loader2, RefreshCw, Trash2, Upload, AlertTriangle } from 'lucide-react';
import { listFiles, uploadFile, deleteFile, createFolder, readFile } from '../services/puterStorage';
import { ensureSignedIn, isSignedIn } from '../services/puterAuth';

function formatSize(bytes) {
  if (!bytes || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return String(d);
  }
}

export default function PuterStoragePanel() {
  const [path, setPath] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await ensureSignedIn();
      const list = await listFiles(path);
      setItems(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(e.message || 'Failed to list files');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (isSignedIn()) refresh();
  }, [refresh]);

  const navigateTo = (folderName) => {
    setPath((p) => (p ? `${p}/${folderName}` : folderName));
  };

  const goUp = () => {
    setPath((p) => {
      const parts = p.split('/').filter(Boolean);
      parts.pop();
      return parts.join('/');
    });
  };

  const handleUpload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    setError('');
    try {
      await ensureSignedIn();
      await uploadFile(f, path || 'uploads');
      await refresh();
    } catch (err) {
      setError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleCreateFolder = async () => {
    const name = prompt('Folder name:');
    if (!name?.trim()) return;
    setError('');
    try {
      await ensureSignedIn();
      await createFolder(path ? `${path}/${name.trim()}` : name.trim());
      await refresh();
    } catch (err) {
      setError(err.message || 'Failed to create folder');
    }
  };

  const handleDelete = async (item) => {
    const name = item.name || item;
    if (!confirm(`Delete "${name}"?`)) return;
    setError('');
    try {
      await deleteFile(path ? `${path}/${name}` : name);
      await refresh();
    } catch (err) {
      setError(err.message || 'Delete failed');
    }
  };

  const handleDownload = async (item) => {
    const name = item.name || item;
    try {
      const blob = await readFile(path ? `${path}/${name}` : name);
      if (blob instanceof Blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setError(err.message || 'Download failed');
    }
  };

  const breadcrumbs = ['GoDam', ...(path ? path.split('/') : [])];

  return (
    <div className="rounded-xl border border-theme-border bg-theme-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center">
          <Cloud size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-theme-fg">Cloud storage</h3>
          <p className="text-[10px] text-theme-fg-muted">Puter cloud file storage for GoDam</p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 mb-3 text-[10px]">
        {breadcrumbs.map((seg, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-theme-fg-muted">/</span>}
            <button
              type="button"
              className={`hover:underline ${i === breadcrumbs.length - 1 ? 'font-bold text-theme-fg' : 'text-theme-primary'}`}
              onClick={() => {
                if (i === 0) setPath('');
                else setPath(path.split('/').slice(0, i).join('/'));
              }}
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      <div className="flex items-center gap-1.5 mb-3">
        <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />
        <button
          type="button"
          className="btn-secondary text-xs inline-flex items-center gap-1"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
          Upload
        </button>
        <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1" onClick={handleCreateFolder}>
          <FolderPlus size={13} />
          New folder
        </button>
        {path && (
          <button type="button" className="btn-secondary text-xs" onClick={goUp}>
            .. Up
          </button>
        )}
        <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1" onClick={refresh} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800 px-3 py-2 text-[11px] text-red-700 dark:text-red-400 flex items-start gap-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-theme-fg-muted text-xs flex items-center justify-center gap-2">
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="py-8 text-center text-theme-fg-muted text-xs">
          {isSignedIn() ? 'Empty folder. Upload files or create a subfolder.' : 'Sign in to Puter to access cloud storage.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-theme-border text-left">
                <th className="py-1.5 px-2 text-theme-fg-muted font-semibold">Name</th>
                <th className="py-1.5 px-2 text-theme-fg-muted font-semibold w-20">Size</th>
                <th className="py-1.5 px-2 text-theme-fg-muted font-semibold w-32">Modified</th>
                <th className="py-1.5 px-2 w-16" />
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
                const name = item.name || String(item);
                const isDir = item.is_dir || item.isDirectory;
                return (
                  <tr key={idx} className="border-b border-theme-border/50 hover:bg-theme-muted/30">
                    <td className="py-1.5 px-2">
                      {isDir ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 text-theme-primary hover:underline font-medium"
                          onClick={() => navigateTo(name)}
                        >
                          <FolderPlus size={13} /> {name}
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <FileText size={13} className="text-theme-fg-muted" /> {name}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-theme-fg-muted">{isDir ? '—' : formatSize(item.size)}</td>
                    <td className="py-1.5 px-2 text-theme-fg-muted">{formatDate(item.modified || item.created)}</td>
                    <td className="py-1.5 px-2">
                      <div className="flex items-center gap-1">
                        {!isDir && (
                          <button type="button" className="text-theme-fg-muted hover:text-theme-primary" title="Download" onClick={() => handleDownload(item)}>
                            <Download size={13} />
                          </button>
                        )}
                        <button type="button" className="text-theme-fg-muted hover:text-red-600" title="Delete" onClick={() => handleDelete(item)}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
