import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { salesOrderDocumentsApi } from '../services/api';
import { defaultScannerAgentUrl, scannerAgentHealth, submitScannerAgentJob } from '../services/scannerAgent';

const DOC_TYPES = [
  { id: 'CUSTOMER_PO', label: 'Customer PO' },
  { id: 'INVOICE', label: 'Invoice' },
  { id: 'DELIVERY_NOTE', label: 'Delivery Note' },
  { id: 'POD', label: 'POD' },
  { id: 'SIGNED_POD', label: 'Signed POD' },
  { id: 'ACCOUNTING_DOCUMENT', label: 'Accounting' },
  { id: 'OTHER', label: 'Other' },
];

/**
 * Local scanner workflow + fallback file upload (no browser TWAIN).
 */
export default function ScanDocumentPanel({
  warehouseId,
  salesOrderNumber = '',
  outboundNumber = '',
  dnNumber = '',
  invoiceNumber = '',
  customerPo = '',
  gappPo = '',
  customerName = '',
  whOk = true,
  onSuccess,
  title = 'Scan document',
  className = '',
}) {
  const [agentUrl, setAgentUrl] = useState(() => defaultScannerAgentUrl);
  const [agentReachable, setAgentReachable] = useState(null);
  const [checking, setChecking] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);

  const [so, setSo] = useState(salesOrderNumber);
  const [ob, setOb] = useState(outboundNumber);
  const [dn, setDn] = useState(dnNumber || outboundNumber);
  const [inv, setInv] = useState(invoiceNumber);
  const [cpo, setCpo] = useState(customerPo);
  const [gapp, setGapp] = useState(gappPo);
  const [cust, setCust] = useState(customerName);
  const [acc, setAcc] = useState('');
  const [docType, setDocType] = useState('DELIVERY_NOTE');

  useEffect(() => {
    setSo(salesOrderNumber || '');
    setOb(outboundNumber || '');
    setDn(dnNumber || outboundNumber || '');
    setInv(invoiceNumber || '');
    setCpo(customerPo || '');
    setGapp(gappPo || '');
    setCust(customerName || '');
  }, [salesOrderNumber, outboundNumber, dnNumber, invoiceNumber, customerPo, gappPo, customerName]);

  const probe = useCallback(async () => {
    setChecking(true);
    try {
      const r = await scannerAgentHealth(agentUrl);
      setAgentReachable(r.ok);
      if (!r.ok) {
        toast.message('Scanner agent not reachable — use file upload below.', { duration: 4000 });
      }
    } finally {
      setChecking(false);
    }
  }, [agentUrl]);

  useEffect(() => {
    void probe();
  }, [probe]);

  const needsExtra = useMemo(() => {
    const t = docType;
    return {
      invoice: t === 'INVOICE',
      accounting: t === 'ACCOUNTING_DOCUMENT',
      customerPo: t === 'CUSTOMER_PO',
    };
  }, [docType]);

  const buildScanPayload = () => {
    const wid = Number(warehouseId);
    if (!whOk || !Number.isFinite(wid) || wid <= 0) throw new Error('Select a warehouse');
    const sales_order_number = String(so || '').trim();
    if (!sales_order_number) throw new Error('Sales Order is required');
    const outbound_number = String(ob || '').trim() || undefined;
    const dn_number = String(dn || '').trim() || outbound_number;
    const payload = {
      warehouse_id: wid,
      sales_order_number,
      document_type: docType,
      outbound_number,
      dn_number,
      invoice_number: String(inv || '').trim() || undefined,
      customer_po_number: String(cpo || '').trim() || undefined,
      gapp_po: String(gapp || '').trim() || undefined,
      customer_name: String(cust || '').trim() || undefined,
      pod_type: docType === 'POD' || docType === 'SIGNED_POD' ? 'scanner_agent_web' : undefined,
    };
    if (needsExtra.invoice) {
      const i = String(inv || '').trim();
      if (!i) throw new Error('Invoice number is required for Invoice uploads');
      payload.invoice_number = i;
    }
    if (needsExtra.accounting) {
      const a = String(acc || '').trim();
      if (!a) throw new Error('Accounting document number is required');
      payload.accounting_document_number = a;
    }
    if (needsExtra.customerPo) {
      payload.customer_po_number = String(cpo || '').trim() || sales_order_number;
    }
    return payload;
  };

  const runScan = async () => {
    try {
      const payload = buildScanPayload();
      setScanBusy(true);
      await submitScannerAgentJob(payload, agentUrl);
      toast.success('Scan uploaded to sales order documents');
      onSuccess?.();
    } catch (e) {
      toast.error(e.message || 'Scan job failed');
    } finally {
      setScanBusy(false);
    }
  };

  const runFallbackUpload = async (file) => {
    if (!file) return;
    try {
      const payload = buildScanPayload();
      const fd = new FormData();
      fd.append('file', file);
      fd.append('sales_order_number', payload.sales_order_number);
      fd.append('document_type', payload.document_type);
      fd.append('warehouse_id', String(payload.warehouse_id));
      if (payload.outbound_number) fd.append('outbound_number', payload.outbound_number);
      if (payload.dn_number) fd.append('dn_number', payload.dn_number);
      if (payload.invoice_number) fd.append('invoice_number', payload.invoice_number);
      if (payload.customer_po_number) fd.append('customer_po_number', payload.customer_po_number);
      if (payload.accounting_document_number) fd.append('accounting_document_number', payload.accounting_document_number);
      if (payload.gapp_po) fd.append('gapp_po', payload.gapp_po);
      if (payload.customer_name) fd.append('customer_name', payload.customer_name);
      if (payload.pod_type) fd.append('pod_type', payload.pod_type);
      await salesOrderDocumentsApi.upload(fd);
      toast.success('Uploaded');
      onSuccess?.();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || 'Upload failed');
    }
  };

  if (!whOk) return null;

  return (
    <div className={`rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 text-[11px] ${className}`}>
      <div className="font-bold text-indigo-950 mb-1">{title}</div>
      <p className="text-gray-600 text-[10px] mb-2">
        Physical scanners are driven by the{' '}
        <strong>Local Scanner Agent</strong> on this PC (<code className="text-[10px]">scanner-agent/</code> in the repo).
        The browser only sends a job to <code className="text-[10px]">127.0.0.1</code>; it does not access TWAIN/WIA.
      </p>

      <div className="grid sm:grid-cols-2 gap-2 mb-2">
        <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-700">
          Agent URL
          <input className="input-field font-normal" value={agentUrl} onChange={(e) => setAgentUrl(e.target.value)} />
        </label>
        <div className="flex items-end gap-2">
          <span className="text-[10px] text-gray-600">
            Status:{' '}
            {checking ? (
              'Checking…'
            ) : agentReachable ? (
              <span className="text-emerald-700 font-semibold">Agent online</span>
            ) : (
              <span className="text-amber-800 font-semibold">Offline — file upload below</span>
            )}
          </span>
          <button type="button" className="btn-secondary !py-0.5 !px-2 text-[10px]" onClick={() => void probe()} disabled={checking}>
            Recheck
          </button>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-2">
        <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-700">
          Sales Order / GAPP PO
          <input className="input-field font-normal" value={so} onChange={(e) => setSo(e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-700">
          Outbound number
          <input className="input-field font-normal" value={ob} onChange={(e) => setOb(e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-700">
          DN number (if different)
          <input className="input-field font-normal" value={dn} onChange={(e) => setDn(e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-700">
          Document type
          <select className="input-field font-normal" value={docType} onChange={(e) => setDocType(e.target.value)}>
            {DOC_TYPES.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-700">
          Invoice no. (if needed)
          <input className="input-field font-normal" value={inv} onChange={(e) => setInv(e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-700">
          Customer PO (if needed)
          <input className="input-field font-normal" value={cpo} onChange={(e) => setCpo(e.target.value)} />
        </label>
        <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-700 sm:col-span-2">
          GAPP PO / customer (optional)
          <input
            className="input-field font-normal"
            value={gapp}
            onChange={(e) => setGapp(e.target.value)}
            placeholder="GAPP PO"
          />
        </label>
        {needsExtra.accounting ? (
          <label className="flex flex-col gap-0.5 text-[10px] font-bold text-gray-700 sm:col-span-2">
            Accounting doc no.
            <input className="input-field font-normal" value={acc} onChange={(e) => setAcc(e.target.value)} />
          </label>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-2">
        <button
          type="button"
          className="btn-primary"
          disabled={scanBusy || checking || !agentReachable}
          onClick={() => void runScan()}
          title={!agentReachable ? 'Start Local Scanner Agent on this PC' : ''}
        >
          {scanBusy ? 'Scanning & uploading…' : 'Scan document (local agent)'}
        </button>
        <label className="btn-secondary cursor-pointer !py-1 !px-2">
          Upload file instead
          <input
            type="file"
            className="hidden"
            accept=".pdf,image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void runFallbackUpload(f);
            }}
          />
        </label>
      </div>
    </div>
  );
}
