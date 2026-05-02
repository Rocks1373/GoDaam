import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { rolesApi } from '../services/api';

const ROLES = ['admin', 'picker', 'checker', 'viewer', 'driver'];

export default function RolePermissions() {
  const [role, setRole] = useState('picker');
  const [perms, setPerms] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async (r) => {
    try {
      setLoading(true);
      const data = await rolesApi.getPermissions(r);
      setPerms(Array.isArray(data) ? data : []);
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(role);
  }, [role]);

  const toggle = (idx) => {
    const next = [...perms];
    next[idx] = { ...next[idx], is_enabled: Number(next[idx].is_enabled) ? 0 : 1 };
    setPerms(next);
  };

  const save = async () => {
    try {
      const payload = perms.map((p) => ({
        permission_key: p.permission_key,
        is_enabled: !!Number(p.is_enabled),
      }));
      const saved = await rolesApi.savePermissions(role, payload);
      setPerms(saved);
      alert('Saved.');
    } catch (e) {
      alert(e.response?.data?.error || e.message);
    }
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-base font-bold text-gray-900">Role permissions</h2>
          <p className="text-[11px] text-gray-600">Uncheck to revoke capability · Admin only</p>
        </div>
        <div>
          <label className="text-[10px] font-bold text-gray-600 block">Role</label>
          <select className="input-field mt-0.5" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="btn-primary flex items-center gap-1" onClick={save} disabled={loading}>
          <Save size={14} />
          Save
        </button>
      </div>

      {loading ? (
        <div className="text-xs">Loading…</div>
      ) : (
        <div className="border rounded-lg divide-y divide-gray-100 bg-white max-w-xl">
          {perms.map((p, idx) => (
            <label key={p.permission_key || idx} className="flex items-center gap-3 px-3 py-2 text-[11px] cursor-pointer hover:bg-gray-50">
              <input type="checkbox" checked={!!Number(p.is_enabled)} onChange={() => toggle(idx)} />
              <span className="font-mono text-[10px] text-gray-800">{p.permission_key}</span>
              <span className="text-gray-600">{p.permission_label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
