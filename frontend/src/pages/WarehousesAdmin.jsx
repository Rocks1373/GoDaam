import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import { warehousesApi } from '../services/api';

export default function WarehousesAdmin() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setRows(await warehousesApi.list());
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
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
    setModal('edit');
  };

  const save = async () => {
    try {
      const code = String(form.warehouse_code || '').trim();
      const name = String(form.warehouse_name || '').trim();
      if (!code || !name) {
        alert('Warehouse code and name are required.');
        return;
      }
      if (modal === 'create') {
        await warehousesApi.create({
          warehouse_code: code,
          warehouse_name: name,
          warehouse_number: String(form.warehouse_number || '').trim() || null,
          location: form.location || null,
          manager_name: form.manager_name || null,
          remarks: form.remarks || null,
          is_active: form.is_active,
        });
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
      setModal(null);
      load();
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  };

  if (loading) return <div className="p-4 text-xs">Loading…</div>;

  return (
    <div>
      <div className="mb-2 flex justify-between items-center gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900">Warehouses</h2>
          <p className="text-[11px] text-gray-600">
            Admin only · sites for multi-warehouse isolation. Registration # is stored for admin reference; non-admin users
            never receive it from the API.
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
              <th className="tbl-th">Manager</th>
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
                <td className="tbl-td text-xs">{w.manager_name || '—'}</td>
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
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-5 w-full max-w-lg space-y-2">
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
            <input
              className="input-field"
              placeholder="Manager name"
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
