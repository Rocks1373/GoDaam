import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Printer, CheckCircle2, FileSpreadsheet, MessageCircle, ClipboardPaste, Upload, Pencil } from 'lucide-react';
import { buildDeliveryNoteFilenameBase, buildDeliveryNoteFilename, downloadDeliveryNoteExcel } from '../utils/deliveryNoteExport';
import WhatsAppDnDialog from '../components/WhatsAppDnDialog';
import { authApi, carriersApi, customersApi, deliveryNotesApi, documentWorkflowApi, documentFlowApi } from '../services/api';
import { toast } from 'sonner';
import { useLocation, Link } from 'react-router-dom';
import { useWarehouse } from '../context/WarehouseContext';
import DnPodUploadModal, { DnPodDropZone } from '../components/DnPodUploadModal';
import DnDateCalendarPicker from '../components/DnDateCalendarPicker';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';
import { canEditWarehouseData, canDownloadDeliveryNotes, canUploadPod, isViewerRole } from '../utils/userPermissions';
import { formatDateDDMMYYYY } from '../utils/dateDisplay';

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDnDateInput(v) {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return todayIsoDate();
}

function pickQtyDn(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

function isIgnorePackageType(v) {
  return String(v ?? '').trim().toLowerCase() === 'ignore';
}

const DN_PRINT_LS_KEY = 'gapp_dn_print_setup';

function readInitialDnPrintSetup() {
  try {
    const j = JSON.parse(localStorage.getItem(DN_PRINT_LS_KEY) || '{}');
    return {
      marginMm:
        typeof j.marginMm === 'number' && Number.isFinite(j.marginMm)
          ? Math.min(22, Math.max(4, j.marginMm))
          : 10,
      zoomPct:
        typeof j.zoomPct === 'number' && Number.isFinite(j.zoomPct)
          ? Math.min(100, Math.max(72, j.zoomPct))
          : 100,
      compact: typeof j.compact === 'boolean' ? j.compact : false,
    };
  } catch {
    return { marginMm: 10, zoomPct: 100, compact: false };
  }
}

export default function DeliveryNote() {
  const { selectedWarehouseId, isAllWarehouses } = useWarehouse();
  const location = useLocation();
  const [outboundNumber, setOutboundNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [dnId, setDnId] = useState(null);
  const [dn, setDn] = useState(null);
  const [error, setError] = useState('');
  const [showContact2, setShowContact2] = useState(false);
  const [cp2DraftName, setCp2DraftName] = useState('');
  const [cp2DraftPhone, setCp2DraftPhone] = useState('');
  const [showInvoicePrompt, setShowInvoicePrompt] = useState(false);
  /** general = print/load; deliver = before Mark Delivered */
  const [invoicePromptPurpose, setInvoicePromptPurpose] = useState('general');
  const [showPackageEditOnly, setShowPackageEditOnly] = useState(false);
  const [packageEditBusy, setPackageEditBusy] = useState(false);
  const [showInvoiceEditOnly, setShowInvoiceEditOnly] = useState(false);
  const [invoiceEditBusy, setInvoiceEditBusy] = useState(false);
  const [invoiceDraft, setInvoiceDraft] = useState('');
  const [packageTypeDraft, setPackageTypeDraft] = useState('Ignore');
  const [packageQtyDraft, setPackageQtyDraft] = useState('');
  const [grossWeightDraft, setGrossWeightDraft] = useState('');
  const [volumeDraft, setVolumeDraft] = useState('');
  const [downloadActionOpen, setDownloadActionOpen] = useState(false);
  const [exportDocFlowOpen, setExportDocFlowOpen] = useState(false);
  const [exportDocFlowHasFollowUp, setExportDocFlowHasFollowUp] = useState(false);
  const [exportInvoiceNumber, setExportInvoiceNumber] = useState('');
  const [exportAccountingNumber, setExportAccountingNumber] = useState('');
  const [exportInvoiceFile, setExportInvoiceFile] = useState(null);
  const [exportAccountingFile, setExportAccountingFile] = useState(null);
  const [exportAccPasteReady, setExportAccPasteReady] = useState(false);
  const exportAccPasteBlobRef = useRef(null);
  const exportDocFlowOnCompleteRef = useRef(null);
  const invoicePromptAfterRef = useRef(null);
  const [podInitialFile, setPodInitialFile] = useState(null);
  const [exportDocFlowBusy, setExportDocFlowBusy] = useState(false);
  const [exportDocDup, setExportDocDup] = useState(null);
  const [downloadActionMode, setDownloadActionMode] = useState('both'); // default: Drive + download
  const [saveDriveBusy, setSaveDriveBusy] = useState(false);
  const [saveDriveDup, setSaveDriveDup] = useState(null);

  const [showTransportPrompt, setShowTransportPrompt] = useState(false);
  const [carriers, setCarriers] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [transportType, setTransportType] = useState('');
  const [transportCarrierId, setTransportCarrierId] = useState('');
  const [transportCarrierName, setTransportCarrierName] = useState('');
  const [transportDriverId, setTransportDriverId] = useState('');
  const [transportDriverName, setTransportDriverName] = useState('');
  const [transportDriverMobile, setTransportDriverMobile] = useState('');
  const [transportVehicle, setTransportVehicle] = useState('');
  const [truckType, setTruckType] = useState('');
  const [truckQty, setTruckQty] = useState('');
  const [waybillNumber, setWaybillNumber] = useState('');
  const [collectorName, setCollectorName] = useState('');
  const [collectorMobile, setCollectorMobile] = useState('');
  const [transportRemarks, setTransportRemarks] = useState('');
  const [holdRows, setHoldRows] = useState([]);
  const [outboundOptions, setOutboundOptions] = useState([]);
  const [outboundTyped, setOutboundTyped] = useState('');
  const [isHuaweiDnSource, setIsHuaweiDnSource] = useState(false);
  const autoHuaweiPoLoad = useRef(false);
  /** Filter outbound dropdown by combined Sales Doc / SO / GAPP PO (from outbound upload / picked list). */
  const [salesDocFilter, setSalesDocFilter] = useState('');
  const [deliveryToOpen, setDeliveryToOpen] = useState(false);
  const [deliveryToLoading, setDeliveryToLoading] = useState(false);
  const [deliveryToCtx, setDeliveryToCtx] = useState(null);
  const [deliveryToCity, setDeliveryToCity] = useState('');
  const [deliveryToAddrId, setDeliveryToAddrId] = useState('');
  const [deliveryToPanel, setDeliveryToPanel] = useState('main');
  const [me, setMe] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [adminCloseOverride, setAdminCloseOverride] = useState(false);
  const [showAdminCloseDialog, setShowAdminCloseDialog] = useState(false);
  /** A4 print / PDF: sheet margins (mm), content zoom %, compact table (saved in localStorage). */
  const [printPageMarginMm, setPrintPageMarginMm] = useState(() => readInitialDnPrintSetup().marginMm);
  const [printZoomPercent, setPrintZoomPercent] = useState(() => readInitialDnPrintSetup().zoomPct);
  const [printCompactTable, setPrintCompactTable] = useState(() => readInitialDnPrintSetup().compact);
  const [whatsappDialogOpen, setWhatsappDialogOpen] = useState(false);
  const [podUploadOpen, setPodUploadOpen] = useState(false);
  /** Mobile / narrow: switch between control panel and live preview */
  const [mobilePanel, setMobilePanel] = useState('controls');
  /** Delivery note date (YYYY-MM-DD); defaults to today, synced from loaded DN */
  const [dnDateDraft, setDnDateDraft] = useState(todayIsoDate);
  const [dnDateSaving, setDnDateSaving] = useState(false);

  const [addAddrForm, setAddAddrForm] = useState({
    city_name: '',
    address: '',
    gps: '',
    contact_person: '',
    contact_number: '',
    email_1: '',
    designation_job: '',
    second_name: '',
    second_number: '',
    second_email: '',
    designation_job_title_2: '',
    remarks: '',
    address_type: 'permanent',
  });

  const trim = (v) => String(v ?? '').trim();

  const checkedByDisplayName = useMemo(() => {
    const n = trim(me?.full_name) || trim(me?.username);
    return n || '—';
  }, [me]);

  useEffect(() => {
    (async () => {
      try {
        const r = await authApi.me();
        setMe(r.user);
      } catch {
        setMe(null);
      }
    })();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        DN_PRINT_LS_KEY,
        JSON.stringify({
          marginMm: printPageMarginMm,
          zoomPct: printZoomPercent,
          compact: printCompactTable,
        })
      );
    } catch {
      /* ignore */
    }
  }, [printPageMarginMm, printZoomPercent, printCompactTable]);

  const fmtDt = (v) => {
    if (!v) return '—';
    try {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return String(v);
      return d.toLocaleString();
    } catch {
      return String(v);
    }
  };

  const refreshTimeline = async (id) => {
    if (!id) {
      setTimeline(null);
      return;
    }
    try {
      const t = await deliveryNotesApi.getTimeline(id);
      setTimeline(t);
    } catch {
      setTimeline(null);
    }
  };

  const refreshDnOnly = async (id = dnId, options = {}) => {
    const silent = Boolean(options.silent);
    if (!id) return;
    try {
      const data = await deliveryNotesApi.get(id);
      setDn(data);
      await refreshTimeline(id);
    } catch (e) {
      if (!silent) alert(e?.response?.data?.error || e.message);
      throw e;
    }
  };

  useEffect(() => {
    if (!dn) return;
    const has2 = Boolean(trim(dn.contact_person_2) || trim(dn.contact_number_2));
    if (has2) setShowContact2(true);
    setCp2DraftName(trim(dn.contact_person_2));
    setCp2DraftPhone(trim(dn.contact_number_2));
    setDnDateDraft(normalizeDnDateInput(dn.dn_date));
  }, [dn]);

  const filteredDeliveryAddresses = useMemo(() => {
    const list = deliveryToCtx?.addresses || [];
    if (!deliveryToCity) return list;
    return list.filter((a) => trim(a.city_name) === deliveryToCity);
  }, [deliveryToCtx, deliveryToCity]);

  const selectedAddrRow = useMemo(() => {
    if (!deliveryToAddrId) return null;
    return (deliveryToCtx?.addresses || []).find((a) => String(a.id) === String(deliveryToAddrId));
  }, [deliveryToCtx, deliveryToAddrId]);

  useEffect(() => {
    if (!deliveryToCtx?.addresses?.length) return;
    const list = !deliveryToCity
      ? deliveryToCtx.addresses
      : deliveryToCtx.addresses.filter((a) => String(a.city_name ?? '').trim() === deliveryToCity);
    if (list.length === 1) setDeliveryToAddrId(String(list[0].id));
    else if (deliveryToAddrId && !list.some((a) => String(a.id) === String(deliveryToAddrId))) setDeliveryToAddrId('');
  }, [deliveryToCity, deliveryToCtx, deliveryToAddrId]);

  const effectiveInvoice = useMemo(
    () => trim(dn?.invoice_number) || trim(dn?.outbound_invoice_number),
    [dn?.invoice_number, dn?.outbound_invoice_number]
  );
  const hasInvoice = Boolean(effectiveInvoice);
  const hasPackageType = Boolean(String(dn?.package_type || '').trim());
  const hasTransportation = Boolean(String(dn?.transportation_type || '').trim());

  const isGapp = String(dn?.transportation_type || '').trim().toLowerCase() === 'gapp';
  const isAdmin = String(me?.role || '').toLowerCase() === 'admin';
  const role = String(me?.role || '').toLowerCase();
  const canUploadOutbound =
    isAdmin ||
    role === 'manager' ||
    role === 'checker' ||
    Boolean(me?.permissions?.can_upload_outbound) ||
    Boolean(me?.permissions?.can_confirm_picked);
  const canEditDn = canEditWarehouseData(me);
  const canUploadPodDn = canUploadPod(me);
  const canDownloadDn = canDownloadDeliveryNotes(me);
  const readOnlyViewer = isViewerRole(me) || (canDownloadDn && !canEditDn);
  const dnLocked = String(dn?.status || '').toLowerCase() === 'delivered';
  const canChangeDnDate = !readOnlyViewer && !dnLocked;

  const packageValidForConfirm = useMemo(() => {
    if (!dn) return false;
    if (!trim(dn.invoice_number) && !trim(dn.outbound_invoice_number)) return false;
    const pt = String(dn.package_type || '').trim().toLowerCase();
    if (!pt) return false;
    if (pt === 'ignore') return true;
    if (pt === 'pallet' && !(Number(dn.pallet_qty) > 0)) return false;
    if (pt === 'box' && !(Number(dn.box_qty) > 0)) return false;
    if (!(Number(dn.gross_weight_kg) > 0)) return false;
    if (!(Number(dn.volume_cbm) > 0)) return false;
    return true;
  }, [dn]);

  const gappTransportComplete = useMemo(() => {
    if (!dn || !isGapp) return true;
    const hasDriver = Boolean(String(dn.driver_name || '').trim()) || Boolean(dn.driver_id);
    const hasPhone = Boolean(String(dn.driver_mobile || '').trim());
    const hasVeh = Boolean(String(dn.vehicle || '').trim());
    return hasDriver && hasPhone && hasVeh;
  }, [dn, isGapp]);

  const gappCanConfirm = useMemo(() => {
    if (!dn || !isGapp || dnLocked) return false;
    if (dn.confirmed_at) return false;
    const addrOk = Boolean(String(dn.delivery_address || '').trim());
    return addrOk && packageValidForConfirm && gappTransportComplete;
  }, [dn, isGapp, dnLocked, packageValidForConfirm, gappTransportComplete]);

  const gappMissingConfirmReasons = useMemo(() => {
    if (!dn || !isGapp) return [];
    const reasons = [];
    if (dnLocked) reasons.push('Delivery note is already delivered');
    if (dn.confirmed_at) reasons.push('Already confirmed');
    if (!String(dn.delivery_address || '').trim()) reasons.push('Delivery To / delivery address is missing');
    if (!packageValidForConfirm) reasons.push('Invoice number is required (package qty/weight/volume only for Pallet/Box)');
    if (!gappTransportComplete) reasons.push('GAPP driver / phone / vehicle is incomplete');
    return reasons;
  }, [dn, isGapp, dnLocked, packageValidForConfirm, gappTransportComplete]);

  const dnNeedsPackagePrompt = useCallback((row) => {
    if (!row) return false;
    if (String(row.status || '').toLowerCase() === 'delivered') return false;
    const inv = trim(row.invoice_number) || trim(row.outbound_invoice_number);
    if (!inv) return true;
    const pt = String(row.package_type || '').trim().toLowerCase();
    if (pt === 'ignore') return false;
    if (!pt) return true;
    if (pt === 'pallet' && !(Number(row.pallet_qty) > 0)) return true;
    if (pt === 'box' && !(Number(row.box_qty) > 0)) return true;
    if (!(Number(row.gross_weight_kg) > 0)) return true;
    if (!(Number(row.volume_cbm) > 0)) return true;
    return false;
  }, []);

  const populatePackageDraftsFromDn = useCallback((row) => {
    const inv = trim(row?.invoice_number) || trim(row?.outbound_invoice_number);
    setInvoiceDraft(inv);
    const pt = String(row?.package_type || '').trim();
    const ptLower = pt.toLowerCase();
    setPackageTypeDraft(pt || 'Pallet');
    const qty = ptLower === 'pallet' ? row?.pallet_qty : ptLower === 'box' ? row?.box_qty : '';
    setPackageQtyDraft(qty != null && qty !== '' && Number(qty) > 0 ? String(qty) : '');
    setGrossWeightDraft(
      ptLower === 'ignore'
        ? ''
        : row?.gross_weight_kg != null && row?.gross_weight_kg !== '' && Number(row.gross_weight_kg) > 0
          ? String(row.gross_weight_kg)
          : ''
    );
    setVolumeDraft(
      ptLower === 'ignore'
        ? ''
        : row?.volume_cbm != null && row?.volume_cbm !== '' && Number(row.volume_cbm) > 0
          ? String(row.volume_cbm)
          : ''
    );
  }, []);

  const openPackagePrompt = useCallback(
    (after, purpose = 'general') => {
      if (dn) populatePackageDraftsFromDn(dn);
      invoicePromptAfterRef.current = typeof after === 'function' ? after : null;
      setInvoicePromptPurpose(purpose);
      setShowInvoicePrompt(true);
    },
    [dn, populatePackageDraftsFromDn]
  );

  const openPackageEditOnly = useCallback(() => {
    if (!dn) return;
    populatePackageDraftsFromDn(dn);
    setShowPackageEditOnly(true);
  }, [dn, populatePackageDraftsFromDn]);

  const validatePackageDraftFields = () => {
    if (!isIgnorePackageType(packageTypeDraft) && !(Number(packageQtyDraft) > 0)) {
      return 'Package quantity is required for Pallet or Box.';
    }
    if (!isIgnorePackageType(packageTypeDraft) && !(Number(grossWeightDraft) > 0)) {
      return 'Gross weight (kg) is required.';
    }
    if (!isIgnorePackageType(packageTypeDraft) && !(Number(volumeDraft) > 0)) {
      return 'Volume (CBM) is required.';
    }
    return null;
  };

  const buildPackageSavePayload = (invoiceNumber) => {
    const isIgnore = isIgnorePackageType(packageTypeDraft);
    const payload = {
      invoice_number: invoiceNumber,
      package_type: isIgnore ? 'Ignore' : packageTypeDraft,
      package_qty: isIgnore ? 0 : packageQtyDraft === '' ? 0 : Number(packageQtyDraft),
    };
    if (!isIgnore) {
      payload.gross_weight_kg = grossWeightDraft === '' ? 0 : Number(grossWeightDraft);
      payload.volume_cbm = volumeDraft === '' ? 0 : Number(volumeDraft);
    }
    return payload;
  };

  const load = async (obOverride) => {
    const ob =
      typeof obOverride === 'string'
        ? obOverride.trim()
        : String(outboundNumber || outboundTyped || '').trim();
    if (!ob) {
      setError(isHuaweiDnSource ? 'Enter Huawei SAP PO first.' : 'Enter or select an outbound number first.');
      return;
    }
    if (ob !== outboundNumber) setOutboundNumber(ob);
    if (ob !== outboundTyped) setOutboundTyped(ob);
    setError('');
    setLoading(true);
    try {
      const commonPayload = {
        dn_date: dnDateDraft,
        ...(selectedWarehouseId != null && selectedWarehouseId !== ''
          ? { warehouse_id: selectedWarehouseId }
          : {}),
      };
      const created = isHuaweiDnSource
        ? await deliveryNotesApi.createFromHuaweiPo(ob, { ...commonPayload, rebuild: true })
        : await deliveryNotesApi.createFromOutbound(ob, commonPayload);
      const id = created?.id;
      setDnId(id);
      let full = await deliveryNotesApi.get(id);
      if (
        canChangeDnDate &&
        normalizeDnDateInput(full?.dn_date) !== normalizeDnDateInput(dnDateDraft)
      ) {
        full = await deliveryNotesApi.saveDnDate(id, { dn_date: dnDateDraft });
      }
      setDn(full);
      await refreshTimeline(id);

      if (!String(full?.transportation_type || '').trim()) {
        setShowTransportPrompt(false);
      }
    } catch (e) {
      setDn(null);
      setError(e?.response?.data?.error || e.message);
      setShowInvoicePrompt(false);
    } finally {
      setLoading(false);
    }
  };

  const saveInvoiceFromModal = async () => {
    if (!dnId) return;
    if (dn && String(dn.status || '').toLowerCase() === 'delivered') {
      alert('This delivery note is already delivered — no further edits.');
      return;
    }
    if (!invoiceDraft.trim()) {
      alert('Invoice number is required.');
      return;
    }
    const pkgErr = validatePackageDraftFields();
    if (pkgErr) {
      alert(pkgErr);
      return;
    }
    try {
      await deliveryNotesApi.savePackageInfo(dnId, buildPackageSavePayload(invoiceDraft.trim()));
      setShowInvoicePrompt(false);
      setInvoicePromptPurpose('general');
      const data = await deliveryNotesApi.get(dnId);
      setDn(data);
      const after = invoicePromptAfterRef.current;
      invoicePromptAfterRef.current = null;
      if (after) {
        try {
          await after();
        } catch (e) {
          toast.error(formatMarkDeliveredError(e));
        }
      }
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const openInvoiceEditOnly = useCallback(() => {
    if (!dn) return;
    setInvoiceDraft(trim(dn.invoice_number) || trim(dn.outbound_invoice_number));
    setShowInvoiceEditOnly(true);
  }, [dn]);

  const saveInvoiceOnly = async () => {
    if (!dnId) return;
    if (dn && String(dn.status || '').toLowerCase() === 'delivered') {
      alert('This delivery note is already delivered — no further edits.');
      return;
    }
    if (!invoiceDraft.trim()) {
      alert('Invoice number is required.');
      return;
    }
    setInvoiceEditBusy(true);
    try {
      const data = await deliveryNotesApi.saveInvoice(dnId, invoiceDraft.trim());
      setDn(data);
      setShowInvoiceEditOnly(false);
      toast.success('Invoice number updated');
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setInvoiceEditBusy(false);
    }
  };

  const savePackageEditOnly = async () => {
    if (!dnId) return;
    if (dn && String(dn.status || '').toLowerCase() === 'delivered') {
      alert('This delivery note is already delivered — no further edits.');
      return;
    }
    const inv = invoiceDraft.trim() || effectiveInvoice;
    if (!inv) {
      alert('Invoice number is required. Use Edit invoice number first.');
      return;
    }
    const pkgErr = validatePackageDraftFields();
    if (pkgErr) {
      alert(pkgErr);
      return;
    }
    setPackageEditBusy(true);
    try {
      await deliveryNotesApi.savePackageInfo(dnId, buildPackageSavePayload(inv));
      const data = await deliveryNotesApi.get(dnId);
      setDn(data);
      setShowPackageEditOnly(false);
      toast.success('Packaging updated');
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally {
      setPackageEditBusy(false);
    }
  };

  const formatMarkDeliveredError = (e) => {
    const data = e?.response?.data;
    const shortages = data?.shortages;
    let msg = data?.error || e.message || 'Mark Delivered failed.';
    if (Array.isArray(shortages) && shortages.length) {
      const lines = shortages.map(
        (s) =>
          `${s.part_number}: need ${s.required_qty}, available ${s.available_qty} (short ${s.shortage_qty})`
      );
      msg = `${msg}\n\n${lines.join('\n')}`;
    }
    if (data?.code === 'MAIN_STOCK_PART_MISSING' && data?.part_number) {
      msg = `${msg}\n\nAdd or align part ${data.part_number} in Main Stock before retrying.`;
    }
    return msg;
  };

  const runMarkDelivered = async () => {
    const result = await deliveryNotesApi.markDelivered(dnId);
    try {
      await refreshDnOnly(dnId, { silent: true });
    } catch {
      try {
        const data = await deliveryNotesApi.get(dnId);
        setDn(data);
        await refreshTimeline(dnId);
      } catch {
        /* ignore — mark-delivered already succeeded */
      }
    }
    toast.success(
      result?.outbound_stock_already_finalized
        ? 'Order processed. Stock was already finalized for this outbound.'
        : 'Order processed successfully.'
    );
  };

  const deliver = async () => {
    try {
      if (!dnId || !dn) {
        toast.error('Load a delivery note first.');
        return;
      }
      if (dnLocked && String(dn?.status || '').toLowerCase() === 'delivered') {
        toast.error('This delivery note is already marked as Delivered.');
        return;
      }
      if (!hasTransportation) {
        toast.error('Transportation Method must be saved before Delivered.');
        setShowTransportPrompt(true);
        return;
      }
      if (dnNeedsPackagePrompt(dn)) {
        openPackagePrompt(() => runMarkDelivered(), 'deliver');
        return;
      }
      await runMarkDelivered();
    } catch (e) {
      toast.error(formatMarkDeliveredError(e));
    }
  };

  const handleConfirmForDelivery = async () => {
    if (!dnId) return;
    if (!gappCanConfirm) {
      const reasons = gappMissingConfirmReasons;
      const msg =
        reasons && reasons.length
          ? `Cannot confirm for delivery:\n- ${reasons.join('\n- ')}`
          : 'Cannot confirm for delivery. Please complete required fields first.';
      alert(msg);
      return;
    }
    try {
      const data = await deliveryNotesApi.confirmForDelivery(dnId);
      setDn(data);
      await refreshTimeline(dnId);
      alert('Confirmed for delivery. Driver has been notified.');
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const handleViewPod = async () => {
    if (!dnId) return;
    try {
      const blob = await deliveryNotesApi.downloadPod(dnId);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const runAdminClose = async () => {
    if (!dnId) return;
    const hasPod = Boolean(String(dn?.pod_file_path || '').trim());
    if (!hasPod && !adminCloseOverride) {
      alert('Add POD on the task or check Admin override.');
      return;
    }
    try {
      const data = await deliveryNotesApi.closeAdmin(dnId, { admin_override: adminCloseOverride && !hasPod });
      setDn(data);
      await refreshTimeline(dnId);
      setShowAdminCloseDialog(false);
      setAdminCloseOverride(false);
      alert('Order closed and locked.');
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const refreshHold = async () => {
    try {
      const data = await deliveryNotesApi.list({ status: 'On Hold', limit: 200 });
      setHoldRows(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
      setHoldRows([]);
    }
  };

  const refreshOutboundOptions = async () => {
    try {
      const data = await deliveryNotesApi.outboundOptions();
      setOutboundOptions(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error(e);
      setOutboundOptions([]);
    }
  };

  const toggleHold = async () => {
    if (!dnId) return;
    try {
      const isHoldNow = String(dn?.status || '').toLowerCase() === 'on hold';
      const updated = await deliveryNotesApi.setHold(dnId, !isHoldNow);
      setDn(updated);
      await refreshHold();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const refreshCarriers = async () => {
    try {
      const list = await carriersApi.list();
      setCarriers(list || []);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    refreshCarriers();
    refreshHold();
    refreshOutboundOptions();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const po = params.get('po')?.trim();
    const huawei =
      params.get('huawei') === '1' ||
      String(params.get('source') || '').toLowerCase() === 'huawei';
    if (!po) return;
    if (huawei) setIsHuaweiDnSource(true);
    setOutboundTyped(po);
    setOutboundNumber(po);
    if (huawei && !autoHuaweiPoLoad.current) {
      autoHuaweiPoLoad.current = true;
      void load(po);
    }
  }, [location.search]);

  // Auto-load when navigated from Picked Orders "Create DN"
  useEffect(() => {
    const sp = new URLSearchParams(location.search || '');
    const ob = String(sp.get('outbound') || '').trim();
    if (!ob) return;
    setSalesDocFilter('');
    setOutboundNumber(ob);
    setOutboundTyped(ob);
    void load(ob);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const trimStr = (v) => String(v ?? '').trim();

  const salesDocChoices = useMemo(() => {
    const s = new Set();
    for (const o of outboundOptions) {
      const v = trimStr(o?.sales_doc);
      if (v) s.add(v);
    }
    return [...s].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  }, [outboundOptions]);

  const outboundFiltered = useMemo(() => {
    const f = trimStr(salesDocFilter);
    if (!f) return outboundOptions;
    return outboundOptions.filter((o) => trimStr(o?.sales_doc) === f);
  }, [outboundOptions, salesDocFilter]);

  /** Load drivers: for GAPP with no carrier selected, merge all GAPP carriers' drivers (default "GAPP" option has empty id). */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (String(transportType || '').toLowerCase() === 'gapp') {
          if (transportCarrierId) {
            const rows = await carriersApi.listDrivers(Number(transportCarrierId));
            if (!cancelled) setDrivers(rows || []);
            return;
          }
          const gappIds = (carriers || [])
            .filter((c) => String(c.carrier_type || '').toLowerCase() === 'gapp')
            .map((c) => c.id);
          if (!gappIds.length) {
            if (!cancelled) setDrivers([]);
            return;
          }
          const parts = await Promise.all(
            gappIds.map((id) => carriersApi.listDrivers(id).catch(() => []))
          );
          if (!cancelled) setDrivers(parts.flat());
          return;
        }
        if (!transportCarrierId) {
          if (!cancelled) setDrivers([]);
          return;
        }
        const rows = await carriersApi.listDrivers(Number(transportCarrierId));
        if (!cancelled) setDrivers(rows || []);
      } catch {
        if (!cancelled) setDrivers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transportCarrierId, carriers, transportType]);

  const openTransport = () => {
    if (!dn) return;
    setTransportType(dn.transportation_type || '');
    setTransportCarrierId(dn.carrier_id != null ? String(dn.carrier_id) : '');
    setTransportCarrierName(dn.carrier_name || '');
    setTransportDriverId(dn.driver_id != null ? String(dn.driver_id) : '');
    setTransportDriverName(dn.driver_name || '');
    setTransportDriverMobile(dn.driver_mobile || '');
    setTransportVehicle(dn.vehicle || '');
    setTruckType(dn.truck_type || '');
    setTruckQty(dn.truck_qty != null ? String(dn.truck_qty) : '');
    setWaybillNumber(dn.waybill_number || '');
    setCollectorName(dn.collector_name || '');
    setCollectorMobile(dn.collector_mobile || '');
    setTransportRemarks(dn.transportation_remarks || '');
    setShowTransportPrompt(true);
  };

  const openDeliveryTo = async () => {
    if (!dnId) return;
    setDeliveryToOpen(true);
    setDeliveryToLoading(true);
    setDeliveryToPanel('main');
    setDeliveryToCity('');
    setDeliveryToAddrId('');
    setAddAddrForm({
      city_name: '',
      address: '',
      gps: '',
      contact_person: '',
      contact_number: '',
      email_1: '',
      designation_job: '',
      second_name: '',
      second_number: '',
      second_email: '',
      designation_job_title_2: '',
      remarks: '',
      address_type: 'permanent',
    });
    try {
      const data = await deliveryNotesApi.getDeliveryTo(dnId);
      setDeliveryToCtx(data);
      const addrs = data.addresses || [];
      const cities = data.cities || [];
      if (addrs.length === 1) {
        const a = addrs[0];
        setDeliveryToCity(trim(a.city_name));
        setDeliveryToAddrId(String(a.id));
      } else if (cities.length === 1) {
        const cty = cities[0];
        setDeliveryToCity(cty);
        const inCity = addrs.filter((x) => trim(x.city_name) === cty);
        if (inCity.length === 1) setDeliveryToAddrId(String(inCity[0].id));
      }
    } catch (e) {
      console.error(e);
      alert(e?.response?.data?.error || e.message);
      setDeliveryToCtx(null);
    } finally {
      setDeliveryToLoading(false);
    }
  };

  const saveTransport = async () => {
    if (!dnId) return;
    try {
      await deliveryNotesApi.saveTransportation(dnId, {
        transportation_type: transportType,
        carrier_id: transportCarrierId ? Number(transportCarrierId) : null,
        carrier_name: transportCarrierName,
        driver_id: transportDriverId ? Number(transportDriverId) : null,
        driver_name: transportDriverName,
        driver_mobile: transportDriverMobile,
        vehicle: transportVehicle,
        truck_type: truckType,
        truck_qty: truckQty === '' ? 0 : Number(truckQty),
        waybill_number: waybillNumber,
        collector_name: collectorName,
        collector_mobile: collectorMobile,
        transportation_remarks: transportRemarks,
      });
      const data = await deliveryNotesApi.get(dnId);
      setDn(data);
      setShowTransportPrompt(false);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const transportRenderLines = useMemo(() => {
    if (!dn?.transportation_type) return [];
    const t = String(dn.transportation_type || '');
    const lines = [];

    if (t === 'GAPP') {
      lines.push({ k: 'Delivered by:', v: '' });
      if (dn.carrier_name) lines.push({ k: 'Carrier:', v: dn.carrier_name });
      if (dn.driver_name) lines.push({ k: 'Driver Name:', v: dn.driver_name });
      if (dn.driver_mobile) lines.push({ k: 'Mobile:', v: dn.driver_mobile });
      if (dn.vehicle) lines.push({ k: 'Vehicle:', v: dn.vehicle });
      return lines;
    }
    if (t === 'Rental') {
      lines.push({ k: 'Delivered by:', v: '' });
      if (dn.carrier_name) lines.push({ k: 'Carrier:', v: dn.carrier_name });
      lines.push({ k: 'Type:', v: 'Rental' });
      if (dn.truck_type) lines.push({ k: 'Truck Type:', v: dn.truck_type });
      if (dn.truck_qty) lines.push({ k: 'No. of Trucks:', v: String(dn.truck_qty) });
      if (dn.driver_name) lines.push({ k: 'Driver Name:', v: dn.driver_name });
      if (dn.driver_mobile) lines.push({ k: 'Mobile:', v: dn.driver_mobile });
      return lines;
    }
    if (t === 'Courier') {
      lines.push({ k: 'Courier:', v: '' });
      if (dn.carrier_name) lines.push({ k: 'Company:', v: dn.carrier_name });
      if (dn.waybill_number) lines.push({ k: 'Waybill Number:', v: dn.waybill_number });
      return lines;
    }
    if (t === 'Self Collection') {
      lines.push({ k: 'Delivery Method:', v: 'Self Collection' });
      if (dn.collector_name) lines.push({ k: 'Collector Name:', v: dn.collector_name });
      if (dn.collector_mobile) lines.push({ k: 'Collector Mobile:', v: dn.collector_mobile });
      return lines;
    }
    return [];
  }, [dn]);

  const applyDnDate = async (ymd) => {
    if (!ymd) return;
    setDnDateDraft(ymd);
    if (!dnId || !canChangeDnDate) return;
    setDnDateSaving(true);
    try {
      const data = await deliveryNotesApi.saveDnDate(dnId, { dn_date: ymd });
      setDn(data);
    } catch (err) {
      toast.error(err?.response?.data?.error || err.message || 'Could not save delivery note date');
      setDnDateDraft(normalizeDnDateInput(dn?.dn_date));
    } finally {
      setDnDateSaving(false);
    }
  };

  // Sample fallback (so layout comparison works even before loading)
  const view = useMemo(() => {
    if (dn) return { ...dn, dn_date: dnDateDraft };
    return {
    dn_date: dnDateDraft,
    gapp_po: '15011096',
    customer_po: 'PO-000451-1',
    outbound_number: '80019214',
    invoice_number: '90017264',
    customer_name: 'Global Arabian for Modern applications-GAMA',
    delivery_address: 'PR2+HR4 An Nakheel, Riyadh',
    gps: 'https://maps.app.goo.gl/fflaoRey96KLU8Fgm8',
    contact_person: 'Ahmed Mohamed        +966 59 144 4953',
    contact_number: '',
    items: [
      {
        part_number: 'ER8202',
        description: 'EASY RACK 800 MM/42U /1000MM with Roof Side panelcastersfeet and 4 Brackets No Bottom black',
        qty: 6,
        uom: 'PCS',
        serial_no: '-',
        condition_text: 'New',
      },
    ],
    package_type: 'Ignore',
    pallet_qty: 0,
    box_qty: 0,
    gross_weight_kg: 0,
    volume_cbm: 0,
    };
  }, [dn, dnDateDraft]);

  const openCustomerWhatsAppDialog = useCallback(() => {
    if (!dnId || !dn) {
      toast.error('Load a delivery note first.');
      return;
    }
    const phoneRaw = trim(dn.contact_number);
    if (!phoneRaw || phoneRaw.replace(/\D/g, '').length < 8) {
      toast.error(
        'Contact person 1 mobile is missing or too short. Set it on the DN (Delivery To / contact line), with country code (e.g. 9665… or 91…).'
      );
      return;
    }
    setWhatsappDialogOpen(true);
  }, [dnId, dn]);

  const invoiceForPrint = trim(view?.invoice_number) || trim(view?.outbound_invoice_number) || '';

  const isHuaweiDn = useMemo(() => {
    if (Number(dn?.is_huawei_source) === 1) return true;
    if (isHuaweiDnSource && dn) return true;
    const ref = trim(dn?.dn_number || '');
    return ref.toUpperCase().startsWith('HW-PO-');
  }, [dn, isHuaweiDnSource]);

  /** Only real line items (no blank filler rows); footer total = sum of qty. */
  const lineItems = useMemo(() => (view?.items || []).filter((it) => it != null), [view?.items]);

  const dnItemSortValue = useCallback((it, k) => {
    if (k === 'qty') return Number(it?.qty) || 0;
    if (k === 'part_number') return String(it?.part_number || '');
    if (k === 'description') return String(it?.description || '');
    if (k === 'uom') return String(it?.uom || '');
    if (k === 'serial_no') return String(it?.serial_no || '');
    if (k === 'box_name') return String(it?.box_name || '');
    if (k === 'condition') return String(it?.condition_text || it?.condition || '');
    return it?.[k];
  }, []);

  const {
    displayRows: displayItems,
    sortKey: dnItemSortKey,
    direction: dnItemDir,
    requestSort: dnItemRequestSort,
  } = useTableSort(lineItems, dnItemSortValue);

  const totalDnQty = lineItems.reduce((sum, it) => sum + (Number(it?.qty) || 0), 0);

  const packageText = useMemo(() => {
    const pt = String(view?.package_type || '').toLowerCase();
    if (pt === 'ignore') return '';
    if (pt === 'pallet') {
      const q = Number(view?.pallet_qty) || 0;
      return q > 0 ? `${q} PALLETS` : '';
    }
    if (pt === 'box') {
      const q = Number(view?.box_qty) || 0;
      return q > 0 ? `${q} BOXES` : '';
    }
    return '';
  }, [view?.package_type, view?.pallet_qty, view?.box_qty]);

  const packageWeightDisplay = useMemo(() => {
    if (String(view?.package_type || '').toLowerCase() === 'ignore') return '—';
    const w = Number(view?.gross_weight_kg);
    return Number.isFinite(w) && w > 0 ? w.toFixed(2) : '—';
  }, [view?.package_type, view?.gross_weight_kg]);

  const packageVolumeDisplay = useMemo(() => {
    if (String(view?.package_type || '').toLowerCase() === 'ignore') return '—';
    const v = Number(view?.volume_cbm);
    return Number.isFinite(v) && v > 0 ? v.toFixed(2) : '—';
  }, [view?.package_type, view?.volume_cbm]);

  const dnPrintDynamicCss = useMemo(() => {
    const m = Math.min(22, Math.max(4, Number(printPageMarginMm) || 10));
    const z = Math.min(1, Math.max(0.72, (Number(printZoomPercent) || 100) / 100));
    const zoomLine = z < 0.999 ? `zoom: ${z};` : '';
    const compactBlock = printCompactTable
      ? `
      .dn-print-compact .dn-grid { font-size: 9px !important; }
      .dn-print-compact .dn-grid th,
      .dn-print-compact .dn-grid td { padding: 2px 4px !important; }
      .dn-print-compact .dn-row { height: 22px !important; }
      .dn-print-compact .dn-company-name { font-size: 15px !important; }
      .dn-print-compact .dn-title { font-size: 20px !important; }
    `
      : '';
    return `
@page { size: A4; margin: ${m}mm; }
@media print {
  .dn-page-scaled { ${zoomLine} }
  .dn-page-counter {
    display: block;
    position: fixed;
    bottom: 4mm;
    right: ${m}mm;
    font-size: 9px;
    font-weight: 600;
    color: #000;
    z-index: 9999;
    pointer-events: none;
  }
  .dn-page-counter::after {
    content: counter(page) " of " counter(pages);
  }
  ${compactBlock}
}
`;
  }, [printPageMarginMm, printZoomPercent, printCompactTable]);

  const resetDnPrintSheetLayout = useCallback(() => {
    const scaled = document.querySelector('.dn-wrap .dn-page-scaled');
    if (scaled) scaled.style.minHeight = '';
  }, []);

  const layoutDnPrintSheet = useCallback(() => {
    const main = document.querySelector('.dn-wrap .dn-page-main');
    const counter = document.querySelector('.dn-wrap .dn-page-counter');
    if (!main || !counter) return;
    const m = Math.min(22, Math.max(4, Number(printPageMarginMm) || 10));
    const z = Math.min(1, Math.max(0.72, (Number(printZoomPercent) || 100) / 100));
    const printablePx = Math.max(1, (297 - 2 * m) * (96 / 25.4) * z);
    const totalPages = Math.max(1, Math.ceil(main.scrollHeight / printablePx));
    counter.dataset.dnPageTotal = String(totalPages);
    counter.setAttribute('data-dn-page-preview', `~${totalPages} page${totalPages === 1 ? '' : 's'} on print`);
  }, [printPageMarginMm, printZoomPercent]);

  const estimateDnPrintPages = layoutDnPrintSheet;

  useEffect(() => {
    const t = window.setTimeout(() => estimateDnPrintPages(), 80);
    return () => window.clearTimeout(t);
  }, [view, displayItems.length, printPageMarginMm, printZoomPercent, printCompactTable, estimateDnPrintPages]);

  useEffect(() => {
    const onBeforePrint = () => layoutDnPrintSheet();
    const onAfterPrint = () => resetDnPrintSheetLayout();
    window.addEventListener('beforeprint', onBeforePrint);
    window.addEventListener('afterprint', onAfterPrint);
    return () => {
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('afterprint', onAfterPrint);
    };
  }, [layoutDnPrintSheet, resetDnPrintSheetLayout]);

  const executePrintA4 = () => {
    const prevTitle = document.title;
    const base = buildDeliveryNoteFilenameBase(view);
    document.title = base || 'Delivery-Note';
    const restore = () => {
      document.title = prevTitle;
    };
    window.addEventListener('afterprint', restore, { once: true });
    layoutDnPrintSheet();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.print());
    });
    setTimeout(restore, 4000);
  };

  const needsExportDocFlowBeforePdf = () =>
    canEditDn && Boolean(trim(dn?.outbound_number)) && Boolean(selectedWarehouseId) && !isAllWarehouses;

  const handlePrintA4 = () => {
    if (!dn) return;
    const go = () => executePrintA4();
    if (canEditDn && dnNeedsPackagePrompt(dn)) {
      openPackagePrompt(go, 'general');
      return;
    }
    go();
  };

  const handleExportExcel = () => {
    if (!dn) return;
    try {
      downloadDeliveryNoteExcel({
        view,
        displayItems,
        packageText,
        transportRenderLines,
        checkedByDisplayName,
      });
    } catch (e) {
      alert(e?.message || 'Export failed');
    }
  };

  const dnDrivePreviewName = useMemo(() => {
    if (!dn) return '';
    const ob = trim(dn.outbound_number);
    const dnNum = trim(dn.dn_number) || String(dn.id);
    return ob && dnNum ? `DN_${ob}_${dnNum}.pdf` : buildDeliveryNoteFilenameBase(view) + '.pdf';
  }, [dn, view]);

  const runSaveDnToDrive = async (duplicate_action) => {
    if (!dnId) return;
    setSaveDriveBusy(true);
    try {
      const res = await documentWorkflowApi.saveDnPdf({
        delivery_note_id: dnId,
        duplicate_action: duplicate_action || undefined,
      });
      if (res.conflict) {
        setSaveDriveDup(res.existing);
        return;
      }
      toast.success('Delivery note PDF saved to Google Drive');
      setSaveDriveDup(null);
      return true;
    } catch (e) {
      if (e.response?.status === 409 && e.response?.data?.conflict) {
        setSaveDriveDup(e.response.data.existing);
        return false;
      }
      toast.error(e.response?.data?.error || e.message || 'Save to Drive failed');
      return false;
    } finally {
      setSaveDriveBusy(false);
    }
  };

  const runDownloadSaveAction = async (duplicate_action) => {
    if (!dn) return;
    const mode = canEditDn ? downloadActionMode : 'download';
    if (canEditDn && (mode === 'drive' || mode === 'both')) {
      const ok = await runSaveDnToDrive(duplicate_action);
      if (!ok) return;
    }
    if (mode === 'download' || mode === 'both') {
      executePrintA4();
    }
    setDownloadActionOpen(false);
    setSaveDriveDup(null);
  };

  const handleDownloadSaveContinue = () => {
    if (!dn) return;
    setDownloadActionOpen(false);
    setSaveDriveDup(null);

    const proceedToSave = () => void runDownloadSaveAction();

    if (canEditDn && dnNeedsPackagePrompt(dn)) {
      openPackagePrompt(proceedToSave, 'general');
      return;
    }
    proceedToSave();
  };

  const resetExportDocFlowFields = () => {
    setExportInvoiceNumber(trim(dn?.invoice_number) || '');
    setExportAccountingNumber('');
    setExportInvoiceFile(null);
    setExportAccountingFile(null);
    exportAccPasteBlobRef.current = null;
    setExportAccPasteReady(false);
  };

  const openExportDocFlowModal = (onComplete) => {
    if (!dn || !trim(dn.outbound_number)) return;
    const hasFollowUp = typeof onComplete === 'function';
    exportDocFlowOnCompleteRef.current = hasFollowUp ? onComplete : null;
    setExportDocFlowHasFollowUp(hasFollowUp);
    resetExportDocFlowFields();
    setExportDocFlowOpen(true);
  };

  const closeExportDocFlowModal = () => {
    exportDocFlowOnCompleteRef.current = null;
    setExportDocFlowHasFollowUp(false);
    setExportDocFlowOpen(false);
    setExportDocDup(null);
  };

  const resolveExportFlowKeys = async () => {
    const ob = trim(dn?.outbound_number);
    let so = trim(dn?.gapp_po || dn?.sales_order_number);
    if (!so && ob && selectedWarehouseId) {
      try {
        const detail = await documentFlowApi.get(ob, { warehouse_id: selectedWarehouseId });
        so = trim(detail?.flow?.sales_order_number) || '';
      } catch {
        /* use outbound fallback */
      }
    }
    return { ob, so: so || ob };
  };

  const pasteExportAccountingFromClipboard = async () => {
    if (!exportAccountingNumber.trim()) {
      toast.error('Enter the accounting document number first, then paste from clipboard.');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      let blob = null;
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            blob = await item.getType(type);
            break;
          }
        }
        if (blob) break;
      }
      if (!blob) {
        toast.error('No image in clipboard — copy an accounting screenshot first.');
        return;
      }
      exportAccPasteBlobRef.current = blob;
      setExportAccPasteReady(true);
      setExportAccountingFile(null);
      toast.success('Accounting image ready — click Save to upload to Google Drive.');
    } catch {
      toast.error('Clipboard access denied — use Upload accounting file instead.');
    }
  };

  const uploadExportDoc = async (ob, fd, duplicate_action) => {
    if (duplicate_action) fd.append('duplicate_action', duplicate_action);
    try {
      const res = await documentFlowApi.upload(ob, fd);
      if (res?.conflict) {
        const err = new Error('duplicate');
        err.conflict = res.existing;
        throw err;
      }
      return res;
    } catch (e) {
      if (e.response?.status === 409 && e.response?.data?.conflict) {
        const err = new Error('duplicate');
        err.conflict = e.response.data.existing;
        throw err;
      }
      throw e;
    }
  };

  const submitExportDocFlow = async (duplicate_action) => {
    const ob = trim(dn?.outbound_number);
    if (!ob || !selectedWarehouseId || isAllWarehouses) {
      toast.error('Select a warehouse and ensure outbound number is set.');
      return;
    }
    if (!exportInvoiceNumber.trim()) {
      toast.error('Invoice number is required.');
      return;
    }
    if (!exportAccountingNumber.trim()) {
      toast.error('Accounting document number is required.');
      return;
    }
    const inv = exportInvoiceNumber.trim();
    const acc = exportAccountingNumber.trim();
    setExportDocFlowBusy(true);
    try {
      const { so } = await resolveExportFlowKeys();

      await documentFlowApi.setAccountingByOutbound(ob, {
        warehouse_id: selectedWarehouseId,
        invoice_number: inv,
        accounting_document_number: acc,
      });

      if (exportInvoiceFile) {
        const fd = new FormData();
        fd.append('file', exportInvoiceFile);
        fd.append('document_type', 'invoice');
        fd.append('warehouse_id', String(selectedWarehouseId));
        fd.append('invoice_number', inv);
        fd.append('accounting_document_number', acc);
        try {
          await uploadExportDoc(ob, fd, duplicate_action);
        } catch (e) {
          if (e.message === 'duplicate' && e.conflict) {
            setExportDocDup({ existing: e.conflict, label: 'Invoice', resume: submitExportDocFlow });
            return;
          }
          throw e;
        }
      }

      if (exportAccountingFile && !exportAccPasteReady) {
        const fd = new FormData();
        fd.append('file', exportAccountingFile);
        fd.append('document_type', 'accounting_document');
        fd.append('warehouse_id', String(selectedWarehouseId));
        fd.append('invoice_number', inv);
        fd.append('accounting_document_number', acc);
        try {
          await uploadExportDoc(ob, fd, duplicate_action);
        } catch (e) {
          if (e.message === 'duplicate' && e.conflict) {
            setExportDocDup({ existing: e.conflict, label: 'Accounting document', resume: submitExportDocFlow });
            return;
          }
          throw e;
        }
      } else if (exportAccPasteReady && exportAccPasteBlobRef.current) {
        const blob = exportAccPasteBlobRef.current;
        const fd = new FormData();
        fd.append('file', new File([blob], `ACC_${acc}.png`, { type: blob.type || 'image/png' }));
        fd.append('accounting_document_number', acc);
        fd.append('warehouse_id', String(selectedWarehouseId));
        fd.append('outbound_number', ob);
        if (duplicate_action) fd.append('duplicate_action', duplicate_action);
        const res = await documentFlowApi.pasteAccounting(so, fd);
        if (res?.conflict) {
          setExportDocDup({ existing: res.existing, label: 'Accounting document (paste)', resume: submitExportDocFlow });
          return;
        }
      }

      toast.success('Invoice and accounting document saved to Google Drive');
      const after = exportDocFlowOnCompleteRef.current;
      exportDocFlowOnCompleteRef.current = null;
      closeExportDocFlowModal();
      exportAccPasteBlobRef.current = null;
      setExportAccPasteReady(false);
      if (after) after();
    } catch (e) {
      if (e.response?.status === 409 && e.response?.data?.conflict) {
        setExportDocDup({
          existing: e.response.data.existing,
          label: 'Document',
          resume: submitExportDocFlow,
        });
        return;
      }
      toast.error(e.response?.data?.error || e.message);
    } finally {
      setExportDocFlowBusy(false);
    }
  };

  const saveContactPerson2Fields = async () => {
    if (!dnId || dnLocked) return;
    try {
      const data = await deliveryNotesApi.saveContactPerson2(dnId, {
        contact_person_2: cp2DraftName.trim(),
        contact_number_2: cp2DraftPhone.trim(),
      });
      setDn(data);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const handleContactPerson2Toggle = async () => {
    if (!dnId) return;
    const hasSaved = Boolean(trim(dn?.contact_person_2) || trim(dn?.contact_number_2));
    if (showContact2 && hasSaved) {
      try {
        const data = await deliveryNotesApi.saveContactPerson2(dnId, {
          contact_person_2: '',
          contact_number_2: '',
        });
        setDn(data);
        setShowContact2(false);
        setCp2DraftName('');
        setCp2DraftPhone('');
      } catch (e) {
        alert(e?.response?.data?.error || e.message);
      }
      return;
    }
    if (showContact2 && !hasSaved) {
      setShowContact2(false);
      setCp2DraftName(trim(dn?.contact_person_2));
      setCp2DraftPhone(trim(dn?.contact_number_2));
      return;
    }
    setShowContact2(true);
  };

  const podFileLabel = useMemo(() => {
    const p = trim(timeline?.pod_file_path || dn?.pod_file_path);
    if (!p) return '';
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] || p;
  }, [timeline, dn]);

  return (
    <div className="dn-screen-root">
      <div className="dn-screen-header dn-no-print">
        <h2 className="text-base font-bold text-gray-900 leading-tight">Delivery Note (DN)</h2>
        {readOnlyViewer ? (
          <p className="text-[11px] text-sky-900 bg-sky-50 border border-sky-200 rounded-md px-2 py-1.5 mt-1">
            <strong>Read-only (Viewer):</strong> view status, print/download delivery notes, Excel, POD, and reports. Editing,
            uploads, and confirm/deliver actions are disabled.
          </p>
        ) : null}
        <p className="text-[10px] text-gray-500 mt-0.5">
          Controls on the left · live delivery note preview on the right.
        </p>
      </div>

      <div className="dn-shell">
        <div className="dn-mobile-tabs" role="tablist" aria-label="Delivery note panels">
          <button
            type="button"
            role="tab"
            aria-selected={mobilePanel === 'controls'}
            className={`dn-mobile-tab${mobilePanel === 'controls' ? ' dn-mobile-tab--active' : ''}`}
            onClick={() => setMobilePanel('controls')}
          >
            Controls
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobilePanel === 'preview'}
            className={`dn-mobile-tab${mobilePanel === 'preview' ? ' dn-mobile-tab--active' : ''}`}
            onClick={() => setMobilePanel('preview')}
          >
            Preview
          </button>
        </div>

        <aside
          className={`dn-control-panel${mobilePanel !== 'controls' ? ' dn-panel-hidden-mobile' : ''}`}
          aria-label="Delivery note controls"
        >
          <div className="dn-control-scroll">
            <section className="dn-control-card dn-date-card">
              <div className="dn-control-card-title">Delivery note date</div>
              <p className="text-[10px] text-gray-600 mb-1">
                Click to open the calendar. Updates the DATE on the delivery note preview
                {dn ? '' : ' (saved when you load the DN)'}.
              </p>
              <DnDateCalendarPicker
                value={dnDateDraft}
                onChange={applyDnDate}
                disabled={!canChangeDnDate || dnDateSaving}
                saving={dnDateSaving}
              />
              {readOnlyViewer ? (
                <p className="text-[10px] text-sky-800 mt-1">Viewer account — date cannot be changed.</p>
              ) : dnLocked ? (
                <p className="text-[10px] text-amber-800 mt-1">Delivered — date is locked.</p>
              ) : null}
            </section>

            <section className="dn-control-card space-y-2">
              <div className="dn-control-card-title">Document</div>
              <label className="flex items-center gap-2 text-[10px] font-semibold text-gray-700">
                <input
                  type="checkbox"
                  checked={isHuaweiDnSource}
                  onChange={(e) => {
                    const v = Boolean(e.target.checked);
                    setIsHuaweiDnSource(v);
                    setOutboundNumber('');
                    setOutboundTyped('');
                    setSalesDocFilter('');
                    setDn(null);
                    setDnId(null);
                    setError('');
                  }}
                />
                Huawei source (use Huawei PO and auto-fill DN)
              </label>
              {isHuaweiDnSource ? (
                <p className="text-[10px] text-gray-600 leading-snug">
                  Lines import <strong>by box</strong> (same box repeats per part). Outbound and invoice you enter
                  manually. System PO defaults to Huawei B2B.
                </p>
              ) : null}
              <label className="flex flex-col text-[10px] font-semibold text-gray-600">
                Sales doc / GAPP PO / SO (filter)
                <select
                  className="input-field mt-0.5"
                  value={salesDocFilter}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSalesDocFilter(v);
                    setOutboundTyped('');
                    const f = trimStr(v);
                    if (!f) return;
                    setOutboundNumber((prev) => {
                      const row = outboundOptions.find((o) => trimStr(o.outbound_number) === trimStr(prev));
                      if (!row) return prev;
                      return trimStr(row.sales_doc) === f ? prev : '';
                    });
                  }}
                  onFocus={refreshOutboundOptions}
                  disabled={isHuaweiDnSource}
                >
                  <option value="">Any</option>
                  {salesDocChoices.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col text-[10px] font-semibold text-gray-600">
                {isHuaweiDnSource ? 'Huawei SAP PO' : 'Outbound / customer'}
                <div className="flex items-center gap-1.5 mt-0.5">
                  <Search size={12} className="text-gray-400 flex-shrink-0" />
                  <select
                    className="input-field flex-1 min-w-0"
                    value={outboundNumber}
                    onChange={(e) => {
                      const v = e.target.value;
                      setOutboundNumber(v);
                      setOutboundTyped('');
                      const row = outboundFiltered.find((o) => trimStr(o.outbound_number) === trimStr(v));
                      if (row && trimStr(row.sales_doc)) setSalesDocFilter(trimStr(row.sales_doc));
                    }}
                    onFocus={refreshOutboundOptions}
                    disabled={isHuaweiDnSource}
                  >
                    <option value="">{isHuaweiDnSource ? 'Select SAP PO…' : 'Select outbound…'}</option>
                    {outboundFiltered.slice(0, 500).map((o, idx) => (
                      <option key={`${o.outbound_number}-${idx}`} value={o.outbound_number}>
                        {o.customer_name || '—'} · {o.outbound_number}
                        {o.sales_doc ? ` · ${o.sales_doc}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </label>
              <div className="flex gap-1.5">
                <input
                  className="input-field flex-1 min-w-0"
                  placeholder={isHuaweiDnSource ? 'Type Huawei SAP PO…' : 'Or type outbound…'}
                  value={outboundTyped}
                  onChange={(e) => {
                    const v = e.target.value;
                    setOutboundTyped(v);
                    setOutboundNumber(v);
                  }}
                />
                <button type="button" className="btn-secondary text-[10px] px-2" onClick={refreshOutboundOptions}>
                  Refresh
                </button>
                <button type="button" className="btn-primary text-[10px] px-2" onClick={() => void load()} disabled={loading}>
                  {loading ? '…' : isHuaweiDnSource ? 'Load Huawei DN' : 'Load DN'}
                </button>
              </div>
              {dn ? (
                <div className="text-[10px] text-gray-700 space-y-0.5 pt-1 border-t border-gray-100">
                  <div>
                    <span className="text-gray-500">Customer: </span>
                    <strong>{trim(dn.customer_name) || '—'}</strong>
                  </div>
                  <div>
                    <span className="text-gray-500">Delivery to: </span>
                    {trim(dn.delivery_address) ? (
                      <span className="line-clamp-2">{trim(dn.delivery_address)}</span>
                    ) : (
                      <span className="text-amber-800">Not set</span>
                    )}
                  </div>
                  {effectiveInvoice ? (
                    <div>
                      <span className="text-gray-500">Invoice: </span>
                      <strong>{effectiveInvoice}</strong>
                    </div>
                  ) : null}
                  {packageText ? (
                    <div>
                      <span className="text-gray-500">Packages: </span>
                      <strong>{packageText}</strong>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-1 pt-1">
                <button
                  className="btn-secondary text-[10px] flex-1"
                  type="button"
                  onClick={openTransport}
                  disabled={!canEditDn || !dn || dnLocked}
                >
                  Transportation
                </button>
                <button
                  className="btn-secondary text-[10px] flex-1"
                  type="button"
                  disabled={!canEditDn || !dn || dnLocked}
                  onClick={openDeliveryTo}
                >
                  Delivery To
                </button>
              </div>
              <div className="pt-1 border-t border-gray-100">
                <button
                  className="btn-secondary text-[10px] w-full"
                  type="button"
                  disabled={!canEditDn || !dn || dnLocked}
                  onClick={handleContactPerson2Toggle}
                >
                  {showContact2 && (trim(dn?.contact_person_2) || trim(dn?.contact_number_2))
                    ? 'Remove Contact 2'
                    : showContact2
                      ? 'Cancel Contact 2'
                      : 'Add Contact Person 2'}
                </button>
                {canEditDn && showContact2 && dn && !dnLocked ? (
                  <div className="mt-1.5 space-y-1">
                    <input
                      className="input-field text-[10px]"
                      value={cp2DraftName}
                      onChange={(e) => setCp2DraftName(e.target.value)}
                      placeholder="Contact person (2)"
                    />
                    <input
                      className="input-field text-[10px]"
                      value={cp2DraftPhone}
                      onChange={(e) => setCp2DraftPhone(e.target.value)}
                      placeholder="Number (2)"
                    />
                    <button type="button" className="btn-primary text-[10px] w-full" onClick={saveContactPerson2Fields}>
                      Save contact (2)
                    </button>
                  </div>
                ) : null}
              </div>
            </section>

            {dn && trim(dn.outbound_number) && dn.pick_footprint ? (
              <details className="dn-control-card text-[10px] text-emerald-950">
                <summary className="dn-control-card-title cursor-pointer select-none text-emerald-900">
                  Pick progress
                  {dn.pick_footprint.pick_progress?.fully_picked ? (
                    <span className="font-normal text-emerald-700"> · complete</span>
                  ) : (
                    <span className="font-normal text-amber-800"> · in progress</span>
                  )}
                </summary>
                <div className="dn-summary-grid mt-1">
                  <div>
                    <dt>Picked</dt>
                    <dd>
                      {pickQtyDn(dn.pick_footprint.pick_progress?.total_picked_qty).toLocaleString()} /{' '}
                      {pickQtyDn(dn.pick_footprint.pick_progress?.total_required_qty).toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt>Lines</dt>
                    <dd>
                      {pickQtyDn(dn.pick_footprint.pick_progress?.lines_complete)} /{' '}
                      {pickQtyDn(dn.pick_footprint.pick_progress?.lines_total)}
                    </dd>
                  </div>
                </div>
                <Link className="mt-1 inline-block text-[10px] font-semibold text-emerald-900 underline" to="/outbound-pick">
                  Outbound &amp; pick →
                </Link>
              </details>
            ) : null}

            <section className="dn-control-card">
              <div className="dn-control-card-title flex items-center justify-between gap-2">
                <span>Invoice number</span>
                {canEditDn && dn && !dnLocked ? (
                  <button
                    type="button"
                    className="text-[10px] font-semibold text-violet-800 underline inline-flex items-center gap-0.5"
                    onClick={openInvoiceEditOnly}
                  >
                    <Pencil size={11} />
                    {hasInvoice ? 'Edit' : 'Add'}
                  </button>
                ) : null}
              </div>
              <p className="text-[11px] font-mono font-semibold text-gray-900 break-all">{effectiveInvoice || 'Not set yet'}</p>
              {canEditDn && dn && !dnLocked && !hasInvoice ? (
                <p className="text-[10px] text-gray-500 mt-1">Required before confirm / deliver. You can change it later using Edit.</p>
              ) : null}
            </section>

            <section className="dn-control-card">
              <div className="dn-control-card-title flex items-center justify-between gap-2">
                <span>Packaging &amp; volume</span>
                {canEditDn && dn && !dnLocked ? (
                  <button
                    type="button"
                    className="text-[10px] font-semibold text-violet-800 underline inline-flex items-center gap-0.5"
                    onClick={openPackageEditOnly}
                  >
                    <Pencil size={11} />
                    Edit
                  </button>
                ) : null}
              </div>
              <dl className="dn-summary-grid text-[11px] mb-2">
                <div>
                  <dt>Package type</dt>
                  <dd>{String(dn?.package_type || '—')}</dd>
                </div>
                <div>
                  <dt>Package qty</dt>
                  <dd>
                    {String(dn?.package_type || '').toLowerCase() === 'pallet'
                      ? dn?.pallet_qty ?? '—'
                      : String(dn?.package_type || '').toLowerCase() === 'box'
                        ? dn?.box_qty ?? '—'
                        : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Weight (kg)</dt>
                  <dd>{packageWeightDisplay}</dd>
                </div>
                <div>
                  <dt>Volume (CBM)</dt>
                  <dd>{packageVolumeDisplay}</dd>
                </div>
              </dl>
              <div className="dn-control-card-title border-t border-gray-100 pt-2 mt-1">Summary</div>
              <dl className="dn-summary-grid">
                <div>
                  <dt>Line items</dt>
                  <dd>{lineItems.length}</dd>
                </div>
                <div>
                  <dt>Total qty</dt>
                  <dd>{totalDnQty.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Packages</dt>
                  <dd>{packageText || '—'}</dd>
                </div>
                <div>
                  <dt>Outbound</dt>
                  <dd className="font-mono text-[10px]">{trim(dn?.outbound_number) || '—'}</dd>
                </div>
                <div>
                  <dt>DN date</dt>
                  <dd>{dnDateDraft || '—'}</dd>
                </div>
              </dl>
            </section>

            <section className="dn-control-card">
              <div className="dn-control-card-title">POD — signed delivery note</div>
              <p className="text-[10px] text-gray-600 mb-1.5">PDF, JPG, or PNG. Replace before final close.</p>
              {podFileLabel ? (
                <div className="text-[10px] bg-emerald-50 border border-emerald-100 rounded px-2 py-1.5 mb-1.5">
                  <div className="font-semibold text-emerald-950 truncate" title={podFileLabel}>
                    {podFileLabel}
                  </div>
                  {timeline?.pod_uploaded_at ? (
                    <div className="text-gray-600 mt-0.5">Uploaded: {fmtDt(timeline.pod_uploaded_at)}</div>
                  ) : null}
                </div>
              ) : (
                <p className="text-[10px] text-gray-500 mb-1.5">No POD on file yet.</p>
              )}
              <DnPodDropZone
                disabled={!canUploadPodDn || !dn || dnLocked}
                onFile={(f) => {
                  setPodInitialFile(f);
                  setPodUploadOpen(true);
                }}
              >
                <Upload size={14} className="inline-block mr-1 opacity-70" />
                Drag &amp; drop POD here (PDF, JPG, PNG)
              </DnPodDropZone>
              <div className="flex flex-wrap gap-1 mt-1.5">
                <button
                  className="btn-secondary flex items-center gap-1 text-[10px] flex-1 border-emerald-700/30 bg-emerald-50/90"
                  type="button"
                  disabled={!canUploadPodDn || !dn || dnLocked}
                  onClick={() => {
                    setPodInitialFile(null);
                    setPodUploadOpen(true);
                  }}
                >
                  <Upload size={12} />
                  {podFileLabel ? 'Replace POD' : 'Upload POD'}
                </button>
                {podFileLabel ? (
                  <button type="button" className="btn-secondary text-[10px]" onClick={handleViewPod}>
                    View
                  </button>
                ) : null}
              </div>
              {/* TODO: backend endpoint to clear POD before close — use Replace to upload a new file for now */}
            </section>

            {dn ? (
              <section className="dn-control-card text-[11px] text-gray-800">
                <div className="dn-control-card-title">Delivery status</div>
                <div>
                  <span className="text-gray-500">Workflow: </span>
                  <strong>{String(dn.delivery_status || 'Draft')}</strong>
                  {dnLocked ? <span className="ml-1 text-amber-800">(delivered)</span> : null}
                </div>
                {timeline ? (
                  <ul className="mt-1.5 space-y-0.5 text-[10px] text-gray-700">
                    <li>
                      <span className="text-gray-500">Confirmed: </span>
                      {fmtDt(timeline.confirmed_at)}
                    </li>
                    <li>
                      <span className="text-gray-500">Opened by driver: </span>
                      {fmtDt(timeline.driver_opened_at)}
                    </li>
                    <li>
                      <span className="text-gray-500">Pickup: </span>
                      {fmtDt(timeline.pickup_confirmed_at)}
                    </li>
                    <li>
                      <span className="text-gray-500">POD uploaded: </span>
                      {fmtDt(timeline.pod_uploaded_at)}
                    </li>
                    <li>
                      <span className="text-gray-500">Closed: </span>
                      {fmtDt(timeline.closed_at)}
                    </li>
                  </ul>
                ) : null}
              </section>
            ) : null}

            {error ? <div className="text-xs text-red-600 px-1">{error}</div> : null}
            {canEditDn && dn && !dnLocked ? (
              <div className="flex flex-wrap gap-3 px-1">
                <button
                  type="button"
                  className="text-[10px] text-gray-600 underline inline-flex items-center gap-0.5"
                  onClick={openInvoiceEditOnly}
                >
                  <Pencil size={11} />
                  Edit invoice number
                </button>
                <button
                  type="button"
                  className="text-[10px] text-gray-600 underline inline-flex items-center gap-0.5"
                  onClick={openPackageEditOnly}
                >
                  <Pencil size={11} />
                  Edit packaging &amp; volume
                </button>
                {needsExportDocFlowBeforePdf() ? (
                  <button
                    type="button"
                    className="text-[10px] text-gray-600 underline"
                    onClick={() => openExportDocFlowModal()}
                  >
                    Upload invoice to Drive (optional)
                  </button>
                ) : null}
              </div>
            ) : null}

            <section className="dn-control-card">
              <div className="dn-control-card-title">Actions</div>
              <div className="dn-action-grid relative z-10">
                <button
                  type="button"
                  className="btn-secondary flex items-center justify-center gap-1"
                  disabled={!dn || !canDownloadDn}
                  onClick={() => {
                    setSaveDriveDup(null);
                    setDownloadActionMode(canEditDn ? 'both' : 'download');
                    setDownloadActionOpen(true);
                  }}
                >
                  <Printer size={12} />
                  Save PDF
                </button>
                <button
                  type="button"
                  className="btn-secondary flex items-center justify-center gap-1"
                  onClick={handlePrintA4}
                  disabled={!dn}
                >
                  <Printer size={12} />
                  Print
                </button>
                <button
                  type="button"
                  className="btn-secondary flex items-center justify-center gap-1"
                  onClick={handleExportExcel}
                  disabled={!dn || !canDownloadDn}
                >
                  <FileSpreadsheet size={12} />
                  Export Excel
                </button>
                <button
                  type="button"
                  className="btn-secondary flex items-center justify-center gap-1 border-emerald-700/30 bg-emerald-50/80"
                  disabled={!dn || !canDownloadDn}
                  onClick={openCustomerWhatsAppDialog}
                >
                  <MessageCircle size={12} />
                  WhatsApp
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={toggleHold}
                  disabled={!canEditDn || !dn || dnLocked}
                >
                  {String(dn?.status || '').toLowerCase() === 'on hold' ? 'Resume Hold' : 'Hold'}
                </button>
                <button
                  type="button"
                  className="btn-secondary flex items-center justify-center gap-1"
                  onClick={deliver}
                  disabled={!canEditDn || !dn}
                >
                  <CheckCircle2 size={12} />
                  Mark Delivered
                </button>
                {isGapp && dn && !dn.confirmed_at && canEditDn && !dnLocked ? (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!gappCanConfirm}
                    onClick={handleConfirmForDelivery}
                    title={!gappCanConfirm ? gappMissingConfirmReasons?.join('; ') : 'Notify driver'}
                  >
                    Confirm for delivery
                  </button>
                ) : null}
                {trim(dn?.gapp_po || dn?.sales_order_number || view?.gapp_po) ? (
                  <Link
                    className="btn-secondary text-center col-span-2"
                    to={`/document-workflow?ob=${encodeURIComponent(trim(dn?.outbound_number || ''))}&so=${encodeURIComponent(
                      trim(dn?.gapp_po || dn?.sales_order_number || view?.gapp_po)
                    )}`}
                  >
                    Document Workflow
                  </Link>
                ) : null}
              </div>
            </section>

            <section className="dn-control-card">
              <div className="dn-control-card-title">On hold</div>
              {holdRows?.length ? (
                <div className="flex flex-wrap gap-1">
                  {holdRows.slice(0, 12).map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="btn-secondary text-[9px] px-1.5 py-0.5"
                      onClick={() => {
                        const ob = r.outbound_number || '';
                        setOutboundNumber(ob);
                        void load(ob);
                      }}
                    >
                      {r.outbound_number}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-gray-500">No held delivery notes.</p>
              )}
            </section>
          </div>
        </aside>

        <section
          className={`dn-preview-panel${mobilePanel !== 'preview' ? ' dn-panel-hidden-mobile' : ''}`}
          aria-label="Delivery note preview"
        >
          <div className="dn-preview-toolbar">
            <span className="text-[10px] font-bold text-gray-800 mr-1">Live preview</span>
            {dn ? (
              <span className="text-[10px] text-gray-500 font-mono truncate max-w-[12rem]">
                {trim(dn.outbound_number) || '—'}
              </span>
            ) : (
              <span className="text-[10px] text-gray-500">Load a delivery note</span>
            )}
            <button
              type="button"
              className="btn-secondary text-[10px] py-0.5 px-2 ml-auto"
              onClick={handlePrintA4}
              disabled={!dn}
            >
              <Printer size={12} className="inline mr-0.5" />
              Print
            </button>
            <details className="text-[10px] relative">
              <summary className="cursor-pointer font-semibold text-gray-700 select-none">Page setup</summary>
              <div className="absolute right-0 z-10 mt-1 p-2 bg-white border rounded-lg shadow-lg grid gap-2 min-w-[200px]">
                <label className="flex flex-col gap-0.5">
                  Margin (mm)
                  <input
                    type="number"
                    min={4}
                    max={22}
                    className="input-field"
                    value={printPageMarginMm}
                    onChange={(e) => setPrintPageMarginMm(Number(e.target.value))}
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  Scale (%)
                  <input
                    type="number"
                    min={72}
                    max={100}
                    className="input-field"
                    value={printZoomPercent}
                    onChange={(e) => setPrintZoomPercent(Number(e.target.value))}
                  />
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={printCompactTable}
                    onChange={(e) => setPrintCompactTable(e.target.checked)}
                  />
                  Compact table
                </label>
              </div>
            </details>
          </div>
          <div className="dn-preview-scroll">

      {/* A4 Printable DN */}
      <div className={`dn-wrap bg-white border rounded-xl shadow-sm p-4${printCompactTable ? ' dn-print-compact' : ''}`}>
        <div className="dn-page" aria-label="Delivery Note A4 Page">
          <div className="dn-page-scaled">
          <div className="dn-page-main">
          <div className="dn-page-body">
          {/* TOP HEADER */}
          <div className="dn-top">
            <div className="dn-company">
              <img className="dn-logo" src="/LOGO.png" alt="Gulf Applications (GAPP)" />
              <div className="dn-company-text">
                <div className="dn-company-name dn-company-name-red">Gulf Applications</div>
                <div className="dn-company-address">
                  Apartment 5001, 50th Floor, Kingdom Tower
                  <br />
                  P.O Box 89098, Riyadh, Saudi Arabia
                </div>
                <div className="dn-company-contact-lines">
                  <div>Tel.: +966 11 47 28 256</div>
                  <div>Fax: +966 11 47 81 503</div>
                  <a className="dn-company-site" href="https://www.gapp.sa" target="_blank" rel="noreferrer">
                    https://www.gapp.sa
                  </a>
                </div>
              </div>
            </div>

            <div className="dn-title-block">
              <div className="dn-title">DELIVERY NOTE</div>
            </div>

            <div className="dn-right-stack">
              <div className="dn-headgrid" role="table" aria-label="DN Header Fields">
                {(isHuaweiDn
                  ? [
                      ['DATE', formatDateDDMMYYYY(view?.dn_date)],
                      ['CUSTOMER PO', view?.customer_po || ''],
                      ['OUTBOUND', view?.outbound_number || ''],
                      ['INVOICE', invoiceForPrint],
                      ['SO NUMBER', view?.sales_order_number || ''],
                    ]
                  : [
                      ['DATE', formatDateDDMMYYYY(view?.dn_date)],
                      ['GAPP PO', view?.gapp_po || ''],
                      ['CUSTOMER PO', view?.customer_po || ''],
                      ['OUTBOUND', view?.outbound_number || ''],
                      ['INVOICE', invoiceForPrint],
                    ]
                ).map(([k, v], idx) => (
                  <div className="dn-headrow" role="row" key={k || `spacer-${idx}`}>
                    <div className="dn-headkey" role="cell">
                      {k}
                    </div>
                    <div className="dn-headval" role="cell">
                      {v}
                    </div>
                  </div>
                ))}
              </div>

              <div className="dn-spo-only">
                <div className="dn-spo-row">
                  <div className="dn-spo-key">SPO</div>
                  <div className="dn-spo-val">{isHuaweiDn ? 'B2B' : (view?.spo || '—')}</div>
                </div>
                {isHuaweiDn && (
                  <div className="dn-spo-row" style={{ marginTop: '4px' }}>
                    <div className="dn-spo-key">CONTRACT</div>
                    <div className="dn-spo-val">{view?.huawei_contract || '—'}</div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* DELIVERY + CONTACTS — shared label column so “Delivery to” lines up with Contact Person */}
          <div className="dn-address-contact-block">
            <div className="dn-delivery">
              <div className="dn-delivery-left">
                <div className="lbl">Delivery to:</div>
              </div>
              <div className="dn-delivery-content">
                {String(view?.customer_name || '').trim() ? (
                  <div className="dn-delivery-name">{view.customer_name}</div>
                ) : null}
                {String(view?.delivery_address || '').trim() ? (
                  <div className="dn-delivery-addr">{view.delivery_address}</div>
                ) : null}
                {String(view?.city_name || '').trim() ? (
                  <div className="dn-delivery-addr">{view.city_name}</div>
                ) : null}
                {String(view?.gps || '').trim() ? (
                  <a className="dn-link dn-no-print" href={view.gps} target="_blank" rel="noreferrer">
                    {view.gps}
                  </a>
                ) : null}
              </div>
            </div>

            {isHuaweiDn && String(view?.reseller_name || '').trim() && trim(view?.reseller_name) !== trim(view?.customer_name) ? (
              <div className="dn-delivery dn-delivery-reseller">
                <div className="dn-delivery-left">
                  <div className="lbl">Delivery (reseller):</div>
                </div>
                <div className="dn-delivery-content">
                  <div className="dn-delivery-name">{view.reseller_name}</div>
                </div>
              </div>
            ) : null}

            {String(view?.contact_person || '').trim() || String(view?.contact_number || '').trim() ? (
              <div className="dn-contact dn-contact-1row">
                <div className="lbl">Contact Person:</div>
                <div className="dn-inline-underline">
                  <span className="dn-under-text">
                    {[view?.contact_person, view?.contact_number].filter(Boolean).join(' - ')}
                  </span>
                </div>
              </div>
            ) : null}

            {String(view?.contact_person_2 || '').trim() || String(view?.contact_number_2 || '').trim() ? (
              <div className="dn-contact dn-contact-2">
                <div className="lbl">Contact Person:</div>
                <div className="dn-inline-underline">
                  <span className="dn-under-text">
                    {[view?.contact_person_2, view?.contact_number_2].filter(Boolean).join(' - ')}
                  </span>
                </div>
              </div>
            ) : null}

            {String(view?.deliver_to_remarks || '').trim() ? (
              <div className="dn-contact dn-contact-remarks">
                <div className="lbl">Delivery remarks:</div>
                <div className="dn-inline-underline">
                  <span className="dn-under-text whitespace-pre-wrap">{String(view.deliver_to_remarks).trim()}</span>
                </div>
              </div>
            ) : null}
          </div>

          {/* ITEM TABLE */}
          <table className="dn-grid">
            <thead className="dn-items-thead">
              <tr>
                {isHuaweiDn ? (
                  <SortTh
                    bare
                    columnKey="box_name"
                    sortKey={dnItemSortKey}
                    direction={dnItemDir}
                    onSort={dnItemRequestSort}
                    style={{ width: '12%' }}
                  >
                    Box
                  </SortTh>
                ) : (
                  <th style={{ width: '6%' }}>Item #</th>
                )}
                <SortTh
                  bare
                  columnKey="part_number"
                  sortKey={dnItemSortKey}
                  direction={dnItemDir}
                  onSort={dnItemRequestSort}
                  style={{ width: '18%' }}
                >
                  Part Number
                </SortTh>
                <SortTh bare columnKey="description" sortKey={dnItemSortKey} direction={dnItemDir} onSort={dnItemRequestSort}>
                  Description
                </SortTh>
                <SortTh
                  bare
                  columnKey="qty"
                  sortKey={dnItemSortKey}
                  direction={dnItemDir}
                  onSort={dnItemRequestSort}
                  style={{ width: '8%' }}
                >
                  Qty
                </SortTh>
                <SortTh
                  bare
                  columnKey="uom"
                  sortKey={dnItemSortKey}
                  direction={dnItemDir}
                  onSort={dnItemRequestSort}
                  style={{ width: '8%' }}
                >
                  UOM
                </SortTh>
                <SortTh
                  bare
                  columnKey="serial_no"
                  sortKey={dnItemSortKey}
                  direction={dnItemDir}
                  onSort={dnItemRequestSort}
                  style={{ width: '14%' }}
                >
                  Serial No.
                </SortTh>
                <SortTh
                  bare
                  columnKey="condition"
                  sortKey={dnItemSortKey}
                  direction={dnItemDir}
                  onSort={dnItemRequestSort}
                  style={{ width: '12%' }}
                >
                  Condition
                </SortTh>
              </tr>
            </thead>
            <tbody>
              {displayItems.map((it, idx) => (
                <tr key={`${it.box_name || ''}-${it.part_number}-${idx}`} className="dn-row">
                  {isHuaweiDn ? (
                    <td className="c font-mono text-[10px]">{it.box_name || '—'}</td>
                  ) : (
                    <td className="c">{idx + 1}</td>
                  )}
                  <td>{it.part_number || ''}</td>
                  <td>{it.description || ''}</td>
                  <td className="c">{it.qty}</td>
                  <td className="c">{it.uom || ''}</td>
                  <td className="c">{isHuaweiDn ? '-' : it.serial_no || '-'}</td>
                  <td className="c">{it.condition_text || it.condition || 'New'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* BOTTOM SUMMARY LINE + Checked by (one line, below volume column) */}
          <div className="dn-summary-block">
            <div className="dn-summary-cell">
              Total: <strong>{packageText || ''}</strong>
            </div>
            <div className="dn-summary-cell">
              gross weight(KG): <strong>{packageWeightDisplay}</strong>
            </div>
            <div className="dn-summary-cell">
              volume(CBM): <strong>{packageVolumeDisplay}</strong>
            </div>
            <div className="dn-checked-by-line">
              <span className="dn-checked-by-label">Checked by:</span>
              <span className="dn-checked-by-name">{checkedByDisplayName}</span>
            </div>
          </div>

          {/* Transportation */}
          {transportRenderLines.length ? (
            <div className="dn-transport">
              <div className="dn-transport-inner">
                {transportRenderLines.map((l, idx) => (
                  <div className="dn-transport-row" key={idx}>
                    <div className="k">{l.k}</div>
                    <div className="v">{l.v}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="dn-transport dn-transport-empty">
              <div className="dn-transport-inner">Transportation Method not set.</div>
            </div>
          )}

          </div>

          {/* RECEIVER SECTION — left 60% fields, right 38% stamp */}
          <div className="dn-receiver">
            <div className="cap">
              Below fields are mandatory to be filled by the Receiver; stated particulars must be true and correct.
            </div>
            <div className="dn-receiver-body">
              <div className="dn-receiver-col-fields">
                <div className="rrow">
                  <div className="k">NAME</div>
                  <div className="u" />
                </div>
                <div className="rrow">
                  <div className="k">SIGN</div>
                  <div className="u" />
                </div>
                <div className="rrow">
                  <div className="k">Mobile no.</div>
                  <div className="u" />
                </div>
                <div className="rrow">
                  <div className="k">DATE</div>
                  <div className="u" />
                </div>
              </div>
              <div className="dn-receiver-col-stamp" aria-hidden="true">
                <div className="dn-stamp-watermark">STAMP</div>
              </div>
            </div>
          </div>

          </div>
          </div>
        </div>
        <div className="dn-page-counter" aria-label="Page number" />
      </div>

          </div>
        </section>
      </div>


      <DnPodUploadModal
        open={podUploadOpen}
        onClose={() => {
          setPodUploadOpen(false);
          setPodInitialFile(null);
        }}
        dnId={dnId}
        initialFile={podInitialFile}
        onSuccess={async () => {
          setPodInitialFile(null);
          if (dnId) await refreshDnOnly(dnId, { silent: true });
        }}
      />

      {exportDocFlowOpen && dn ? (
        <div className="dn-no-print fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-lg max-w-lg w-full p-5 border text-sm max-h-[90vh] overflow-y-auto">
            <h3 className="text-sm font-bold text-gray-900">Export PDF — Invoice &amp; Accounting</h3>
            <p className="text-[11px] text-gray-600 mt-2">
              Outbound <strong className="font-mono">{trim(dn.outbound_number)}</strong>. Enter invoice and accounting document
              numbers before printing or saving the delivery note PDF. Optional: upload files or paste accounting screenshot.
            </p>
            <div className="mt-4 space-y-3">
              <div className="rounded-lg border border-gray-200 bg-gray-50/80 p-3 space-y-2">
                <p className="text-[10px] font-bold text-gray-700 uppercase tracking-wide">Step 1 — Reference numbers</p>
                <label className="text-[10px] font-bold text-gray-600 flex flex-col">
                  Invoice number *
                  <input
                    className="input-field mt-0.5 bg-white"
                    value={exportInvoiceNumber}
                    onChange={(e) => setExportInvoiceNumber(e.target.value)}
                    placeholder="e.g. INV-2026-001"
                  />
                </label>
                <label className="text-[10px] font-bold text-gray-600 flex flex-col">
                  Accounting document number *
                  <input
                    className="input-field mt-0.5 bg-white"
                    value={exportAccountingNumber}
                    onChange={(e) => {
                      setExportAccountingNumber(e.target.value);
                      if (!e.target.value.trim()) {
                        exportAccPasteBlobRef.current = null;
                        setExportAccPasteReady(false);
                      }
                    }}
                    placeholder="SAP / voucher reference"
                  />
                </label>
              </div>

              <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3 space-y-2">
                <p className="text-[10px] font-bold text-violet-900 uppercase tracking-wide">Step 2 — Upload or paste</p>
                <label className="text-[10px] font-bold text-gray-600 flex flex-col">
                  <span className="inline-flex items-center gap-1">
                    <Upload size={12} /> Upload invoice (PDF or image)
                  </span>
                  <input
                    type="file"
                    className="mt-0.5 text-[11px] bg-white rounded border border-gray-200 px-2 py-1"
                    accept=".pdf,.jpg,.jpeg,.png"
                    onChange={(e) => setExportInvoiceFile(e.target.files?.[0] || null)}
                  />
                  {exportInvoiceFile ? (
                    <span className="text-[10px] text-emerald-800 mt-0.5">{exportInvoiceFile.name}</span>
                  ) : (
                    <span className="text-[10px] text-gray-500 mt-0.5 font-normal">Optional</span>
                  )}
                </label>
                <label className="text-[10px] font-bold text-gray-600 flex flex-col">
                  <span className="inline-flex items-center gap-1">
                    <Upload size={12} /> Upload accounting document (PDF or image)
                  </span>
                  <input
                    type="file"
                    className="mt-0.5 text-[11px] bg-white rounded border border-gray-200 px-2 py-1"
                    accept=".pdf,.jpg,.jpeg,.png"
                    disabled={exportAccPasteReady}
                    onChange={(e) => {
                      setExportAccountingFile(e.target.files?.[0] || null);
                      if (e.target.files?.[0]) {
                        exportAccPasteBlobRef.current = null;
                        setExportAccPasteReady(false);
                      }
                    }}
                  />
                  {exportAccountingFile ? (
                    <span className="text-[10px] text-emerald-800 mt-0.5">{exportAccountingFile.name}</span>
                  ) : (
                    <span className="text-[10px] text-gray-500 mt-0.5 font-normal">Optional if you paste below</span>
                  )}
                </label>
                <button
                  type="button"
                  className="btn-secondary w-full text-[11px] flex items-center justify-center gap-1.5"
                  disabled={!exportAccountingNumber.trim() || exportDocFlowBusy}
                  onClick={() => void pasteExportAccountingFromClipboard()}
                >
                  <ClipboardPaste size={14} />
                  Paste accounting from clipboard
                </button>
                {exportAccPasteReady ? (
                  <p className="text-[10px] text-emerald-800 bg-emerald-50 border border-emerald-100 rounded px-2 py-1">
                    Clipboard image ready for <strong className="font-mono">{exportAccountingNumber.trim()}</strong> — save to upload.
                  </p>
                ) : (
                  <p className="text-[10px] text-gray-500">Enter accounting number first, copy screenshot, then paste.</p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 mt-4 pt-2 border-t border-gray-100">
              <button type="button" className="btn-primary" disabled={exportDocFlowBusy} onClick={() => void submitExportDocFlow()}>
                {exportDocFlowBusy ? 'Saving to Drive…' : 'Save to Google Drive'}
              </button>
              <Link
                to={`/document-flow/${encodeURIComponent(trim(dn.outbound_number))}`}
                className="btn-secondary"
                onClick={() => closeExportDocFlowModal()}
              >
                Open Document Flow
              </Link>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  const after = exportDocFlowOnCompleteRef.current;
                  exportDocFlowOnCompleteRef.current = null;
                  closeExportDocFlowModal();
                  exportAccPasteBlobRef.current = null;
                  setExportAccPasteReady(false);
                  if (after) after();
                }}
              >
                {exportDocFlowHasFollowUp ? 'Continue without Drive upload' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {exportDocDup ? (
        <div className="dn-no-print fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-5 border text-sm">
            <h3 className="font-bold text-gray-900">File already exists — {exportDocDup.label}</h3>
            <p className="text-[11px] text-gray-600 mt-2">
              <code className="font-mono">{exportDocDup.existing?.stored_file_name}</code> is already in Drive.
            </p>
            <div className="flex flex-col gap-2 mt-4">
              <button
                type="button"
                className="btn-primary"
                disabled={exportDocFlowBusy}
                onClick={() => {
                  setExportDocDup(null);
                  void exportDocDup.resume('replace');
                }}
              >
                Replace — overwrite existing file
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={exportDocFlowBusy}
                onClick={() => {
                  setExportDocDup(null);
                  void exportDocDup.resume('append');
                }}
              >
                Append — keep both (second file name)
              </button>
              <button type="button" className="btn-secondary" onClick={() => setExportDocDup(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {downloadActionOpen && dn ? (
        <div className="dn-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-5 border text-sm">
            <h3 className="text-sm font-bold text-gray-900">Choose action</h3>
            <div className="mt-3 space-y-2 text-[11px]">
              {[
                { id: 'download', label: 'Download PDF only' },
                ...(canEditDn
                  ? [
                      { id: 'drive', label: 'Save PDF to Google Drive only' },
                      { id: 'both', label: 'Save to Google Drive + Download PDF' },
                    ]
                  : []),
              ].map((o) => (
                <label key={o.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="dn-dl-mode"
                    checked={downloadActionMode === o.id}
                    onChange={() => setDownloadActionMode(o.id)}
                  />
                  {o.label}
                </label>
              ))}
            </div>
            <dl className="mt-3 text-[11px] space-y-1 text-gray-800">
              <div className="flex gap-2">
                <dt className="font-semibold w-28">Sales Order</dt>
                <dd>{trim(dn.gapp_po || dn.sales_order_number || view?.outbound_sales_doc) || '—'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-semibold w-28">Outbound</dt>
                <dd>{trim(dn.outbound_number) || '—'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-semibold w-28">DN number</dt>
                <dd>{trim(dn.dn_number) || String(dn.id)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-semibold w-28">File preview</dt>
                <dd className="font-mono text-[10px] break-all">{dnDrivePreviewName}</dd>
              </div>
            </dl>
            {saveDriveDup ? (
              <p className="mt-3 text-amber-800 text-[11px]">
                Existing file: <code>{saveDriveDup.stored_file_name}</code>
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2 mt-4">
              {saveDriveDup ? (
                <>
                  <button type="button" className="btn-primary" disabled={saveDriveBusy} onClick={() => void runDownloadSaveAction('replace')}>
                    Replace existing
                  </button>
                  <button type="button" className="btn-secondary" disabled={saveDriveBusy} onClick={() => void runDownloadSaveAction('append')}>
                    Append (second file name)
                  </button>
                </>
              ) : (
                <button type="button" className="btn-primary" disabled={saveDriveBusy} onClick={() => void handleDownloadSaveContinue()}>
                  {saveDriveBusy ? 'Working…' : 'Continue'}
                </button>
              )}
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setDownloadActionOpen(false);
                  setSaveDriveDup(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showPackageEditOnly && dn ? (
        <div
          className="dn-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dn-package-edit-title"
        >
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-5 border">
            <h3 id="dn-package-edit-title" className="text-sm font-bold text-gray-900">
              Edit packaging &amp; volume
            </h3>
            <p className="text-[11px] text-gray-600 mt-2">
              Invoice: <span className="font-mono font-semibold">{effectiveInvoice || '—'}</span>
              {!effectiveInvoice ? (
                <span className="block text-amber-800 mt-1">Set invoice number first (Edit invoice).</span>
              ) : null}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
              <select
                className="input-field"
                value={packageTypeDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setPackageTypeDraft(v);
                  if (isIgnorePackageType(v)) {
                    setPackageQtyDraft('');
                    setGrossWeightDraft('');
                    setVolumeDraft('');
                  }
                }}
              >
                <option value="Pallet">Pallet</option>
                <option value="Box">Box</option>
                <option value="Ignore">Ignore</option>
              </select>
              <input
                className="input-field"
                placeholder="Package qty"
                value={packageQtyDraft}
                onChange={(e) => setPackageQtyDraft(e.target.value)}
                disabled={isIgnorePackageType(packageTypeDraft)}
              />
              <input
                className="input-field"
                placeholder="Gross weight (kg)"
                value={grossWeightDraft}
                onChange={(e) => setGrossWeightDraft(e.target.value)}
                disabled={isIgnorePackageType(packageTypeDraft)}
              />
              <input
                className="input-field"
                placeholder="Volume (CBM)"
                value={volumeDraft}
                onChange={(e) => setVolumeDraft(e.target.value)}
                disabled={isIgnorePackageType(packageTypeDraft)}
              />
            </div>
            <div className="flex flex-wrap gap-2 mt-4 justify-end">
              <button
                type="button"
                className="btn-secondary"
                disabled={packageEditBusy}
                onClick={() => setShowPackageEditOnly(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={packageEditBusy || !effectiveInvoice}
                onClick={() => void savePackageEditOnly()}
              >
                {packageEditBusy ? 'Saving…' : 'Save packaging'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showInvoiceEditOnly && dn ? (
        <div
          className="dn-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dn-invoice-edit-title"
        >
          <div className="bg-white rounded-xl shadow-lg max-w-sm w-full p-5 border">
            <h3 id="dn-invoice-edit-title" className="text-sm font-bold text-gray-900">
              {hasInvoice ? 'Edit invoice number' : 'Add invoice number'}
            </h3>
            <p className="text-[11px] text-gray-600 mt-2">
              Updates the invoice on this delivery note and the linked outbound order.
            </p>
            <input
              className="input-field w-full mt-3"
              placeholder="Invoice #"
              value={invoiceDraft}
              onChange={(e) => setInvoiceDraft(e.target.value)}
              autoFocus
            />
            <div className="flex flex-wrap gap-2 mt-4 justify-end">
              <button
                type="button"
                className="btn-secondary"
                disabled={invoiceEditBusy}
                onClick={() => setShowInvoiceEditOnly(false)}
              >
                Cancel
              </button>
              <button type="button" className="btn-primary" disabled={invoiceEditBusy} onClick={() => void saveInvoiceOnly()}>
                {invoiceEditBusy ? 'Saving…' : 'Save invoice'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showInvoicePrompt && dn ? (
        <div
          className="dn-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dn-invoice-dialog-title"
        >
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-5 border">
            <h3 id="dn-invoice-dialog-title" className="text-sm font-bold text-gray-900">
              {invoicePromptPurpose === 'deliver' ? 'Before marking delivered' : 'Invoice & package'}
            </h3>
            <p className="text-sm text-gray-600 mt-2">
              {invoicePromptPurpose === 'deliver' ? (
                <>
                  Confirm invoice and packaging (quantity, weight, volume). Uploading files to Drive is{' '}
                  <strong>not</strong> required here — use Document Workflow when you need that.
                </>
              ) : (
                <>
                  Invoice number is required. Choose <strong>Ignore</strong> for package type if you do not need pallet/box
                  quantity, weight, or volume on this delivery note.
                </>
              )}
            </p>
            <input
              className="input-field w-full mt-3"
              placeholder="Invoice #"
              value={invoiceDraft}
              onChange={(e) => setInvoiceDraft(e.target.value)}
              autoFocus
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
              <select
                className="input-field"
                value={packageTypeDraft}
                onChange={(e) => {
                  const v = e.target.value;
                  setPackageTypeDraft(v);
                  if (isIgnorePackageType(v)) {
                    setPackageQtyDraft('');
                    setGrossWeightDraft('');
                    setVolumeDraft('');
                  }
                }}
              >
                <option value="Pallet">Pallet</option>
                <option value="Box">Box</option>
                <option value="Ignore">Ignore</option>
              </select>
              <input
                className="input-field"
                placeholder="Package Qty"
                value={packageQtyDraft}
                onChange={(e) => setPackageQtyDraft(e.target.value)}
                disabled={isIgnorePackageType(packageTypeDraft)}
              />
              <input
                className="input-field"
                placeholder="gross weight(KG)"
                value={grossWeightDraft}
                onChange={(e) => setGrossWeightDraft(e.target.value)}
                disabled={isIgnorePackageType(packageTypeDraft)}
              />
              <input
                className="input-field"
                placeholder="volume(CBM)"
                value={volumeDraft}
                onChange={(e) => setVolumeDraft(e.target.value)}
                disabled={isIgnorePackageType(packageTypeDraft)}
              />
            </div>
            <div className="flex flex-wrap gap-2 mt-4 justify-end">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  invoicePromptAfterRef.current = null;
                  setInvoicePromptPurpose('general');
                  setShowInvoicePrompt(false);
                }}
              >
                {invoicePromptPurpose === 'deliver' ? 'Cancel' : 'Ignore for now'}
              </button>
              <button type="button" className="btn-primary" onClick={saveInvoiceFromModal}>
                {invoicePromptPurpose === 'deliver'
                  ? 'Save & mark delivered'
                  : isIgnorePackageType(packageTypeDraft)
                    ? 'Save invoice only'
                    : 'Save invoice & package'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showTransportPrompt && dn ? (
        <div className="dn-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="bg-white rounded-xl shadow-lg max-w-lg w-full p-5 border">
            <h3 className="text-sm font-bold text-gray-900">Transportation Method</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
              <label className="text-[11px] font-semibold">
                Transportation Type
                <select
                  className="input-field mt-1"
                  value={transportType}
                  onChange={(e) => {
                    setTransportType(e.target.value);
                    setTransportCarrierId('');
                    setTransportCarrierName('');
                    setTransportDriverId('');
                    setTransportDriverName('');
                    setTransportDriverMobile('');
                    setTransportVehicle('');
                  }}
                >
                  <option value="">Select…</option>
                  <option value="GAPP">GAPP</option>
                  <option value="Rental">Rental</option>
                  <option value="Courier">Courier</option>
                  <option value="Self Collection">Self Collection</option>
                </select>
              </label>

              {transportType === 'GAPP' ? (
                <label className="text-[11px] font-semibold">
                  Carrier
                  <select
                    className="input-field mt-1"
                    value={transportCarrierId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setTransportCarrierId(id);
                      const c = carriers.find((x) => String(x.id) === String(id));
                      setTransportCarrierName(c?.carrier_name || 'GAPP');
                    }}
                  >
                    <option value="">GAPP</option>
                    {carriers
                      .filter((c) => String(c.carrier_type || '').toLowerCase() === 'gapp')
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.carrier_name}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}

              {transportType === 'Rental' ? (
                <label className="text-[11px] font-semibold">
                  Rental Carrier
                  <select
                    className="input-field mt-1"
                    value={transportCarrierId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setTransportCarrierId(id);
                      const c = carriers.find((x) => String(x.id) === String(id));
                      setTransportCarrierName(c?.carrier_name || '');
                    }}
                  >
                    <option value="">Select…</option>
                    {carriers
                      .filter((c) => String(c.carrier_type || '').toLowerCase() === 'rental')
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.carrier_name}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}

              {transportType === 'Courier' ? (
                <label className="text-[11px] font-semibold">
                  Courier Company
                  <select
                    className="input-field mt-1"
                    value={transportCarrierId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setTransportCarrierId(id);
                      const c = carriers.find((x) => String(x.id) === String(id));
                      setTransportCarrierName(c?.carrier_name || '');
                    }}
                  >
                    <option value="">Select…</option>
                    {carriers
                      .filter((c) => String(c.carrier_type || '').toLowerCase() === 'courier')
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.carrier_name}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}

              {transportType === 'GAPP' ? (
                <>
                  <label className="text-[11px] font-semibold">
                    Driver
                    <select
                      className="input-field mt-1"
                      value={transportDriverId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setTransportDriverId(id);
                        const d = drivers.find((x) => String(x.id) === String(id));
                        setTransportDriverName(d?.driver_name || '');
                        setTransportDriverMobile(d?.phone_number || '');
                        const vt = d?.vehicle_type || '';
                        const vn = d?.vehicle_number || '';
                        setTransportVehicle([vt, vn].filter(Boolean).join(' / ') || d?.vehicle || '');
                      }}
                    >
                      <option value="">Select…</option>
                      {drivers
                        .filter((d) => d.is_active)
                        .filter((d) => !transportCarrierId || String(d.carrier_id) === String(transportCarrierId))
                        .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.driver_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[11px] font-semibold">
                    Driver phone
                    <input className="input-field mt-1" value={transportDriverMobile} onChange={(e) => setTransportDriverMobile(e.target.value)} />
                  </label>
                  <label className="text-[11px] font-semibold">
                    Vehicle
                    <input className="input-field mt-1" value={transportVehicle} onChange={(e) => setTransportVehicle(e.target.value)} />
                  </label>
                </>
              ) : null}

              {transportType === 'Rental' ? (
                <>
                  <label className="text-[11px] font-semibold">
                    Truck Type
                    <select className="input-field mt-1" value={truckType} onChange={(e) => setTruckType(e.target.value)}>
                      <option value="">Select…</option>
                      {['Dyna', 'Trailer', 'Lorry', 'Boom Truck', 'Pickup', 'Car'].map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[11px] font-semibold">
                    Truck Quantity
                    <input className="input-field mt-1" value={truckQty} onChange={(e) => setTruckQty(e.target.value)} />
                  </label>
                  <label className="text-[11px] font-semibold sm:col-span-2">
                    Driver from master (optional)
                    <select
                      className="input-field mt-1"
                      value={transportDriverId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setTransportDriverId(id);
                        const d = drivers.find((x) => String(x.id) === String(id));
                        setTransportDriverName(d?.driver_name || '');
                        setTransportDriverMobile(d?.phone_number || '');
                        const vt = d?.vehicle_type || '';
                        const vn = d?.vehicle_number || '';
                        setTransportVehicle([vt, vn].filter(Boolean).join(' / ') || d?.vehicle || '');
                      }}
                    >
                      <option value="">—</option>
                      {drivers
                        .filter((d) => d.is_active)
                        .filter((d) => !transportCarrierId || String(d.carrier_id) === String(transportCarrierId))
                        .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.driver_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[11px] font-semibold">
                    Driver Name (optional)
                    <input className="input-field mt-1" value={transportDriverName} onChange={(e) => setTransportDriverName(e.target.value)} />
                  </label>
                  <label className="text-[11px] font-semibold">
                    Driver Mobile (optional)
                    <input className="input-field mt-1" value={transportDriverMobile} onChange={(e) => setTransportDriverMobile(e.target.value)} />
                  </label>
                </>
              ) : null}

              {transportType === 'Courier' ? (
                <label className="text-[11px] font-semibold sm:col-span-2">
                  Waybill Number
                  <input className="input-field mt-1" value={waybillNumber} onChange={(e) => setWaybillNumber(e.target.value)} />
                </label>
              ) : null}

              {transportType === 'Self Collection' ? (
                <>
                  <label className="text-[11px] font-semibold">
                    Carrier (optional)
                    <select
                      className="input-field mt-1"
                      value={transportCarrierId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setTransportCarrierId(id);
                        const c = carriers.find((x) => String(x.id) === String(id));
                        setTransportCarrierName(c?.carrier_name || '');
                      }}
                    >
                      <option value="">—</option>
                      {carriers
                        .filter((c) => String(c.carrier_type || '').toLowerCase() === 'self collection')
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.carrier_name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="text-[11px] font-semibold">
                    Driver from master (optional)
                    <select
                      className="input-field mt-1"
                      value={transportDriverId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setTransportDriverId(id);
                        const d = drivers.find((x) => String(x.id) === String(id));
                        setTransportDriverName(d?.driver_name || '');
                        setTransportDriverMobile(d?.phone_number || '');
                        const vt = d?.vehicle_type || '';
                        const vn = d?.vehicle_number || '';
                        setTransportVehicle([vt, vn].filter(Boolean).join(' / ') || d?.vehicle || '');
                      }}
                    >
                      <option value="">—</option>
                      {drivers
                        .filter((d) => d.is_active)
                        .filter((d) => !transportCarrierId || String(d.carrier_id) === String(transportCarrierId))
                        .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.driver_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[11px] font-semibold">
                    Collector Name (optional)
                    <input className="input-field mt-1" value={collectorName} onChange={(e) => setCollectorName(e.target.value)} />
                  </label>
                  <label className="text-[11px] font-semibold">
                    Collector Mobile (optional)
                    <input className="input-field mt-1" value={collectorMobile} onChange={(e) => setCollectorMobile(e.target.value)} />
                  </label>
                </>
              ) : null}

              <label className="text-[11px] font-semibold sm:col-span-2">
                Remarks (optional)
                <input className="input-field mt-1" value={transportRemarks} onChange={(e) => setTransportRemarks(e.target.value)} />
              </label>
            </div>

            <div className="flex flex-wrap gap-2 mt-4 justify-end">
              <button type="button" className="btn-secondary" onClick={() => setShowTransportPrompt(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={saveTransport}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showAdminCloseDialog && dn ? (
        <div
          className="dn-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-5 border">
            <h3 className="text-sm font-bold text-gray-900">Close order (admin)</h3>
            <p className="text-sm text-gray-600 mt-2">
              Closing will lock the order permanently. Stock is not adjusted until you use Mark Delivered. Continue only if
              the delivery workflow is complete or you intentionally override.
            </p>
            {String(dn.pod_file_path || '').trim() ? (
              <p className="text-xs text-green-800 mt-2">POD is on file — you may close.</p>
            ) : (
              <label className="flex items-center gap-2 mt-3 text-sm">
                <input
                  type="checkbox"
                  checked={adminCloseOverride}
                  onChange={(e) => setAdminCloseOverride(e.target.checked)}
                />
                Admin override (close without POD)
              </label>
            )}
            <div className="flex flex-wrap gap-2 mt-4 justify-end">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setShowAdminCloseDialog(false);
                  setAdminCloseOverride(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary bg-amber-700 hover:bg-amber-800 border-amber-800"
                onClick={() => {
                  if (
                    window.confirm(
                      'Closing will lock the order permanently. Continue?'
                    )
                  ) {
                    runAdminClose();
                  }
                }}
              >
                Close order
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deliveryToOpen && dn ? (
        <div className="dn-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="bg-white rounded-xl shadow-lg max-w-3xl w-full p-5 border max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm font-bold text-gray-900">Delivery To</div>
              <button type="button" className="btn-secondary" onClick={() => setDeliveryToOpen(false)}>
                Close
              </button>
            </div>

            {deliveryToLoading ? <div className="text-sm text-gray-600 mt-3">Loading…</div> : null}

            {!deliveryToLoading && deliveryToCtx && deliveryToPanel === 'main' ? (
              <div className="mt-3">
                <div className="text-[11px] text-gray-800 space-y-1 border-b pb-3 mb-3">
                  <div>
                    <span className="font-semibold">Customer Number:</span>{' '}
                    <span className="tabular-nums">{trim(deliveryToCtx.outbound?.sold_to) || '—'}</span>
                  </div>
                  <div>
                    <span className="font-semibold">Customer Name:</span>{' '}
                    {trim(deliveryToCtx.outbound?.name_1) || trim(deliveryToCtx.outbound?.customer_name) || '—'}
                  </div>
                  <div>
                    <span className="font-semibold">Outbound:</span> {deliveryToCtx.outbound?.outbound_number || '—'}
                  </div>
                  <div>
                    <span className="font-semibold">Sales Doc:</span> {deliveryToCtx.outbound?.sales_doc || '—'}
                  </div>
                  <div>
                    <span className="font-semibold">Customer Reference:</span>{' '}
                    {deliveryToCtx.outbound?.customer_reference || '—'}
                  </div>
                </div>

                {!trim(deliveryToCtx.outbound?.sold_to) ? (
                  <div className="text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-2 text-[12px] mb-3">
                    This outbound has no Sold-to number. Add Sold-to on the outbound order, then retry.
                  </div>
                ) : null}

                {trim(deliveryToCtx.outbound?.sold_to) && !(deliveryToCtx.addresses || []).length ? (
                  <div className="mt-2">
                    <div className="text-red-800 font-semibold text-sm">Customer not found in Address Book</div>
                    <div className="flex flex-wrap gap-2 mt-3">
                      <button type="button" className="btn-primary" onClick={() => setDeliveryToPanel('add')}>
                        Add Customer Address
                      </button>
                      <button type="button" className="btn-secondary" onClick={() => setDeliveryToOpen(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}

                {trim(deliveryToCtx.outbound?.sold_to) && (deliveryToCtx.addresses || []).length > 0 ? (
                  <div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <label className="text-[11px] font-bold text-gray-700">
                        City Name
                        <select
                          className="input-field mt-1"
                          value={deliveryToCity}
                          onChange={(e) => {
                            setDeliveryToCity(e.target.value);
                            setDeliveryToAddrId('');
                          }}
                        >
                          <option value="">All cities</option>
                          {(deliveryToCtx.cities || []).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-[11px] font-bold text-gray-700">
                        Delivery Address
                        <select
                          className="input-field mt-1"
                          value={deliveryToAddrId}
                          onChange={(e) => setDeliveryToAddrId(e.target.value)}
                        >
                          <option value="">Select address…</option>
                          {filteredDeliveryAddresses.map((a) => (
                            <option key={a.id} value={a.id}>
                              {trim(a.address)}
                              {trim(a.city_name) ? ` — ${trim(a.city_name)}` : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {selectedAddrRow ? (
                      <div className="mt-3 border rounded-lg p-3 text-[11px] bg-gray-50 space-y-1">
                        <div className="font-bold text-gray-900 mb-1">Selected Address Preview</div>
                        {trim(selectedAddrRow.company_name) ? (
                          <div>
                            <span className="font-semibold">Company Name:</span> {selectedAddrRow.company_name}
                          </div>
                        ) : null}
                        {trim(selectedAddrRow.city_name) ? (
                          <div>
                            <span className="font-semibold">City Name:</span> {selectedAddrRow.city_name}
                          </div>
                        ) : null}
                        {trim(selectedAddrRow.address) ? (
                          <div>
                            <span className="font-semibold">Address:</span> {selectedAddrRow.address}
                          </div>
                        ) : null}
                        {trim(selectedAddrRow.gps) ? (
                          <div>
                            <span className="font-semibold">GPS:</span> {selectedAddrRow.gps}
                          </div>
                        ) : null}
                        {trim(selectedAddrRow.contact_person) || trim(selectedAddrRow.contact_person_number_1 || selectedAddrRow.contact_person_number) ? (
                          <div>
                            <span className="font-semibold">Contact Person:</span>{' '}
                            {[selectedAddrRow.contact_person, selectedAddrRow.contact_person_number_1 || selectedAddrRow.contact_person_number]
                              .filter(Boolean)
                              .join(' — ')}
                          </div>
                        ) : null}
                        {trim(selectedAddrRow.email_1) ? (
                          <div>
                            <span className="font-semibold">Email:</span> {selectedAddrRow.email_1}
                          </div>
                        ) : null}
                        {trim(selectedAddrRow.designation_job) ? (
                          <div>
                            <span className="font-semibold">Designation / Job:</span> {selectedAddrRow.designation_job}
                          </div>
                        ) : null}
                        {trim(selectedAddrRow.second_name) || trim(selectedAddrRow.second_number) ? (
                          <div>
                            <span className="font-semibold">2nd Contact:</span>{' '}
                            {[selectedAddrRow.second_name, selectedAddrRow.second_number].filter(Boolean).join(' — ')}
                          </div>
                        ) : null}
                        {trim(selectedAddrRow.second_email) ? (
                          <div>
                            <span className="font-semibold">2nd Email:</span> {selectedAddrRow.second_email}
                          </div>
                        ) : null}
                        {trim(selectedAddrRow.designation_job_title_2 || selectedAddrRow.designation_job_2) ? (
                          <div>
                            <span className="font-semibold">Designation / Job title2:</span>{' '}
                            {trim(selectedAddrRow.designation_job_title_2 || selectedAddrRow.designation_job_2)}
                          </div>
                        ) : null}
                        {trim(selectedAddrRow.remarks) ? (
                          <div>
                            <span className="font-semibold">Remarks:</span> {selectedAddrRow.remarks}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-2 mt-4 justify-end">
                      <button type="button" className="btn-secondary" onClick={() => setDeliveryToOpen(false)}>
                        Cancel
                      </button>
                      <button type="button" className="btn-secondary" onClick={() => setDeliveryToPanel('add')}>
                        Add New Address
                      </button>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={!deliveryToAddrId}
                        onClick={async () => {
                          try {
                            if (!dnId || !deliveryToAddrId) return;
                            await deliveryNotesApi.applyDeliveryTo(dnId, {
                              customer_id: Number(deliveryToAddrId),
                              address_source: 'address_book',
                              address_type: trim(selectedAddrRow?.address_type) || 'permanent',
                            });
                            const full = await deliveryNotesApi.get(dnId);
                            setDn(full);
                            setDeliveryToOpen(false);
                          } catch (e) {
                            alert(e?.response?.data?.error || e.message);
                          }
                        }}
                      >
                        Apply to Delivery Note
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {!deliveryToLoading && deliveryToPanel === 'add' ? (
              <div className="mt-4 space-y-2">
                <div className="text-[12px] font-bold text-gray-900">Add Customer Address</div>
                <div className="grid sm:grid-cols-2 gap-2 text-[11px] text-gray-700 border rounded-md p-2 bg-gray-50">
                  <div>
                    <span className="font-semibold">Customer Number</span>
                    <div className="tabular-nums">{trim(deliveryToCtx?.outbound?.sold_to) || '—'}</div>
                  </div>
                  <div>
                    <span className="font-semibold">Company Name</span>
                    <div>
                      {trim(deliveryToCtx?.outbound?.name_1) || trim(deliveryToCtx?.outbound?.customer_name) || '—'}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className="text-[11px] font-bold">
                    City Name
                    <input
                      className="input-field mt-1"
                      value={addAddrForm.city_name}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, city_name: e.target.value }))}
                    />
                  </label>
                  <label className="text-[11px] font-bold sm:col-span-2">
                    Address
                    <textarea
                      className="input-field mt-1 h-16"
                      value={addAddrForm.address}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, address: e.target.value }))}
                    />
                  </label>
                  <label className="text-[11px] font-bold sm:col-span-2">
                    GPS
                    <input
                      className="input-field mt-1"
                      value={addAddrForm.gps}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, gps: e.target.value }))}
                    />
                  </label>
                  <label className="text-[11px] font-bold">
                    Contact Person
                    <input
                      className="input-field mt-1"
                      value={addAddrForm.contact_person}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, contact_person: e.target.value }))}
                    />
                  </label>
                  <label className="text-[11px] font-bold">
                    ContactPersonNumber1
                    <input
                      className="input-field mt-1"
                      value={addAddrForm.contact_number}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, contact_number: e.target.value }))}
                    />
                  </label>
                  <label className="text-[11px] font-bold sm:col-span-2">
                    Email 1
                    <input
                      className="input-field mt-1"
                      value={addAddrForm.email_1}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, email_1: e.target.value }))}
                    />
                  </label>
                  <label className="text-[11px] font-bold sm:col-span-2">
                    Designation / Job
                    <input
                      className="input-field mt-1"
                      value={addAddrForm.designation_job}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, designation_job: e.target.value }))}
                    />
                  </label>
                  <label className="text-[11px] font-bold">
                    2nd Name
                    <input
                      className="input-field mt-1"
                      value={addAddrForm.second_name}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, second_name: e.target.value }))}
                    />
                  </label>
                  <label className="text-[11px] font-bold">
                    2nd Number
                    <input
                      className="input-field mt-1"
                      value={addAddrForm.second_number}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, second_number: e.target.value }))}
                    />
                  </label>
                  <label className="text-[11px] font-bold sm:col-span-2">
                    2nd Email
                    <input
                      className="input-field mt-1"
                      value={addAddrForm.second_email}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, second_email: e.target.value }))}
                    />
                  </label>
                  <label className="text-[11px] font-bold sm:col-span-2">
                    Designation / Job title2
                    <input
                      className="input-field mt-1"
                      value={addAddrForm.designation_job_title_2}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, designation_job_title_2: e.target.value }))}
                    />
                  </label>
                  <label className="text-[11px] font-bold sm:col-span-2">
                    Remarks
                    <textarea
                      className="input-field mt-1 h-14"
                      value={addAddrForm.remarks}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, remarks: e.target.value }))}
                    />
                  </label>
                  <label className="text-[11px] font-bold sm:col-span-2">
                    Address Type
                    <select
                      className="input-field mt-1"
                      value={addAddrForm.address_type}
                      onChange={(e) => setAddAddrForm((s) => ({ ...s, address_type: e.target.value }))}
                    >
                      <option value="permanent">Permanent</option>
                      <option value="temporary">Temporary</option>
                    </select>
                  </label>
                </div>
                <div className="flex flex-wrap gap-2 justify-end pt-2">
                  <button type="button" className="btn-secondary" onClick={() => setDeliveryToPanel('main')}>
                    Back
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={async () => {
                      try {
                        if (!dnId) return;
                        const soldTo = trim(deliveryToCtx?.outbound?.sold_to);
                        if (!soldTo) return alert('Sold-to is missing on this outbound.');
                        const companyName =
                          trim(deliveryToCtx?.outbound?.name_1) ||
                          trim(deliveryToCtx?.outbound?.customer_name) ||
                          'Customer';
                        if (addAddrForm.address_type === 'permanent') {
                          const missing = [];
                          if (!trim(addAddrForm.city_name)) missing.push('City Name');
                          if (!trim(addAddrForm.address)) missing.push('Address');
                          if (!trim(addAddrForm.gps)) missing.push('GPS');
                          if (!trim(addAddrForm.contact_person)) missing.push('Contact Person');
                          if (!trim(addAddrForm.contact_number)) missing.push('ContactPersonNumber1');
                          if (missing.length) return alert(`Missing required fields for Permanent address: ${missing.join(', ')}`);
                        }
                        if (addAddrForm.address_type === 'permanent') {
                          const row = await customersApi.create({
                            customer_number: soldTo,
                            company_name: companyName,
                            city_name: addAddrForm.city_name,
                            address: addAddrForm.address,
                            gps: addAddrForm.gps,
                            contact_person: addAddrForm.contact_person,
                            contact_person_number: addAddrForm.contact_number,
                            contact_person_number_1: addAddrForm.contact_number,
                            email_1: addAddrForm.email_1,
                            designation_job: addAddrForm.designation_job,
                            second_name: addAddrForm.second_name,
                            second_number: addAddrForm.second_number,
                            second_email: addAddrForm.second_email,
                            designation_job_title_2: addAddrForm.designation_job_title_2,
                            designation_job_2: addAddrForm.designation_job_title_2,
                            remarks: addAddrForm.remarks,
                            address_type: 'permanent',
                          });
                          await deliveryNotesApi.applyDeliveryTo(dnId, {
                            customer_id: row.id,
                            address_source: 'address_book',
                            address_type: 'permanent',
                          });
                        } else {
                          await deliveryNotesApi.applyDeliveryTo(dnId, {
                            address_source: 'temporary_manual',
                            address_type: 'temporary',
                            customer_number: soldTo,
                            customer_name: companyName,
                            city_name: addAddrForm.city_name,
                            delivery_address: addAddrForm.address,
                            gps: addAddrForm.gps,
                            contact_person: addAddrForm.contact_person,
                            contact_number: addAddrForm.contact_number,
                            email_1: addAddrForm.email_1,
                            second_name: addAddrForm.second_name,
                            second_number: addAddrForm.second_number,
                            second_email: addAddrForm.second_email,
                            deliver_to_remarks: addAddrForm.remarks,
                          });
                        }
                        const full = await deliveryNotesApi.get(dnId);
                        setDn(full);
                        setDeliveryToOpen(false);
                        setDeliveryToPanel('main');
                      } catch (e) {
                        alert(e?.response?.data?.error || e.message);
                      }
                    }}
                  >
                    Save & Apply to Delivery Note
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}


      {/* Print CSS */}
      <style>{`
        .dn-wrap { overflow: hidden; }
        /* border-box: padding counts inside width/height so 297mm page is truly one A4 sheet */
        .dn-page {
          box-sizing: border-box;
          width: 210mm;
          min-height: 297mm;
          margin: 0 auto;
          padding: 10mm;
          font-family: Arial, sans-serif;
          color: #000;
          background: #fff;
          display: flex;
          flex-direction: column;
        }
        .dn-page-scaled {
          width: 100%;
          transform-origin: top center;
          display: flex;
          flex-direction: column;
        }
        .dn-page-main {
          flex: 0 0 auto;
        }
        .dn-page-body {
          flex: 0 0 auto;
          min-height: 0;
        }
        .dn-top {
          display: grid;
          /* Row 1: title full width. Row 2: company (flex) | DN fields (fixed-ish width). Stops title painting over GAPP block. */
          grid-template-columns: minmax(0, 1fr) auto;
          grid-template-rows: auto auto;
          column-gap: 14px;
          row-gap: 10px;
          align-items: start;
        }
        .dn-company {
          grid-column: 1;
          grid-row: 2;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 8px;
          min-width: 0;
        }
        .dn-logo {
          width: 210px;
          height: auto;
          max-height: 140px;
          object-fit: contain;
          flex-shrink: 0;
        }
        .dn-company-text { padding-top: 0; min-width: 0; width: 100%; max-width: 100%; }
        .dn-company-name { font-weight: 700; font-size: 17px; }
        .dn-company-name-red { color: #c1121f; }
        .dn-company-address { font-size: 11px; line-height: 1.2; margin-top: 2px; }
        .dn-company-contact-lines {
          font-size: 10px;
          line-height: 1.35;
          margin-top: 4px;
          color: #000;
        }
        .dn-company-site {
          display: inline-block;
          margin-top: 2px;
          color: #0b5bd3;
          text-decoration: underline;
          word-break: break-all;
        }
        .dn-title-block {
          grid-column: 1 / -1;
          grid-row: 1;
          text-align: center;
          width: 100%;
          min-width: 0;
          padding-top: 0;
          align-self: center;
        }
        /* Full-width row — no overlap into company column */
        .dn-title { font-weight: 900; font-size: 22px; letter-spacing: 1px; line-height: 1.15; white-space: nowrap; }
        .dn-declaration-line { display: none; }
        .dn-right-stack {
          grid-column: 2;
          grid-row: 2;
          display: flex;
          flex-direction: column;
          gap: 14px;
          align-items: flex-end;
          justify-self: end;
          min-width: 0;
        }

        /* Header: labels outside, only value boxes bordered (like screenshot) */
        .dn-headgrid { width: 270px; font-size: 11px; }
        .dn-headrow { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 6px; margin: 2px 0; }
        .dn-headkey { text-align: right; font-weight: 700; }
        .dn-headval { border: 1px solid #000; height: 18px; padding: 2px 6px; display: flex; align-items: center; }

        /* SPO row: label outside + single bordered value box */
        .dn-spo-only { width: 270px; }
        .dn-spo-row { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 6px; }
        .dn-spo-key { text-align: right; font-weight: 700; font-size: 11px; }
        .dn-spo-val {
          border: 1px solid #000;
          height: 18px;
          padding: 2px 6px;
          display: flex;
          align-items: center;
          font-size: 11px;
          font-weight: 700;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }

        /* Delivery + contact share one label column so rows align */
        .dn-address-contact-block { margin-top: 10px; }
        .dn-address-contact-block .dn-delivery,
        .dn-address-contact-block .dn-contact {
          display: grid;
          grid-template-columns: 95px 1fr;
          gap: 6px;
          align-items: start;
        }
        .dn-address-contact-block .dn-delivery { margin-top: 0; }
        .dn-address-contact-block .dn-contact { margin-top: 6px; }
        .dn-address-contact-block .dn-contact-1row { margin-top: 8px; }

        /* Delivery block */
        .dn-delivery { display: grid; grid-template-columns: 95px 1fr; gap: 6px; align-items: start; margin-top: 0; }
        .dn-delivery .lbl { font-size: 10px; font-weight: 700; padding-top: 1px; }
        .dn-delivery-content { min-height: 22px; font-size: 11px; line-height: 1.25; white-space: pre-wrap; }
        .dn-delivery-name { font-weight: 700; }
        .dn-delivery-addr { margin-top: 1px; white-space: pre-wrap; }
        .dn-link { display: inline-block; margin-top: 2px; color: #0b5bd3; text-decoration: underline; word-break: break-all; }

        .dn-contact { display: grid; grid-template-columns: 95px 1fr; align-items: end; gap: 6px; margin-top: 8px; }
        .dn-contact-1row { grid-template-columns: 95px 1fr; align-items: baseline; }
        .dn-inline-underline { display: inline-flex; align-items: baseline; }
        .dn-contact-2 { margin-top: 4px; }
        .dn-contact .lbl { font-size: 10px; font-weight: 700; }
        .dn-inline-underline { min-height: 16px; }
        .dn-under-text { display: inline-block; border-bottom: 1px solid #000; padding-bottom: 2px; font-size: 10px; line-height: 1.1; }

        .dn-grid { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 11px; page-break-inside: auto; }
        .dn-grid th, .dn-grid td { border: 1px solid #000; padding: 4px 6px; }
        .dn-grid th { font-weight: 700; text-align: center; }
        .dn-grid tbody tr { page-break-inside: auto; break-inside: auto; }
        /* Line-items column headers: dim violet tint (matches bg-violet-50/50 panels on this page) */
        .dn-grid thead.dn-items-thead th {
          background-color: #ede9fe;
          color: #111827;
        }
        .dn-row { height: 28px; }
        .dn-grid .c { text-align: center; }

        .dn-summary-block {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 10px;
          row-gap: 4px;
          margin-top: 8px;
          font-size: 11px;
        }
        .dn-summary-cell strong { font-weight: 800; }
        .dn-checked-by-line {
          grid-column: 3;
          display: flex;
          flex-direction: row;
          flex-wrap: nowrap;
          align-items: baseline;
          justify-content: flex-end;
          gap: 6px;
          white-space: nowrap;
          line-height: 1.3;
          page-break-inside: avoid;
          break-inside: avoid;
        }
        .dn-checked-by-label { font-weight: 700; flex-shrink: 0; }
        .dn-checked-by-name { font-weight: 600; }
        .dn-transport { margin-top: 6px; font-size: 11px; display: block; }
        .dn-transport-inner { width: 100%; max-width: none; min-width: 0; }
        .dn-transport-row { display: grid; grid-template-columns: 120px 1fr; gap: 8px; margin: 2px 0; }
        .dn-transport-row .k { font-weight: 700; text-align: left; padding-left: 0; }
        .dn-transport-row .v { min-height: 14px; }
        .dn-transport-empty { color: rgba(0,0,0,0.55); font-weight: 700; }

        .dn-receiver {
          border: 1px solid #000;
          margin-top: 16px;
          padding: 10px 10px 12px;
          font-size: 11px;
          page-break-inside: avoid;
          break-inside: avoid;
        }
        .dn-receiver .cap {
          font-weight: 700;
          line-height: 1.45;
          margin-bottom: 12px;
        }
        .dn-receiver-body {
          display: grid;
          grid-template-columns: 60% 38%;
          column-gap: 2%;
          align-items: start;
        }
        .dn-receiver-col-fields {
          display: grid;
          gap: 14px;
          min-width: 0;
          max-width: 100%;
        }
        .dn-receiver .rrow {
          display: grid;
          grid-template-columns: 88px minmax(0, 1fr);
          align-items: end;
          gap: 8px 10px;
          min-height: 26px;
          max-width: 100%;
        }
        .dn-receiver .k { font-weight: 700; line-height: 1.3; padding-bottom: 3px; white-space: nowrap; }
        .dn-receiver .u {
          border-bottom: 1px solid #000;
          height: 16px;
          min-height: 16px;
          margin-bottom: 2px;
          width: 100%;
          max-width: 100%;
          box-sizing: border-box;
        }
        .dn-receiver-col-stamp {
          display: flex;
          justify-content: center;
          align-items: flex-start;
          min-width: 0;
          padding-top: 2px;
        }
        .dn-stamp-watermark {
          width: 100%;
          max-width: 140px;
          height: 118px;
          border: 2px dashed rgba(0,0,0,0.18);
          color: rgba(0,0,0,0.12);
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 800;
          letter-spacing: 1px;
          font-size: 14px;
          pointer-events: none;
          box-sizing: border-box;
        }

        /* Page x of y: counter lives outside zoomed .dn-page-scaled (Chrome print counters) */
        .dn-page-counter {
          display: none;
          pointer-events: none;
        }
        .dn-preview-scroll .dn-page-counter {
          display: block;
          text-align: right;
          font-size: 9px;
          font-weight: 600;
          color: #6b7280;
          margin-top: 6px;
          padding-right: 2px;
        }
        .dn-preview-scroll .dn-page-counter::after {
          content: attr(data-dn-page-preview);
        }
        /* @page margin is injected by dnPrintDynamicCss (Page setup) */
        @media print {
          /* Kill themed page gradients on in-tab print fallback (see index.css body / .app-shell). */
          html, body, #root, .app-shell, .app-workspace, .app-main {
            background: #fff !important;
            background-image: none !important;
            box-shadow: none !important;
            height: auto !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          /* Default print mode: do not force tinted backgrounds from the UI onto paper/PDF. */
          html, body {
            print-color-adjust: economy;
            -webkit-print-color-adjust: economy;
          }
          .dn-logo {
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
          .dn-wrap,
          .dn-wrap * {
            font-family: Arial, Helvetica, sans-serif !important;
          }
          .dn-wrap {
            border: none !important;
            box-shadow: none !important;
            padding: 0 !important;
            overflow: visible !important;
            max-width: none !important;
            background: #fff !important;
          }
          .dn-page {
            box-sizing: border-box !important;
            width: 100% !important;
            min-height: auto !important;
            height: auto !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            box-shadow: none !important;
            border: none !important;
            page-break-after: auto;
          }
          .dn-page-scaled {
            display: flex !important;
            flex-direction: column !important;
          }
          .dn-page-main {
            flex: 0 0 auto !important;
          }
          .dn-summary-block {
            display: grid !important;
            grid-template-columns: 1fr 1fr 1fr !important;
          }
          .dn-checked-by-line {
            grid-column: 3 !important;
            display: flex !important;
            flex-wrap: nowrap !important;
            justify-content: flex-end !important;
            white-space: nowrap !important;
          }
          .dn-grid {
            page-break-inside: auto !important;
          }
          .dn-grid tbody tr {
            page-break-inside: auto !important;
            break-inside: auto !important;
          }
          .dn-grid thead {
            display: table-header-group;
          }
          .dn-grid thead.dn-items-thead th {
            background-color: #f3f4f6 !important;
            color: #000 !important;
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
          .dn-receiver-body {
            display: grid !important;
            grid-template-columns: 60% 38% !important;
            column-gap: 2% !important;
          }
          .dn-receiver-col-fields { max-width: 100% !important; }
          .dn-receiver .u { max-width: 100% !important; }
          .dn-preview-scroll .dn-page-counter {
            display: none !important;
          }
          .dn-page-counter {
            display: block !important;
            position: fixed;
            bottom: 4mm;
            right: 0;
            font-size: 9px;
            font-weight: 600;
            color: #000 !important;
            z-index: 9999;
            pointer-events: none;
          }
          .dn-page-counter::after {
            content: counter(page) " of " counter(pages);
          }
          .btn-primary, .btn-secondary, header,
          .dn-screen-header, .dn-control-panel, .dn-preview-toolbar,
          .dn-mobile-tabs, .dn-no-print { display: none !important; }
          .dn-screen-root, .dn-shell {
            display: block !important;
            max-height: none !important;
            min-height: 0 !important;
            overflow: visible !important;
          }
          .dn-shell {
            grid-template-columns: 1fr !important;
          }
          .dn-preview-panel, .dn-preview-scroll {
            display: block !important;
            overflow: visible !important;
            padding: 0 !important;
            border: none !important;
            background: #fff !important;
            max-height: none !important;
          }
        }
      `}</style>
      <style>{dnPrintDynamicCss}</style>

      <WhatsAppDnDialog
        open={whatsappDialogOpen}
        onClose={() => setWhatsappDialogOpen(false)}
        dnId={dnId}
        dn={dn}
      />
    </div>
  );
}

