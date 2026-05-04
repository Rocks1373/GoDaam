import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Printer, CheckCircle2, FileSpreadsheet } from 'lucide-react';
import { buildDeliveryNoteFilename, downloadDeliveryNoteExcel } from '../utils/deliveryNoteExport';
import { authApi, carriersApi, customersApi, deliveryNotesApi } from '../services/api';
import { useLocation } from 'react-router-dom';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';

export default function DeliveryNote() {
  const location = useLocation();
  const [outboundNumber, setOutboundNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [dnId, setDnId] = useState(null);
  const [dn, setDn] = useState(null);
  const [error, setError] = useState('');
  const [showContact2, setShowContact2] = useState(false);
  const [showInvoicePrompt, setShowInvoicePrompt] = useState(false);
  const [invoiceDraft, setInvoiceDraft] = useState('');
  const [packageTypeDraft, setPackageTypeDraft] = useState('Ignore');
  const [packageQtyDraft, setPackageQtyDraft] = useState('');
  const [grossWeightDraft, setGrossWeightDraft] = useState('');
  const [volumeDraft, setVolumeDraft] = useState('');

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
  const canUploadOutbound = Boolean(me?.permissions?.can_upload_outbound) || isAdmin;
  const dnLocked =
    Number(dn?.is_closed) === 1 || String(dn?.delivery_status || '').toLowerCase() === 'closed';

  const packageValidForConfirm = useMemo(() => {
    if (!dn) return false;
    if (!trim(dn.invoice_number) && !trim(dn.outbound_invoice_number)) return false;
    const pt = String(dn.package_type || '').trim().toLowerCase();
    if (!pt) return false;
    if (pt === 'ignore') return true;
    if (pt === 'pallet') return (Number(dn.pallet_qty) || 0) > 0;
    if (pt === 'box') return (Number(dn.box_qty) || 0) > 0;
    return false;
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

  const gappMarkDeliveredBlocked = useMemo(() => {
    if (!dn || !isGapp) return false;
    if (!dn.confirmed_at) return true;
    if (!Number(dn.is_closed)) return true;
    return false;
  }, [dn, isGapp]);

  const load = async () => {
    setError('');
    setLoading(true);
    try {
      const created = await deliveryNotesApi.createFromOutbound(outboundNumber.trim());
      const id = created?.id;
      setDnId(id);
      const full = await deliveryNotesApi.get(id);
      setDn(full);
      await refreshTimeline(id);

      const invOk = trim(full?.invoice_number) || trim(full?.outbound_invoice_number);
      if (!invOk || !String(full?.package_type || '').trim()) {
        setInvoiceDraft(trim(full?.invoice_number) || trim(full?.outbound_invoice_number));
        setPackageTypeDraft(String(full?.package_type || 'Ignore'));
        const qty = String(full?.package_type || '').toLowerCase() === 'pallet' ? full?.pallet_qty : full?.box_qty;
        setPackageQtyDraft(qty ? String(qty) : '');
        setGrossWeightDraft(full?.gross_weight_kg != null ? String(full.gross_weight_kg) : '');
        setVolumeDraft(full?.volume_cbm != null ? String(full.volume_cbm) : '');
        setShowInvoicePrompt(true);
      } else {
        setShowInvoicePrompt(false);
      }

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
    if (dn && Number(dn.is_closed) === 1) {
      alert('Delivery note is closed — no further edits.');
      return;
    }
    try {
      await deliveryNotesApi.savePackageInfo(dnId, {
        invoice_number: invoiceDraft.trim(),
        package_type: packageTypeDraft,
        package_qty: packageQtyDraft === '' ? 0 : Number(packageQtyDraft),
        gross_weight_kg: grossWeightDraft === '' ? 0 : Number(grossWeightDraft),
        volume_cbm: volumeDraft === '' ? 0 : Number(volumeDraft),
      });
      setShowInvoicePrompt(false);
      const data = await deliveryNotesApi.get(dnId);
      setDn(data);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const deliver = async () => {
    try {
      if (!dnId) return;
      if (gappMarkDeliveredBlocked) {
        alert('GAPP: wait for driver close (POD) after Confirm before Mark Delivered.');
        return;
      }
      if (!hasTransportation) {
        alert('Transportation Method must be saved before Delivered.');
        setShowTransportPrompt(true);
        return;
      }
      if (!hasInvoice || !hasPackageType) {
        alert('Invoice number and Package Type are required before marking delivered.');
        setShowInvoicePrompt(true);
        return;
      }
      await deliveryNotesApi.markDelivered(dnId);
      await load();
      alert('Marked as Delivered. Stock deducted (double deduction prevented).');
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const handleConfirmForDelivery = async () => {
    if (!dnId) return;
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

  // Auto-load when navigated from Picked Orders "Create DN"
  useEffect(() => {
    const sp = new URLSearchParams(location.search || '');
    const ob = String(sp.get('outbound') || '').trim();
    if (!ob) return;
    setOutboundNumber(ob);
    setOutboundTyped(ob);
    setTimeout(() => load(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  useEffect(() => {
    const cId = transportCarrierId ? Number(transportCarrierId) : null;
    if (!cId) {
      setDrivers([]);
      return;
    }
    carriersApi
      .listDrivers(cId)
      .then((rows) => setDrivers(rows || []))
      .catch(() => setDrivers([]));
  }, [transportCarrierId]);

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

  // Sample fallback (so layout comparison works even before loading)
  const view = dn || {
    dn_date: '2026-04-28',
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

  const invoiceForPrint = trim(view?.invoice_number) || trim(view?.outbound_invoice_number) || '';

  /** Only real line items (no blank filler rows); footer total = sum of qty. */
  const lineItems = useMemo(() => (view?.items || []).filter((it) => it != null), [view?.items]);

  const dnItemSortValue = useCallback((it, k) => {
    if (k === 'qty') return Number(it?.qty) || 0;
    if (k === 'part_number') return String(it?.part_number || '');
    if (k === 'description') return String(it?.description || '');
    if (k === 'uom') return String(it?.uom || '');
    if (k === 'serial_no') return String(it?.serial_no || '');
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

  const handlePrintA4 = () => {
    const prevTitle = document.title;
    const base = buildDeliveryNoteFilename(view, '.pdf').replace(/\.pdf$/i, '');
    document.title = base;
    const restore = () => {
      document.title = prevTitle;
    };
    window.addEventListener('afterprint', restore, { once: true });
    window.print();
    setTimeout(restore, 3000);
  };

  const handleExportExcel = () => {
    if (!dn) return;
    try {
      downloadDeliveryNoteExcel({
        view,
        displayItems,
        packageText,
        transportRenderLines,
      });
    } catch (e) {
      alert(e?.message || 'Export failed');
    }
  };

  return (
    <div>
      <div className="mb-2 dn-no-print">
        <h2 className="text-base font-bold text-gray-900 leading-tight">Delivery Note (DN)</h2>
        <p className="text-[11px] text-gray-600">
          A4 print / Save as PDF, and Excel export (same structure). File names: RG_Invoice_Outbound_CustomerPO_CustomerName_GappPO
        </p>
      </div>

      {/* Search bar (required on screens) */}
      <div className="app-page-toolbar dn-screen-toolbar">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="flex items-center gap-3 max-w-lg flex-1">
            <Search size={14} className="text-gray-400 flex-shrink-0" />
            <div className="flex gap-2 flex-1">
              <select
                className="input-field flex-1"
                value={outboundNumber}
                onChange={(e) => {
                  setOutboundNumber(e.target.value);
                  setOutboundTyped('');
                }}
                onFocus={refreshOutboundOptions}
              >
                <option value="">Select Outbound Number…</option>
                {outboundOptions.slice(0, 500).map((o, idx) => (
                  <option key={`${o.outbound_number}-${idx}`} value={o.outbound_number}>
                    {o.outbound_number} · {o.customer_name || ''}{o.customer_reference ? ` · ${o.customer_reference}` : ''}
                  </option>
                ))}
              </select>
              <input
                className="input-field w-44"
                placeholder="Or type…"
                value={outboundTyped}
                onChange={(e) => {
                  const v = e.target.value;
                  setOutboundTyped(v);
                  setOutboundNumber(v);
                }}
              />
              <button type="button" className="btn-secondary whitespace-nowrap" onClick={refreshOutboundOptions}>
                Refresh
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="btn-primary" onClick={load} disabled={loading}>
              {loading ? 'Loading…' : 'Load DN'}
            </button>
            <button
              className="btn-secondary"
              type="button"
              onClick={openTransport}
              disabled={!dn || dnLocked}
              title={!dn ? 'Load a delivery note first' : dnLocked ? 'Closed — no changes' : ''}
            >
              Transportation Method
            </button>
            <button className="btn-secondary flex items-center gap-1" type="button" onClick={handlePrintA4}>
              <Printer size={14} />
              Print / Save PDF
            </button>
            <button
              className="btn-secondary flex items-center gap-1"
              type="button"
              onClick={handleExportExcel}
              disabled={!dn}
              title={!dn ? 'Load a delivery note first' : 'Download Excel in the same structure as the delivery note'}
            >
              <FileSpreadsheet size={14} />
              Export Excel
            </button>
            <button
              className="btn-secondary"
              type="button"
              disabled={!dn || dnLocked}
              onClick={openDeliveryTo}
              title={dnLocked ? 'Closed — no changes' : ''}
            >
              Delivery To
            </button>
            <button
              className="btn-secondary"
              type="button"
              onClick={toggleHold}
              disabled={!dn || dnLocked}
              title={dnLocked ? 'Closed — no changes' : ''}
            >
              {String(dn?.status || '').toLowerCase() === 'on hold' ? 'Resume from Hold' : 'Hold'}
            </button>
            {isGapp && canUploadOutbound ? (
              <button
                type="button"
                className="btn-secondary"
                disabled={!dn || dnLocked || !gappCanConfirm}
                onClick={handleConfirmForDelivery}
                title={
                  dnLocked
                    ? 'Closed'
                    : !gappCanConfirm
                      ? 'Complete Delivery To, GAPP driver/vehicle, and package info'
                      : 'Send confirmation to driver'
                }
              >
                Confirm for Delivery
              </button>
            ) : null}
            {isAdmin ? (
              <button
                type="button"
                className="btn-secondary border-amber-300"
                disabled={!dn || dnLocked}
                onClick={() => {
                  if (dnLocked) return;
                  setShowAdminCloseDialog(true);
                }}
                title="Admin: lock order (POD or override)"
              >
                Close Order (Admin)
              </button>
            ) : null}
            <button
              className="btn-secondary flex items-center gap-1"
              type="button"
              onClick={deliver}
              disabled={!dn || !hasInvoice || !hasPackageType || !hasTransportation || gappMarkDeliveredBlocked}
              title={
                !dn
                  ? 'Load a delivery note first'
                  : !hasInvoice
                    ? 'Add an invoice number before marking delivered'
                    : !hasPackageType
                      ? 'Package type is required'
                      : !hasTransportation
                        ? 'Save transportation method first'
                        : gappMarkDeliveredBlocked
                          ? 'GAPP: Confirm for delivery → driver uploads POD → driver closes (or Admin close). Then Mark Delivered.'
                          : ''
              }
            >
              <CheckCircle2 size={14} />
              Mark Delivered
            </button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          <button
            className="btn-secondary"
            type="button"
            onClick={() => setShowContact2((v) => !v)}
          >
            {showContact2 ? 'Remove Contact Person 2' : 'Add Contact Person 2'}
          </button>
        </div>
        {error ? <div className="text-xs text-red-600 mt-2">{error}</div> : null}
        {dn && (!hasInvoice || !hasPackageType) ? (
          <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mt-2 flex flex-wrap items-center justify-between gap-2">
            <span>
              Delivery note is incomplete without Invoice + Package Type. You can print; marking delivered is blocked
              until saved.
            </span>
            <button type="button" className="text-sm font-medium text-amber-900 underline" onClick={() => setShowInvoicePrompt(true)}>
              Add invoice
            </button>
          </div>
        ) : null}
        {dn && hasInvoice && !dnLocked ? (
          <div className="mt-2">
            <button
              type="button"
              className="text-sm text-gray-600 underline"
              onClick={() => {
                setInvoiceDraft(trim(dn.invoice_number) || trim(dn.outbound_invoice_number));
                setShowInvoicePrompt(true);
              }}
            >
              Change invoice number
            </button>
          </div>
        ) : null}
        {dn ? (
          <>
            <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50/80 p-3 text-[11px] text-gray-800">
              <div className="font-bold text-gray-900 mb-1.5">Delivery status</div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                <span>
                  <span className="text-gray-500">Workflow: </span>
                  <strong>{String(dn.delivery_status || 'Draft')}</strong>
                  {Number(dn.is_closed) ? <span className="ml-1 text-amber-800">(locked)</span> : null}
                </span>
                {isGapp && !dn.confirmed_at ? (
                  <span className="text-amber-800">GAPP requires Confirm before driver flow and Mark Delivered.</span>
                ) : null}
              </div>
              {timeline ? (
                <div className="mt-2 pt-2 border-t border-gray-200">
                  <div className="font-semibold text-gray-800 mb-1">Timeline</div>
                  <ul className="space-y-0.5 list-disc list-inside text-gray-700">
                    <li>Confirmed: {fmtDt(timeline.confirmed_at)}</li>
                    <li>Opened by driver: {fmtDt(timeline.driver_opened_at)}</li>
                    <li>Pickup: {fmtDt(timeline.pickup_confirmed_at)}</li>
                    <li>POD uploaded: {fmtDt(timeline.pod_uploaded_at)}</li>
                    <li>Closed: {fmtDt(timeline.closed_at)}</li>
                  </ul>
                  {timeline.pod_file_path ? (
                    <button type="button" className="mt-1 text-blue-700 underline" onClick={handleViewPod}>
                      View POD
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {/* Hold queue (screen only) */}
      <div className="app-page-toolbar dn-no-print">
        <div className="text-[11px] font-bold text-gray-800 mb-2">On Hold</div>
        {holdRows?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {holdRows.slice(0, 30).map((r) => (
              <button
                key={r.id}
                type="button"
                className="btn-secondary text-[11px]"
                onClick={() => {
                  setOutboundNumber(r.outbound_number || '');
                  setTimeout(() => load(), 0);
                }}
              >
                {r.outbound_number} · {r.customer_name || ''} · {r.invoice_number ? `INV ${r.invoice_number}` : 'No invoice'}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-gray-500">No held delivery notes.</div>
        )}
      </div>

      {showInvoicePrompt && dn ? (
        <div
          className="dn-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dn-invoice-dialog-title"
        >
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-5 border">
            <h3 id="dn-invoice-dialog-title" className="text-sm font-bold text-gray-900">
              Invoice & Package
            </h3>
            <p className="text-sm text-gray-600 mt-2">
              Invoice Number and Package Type are required before marking Delivered.
            </p>
            <input
              className="input-field w-full mt-3"
              placeholder="Invoice #"
              value={invoiceDraft}
              onChange={(e) => setInvoiceDraft(e.target.value)}
              autoFocus
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
              <select className="input-field" value={packageTypeDraft} onChange={(e) => setPackageTypeDraft(e.target.value)}>
                <option value="Pallet">Pallet</option>
                <option value="Box">Box</option>
                <option value="Ignore">Ignore</option>
              </select>
              <input
                className="input-field"
                placeholder="Package Qty"
                value={packageQtyDraft}
                onChange={(e) => setPackageQtyDraft(e.target.value)}
                disabled={packageTypeDraft === 'Ignore'}
              />
              <input
                className="input-field"
                placeholder="gross weight(KG)"
                value={grossWeightDraft}
                onChange={(e) => setGrossWeightDraft(e.target.value)}
              />
              <input
                className="input-field"
                placeholder="volume(CBM)"
                value={volumeDraft}
                onChange={(e) => setVolumeDraft(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-2 mt-4 justify-end">
              <button type="button" className="btn-secondary" onClick={() => setShowInvoicePrompt(false)}>
                Ignore for now
              </button>
              <button type="button" className="btn-primary" onClick={saveInvoiceFromModal}>
                Save invoice
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

      {/* A4 Printable DN */}
      <div className="dn-wrap bg-white border rounded-xl shadow-sm p-4">
        <div className="dn-page" aria-label="Delivery Note A4 Page">
          {/* TOP HEADER */}
          <div className="dn-top">
            <div className="dn-company">
              <img className="dn-logo" src="/LOGO.png" alt="GoDaam" />
              <div className="dn-company-text">
                <div className="dn-company-name dn-company-name-red">Gulf Applications</div>
                <div className="dn-company-address">
                  Apartment 5001, 50th Floor, Kingdom Tower
                  <br />
                  P.O Box 89098, Riyadh, Saudi Arabia
                </div>
                <div className="dn-company-tel">Tel / Fax</div>
              </div>
            </div>

            <div className="dn-title-block">
              <div className="dn-title">DELIVERY NOTE</div>
            </div>

            <div className="dn-right-stack">
              <div className="dn-headgrid" role="table" aria-label="DN Header Fields">
                {[
                  ['DATE', view?.dn_date || ''],
                  ['GAPP PO', view?.gapp_po || ''],
                  ['CUSTOMER PO', view?.customer_po || ''],
                  ['OUTBOUND', view?.outbound_number || ''],
                  ['INVOICE', invoiceForPrint],
                ].map(([k, v]) => (
                  <div className="dn-headrow" role="row" key={k}>
                    <div className="dn-headkey" role="cell">
                      {k}
                    </div>
                    <div className="dn-headval" role="cell">
                      {v}
                    </div>
                  </div>
                ))}
              </div>

              {/* Only SPO is boxed */}
              <div className="dn-spo-only">
                <div className="dn-spo-row">
                  <div className="dn-spo-key">SPO</div>
                  <div className="dn-spo-val">{view?.spo || 'SCHNEIDER STOCK'}</div>
                </div>
              </div>
            </div>
          </div>

          {/* DELIVERY SECTION */}
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
                <a className="dn-link" href={view.gps} target="_blank" rel="noreferrer">
                  {view.gps}
                </a>
              ) : null}
            </div>
          </div>

          {/* CONTACT SECTION */}
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
              <div className="lbl">2nd Contact:</div>
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

          {/* ITEM TABLE */}
          <table className="dn-grid">
            <thead>
              <tr>
                <th style={{ width: '6%' }}>Item #</th>
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
                <tr key={`${it.part_number}-${idx}`} className="dn-row">
                  <td className="c">{idx + 1}</td>
                  <td>{it.part_number || ''}</td>
                  <td>{it.description || ''}</td>
                  <td className="c">{it.qty}</td>
                  <td className="c">{it.uom || ''}</td>
                  <td className="c">{it.serial_no || '-'}</td>
                  <td className="c">{it.condition_text || it.condition || 'New'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* BOTTOM SUMMARY LINE */}
          <div className="dn-summary">
            <div>
              Total: <strong>{packageText || ''}</strong>
            </div>
            <div>
              gross weight(KG): <strong>{Number(view?.gross_weight_kg || 0)}</strong>
            </div>
            <div>
              volume(CBM): <strong>{Number(view?.volume_cbm || 0)}</strong>
            </div>
          </div>

          {/* TRANSPORTATION DETAILS (replaces old static Delivered/Pickup/Name/Mobile/Carrier block) */}
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

          {/* RECEIVER SECTION */}
          <div className="dn-receiver">
            <div className="cap">
              Below fields are mandatory to be filled by the Receiver; stated particulars must be true and correct.
            </div>
            <div className="dn-receiver-body">
              <div className="dn-receiver-left">
                <div className="rrow"><div className="k">NAME</div><div className="u" /></div>
                <div className="rrow"><div className="k">SIGN</div><div className="u" /></div>
                <div className="rrow"><div className="k">Mobile no.</div><div className="u" /></div>
                <div className="rrow"><div className="k">DATE</div><div className="u" /></div>
              </div>
              <div className="dn-receiver-stamp">
                <div className="dn-stamp-watermark">STAMP</div>
              </div>
            </div>
          </div>

          {/* No extra receiver name footer (already captured above) */}
        </div>
      </div>

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
        }
        .dn-top { display: grid; grid-template-columns: 1fr 0.9fr 0.85fr; gap: 10px; align-items: start; }
        /* Logo must be on top, company details below */
        .dn-company { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
        .dn-logo { width: 170px; height: 60px; object-fit: contain; }
        .dn-company-text { padding-top: 0; }
        .dn-company-name { font-weight: 700; font-size: 15px; }
        .dn-company-name-red { color: #c1121f; }
        .dn-company-address { font-size: 11px; line-height: 1.2; margin-top: 2px; }
        .dn-company-tel { font-size: 11px; margin-top: 4px; }
        .dn-title-block { text-align: center; padding-top: 4px; }
        /* Prevent DELIVERY NOTE wrapping/overlapping */
        .dn-title { font-weight: 900; font-size: 24px; letter-spacing: 1px; line-height: 1; white-space: nowrap; }
        .dn-declaration-line { display: none; }
        .dn-right-stack { display: flex; flex-direction: column; gap: 14px; align-items: flex-end; }

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

        /* Delivery block should support multi-line address + Google links */
        .dn-delivery { display: grid; grid-template-columns: 95px 1fr; gap: 6px; align-items: start; margin-top: 10px; }
        .dn-delivery .lbl { font-size: 10px; font-weight: 700; padding-top: 1px; }
        .dn-delivery-content { min-height: 22px; font-size: 11px; line-height: 1.25; white-space: pre-wrap; }
        .dn-delivery-name { font-weight: 700; }
        .dn-delivery-addr { margin-top: 1px; white-space: pre-wrap; }
        .dn-link { display: inline-block; margin-top: 2px; color: #0b5bd3; text-decoration: underline; word-break: break-all; }

        .dn-contact { display: grid; grid-template-columns: 120px 1fr; align-items: end; gap: 6px; margin-top: 8px; }
        .dn-contact-1row { grid-template-columns: 120px 1fr; align-items: baseline; }
        .dn-inline-underline { display: inline-flex; align-items: baseline; }
        .dn-contact-2 { margin-top: 4px; }
        .dn-contact .lbl { font-size: 10px; font-weight: 700; }
        .dn-inline-underline { min-height: 16px; }
        .dn-under-text { display: inline-block; border-bottom: 1px solid #000; padding-bottom: 2px; font-size: 10px; line-height: 1.1; }

        .dn-grid { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 11px; }
        .dn-grid th, .dn-grid td { border: 1px solid #000; padding: 4px 6px; }
        .dn-grid th { font-weight: 700; text-align: center; }
        .dn-row { height: 28px; }
        .dn-grid .c { text-align: center; }

        .dn-summary { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; font-size: 11px; margin-top: 8px; }
        .dn-summary strong { font-weight: 800; }
        /* Transport block should sit directly under Total and align left (not centered). */
        .dn-transport { margin-top: 2px; font-size: 11px; display: block; }
        .dn-transport-inner { width: 100%; max-width: none; min-width: 0; }
        .dn-transport-row { display: grid; grid-template-columns: 120px 1fr; gap: 8px; margin: 2px 0; }
        .dn-transport-row .k { font-weight: 700; text-align: left; padding-left: 0; }
        .dn-transport-row .v { min-height: 14px; }
        .dn-transport-empty { color: rgba(0,0,0,0.55); font-weight: 700; }

        /* Increase gap after Delivered/Pickup/Name/Mobile/Carrier block (≈ +70%) */
        .dn-receiver { border: 1px solid #000; margin-top: 20px; padding: 8px; font-size: 11px; }
        .dn-receiver .cap { font-weight: 700; margin-bottom: 8px; }
        .dn-receiver-body { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 16px; align-items: start; }
        .dn-receiver-left { display: grid; gap: 10px; }
        .dn-receiver .rrow { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 8px; }
        .dn-receiver .k { font-weight: 700; }
        .dn-receiver .u { border-bottom: 1px solid #000; height: 14px; }

        .dn-receiver-stamp { display: flex; justify-content: flex-end; }
        .dn-stamp-watermark {
          width: 150px;
          height: 130px;
          border: 2px solid rgba(0,0,0,0.1);
          color: rgba(0,0,0,0.1);
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: 800;
          letter-spacing: 1px;
          font-size: 16px;
          pointer-events: none;
        }

        /* A4: let the browser apply sheet margins; content then fits the printable area */
        @page {
          size: A4;
          margin: 10mm;
        }
        @media print {
          html, body {
            background: #fff !important;
            height: auto !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
          .dn-wrap {
            border: none !important;
            box-shadow: none !important;
            padding: 0 !important;
            overflow: visible !important;
            max-width: none !important;
          }
          /* Single page when content fits: no forced full-page min-height (that caused a blank 2nd page) */
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
          /* Long tables: continue on additional sheets only when needed */
          .dn-grid {
            page-break-inside: auto;
          }
          .dn-grid thead {
            display: table-header-group;
          }
          .btn-primary, .btn-secondary, header, aside, .dn-screen-toolbar, .dn-no-print { display: none !important; }
        }
      `}</style>
    </div>
  );
}

