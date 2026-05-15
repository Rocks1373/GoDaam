import { useRef, useState } from 'react';
import { FileText, Upload, Loader2, Check, Edit3, Save, RotateCcw, AlertTriangle } from 'lucide-react';
import { ocrAndExtract } from '../services/puterAI';
import { writeJSON } from '../services/puterStorage';
import { ensureSignedIn } from '../services/puterAuth';

const EMPTY_RESULT = {
  documentType: '',
  poNumber: '',
  soNumber: '',
  deliveryNumber: '',
  invoiceNumber: '',
  vendorName: '',
  customerName: '',
  date: '',
  lineItems: [],
};

const FIELD_LABELS = {
  documentType: 'Document type',
  poNumber: 'PO number',
  soNumber: 'SO number',
  deliveryNumber: 'Delivery number',
  invoiceNumber: 'Invoice number',
  vendorName: 'Vendor name',
  customerName: 'Customer name',
  date: 'Date',
};

function isSupportedFile(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  return (
    type.startsWith('image/') ||
    type === 'application/pdf' ||
    /\.(png|jpe?g|webp|gif|bmp|tiff?|pdf)$/i.test(name)
  );
}

export default function PuterOCRUpload() {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rawText, setRawText] = useState('');
  const [structured, setStructured] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState(null);
  const [saved, setSaved] = useState(false);

  const onPickFile = (e) => {
    const f = e.target.files?.[0];
    setError('');
    setSaved(false);
    setRawText('');
    setStructured(null);
    setEditData(null);
    setEditing(false);
    if (!f) {
      setFile(null);
      setPreview(null);
      return;
    }
    if (!isSupportedFile(f)) {
      setError('Choose an image or PDF file.');
      return;
    }
    setFile(f);
    if (f.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => setPreview(ev.target?.result);
      reader.readAsDataURL(f);
    } else {
      setPreview(null);
    }
  };

  const runOCR = async () => {
    if (!file || busy) return;
    setError('');
    setBusy(true);
    setSaved(false);
    try {
      await ensureSignedIn();
      const result = await ocrAndExtract(file);
      setRawText(result.rawText || '');
      if (result.structured && !result.structured.parseError) {
        setStructured(result.structured);
        setEditData(JSON.parse(JSON.stringify(result.structured)));
      } else {
        setStructured(null);
        setEditData(null);
        if (result.error) setError(result.error);
      }
    } catch (e) {
      setError(e.message || 'OCR failed');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFile(null);
    setPreview(null);
    setRawText('');
    setStructured(null);
    setEditData(null);
    setEditing(false);
    setError('');
    setSaved(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const updateField = (field, value) => {
    setEditData((prev) => ({ ...prev, [field]: value }));
  };

  const updateLineItem = (idx, field, value) => {
    setEditData((prev) => {
      const items = [...(prev.lineItems || [])];
      items[idx] = { ...items[idx], [field]: value };
      return { ...prev, lineItems: items };
    });
  };

  const addLineItem = () => {
    setEditData((prev) => ({
      ...prev,
      lineItems: [...(prev.lineItems || []), { partNumber: '', description: '', quantity: '', uom: '' }],
    }));
  };

  const removeLineItem = (idx) => {
    setEditData((prev) => ({
      ...prev,
      lineItems: (prev.lineItems || []).filter((_, i) => i !== idx),
    }));
  };

  const saveToCloud = async () => {
    if (!editData) return;
    setBusy(true);
    setError('');
    try {
      await ensureSignedIn();
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const name = `ocr/${(editData.documentType || 'doc').replace(/\s+/g, '_')}_${ts}.json`;
      await writeJSON(name, { ...editData, sourceFile: file?.name || '', extractedAt: new Date().toISOString() });
      setSaved(true);
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const data = editing ? editData : structured;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-theme-border bg-theme-card p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-lg bg-amber-600 text-white flex items-center justify-center">
            <FileText size={18} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-theme-fg">Invoice / Document OCR</h3>
            <p className="text-[10px] text-theme-fg-muted">Upload an invoice, DN, PO, or packing list to extract fields</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept="image/*,.pdf,application/pdf"
            onChange={onPickFile}
          />
          <button
            type="button"
            className="btn-secondary inline-flex items-center gap-1.5 text-xs"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            <Upload size={14} />
            {file ? 'Change file' : 'Select file'}
          </button>

          {file && (
            <>
              <button
                type="button"
                className="btn-primary inline-flex items-center gap-1.5 text-xs"
                onClick={runOCR}
                disabled={busy}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                {busy ? 'Processing…' : 'Extract fields'}
              </button>
              <button type="button" className="btn-secondary text-xs" onClick={reset} disabled={busy}>
                <RotateCcw size={14} />
              </button>
              <span className="text-[10px] text-theme-fg-muted truncate max-w-[200px]">{file.name}</span>
            </>
          )}
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800 px-3 py-2 text-[11px] text-red-700 dark:text-red-400 flex items-start gap-2">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {preview && (
          <div className="mb-3">
            <img src={preview} alt="Preview" className="max-h-48 rounded-lg border border-theme-border object-contain" />
          </div>
        )}
      </div>

      {rawText && (
        <div className="rounded-xl border border-theme-border bg-theme-card p-4">
          <h4 className="text-xs font-bold text-theme-fg mb-2">Raw OCR text</h4>
          <pre className="text-[10px] text-theme-fg-muted bg-theme-page rounded-lg p-3 max-h-40 overflow-auto whitespace-pre-wrap border border-theme-border">
            {rawText}
          </pre>
        </div>
      )}

      {data && (
        <div className="rounded-xl border border-theme-border bg-theme-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-bold text-theme-fg">Extracted fields</h4>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className={`btn-secondary text-xs inline-flex items-center gap-1 ${editing ? 'ring-2 ring-amber-400' : ''}`}
                onClick={() => setEditing(!editing)}
              >
                <Edit3 size={13} />
                {editing ? 'Stop editing' : 'Edit'}
              </button>
              <button
                type="button"
                className="btn-primary text-xs inline-flex items-center gap-1"
                onClick={saveToCloud}
                disabled={busy || saved}
              >
                {saved ? <Check size={13} /> : <Save size={13} />}
                {saved ? 'Saved' : 'Save to cloud'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
            {Object.entries(FIELD_LABELS).map(([key, label]) => (
              <div key={key} className="space-y-0.5">
                <label className="text-[10px] font-semibold text-theme-fg-muted uppercase tracking-wide">{label}</label>
                {editing ? (
                  <input
                    type="text"
                    className="w-full text-xs border border-theme-border rounded-md px-2 py-1 bg-theme-page text-theme-fg"
                    value={data[key] ?? ''}
                    onChange={(e) => updateField(key, e.target.value)}
                  />
                ) : (
                  <div className="text-xs text-theme-fg font-medium px-2 py-1 bg-theme-page rounded-md border border-theme-border min-h-[28px]">
                    {data[key] || <span className="text-theme-fg-muted italic">—</span>}
                  </div>
                )}
              </div>
            ))}
          </div>

          {(data.lineItems || []).length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h5 className="text-[11px] font-bold text-theme-fg">Line items ({data.lineItems.length})</h5>
                {editing && (
                  <button type="button" className="btn-secondary text-[10px]" onClick={addLineItem}>
                    + Add row
                  </button>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-theme-border">
                      <th className="text-left py-1 px-2 text-theme-fg-muted font-semibold">Part #</th>
                      <th className="text-left py-1 px-2 text-theme-fg-muted font-semibold">Description</th>
                      <th className="text-left py-1 px-2 text-theme-fg-muted font-semibold">Qty</th>
                      <th className="text-left py-1 px-2 text-theme-fg-muted font-semibold">UOM</th>
                      {editing && <th className="w-8" />}
                    </tr>
                  </thead>
                  <tbody>
                    {data.lineItems.map((item, idx) => (
                      <tr key={idx} className="border-b border-theme-border/50">
                        {editing ? (
                          <>
                            <td className="py-1 px-1">
                              <input className="w-full text-xs border border-theme-border rounded px-1 py-0.5 bg-theme-page" value={item.partNumber ?? ''} onChange={(e) => updateLineItem(idx, 'partNumber', e.target.value)} />
                            </td>
                            <td className="py-1 px-1">
                              <input className="w-full text-xs border border-theme-border rounded px-1 py-0.5 bg-theme-page" value={item.description ?? ''} onChange={(e) => updateLineItem(idx, 'description', e.target.value)} />
                            </td>
                            <td className="py-1 px-1">
                              <input className="w-20 text-xs border border-theme-border rounded px-1 py-0.5 bg-theme-page" value={item.quantity ?? ''} onChange={(e) => updateLineItem(idx, 'quantity', e.target.value)} />
                            </td>
                            <td className="py-1 px-1">
                              <input className="w-16 text-xs border border-theme-border rounded px-1 py-0.5 bg-theme-page" value={item.uom ?? ''} onChange={(e) => updateLineItem(idx, 'uom', e.target.value)} />
                            </td>
                            <td className="py-1 px-1">
                              <button type="button" className="text-red-500 hover:text-red-700 text-[10px]" onClick={() => removeLineItem(idx)}>x</button>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="py-1 px-2 font-mono">{item.partNumber || '—'}</td>
                            <td className="py-1 px-2">{item.description || '—'}</td>
                            <td className="py-1 px-2 font-mono">{item.quantity || '—'}</td>
                            <td className="py-1 px-2">{item.uom || '—'}</td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="mt-3">
            <details className="text-[10px]">
              <summary className="cursor-pointer text-theme-fg-muted hover:text-theme-fg font-semibold">Raw JSON</summary>
              <pre className="mt-1 bg-theme-page rounded-lg p-2 overflow-auto max-h-40 border border-theme-border text-theme-fg-muted">
                {JSON.stringify(data, null, 2)}
              </pre>
            </details>
          </div>
        </div>
      )}
    </div>
  );
}
