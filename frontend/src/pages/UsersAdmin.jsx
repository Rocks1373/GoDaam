import { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Ban, KeyRound } from 'lucide-react';
import { usersApi, warehousesApi } from '../services/api';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';

const ROLES = ['admin', 'picker', 'checker', 'viewer', 'driver'];

function warehouseLabel(list, id) {
  if (id == null || id === '') return '—';
  const w = (list || []).find((x) => Number(x.id) === Number(id));
  return w ? `${w.warehouse_code}` : `#${id}`;
}

export default function UsersAdmin() {
  const [rows, setRows] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [pwdModal, setPwdModal] = useState(null);
  const [pwd, setPwd] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [userRows, wh] = await Promise.all([usersApi.list(), warehousesApi.list().catch(() => [])]);
      setRows(userRows);
      setWarehouses(Array.isArray(wh) ? wh.filter((w) => Number(w.is_active) !== 0) : []);
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
    const first = warehouses[0];
    setForm({
      username: '',
      password: '',
      full_name: '',
      mobile_number: '',
      email: '',
      role: 'picker',
      is_active: true,
      can_access_web: false,
      can_access_mobile: true,
      token_expiry_days: 30,
      warehouse_ids: first ? [first.id] : [],
      default_warehouse_id: first ? first.id : null,
    });
    setModal('create');
  };

  const openEdit = (u) => {
    (async () => {
      let warehouse_ids = [];
      let default_warehouse_id = u.default_warehouse_id ?? null;
      try {
        const a = await usersApi.getWarehouseAssignments(u.id);
        warehouse_ids = Array.isArray(a.warehouse_ids) ? a.warehouse_ids.map(Number) : [];
        default_warehouse_id = a.default_warehouse_id ?? default_warehouse_id;
      } catch (e) {
        alert(e.response?.data?.error || e.message);
        return;
      }
      if (String(u.role || '').toLowerCase() !== 'admin' && !warehouse_ids.length && warehouses.length) {
        warehouse_ids = [warehouses[0].id];
        default_warehouse_id = warehouses[0].id;
      }
      setForm({
        ...u,
        password: '',
        is_active: !!Number(u.is_active),
        can_access_web: !!Number(u.can_access_web),
        can_access_mobile: !!Number(u.can_access_mobile),
        warehouse_ids,
        default_warehouse_id,
      });
      setModal('edit');
    })();
  };

  const toggleWarehouse = (wid) => {
    const id = Number(wid);
    const cur = Array.isArray(form.warehouse_ids) ? [...form.warehouse_ids] : [];
    const i = cur.indexOf(id);
    let next;
    if (i >= 0) {
      next = cur.filter((x) => x !== id);
    } else {
      next = [...cur, id];
    }
    let def = form.default_warehouse_id;
    if (def != null && !next.includes(Number(def))) {
      def = next[0] ?? null;
    }
    setForm({ ...form, warehouse_ids: next, default_warehouse_id: def });
  };

  const save = async () => {
    try {
      const role = String(form.role || 'viewer').toLowerCase();
      const payloadBase = {
        full_name: form.full_name,
        mobile_number: form.mobile_number,
        email: form.email,
        role: form.role,
        is_active: form.is_active,
        can_access_web: form.can_access_web,
        can_access_mobile: form.can_access_mobile,
        token_expiry_days: form.token_expiry_days,
      };
      if (role !== 'admin') {
        const ids = Array.isArray(form.warehouse_ids) ? form.warehouse_ids.map(Number).filter((n) => n > 0) : [];
        if (!ids.length) {
          alert('Non-admin users need at least one warehouse. Select warehouses or set role to admin.');
          return;
        }
        payloadBase.warehouse_ids = ids;
        payloadBase.default_warehouse_id = form.default_warehouse_id != null ? Number(form.default_warehouse_id) : ids[0];
      } else {
        payloadBase.warehouse_ids = [];
        if (form.default_warehouse_id != null && form.default_warehouse_id !== '') {
          payloadBase.default_warehouse_id = Number(form.default_warehouse_id);
        }
      }

      if (modal === 'create') {
        await usersApi.create({
          username: form.username,
          password: form.password,
          ...payloadBase,
        });
      } else if (modal === 'edit') {
        await usersApi.update(form.id, {
          username: form.username,
          ...payloadBase,
        });
      }
      setModal(null);
      load();
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  };

  const disableUser = async (id) => {
    if (!confirm('Disable this user?')) return;
    try {
      await usersApi.disable(id);
      load();
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  };

  const submitPwd = async () => {
    if (!pwdModal || !pwd) return;
    try {
      await usersApi.resetPassword(pwdModal, pwd);
      setPwdModal(null);
      setPwd('');
      alert('Password updated.');
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  };

  const userSortValue = useCallback((r, k) => {
    if (['is_active', 'can_access_web', 'can_access_mobile'].includes(k)) return Number(r[k]) ? 1 : 0;
    return r[k];
  }, []);
  const { displayRows, sortKey, direction, requestSort } = useTableSort(rows, userSortValue);

  if (loading) return <div className="p-4 text-xs">Loading…</div>;

  return (
    <div>
      <div className="mb-2 flex justify-between items-center gap-2">
        <div>
          <h2 className="text-base font-bold text-gray-900">User Management</h2>
          <p className="text-[11px] text-gray-600">Admin only · roles, web/mobile access, warehouse assignment</p>
        </div>
        <button type="button" className="btn-primary flex items-center gap-1" onClick={openCreate}>
          <Plus size={14} />
          Add user
        </button>
      </div>

      <div className="table-container">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <SortTh columnKey="username" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Username
              </SortTh>
              <SortTh columnKey="full_name" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Full name
              </SortTh>
              <SortTh columnKey="role" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Role
              </SortTh>
              <th className="tbl-th">Default WH</th>
              <SortTh columnKey="is_active" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Active
              </SortTh>
              <SortTh columnKey="can_access_web" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Web
              </SortTh>
              <SortTh columnKey="can_access_mobile" sortKey={sortKey} direction={direction} onSort={requestSort}>
                Mobile
              </SortTh>
              <th className="tbl-th">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {displayRows.map((u) => (
              <tr key={u.id} className="hover:bg-gray-50">
                <td className="tbl-td-nowrap">{u.username}</td>
                <td className="tbl-td">{u.full_name || '-'}</td>
                <td className="tbl-td-nowrap">{u.role}</td>
                <td className="tbl-td-nowrap text-xs">
                  {String(u.role || '').toLowerCase() === 'admin' ? 'all' : warehouseLabel(warehouses, u.default_warehouse_id)}
                </td>
                <td className="tbl-td-nowrap">{Number(u.is_active) ? 'Yes' : 'No'}</td>
                <td className="tbl-td-nowrap">{Number(u.can_access_web) ? 'Y' : 'N'}</td>
                <td className="tbl-td-nowrap">{Number(u.can_access_mobile) ? 'Y' : 'N'}</td>
                <td className="tbl-td-nowrap">
                  <div className="flex gap-1">
                    <button type="button" className="btn-secondary !py-1 !px-1.5" onClick={() => openEdit(u)} title="Edit">
                      <Pencil size={14} />
                    </button>
                    <button type="button" className="btn-secondary !py-1 !px-1.5" onClick={() => disableUser(u.id)} title="Disable">
                      <Ban size={14} />
                    </button>
                    <button type="button" className="btn-secondary !py-1 !px-1.5" onClick={() => setPwdModal(u.id)} title="Reset password">
                      <KeyRound size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal ? (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-5 w-full max-w-lg max-h-[90vh] overflow-y-auto space-y-2">
            <h3 className="font-bold text-sm">{modal === 'create' ? 'Add user' : 'Edit user'}</h3>
            <input
              className="input-field"
              placeholder="Username"
              value={form.username || ''}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              disabled={modal === 'edit'}
            />
            {modal === 'create' ? (
              <input
                className="input-field"
                placeholder="Password"
                type="password"
                value={form.password || ''}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            ) : null}
            <input className="input-field" placeholder="Full name" value={form.full_name || ''} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            <input className="input-field" placeholder="Mobile" value={form.mobile_number || ''} onChange={(e) => setForm({ ...form, mobile_number: e.target.value })} />
            <input className="input-field" placeholder="Email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <select
              className="input-field"
              value={form.role || 'picker'}
              onChange={(e) => {
                const nextRole = e.target.value;
                const wasAdmin = String(form.role || '').toLowerCase() === 'admin';
                const nowAdmin = String(nextRole || '').toLowerCase() === 'admin';
                let patch = { ...form, role: nextRole };
                if (wasAdmin && !nowAdmin && warehouses.length) {
                  const ids =
                    Array.isArray(form.warehouse_ids) && form.warehouse_ids.length ? form.warehouse_ids.map(Number) : [warehouses[0].id];
                  patch.warehouse_ids = ids;
                  const d = Number(form.default_warehouse_id);
                  patch.default_warehouse_id = ids.includes(d) ? d : ids[0];
                }
                setForm(patch);
              }}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>

            {String(form.role || '').toLowerCase() === 'admin' ? (
              <>
                <p className="text-[11px] text-gray-600">
                  Admins can access all active warehouses. Optional default is used for the header selector.
                </p>
                <label className="block text-[11px] font-semibold text-gray-800">Optional default warehouse (selector)</label>
                <select
                  className="input-field"
                  value={form.default_warehouse_id ?? ''}
                  onChange={(e) => setForm({ ...form, default_warehouse_id: e.target.value === '' ? null : Number(e.target.value) })}
                >
                  <option value="">— None —</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.warehouse_code} — {w.warehouse_name}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <>
                <p className="text-[11px] font-semibold text-gray-800">Warehouses</p>
                {!warehouses.length ? (
                  <p className="text-[11px] text-amber-800">No active warehouses defined. Add sites under Admin → Warehouses first.</p>
                ) : (
                  <div className="space-y-1 border border-gray-200 rounded-md p-2 max-h-36 overflow-y-auto">
                    {warehouses.map((w) => (
                      <label key={w.id} className="flex items-center gap-2 text-[11px] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Array.isArray(form.warehouse_ids) && form.warehouse_ids.map(Number).includes(Number(w.id))}
                          onChange={() => toggleWarehouse(w.id)}
                        />
                        <span>
                          {w.warehouse_code} — {w.warehouse_name}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <label className="block text-[11px] font-semibold text-gray-800">Default warehouse</label>
                <select
                  className="input-field"
                  value={form.default_warehouse_id ?? ''}
                  onChange={(e) => setForm({ ...form, default_warehouse_id: e.target.value === '' ? null : Number(e.target.value) })}
                >
                  {(Array.isArray(form.warehouse_ids) ? form.warehouse_ids : []).map((wid) => {
                    const w = warehouses.find((x) => Number(x.id) === Number(wid));
                    return (
                      <option key={wid} value={wid}>
                        {w ? `${w.warehouse_code} — ${w.warehouse_name}` : wid}
                      </option>
                    );
                  })}
                </select>
              </>
            )}

            <label className="flex items-center gap-2 text-[11px]">
              <input type="checkbox" checked={!!form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              Active
            </label>
            <label className="flex items-center gap-2 text-[11px]">
              <input type="checkbox" checked={!!form.can_access_web} onChange={(e) => setForm({ ...form, can_access_web: e.target.checked })} />
              Web access
            </label>
            <label className="flex items-center gap-2 text-[11px]">
              <input type="checkbox" checked={!!form.can_access_mobile} onChange={(e) => setForm({ ...form, can_access_mobile: e.target.checked })} />
              Mobile access
            </label>
            <input
              className="input-field"
              placeholder="Token expiry days"
              value={String(form.token_expiry_days ?? 30)}
              onChange={(e) => setForm({ ...form, token_expiry_days: Number(e.target.value) || 30 })}
            />
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

      {pwdModal ? (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-5 w-full max-w-sm space-y-2">
            <h3 className="font-bold text-sm">Reset password</h3>
            <input className="input-field" type="password" placeholder="New password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
            <div className="flex gap-2">
              <button type="button" className="btn-primary flex-1" onClick={submitPwd}>
                Update
              </button>
              <button type="button" className="btn-secondary flex-1" onClick={() => setPwdModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
