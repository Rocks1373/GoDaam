import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { salesOrderDocumentsApi } from '../services/api';
import { useWarehouse } from '../context/WarehouseContext';
import ScanDocumentPanel from '../components/ScanDocumentPanel';

const TABS = [
  { id: 'CUSTOMER_PO', label: 'Customer PO' },
  { id: 'INVOICE', label: 'Invoices' },
  { id: 'DELIVERY_NOTE', label: 'Delivery Notes' },
  { id: 'POD', label: 'POD' },
  { id: 'ACCOUNTING_DOCUMENT', label: 'Accounting' },
  { id: 'ALL', label: 'All Documents' },
  { id: 'CHECKLIST', label: 'Checklist' },
];

function tabMatches(doc, tabId) {
  if (tabId === 'ALL') return true;
  if (tabId === 'CHECKLIST') return false;
  return String(doc.document_type || '') === tabId;
}

function isPodDoc(d) {
  const t = String(d?.document_type || '');
  return t === 'POD' || t === 'SIGNED_POD';
}

function refsFromUploadContext(ctx) {
  const c = ctx || {};
  const ob = c.outbound_number || '';
  const dn = c.dn_number || ob || '';
  return {
    customer_po_number: c.customer_po_number || '',
    invoice_number: c.invoice_number || '',
    outbound_number: ob,
    dn_number: dn,
    gapp_po: c.gapp_po || '',
    customer_name: c.customer_name || '',
    accounting_document_number: '',
  };
}

export default function SalesOrderDocuments() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedWarehouseId, isAllWarehouses, isAdmin } = useWarehouse();
  const [soInput, setSoInput] = useState(() => searchParams.get('so') || '');
  const [activeSo, setActiveSo] = useState(() => searchParams.get('so') || '');
  const [tab, setTab] = useState('CUSTOMER_PO');
  const [folder, setFolder] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [checklist, setChecklist] = useState([]);
  const [loading, setLoading] = useState(false);
  const [dup, setDup] = useState(null);
  const [pendingForm, setPendingForm] = useState(null);
  const [uploadRefs, setUploadRefs] = useState(() => refsFromUploadContext(null));

  const [exportBusy, setExportBusy] = useState(null);
  const [parallelBundle, setParallelBundle] = useState(null);
  const [driveSetup, setDriveSetup] = useState(null);

  const whOk = isAdmin || (!isAllWarehouses && selectedWarehouseId);

  useEffect(() => {
    const s = String(searchParams.get('so') || '').trim();
    if (s) {
      setSoInput(s);
      setActiveSo(s);
    }
  }, [searchParams]);

  const load = useCallback(async () => {
    const so = String(activeSo || '').trim();
    if (!so || !whOk) return;
    setLoading(true);
    try {
      await salesOrderDocumentsApi.ensureFolder({
        sales_order_number: so,
        warehouse_id: selectedWarehouseId,
      });
      const data = await salesOrderDocumentsApi.listDocuments(so);
      setDocuments(data.documents || []);
      const st = await salesOrderDocumentsApi.status(so);
      setChecklist(st.checklist || []);
      setFolder(st.folder || data.folder || null);
      setUploadRefs(refsFromUploadContext(st.upload_context));
      setParallelBundle(st.parallel_bundle || null);
      try {
        const ds = await salesOrderDocumentsApi.driveSetup({
          warehouse_id: selectedWarehouseId || undefined,
        });
        setDriveSetup(ds);
      } catch {
        setDriveSetup(null);
      }
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || 'Load failed');
      setDriveSetup(null);
    } finally {
      setLoading(false);
    }
  }, [activeSo, selectedWarehouseId, whOk]);

  useEffect(() => {
    void load();
  }, [load]);

  const filteredDocs = useMemo(() => {
    const list = documents || [];
    if (tab === 'CHECKLIST') return [];
    if (tab === 'ALL') return list;
    return list.filter((d) => tabMatches(d, tab));
  }, [documents, tab]);

  const podDocs = useMemo(() => (documents || []).filter(isPodDoc), [documents]);

  const openSo = () => {
    const s = String(soInput || '').trim();
    if (!s) {
      toast.error('Enter Sales Order Number / GAPP PO');
      return;
    }
    setActiveSo(s);
    setSearchParams({ so: s });
  };

  const runUpload = async (form, duplicate_action) => {
    if (!whOk) {
      toast.error('Select a warehouse (not “all”) to upload.');
      return;
    }
    const fd = new FormData();
    const { file, ...rest } = form;
    if (!file) {
      toast.error('Missing file');
      return;
    }
    fd.append('file', file);
    Object.entries(rest).forEach(([k, v]) => {
      if (v != null && v !== '') fd.append(k, v);
    });
    if (selectedWarehouseId) fd.append('warehouse_id', String(selectedWarehouseId));
    if (duplicate_action) fd.append('duplicate_action', duplicate_action);
    try {
      const res = await salesOrderDocumentsApi.upload(fd);
      if (res.conflict) {
        setDup(res.existing);
        setPendingForm({ ...form });
        return;
      }
      toast.success('Uploaded');
      setDup(null);
      setPendingForm(null);
      if (res.parallel_bundle && !res.parallel_bundle.parallel_complete) {
        const msg = res.parallel_bundle.reminders?.[0] || res.parallel_bundle.summary;
        if (msg) toast.warning(msg);
      } else if (res.parallel_bundle?.customer_po_reminder) {
        toast.message(res.parallel_bundle.customer_po_reminder);
      }
      await load();
    } catch (e) {
      if (e.response?.status === 409 && e.response?.data?.conflict) {
        setDup(e.response.data.existing);
        setPendingForm({ ...form });
        return;
      }
      toast.error(e.response?.data?.error || e.message || 'Upload failed');
    }
  };

  const resumeDup = (action) => {
    if (!pendingForm) return;
    const f = { ...pendingForm };
    setDup(null);
    void runUpload(f, action);
  };

  const onVerify = async (id, status) => {
    try {
      await salesOrderDocumentsApi.verify(id, { status });
      toast.success('Updated');
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message);
    }
  };

  const copyLink = async (url) => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  const uploadMeta = () => {
    const ob = String(uploadRefs.outbound_number || '').trim();
    const dn = String(uploadRefs.dn_number || '').trim() || ob || undefined;
    return {
      outbound_number: ob || undefined,
      dn_number: dn,
      invoice_number: String(uploadRefs.invoice_number || '').trim() || undefined,
      customer_po_number: String(uploadRefs.customer_po_number || '').trim() || undefined,
      gapp_po: String(uploadRefs.gapp_po || '').trim() || undefined,
      customer_name: String(uploadRefs.customer_name || '').trim() || undefined,
    };
  };

  const runExportCombinedPdf = async () => {
    const so = String(activeSo || '').trim();
    if (!so || !whOk) return;
    setExportBusy('pdf');
    try {
      await salesOrderDocumentsApi.downloadCombinedPdf(so, selectedWarehouseId, {
        customerPoNumber: folder?.customer_po_number,
      });
      toast.success('Combined PDF downloaded');
    } catch (e) {
      toast.error(e.message || 'Download failed');
    } finally {
      setExportBusy(null);
    }
  };

  const runExportZip = async () => {
    const so = String(activeSo || '').trim();
    if (!so || !whOk) return;
    setExportBusy('zip');
    try {
      await salesOrderDocumentsApi.downloadIndividualZip(so, selectedWarehouseId, {
        customerPoNumber: folder?.customer_po_number,
      });
      toast.success('ZIP downloaded');
    } catch (e) {
      toast.error(e.message || 'Download failed');
    } finally {
      setExportBusy(null);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-2 py-3">
      <div className="mb-3">
        <h2 className="text-base font-bold text-gray-900">Sales Order Documents</h2>
        <p className="text-[11px] text-gray-600 mt-1">
          Enter the Sales Order / GAPP PO (same as Outbound <strong>Sales Doc.</strong>), press <strong>Load</strong>. References
          (customer PO, invoice, outbound / DN) are filled from the outbound and delivery note when available — edit them if needed.
          Then use <strong>Choose file</strong> for each document type. Accounting: enter the document number and attach the file.
          Driver PODs usually come from the mobile app; web POD upload is optional.
        </p>
      </div>

      {!whOk ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-xs p-3">
          Select a single warehouse in the toolbar (admins: avoid “All warehouses”) to load and upload documents.
        </div>
      ) : null}

      {whOk && isAdmin && isAllWarehouses ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-[11px] p-3 mb-3">
          Admin: toolbar is on <strong>All warehouses</strong> — Drive uploads use default warehouse <strong>WH1</strong>.
          Select <strong>WH1</strong> in the toolbar so folder links match what you upload.
        </div>
      ) : null}

      {whOk && driveSetup && !driveSetup.root_accessible ? (
        <div className="rounded-lg border border-red-300 bg-red-50 text-red-950 text-[11px] p-3 mb-3 space-y-2">
          <div className="font-bold">Google Drive root not reachable by the app</div>
          <p>{driveSetup.root_error || 'Share the root folder with the service account.'}</p>
          {driveSetup.service_account_email ? (
            <p>
              Share folder <code className="text-[10px]">{driveSetup.root_folder_id}</code> with:{' '}
              <strong>{driveSetup.service_account_email}</strong> (Editor), then restart <code className="text-[10px]">./dev.sh</code>.
            </p>
          ) : null}
          {driveSetup.warehouse_drive_url ? (
            <p className="text-gray-800">
              Existing SO folders may already be here (old setup):{' '}
              <a className="underline font-semibold" href={driveSetup.warehouse_drive_url} target="_blank" rel="noreferrer">
                Open {driveSetup.warehouse_code || 'warehouse'} folder in Drive
              </a>
            </p>
          ) : null}
          {driveSetup.where_folders_go ? <p className="text-gray-800">{driveSetup.where_folders_go}</p> : null}
        </div>
      ) : null}

      {whOk && driveSetup?.root_accessible && driveSetup.where_folders_go ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/90 text-emerald-950 text-[11px] p-3 mb-3">
          {driveSetup.where_folders_go}
          {driveSetup.warehouse_drive_url ? (
            <>
              {' '}
              <a className="underline font-semibold" href={driveSetup.warehouse_drive_url} target="_blank" rel="noreferrer">
                Open {driveSetup.warehouse_code} in Drive
              </a>
            </>
          ) : null}
        </div>
      ) : null}

      {whOk && activeSo && parallelBundle && !parallelBundle.parallel_complete ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50/95 text-amber-950 text-[11px] p-3 mb-3 space-y-1.5">
          <div className="font-bold">Parallel documents incomplete (invoice · delivery note · accounting)</div>
          <p className="text-gray-800">{parallelBundle.summary}</p>
          <ul className="list-disc pl-4 space-y-0.5 text-gray-800">
            {(parallelBundle.reminders || []).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          <p className="text-[10px] text-gray-600">
            Uploaded counts — invoices:{' '}
            <strong>{parallelBundle.counts?.invoice ?? 0}</strong>, delivery notes:{' '}
            <strong>{parallelBundle.counts?.delivery_note ?? 0}</strong>, accounting:{' '}
            <strong>{parallelBundle.counts?.accounting_document ?? 0}</strong>
            {parallelBundle.counts?.customer_po != null ? (
              <>
                , customer PO files: <strong>{parallelBundle.counts.customer_po}</strong>
              </>
            ) : null}
            . Combined PDF order: accounting → invoice → delivery note → customer PO → POD (non-PDF pages are skipped).
          </p>
        </div>
      ) : null}

      {whOk && activeSo && parallelBundle?.parallel_complete && parallelBundle?.customer_po_reminder ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50/90 text-blue-950 text-[11px] p-3 mb-3">
          {parallelBundle.customer_po_reminder}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 items-end mb-3">
        <label className="flex flex-col text-[10px] font-bold text-gray-600">
          Sales Order / GAPP PO
          <input className="input-field mt-0.5 w-48" value={soInput} onChange={(e) => setSoInput(e.target.value)} />
        </label>
        <button type="button" className="btn-primary" onClick={openSo} disabled={loading}>
          Load
        </button>
        {folder?.sales_order_folder_id ? (
          <a
            className="btn-secondary text-[11px]"
            href={`https://drive.google.com/drive/folders/${folder.sales_order_folder_id}`}
            target="_blank"
            rel="noreferrer"
          >
            Open SO folder in Drive
          </a>
        ) : null}
        <Link to="/reports/sales-order-documents" className="btn-secondary text-[11px]">
          Document report
        </Link>
        {activeSo && whOk && documents.length > 0 ? (
          <>
            <button
              type="button"
              className="btn-secondary text-[11px]"
              disabled={loading || exportBusy}
              onClick={() => void runExportCombinedPdf()}
            >
              {exportBusy === 'pdf' ? 'Preparing…' : 'Download combined PDF'}
            </button>
            <button
              type="button"
              className="btn-secondary text-[11px]"
              disabled={loading || exportBusy}
              onClick={() => void runExportZip()}
            >
              {exportBusy === 'zip' ? 'Preparing…' : 'Download individual (ZIP)'}
            </button>
          </>
        ) : null}
      </div>

      {activeSo ? (
        <div className="rounded-lg border border-gray-200 bg-white p-3 mb-3 text-[11px] text-gray-800 grid sm:grid-cols-2 gap-2">
          <div>
            <span className="font-semibold">Sales Order:</span> {activeSo}
          </div>
          <div>
            <span className="font-semibold">Folder status:</span> {folder?.folder_status || '—'}
          </div>
          <div>
            <span className="font-semibold">Warehouse folder path:</span> {folder?.sales_order_folder_path || '—'}
          </div>
          <div>
            <span className="font-semibold">Customer:</span> {folder?.customer_name || '—'}
          </div>
          {documents.length > 0 && folder?.folder_status !== 'Completed' ? (
            <div className="sm:col-span-2 text-amber-800">
              Folder is not “Completed” yet — combined ZIP/PDF may still be missing documents.
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <div className="flex-1 min-w-0 w-full space-y-3">
          <div className="flex flex-wrap gap-1 mb-2 border-b border-gray-200 pb-2">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`rounded-md px-2 py-1 text-[11px] font-bold ${
                  tab === t.id ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700'
                }`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

      {tab !== 'CHECKLIST' && activeSo ? (
        <div className="mb-3 rounded-lg border border-gray-100 bg-gray-50/80 p-3 text-[11px] space-y-3">
          <ScanDocumentPanel
            warehouseId={selectedWarehouseId}
            salesOrderNumber={activeSo}
            outboundNumber={uploadRefs.outbound_number}
            dnNumber={uploadRefs.dn_number}
            invoiceNumber={uploadRefs.invoice_number}
            customerPo={uploadRefs.customer_po_number}
            gappPo={uploadRefs.gapp_po}
            customerName={uploadRefs.customer_name}
            whOk={whOk}
            onSuccess={() => void load()}
            title="Scan document (local agent)"
            className="!bg-white !border-indigo-100"
          />
          <div>
            <div className="font-bold text-gray-800 mb-1">Order references</div>
            <p className="text-gray-600 text-[10px] mb-2">
              Prefilled from warehouse outbound / delivery note. Customer PO and invoice numbers are used for file names and
              Drive indexing.
            </p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-600">
                Customer PO
                <input
                  className="input-field font-normal"
                  value={uploadRefs.customer_po_number}
                  onChange={(e) => setUploadRefs((r) => ({ ...r, customer_po_number: e.target.value }))}
                  placeholder="From DN / outbound"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-600">
                Invoice no.
                <input
                  className="input-field font-normal"
                  value={uploadRefs.invoice_number}
                  onChange={(e) => setUploadRefs((r) => ({ ...r, invoice_number: e.target.value }))}
                  placeholder="From outbound"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-600">
                Outbound / delivery ref.
                <input
                  className="input-field font-normal"
                  value={uploadRefs.outbound_number}
                  onChange={(e) =>
                    setUploadRefs((r) => ({
                      ...r,
                      outbound_number: e.target.value,
                      dn_number: r.dn_number === r.outbound_number ? e.target.value : r.dn_number,
                    }))
                  }
                  placeholder="Outbound number"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-600">
                DN number (if different)
                <input
                  className="input-field font-normal"
                  value={uploadRefs.dn_number}
                  onChange={(e) => setUploadRefs((r) => ({ ...r, dn_number: e.target.value }))}
                  placeholder="Usually same as outbound"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-600 sm:col-span-2">
                GAPP PO / Sales doc (optional)
                <input
                  className="input-field font-normal"
                  value={uploadRefs.gapp_po}
                  onChange={(e) => setUploadRefs((r) => ({ ...r, gapp_po: e.target.value }))}
                  placeholder="Echo of loaded SO if needed for folder metadata"
                />
              </label>
            </div>
          </div>

          <div>
            <div className="font-bold text-gray-800 mb-2">Quick upload</div>
            <div className="space-y-2">
              <UploadRow
                label="Customer PO"
                onPick={(file) =>
                  runUpload({
                    file,
                    sales_order_number: activeSo,
                    document_type: 'CUSTOMER_PO',
                    ...uploadMeta(),
                  })
                }
              />
              <UploadRow
                label="Invoice"
                onPick={(file) => {
                  if (!String(uploadRefs.invoice_number || '').trim()) {
                    toast.error('Enter the invoice number under Order references (or type it if not loaded from the system).');
                    return;
                  }
                  runUpload({
                    file,
                    sales_order_number: activeSo,
                    document_type: 'INVOICE',
                    ...uploadMeta(),
                  });
                }}
              />
              <UploadRow
                label="Delivery Note PDF"
                onPick={(file) =>
                  runUpload({
                    file,
                    sales_order_number: activeSo,
                    document_type: 'DELIVERY_NOTE',
                    ...uploadMeta(),
                  })
                }
              />
              <UploadRow
                label="POD"
                onPick={(file) =>
                  runUpload({
                    file,
                    sales_order_number: activeSo,
                    document_type: 'POD',
                    pod_type: 'web_upload',
                    ...uploadMeta(),
                  })
                }
              />
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-600 min-w-[10rem]">
                  Accounting doc no.
                  <input
                    className="input-field font-normal"
                    value={uploadRefs.accounting_document_number}
                    onChange={(e) => setUploadRefs((r) => ({ ...r, accounting_document_number: e.target.value }))}
                    placeholder="Voucher / ref. from screenshot"
                  />
                </label>
                <UploadRow
                  label="Accounting file"
                  onPick={(file) => {
                    if (!String(uploadRefs.accounting_document_number || '').trim()) {
                      toast.error('Enter the accounting document number first, then choose the file.');
                      return;
                    }
                    runUpload({
                      file,
                      sales_order_number: activeSo,
                      document_type: 'ACCOUNTING_DOCUMENT',
                      accounting_document_number: uploadRefs.accounting_document_number.trim(),
                      ...uploadMeta(),
                    });
                  }}
                />
              </div>
              <UploadRow
                label="Other"
                onPick={(file) =>
                  runUpload({
                    file,
                    sales_order_number: activeSo,
                    document_type: 'OTHER',
                    ...uploadMeta(),
                  })
                }
              />
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'CHECKLIST' ? (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="min-w-full text-[11px]">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-2 py-1">When</th>
                <th className="text-left px-2 py-1">Key</th>
                <th className="text-left px-2 py-1">Outbound</th>
                <th className="text-left px-2 py-1">Remarks</th>
              </tr>
            </thead>
            <tbody>
              {(checklist || []).map((c) => (
                <tr key={c.id} className="border-t border-gray-100">
                  <td className="px-2 py-1 whitespace-nowrap">{c.completed_at || '—'}</td>
                  <td className="px-2 py-1">{c.checklist_key}</td>
                  <td className="px-2 py-1">{c.outbound_number || '—'}</td>
                  <td className="px-2 py-1">{c.remarks || '—'}</td>
                </tr>
              ))}
              {!checklist?.length ? (
                <tr>
                  <td colSpan={4} className="px-2 py-2 text-gray-500">
                    No checklist rows yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="min-w-full text-[11px]">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-2 py-1">Type</th>
                <th className="text-left px-2 py-1">File</th>
                <th className="text-left px-2 py-1">Verification</th>
                <th className="text-left px-2 py-1">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredDocs.map((d) => (
                <tr key={d.id} className="border-t border-gray-100">
                  <td className="px-2 py-1 whitespace-nowrap">{d.document_type}</td>
                  <td className="px-2 py-1">{d.stored_file_name}</td>
                  <td className="px-2 py-1">{d.verification_status}</td>
                  <td className="px-2 py-1 whitespace-nowrap space-x-1">
                    {d.cloud_web_url ? (
                      <a className="text-primary-700 underline" href={d.cloud_web_url} target="_blank" rel="noreferrer">
                        Drive
                      </a>
                    ) : null}
                    <button type="button" className="text-primary-700 underline" onClick={() => copyLink(d.cloud_web_url)}>
                      Copy
                    </button>
                    {(d.document_type === 'POD' || d.document_type === 'SIGNED_POD') && (
                      <>
                        <button type="button" className="text-emerald-700 underline" onClick={() => onVerify(d.id, 'APPROVED')}>
                          Approve
                        </button>
                        <button type="button" className="text-red-700 underline" onClick={() => onVerify(d.id, 'REJECTED')}>
                          Reject
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!filteredDocs.length ? (
                <tr>
                  <td colSpan={4} className="px-2 py-2 text-gray-500">
                    No documents in this tab.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

        </div>

        {activeSo ? (
          <aside className="w-full lg:w-80 shrink-0 rounded-lg border border-gray-200 bg-white p-3 text-[11px] text-gray-800 lg:sticky lg:top-4 self-start">
            <div className="font-bold text-gray-900 border-b border-gray-100 pb-2 mb-2">Proof of delivery (POD)</div>
            <p className="text-gray-600 mb-3">
              Driver uploads and web POD files land here (stored as PDF in Drive). Use Approve / Reject for review.
            </p>
            {podDocs.length ? (
              <ul className="space-y-3">
                {podDocs.map((d) => (
                  <li key={d.id} className="rounded-md border border-gray-100 bg-gray-50/80 p-2">
                    <div className="font-semibold text-gray-900 break-all">{d.stored_file_name}</div>
                    <div className="text-gray-600 mt-0.5">{d.document_type}</div>
                    <div className="text-gray-500 mt-0.5">Verification: {d.verification_status || '—'}</div>
                    {d.uploaded_at ? <div className="text-gray-500 mt-0.5">Uploaded: {String(d.uploaded_at).slice(0, 19)}</div> : null}
                    <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1">
                      {d.cloud_web_url ? (
                        <a className="text-primary-700 underline" href={d.cloud_web_url} target="_blank" rel="noreferrer">
                          Drive
                        </a>
                      ) : null}
                      <button type="button" className="text-primary-700 underline" onClick={() => copyLink(d.cloud_web_url)}>
                        Copy link
                      </button>
                      <button type="button" className="text-emerald-700 underline" onClick={() => onVerify(d.id, 'APPROVED')}>
                        Approve
                      </button>
                      <button type="button" className="text-red-700 underline" onClick={() => onVerify(d.id, 'REJECTED')}>
                        Reject
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-gray-500">No POD uploaded for this sales order yet.</p>
            )}
          </aside>
        ) : null}
      </div>

      {dup ? (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-lg max-w-md w-full p-4 text-sm">
            <div className="font-bold mb-2">Duplicate document</div>
            <p className="text-gray-700 text-[12px] mb-3">
              A file already exists: <code>{dup.stored_file_name}</code>
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" onClick={() => resumeDup('replace')}>
                Replace existing
              </button>
              <button type="button" className="btn-secondary" onClick={() => resumeDup('version')}>
                Keep both (version)
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setDup(null);
                  setPendingForm(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UploadRow({ label, onPick }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-36 text-gray-600">{label}</span>
      <label className="btn-secondary cursor-pointer !py-0.5 !px-2">
        Choose file
        <input
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onPick(f);
          }}
        />
      </label>
    </div>
  );
}
