import { useCallback, useEffect, useRef, useState } from 'react';
import { Boxes, Plus, Trash2, Upload, Download, Search } from 'lucide-react';
import { bomApi } from '../services/api';
import { reportUploadError, reportUploadResult } from '../utils/uploadErrorReport';

function StockBadge({ inMainStock, inRack, mainQty, rackQty }) {
  if (inMainStock && inRack) {
    return (
      <span className="inline-flex gap-1">
        <span className="text-[10px] bg-green-100 text-green-800 border border-green-300 rounded px-1">
          Main {mainQty}
        </span>
        <span className="text-[10px] bg-blue-100 text-blue-800 border border-blue-300 rounded px-1">
          Rack {rackQty}
        </span>
      </span>
    );
  }
  if (inMainStock) {
    return (
      <span className="text-[10px] bg-green-100 text-green-800 border border-green-300 rounded px-1">
        Main stock {mainQty}
      </span>
    );
  }
  if (inRack) {
    return (
      <span className="text-[10px] bg-blue-100 text-blue-800 border border-blue-300 rounded px-1">
        Rack only {rackQty}
      </span>
    );
  }
  return (
    <span className="text-[10px] bg-gray-100 text-gray-500 border border-gray-200 rounded px-1">
      Not in stock
    </span>
  );
}

function ParentAutocomplete({ value, onChange, onSelect }) {
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const onInput = (e) => {
    const v = e.target.value;
    onChange(v);
    clearTimeout(timerRef.current);
    if (!v.trim()) { setResults([]); setOpen(false); return; }
    timerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const rows = await bomApi.searchStock(v.trim());
        setResults(Array.isArray(rows) ? rows : []);
        setOpen(true);
      } catch { setResults([]); }
      finally { setSearching(false); }
    }, 280);
  };

  const pick = (row) => {
    onSelect(row);
    setOpen(false);
    setResults([]);
  };

  return (
    <div className="relative" ref={boxRef}>
      <div className="relative">
        <input
          className="border rounded px-2 py-1 text-sm w-full pr-7"
          placeholder="Type part number or description to search stock…"
          value={value}
          onChange={onInput}
          onFocus={() => results.length && setOpen(true)}
          autoComplete="off"
        />
        {searching && (
          <span className="absolute right-2 top-1.5 text-gray-400 text-xs">…</span>
        )}
      </div>
      {open && results.length > 0 && (
        <ul className="absolute z-30 w-full bg-white border border-gray-200 rounded shadow-lg mt-0.5 max-h-64 overflow-y-auto text-sm">
          {results.map((r) => (
            <li
              key={r.part_number}
              className="flex items-start justify-between gap-2 px-3 py-1.5 hover:bg-blue-50 cursor-pointer border-b border-gray-50 last:border-0"
              onMouseDown={() => pick(r)}
            >
              <div className="min-w-0">
                <div className="font-semibold truncate">{r.part_number}</div>
                {r.sap_part_number && r.sap_part_number !== r.part_number && (
                  <div className="text-xs text-gray-500 truncate">SAP: {r.sap_part_number}</div>
                )}
                {r.description && (
                  <div className="text-xs text-gray-400 truncate">{r.description}</div>
                )}
              </div>
              <div className="flex-shrink-0 pt-0.5">
                <StockBadge
                  inMainStock={r.in_main_stock}
                  inRack={r.in_rack}
                  mainQty={r.main_stock_qty}
                  rackQty={r.rack_qty}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function AdminBomParts() {
  const [sets, setSets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [parentPn, setParentPn] = useState('');
  const [parentSap, setParentSap] = useState('');
  const [parentDesc, setParentDesc] = useState('');
  const [parentPhysical, setParentPhysical] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [childPn, setChildPn] = useState('');
  const [childSap, setChildSap] = useState('');
  const [childDesc, setChildDesc] = useState('');
  const [childQty, setChildQty] = useState('1');
  const [childUom, setChildUom] = useState('PCS');
  const [childStockInfo, setChildStockInfo] = useState(null);
  const childSearchTimer = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const rows = await bomApi.list();
      setSets(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
      setSets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (id) => {
    setSelectedId(id);
    const row = sets.find((s) => Number(s.id) === Number(id));
    if (!row) return;
    try {
      const d = await bomApi.getByParent(row.parent_part_number);
      setDetail(d);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
      setDetail(null);
    }
  };

  const onSelectParentFromStock = (row) => {
    setParentPn(row.part_number);
    setParentSap(row.sap_part_number || '');
    setParentDesc(row.description || '');
  };

  const createParent = async () => {
    if (!parentPn.trim()) return;
    setErr('');
    try {
      await bomApi.create({
        parent_part_number: parentPn.trim(),
        parent_sap_part_number: parentSap.trim(),
        parent_description: parentDesc.trim(),
        parent_is_physical: parentPhysical,
        is_active: true,
      });
      setParentPn(''); setParentSap(''); setParentDesc(''); setParentPhysical(false);
      await load();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  const onChildPnChange = (v) => {
    setChildPn(v);
    setChildStockInfo(null);
    clearTimeout(childSearchTimer.current);
    if (!v.trim()) return;
    childSearchTimer.current = setTimeout(async () => {
      try {
        const rows = await bomApi.searchStock(v.trim());
        const match = rows.find(
          (r) => r.part_number.toLowerCase() === v.trim().toLowerCase()
        );
        setChildStockInfo(match || null);
      } catch { /* ignore */ }
    }, 400);
  };

  const addChild = async () => {
    if (!selectedId || !childPn.trim()) return;
    const q = Number(childQty);
    if (!Number.isFinite(q) || q <= 0) { setErr('Child qty per parent must be > 0'); return; }
    setErr('');
    try {
      await bomApi.addChild(selectedId, {
        child_part_number: childPn.trim(),
        child_sap_part_number: childSap.trim(),
        child_description: childDesc.trim(),
        child_qty_per_parent: q,
        uom: childUom.trim() || 'PCS',
        is_active: true,
      });
      setChildPn(''); setChildSap(''); setChildDesc(''); setChildQty('1'); setChildStockInfo(null);
      await load();
      await openDetail(selectedId);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  const removeChild = async (childId) => {
    if (!window.confirm('Remove this child line?')) return;
    setErr('');
    try {
      await bomApi.deleteChild(childId);
      await load();
      if (selectedId) await openDetail(selectedId);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  const deleteSet = async (id) => {
    if (!window.confirm('Delete entire parent BOM (all children)?')) return;
    setErr('');
    try {
      await bomApi.deleteSet(id);
      setSelectedId(null);
      setDetail(null);
      await load();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  const onUpload = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setErr('');
    try {
      const r = await bomApi.upload(f);
      reportUploadResult(r, { label: 'BOM upload', filenamePrefix: 'bom-upload' });
      await load();
    } catch (ex) {
      reportUploadError(ex, { label: 'BOM upload', filenamePrefix: 'bom-upload', notify: setErr });
    }
  };

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-2">
        <Boxes className="w-6 h-6 text-amber-700" />
        <h1 className="text-lg font-bold text-gray-900">Parent &amp; Child Parts (BOM)</h1>
      </div>
      <p className="text-sm text-gray-600 mb-3">
        Optional BOM: outbound lines that match a parent part auto-expand into child pick/FIFO quantities.
        Children are picked from <strong>Stock by Rack only</strong>. A child can also exist in Main Stock (for backup/replacement orders) — the BOM relationship is independent of stock location.
      </p>

      {err ? (
        <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{err}</div>
      ) : null}

      <div className="flex flex-wrap gap-2 mb-4">
        <button
          type="button"
          className="btn-secondary inline-flex items-center gap-1 text-sm"
          onClick={bomApi.downloadTemplate}
        >
          <Download className="w-4 h-4" /> Download Excel template
        </button>
        <label className="btn-secondary inline-flex items-center gap-1 text-sm cursor-pointer">
          <Upload className="w-4 h-4" /> Upload BOM (Excel/CSV)
          <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={onUpload} />
        </label>
      </div>

      {/* Add parent */}
      <div className="border rounded-lg p-4 bg-white mb-6">
        <h2 className="text-sm font-bold text-gray-800 mb-2">Add / create parent</h2>
        <p className="text-xs text-gray-500 mb-2">
          Start typing in the first field to search existing stock and auto-fill — or type a new part number directly.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div className="md:col-span-2">
            <ParentAutocomplete
              value={parentPn}
              onChange={setParentPn}
              onSelect={onSelectParentFromStock}
            />
          </div>
          <input
            className="border rounded px-2 py-1 text-sm"
            placeholder="Parent SAP part number"
            value={parentSap}
            onChange={(e) => setParentSap(e.target.value)}
          />
          <input
            className="border rounded px-2 py-1 text-sm"
            placeholder="Parent description"
            value={parentDesc}
            onChange={(e) => setParentDesc(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input
              type="checkbox"
              checked={parentPhysical}
              onChange={(e) => setParentPhysical(e.target.checked)}
            />
            Parent is physical stock (mark-delivered deducts from parent Main Stock; default = deduct children only)
          </label>
        </div>
        <button
          type="button"
          className="btn-primary mt-2 inline-flex items-center gap-1 text-sm"
          onClick={createParent}
        >
          <Plus className="w-4 h-4" /> Create parent
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Parent list */}
        <div className="border rounded-lg bg-white overflow-hidden">
          <div className="px-3 py-2 bg-gray-50 border-b text-sm font-bold">Parents</div>
          {loading ? <div className="p-3 text-sm text-gray-500">Loading…</div> : null}
          <ul className="max-h-[480px] overflow-y-auto divide-y">
            {sets.map((s) => (
              <li
                key={s.id}
                className={`flex items-center justify-between gap-2 px-3 py-2 text-sm ${Number(selectedId) === Number(s.id) ? 'bg-blue-50' : ''}`}
              >
                <button
                  type="button"
                  className="text-left flex-1 hover:underline"
                  onClick={() => openDetail(s.id)}
                >
                  <div className="font-semibold">{s.parent_part_number}</div>
                  <div className="text-xs text-gray-500">
                    {s.child_count ?? 0} children · {s.is_active ? 'active' : 'inactive'}
                    {s.parent_is_physical ? ' · physical' : ''}
                  </div>
                </button>
                <button
                  type="button"
                  className="text-red-600 p-1"
                  title="Delete"
                  onClick={() => deleteSet(s.id)}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
            {!loading && !sets.length && (
              <li className="p-3 text-sm text-gray-400">No BOM sets yet.</li>
            )}
          </ul>
        </div>

        {/* Child panel */}
        <div className="border rounded-lg p-4 bg-white">
          <div className="text-sm font-bold mb-2">
            Children{detail?.set?.parent_part_number ? ` — ${detail.set.parent_part_number}` : ''}
          </div>
          {!detail ? (
            <div className="text-sm text-gray-500">Select a parent on the left.</div>
          ) : null}

          {detail?.children?.length ? (
            <ul className="mb-4 divide-y border rounded">
              {detail.children.map((c) => (
                <li key={c.id} className="flex justify-between items-start px-2 py-1.5 text-sm gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold">
                      {c.child_part_number} × {c.child_qty_per_parent} {c.uom || ''}
                    </div>
                    {c.child_description && (
                      <div className="text-xs text-gray-500">{c.child_description}</div>
                    )}
                    <ChildStockStatus partNumber={c.child_part_number} />
                  </div>
                  <button
                    type="button"
                    className="text-red-600 flex-shrink-0 mt-0.5"
                    onClick={() => removeChild(c.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {selectedId ? (
            <div className="space-y-2 border-t pt-3">
              <div className="text-xs font-bold text-gray-600">Add child part</div>
              <div className="flex flex-col gap-1">
                <input
                  className="border rounded px-2 py-1 text-sm w-full"
                  placeholder="Child part number"
                  value={childPn}
                  onChange={(e) => onChildPnChange(e.target.value)}
                />
                {childStockInfo && (
                  <div className="flex items-center gap-1.5 text-xs">
                    <Search className="w-3 h-3 text-gray-400" />
                    <StockBadge
                      inMainStock={childStockInfo.in_main_stock}
                      inRack={childStockInfo.in_rack}
                      mainQty={childStockInfo.main_stock_qty}
                      rackQty={childStockInfo.rack_qty}
                    />
                    {!childStockInfo.in_rack && (
                      <span className="text-amber-700 font-medium">Not in rack — will show shortage until stocked in rack</span>
                    )}
                    {childStockInfo.in_rack && !childStockInfo.in_main_stock && (
                      <span className="text-blue-700">Rack only (will not appear in Main Stock list)</span>
                    )}
                  </div>
                )}
              </div>
              <input
                className="border rounded px-2 py-1 text-sm w-full"
                placeholder="Child SAP (optional)"
                value={childSap}
                onChange={(e) => setChildSap(e.target.value)}
              />
              <input
                className="border rounded px-2 py-1 text-sm w-full"
                placeholder="Child description (optional)"
                value={childDesc}
                onChange={(e) => setChildDesc(e.target.value)}
              />
              <div className="flex gap-2">
                <input
                  className="border rounded px-2 py-1 text-sm w-24"
                  placeholder="Qty / parent"
                  value={childQty}
                  onChange={(e) => setChildQty(e.target.value)}
                />
                <input
                  className="border rounded px-2 py-1 text-sm w-20"
                  placeholder="UOM"
                  value={childUom}
                  onChange={(e) => setChildUom(e.target.value)}
                />
              </div>
              <button type="button" className="btn-primary text-sm" onClick={addChild}>
                Add child
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Lazy-loads stock status for a given part number (used in child list). */
function ChildStockStatus({ partNumber }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    if (!partNumber) return;
    let cancelled = false;
    bomApi.searchStock(partNumber).then((rows) => {
      if (cancelled) return;
      const match = rows.find(
        (r) => r.part_number.toLowerCase() === partNumber.toLowerCase()
      );
      setInfo(match || { in_main_stock: false, in_rack: false, main_stock_qty: 0, rack_qty: 0 });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [partNumber]);

  if (!info) return null;
  return (
    <div className="mt-0.5">
      <StockBadge
        inMainStock={info.in_main_stock}
        inRack={info.in_rack}
        mainQty={info.main_stock_qty}
        rackQty={info.rack_qty}
      />
    </div>
  );
}
