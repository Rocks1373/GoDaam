import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'godam_web_warehouse_id';
const ALL = 'all';

const WarehouseContext = createContext(null);

export function WarehouseProvider({ children, user }) {
  const [warehouses, setWarehouses] = useState([]);
  const [selected, setSelectedState] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw === ALL || raw === '' || raw == null ? ALL : Number(raw) || ALL;
    } catch {
      return ALL;
    }
  });

  useEffect(() => {
    if (!user || typeof user !== 'object') {
      setWarehouses([]);
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

  const value = useMemo(
    () => ({
      warehouses,
      selectedWarehouseId: selected === ALL ? null : selected,
      selectedMode: selected === ALL ? 'all' : 'one',
      setSelectedWarehouse: setSelected,
      isAllWarehouses: selected === ALL,
      isAdmin: roleLower === 'admin',
      isManager,
    }),
    [warehouses, selected, setSelected, roleLower, isManager]
  );

  return <WarehouseContext.Provider value={value}>{children}</WarehouseContext.Provider>;
}

export function useWarehouse() {
  const v = useContext(WarehouseContext);
  if (!v) throw new Error('useWarehouse must be used within WarehouseProvider');
  return v;
}

export { ALL as WAREHOUSE_ALL };
