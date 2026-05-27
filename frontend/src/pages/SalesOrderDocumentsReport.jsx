import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { salesOrderDocumentsApi } from '../services/api';
import { useWarehouse } from '../context/WarehouseContext';

function aggregateParallelBundleBySo(rows) {
  const bySo = new Map();
  for (const r of rows || []) {
    const so = String(r.sales_order_number || '').trim();
    if (!so) continue;
    if (!bySo.has(so)) {
      bySo.set(so, {
        sales_order_number: so,
        customer_po_number: null,
        invoice: 0,
        delivery_note: 0,
        accounting_document: 0,
        customer_po: 0,
        pod: 0,
      });
    }
    const o = bySo.get(so);
    const cpo = r.customer_po_number;
    if (cpo && !o.customer_po_number) o.customer_po_number = String(cpo).trim();
    if (String(r.upload_status || '').toUpperCase() !== 'UPLOADED') continue;
    const t = String(r.document_type || '').toUpperCase();
    if (t === 'INVOICE') o.invoice += 1;
    else if (t === 'DELIVERY_NOTE') o.delivery_note += 1;
    else if (t === 'ACCOUNTING_DOCUMENT') o.accounting_document += 1;
    else if (t === 'CUSTOMER_PO') o.customer_po += 1;
    else if (t === 'POD' || t === 'SIGNED_POD') o.pod += 1;
  }
  const out = [];
  for (const o of bySo.values()) {
    const m = Math.max(o.invoice, o.delivery_note, o.accounting_document);
    const balanced = m === 0 || (o.invoice === m && o.delivery_note === m && o.accounting_document === m);
    const missingPo = m > 0 && o.customer_po === 0;
    out.push({
      ...o,
      trio_max: m,
      parallel_complete: balanced,
      missing_customer_po: missingPo,
    });
  }
  out.sort((a, b) => a.sales_order_number.localeCompare(b.sales_order_number));
  return out;
}

export default function SalesOrderDocumentsReport() {
  const { selectedWarehouseId, isAllWarehouses, isAdmin } = useWarehouse();
  const [filters, setFilters] = useState({
    sales_order_number: '',
    outbound_number: '',
    invoice_number: '',
    dn_number: '',
    customer_po_number: '',
    document_type: '',
    upload_status: '',
    verification_status: '',
    missing_only: false,
    date_from: '',
    date_to: '',
  });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const whOk = isAdmin || (!isAllWarehouses && selectedWarehouseId);

  const params = useMemo(() => {
    const p = {};
    Object.entries(filters).forEach(([k, v]) => {
      if (k === 'missing_only') {
        if (v) p.missing_only = '1';
        return;
      }
      if (v !== '' && v != null) p[k] = v;
    });
    return p;
  }, [filters]);

  const soSummary = useMemo(() => aggregateParallelBundleBySo(rows), [rows]);

  const podRows = useMemo(
    () =>
      rows.filter((r) => {
        const t = String(r.document_type || '').toUpperCase();
        return t === 'POD' || t === 'SIGNED_POD';
      }),
    [rows]
  );

  const load = async () => {
    if (!whOk) {
      setErr('Select a single warehouse in the toolbar.');
      return;
    }
    setLoading(true);
    setErr('');
    try {
      const data = await salesOrderDocumentsApi.report(params);
      setRows(data.rows || []);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed');
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const setF = (k, v) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <div className="max-w-7xl mx-auto px-2 py-3">
      <h2 className="text-base font-bold text-gray-900 mb-2">Sales Order Document Report</h2>
      {!whOk ? <div className="text-xs text-amber-800 mb-2">{err || 'Select one warehouse to run this report.'}</div> : null}
      <div className="grid sm:grid-cols-3 lg:grid-cols-4 gap-2 text-[11px] mb-3">
        <label className="flex flex-col gap-0.5">
          Sales Order
          <input className="input-field" value={filters.sales_order_number} onChange={(e) => setF('sales_order_number', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          Outbound
          <input className="input-field" value={filters.outbound_number} onChange={(e) => setF('outbound_number', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          Invoice
          <input className="input-field" value={filters.invoice_number} onChange={(e) => setF('invoice_number', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          DN
          <input className="input-field" value={filters.dn_number} onChange={(e) => setF('dn_number', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          Customer PO
          <input className="input-field" value={filters.customer_po_number} onChange={(e) => setF('customer_po_number', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          Doc type
          <input className="input-field" value={filters.document_type} onChange={(e) => setF('document_type', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          Upload status
          <input className="input-field" value={filters.upload_status} onChange={(e) => setF('upload_status', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          Verification
          <input className="input-field" value={filters.verification_status} onChange={(e) => setF('verification_status', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          Date from
          <input className="input-field" type="date" value={filters.date_from} onChange={(e) => setF('date_from', e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5">
          Date to
          <input className="input-field" type="date" value={filters.date_to} onChange={(e) => setF('date_to', e.target.value)} />
        </label>
        <label className="flex items-center gap-2 mt-5">
          <input type="checkbox" checked={filters.missing_only} onChange={(e) => setF('missing_only', e.target.checked)} />
          Missing only
        </label>
      </div>
      <div className="flex gap-2 mb-3">
        <button type="button" className="btn-primary" onClick={load} disabled={loading || !whOk}>
          {loading ? 'Loading…' : 'Run report'}
        </button>
        <Link className="btn-secondary" to="/sales-order-documents">
          Open Document Center
        </Link>
      </div>
      {soSummary.length > 0 ? (
        <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50/80 p-3 text-[11px] text-gray-800">
          <div className="font-bold text-gray-900 mb-2">
            By sales order — uploaded file counts (invoice / delivery note / accounting must match)
          </div>
          <div className="overflow-x-auto max-h-48 overflow-y-auto">
            <table className="min-w-full">
              <thead className="text-gray-600 border-b border-gray-200">
                <tr>
                  <th className="text-left py-1 pr-2">SO</th>
                  <th className="text-left py-1 pr-2">Cust PO #</th>
                  <th className="text-right py-1 pr-2">Inv</th>
                  <th className="text-right py-1 pr-2">DN</th>
                  <th className="text-right py-1 pr-2">Acct</th>
                  <th className="text-right py-1 pr-2">PO files</th>
                  <th className="text-right py-1 pr-2">POD</th>
                  <th className="text-left py-1">Trio</th>
                </tr>
              </thead>
              <tbody>
                {soSummary.map((s) => (
                  <tr key={s.sales_order_number} className="border-t border-gray-100">
                    <td className="py-1 pr-2 font-medium">{s.sales_order_number}</td>
                    <td className="py-1 pr-2">{s.customer_po_number || '—'}</td>
                    <td className="py-1 pr-2 text-right">{s.invoice}</td>
                    <td className="py-1 pr-2 text-right">{s.delivery_note}</td>
                    <td className="py-1 pr-2 text-right">{s.accounting_document}</td>
                    <td className="py-1 pr-2 text-right">{s.customer_po}</td>
                    <td className="py-1 pr-2 text-right">{s.pod}</td>
                    <td className="py-1">
                      {s.trio_max === 0 ? (
                        <span className="text-gray-500">—</span>
                      ) : s.parallel_complete ? (
                        <span className="text-emerald-800">Balanced</span>
                      ) : (
                        <span className="text-amber-800">Incomplete</span>
                      )}
                      {s.missing_customer_po ? (
                        <span className="text-blue-800"> · no cust PO file</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {podRows.length > 0 ? (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50/80 p-3 text-[11px] text-gray-800">
          <div className="font-bold text-emerald-900 mb-2">POD in this result ({podRows.length})</div>
          <ul className="space-y-1 max-h-40 overflow-y-auto">
            {podRows.map((r) => (
              <li key={r.id} className="flex flex-wrap gap-x-2 gap-y-0.5 border-b border-emerald-100/80 pb-1 last:border-0">
                <span className="font-semibold">{r.sales_order_number}</span>
                <span className="text-gray-600">{r.document_type}</span>
                <span className="text-gray-600 break-all">{r.stored_file_name}</span>
                {r.cloud_web_url ? (
                  <a className="text-primary-700 underline" href={r.cloud_web_url} target="_blank" rel="noreferrer">
                    Drive
                  </a>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {err && whOk ? <div className="text-xs text-red-700 mb-2">{err}</div> : null}
      <div className="overflow-x-auto border border-gray-200 rounded-lg">
        <table className="min-w-full text-[11px]">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left px-2 py-1">SO</th>
              <th className="text-left px-2 py-1">Outbound</th>
              <th className="text-left px-2 py-1">Invoice</th>
              <th className="text-left px-2 py-1">DN</th>
              <th className="text-left px-2 py-1">Cust PO</th>
              <th className="text-left px-2 py-1">Type</th>
              <th className="text-left px-2 py-1">Stored name</th>
              <th className="text-left px-2 py-1">Drive</th>
              <th className="text-left px-2 py-1">Verification</th>
              <th className="text-left px-2 py-1">Uploaded by</th>
              <th className="text-left px-2 py-1">Uploaded at</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-gray-100">
                <td className="px-2 py-1">{r.sales_order_number}</td>
                <td className="px-2 py-1">{r.outbound_number || '—'}</td>
                <td className="px-2 py-1">{r.invoice_number || '—'}</td>
                <td className="px-2 py-1">{r.dn_number || '—'}</td>
                <td className="px-2 py-1">{r.customer_po_number || '—'}</td>
                <td className="px-2 py-1">{r.document_type}</td>
                <td className="px-2 py-1">{r.stored_file_name}</td>
                <td className="px-2 py-1">
                  {r.cloud_web_url ? (
                    <a className="text-primary-700 underline" href={r.cloud_web_url} target="_blank" rel="noreferrer">
                      link
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-2 py-1">{r.verification_status}</td>
                <td className="px-2 py-1">{r.uploaded_by_username || '—'}</td>
                <td className="px-2 py-1 whitespace-nowrap">{r.uploaded_at || '—'}</td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={11} className="px-2 py-3 text-gray-500">
                  No rows. Run the report.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
