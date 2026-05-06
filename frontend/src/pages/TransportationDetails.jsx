import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, FileDown, Paperclip, Eye, Search } from 'lucide-react';
import { transportationApi } from '../services/api';

function isPastDate(iso) {
  if (!iso || !String(iso).trim()) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso).trim());
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = new Date();
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  return d < today;
}

function canAccessPage(user) {
  if (!user) return false;
  if (String(user.role || '').toLowerCase() === 'admin') return true;
  return !!(user.permissions?.can_view_transportation || user.permissions?.can_manage_transportation);
}

function canManage(user) {
  if (!user) return false;
  if (String(user.role || '').toLowerCase() === 'admin') return true;
  return !!user.permissions?.can_manage_transportation;
}

const emptyCarrier = {
  carrier_type: 'GAPP',
  carrier_name: '',
  contact_person: '',
  phone_number: '',
  email: '',
  remarks: '',
  status: 'Active',
};

const emptyDriver = {
  carrier_id: '',
  carrier_type: '',
  carrier_name: '',
  driver_name: '',
  driver_phone: '',
  iqama_number: '',
  iqama_expiry: '',
  license_number: '',
  license_expiry: '',
  national_id: '',
  vehicle_number: '',
  vehicle_type: '',
  vehicle_document_number: '',
  vehicle_document_expiry: '',
  insurance_number: '',
  insurance_expiry: '',
  fahas_number: '',
  fahas_expiry: '',
  remarks: '',
  status: 'Active',
};

export default function TransportationDetails({ user }) {
  const manage = canManage(user);
  const [tab, setTab] = useState('carriers');
  const [carriers, setCarriers] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [driverFilters, setDriverFilters] = useState({
    carrier_type: '',
    carrier_name: '',
    driver_name: '',
    driver_phone: '',
    vehicle_number: '',
    vehicle_type: '',
    status: '',
    expired_documents: false,
    expiring_soon: false,
  });
  const driverFiltersRef = useRef(driverFilters);
  driverFiltersRef.current = driverFilters;

  const [carrierModal, setCarrierModal] = useState(false);
  const [carrierForm, setCarrierForm] = useState(emptyCarrier);
  const [editingCarrierId, setEditingCarrierId] = useState(null);

  const [driverModal, setDriverModal] = useState(false);
  const [driverForm, setDriverForm] = useState(emptyDriver);
  const [editingDriverId, setEditingDriverId] = useState(null);
  const [driverModalCarriers, setDriverModalCarriers] = useState([]);
  const [pendingFiles, setPendingFiles] = useState([]);

  const [viewDriver, setViewDriver] = useState(null);

  const loadCarriers = useCallback(async () => {
    const data = await transportationApi.listCarriers();
    setCarriers(Array.isArray(data) ? data : []);
  }, []);

  const loadDrivers = useCallback(async () => {
    const f = driverFiltersRef.current;
    const params = {};
    if (f.carrier_type) params.carrier_type = f.carrier_type;
    if (f.carrier_name) params.carrier_name = f.carrier_name;
    if (f.driver_name) params.driver_name = f.driver_name;
    if (f.driver_phone) params.driver_phone = f.driver_phone;
    if (f.vehicle_number) params.vehicle_number = f.vehicle_number;
    if (f.vehicle_type) params.vehicle_type = f.vehicle_type;
    if (f.status) params.status = f.status;
    if (f.expired_documents) params.expired_documents = '1';
    if (f.expiring_soon) params.expiring_soon = '1';
    const data = await transportationApi.listDrivers(params);
    setDrivers(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    if (!canAccessPage(user)) return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        await loadCarriers();
      } catch (e) {
        alert(e?.response?.data?.error || e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [user, loadCarriers]);

  useEffect(() => {
    if (!canAccessPage(user) || tab !== 'drivers') return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        await loadDrivers();
      } catch (e) {
        alert(e?.response?.data?.error || e.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [user, tab, loadDrivers]);

  useEffect(() => {
    const t = driverForm.carrier_type;
    if (!t) {
      setDriverModalCarriers([]);
      return;
    }
    setDriverModalCarriers(carriers.filter((c) => String(c.carrier_type) === String(t)));
  }, [driverForm.carrier_type, carriers]);

  const openAddCarrier = () => {
    setEditingCarrierId(null);
    setCarrierForm(emptyCarrier);
    setCarrierModal(true);
  };

  const openEditCarrier = (c) => {
    setEditingCarrierId(c.id);
    setCarrierForm({
      carrier_type: c.carrier_type || 'GAPP',
      carrier_name: c.carrier_name || '',
      contact_person: c.contact_person || '',
      phone_number: c.phone_number || '',
      email: c.email || '',
      remarks: c.remarks || '',
      status: c.status === 'Inactive' ? 'Inactive' : 'Active',
    });
    setCarrierModal(true);
  };

  const saveCarrier = async () => {
    try {
      if (editingCarrierId) await transportationApi.updateCarrier(editingCarrierId, carrierForm);
      else await transportationApi.createCarrier(carrierForm);
      setCarrierModal(false);
      await loadCarriers();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const removeCarrier = async (id) => {
    if (!window.confirm('Delete this carrier and all its drivers?')) return;
    try {
      await transportationApi.deleteCarrier(id);
      await loadCarriers();
      if (tab === 'drivers') await loadDrivers();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const openAddDriver = () => {
    setEditingDriverId(null);
    setDriverForm({ ...emptyDriver, carrier_type: 'GAPP' });
    setPendingFiles([]);
    setDriverModal(true);
  };

  const openEditDriver = async (row) => {
    setEditingDriverId(row.id);
    setDriverForm({
      carrier_id: String(row.carrier_id),
      carrier_type: row.carrier_type || '',
      carrier_name: row.carrier_name || '',
      driver_name: row.driver_name || '',
      driver_phone: row.driver_phone || '',
      iqama_number: row.iqama_number || '',
      iqama_expiry: row.iqama_expiry || '',
      license_number: row.license_number || '',
      license_expiry: row.license_expiry || '',
      national_id: row.national_id || '',
      vehicle_number: row.vehicle_number || '',
      vehicle_type: row.vehicle_type || '',
      vehicle_document_number: row.vehicle_document_number || '',
      vehicle_document_expiry: row.vehicle_document_expiry || '',
      insurance_number: row.insurance_number || '',
      insurance_expiry: row.insurance_expiry || '',
      fahas_number: row.fahas_number || '',
      fahas_expiry: row.fahas_expiry || '',
      remarks: row.remarks || '',
      status: row.status === 'Inactive' ? 'Inactive' : 'Active',
    });
    setPendingFiles([]);
    setDriverModal(true);
  };

  const saveDriver = async () => {
    try {
      const payload = {
        ...driverForm,
        carrier_id: Number(driverForm.carrier_id),
      };
      let id = editingDriverId;
      if (editingDriverId) await transportationApi.updateDriver(editingDriverId, payload);
      else {
        const created = await transportationApi.createDriver(payload);
        id = created?.id;
      }
      if (id && pendingFiles.length) {
        for (const pf of pendingFiles) {
          await transportationApi.uploadAttachment(id, pf.file, pf.attachment_type);
        }
      }
      setDriverModal(false);
      await loadDrivers();
      await loadCarriers();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const deactivateDriver = async (row) => {
    if (!window.confirm('Deactivate this driver?')) return;
    try {
      await transportationApi.updateDriver(row.id, { carrier_id: row.carrier_id, status: 'Inactive' });
      await loadDrivers();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const deleteDriverHard = async (row) => {
    if (!window.confirm('Permanently delete this driver and attachments?')) return;
    try {
      await transportationApi.deleteDriver(row.id);
      await loadDrivers();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const openView = async (id) => {
    try {
      const d = await transportationApi.getDriver(id);
      setViewDriver(d);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const downloadAtt = async (id, name) => {
    try {
      const blob = await transportationApi.downloadAttachment(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name || 'attachment';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const pdfNameFor = (d) => {
    const n = String(d?.driver_name || 'driver').replace(/[^\w\-]+/g, '_');
    const v = String(d?.vehicle_number || '').replace(/[^\w\-]+/g, '_');
    return v ? `driver_${n}_${v}.pdf` : `driver_${n}.pdf`;
  };

  const exportPdf = async (row) => {
    try {
      await transportationApi.exportDriverPdf(row.id, pdfNameFor(row));
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const exportExcel = async () => {
    try {
      const params = {};
      if (driverFilters.carrier_type) params.carrier_type = driverFilters.carrier_type;
      if (driverFilters.carrier_name) params.carrier_name = driverFilters.carrier_name;
      if (driverFilters.driver_name) params.driver_name = driverFilters.driver_name;
      if (driverFilters.driver_phone) params.driver_phone = driverFilters.driver_phone;
      if (driverFilters.vehicle_number) params.vehicle_number = driverFilters.vehicle_number;
      if (driverFilters.vehicle_type) params.vehicle_type = driverFilters.vehicle_type;
      if (driverFilters.status) params.status = driverFilters.status;
      if (driverFilters.expired_documents) params.expired_documents = '1';
      if (driverFilters.expiring_soon) params.expiring_soon = '1';
      await transportationApi.exportDriversExcel(params);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const dateField = (label, key, optional = true) => (
    <label className="block text-[10px] font-bold text-gray-600 mt-2">
      {label} {optional ? '' : '*'}
      <input
        type="date"
        className="input-field mt-0.5 w-full"
        value={driverForm[key] || ''}
        onChange={(e) => setDriverForm((f) => ({ ...f, [key]: e.target.value }))}
      />
      {driverForm[key] && isPastDate(driverForm[key]) ? (
        <span className="text-[10px] text-amber-700 font-semibold">Past date — expiry warning will apply after save.</span>
      ) : null}
    </label>
  );

  const filterChip = useMemo(
    () => (
      <div className="flex flex-wrap gap-2 items-end mb-3">
        <select
          className="input-field text-[11px]"
          value={driverFilters.carrier_type}
          onChange={(e) => setDriverFilters((f) => ({ ...f, carrier_type: e.target.value }))}
        >
          <option value="">Carrier type</option>
          {transportationApi.carrierTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="input-field text-[11px] w-36"
          placeholder="Carrier name"
          value={driverFilters.carrier_name}
          onChange={(e) => setDriverFilters((f) => ({ ...f, carrier_name: e.target.value }))}
        />
        <input
          className="input-field text-[11px] w-32"
          placeholder="Driver name"
          value={driverFilters.driver_name}
          onChange={(e) => setDriverFilters((f) => ({ ...f, driver_name: e.target.value }))}
        />
        <input
          className="input-field text-[11px] w-32"
          placeholder="Driver phone"
          value={driverFilters.driver_phone}
          onChange={(e) => setDriverFilters((f) => ({ ...f, driver_phone: e.target.value }))}
        />
        <input
          className="input-field text-[11px] w-28"
          placeholder="Vehicle #"
          value={driverFilters.vehicle_number}
          onChange={(e) => setDriverFilters((f) => ({ ...f, vehicle_number: e.target.value }))}
        />
        <select
          className="input-field text-[11px]"
          value={driverFilters.vehicle_type}
          onChange={(e) => setDriverFilters((f) => ({ ...f, vehicle_type: e.target.value }))}
        >
          <option value="">Vehicle type</option>
          {transportationApi.vehicleTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          className="input-field text-[11px]"
          value={driverFilters.status}
          onChange={(e) => setDriverFilters((f) => ({ ...f, status: e.target.value }))}
        >
          <option value="">Status</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
        </select>
        <label className="flex items-center gap-1 text-[10px] font-bold text-gray-700">
          <input
            type="checkbox"
            checked={driverFilters.expired_documents}
            onChange={(e) => setDriverFilters((f) => ({ ...f, expired_documents: e.target.checked }))}
          />
          Expired docs
        </label>
        <label className="flex items-center gap-1 text-[10px] font-bold text-gray-700">
          <input
            type="checkbox"
            checked={driverFilters.expiring_soon}
            onChange={(e) => setDriverFilters((f) => ({ ...f, expiring_soon: e.target.checked }))}
          />
          Expiring soon
        </label>
        <button type="button" className="btn-secondary text-[11px]" onClick={() => loadDrivers()}>
          <Search className="w-3 h-3 inline mr-1" />
          Apply
        </button>
      </div>
    ),
    [driverFilters, loadDrivers]
  );

  if (!canAccessPage(user)) {
    return (
      <div className="p-6 max-w-lg">
        <h2 className="text-base font-bold text-gray-900">Transportation Details</h2>
        <p className="text-sm text-gray-600 mt-2">You do not have permission to view this module.</p>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-[100vw]">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Transportation Details</h2>
          <p className="text-[11px] text-gray-600">Carriers and drivers for delivery transportation master data.</p>
        </div>
      </div>

      <div className="flex gap-2 border-b border-gray-200 mb-4">
        <button
          type="button"
          className={`px-3 py-2 text-[12px] font-bold border-b-2 -mb-px ${
            tab === 'carriers' ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-600'
          }`}
          onClick={() => setTab('carriers')}
        >
          Carriers
        </button>
        <button
          type="button"
          className={`px-3 py-2 text-[12px] font-bold border-b-2 -mb-px ${
            tab === 'drivers' ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-600'
          }`}
          onClick={() => {
            setTab('drivers');
            loadDrivers();
          }}
        >
          Drivers
        </button>
      </div>

      {loading ? <div className="text-xs text-gray-500">Loading…</div> : null}

      {tab === 'carriers' && !loading ? (
        <div>
          {manage ? (
            <button type="button" className="btn-primary text-[11px] mb-3" onClick={openAddCarrier}>
              <Plus className="w-3.5 h-3.5 inline mr-1" />
              Add Carrier
            </button>
          ) : null}
          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="min-w-full text-[11px]">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="p-2 font-bold">Type</th>
                  <th className="p-2 font-bold">Name</th>
                  <th className="p-2 font-bold">Contact</th>
                  <th className="p-2 font-bold">Phone</th>
                  <th className="p-2 font-bold">Email</th>
                  <th className="p-2 font-bold">Status</th>
                  {manage ? <th className="p-2 font-bold">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {carriers.map((c) => (
                  <tr key={c.id} className="border-t border-gray-100">
                    <td className="p-2">{c.carrier_type}</td>
                    <td className="p-2 font-semibold">{c.carrier_name}</td>
                    <td className="p-2">{c.contact_person || '—'}</td>
                    <td className="p-2">{c.phone_number || '—'}</td>
                    <td className="p-2">{c.email || '—'}</td>
                    <td className="p-2">{c.status}</td>
                    {manage ? (
                      <td className="p-2 flex gap-1">
                        <button type="button" className="btn-secondary px-2 py-0.5" onClick={() => openEditCarrier(c)}>
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button type="button" className="btn-secondary px-2 py-0.5 text-red-700" onClick={() => removeCarrier(c.id)}>
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
            {!carriers.length ? <p className="p-4 text-xs text-gray-500">No carriers.</p> : null}
          </div>
        </div>
      ) : null}

      {tab === 'drivers' && !loading ? (
        <div>
          <div className="flex flex-wrap gap-2 mb-2">
            {manage ? (
              <button type="button" className="btn-primary text-[11px]" onClick={openAddDriver}>
                <Plus className="w-3.5 h-3.5 inline mr-1" />
                Add Driver
              </button>
            ) : null}
            <button type="button" className="btn-secondary text-[11px]" onClick={exportExcel}>
              <FileDown className="w-3.5 h-3.5 inline mr-1" />
              Export Driver Details Excel
            </button>
          </div>
          {filterChip}
          <div className="overflow-x-auto border border-gray-200 rounded-lg max-h-[70vh] overflow-y-auto">
            <table className="min-w-[1200px] text-[10px]">
              <thead className="bg-gray-50 text-left sticky top-0 z-10">
                <tr>
                  {[
                    'Carrier Type',
                    'Carrier Name',
                    'Driver',
                    'Phone',
                    'Iqama',
                    'Iqama exp',
                    'License',
                    'Lic exp',
                    'Vehicle #',
                    'Veh type',
                    'Ins exp',
                    'Fahas exp',
                    'Status',
                    'Warning',
                    'Att',
                    'Actions',
                  ].map((h) => (
                    <th key={h} className="p-1.5 font-bold whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {drivers.map((d) => (
                  <tr key={d.id} className="border-t border-gray-100">
                    <td className="p-1.5 whitespace-nowrap">{d.carrier_type}</td>
                    <td className="p-1.5 whitespace-nowrap">{d.carrier_name}</td>
                    <td className="p-1.5 whitespace-nowrap">{d.driver_name}</td>
                    <td className="p-1.5 whitespace-nowrap">{d.driver_phone}</td>
                    <td className="p-1.5 whitespace-nowrap">{d.iqama_number || '—'}</td>
                    <td className="p-1.5 whitespace-nowrap">{d.iqama_expiry || '—'}</td>
                    <td className="p-1.5 whitespace-nowrap">{d.license_number || '—'}</td>
                    <td className="p-1.5 whitespace-nowrap">{d.license_expiry || '—'}</td>
                    <td className="p-1.5 whitespace-nowrap">{d.vehicle_number || '—'}</td>
                    <td className="p-1.5 whitespace-nowrap">{d.vehicle_type || '—'}</td>
                    <td className="p-1.5 whitespace-nowrap">{d.insurance_expiry || '—'}</td>
                    <td className="p-1.5 whitespace-nowrap">{d.fahas_expiry || '—'}</td>
                    <td className="p-1.5 whitespace-nowrap">{d.status}</td>
                    <td className="p-1.5 text-amber-800 max-w-[140px]">{d.warning}</td>
                    <td className="p-1.5">{d.attachment_count ?? 0}</td>
                    <td className="p-1.5 whitespace-nowrap">
                      <div className="flex flex-wrap gap-0.5">
                        <button type="button" className="btn-secondary px-1 py-0.5" onClick={() => openView(d.id)}>
                          <Eye className="w-3 h-3" />
                        </button>
                        {manage ? (
                          <>
                            <button type="button" className="btn-secondary px-1 py-0.5" onClick={() => openEditDriver(d)}>
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button type="button" className="btn-secondary px-1 py-0.5" onClick={() => exportPdf(d)} title="Export attachments PDF">
                              <Paperclip className="w-3 h-3" />
                            </button>
                            {d.status === 'Active' ? (
                              <button type="button" className="btn-secondary px-1 py-0.5 text-amber-800" onClick={() => deactivateDriver(d)}>
                                Off
                              </button>
                            ) : null}
                            <button type="button" className="btn-secondary px-1 py-0.5 text-red-700" onClick={() => deleteDriverHard(d)}>
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!drivers.length ? <p className="p-4 text-xs text-gray-500">No drivers match filters.</p> : null}
          </div>
        </div>
      ) : null}

      {carrierModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-lg max-w-md w-full p-5 border max-h-[90vh] overflow-y-auto">
            <h3 className="text-sm font-bold">{editingCarrierId ? 'Edit Carrier' : 'Carrier Registration'}</h3>
            <label className="block text-[10px] font-bold text-gray-600 mt-3">
              Carrier Type *
              <select
                className="input-field mt-0.5 w-full"
                value={carrierForm.carrier_type}
                onChange={(e) => setCarrierForm((f) => ({ ...f, carrier_type: e.target.value }))}
              >
                {transportationApi.carrierTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Carrier Name *
              <input
                className="input-field mt-0.5 w-full"
                value={carrierForm.carrier_name}
                onChange={(e) => setCarrierForm((f) => ({ ...f, carrier_name: e.target.value }))}
              />
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Contact Person
              <input
                className="input-field mt-0.5 w-full"
                value={carrierForm.contact_person}
                onChange={(e) => setCarrierForm((f) => ({ ...f, contact_person: e.target.value }))}
              />
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Phone Number
              <input
                className="input-field mt-0.5 w-full"
                value={carrierForm.phone_number}
                onChange={(e) => setCarrierForm((f) => ({ ...f, phone_number: e.target.value }))}
              />
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Email
              <input
                className="input-field mt-0.5 w-full"
                type="email"
                value={carrierForm.email}
                onChange={(e) => setCarrierForm((f) => ({ ...f, email: e.target.value }))}
              />
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Remarks
              <textarea
                className="input-field mt-0.5 w-full min-h-[60px]"
                value={carrierForm.remarks}
                onChange={(e) => setCarrierForm((f) => ({ ...f, remarks: e.target.value }))}
              />
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Status
              <select
                className="input-field mt-0.5 w-full"
                value={carrierForm.status}
                onChange={(e) => setCarrierForm((f) => ({ ...f, status: e.target.value }))}
              >
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </label>
            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className="btn-secondary" onClick={() => setCarrierModal(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={saveCarrier}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {driverModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-lg max-w-lg w-full p-5 border max-h-[92vh] overflow-y-auto">
            <h3 className="text-sm font-bold">{editingDriverId ? 'Edit Driver' : 'Driver Registration'}</h3>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Carrier Type *
              <select
                className="input-field mt-0.5 w-full"
                value={driverForm.carrier_type}
                onChange={(e) => setDriverForm((f) => ({ ...f, carrier_type: e.target.value, carrier_id: '' }))}
              >
                {transportationApi.carrierTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Carrier *
              <select
                className="input-field mt-0.5 w-full"
                value={driverForm.carrier_id}
                onChange={(e) => {
                  const id = e.target.value;
                  const c = driverModalCarriers.find((x) => String(x.id) === String(id));
                  setDriverForm((f) => ({
                    ...f,
                    carrier_id: id,
                    carrier_name: c?.carrier_name || f.carrier_name,
                  }));
                }}
              >
                <option value="">Select…</option>
                {driverModalCarriers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.carrier_name}
                  </option>
                ))}
              </select>
            </label>
            <hr className="my-3" />
            <label className="block text-[10px] font-bold text-gray-600">
              Driver Name *
              <input
                className="input-field mt-0.5 w-full"
                value={driverForm.driver_name}
                onChange={(e) => setDriverForm((f) => ({ ...f, driver_name: e.target.value }))}
              />
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Driver Phone *
              <input
                className="input-field mt-0.5 w-full"
                value={driverForm.driver_phone}
                onChange={(e) => setDriverForm((f) => ({ ...f, driver_phone: e.target.value }))}
              />
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Iqama Number
              <input
                className="input-field mt-0.5 w-full"
                value={driverForm.iqama_number}
                onChange={(e) => setDriverForm((f) => ({ ...f, iqama_number: e.target.value }))}
              />
            </label>
            {dateField('Iqama Expiry', 'iqama_expiry')}
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              License Number
              <input
                className="input-field mt-0.5 w-full"
                value={driverForm.license_number}
                onChange={(e) => setDriverForm((f) => ({ ...f, license_number: e.target.value }))}
              />
            </label>
            {dateField('License Expiry', 'license_expiry')}
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              National ID
              <input
                className="input-field mt-0.5 w-full"
                value={driverForm.national_id}
                onChange={(e) => setDriverForm((f) => ({ ...f, national_id: e.target.value }))}
              />
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Vehicle Number
              <input
                className="input-field mt-0.5 w-full"
                value={driverForm.vehicle_number}
                onChange={(e) => setDriverForm((f) => ({ ...f, vehicle_number: e.target.value }))}
              />
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Vehicle Type
              <select
                className="input-field mt-0.5 w-full"
                value={driverForm.vehicle_type}
                onChange={(e) => setDriverForm((f) => ({ ...f, vehicle_type: e.target.value }))}
              >
                <option value="">—</option>
                {transportationApi.vehicleTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Vehicle Document Number
              <input
                className="input-field mt-0.5 w-full"
                value={driverForm.vehicle_document_number}
                onChange={(e) => setDriverForm((f) => ({ ...f, vehicle_document_number: e.target.value }))}
              />
            </label>
            {dateField('Vehicle Document Expiry', 'vehicle_document_expiry')}
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Insurance Number
              <input
                className="input-field mt-0.5 w-full"
                value={driverForm.insurance_number}
                onChange={(e) => setDriverForm((f) => ({ ...f, insurance_number: e.target.value }))}
              />
            </label>
            {dateField('Insurance Expiry', 'insurance_expiry')}
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Inspection / Fahas Number
              <input
                className="input-field mt-0.5 w-full"
                value={driverForm.fahas_number}
                onChange={(e) => setDriverForm((f) => ({ ...f, fahas_number: e.target.value }))}
              />
            </label>
            {dateField('Fahas Expiry', 'fahas_expiry')}
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Remarks
              <textarea
                className="input-field mt-0.5 w-full min-h-[50px]"
                value={driverForm.remarks}
                onChange={(e) => setDriverForm((f) => ({ ...f, remarks: e.target.value }))}
              />
            </label>
            <label className="block text-[10px] font-bold text-gray-600 mt-2">
              Status
              <select
                className="input-field mt-0.5 w-full"
                value={driverForm.status}
                onChange={(e) => setDriverForm((f) => ({ ...f, status: e.target.value }))}
              >
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </label>

            {manage ? (
              <div className="mt-4 border-t border-gray-100 pt-3">
                <p className="text-[10px] font-bold text-gray-700 mb-2">Attachments (new uploads apply after save for new drivers)</p>
                <div className="flex flex-wrap gap-2 mb-2">
                  <select id="attType" className="input-field text-[11px] flex-1 min-w-[120px]">
                    {transportationApi.attachmentTypes.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <input
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                    className="text-[10px]"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      const sel = document.getElementById('attType');
                      const attachment_type = sel?.value || 'Other';
                      if (file) setPendingFiles((p) => [...p, { file, attachment_type }]);
                      e.target.value = '';
                    }}
                  />
                </div>
                {pendingFiles.length ? (
                  <ul className="text-[10px] text-gray-700 mb-2">
                    {pendingFiles.map((p, i) => (
                      <li key={i} className="flex justify-between gap-2">
                        <span>
                          {p.attachment_type}: {p.file.name}
                        </span>
                        <button type="button" className="text-red-600" onClick={() => setPendingFiles((x) => x.filter((_, j) => j !== i))}>
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {editingDriverId ? <DriverAttachmentsPanel driverId={editingDriverId} manage={manage} /> : null}
              </div>
            ) : null}

            <div className="flex justify-end gap-2 mt-4">
              <button type="button" className="btn-secondary" onClick={() => setDriverModal(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={saveDriver}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {viewDriver ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-lg max-w-lg w-full p-5 border max-h-[90vh] overflow-y-auto text-[11px]">
            <h3 className="text-sm font-bold">Driver details</h3>
            <p className="mt-2">
              <strong>{viewDriver.driver_name}</strong> · {viewDriver.driver_phone}
            </p>
            <p className="text-gray-600">
              {viewDriver.carrier_type} — {viewDriver.carrier_name}
            </p>
            <p className="text-amber-800 mt-1">Warning: {viewDriver.warning}</p>
            <p className="mt-2 font-bold">Attachments</p>
            <ul className="mt-1 space-y-1">
              {(viewDriver.attachments || []).map((a) => (
                <li key={a.id} className="flex justify-between gap-2 border-b border-gray-100 pb-1">
                  <span>
                    {a.attachment_type}: {a.file_name}
                  </span>
                  <span>
                    <button type="button" className="text-primary-700 font-bold mr-2" onClick={() => downloadAtt(a.id, a.file_name)}>
                      Download
                    </button>
                    {manage ? (
                      <button
                        type="button"
                        className="text-red-700 font-bold"
                        onClick={async () => {
                          if (!window.confirm('Delete attachment?')) return;
                          try {
                            await transportationApi.deleteAttachment(a.id);
                            const d = await transportationApi.getDriver(viewDriver.id);
                            setViewDriver(d);
                          } catch (e) {
                            alert(e?.response?.data?.error || e.message);
                          }
                        }}
                      >
                        Delete
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end mt-4">
              <button type="button" className="btn-secondary" onClick={() => setViewDriver(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DriverAttachmentsPanel({ driverId, manage }) {
  const [rows, setRows] = useState([]);
  const load = useCallback(async () => {
    const data = await transportationApi.listDriverAttachments(driverId);
    setRows(Array.isArray(data) ? data : []);
  }, [driverId]);
  useEffect(() => {
    load();
  }, [load]);

  const downloadAtt = async (id, name) => {
    const blob = await transportationApi.downloadAttachment(id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'attachment';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <ul className="text-[10px] space-y-1">
      {rows.map((a) => (
        <li key={a.id} className="flex justify-between gap-2">
          <span>
            {a.attachment_type}: {a.file_name}
          </span>
          <span>
            <button type="button" className="text-primary-700 font-bold mr-2" onClick={() => downloadAtt(a.id, a.file_name)}>
              Download
            </button>
            {manage ? (
              <button
                type="button"
                className="text-red-700 font-bold"
                onClick={async () => {
                  if (!window.confirm('Delete?')) return;
                  await transportationApi.deleteAttachment(a.id);
                  load();
                }}
              >
                Delete
              </button>
            ) : null}
          </span>
        </li>
      ))}
      {!rows.length ? <li className="text-gray-500">No attachments yet.</li> : null}
    </ul>
  );
}
