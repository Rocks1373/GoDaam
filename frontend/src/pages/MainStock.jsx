import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Upload, Copy, Eye, Package, Truck, GitCompare, Plus, FileDown } from 'lucide-react';
import { toast } from 'sonner';
import { mainStockApi, inboundApi, soldOutApi, stockComparisonApi, vendorsApi } from '../services/api';

async function fetchMainStockPartPrefixSuggestions(q) {
  const rows = await mainStockApi.search(q, { partPrefix: true });
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const part_number = String(r.part_number || '').trim();
    if (!part_number) continue;
    const key = part_number.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id,
      part_number,
      sap_part_number: r.sap_part_number || '',
      description: r.description || '',
      uom: r.uom || '',
      vendor_id: r.vendor_id ?? null,
      vendor_number: r.vendor_number || '',
      vendor_name: r.vendor_name || '',
    });
  }
  return out.slice(0, 30);
}
import { formatDateDDMMYYYY } from '../utils/dateDisplay';
import { reportUploadResult, reportUploadError } from '../utils/uploadErrorReport';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';
import InboundFilterAutocomplete from '../components/InboundFilterAutocomplete';
import InboundUploadValidation from '../components/InboundUploadValidation';
import { exportJsonToExcel } from '../utils/exportExcel';

function downloadCsvFile(filename, headers, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const line = (cells) => cells.map(esc).join(',');
  const body = [line(headers), ...rows.map((row) => line(headers.map((h) => row[h] ?? '')))].join('\n');
  const blob = new Blob(['\ufeff', body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const TABS = [
  { id: 'stock', label: 'Main Stock', Icon: Package },
  { id: 'inbound', label: 'Inbound / Receiving', Icon: Truck },
  { id: 'soldout', label: 'Sold Out / Outbound', Icon: Truck },
  { id: 'report', label: 'Stock Comparison Report', Icon: GitCompare },
];

function splitPasteLine(line) {
  return line.includes('\t') ? line.split('\t') : line.split(',').map((c) => c.trim());
}

/** Paste / bulk: header row (Excel export) or positional rows. Server recomputes Available Qty. */
function parseMainStockPaste(text) {
  const lines = text.trim().split('\n').filter((line) => line.trim());
  if (!lines.length) return [];

  const head = splitPasteLine(lines[0]).map((c) => String(c).trim());
  const headerMode =
    head.some((h) => /part\s*number/i.test(h)) &&
    (head.some((h) => /vendor/i.test(h)) || head.some((h) => /received/i.test(h)));

  if (headerMode && lines.length > 1) {
    const headers = head.map((h) => h.trim());
    const lower = headers.map((h) => h.toLowerCase());
    const pick = (cols, ...names) => {
      for (const n of names) {
        const want = n.toLowerCase();
        const i = lower.indexOf(want);
        if (i >= 0) return cols[i] ?? '';
      }
      return '';
    };
    return lines.slice(1).map((line) => {
      const cols = splitPasteLine(line);
      return {
        Product: pick(cols, 'Product'),
        'Vendor Number': pick(cols, 'Vendor Number'),
        'Vendor Name': pick(cols, 'Vendor Name'),
        'SAP Part Number': pick(cols, 'SAP Part Number'),
        'Part Number': pick(cols, 'Part Number'),
        Description: pick(cols, 'Description'),
        'Received Qty': pick(cols, 'Received Qty'),
        'Sold Out Qty': pick(cols, 'Sold Out Qty'),
        'Pending Delivery Qty': pick(cols, 'Pending Delivery Qty'),
        'Available Qty': pick(cols, 'Available Qty'),
        'SAP Qty': pick(cols, 'SAP Qty'),
        UOM: pick(cols, 'UOM'),
        Remarks: pick(cols, 'Remarks'),
      };
    });
  }

  return lines.map((line) => {
    const cols = splitPasteLine(line);
    // Legacy (≥12 cols): Product | Vendor Name | Vendor # | SAP PN | Part # | Desc | Received | Sold | Pending | [Avail] | SAP Qty | UOM | Remarks
    if (cols.length >= 12) {
      const hasAvailCol = cols.length >= 13;
      const iSap = hasAvailCol ? 10 : 9;
      const iUom = hasAvailCol ? 11 : 10;
      const iRem = hasAvailCol ? 12 : 11;
      return {
        Product: cols[0],
        'Vendor Name': cols[1],
        'Vendor Number': cols[2],
        'SAP Part Number': cols[3],
        'Part Number': cols[4],
        Description: cols[5],
        'Received Qty': parseFloat(cols[6]) || 0,
        'Sold Out Qty': parseFloat(cols[7]) || 0,
        'Pending Delivery Qty': parseFloat(cols[8]) || 0,
        'SAP Qty': cols[iSap] === '' || cols[iSap] === undefined ? undefined : parseFloat(cols[iSap]) || 0,
        UOM: cols[iUom],
        Remarks: cols[iRem],
      };
    }
    // Current template (10–11 cols): Vendor # | Vendor Name | SAP PN | Part # | Desc | Received | Sold | Pending | [Avail] | UOM | Remarks
    const hasAvail = cols.length >= 11;
    return {
      'Vendor Number': cols[0],
      'Vendor Name': cols[1],
      'SAP Part Number': cols[2],
      'Part Number': cols[3],
      Description: cols[4],
      'Received Qty': parseFloat(cols[5]) || 0,
      'Sold Out Qty': parseFloat(cols[6]) || 0,
      'Pending Delivery Qty': parseFloat(cols[7]) || 0,
      ...(hasAvail ? { 'Available Qty': parseFloat(cols[8]) || 0 } : {}),
      UOM: cols[hasAvail ? 9 : 8],
      Remarks: cols[hasAvail ? 10 : 9],
    };
  });
}

function parseInboundPaste(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim());
  const first = (lines[0] || '').toLowerCase();
  const hasNewHeader = first.includes('vendor') && first.includes('part');
  const hasLegacyHeader = first.includes('batch') && first.includes('part');
  const hasHeader = hasNewHeader || hasLegacyHeader;
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const cols = line.includes('\t') ? line.split('\t') : line.split(',').map((c) => c.trim());
    if (hasNewHeader || (cols.length >= 6 && cols.length <= 11)) {
      return {
        vendor_number: cols[0],
        vendor_name: cols[1],
        part_number: cols[2],
        description: cols[3],
        quantity: parseFloat(cols[4]) || 0,
        uom: cols[5] || '',
        size: cols[6] || '',
        weight: cols[7] || '',
        local_po: cols[8] || '',
        vendor_invoice: cols[9] || '',
        sap_bill: cols[10] || '',
      };
    }
    if (cols.length >= 10) {
      return {
        'Batch/Vendor Name': cols[0],
        'Local PO': cols[1],
        'SAP PO': cols[2],
        'SAP Invoice Number': cols[3],
        'Part Number': cols[4],
        'SAP Part Number': cols[5] || '',
        Description: cols[6],
        'Inbound Qty': parseFloat(cols[7]) || 0,
        'Received Date': cols[8] || '',
        Remarks: cols[9] || '',
      };
    }
    return {
      'Batch/Vendor Name': cols[0],
      'Local PO': '',
      'SAP PO': cols[2] || '',
      'SAP Invoice Number': cols[1] || '',
      'Part Number': cols[3],
      'SAP Part Number': cols[4] || '',
      Description: cols[5],
      'Inbound Qty': parseFloat(cols[6]) || 0,
      'Received Date': cols[7] || '',
      Remarks: cols[8] || '',
    };
  });
}

function parseSoldOutPaste(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim());
  return lines.map((line) => {
    const cols = line.includes('\t') ? line.split('\t') : line.split(',').map((c) => c.trim());
    return {
      DATE: cols[0],
      PO: cols[1],
      'CUSTOMER PO': cols[2],
      'Invoice No.': cols[3],
      Invoice: cols[4],
      'Customer Name': cols[5],
      'Delivery Address': cols[6],
      GPS: cols[7],
      'Part Number': cols[8],
      'SAP Part Number': cols[9] || '',
      Description: cols[10],
      'Outbound Qty': parseFloat(cols[11]) || 0,
      Delivery: cols[12] || '',
      'Sales Doc': cols[13] || '',
      Status: cols[14] || '',
      Remarks: cols[15] || '',
    };
  });
}

export default function MainStock() {
  const [tab, setTab] = useState('stock');
  const [stocks, setStocks] = useState([]);
  const [inboundRows, setInboundRows] = useState([]);
  const [inboundFilterLpo, setInboundFilterLpo] = useState('');
  const [inboundFilterSapPo, setInboundFilterSapPo] = useState('');
  const [inboundFilterInvoice, setInboundFilterInvoice] = useState('');
  const [inboundFilterPart, setInboundFilterPart] = useState('');
  const [soldRows, setSoldRows] = useState([]);
  const [reportRows, setReportRows] = useState([]);
  const [reportFilter, setReportFilter] = useState('all');
  const [reportSearchPn, setReportSearchPn] = useState('');
  const [reportSearchSap, setReportSearchSap] = useState('');

  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState('stock');
  const [bulkData, setBulkData] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);

  // Manual Stock In (admin-only enforced server-side)
  const [stockInOpen, setStockInOpen] = useState(false);
  const [stockInPn, setStockInPn] = useState('');
  const [stockInSuggestions, setStockInSuggestions] = useState([]);
  const [stockInSelected, setStockInSelected] = useState(null); // {source, ...}
  const [stockInVendorNumber, setStockInVendorNumber] = useState('');
  const [stockInVendorName, setStockInVendorName] = useState('');
  const [stockInSapPn, setStockInSapPn] = useState('');
  const [stockInDesc, setStockInDesc] = useState('');
  const [stockInQty, setStockInQty] = useState('');
  const [stockInRef, setStockInRef] = useState('');
  const [stockInRemarks, setStockInRemarks] = useState('');

  const [newPartOpen, setNewPartOpen] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [newPartVendorId, setNewPartVendorId] = useState('');
  const [newPartVendorNumber, setNewPartVendorNumber] = useState('');
  const [newPartVendorName, setNewPartVendorName] = useState('');
  const [newPartSapPn, setNewPartSapPn] = useState('');
  const [newPartPn, setNewPartPn] = useState('');
  const [newPartDesc, setNewPartDesc] = useState('');
  const [newPartUom, setNewPartUom] = useState('');
  const [newPartRemarks, setNewPartRemarks] = useState('');

  const [addVendorOpen, setAddVendorOpen] = useState(false);
  const [addVendorForm, setAddVendorForm] = useState({
    vendor_number: '',
    vendor_name: '',
    contact_person: '',
    phone_number: '',
    email: '',
    remarks: '',
  });

  const [inboundSingleOpen, setInboundSingleOpen] = useState(false);
  const [inboundSingleForm, setInboundSingleForm] = useState({
    vendor_id: '',
    vendor_number: '',
    vendor_name: '',
    part_number: '',
    sap_part_number: '',
    description: '',
    uom: '',
    quantity: '',
    lpo: '',
    sap_po: '',
    invoice_no: '',
    received_date: new Date().toISOString().slice(0, 10),
    remarks: '',
  });
  const [inboundPartSearch, setInboundPartSearch] = useState('');
  const [inboundPartSuggestions, setInboundPartSuggestions] = useState([]);

  const [outboundSingleOpen, setOutboundSingleOpen] = useState(false);
  const [outboundSingleForm, setOutboundSingleForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    po: '',
    customer_po: '',
    invoice_no: '',
    customer_name: '',
    delivery_address: '',
    part_number: '',
    sap_part_number: '',
    description: '',
    outbound_qty: '',
    delivery: '',
    sales_doc: '',
    status: 'Delivered',
    remarks: '',
  });
  const [outboundPartSearch, setOutboundPartSearch] = useState('');
  const [outboundPartSuggestions, setOutboundPartSuggestions] = useState([]);

  const emptyInboundSingleForm = () => ({
    vendor_id: '',
    vendor_number: '',
    vendor_name: '',
    part_number: '',
    sap_part_number: '',
    description: '',
    uom: '',
    quantity: '',
    lpo: '',
    sap_po: '',
    invoice_no: '',
    received_date: new Date().toISOString().slice(0, 10),
    remarks: '',
  });

  const emptyOutboundSingleForm = () => ({
    date: new Date().toISOString().slice(0, 10),
    po: '',
    customer_po: '',
    invoice_no: '',
    customer_name: '',
    delivery_address: '',
    part_number: '',
    sap_part_number: '',
    description: '',
    outbound_qty: '',
    delivery: '',
    sales_doc: '',
    status: 'Delivered',
    remarks: '',
  });

  const fileStockRef = useRef(null);
  const fileInboundRef = useRef(null);
  const fileSoldRef = useRef(null);

  const loadStock = async (q = '') => {
    setLoading(true);
    try {
      const data = await mainStockApi.list(q);
      setStocks(data);
    } catch (e) {
      console.error(e);
      try {
        toast.error(e?.response?.data?.error || e.message || 'Failed to load main stock');
      } catch {
        /* ignore */
      }
    } finally {
      setLoading(false);
    }
  };

  const inboundListParams = useCallback(() => {
    const p = {};
    if (inboundFilterLpo.trim()) p.lpo = inboundFilterLpo.trim();
    if (inboundFilterSapPo.trim()) p.sap_po = inboundFilterSapPo.trim();
    if (inboundFilterInvoice.trim()) p.invoice = inboundFilterInvoice.trim();
    if (inboundFilterPart.trim()) p.part_number = inboundFilterPart.trim();
    return p;
  }, [inboundFilterLpo, inboundFilterSapPo, inboundFilterInvoice, inboundFilterPart]);

  const loadInbound = async () => {
    setLoading(true);
    try {
      setInboundRows(await inboundApi.list(inboundListParams()));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const clearInboundFilters = () => {
    setInboundFilterLpo('');
    setInboundFilterSapPo('');
    setInboundFilterInvoice('');
    setInboundFilterPart('');
  };

  const loadSold = async () => {
    setLoading(true);
    try {
      setSoldRows(await soldOutApi.list());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const loadReport = async () => {
    setLoading(true);
    try {
      const params = {
        filter: reportFilter,
        ...(reportSearchPn.trim() ? { part_number: reportSearchPn.trim() } : {}),
        ...(reportSearchSap.trim() ? { sap_part_number: reportSearchSap.trim() } : {}),
      };
      const data = await stockComparisonApi.report(params);
      setReportRows(data.rows || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'stock') loadStock(search);
    else if (tab === 'inbound') loadInbound();
    else if (tab === 'soldout') loadSold();
    else loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (tab === 'stock') loadStock(search);
    }, 300);
    return () => clearTimeout(t);
  }, [search, tab]);

  useEffect(() => {
    if (tab !== 'report') return;
    const t = setTimeout(() => loadReport(), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportFilter, reportSearchPn, reportSearchSap, tab]);

  const refreshVendors = async () => {
    try {
      const v = await vendorsApi.list('');
      setVendors(Array.isArray(v) ? v.filter((x) => x.is_active) : []);
    } catch {
      setVendors([]);
    }
  };

  useEffect(() => {
    refreshVendors();
  }, []);

  const onInboundVendorPick = (vendorId) => {
    const v = vendors.find((x) => String(x.id) === String(vendorId));
    setInboundSingleForm((f) => ({
      ...f,
      vendor_id: vendorId,
      vendor_number: v?.vendor_number || '',
      vendor_name: v?.vendor_name || '',
    }));
  };

  const applyInboundPartSuggestion = (s) => {
    setInboundSingleForm((f) => ({
      ...f,
      part_number: s.part_number,
      sap_part_number: s.sap_part_number || '',
      description: s.description || '',
      uom: s.uom || '',
      vendor_id: s.vendor_id != null ? String(s.vendor_id) : f.vendor_id,
      vendor_number: s.vendor_number || f.vendor_number,
      vendor_name: s.vendor_name || f.vendor_name,
    }));
    setInboundPartSearch(s.part_number);
    setInboundPartSuggestions([]);
  };

  const openInboundSingle = () => {
    setInboundSingleForm(emptyInboundSingleForm());
    setInboundPartSearch('');
    setInboundPartSuggestions([]);
    refreshVendors();
    setInboundSingleOpen(true);
  };

function cleanInboundPartNumber(value) {
  let s = String(value || '').trim();
  for (const sep of [' — ', ' – ', ' | ']) {
    const i = s.indexOf(sep);
    if (i > 0) {
      s = s.slice(0, i).trim();
      break;
    }
  }
  return s;
}

  const submitInboundSingle = async () => {
    const f = inboundSingleForm;
    const qty = Number(String(f.quantity || '').replace(/,/g, ''));
    const partNumber = cleanInboundPartNumber(f.part_number);
    if (!f.vendor_number.trim()) return alert('Vendor is required');
    if (!partNumber) return alert('Part number is required');
    if (!f.description.trim()) return alert('Description is required');
    if (!f.uom.trim()) return alert('UOM is required');
    if (!Number.isFinite(qty) || qty <= 0) return alert('Inbound quantity must be > 0');

    const row = {
      vendor_number: f.vendor_number.trim(),
      vendor_name: f.vendor_name.trim(),
      part_number: partNumber,
      description: f.description.trim(),
      quantity: qty,
      uom: f.uom.trim(),
      'SAP Part Number': f.sap_part_number.trim(),
      'Local PO': f.lpo.trim(),
      'SAP PO': f.sap_po.trim(),
      'SAP Invoice Number': f.invoice_no.trim(),
      'Received Date': f.received_date || '',
      Remarks: f.remarks.trim(),
    };

    try {
      await inboundApi.createSingle(row);
      setInboundSingleOpen(false);
      await loadInbound();
      alert('Inbound line saved.');
    } catch (e) {
      const data = e?.response?.data;
      if (data?.missing_parts?.length) {
        alert(
          `${data.reject_message || 'Part not in item master.'}\nMissing: ${data.missing_parts.map((m) => m.part_number).join(', ')}`
        );
      } else {
        alert(data?.error || e.message);
      }
    }
  };

  const openOutboundSingle = () => {
    setOutboundSingleForm(emptyOutboundSingleForm());
    setOutboundPartSearch('');
    setOutboundPartSuggestions([]);
    setOutboundSingleOpen(true);
  };

  const submitOutboundSingle = async () => {
    const f = outboundSingleForm;
    const qty = Number(String(f.outbound_qty || '').replace(/,/g, ''));
    if (!f.part_number.trim()) return alert('Part number is required');
    if (!Number.isFinite(qty) || qty <= 0) return alert('Outbound quantity must be > 0');

    const row = {
      DATE: f.date || '',
      PO: f.po.trim(),
      'CUSTOMER PO': f.customer_po.trim(),
      'Invoice No.': f.invoice_no.trim(),
      Invoice: f.invoice_no.trim(),
      'Customer Name': f.customer_name.trim(),
      'Delivery Address': f.delivery_address.trim(),
      'Part Number': f.part_number.trim(),
      'SAP Part Number': f.sap_part_number.trim(),
      Description: f.description.trim(),
      'Outbound Qty': qty,
      Delivery: f.delivery.trim(),
      'Sales Doc': f.sales_doc.trim(),
      Status: f.status.trim(),
      Remarks: f.remarks.trim(),
    };

    try {
      const res = await soldOutApi.create(row);
      setOutboundSingleOpen(false);
      await loadSold();
      if (res?.shortage_warnings?.length) {
        alert(`Saved with stock shortages: ${JSON.stringify(res.shortage_warnings)}`);
      } else {
        alert('Outbound line saved.');
      }
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  useEffect(() => {
    if (!inboundSingleOpen) return;
    const q = inboundPartSearch.trim();
    if (!q) {
      setInboundPartSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setInboundPartSuggestions(await fetchMainStockPartPrefixSuggestions(q));
      } catch {
        setInboundPartSuggestions([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [inboundPartSearch, inboundSingleOpen]);

  useEffect(() => {
    if (!outboundSingleOpen) return;
    const q = outboundPartSearch.trim();
    if (!q) {
      setOutboundPartSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setOutboundPartSuggestions(await fetchMainStockPartPrefixSuggestions(q));
      } catch {
        setOutboundPartSuggestions([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [outboundPartSearch, outboundSingleOpen]);

  useEffect(() => {
    if (!stockInOpen) return;
    const q = stockInPn.trim();
    if (!q) {
      setStockInSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setStockInSuggestions(await fetchMainStockPartPrefixSuggestions(q));
      } catch (e) {
        console.error(e);
        setStockInSuggestions([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [stockInPn, stockInOpen]);

  const stockRows = useMemo(() => stocks || [], [stocks]);

  const stockSortValue = useCallback((r, k) => {
    if (k === 'sold_out_qty') return Number(r.sold_out_qty ?? r.issued_qty) || 0;
    const nums = new Set(['received_qty', 'issued_qty', 'pending_delivery_qty', 'available_qty', 'sap_qty']);
    if (nums.has(k)) {
      const v = r[k];
      if (v === '' || v === null || v === undefined || v === '-') return -Infinity;
      const n = Number(v);
      return Number.isFinite(n) ? n : -Infinity;
    }
    return r[k];
  }, []);
  const { displayRows: stockDisplay, sortKey: sortStockKey, direction: dirStock, requestSort: sortStock } =
    useTableSort(stockRows, stockSortValue);

  const inboundSortValue = useCallback((r, k) => {
    if (k === 'inbound_qty') return Number(r.inbound_qty) || 0;
    if (k === 'received_date') {
      const t = r.received_date ? new Date(r.received_date).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    }
    return r[k];
  }, []);
  const { displayRows: inboundDisplay, sortKey: sortInboundKey, direction: dirInbound, requestSort: sortInbound } =
    useTableSort(inboundRows, inboundSortValue);

  const soldSortValue = useCallback((r, k) => {
    if (k === 'outbound_qty') return Number(r.outbound_qty ?? r.sold_qty) || 0;
    if (k === 'date') {
      const t = r.date ? new Date(r.date).getTime() : 0;
      return Number.isFinite(t) ? t : 0;
    }
    return r[k];
  }, []);
  const { displayRows: soldDisplay, sortKey: sortSoldKey, direction: dirSold, requestSort: sortSold } =
    useTableSort(soldRows, soldSortValue);

  const reportSortValue = useCallback((r, k) => {
    if (['main_stock_available_qty', 'stock_by_rack_available_qty', 'difference'].includes(k)) return Number(r[k]) || 0;
    if (k === 'sap_qty') {
      const v = r.sap_qty;
      if (v === '' || v === null || v === undefined || v === '-') return -Infinity;
      const n = Number(v);
      return Number.isFinite(n) ? n : -Infinity;
    }
    return r[k];
  }, []);
  const { displayRows: reportDisplay, sortKey: sortReportKey, direction: dirReport, requestSort: sortReport } =
    useTableSort(reportRows, reportSortValue);

  const openBulk = (mode) => {
    setBulkMode(mode);
    setBulkData('');
    setBulkPreview([]);
    setBulkOpen(true);
  };

  const previewBulk = () => {
    try {
      if (bulkMode === 'stock') setBulkPreview(parseMainStockPaste(bulkData).slice(0, 15));
      else if (bulkMode === 'inbound') setBulkPreview(parseInboundPaste(bulkData).slice(0, 15));
      else setBulkPreview(parseSoldOutPaste(bulkData).slice(0, 15));
    } catch {
      setBulkPreview([]);
    }
  };

  const submitBulk = async () => {
    try {
      if (bulkMode === 'stock') {
        await mainStockApi.bulkPaste(parseMainStockPaste(bulkData));
        await loadStock(search);
      } else if (bulkMode === 'inbound') {
        const rows = parseInboundPaste(bulkData);
        let validation;
        try {
          validation = await inboundApi.validateRows(rows, 'bulk-paste');
        } catch (e) {
          const data = e?.response?.data;
          if (data?.validation_id) validation = data;
          else throw e;
        }
        if (!validation?.valid) {
          alert(validation?.reject_message || 'Validation failed — fix missing parts first.');
          return;
        }
        await inboundApi.bulkPaste(rows, validation.validation_id);
        await loadInbound();
      } else {
        const res = await soldOutApi.bulkPaste(parseSoldOutPaste(bulkData));
        if (res?.shortage_warnings?.length) alert(`Shortage warnings: ${JSON.stringify(res.shortage_warnings)}`);
        await loadSold();
      }
      setBulkOpen(false);
      setBulkData('');
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  };

  const pasteHint =
    bulkMode === 'stock'
      ? 'Tab or comma (or paste with header row): Vendor Number | Vendor Name | SAP PN | Part # | Desc | Received | Sold Out | Pending | [Available Qty] | UOM | Remarks — Legacy 12+ cols with Product still supported.'
      : bulkMode === 'inbound'
        ? 'Tab or comma: vendor_number | vendor_name | part_number | description | quantity | uom | [size] | [weight] — or legacy Batch/Vendor columns'
        : 'Tab or comma: DATE | PO | CUSTOMER PO | Invoice No | Invoice | Customer | Address | GPS | Part # | SAP PN | Desc | Outbound Qty | Delivery | Sales Doc | Status | Remarks';

  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-start justify-between mb-3 gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900 leading-tight">Main Stock module</h2>
          <p className="text-[11px] text-gray-600">
            Main Stock is source of truth. Stock by Rack is FIFO-only. Comparison tab does not block mismatches.
          </p>
        </div>
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[10px] text-gray-500 mr-1">XLSX:</span>
          <button type="button" className="btn-secondary text-[11px]" onClick={() => mainStockApi.downloadTemplateXlsx()}>
            Main Stock
          </button>
          <button type="button" className="btn-secondary text-[11px]" onClick={() => inboundApi.downloadTemplateXlsx()}>
            Inbound
          </button>
          <button type="button" className="btn-secondary text-[11px]" onClick={() => soldOutApi.downloadTemplateXlsx()}>
            Outbound
          </button>
          <span className="text-[10px] text-gray-500 mx-1">CSV:</span>
          <button
            type="button"
            className="btn-secondary text-[11px]"
            onClick={() =>
              downloadCsvFile(
                'main-stock-template.csv',
                [
                  'Vendor Number',
                  'Vendor Name',
                  'SAP Part Number',
                  'Part Number',
                  'Description',
                  'Received Qty',
                  'Sold Out Qty',
                  'Pending Delivery Qty',
                  'Available Qty',
                  'UOM',
                  'Remarks',
                ],
                [
                  {
                    'Vendor Number': 'VEN001',
                    'Vendor Name': 'CommScope',
                    'SAP Part Number': 'SAP-PN-100',
                    'Part Number': 'PN-100',
                    Description: 'Patch Cord',
                    'Received Qty': 100,
                    'Sold Out Qty': 20,
                    'Pending Delivery Qty': 10,
                    'Available Qty': 70,
                    UOM: 'PCS',
                    Remarks: 'Opening balance',
                  },
                ]
              )
            }
          >
            Main Stock
          </button>
          <button
            type="button"
            className="btn-secondary text-[11px]"
            onClick={() =>
              downloadCsvFile(
                'inbound-template.csv',
                [
                  'Batch/Vendor Name',
                  'Local PO',
                  'SAP PO',
                  'SAP Invoice Number',
                  'Part Number',
                  'SAP Part Number',
                  'Description',
                  'Inbound Qty',
                  'Received Date',
                  'Remarks',
                ],
                [
                  {
                    'Batch/Vendor Name': 'C779-C788 | Schneider',
                    'Local PO': 'LPO-2026-001',
                    'SAP PO': '5500001206',
                    'SAP Invoice Number': '9010104400',
                    'Part Number': '760241056',
                    'SAP Part Number': '760241056',
                    Description: 'O-012-LN-8W-M12BK/2C',
                    'Inbound Qty': 2046,
                    'Received Date': '2026-05-01',
                    Remarks: 'Receiving upload',
                  },
                ]
              )
            }
          >
            Inbound
          </button>
          <button
            type="button"
            className="btn-secondary text-[11px]"
            onClick={() =>
              downloadCsvFile(
                'outbound-template.csv',
                [
                  'DATE',
                  'PO',
                  'CUSTOMER PO',
                  'Invoice No.',
                  'Invoice',
                  'Customer Name',
                  'Delivery Address',
                  'GPS',
                  'Part Number',
                  'SAP Part Number',
                  'Description',
                  'Outbound Qty',
                  'Delivery',
                  'Sales Doc',
                  'Status',
                  'Remarks',
                ],
                [
                  {
                    DATE: '2023-07-18',
                    PO: '15001789',
                    'CUSTOMER PO': '3419',
                    'Invoice No.': '90005242',
                    Invoice: '90005242',
                    'Customer Name': 'Madar Information',
                    'Delivery Address': 'Makkah - Jeddah',
                    GPS: 'https://goo.gl/example',
                    'Part Number': '1671000-8',
                    'SAP Part Number': '1671000-8',
                    Description: '10ENC_SLID',
                    'Outbound Qty': 10,
                    Delivery: '80019130',
                    'Sales Doc': '50012345',
                    Status: 'Delivered',
                    Remarks: '-',
                  },
                ]
              )
            }
          >
            Outbound
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 mb-3 border-b border-gray-200 pb-2">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-[11px] font-bold border ${
              tab === id ? 'bg-primary-50 text-primary-700 border-primary-200' : 'bg-white text-gray-700 border-gray-200'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* Manual Stock In Modal */}
      {stockInOpen ? (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 dn-no-print">
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[86vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold">Add Stock In - Main Stock</h3>
                <p className="text-[11px] text-gray-600 mt-1">Updates Main Stock only. Does not touch Stock By Rack.</p>
              </div>
              <button type="button" className="btn-secondary" onClick={() => setStockInOpen(false)}>
                Close
              </button>
            </div>

            <div className="mt-4">
              <label className="text-[11px] font-bold text-gray-700">
                Part Number search
                <input
                  className="input-field mt-1"
                  value={stockInPn}
                  onChange={(e) => {
                    setStockInPn(e.target.value);
                    setStockInSelected(null);
                  }}
                  placeholder="Type part number — suggestions start with what you type"
                />
              </label>

              {stockInPn.trim() && stockInSuggestions.length ? (
                <div className="mt-2 border rounded-md overflow-hidden">
                  <div className="px-3 py-2 bg-gray-50 text-[11px] font-bold text-gray-700">Suggestions</div>
                  <div className="max-h-48 overflow-y-auto">
                    {stockInSuggestions.map((s) => (
                      <button
                        key={s.part_number}
                        type="button"
                        className="w-full text-left px-3 py-2 hover:bg-gray-50 border-t text-[11px]"
                        onClick={() => {
                          setStockInSelected(s);
                          setStockInPn(s.part_number);
                          setStockInVendorNumber(s.vendor_number || '');
                          setStockInVendorName(s.vendor_name || '');
                          setStockInSapPn(s.sap_part_number || '');
                          setStockInDesc(s.description || '');
                        }}
                      >
                        <div className="font-semibold text-gray-900">
                          {s.part_number}
                          {s.description ? ` — ${s.description}` : ''}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {stockInPn.trim() && !stockInSuggestions.length ? (
                <div className="mt-2 flex items-center justify-between gap-2 text-[11px] bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                  <div className="text-amber-900 font-semibold">Part number not found.</div>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setNewPartOpen(true);
                      setNewPartPn(stockInPn.trim());
                      setNewPartSapPn('');
                      setNewPartDesc('');
                      setNewPartUom('');
                      setNewPartVendorId('');
                      setNewPartVendorNumber('');
                      setNewPartVendorName('');
                      setNewPartRemarks('');
                    }}
                  >
                    Add New Part Number
                  </button>
                </div>
              ) : null}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
              <label className="text-[11px] font-bold text-gray-700">
                Vendor Number
                <input className="input-field mt-1" value={stockInVendorNumber} onChange={(e) => setStockInVendorNumber(e.target.value)} />
              </label>
              <label className="text-[11px] font-bold text-gray-700">
                Vendor Name
                <input className="input-field mt-1" value={stockInVendorName} onChange={(e) => setStockInVendorName(e.target.value)} />
              </label>
              <label className="text-[11px] font-bold text-gray-700">
                SAP Part Number
                <input className="input-field mt-1" value={stockInSapPn} onChange={(e) => setStockInSapPn(e.target.value)} />
              </label>
              <label className="text-[11px] font-bold text-gray-700 sm:col-span-2">
                Description
                <input className="input-field mt-1" value={stockInDesc} onChange={(e) => setStockInDesc(e.target.value)} />
              </label>
              <label className="text-[11px] font-bold text-gray-700">
                Qty In
                <input className="input-field mt-1" value={stockInQty} onChange={(e) => setStockInQty(e.target.value)} />
              </label>
              <label className="text-[11px] font-bold text-gray-700">
                Reference No.
                <input className="input-field mt-1" value={stockInRef} onChange={(e) => setStockInRef(e.target.value)} />
              </label>
              <label className="text-[11px] font-bold text-gray-700 sm:col-span-2">
                Remarks
                <textarea className="input-field mt-1 h-16" value={stockInRemarks} onChange={(e) => setStockInRemarks(e.target.value)} />
              </label>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className="btn-secondary" onClick={() => setStockInOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={async () => {
                  try {
                    const pn = stockInPn.trim();
                    const qty = Number(String(stockInQty || '').replace(/,/g, ''));
                    if (!pn) return alert('Part Number is required');
                    if (!Number.isFinite(qty) || qty <= 0) return alert('Qty In must be > 0');
                    if (!stockInDesc.trim()) return alert('Description is required');
                    await mainStockApi.manualStockIn({
                      part_number: pn,
                      qty_in: qty,
                      vendor_number: stockInVendorNumber,
                      vendor_name: stockInVendorName,
                      sap_part_number: stockInSapPn,
                      description: stockInDesc,
                      reference_no: stockInRef,
                      remarks: stockInRemarks,
                    });
                    alert('Stock In saved successfully');
                    setStockInOpen(false);
                    await loadStock(search);
                    if (tab === 'inbound') await loadInbound();
                  } catch (e) {
                    alert(e?.response?.data?.error || e.message);
                  }
                }}
              >
                Save Stock In
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* New Part Number Modal */}
      {newPartOpen ? (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 dn-no-print">
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[86vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-lg font-bold">New Part Number</h3>
              <button type="button" className="btn-secondary" onClick={() => setNewPartOpen(false)}>
                Close
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
              <label className="text-[11px] font-bold sm:col-span-2">
                Vendor
                <div className="flex gap-2 mt-1">
                  <select
                    className="input-field flex-1"
                    value={newPartVendorId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setNewPartVendorId(id);
                      const v = vendors.find((x) => String(x.id) === String(id));
                      setNewPartVendorNumber(v?.vendor_number || '');
                      setNewPartVendorName(v?.vendor_name || '');
                    }}
                  >
                    <option value="">Select vendor…</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.vendor_name} {v.vendor_number ? `(${v.vendor_number})` : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-secondary whitespace-nowrap"
                    onClick={() => {
                      setAddVendorOpen(true);
                      setAddVendorForm({ vendor_number: '', vendor_name: '', contact_person: '', phone_number: '', email: '', remarks: '' });
                    }}
                  >
                    Add Vendor
                  </button>
                </div>
              </label>
              <label className="text-[11px] font-bold">
                Vendor Number
                <input className="input-field mt-1" value={newPartVendorNumber} readOnly />
              </label>
              <label className="text-[11px] font-bold">
                Vendor Name
                <input className="input-field mt-1" value={newPartVendorName} readOnly />
              </label>
              <label className="text-[11px] font-bold">
                SAP Part Number
                <input className="input-field mt-1" value={newPartSapPn} onChange={(e) => setNewPartSapPn(e.target.value)} />
              </label>
              <label className="text-[11px] font-bold">
                Part Number
                <input className="input-field mt-1" value={newPartPn} onChange={(e) => setNewPartPn(e.target.value)} />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Description
                <input className="input-field mt-1" value={newPartDesc} onChange={(e) => setNewPartDesc(e.target.value)} />
              </label>
              <label className="text-[11px] font-bold">
                UOM
                <input className="input-field mt-1" value={newPartUom} onChange={(e) => setNewPartUom(e.target.value)} />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Remarks
                <textarea className="input-field mt-1 h-16" value={newPartRemarks} onChange={(e) => setNewPartRemarks(e.target.value)} />
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className="btn-secondary" onClick={() => setNewPartOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={async () => {
                  try {
                    if (!newPartPn.trim()) return alert('Part Number is required');
                    if (!newPartDesc.trim()) return alert('Description is required');
                    if (!newPartVendorId) return alert('Vendor is required');
                    const out = await mainStockApi.addNewPart({
                      vendor_id: Number(newPartVendorId),
                      sap_part_number: newPartSapPn,
                      part_number: newPartPn,
                      description: newPartDesc,
                      uom: newPartUom,
                      remarks: newPartRemarks,
                    });
                    setNewPartOpen(false);
                    setStockInPn(out?.main_stock?.part_number || newPartPn);
                    setStockInVendorNumber(out?.main_stock?.vendor_number || newPartVendorNumber);
                    setStockInVendorName(out?.main_stock?.vendor_name || newPartVendorName);
                    setStockInSapPn(out?.main_stock?.sap_part_number || newPartSapPn);
                    setStockInDesc(out?.main_stock?.description || newPartDesc);
                    await loadStock(search);
                  } catch (e) {
                    alert(e?.response?.data?.error || e.message);
                  }
                }}
              >
                Save Item
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Add Vendor Modal */}
      {addVendorOpen ? (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 dn-no-print">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-lg font-bold">Add New Vendor</h3>
              <button type="button" className="btn-secondary" onClick={() => setAddVendorOpen(false)}>
                Close
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
              <label className="text-[11px] font-bold">
                Vendor Number
                <input className="input-field mt-1" value={addVendorForm.vendor_number} onChange={(e) => setAddVendorForm((s) => ({ ...s, vendor_number: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                Vendor Name
                <input className="input-field mt-1" value={addVendorForm.vendor_name} onChange={(e) => setAddVendorForm((s) => ({ ...s, vendor_name: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                Contact Person
                <input className="input-field mt-1" value={addVendorForm.contact_person} onChange={(e) => setAddVendorForm((s) => ({ ...s, contact_person: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                Phone Number
                <input className="input-field mt-1" value={addVendorForm.phone_number} onChange={(e) => setAddVendorForm((s) => ({ ...s, phone_number: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Email
                <input className="input-field mt-1" value={addVendorForm.email} onChange={(e) => setAddVendorForm((s) => ({ ...s, email: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Remarks
                <textarea className="input-field mt-1 h-16" value={addVendorForm.remarks} onChange={(e) => setAddVendorForm((s) => ({ ...s, remarks: e.target.value }))} />
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className="btn-secondary" onClick={() => setAddVendorOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={async () => {
                  try {
                    if (!addVendorForm.vendor_name.trim()) return alert('Vendor Name is required');
                    const v = await vendorsApi.create(addVendorForm);
                    await refreshVendors();
                    setAddVendorOpen(false);
                    if (v?.id) {
                      setNewPartVendorId(String(v.id));
                      setNewPartVendorNumber(v.vendor_number || '');
                      setNewPartVendorName(v.vendor_name || '');
                    }
                  } catch (e) {
                    alert(e?.response?.data?.error || e.message);
                  }
                }}
              >
                Save Vendor
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'stock' && (
        <>
          <div className="flex flex-wrap gap-1.5 mb-2 justify-end">
            <button
              type="button"
              className="btn-secondary flex items-center gap-1 text-[11px]"
              onClick={() =>
                exportJsonToExcel(
                  stockDisplay.map((r) => ({
                    'Part Number': r.part_number,
                    'SAP Part Number': r.sap_part_number,
                    Description: r.description,
                    'Received Qty': r.received_qty,
                    'Sold Out Qty': r.sold_out_qty ?? r.issued_qty,
                    'Pending Delivery Qty': r.pending_delivery_qty,
                    'Available Qty': r.available_qty,
                    'SAP Qty': r.sap_qty,
                    UOM: r.uom,
                    Remarks: r.remarks,
                  })),
                  'main-stock-export.xlsx',
                  'Main Stock'
                )
              }
            >
              <FileDown size={14} />
              Export Excel
            </button>
            <label className="btn-secondary flex items-center gap-1 cursor-pointer text-[11px]">
              <Upload size={14} />
              Upload Excel/CSV
              <input
                ref={fileStockRef}
                type="file"
                accept=".xlsx,.xls,.csv,.txt"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    const summary = await mainStockApi.upload(f);
                    await loadStock(search);
                    reportUploadResult(summary, {
                      label: 'Main stock upload',
                      filenamePrefix: 'main-stock-upload',
                      notify: (msg) => (summary?.success === summary?.total ? toast.success(msg) : toast.warning(msg)),
                    });
                  } catch (err) {
                    if (err?.code === 'ECONNABORTED') {
                      alert('Request timed out — file may be too large or the server is busy.');
                    } else {
                      reportUploadError(err, { label: 'Main stock upload', filenamePrefix: 'main-stock-upload' });
                    }
                  } finally {
                    e.target.value = '';
                  }
                }}
              />
            </label>
            <button type="button" className="btn-secondary flex items-center gap-1 text-[11px]" onClick={() => openBulk('stock')}>
              <Copy size={14} />
              Bulk paste
            </button>
          </div>
          <div className="app-page-toolbar">
            <div className="flex items-center gap-2 max-w-md">
              <Search size={14} className="text-gray-400 flex-shrink-0" />
              <input
                type="text"
                placeholder="Search part, SAP, vendor, description…"
                className="input-field flex-1"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="table-container mt-2">
            <table className="min-w-full divide-y divide-gray-200 text-[11px]">
              <thead className="bg-gray-50">
                <tr>
                  <SortTh columnKey="part_number" sortKey={sortStockKey} direction={dirStock} onSort={sortStock}>
                    Part #
                  </SortTh>
                  <SortTh columnKey="sap_part_number" sortKey={sortStockKey} direction={dirStock} onSort={sortStock}>
                    SAP PN
                  </SortTh>
                  <SortTh columnKey="description" sortKey={sortStockKey} direction={dirStock} onSort={sortStock}>
                    Description
                  </SortTh>
                  <SortTh columnKey="received_qty" sortKey={sortStockKey} direction={dirStock} onSort={sortStock}>
                    Received
                  </SortTh>
                  <SortTh columnKey="sold_out_qty" sortKey={sortStockKey} direction={dirStock} onSort={sortStock}>
                    Sold out
                  </SortTh>
                  <SortTh columnKey="pending_delivery_qty" sortKey={sortStockKey} direction={dirStock} onSort={sortStock}>
                    Pending del.
                  </SortTh>
                  <SortTh columnKey="available_qty" sortKey={sortStockKey} direction={dirStock} onSort={sortStock}>
                    Available
                  </SortTh>
                  <SortTh columnKey="sap_qty" sortKey={sortStockKey} direction={dirStock} onSort={sortStock}>
                    SAP Qty
                  </SortTh>
                  <SortTh columnKey="uom" sortKey={sortStockKey} direction={dirStock} onSort={sortStock}>
                    UOM
                  </SortTh>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr>
                    <td className="tbl-td text-gray-500" colSpan={9}>
                      Loading…
                    </td>
                  </tr>
                ) : null}
                {stockDisplay.map((r) => (
                  <tr key={r.id || r.part_number} className="hover:bg-gray-50">
                    <td className="tbl-td-nowrap font-mono">{r.part_number}</td>
                    <td className="tbl-td-nowrap font-mono">{r.sap_part_number || '-'}</td>
                    <td className="tbl-td">{r.description || '-'}</td>
                    <td className="tbl-td-nowrap">{r.received_qty ?? 0}</td>
                    <td className="tbl-td-nowrap">{r.sold_out_qty ?? r.issued_qty ?? 0}</td>
                    <td className="tbl-td-nowrap">{r.pending_delivery_qty ?? 0}</td>
                    <td className="tbl-td-nowrap font-bold">{r.available_qty ?? 0}</td>
                    <td className="tbl-td-nowrap">{r.sap_qty ?? '-'}</td>
                    <td className="tbl-td-nowrap">{r.uom || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'inbound' && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <p className="text-[11px] text-gray-600">
              Inbound increases Main Stock only. All part numbers must exist in item master or main stock before upload.
            </p>
            <button type="button" className="btn-primary flex items-center gap-1 text-[11px] shrink-0" onClick={openInboundSingle}>
              <Plus size={14} />
              Add Inbound
            </button>
          </div>
          <InboundUploadValidation
            onUploadComplete={(summary) => {
              loadInbound();
              reportUploadResult(summary, { label: 'Inbound upload', filenamePrefix: 'inbound-upload' });
            }}
          />
          <div className="flex flex-wrap gap-1.5 mb-2">
            <button
              type="button"
              className="btn-secondary flex items-center gap-1 text-[11px]"
              onClick={() =>
                exportJsonToExcel(
                  inboundDisplay.map((r) => ({
                    'Vendor batch': r.batch_vendor_name,
                    LPO: r.lpo,
                    'SAP PO': r.sap_po || r.po_number,
                    Invoice: r.invoice_no,
                    'Part Number': r.part_number,
                    'SAP Part Number': r.sap_part_number,
                    Description: r.description,
                    'Inbound Qty': r.inbound_qty,
                    'Received Date': r.received_date,
                    Remarks: r.remarks,
                  })),
                  'inbound-export.xlsx',
                  'Inbound'
                )
              }
            >
              <FileDown size={14} />
              Export Excel
            </button>
            <button type="button" className="btn-secondary flex items-center gap-1 text-[11px]" onClick={() => openBulk('inbound')}>
              <Copy size={14} />
              Bulk paste
            </button>
            <button type="button" className="btn-secondary text-[11px]" onClick={() => inboundApi.downloadTemplateXlsx()}>
              Download template
            </button>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-3 mb-2">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <InboundFilterAutocomplete
                label="LPO"
                value={inboundFilterLpo}
                onChange={setInboundFilterLpo}
                fetchSuggestions={(q) => inboundApi.filterSuggestions('lpo', q)}
              />
              <InboundFilterAutocomplete
                label="SAP PO"
                value={inboundFilterSapPo}
                onChange={setInboundFilterSapPo}
                fetchSuggestions={(q) => inboundApi.filterSuggestions('sap_po', q)}
              />
              <InboundFilterAutocomplete
                label="Invoice"
                value={inboundFilterInvoice}
                onChange={setInboundFilterInvoice}
                fetchSuggestions={(q) => inboundApi.filterSuggestions('invoice', q)}
              />
              <InboundFilterAutocomplete
                label="Part #"
                value={inboundFilterPart}
                onChange={setInboundFilterPart}
                fetchSuggestions={(q) => inboundApi.filterSuggestions('part', q)}
              />
              <div className="flex items-end gap-2">
                <button type="button" className="btn-primary text-[11px] flex-1" onClick={() => loadInbound()}>
                  Apply
                </button>
                <button
                  type="button"
                  className="btn-secondary text-[11px]"
                  onClick={() => {
                    clearInboundFilters();
                    setTimeout(() => loadInbound(), 0);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
          <div className="table-container">
            <table className="min-w-full divide-y divide-gray-200 text-[11px]">
              <thead className="bg-gray-50">
                <tr>
                  <SortTh columnKey="batch_vendor_name" sortKey={sortInboundKey} direction={dirInbound} onSort={sortInbound}>
                    Vendor batch
                  </SortTh>
                  <SortTh columnKey="lpo" sortKey={sortInboundKey} direction={dirInbound} onSort={sortInbound}>
                    LPO
                  </SortTh>
                  <SortTh columnKey="sap_po" sortKey={sortInboundKey} direction={dirInbound} onSort={sortInbound}>
                    SAP PO
                  </SortTh>
                  <SortTh columnKey="invoice_no" sortKey={sortInboundKey} direction={dirInbound} onSort={sortInbound}>
                    Invoice
                  </SortTh>
                  <SortTh columnKey="part_number" sortKey={sortInboundKey} direction={dirInbound} onSort={sortInbound}>
                    Part #
                  </SortTh>
                  <SortTh columnKey="inbound_qty" sortKey={sortInboundKey} direction={dirInbound} onSort={sortInbound}>
                    Qty
                  </SortTh>
                  <SortTh columnKey="received_date" sortKey={sortInboundKey} direction={dirInbound} onSort={sortInbound}>
                    Date
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={7} className="tbl-td">
                      Loading…
                    </td>
                  </tr>
                ) : null}
                {inboundDisplay.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="tbl-td">{r.batch_vendor_name}</td>
                    <td className="tbl-td-nowrap">{r.lpo || '—'}</td>
                    <td className="tbl-td-nowrap">{r.sap_po || r.po_number || '—'}</td>
                    <td className="tbl-td-nowrap">{r.invoice_no || '—'}</td>
                    <td className="tbl-td font-mono">{r.part_number}</td>
                    <td className="tbl-td">{r.inbound_qty}</td>
                    <td className="tbl-td-nowrap">{formatDateDDMMYYYY(r.received_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'soldout' && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-md px-2 py-1.5 flex-1">
              Upload logs Sold Out lines. Rows with Status = Delivered deduct Main Stock (sold_out_qty) when sufficient quantity;
              shortages are reported without forcing negative stock.
            </p>
            <button type="button" className="btn-primary flex items-center gap-1 text-[11px] shrink-0" onClick={openOutboundSingle}>
              <Plus size={14} />
              Add Outbound
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            <label className="btn-secondary flex items-center gap-1 cursor-pointer text-[11px]">
              <Upload size={14} />
              Upload
              <input
                ref={fileSoldRef}
                type="file"
                accept=".xlsx,.xls,.csv,.txt"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    const res = await soldOutApi.upload(f);
                    await loadSold();
                    reportUploadResult(res, { label: 'Outbound / sold-out upload', filenamePrefix: 'sold-out-upload' });
                    if (res?.shortage_warnings?.length) alert(`Shortages: ${JSON.stringify(res.shortage_warnings)}`);
                  } catch (err) {
                    reportUploadError(err, { label: 'Outbound / sold-out upload', filenamePrefix: 'sold-out-upload' });
                  } finally {
                    e.target.value = '';
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="btn-secondary flex items-center gap-1 text-[11px]"
              onClick={() =>
                exportJsonToExcel(
                  soldDisplay.map((r) => ({
                    Date: r.date,
                    'Part Number': r.part_number,
                    'SAP Part Number': r.sap_part_number,
                    Description: r.description,
                    'Outbound Qty': r.outbound_qty ?? r.sold_qty,
                    Status: r.status,
                    'Invoice Number': r.invoice_number,
                    Delivery: r.delivery,
                    'Sales Doc': r.sales_doc,
                    'Customer PO': r.customer_po,
                    Customer: r.customer_name,
                    Remarks: r.remarks,
                  })),
                  'outbound-sold-out-export.xlsx',
                  'Outbound'
                )
              }
            >
              <FileDown size={14} />
              Export Excel
            </button>
            <button type="button" className="btn-secondary flex items-center gap-1 text-[11px]" onClick={() => openBulk('soldout')}>
              <Copy size={14} />
              Bulk paste
            </button>
          </div>
          <div className="table-container max-h-[520px] overflow-auto">
            <table className="min-w-full divide-y divide-gray-200 text-[11px]">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <SortTh columnKey="date" sortKey={sortSoldKey} direction={dirSold} onSort={sortSold}>
                    Date
                  </SortTh>
                  <SortTh columnKey="part_number" sortKey={sortSoldKey} direction={dirSold} onSort={sortSold}>
                    Part #
                  </SortTh>
                  <SortTh columnKey="outbound_qty" sortKey={sortSoldKey} direction={dirSold} onSort={sortSold}>
                    Outbound qty
                  </SortTh>
                  <SortTh columnKey="status" sortKey={sortSoldKey} direction={dirSold} onSort={sortSold}>
                    Status
                  </SortTh>
                  <SortTh columnKey="invoice_number" sortKey={sortSoldKey} direction={dirSold} onSort={sortSold}>
                    Invoice
                  </SortTh>
                  <SortTh columnKey="delivery" sortKey={sortSoldKey} direction={dirSold} onSort={sortSold}>
                    Delivery
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={6} className="tbl-td">
                      Loading…
                    </td>
                  </tr>
                ) : null}
                {soldDisplay.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="tbl-td-nowrap">{formatDateDDMMYYYY(r.date)}</td>
                    <td className="tbl-td font-mono">{r.part_number}</td>
                    <td className="tbl-td">{r.outbound_qty ?? r.sold_qty}</td>
                    <td className="tbl-td">{r.status}</td>
                    <td className="tbl-td-nowrap">{r.invoice_number}</td>
                    <td className="tbl-td">{r.delivery}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'report' && (
        <>
          <div className="flex flex-wrap gap-2 items-end mb-3">
            <label className="text-[11px] font-semibold">
              Filter
              <select
                className="mt-0.5 block border border-gray-300 rounded-md px-2 py-1 text-[11px]"
                value={reportFilter}
                onChange={(e) => setReportFilter(e.target.value)}
              >
                <option value="all">Show all</option>
                <option value="match">Match only</option>
                <option value="mismatch">Mismatch only</option>
              </select>
            </label>
            <label className="text-[11px] font-semibold">
              Part #
              <input
                className="mt-0.5 block border border-gray-300 rounded-md px-2 py-1 text-[11px] w-36"
                value={reportSearchPn}
                onChange={(e) => setReportSearchPn(e.target.value)}
                placeholder="contains…"
              />
            </label>
            <label className="text-[11px] font-semibold">
              SAP PN
              <input
                className="mt-0.5 block border border-gray-300 rounded-md px-2 py-1 text-[11px] w-36"
                value={reportSearchSap}
                onChange={(e) => setReportSearchSap(e.target.value)}
                placeholder="contains…"
              />
            </label>
          </div>
          <div className="table-container max-h-[560px] overflow-auto">
            <table className="min-w-full divide-y divide-gray-200 text-[11px]">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <SortTh columnKey="part_number" sortKey={sortReportKey} direction={dirReport} onSort={sortReport}>
                    Part #
                  </SortTh>
                  <SortTh columnKey="sap_part_number" sortKey={sortReportKey} direction={dirReport} onSort={sortReport}>
                    SAP PN
                  </SortTh>
                  <SortTh columnKey="description" sortKey={sortReportKey} direction={dirReport} onSort={sortReport}>
                    Description
                  </SortTh>
                  <SortTh columnKey="main_stock_available_qty" sortKey={sortReportKey} direction={dirReport} onSort={sortReport}>
                    Main avail
                  </SortTh>
                  <SortTh columnKey="stock_by_rack_available_qty" sortKey={sortReportKey} direction={dirReport} onSort={sortReport}>
                    Rack sum
                  </SortTh>
                  <SortTh columnKey="sap_qty" sortKey={sortReportKey} direction={dirReport} onSort={sortReport}>
                    SAP Qty
                  </SortTh>
                  <SortTh columnKey="difference" sortKey={sortReportKey} direction={dirReport} onSort={sortReport}>
                    Difference
                  </SortTh>
                  <SortTh columnKey="status" sortKey={sortReportKey} direction={dirReport} onSort={sortReport}>
                    Status
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={8} className="tbl-td">
                      Loading…
                    </td>
                  </tr>
                ) : null}
                {reportDisplay.map((r, i) => (
                  <tr key={`${r.part_number}-${i}`} className="hover:bg-gray-50">
                    <td className="tbl-td font-mono">{r.part_number}</td>
                    <td className="tbl-td font-mono">{r.sap_part_number || '-'}</td>
                    <td className="tbl-td">{r.description || '-'}</td>
                    <td className="tbl-td">{Number(r.main_stock_available_qty).toFixed(4)}</td>
                    <td className="tbl-td">{Number(r.stock_by_rack_available_qty).toFixed(4)}</td>
                    <td className="tbl-td">{r.sap_qty ?? '-'}</td>
                    <td className="tbl-td">{Number(r.difference).toFixed(4)}</td>
                    <td className="tbl-td">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {inboundSingleOpen ? (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 dn-no-print">
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[86vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold">Add Inbound — single line</h3>
                <p className="text-[11px] text-gray-600 mt-1">Part must exist in item master. Updates Main Stock received qty.</p>
              </div>
              <button type="button" className="btn-secondary" onClick={() => setInboundSingleOpen(false)}>
                Close
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
              <label className="text-[11px] font-bold sm:col-span-2">
                Vendor
                <select
                  className="input-field mt-1"
                  value={inboundSingleForm.vendor_id}
                  onChange={(e) => onInboundVendorPick(e.target.value)}
                >
                  <option value="">Select vendor…</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.vendor_name} {v.vendor_number ? `(${v.vendor_number})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Part Number
                <input
                  className="input-field mt-1"
                  value={inboundPartSearch}
                  onChange={(e) => {
                    setInboundPartSearch(e.target.value);
                    setInboundSingleForm((f) => ({ ...f, part_number: e.target.value }));
                  }}
                  placeholder="Type part number — suggestions start with what you type"
                />
              </label>
              {inboundPartSuggestions.length ? (
                <div className="sm:col-span-2 border rounded-md overflow-hidden max-h-40 overflow-y-auto">
                  {inboundPartSuggestions.map((s) => (
                    <button
                      key={s.part_number}
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 border-t text-[11px]"
                      onClick={() => applyInboundPartSuggestion(s)}
                    >
                      <span className="font-semibold">{s.part_number}</span>
                      {s.description ? ` — ${s.description}` : ''}
                    </button>
                  ))}
                </div>
              ) : null}
              <label className="text-[11px] font-bold">
                Inbound Qty
                <input
                  className="input-field mt-1"
                  type="number"
                  min="0"
                  step="any"
                  value={inboundSingleForm.quantity}
                  onChange={(e) => setInboundSingleForm((f) => ({ ...f, quantity: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Description
                <input
                  className="input-field mt-1"
                  value={inboundSingleForm.description}
                  onChange={(e) => setInboundSingleForm((f) => ({ ...f, description: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                UOM
                <input
                  className="input-field mt-1"
                  value={inboundSingleForm.uom}
                  onChange={(e) => setInboundSingleForm((f) => ({ ...f, uom: e.target.value }))}
                  placeholder="e.g. PCS"
                />
              </label>
              <label className="text-[11px] font-bold">
                SAP Part Number
                <input
                  className="input-field mt-1"
                  value={inboundSingleForm.sap_part_number}
                  onChange={(e) => setInboundSingleForm((f) => ({ ...f, sap_part_number: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                Local PO
                <input
                  className="input-field mt-1"
                  value={inboundSingleForm.lpo}
                  onChange={(e) => setInboundSingleForm((f) => ({ ...f, lpo: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                SAP PO
                <input
                  className="input-field mt-1"
                  value={inboundSingleForm.sap_po}
                  onChange={(e) => setInboundSingleForm((f) => ({ ...f, sap_po: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                SAP Invoice
                <input
                  className="input-field mt-1"
                  value={inboundSingleForm.invoice_no}
                  onChange={(e) => setInboundSingleForm((f) => ({ ...f, invoice_no: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                Received Date
                <input
                  className="input-field mt-1"
                  type="date"
                  value={inboundSingleForm.received_date}
                  onChange={(e) => setInboundSingleForm((f) => ({ ...f, received_date: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Remarks
                <input
                  className="input-field mt-1"
                  value={inboundSingleForm.remarks}
                  onChange={(e) => setInboundSingleForm((f) => ({ ...f, remarks: e.target.value }))}
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className="btn-secondary" onClick={() => setInboundSingleOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={submitInboundSingle}>
                Save Inbound
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {outboundSingleOpen ? (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 dn-no-print">
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[86vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold">Add Outbound — single line</h3>
                <p className="text-[11px] text-gray-600 mt-1">
                  Status Delivered deducts Main Stock when quantity is available.
                </p>
              </div>
              <button type="button" className="btn-secondary" onClick={() => setOutboundSingleOpen(false)}>
                Close
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
              <label className="text-[11px] font-bold">
                Date
                <input
                  className="input-field mt-1"
                  type="date"
                  value={outboundSingleForm.date}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, date: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                Status
                <select
                  className="input-field mt-1"
                  value={outboundSingleForm.status}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, status: e.target.value }))}
                >
                  <option value="Delivered">Delivered</option>
                  <option value="Pending">Pending</option>
                  <option value="Open">Open</option>
                </select>
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Part Number search
                <input
                  className="input-field mt-1"
                  value={outboundPartSearch}
                  onChange={(e) => {
                    setOutboundPartSearch(e.target.value);
                    setOutboundSingleForm((f) => ({ ...f, part_number: e.target.value }));
                  }}
                  placeholder="Type part number — suggestions start with what you type"
                />
              </label>
              {outboundPartSuggestions.length ? (
                <div className="sm:col-span-2 border rounded-md overflow-hidden max-h-40 overflow-y-auto">
                  {outboundPartSuggestions.map((s) => (
                    <button
                      key={s.part_number}
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 border-t text-[11px]"
                      onClick={() => {
                        setOutboundSingleForm((f) => ({
                          ...f,
                          part_number: s.part_number,
                          sap_part_number: s.sap_part_number || '',
                          description: s.description || '',
                        }));
                        setOutboundPartSearch(s.part_number);
                        setOutboundPartSuggestions([]);
                      }}
                    >
                      <span className="font-semibold">{s.part_number}</span>
                      {s.description ? ` — ${s.description}` : ''}
                    </button>
                  ))}
                </div>
              ) : null}
              <label className="text-[11px] font-bold">
                Outbound Qty
                <input
                  className="input-field mt-1"
                  type="number"
                  min="0"
                  step="any"
                  value={outboundSingleForm.outbound_qty}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, outbound_qty: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                SAP Part Number
                <input
                  className="input-field mt-1"
                  value={outboundSingleForm.sap_part_number}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, sap_part_number: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Description
                <input
                  className="input-field mt-1"
                  value={outboundSingleForm.description}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, description: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                PO
                <input
                  className="input-field mt-1"
                  value={outboundSingleForm.po}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, po: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                Customer PO
                <input
                  className="input-field mt-1"
                  value={outboundSingleForm.customer_po}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, customer_po: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                Invoice No
                <input
                  className="input-field mt-1"
                  value={outboundSingleForm.invoice_no}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, invoice_no: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                Customer Name
                <input
                  className="input-field mt-1"
                  value={outboundSingleForm.customer_name}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, customer_name: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Delivery Address
                <input
                  className="input-field mt-1"
                  value={outboundSingleForm.delivery_address}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, delivery_address: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                Delivery
                <input
                  className="input-field mt-1"
                  value={outboundSingleForm.delivery}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, delivery: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                Sales Doc
                <input
                  className="input-field mt-1"
                  value={outboundSingleForm.sales_doc}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, sales_doc: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Remarks
                <input
                  className="input-field mt-1"
                  value={outboundSingleForm.remarks}
                  onChange={(e) => setOutboundSingleForm((f) => ({ ...f, remarks: e.target.value }))}
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className="btn-secondary" onClick={() => setOutboundSingleOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={submitOutboundSingle}>
                Save Outbound
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {bulkOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-xl border border-gray-200">
            <h3 className="text-lg font-bold mb-2">Bulk paste ({bulkMode})</h3>
            <p className="text-[11px] text-gray-600 mb-2">{pasteHint}</p>
            <textarea
              value={bulkData}
              onChange={(e) => setBulkData(e.target.value)}
              className="input-field h-44 font-mono text-[11px] resize-none"
              placeholder="Paste from Excel (tabs) or comma-separated…"
            />
            {bulkPreview.length ? (
              <div className="mt-3 border rounded-lg overflow-hidden">
                <div className="px-3 py-1.5 bg-gray-50 text-[10px] font-bold text-gray-600">Preview</div>
                <pre className="p-2 text-[10px] overflow-auto max-h-36">{JSON.stringify(bulkPreview, null, 2)}</pre>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2 mt-4">
              <button type="button" className="btn-secondary flex items-center gap-1 text-[11px]" onClick={previewBulk}>
                <Eye size={14} />
                Preview
              </button>
              <button type="button" className="btn-primary text-[11px] flex-1" onClick={submitBulk}>
                Import
              </button>
              <button type="button" className="btn-secondary text-[11px]" onClick={() => setBulkOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
