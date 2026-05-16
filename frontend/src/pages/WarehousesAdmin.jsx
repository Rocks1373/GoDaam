import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import { usersApi, warehousesApi } from '../services/api';

export default function WarehousesAdmin() {
  const [rows, setRows] = useState([]);
  const [users, setUsers] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [managerUserId, setManagerUserId] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [wh, u] = await Promise.all([warehousesApi.list(), usersApi.list().catch(() => [])]);
      setRows(wh);
      setUsers(Array.isArray(u) ? u.filter((x) => Number(x.is_active) !== 0) : []);
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadStaff = async (warehouseId) => {
    try {
      const data = await warehousesApi.getStaff(warehouseId);
      setStaff(data.staff || []);
      if (data.warehouse?.manager_user_id) {
        setManagerUserId(String(data.warehouse.manager_user_id));
      }
    } catch {
      setStaff([]);
    }
  };

  const openCreate = () => {
    setStaff([]);
    setManagerUserId('');
    setForm({
      warehouse_code: '',
      warehouse_name: '',
      warehouse_number: '',
      location: '',
      manager_name: '',
      remarks: '',
      is_active: true,
    });
    setModal('create');
  };

  const openEdit = (w) => {
    setForm({
      id: w.id,
      warehouse_code: w.warehouse_code || '',
      warehouse_name: w.warehouse_name || '',
      warehouse_number: w.warehouse_number ?? '',
      location: w.location || '',
      manager_name: w.manager_name || '',
      remarks: w.remarks || '',
      is_active: !!Number(w.is_active ?? 1),
    });
    setManagerUserId(w.manager_user_id ? String(w.manager_user_id) : '');
    setModal('edit');
    void loadStaff(w.id);
  };

  const save = async () => {
    try {
      const code = String(form.warehouse_code || '').trim();
      const name = String(form.warehouse_name || '').trim();
      if (!code || !name) {
        alert('Warehouse code and name are required.');
        return;
      }
      let whId = form.id;
      if (modal === 'create') {
        const created = await warehousesApi.create({
          warehouse_code: code,
          warehouse_name: name,
          warehouse_number: String(form.warehouse_number || '').trim() || null,
          location: form.location || null,
          manager_name: form.manager_name || null,
          remarks: form.remarks || null,
          is_active: form.is_active,
        });
        whId = created.id;
      } else {
        await warehousesApi.update(form.id, {
          warehouse_name: name,
          warehouse_number: String(form.warehouse_number || '').trim() || null,
          location: form.location || null,
          manager_name: form.manager_name || null,
          remarks: form.remarks || null,
          is_active: form.is_active,
        });
      }
      if (managerUserId && whId) {
        await warehousesApi.assignManager(whId, Number(managerUserId));
      }
      setModal(null);
      load();
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  };

  const managerLabel = (w) => {
    if (w.manager_username) return `${w.manager_username} (${w.manager_full_name || 'manager'})`;
    return w.manager_name || '—';
  };

  if (loading) return <div className="p-4 text-xs">Loading…</div>;

  return (
    <div>
      <div className="mb-2 flex justify-between items-center gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900">Warehouse management</h2>
          <p className="text-[11px] text-gray-600 max-w-2xl">
            One shared database; each warehouse (WH1, WH2, …) has its own workflow scope. Admin assigns a{' '}
            <strong>manager</strong> user per site. The manager logs in, selects their warehouse in the toolbar, and runs
            outbound / delivery / pick flows for that site only. Stock can still be viewed across warehouses where
            permissions allow. <strong>Drivers are shared</strong> across warehouses; GAPP deliveries only allow the{' '}
            <strong>assigned driver</strong> to confirm pickup on mobile.
          </p>
        </div>
        <button type="button" className="btn-primary flex items-center gap-1" onClick={openCreate}>
          <Plus size={14} />
          Add warehouse
        </button>
      </div>

      <div className="table-container">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="tbl-th">Code</th>
              <th className="tbl-th">Name</th>
              <th className="tbl-th">Reg. #</th>
              <th className="tbl-th">Location</th>
              <th className="tbl-th">Manager (login)</th>
              <th className="tbl-th">Active</th>
              <th className="tbl-th">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(rows || []).map((w) => (
              <tr key={w.id} className="hover:bg-gray-50">
                <td className="tbl-td-nowrap font-mono text-xs">{w.warehouse_code}</td>
                <td className="tbl-td">{w.warehouse_name}</td>
                <td className="tbl-td-nowrap font-mono text-xs">{w.warehouse_number || '—'}</td>
                <td className="tbl-td text-xs">{w.location || '—'}</td>
                <td className="tbl-td text-xs">{managerLabel(w)}</td>
                <td className="tbl-td-nowrap">{Number(w.is_active) ? 'Yes' : 'No'}</td>
                <td className="tbl-td-nowrap">
                  <button type="button" className="btn-secondary !py-1 !px-1.5" onClick={() => openEdit(w)} title="Edit">
                    <Pencil size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal ? (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-xl p-5 w-full max-w-lg space-y-2 my-4 max-h-[90vh] overflow-y-auto">
            <h3 className="font-bold text-sm">{modal === 'create' ? 'Add warehouse' : 'Edit warehouse'}</h3>
            <input
              className="input-field"
              placeholder="Warehouse code (e.g. WH2)"
              value={form.warehouse_code || ''}
              onChange={(e) => setForm({ ...form, warehouse_code: e.target.value })}
              disabled={modal === 'edit'}
            />
            <input
              className="input-field"
              placeholder="Warehouse name"
              value={form.warehouse_name || ''}
              onChange={(e) => setForm({ ...form, warehouse_name: e.target.value })}
            />
            <input
              className="input-field"
              placeholder="Registration / warehouse number (admin-only for other users)"
              value={form.warehouse_number || ''}
              onChange={(e) => setForm({ ...form, warehouse_number: e.target.value })}
            />
            <input
              className="input-field"
              placeholder="Location"
              value={form.location || ''}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
            />
            <label className="block text-[10px] font-bold text-gray-600">Manager user (login account)</label>
            <select
              className="input-field"
              value={managerUserId}
              onChange={(e) => setManagerUserId(e.target.value)}
            >
              <option value="">— Select manager user —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username} · {u.role} {u.full_name ? `(${u.full_name})` : ''}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-gray-500">
              Saves on Submit: sets user role to <strong>manager</strong>, links them to this warehouse, and sets default
              warehouse. Create the user first under Users if needed.
            </p>
            <input
              className="input-field"
              placeholder="Manager display name (optional label)"
              value={form.manager_name || ''}
              onChange={(e) => setForm({ ...form, manager_name: e.target.value })}
            />
            <textarea
              className="input-field min-h-[72px]"
              placeholder="Remarks"
              value={form.remarks || ''}
              onChange={(e) => setForm({ ...form, remarks: e.target.value })}
            />
            <label className="flex items-center gap-2 text-[11px]">
              <input type="checkbox" checked={!!form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              Active
            </label>

            {modal === 'edit' && staff.length > 0 ? (
              <div className="border border-gray-200 rounded-lg p-2 mt-2">
                <div className="text-[10px] font-bold text-gray-700 mb-1">Staff assigned to this warehouse</div>
                <ul className="text-[10px] text-gray-600 space-y-0.5 max-h-32 overflow-y-auto">
                  {staff.map((s) => (
                    <li key={s.user_id}>
                      {s.username} · {s.role} {s.role_in_warehouse ? `(${s.role_in_warehouse})` : ''}
                    </li>
                  ))}
                </ul>
                <p className="text-[10px] text-gray-500 mt-1">
                  Assign pickers/checkers/drivers in <strong>Users</strong> (warehouse checkboxes).
                </p>
              </div>
            ) : null}

            <div className="flex gap-2 pt-2">
              <button type="button" className="btn-primary flex-1" onClick={save}>
                Save
              </button>
              <button type="button" className="btn-secondary flex-1" onClick={() => setModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
