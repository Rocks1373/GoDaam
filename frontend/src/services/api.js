import axios from 'axios';

const TOKEN_KEY = 'token';
const TOKEN_EXPIRES_AT_KEY = 'token_expires_at';

function normalizeToken(raw) {
  if (!raw) return '';
  const t = String(raw).trim();
  if (!t) return '';
  // Handle accidentally stringified values like "\"ey...\""
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function getStoredToken() {
  return normalizeToken(localStorage.getItem(TOKEN_KEY));
}

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_EXPIRES_AT_KEY);
    }
    return Promise.reject(error);
  }
);

export const authApi = {
  login: async (username, password) => {
    const res = await api.post('/auth/login', { username, password });
    return res.data;
  },
  me: async () => {
    const res = await api.get('/auth/me');
    return res.data;
  },
  getToken: () => getStoredToken(),
  setToken: (token, expiresAt) => {
    const cleaned = normalizeToken(token);
    if (!cleaned) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_EXPIRES_AT_KEY);
      return;
    }
    localStorage.setItem(TOKEN_KEY, cleaned);
    if (expiresAt) localStorage.setItem(TOKEN_EXPIRES_AT_KEY, String(expiresAt));
    else localStorage.removeItem(TOKEN_EXPIRES_AT_KEY);
  },
  getTokenExpiry: () => localStorage.getItem(TOKEN_EXPIRES_AT_KEY),
  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXPIRES_AT_KEY);
  },
};

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const mainStockApi = {
  list: async (search = '') => (await api.get('/main-stock', { params: { search, limit: 500 } })).data,
  search: async (q) => (await api.get('/main-stock/search', { params: { q } })).data,
  addNewPart: async (payload) => (await api.post('/main-stock/add-new-part', payload)).data,
  manualStockIn: async (payload) => (await api.post('/main-stock/manual-stock-in', payload)).data,
  bulkPaste: async (data) => (await api.post('/main-stock/bulk-paste', { data })).data,
  updateExisting: async (data) => (await api.post('/main-stock/update-existing', { data })).data,
  upload: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/main-stock/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  },
  downloadTemplateXlsx: async () => {
    const res = await api.get('/main-stock/template', { responseType: 'blob' });
    downloadBlob(res.data, 'main-stock-template.xlsx');
  },
};

export const inboundApi = {
  list: async () => (await api.get('/inbound', { params: { limit: 1000 } })).data,
  upload: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/inbound/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  },
  bulkPaste: async (data) => (await api.post('/inbound/bulk-paste', { data })).data,
  downloadTemplateXlsx: async () => {
    const res = await api.get('/inbound/template', { responseType: 'blob' });
    downloadBlob(res.data, 'inbound-template.xlsx');
  },
  putawayReport: async (params = {}) => (await api.get('/inbound/putaway-report', { params })).data,
  applyPutawayToRack: async (inbound_item_ids) =>
    (await api.post('/inbound/apply-putaway-to-rack', { inbound_item_ids })).data,
};

export const reportsApi = {
  outboundPicks: async (params = {}) => (await api.get('/reports/outbound-picks', { params })).data,
};

export const soldOutApi = {
  list: async () => (await api.get('/sold-out', { params: { limit: 2000 } })).data,
  upload: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/sold-out/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  },
  bulkPaste: async (data) => (await api.post('/sold-out/bulk-paste', { data })).data,
  downloadTemplateXlsx: async () => {
    const res = await api.get('/sold-out/template', { responseType: 'blob' });
    downloadBlob(res.data, 'outbound-sold-template.xlsx');
  },
};

export const stockComparisonApi = {
  report: async (params = {}) => (await api.get('/stock-comparison-report', { params })).data,
};

export const stockByRackApi = {
  list: async (params = {}) => (await api.get('/stock-by-rack', { params: { limit: 500, ...params } })).data,
  search: async (params = {}) => (await api.get('/stock-by-rack/search', { params: { limit: 500, ...params } })).data,
};

export const stockInApi = {
  list: async (params = {}) => (await api.get('/stock-in', { params: { limit: 500, ...params } })).data,
  create: async (payload) => (await api.post('/stock-in', payload)).data,
  update: async (id, payload) => (await api.put(`/stock-in/${id}`, payload)).data,
  remove: async (id) => (await api.delete(`/stock-in/${id}`)).data,
  bulkPaste: async (data, { update_existing = false } = {}) =>
    (await api.post('/stock-in/bulk-paste', { data, update_existing })).data,
  upload: async (file, { update_existing = false } = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('update_existing', String(update_existing));
    const res = await api.post('/stock-in/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  },
};

export const stockOutApi = {
  list: async (params = {}) => (await api.get('/stock-out', { params: { limit: 500, ...params } })).data,
  create: async (payload) => (await api.post('/stock-out', payload)).data,
  update: async (id, payload) => (await api.put(`/stock-out/${id}`, payload)).data,
  remove: async (id) => (await api.delete(`/stock-out/${id}`)).data,
  bulkPaste: async (data, { update_existing = false } = {}) =>
    (await api.post('/stock-out/bulk-paste', { data, update_existing })).data,
  upload: async (file, { update_existing = false } = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('update_existing', String(update_existing));
    const res = await api.post('/stock-out/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  },
};

export const customersApi = {
  list: async (search = '') => (await api.get('/customers', { params: { search, limit: 500 } })).data,
  create: async (payload) => (await api.post('/customers', payload)).data,
  update: async (id, payload) => (await api.put(`/customers/${id}`, payload)).data,
  remove: async (id) => (await api.delete(`/customers/${id}`)).data,
  bulkPaste: async (data) => (await api.post('/customers/bulk-paste', { data })).data,
  upload: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/customers/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  },
  byNumber: async (customer_number) =>
    (await api.get(`/customers/by-number/${encodeURIComponent(customer_number)}`)).data,
  byNumberCities: async (customer_number) =>
    (await api.get(`/customers/by-number/${encodeURIComponent(customer_number)}/cities`)).data,
  byNumberAddresses: async (customer_number, city = '') =>
    (
      await api.get(`/customers/by-number/${encodeURIComponent(customer_number)}/addresses`, {
        params: city ? { city } : {},
      })
    ).data,
};

export const deliveryNoteApi = {
  getByOutboundNumber: async (outbound_number) => (await api.get(`/delivery-note/${outbound_number}`)).data,
  deliver: async (outbound_number) => (await api.post(`/delivery-note/${outbound_number}/deliver`)).data,
  setInvoice: async (outbound_number, invoice_number) =>
    (await api.patch(`/delivery-note/${encodeURIComponent(outbound_number)}/invoice`, { invoice_number })).data,
};

export const deliveryNotesApi = {
  createFromOutbound: async (outbound_number) => (await api.post('/delivery-notes', { outbound_number })).data,
  get: async (id) => (await api.get(`/delivery-notes/${id}`)).data,
  outboundOptions: async () => (await api.get('/delivery-notes/outbound-options')).data,
  list: async (params = {}) => (await api.get('/delivery-notes', { params })).data,
  getDeliveryTo: async (id) => (await api.get(`/delivery-notes/${id}/delivery-to`)).data,
  applyDeliveryTo: async (id, payload) => (await api.post(`/delivery-notes/${id}/delivery-to`, payload)).data,
  saveTransportation: async (id, payload) => (await api.post(`/delivery-notes/${id}/transportation`, payload)).data,
  savePackageInfo: async (id, payload) => (await api.post(`/delivery-notes/${id}/package-info`, payload)).data,
  setHold: async (id, is_hold) => (await api.post(`/delivery-notes/${id}/hold`, { is_hold })).data,
  markDelivered: async (id) => (await api.post(`/delivery-notes/${id}/mark-delivered`)).data,
  print: async (id) => (await api.get(`/delivery-notes/${id}/print`)).data,
};

export const carriersApi = {
  list: async (params = {}) => (await api.get('/carriers', { params })).data,
  create: async (payload) => (await api.post('/carriers', payload)).data,
  update: async (id, payload) => (await api.put(`/carriers/${id}`, payload)).data,
  remove: async (id) => (await api.delete(`/carriers/${id}`)).data,
  listDrivers: async (carrier_id) => (await api.get(`/carriers/${carrier_id}/drivers`)).data,
  createDriver: async (carrier_id, payload) => (await api.post(`/carriers/${carrier_id}/drivers`, payload)).data,
};

export const driversApi = {
  update: async (id, payload) => (await api.put(`/drivers/${id}`, payload)).data,
  remove: async (id) => (await api.delete(`/drivers/${id}`)).data,
};

export const vendorsApi = {
  list: async (search = '') => (await api.get('/vendors', { params: { search, limit: 1000 } })).data,
  get: async (id) => (await api.get(`/vendors/${id}`)).data,
  create: async (payload) => (await api.post('/vendors', payload)).data,
  update: async (id, payload) => (await api.put(`/vendors/${id}`, payload)).data,
  remove: async (id) => (await api.delete(`/vendors/${id}`)).data,
  bulkPaste: async (data) => (await api.post('/vendors/bulk-paste', { data })).data,
  upload: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/vendors/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  },
  downloadTemplateXlsx: async () => {
    const res = await api.get('/vendors/template', { responseType: 'blob' });
    downloadBlob(res.data, 'vendors-template.xlsx');
  },
};

export const vendorItemsApi = {
  list: async (params = {}) => (await api.get('/vendor-items', { params })).data,
  search: async (q) => (await api.get('/vendor-items/search', { params: { q } })).data,
  create: async (payload) => (await api.post('/vendor-items', payload)).data,
  update: async (id, payload) => (await api.put(`/vendor-items/${id}`, payload)).data,
  remove: async (id) => (await api.delete(`/vendor-items/${id}`)).data,
  bulkPaste: async (data) => (await api.post('/vendor-items/bulk-paste', { data })).data,
  upload: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/vendor-items/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  },
  downloadTemplateXlsx: async () => {
    const res = await api.get('/vendor-items/template', { responseType: 'blob' });
    downloadBlob(res.data, 'vendor-items-template.xlsx');
  },
};

export const notificationsApi = {
  list: async ({ unread_only = false } = {}) => (await api.get('/notifications', { params: { unread_only } })).data,
  markRead: async (id) => (await api.post(`/notifications/${id}/read`)).data,
};

export const outboundGodamApi = {
  uploadExcel: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/outbound/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  },
  list: async (params = {}) => (await api.get('/outbound', { params })).data,
  get: async (id) => (await api.get(`/outbound/${id}`)).data,
  checkStock: async (id) => (await api.post(`/outbound/${id}/check-stock`)).data,
  generateFifo: async (id) => (await api.post(`/outbound/${id}/generate-fifo`)).data,
  sendForPick: async (id) => (await api.post(`/outbound/${id}/send-for-pick`)).data,
  markDelivered: async (id) => (await api.post(`/outbound/${id}/mark-delivered`)).data,
  /** Alias for spec path POST /api/orders/:id/mark-delivered */
  markDeliveredOrdersPath: async (id) => (await api.post(`/orders/${id}/mark-delivered`)).data,
  /** Undo mark-delivered: restores main stock sold counts, removes delivery guard + sold_out rows for this outbound. */
  reverseDelivery: async (id) => (await api.post(`/outbound/${id}/reverse-delivery`)).data,
  reverseDeliveryOrdersPath: async (id) => (await api.post(`/orders/${id}/reverse-delivery`)).data,
  changePickLocation: async (id, payload) => (await api.post(`/outbound/${id}/change-pick-location`, payload)).data,
  updateFifoQty: async (id, fifoId, suggested_qty) => (await api.put(`/outbound/${id}/fifo/${fifoId}`, { suggested_qty })).data,
  removeFifoLine: async (id, fifoId) => (await api.delete(`/outbound/${id}/fifo/${fifoId}`)).data,
  remove: async (id) => (await api.delete(`/outbound/${id}`)).data,
  updateItemQty: async (outboundId, itemId, required_qty) =>
    (await api.put(`/outbound/${outboundId}/items/${itemId}`, { required_qty })).data,
};

export const usersApi = {
  list: async () => (await api.get('/users')).data,
  create: async (payload) => (await api.post('/users', payload)).data,
  update: async (id, payload) => (await api.put(`/users/${id}`, payload)).data,
  remove: async (id) => (await api.delete(`/users/${id}`)).data,
  disable: async (id) => (await api.post(`/users/${id}/disable`)).data,
  resetPassword: async (id, password) => (await api.post(`/users/${id}/reset-password`, { password })).data,
};

export const rolesApi = {
  getPermissions: async (role) => (await api.get(`/roles/${encodeURIComponent(role)}/permissions`)).data,
  savePermissions: async (role, permissions) =>
    (await api.put(`/roles/${encodeURIComponent(role)}/permissions`, { permissions })).data,
};

export const pickedOrdersApi = {
  list: async (params = {}) => (await api.get('/admin/picked-orders', { params })).data,
  get: async (id) => (await api.get(`/admin/picked-orders/${id}`)).data,
};

/** Admin-only: outbound SQLite domain stats, browse whitelist tables, wipe outbound workflow */
export const maintenanceApi = {
  outboundStats: async () => (await api.get('/admin/maintenance/outbound-stats')).data,
  browseTable: async (table, limit = 100) =>
    (await api.get(`/admin/maintenance/browse/${encodeURIComponent(table)}`, { params: { limit } })).data,
  clearOutboundDomain: async (confirmPhrase) =>
    (await api.post('/admin/maintenance/clear-outbound-domain', { confirmPhrase })).data,
};

export default api;
