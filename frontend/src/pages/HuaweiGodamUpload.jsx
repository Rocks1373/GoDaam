import { useEffect, useMemo, useRef, useState } from 'react';
import { UploadCloud, RefreshCw, Activity, FileText } from 'lucide-react';
import api, { huaweiGodamApi } from '../services/api';

const MASTER_FIELDS = [
  { key: 'summary', label: 'Summary', required: true },
  { key: 'po', label: 'PO', required: true },
  { key: 'so', label: 'SO', required: true },
  { key: 'vcust', label: 'VCUST', required: true },
  { key: 'contracts', label: 'Contracts', required: true },
  { key: 'accessories', label: 'Accessories', required: true },
];

export default function HuaweiGodamUpload({ currentUser }) {
  const isAdmin = String(currentUser?.role || '').toLowerCase() === 'admin';
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [masters, setMasters] = useState({});
  const [dnFiles, setDnFiles] = useState([]);
  const [rulesFile, setRulesFile] = useState(null);
  const [batches, setBatches] = useState([]);
  const [health, setHealth] = useState(null);
  const [selected, setSelected] = useState(null);
  const [selectedLoading, setSelectedLoading] = useState(false);

  // Customer Order List (new Huawei DB design)
  const [poQuery, setPoQuery] = useState('');
  const [poOptions, setPoOptions] = useState([]);
  const [poLoading, setPoLoading] = useState(false);
  const [poSelected, setPoSelected] = useState('');
  const [dsaOptions, setDsaOptions] = useState([]);
  const [dsaLoading, setDsaLoading] = useState(false);
  const [dsaSelected, setDsaSelected] = useState('');
  const [itemRows, setItemRows] = useState([]);
  const [itemsLoading, setItemsLoading] = useState(false);

  const mastersRef = useRef({});
  mastersRef.current = masters;

  const canUpload = useMemo(() => {
    if (isAdmin) return true;
    return false;
  }, [isAdmin]);

  const load = async () => {
    setLoading(true);
    setMsg('');
    try {
      const [h, rows] = await Promise.all([
        huaweiGodamApi.health().catch(() => null),
        huaweiGodamApi.listBatches(50).catch(() => []),
      ]);
      setHealth(h);
      setBatches(rows || []);
    } catch (e) {
      setMsg(e?.response?.data?.error || e?.message || 'Failed to load Huawei GoDam status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const loadPoOptions = async (q) => {
    setPoLoading(true);
    try {
      const out = await huaweiGodamApi.poOptions(q || '', 50);
      setPoOptions(out?.pos || []);
    } catch {
      setPoOptions([]);
    } finally {
      setPoLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      if (!alive) return;
      loadPoOptions(poQuery);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [poQuery]);

  const choosePo = async (po) => {
    const p = String(po || '').trim();
    setPoSelected(p);
    setDsaSelected('');
    setItemRows([]);
    setDsaOptions([]);
    if (!p) return;
    setDsaLoading(true);
    try {
      const out = await huaweiGodamApi.dsaOptions(p);
      setDsaOptions(out?.dsas || []);
    } catch {
      setDsaOptions([]);
    } finally {
      setDsaLoading(false);
    }
  };

  const chooseDsa = async (dsa) => {
    const d = String(dsa || '').trim();
    setDsaSelected(d);
    setItemRows([]);
    if (!poSelected || !d) return;
    setItemsLoading(true);
    try {
      const out = await huaweiGodamApi.dsaItems(poSelected, d);
      setItemRows(out?.items || []);
    } catch {
      setItemRows([]);
    } finally {
      setItemsLoading(false);
    }
  };

  const allMastersPresent = useMemo(() => {
    return MASTER_FIELDS.every((f) => !!masters[f.key]);
  }, [masters]);

  const submit = async () => {
    if (!canUpload) {
      setMsg('Forbidden: Admin only.');
      return;
    }
    if (!allMastersPresent) {
      setMsg('Please select all required master files (Summary, PO, SO, VCUST, Contracts, Accessories).');
      return;
    }
    if (!dnFiles?.length) {
      setMsg('Please select at least one DN file (.xlsx/.xls).');
      return;
    }
    setLoading(true);
    setMsg('');
    try {
      const res = await huaweiGodamApi.createBatch(mastersRef.current, dnFiles, rulesFile);
      setMsg(`Batch #${res?.id || ''} completed.`);
      setDnFiles([]);
      setRulesFile(null);
      setMasters({});
      await load();
      if (res?.id) {
        setSelectedLoading(true);
        try {
          const d = await huaweiGodamApi.getBatch(res.id);
          setSelected(d || null);
        } catch {
          setSelected(null);
        } finally {
          setSelectedLoading(false);
        }
      }
    } catch (e) {
      setMsg(e?.response?.data?.error || e?.message || 'Upload failed');
    } finally {
      setLoading(false);
    }
  };

  const openBatch = async (id) => {
    const batchId = Number(id);
    if (!batchId) return;
    setSelectedLoading(true);
    setMsg('');
    try {
      const d = await huaweiGodamApi.getBatch(batchId);
      setSelected(d || null);
    } catch (e) {
      setSelected(null);
      setMsg(e?.response?.data?.error || e?.message || 'Failed to load batch details');
    } finally {
      setSelectedLoading(false);
    }
  };

  /**
   * Uploaded files are served only via the authenticated /api/files/uploads/*
   * route. We can't use a plain <a href> (browsers won't send the bearer token),
   * so artifact links go through axios as a blob and trigger a client-side download.
   */
  const downloadArtifact = async (rel, suggestedName) => {
    const s = String(rel || '');
    if (!s) return;
    const stripped = s.replace(/^uploads\//, '').replace(/^\/+/, '');
    try {
      const res = await api.get(`/files/uploads/${stripped}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestedName || stripped.split('/').pop() || 'download';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setMsg(`Download failed: ${e?.response?.status || ''} ${e?.message || e}`);
    }
  };

  return (
    <div>
      <div className="mb-2">
        <h2 className="text-base font-bold text-gray-900 leading-tight">Huawei · GoDam upload</h2>
        <p className="text-[11px] text-gray-600">
          Upload the 6 required master Excel files + one or more DN files. The server runs the matcher and imports results into
          the Huawei GoDam DB.
        </p>
      </div>

      <div className="app-page-toolbar flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary flex items-center gap-1" onClick={load} disabled={loading}>
          <RefreshCw size={14} />
          Refresh
        </button>
        <button type="button" className="btn-primary flex items-center gap-1" onClick={submit} disabled={loading || !canUpload}>
          <UploadCloud size={14} />
          Upload & Run
        </button>
        {loading ? <span className="text-[11px] text-gray-500">Working…</span> : null}
      </div>

      {msg ? <div className="mt-2 text-[11px] text-gray-700">{msg}</div> : null}

      {!canUpload ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
          This screen is currently <b>Admin only</b>. If you want non-admin roles to upload, we can add a permission check.
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-3 items-start">
        <div className="lg:col-span-2 rounded-lg border border-theme-border bg-theme-card p-3">
          <div className="rounded-lg border border-theme-border bg-theme-page p-3 mb-3">
            <div className="text-[10px] font-bold text-theme-fg-muted uppercase mb-2">Customer Order List (PO → DSA → Items)</div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-2 items-end">
              <label className="block">
                <div className="text-[11px] font-bold text-theme-fg">PO search</div>
                <input
                  className="mt-1 w-full rounded-lg border border-theme-border bg-white px-3 py-2 text-[11px]"
                  value={poQuery}
                  onChange={(e) => setPoQuery(e.target.value)}
                  placeholder="Type PO number..."
                />
                <div className="mt-1 text-[10px] text-theme-fg-muted">
                  {poLoading ? 'Searching…' : `${(poOptions || []).length} PO(s)`}
                </div>
              </label>
              <label className="block">
                <div className="text-[11px] font-bold text-theme-fg">PO number</div>
                <select
                  className="mt-1 w-full rounded-lg border border-theme-border bg-white px-3 py-2 text-[11px]"
                  value={poSelected}
                  onChange={(e) => choosePo(e.target.value)}
                >
                  <option value="">Select PO</option>
                  {(poOptions || []).map((po) => (
                    <option key={po} value={po}>
                      {po}
                    </option>
                  ))}
                </select>
                <div className="mt-1 text-[10px] text-theme-fg-muted">
                  {dsaLoading ? 'Loading DSA…' : poSelected ? `${(dsaOptions || []).length} DSA(s) (Received)` : ' '}
                </div>
              </label>
              <label className="block">
                <div className="text-[11px] font-bold text-theme-fg">DSA number (status=Received)</div>
                <select
                  className="mt-1 w-full rounded-lg border border-theme-border bg-white px-3 py-2 text-[11px]"
                  value={dsaSelected}
                  onChange={(e) => chooseDsa(e.target.value)}
                  disabled={!poSelected || dsaLoading}
                >
                  <option value="">Select DSA</option>
                  {(dsaOptions || []).map((d) => (
                    <option key={d.id} value={d.dsa_number}>
                      {d.dsa_number}
                    </option>
                  ))}
                </select>
                <div className="mt-1 text-[10px] text-theme-fg-muted">
                  {itemsLoading ? 'Loading items…' : dsaSelected ? `${(itemRows || []).length} item row(s)` : ' '}
                </div>
              </label>
            </div>

            {poSelected && dsaSelected ? (
              <div className="mt-3 rounded-lg border border-theme-border bg-white overflow-hidden">
                <div className="px-3 py-2 border-b border-theme-border bg-theme-muted text-[11px] font-bold text-theme-fg">
                  Items for PO {poSelected} / DSA {dsaSelected}
                </div>
                <div className="max-h-[360px] overflow-auto">
                  <table className="min-w-full text-[11px]">
                    <thead className="sticky top-0 bg-white border-b border-theme-border">
                      <tr className="text-left">
                        <th className="px-3 py-2">Part</th>
                        <th className="px-3 py-2">Description</th>
                        <th className="px-3 py-2">Qty</th>
                        <th className="px-3 py-2">UOM</th>
                        <th className="px-3 py-2">Contract</th>
                        <th className="px-3 py-2">SO</th>
                        <th className="px-3 py-2">Source file</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(itemRows || []).map((r) => (
                        <tr key={r.id} className="border-b border-theme-border">
                          <td className="px-3 py-2 font-mono">{r.part_number || '-'}</td>
                          <td className="px-3 py-2">{r.description || '-'}</td>
                          <td className="px-3 py-2">{r.quantity ?? '-'}</td>
                          <td className="px-3 py-2">{r.uom || '-'}</td>
                          <td className="px-3 py-2 font-mono">{r.contract_no || '-'}</td>
                          <td className="px-3 py-2 font-mono">{r.so_number || '-'}</td>
                          <td className="px-3 py-2 truncate max-w-[220px]" title={r.source_file || ''}>
                            {r.source_file || '-'}
                          </td>
                        </tr>
                      ))}
                      {!(itemRows || []).length && !itemsLoading ? (
                        <tr>
                          <td className="px-3 py-3 text-theme-fg-muted" colSpan={7}>
                            No items found for this PO/DSA with status=Received. (If you just imported, run a Huawei batch first.)
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="mt-3 text-[11px] text-theme-fg-muted">
                Select a PO and DSA to view the saved item-level rows.
              </div>
            )}
          </div>

          <div className="text-[10px] font-bold text-theme-fg-muted uppercase mb-2 flex items-center gap-2">
            <FileText className="w-3 h-3" />
            Required masters
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {MASTER_FIELDS.map((f) => (
              <label key={f.key} className="rounded-lg border border-theme-border bg-theme-page p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-bold text-theme-fg">{f.label}</div>
                  {masters[f.key] ? (
                    <span className="text-[10px] font-semibold text-emerald-700">Selected</span>
                  ) : (
                    <span className="text-[10px] font-semibold text-red-700">Missing</span>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-theme-fg-muted truncate">
                  {masters[f.key]?.name || 'Choose .xlsx/.xls'}
                </div>
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  className="mt-2 block w-full text-[11px]"
                  onChange={(e) => {
                    const file = e.target.files?.[0] || null;
                    setMasters((s) => {
                      if (!file) {
                        const next = { ...s };
                        delete next[f.key];
                        return next;
                      }
                      return { ...s, [f.key]: file };
                    });
                  }}
                />
              </label>
            ))}
          </div>

          <div className="mt-3">
            <div className="text-[10px] font-bold text-theme-fg-muted uppercase mb-2">DN files (one or more)</div>
            <input
              type="file"
              accept=".xlsx,.xls"
              multiple
              className="block w-full text-[11px]"
              onChange={(e) => setDnFiles(Array.from(e.target.files || []))}
            />
            <div className="mt-1 text-[11px] text-theme-fg-muted">
              Selected: <b>{dnFiles.length}</b>
            </div>
          </div>

          <div className="mt-3">
            <div className="text-[10px] font-bold text-theme-fg-muted uppercase mb-2">Optional rules.json</div>
            <input
              type="file"
              accept=".json"
              className="block w-full text-[11px]"
              onChange={(e) => setRulesFile(e.target.files?.[0] || null)}
            />
            <div className="mt-1 text-[11px] text-theme-fg-muted truncate">
              {rulesFile?.name ? `Selected: ${rulesFile.name}` : 'If empty, server uses plugin default rules.json'}
            </div>
          </div>

          {health && !health.pluginReady ? (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-[11px] text-red-800">
              Plugin not ready on server. Ensure `plugins/GoDam-1.0` exists and matcher CLI is present. Server reports:
              <div className="mt-2 font-mono text-[10px] whitespace-pre-wrap">
                {JSON.stringify(health, null, 2)}
              </div>
            </div>
          ) : null}

          {selected ? (
            <div className="mt-4 rounded-lg border border-theme-border bg-theme-page p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] font-bold text-theme-fg-muted uppercase">
                  Batch #{selected?.batch?.id} outputs
                </div>
                <button type="button" className="btn-secondary !py-1 !px-2" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
              {selectedLoading ? (
                <div className="mt-2 text-[11px] text-theme-fg-muted">Loading…</div>
              ) : (
                <>
                  <div className="mt-2 text-[11px] text-theme-fg-muted">
                    Status: <b>{selected?.batch?.status || '-'}</b>
                  </div>
                  {(selected?.artifacts || []).length ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selected.artifacts.map((a) => (
                        <button
                          type="button"
                          key={a.id}
                          className="btn-secondary text-[11px] !py-1.5 !px-2"
                          onClick={() => downloadArtifact(a.relative_path, a.original_filename)}
                          title={a.relative_path}
                        >
                          Download {a.kind}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2 text-[11px] text-theme-fg-muted">
                      No artifacts recorded for this batch yet.
                    </div>
                  )}
                  {selected?.batch?.error_message ? (
                    <div className="mt-2 text-[11px] text-red-700 whitespace-pre-wrap">
                      {String(selected.batch.error_message)}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-theme-border bg-theme-card p-3">
          <div className="text-[10px] font-bold text-theme-fg-muted uppercase mb-2 flex items-center gap-2">
            <Activity className="w-3 h-3" />
            Recent batches
          </div>
          <div className="space-y-2">
            {(batches || []).slice(0, 12).map((b) => (
              <div key={b.id} className="rounded-lg border border-theme-border bg-theme-page p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-bold text-theme-fg">#{b.id}</div>
                  <div
                    className={`text-[10px] font-bold ${
                      String(b.status || '').toLowerCase() === 'completed'
                        ? 'text-emerald-700'
                        : String(b.status || '').toLowerCase() === 'failed'
                          ? 'text-red-700'
                          : 'text-amber-700'
                    }`}
                  >
                    {b.status || '-'}
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-theme-fg-muted">
                  {b.summary_original_filename || '—'} / {b.po_original_filename || '—'}
                </div>
                {b.error_message ? (
                  <div className="mt-1 text-[11px] text-red-700 line-clamp-3">{String(b.error_message)}</div>
                ) : null}
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary !py-1 !px-2 text-[11px]"
                    onClick={() => openBatch(b.id)}
                    disabled={selectedLoading}
                  >
                    View / download
                  </button>
                  {selected?.batch?.id === b.id ? (
                    <span className="text-[10px] font-bold text-theme-fg-muted uppercase">Selected</span>
                  ) : null}
                </div>
                <div className="mt-1 text-[10px] text-theme-fg-muted">
                  {b.created_at ? new Date(b.created_at).toLocaleString() : ''}
                </div>
              </div>
            ))}
            {!batches?.length ? <div className="text-[11px] text-theme-fg-muted">No batches yet.</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

