import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { authApi } from '../services/api';

const STORAGE_KEY = 'godam_web_warehouse_id';
const ALL = 'all';

const WarehouseContext = createContext(null);

function pickAdminDefaultWarehouseId(user, warehouses) {
  const list = Array.isArray(warehouses) ? warehouses : [];
  if (!list.length) return null;
  const def = Number(user?.default_warehouse_id);
  if (def && list.some((w) => Number(w.id) === def)) return def;
  const wh2 = list.find((w) => String(w.warehouse_code || '').toLowerCase() === 'wh2');
  if (wh2?.id) return Number(wh2.id);
  return null;
}

export function WarehouseProvider({ children, user, onUserPatch }) {
  const [warehouses, setWarehouses] = useState([]);
  const [selected, setSelectedState] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw === ALL || raw === '' || raw == null ? ALL : Number(raw) || ALL;
    } catch {
      return ALL;
    }
  });
  const adminLoginDefaultApplied = useRef(null);

  useEffect(() => {
    if (!user || typeof user !== 'object') {
      setWarehouses([]);
      adminLoginDefaultApplied.current = null;
      return;
    }
    try {
      const wh = user.warehouses;
      setWarehouses(Array.isArray(wh) ? wh : []);
    } catch {
      setWarehouses([]);
    }
  }, [user]);

  const setSelected = useCallback((v) => {
    const next = v === ALL || v === 'all' ? ALL : Number(v);
    setSelectedState(Number.isFinite(next) && next > 0 ? next : ALL);
    try {
      if (next === ALL) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  }, []);

  const roleLower = user && typeof user === 'object' ? String(user.role || '').toLowerCase() : '';
  const isManager = roleLower === 'manager';
  const isAdmin = roleLower === 'admin';

  useEffect(() => {
    if (!user || !isManager) return;
    const list = Array.isArray(warehouses) ? warehouses : [];
    if (list.length === 1) {
      setSelected(list[0].id);
      return;
    }
    const def = Number(user.default_warehouse_id);
    if (def && list.some((w) => Number(w.id) === def)) {
      setSelected(def);
    }
  }, [user, warehouses, isManager, setSelected]);

  /** On admin login, default to profile default_warehouse_id (WH2 if unset) so uploads target the right site. */
  useEffect(() => {
    if (!user?.id || !isAdmin) {
      if (!user) adminLoginDefaultApplied.current = null;
      return;
    }
    if (adminLoginDefaultApplied.current === user.id) return;
    const pick = pickAdminDefaultWarehouseId(user, warehouses);
    if (pick) setSelected(pick);
    adminLoginDefaultApplied.current = user.id;
  }, [user, warehouses, isAdmin, setSelected]);

  const saveAdminDefaultWarehouse = useCallback(
    async (warehouseId) => {
      if (!isAdmin) return;
      const wid =
        warehouseId == null || warehouseId === '' || warehouseId === ALL
          ? null
          : Number(warehouseId);
      if (wid != null && (!Number.isFinite(wid) || wid <= 0)) return;
      const data = await authApi.updateDefaultWarehouse(wid);
      onUserPatch?.({ default_warehouse_id: data.default_warehouse_id ?? null });
      if (wid) setSelected(wid);
    },
    [isAdmin, onUserPatch, setSelected]
  );

  const adminDefaultWarehouseId = useMemo(
    () => (isAdmin && user ? pickAdminDefaultWarehouseId(user, warehouses) : null),
    [isAdmin, user, warehouses]
  );

  const value = useMemo(
    () => ({
      warehouses,
      selectedWarehouseId: selected === ALL ? null : selected,
      selectedMode: selected === ALL ? 'all' : 'one',
      setSelectedWarehouse: setSelected,
      isAllWarehouses: selected === ALL,
      isAdmin,
      isManager,
      adminDefaultWarehouseId,
      saveAdminDefaultWarehouse,
      isUsingAdminDefault:
        isAdmin &&
        adminDefaultWarehouseId != null &&
        selected !== ALL &&
        Number(selected) === Number(adminDefaultWarehouseId),
    }),
    [
      warehouses,
      selected,
      setSelected,
      isAdmin,
      isManager,
      adminDefaultWarehouseId,
      saveAdminDefaultWarehouse,
    ]
  );

  return <WarehouseContext.Provider value={value}>{children}</WarehouseContext.Provider>;
}

export function useWarehouse() {
  const v = useContext(WarehouseContext);
  if (!v) throw new Error('useWarehouse must be used within WarehouseProvider');
  return v;
}

export { ALL as WAREHOUSE_ALL };
