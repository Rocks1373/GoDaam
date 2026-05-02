import { useEffect, useMemo, useState } from 'react';
import { Plus, Search, Trash2, Pencil } from 'lucide-react';
import { carriersApi, driversApi } from '../services/api';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';

const TYPE_OPTIONS = ['GAPP', 'Rental', 'Courier', 'Self Collection'];

export default function CarrierMaster() {
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [selectedCarrierId, setSelectedCarrierId] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const selectedCarrier = useMemo(() => rows.find((r) => Number(r.id) === Number(selectedCarrierId)) || null, [rows, selectedCarrierId]);

  const [carrierForm, setCarrierForm] = useState({ carrier_name: '', carrier_type: 'GAPP', is_active: true });
  const [editingCarrierId, setEditingCarrierId] = useState(null);

  const [driverForm, setDriverForm] = useState({ carrier_id: '', driver_name: '', phone_number: '', vehicle: '', is_active: true });
  const [editingDriverId, setEditingDriverId] = useState(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => String(r.carrier_name || '').toLowerCase().includes(q));
  }, [rows, search]);

  const {
    displayRows: carrierRows,
    sortKey: sortCarrierKey,
    direction: carrierDir,
    requestSort: sortCarrierBy,
  } = useTableSort(filtered);

  const {
    displayRows: driverRows,
    sortKey: sortDriverKey,
    direction: driverDir,
    requestSort: sortDriverBy,
  } = useTableSort(drivers);

  const load = async () => {
    setLoading(true);
    try {
      const data = await carriersApi.list();
      setRows(data || []);
      if (!selectedCarrierId && (data?.[0]?.id || null)) setSelectedCarrierId(data[0].id);
    } finally {
      setLoading(false);
    }
  };

  const loadDrivers = async (carrierId) => {
    if (!carrierId) {
      setDrivers([]);
      return;
    }
    const data = await carriersApi.listDrivers(carrierId);
    setDrivers(data || []);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadDrivers(selectedCarrierId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCarrierId]);

  const startEditCarrier = (c) => {
    setEditingCarrierId(c.id);
    setCarrierForm({ carrier_name: c.carrier_name || '', carrier_type: c.carrier_type || 'GAPP', is_active: !!c.is_active });
  };

  const resetCarrierForm = () => {
    setEditingCarrierId(null);
    setCarrierForm({ carrier_name: '', carrier_type: 'GAPP', is_active: true });
  };

  const saveCarrier = async () => {
    const payload = { ...carrierForm, carrier_name: carrierForm.carrier_name.trim() };
    if (!payload.carrier_name) return alert('Carrier name is required');
    try {
      if (editingCarrierId) await carriersApi.update(editingCarrierId, payload);
      else await carriersApi.create(payload);
      resetCarrierForm();
      await load();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const deleteCarrier = async (id) => {
    if (!confirm('Delete this carrier (and its drivers)?')) return;
    try {
      await carriersApi.remove(id);
      if (selectedCarrierId === id) setSelectedCarrierId(null);
      await load();
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const startEditDriver = (d) => {
    setEditingDriverId(d.id);
    setDriverForm({
      carrier_id: String(d.carrier_id ?? selectedCarrierId ?? ''),
      driver_name: d.driver_name || '',
      phone_number: d.phone_number || '',
      vehicle: d.vehicle || '',
      is_active: !!d.is_active,
    });
  };

  const resetDriverForm = () => {
    setEditingDriverId(null);
    setDriverForm({ carrier_id: selectedCarrierId ? String(selectedCarrierId) : '', driver_name: '', phone_number: '', vehicle: '', is_active: true });
  };

  const saveDriver = async () => {
    const carrierId = driverForm.carrier_id ? Number(driverForm.carrier_id) : Number(selectedCarrierId);
    if (!carrierId) return alert('Select a carrier first');
    const payload = { ...driverForm, driver_name: driverForm.driver_name.trim() };
    if (!payload.driver_name) return alert('Driver name is required');
    try {
      if (editingDriverId) await driversApi.update(editingDriverId, payload);
      else await carriersApi.createDriver(carrierId, payload);
      resetDriverForm();
      await loadDrivers(selectedCarrierId || carrierId);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const deleteDriver = async (id) => {
    if (!confirm('Delete this driver?')) return;
    try {
      await driversApi.remove(id);
      await loadDrivers(selectedCarrierId);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  return (
    <div>
      <div className="mb-2">
        <h2 className="text-base font-bold text-gray-900 leading-tight">Carrier Master</h2>
        <p className="text-[11px] text-gray-600">Manage carriers and drivers for DN transportation method</p>
      </div>

      <div className="app-page-toolbar">
        <div className="flex flex-col md:flex-row md:items-end gap-2">
          <div className="flex items-center gap-2 flex-1">
            <Search size={14} className="text-gray-400" />
            <input className="input-field" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search carrier…" />
          </div>
          <button type="button" className="btn-secondary text-[11px]" onClick={load} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        <div className="bg-white border rounded-lg shadow-sm">
          <div className="px-3 py-2 border-b flex items-center justify-between">
            <div className="text-[11px] font-bold text-gray-700">Carriers</div>
            <button type="button" className="btn-secondary !py-1 !px-2 text-[11px]" onClick={resetCarrierForm}>
              <Plus size={14} /> New
            </button>
          </div>

          <div className="p-3 space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <input
                className="input-field"
                placeholder="Carrier name"
                value={carrierForm.carrier_name}
                onChange={(e) => setCarrierForm((s) => ({ ...s, carrier_name: e.target.value }))}
              />
              <select
                className="input-field"
                value={carrierForm.carrier_type}
                onChange={(e) => setCarrierForm((s) => ({ ...s, carrier_type: e.target.value }))}
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-[11px] text-gray-700">
                <input
                  type="checkbox"
                  checked={carrierForm.is_active}
                  onChange={(e) => setCarrierForm((s) => ({ ...s, is_active: e.target.checked }))}
                />
                Active
              </label>
              <button type="button" className="btn-primary text-[11px]" onClick={saveCarrier}>
                {editingCarrierId ? 'Update' : 'Add'} carrier
              </button>
            </div>
          </div>

          <div className="table-container rounded-none border-x-0 border-b-0">
            <table className="min-w-full divide-y divide-gray-200 text-[11px]">
              <thead className="bg-gray-50">
                <tr>
                  <SortTh
                    columnKey="carrier_name"
                    sortKey={sortCarrierKey}
                    direction={carrierDir}
                    onSort={sortCarrierBy}
                  >
                    Carrier
                  </SortTh>
                  <SortTh
                    columnKey="carrier_type"
                    sortKey={sortCarrierKey}
                    direction={carrierDir}
                    onSort={sortCarrierBy}
                  >
                    Type
                  </SortTh>
                  <SortTh
                    columnKey="is_active"
                    sortKey={sortCarrierKey}
                    direction={carrierDir}
                    onSort={sortCarrierBy}
                  >
                    Active
                  </SortTh>
                  <th className="tbl-th w-[120px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr>
                    <td className="tbl-td text-gray-500" colSpan={4}>
                      Loading…
                    </td>
                  </tr>
                ) : null}
                {carrierRows.map((c) => (
                  <tr
                    key={c.id}
                    className={`hover:bg-gray-50 cursor-pointer ${selectedCarrierId === c.id ? 'bg-primary-50' : ''}`}
                    onClick={() => setSelectedCarrierId(c.id)}
                  >
                    <td className="tbl-td">{c.carrier_name}</td>
                    <td className="tbl-td">{c.carrier_type}</td>
                    <td className="tbl-td">{c.is_active ? 'Yes' : 'No'}</td>
                    <td className="tbl-td-nowrap">
                      <button type="button" className="btn-secondary !py-1 !px-2 mr-1" onClick={(e) => { e.stopPropagation(); startEditCarrier(c); }}>
                        <Pencil size={14} />
                      </button>
                      <button type="button" className="btn-secondary !py-1 !px-2" onClick={(e) => { e.stopPropagation(); deleteCarrier(c.id); }}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
                {!loading && !carrierRows.length ? (
                  <tr>
                    <td className="tbl-td text-gray-500" colSpan={4}>
                      No carriers found.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white border rounded-lg shadow-sm">
          <div className="px-3 py-2 border-b flex items-center justify-between">
            <div className="text-[11px] font-bold text-gray-700">
              Drivers{selectedCarrier ? ` · ${selectedCarrier.carrier_name}` : ''}
            </div>
            <button type="button" className="btn-secondary !py-1 !px-2 text-[11px]" onClick={resetDriverForm} disabled={!selectedCarrierId}>
              <Plus size={14} /> New
            </button>
          </div>

          <div className="p-3 space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <select
                className="input-field"
                value={driverForm.carrier_id || (selectedCarrierId ? String(selectedCarrierId) : '')}
                onChange={(e) => setDriverForm((s) => ({ ...s, carrier_id: e.target.value }))}
                disabled={!rows.length}
              >
                <option value="">Select carrier…</option>
                {rows.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.carrier_name} ({c.carrier_type})
                  </option>
                ))}
              </select>
              <input
                className="input-field"
                placeholder="Driver name"
                value={driverForm.driver_name}
                onChange={(e) => setDriverForm((s) => ({ ...s, driver_name: e.target.value }))}
                disabled={!selectedCarrierId && !driverForm.carrier_id}
              />
              <input
                className="input-field"
                placeholder="Phone number"
                value={driverForm.phone_number}
                onChange={(e) => setDriverForm((s) => ({ ...s, phone_number: e.target.value }))}
                disabled={!selectedCarrierId && !driverForm.carrier_id}
              />
              <input
                className="input-field"
                placeholder="Vehicle"
                value={driverForm.vehicle}
                onChange={(e) => setDriverForm((s) => ({ ...s, vehicle: e.target.value }))}
                disabled={!selectedCarrierId && !driverForm.carrier_id}
              />
              <label className="flex items-center gap-2 text-[11px] text-gray-700">
                <input
                  type="checkbox"
                  checked={driverForm.is_active}
                  onChange={(e) => setDriverForm((s) => ({ ...s, is_active: e.target.checked }))}
                  disabled={!selectedCarrierId && !driverForm.carrier_id}
                />
                Active
              </label>
              <button
                type="button"
                className="btn-primary text-[11px]"
                onClick={saveDriver}
                disabled={!selectedCarrierId && !driverForm.carrier_id}
              >
                {editingDriverId ? 'Update' : 'Add'} driver
              </button>
              {selectedCarrierId ? (
                <div className="text-[10px] text-gray-500">
                  Selected carrier ID: <span className="font-mono">{selectedCarrierId}</span>
                </div>
              ) : (
                <div className="text-[10px] text-gray-500">Select a carrier to manage drivers.</div>
              )}
            </div>
          </div>

          <div className="table-container rounded-none border-x-0 border-b-0">
            <table className="min-w-full divide-y divide-gray-200 text-[11px]">
              <thead className="bg-gray-50">
                <tr>
                  <SortTh columnKey="driver_name" sortKey={sortDriverKey} direction={driverDir} onSort={sortDriverBy}>
                    Driver
                  </SortTh>
                  <SortTh columnKey="phone_number" sortKey={sortDriverKey} direction={driverDir} onSort={sortDriverBy}>
                    Phone
                  </SortTh>
                  <SortTh columnKey="vehicle" sortKey={sortDriverKey} direction={driverDir} onSort={sortDriverBy}>
                    Vehicle
                  </SortTh>
                  <SortTh columnKey="is_active" sortKey={sortDriverKey} direction={driverDir} onSort={sortDriverBy}>
                    Active
                  </SortTh>
                  <th className="tbl-th w-[120px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {driverRows.map((d) => (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="tbl-td">{d.driver_name}</td>
                    <td className="tbl-td-nowrap">{d.phone_number || '-'}</td>
                    <td className="tbl-td">{d.vehicle || '-'}</td>
                    <td className="tbl-td">{d.is_active ? 'Yes' : 'No'}</td>
                    <td className="tbl-td-nowrap">
                      <button type="button" className="btn-secondary !py-1 !px-2 mr-1" onClick={() => startEditDriver(d)}>
                        <Pencil size={14} />
                      </button>
                      <button type="button" className="btn-secondary !py-1 !px-2" onClick={() => deleteDriver(d.id)}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
                {!driverRows.length ? (
                  <tr>
                    <td className="tbl-td text-gray-500" colSpan={5}>
                      No drivers for this carrier.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

