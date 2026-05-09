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
  /** Same data as outbound-picks; spec path */
  outbound: async (params = {}) => (await api.get('/reports/outbound', { params })).data,
  inbound: async (params = {}) => (await api.get('/reports/inbound', { params })).data,
  delivery: async (params = {}) => (await api.get('/reports/delivery', { params })).data,
  stockByRackReport: async (params = {}) => (await api.get('/reports/stock-by-rack', { params })).data,
  mainStockReport: async (params = {}) => (await api.get('/reports/main-stock', { params })).data,
  sapStock: async (params = {}) => (await api.get('/reports/sap-stock', { params })).data,
  stockComparison: async (params = {}) => (await api.get('/reports/stock-comparison', { params })).data,
  rackBalanceAdjustments: async (params = {}) => (await api.get('/reports/rack-balance-adjustments', { params })).data,
};

export const dashboardApi = {
  summary: async () => (await api.get('/dashboard/summary')).data,
  recentActivity: async () => (await api.get('/dashboard/recent-activity')).data,
  notifications: async () => (await api.get('/dashboard/notifications')).data,
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

export const sapStockApi = {
  list: async (params = {}) => (await api.get('/sap-stock', { params })).data,
  summary: async (params = {}) => (await api.get('/sap-stock/summary', { params })).data,
  details: async (material) =>
    (await api.get(`/sap-stock/${encodeURIComponent(material)}/details`)).data,
  uploadHistory: async () => (await api.get('/sap-stock/upload-history')).data,
  upload: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/sap-stock/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  },
  updateMainStockSapQty: async (batch_id) =>
    (await api.post('/sap-stock/update-main-stock-sap-qty', { batch_id })).data,
  clearLatestUpload: async () => (await api.post('/sap-stock/clear-latest-upload')).data,
  downloadTemplate: async () => {
    const res = await api.get('/sap-stock/template', { responseType: 'blob' });
    downloadBlob(res.data, 'sap-stock-upload-template.xlsx');
  },
  exportExcel: async () => {
    const res = await api.get('/sap-stock/export', { responseType: 'blob' });
    downloadBlob(res.data, 'sap-stock-export.xlsx');
  },
};

export const stockByRackApi = {
  list: async (params = {}) => (await api.get('/stock-by-rack', { params: { limit: 500, ...params } })).data,
  search: async (params = {}) => (await api.get('/stock-by-rack/search', { params: { limit: 500, ...params } })).data,
  adjust: async (payload) => (await api.post('/stock-by-rack/adjust', payload)).data,
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
  saveContactPerson2: async (id, payload) => (await api.post(`/delivery-notes/${id}/contact-person-2`, payload)).data,
  setHold: async (id, is_hold) => (await api.post(`/delivery-notes/${id}/hold`, { is_hold })).data,
  markDelivered: async (id) => (await api.post(`/delivery-notes/${id}/mark-delivered`)).data,
  print: async (id) => (await api.get(`/delivery-notes/${id}/print`)).data,
  getTimeline: async (id) => (await api.get(`/delivery-notes/${id}/timeline`)).data,
  confirmForDelivery: async (id) => (await api.post(`/delivery-notes/${id}/confirm`)).data,
  closeAdmin: async (id, payload) => (await api.post(`/delivery-notes/${id}/close-admin`, payload)).data,
  downloadPod: async (id) =>
    (await api.get(`/delivery-notes/${id}/pod`, { responseType: 'blob' })).data,
  recentPods: async (params = {}) => (await api.get('/delivery-notes/recent-pods', { params })).data,
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

const CARRIER_TYPES_TD = ['GAPP', 'Rental', 'Courier', 'Self Collection'];
const VEHICLE_TYPES_TD = ['Pickup', 'Dyna', 'Trailer', 'Lorry', 'Boom Truck', 'Car'];
const ATTACHMENT_TYPES_TD = [
  'Iqama',
  'Driving License',
  'Insurance',
  'Fahas / Vehicle Inspection',
  'Vehicle Document / Istimara',
  'Gate Pass',
  'Other',
];

export const transportationApi = {
  carrierTypes: CARRIER_TYPES_TD,
  vehicleTypes: VEHICLE_TYPES_TD,
  attachmentTypes: ATTACHMENT_TYPES_TD,
  listCarriers: async (params = {}) => (await api.get('/transportation/carriers', { params })).data,
  createCarrier: async (payload) => (await api.post('/transportation/carriers', payload)).data,
  updateCarrier: async (id, payload) => (await api.put(`/transportation/carriers/${id}`, payload)).data,
  deleteCarrier: async (id) => (await api.delete(`/transportation/carriers/${id}`)).data,
  listDrivers: async (params = {}) => (await api.get('/transportation/drivers', { params })).data,
  getDriver: async (id) => (await api.get(`/transportation/drivers/${id}`)).data,
  createDriver: async (payload) => (await api.post('/transportation/drivers', payload)).data,
  updateDriver: async (id, payload) => (await api.put(`/transportation/drivers/${id}`, payload)).data,
  deleteDriver: async (id) => (await api.delete(`/transportation/drivers/${id}`)).data,
  listDriverAttachments: async (driverId) => (await api.get(`/transportation/drivers/${driverId}/attachments`)).data,
  uploadAttachment: async (driverId, file, attachment_type) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('attachment_type', attachment_type);
    const res = await api.post(`/transportation/drivers/${driverId}/attachments`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data;
  },
  deleteAttachment: async (id) => (await api.delete(`/transportation/attachments/${id}`)).data,
  downloadAttachment: async (id) => {
    const res = await api.get(`/transportation/attachments/${id}/download`, { responseType: 'blob' });
    return res.data;
  },
  exportDriversExcel: async (params = {}) => {
    const res = await api.get('/transportation/drivers/export/excel', { params, responseType: 'blob' });
    downloadBlob(res.data, 'driver-details.xlsx');
  },
  exportDriverPdf: async (driverId, filename) => {
    const res = await api.get(`/transportation/drivers/${driverId}/export/pdf`, { responseType: 'blob' });
    downloadBlob(res.data, filename || `driver_${driverId}.pdf`);
  },
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
  unreadCount: async () => (await api.get('/notifications/unread-count')).data,
  markRead: async (id) => (await api.post(`/notifications/${id}/read`)).data,
  markAllRead: async () => (await api.post('/notifications/mark-all-read')).data,
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
  manualPick: async (id, payload = {}) => (await api.post(`/outbound/${id}/manual-pick`, payload)).data,
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

async function readBlobError(blob) {
  if (!(blob instanceof Blob)) return null;
  try {
    const text = await blob.text();
    const j = JSON.parse(text);
    return j.error || j.detail || text;
  } catch {
    try {
      return await blob.text();
    } catch {
      return null;
    }
  }
}

/** Admin-only: release APK metadata + download (Bearer auth; file lives under backend/uploads/mobile/) */
export const adminMobileAppApi = {
  getInfo: async () => (await api.get('/admin/mobile-app')).data,
  downloadApk: async () => {
    try {
      const res = await api.get('/admin/mobile-app/apk', { responseType: 'blob' });
      let filename = 'GoDam.apk';
      const cd = res.headers['content-disposition'];
      if (cd && typeof cd === 'string') {
        const m = cd.match(/filename\*?=(?:UTF-8'')?([^;\s]+)|filename="([^"]+)"/i);
        const raw = m ? (m[1] || m[2] || '').trim() : '';
        if (raw) {
          try {
            filename = decodeURIComponent(raw.replace(/^["']|["']$/g, ''));
          } catch {
            filename = raw.replace(/^["']|["']$/g, '') || filename;
          }
        }
      }
      downloadBlob(res.data, filename);
    } catch (e) {
      const msg = await readBlobError(e.response?.data);
      if (msg) throw new Error(msg);
      throw e;
    }
  },
};

/** Admin-only: outbound SQLite domain stats, browse whitelist tables, wipe outbound workflow */
export const maintenanceApi = {
  outboundStats: async () => (await api.get('/admin/maintenance/outbound-stats')).data,
  browseTable: async (table, limit = 100) =>
    (await api.get(`/admin/maintenance/browse/${encodeURIComponent(table)}`, { params: { limit } })).data,
  clearOutboundDomain: async (confirmPhrase) =>
    (await api.post('/admin/maintenance/clear-outbound-domain', { confirmPhrase })).data,
};

/** Web OCR Center — templates, uploads, results (does not auto-post to stock). */
export const ocrCenterApi = {
  listTemplates: async (params = {}) => (await api.get('/ocr/templates', { params })).data,
  createTemplate: async (payload) => (await api.post('/ocr/templates', payload)).data,
  updateTemplate: async (id, payload) => (await api.put(`/ocr/templates/${id}`, payload)).data,
  deleteTemplate: async (id) => (await api.delete(`/ocr/templates/${id}`)).data,
  getSettings: async () => (await api.get('/ocr/settings')).data,
  updateSettings: async (payload) => (await api.put('/ocr/settings', payload)).data,
  upload: async (file, { document_type, template_id } = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    if (document_type) fd.append('document_type', document_type);
    if (template_id) fd.append('template_id', String(template_id));
    const res = await api.post('/ocr/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    return res.data;
  },
  run: async (payload) => (await api.post('/ocr/run', payload)).data,
  saveResult: async (payload) => (await api.post('/ocr/save-result', payload)).data,
  listResults: async (limit = 100) => (await api.get('/ocr/results', { params: { limit } })).data,
  getResult: async (id) => (await api.get(`/ocr/results/${id}`)).data,
  exportExcel: async (id) => {
    const res = await api.post(`/ocr/results/${id}/export-excel`, {}, { responseType: 'blob' });
    downloadBlob(res.data, `ocr-result-${id}.xlsx`);
  },
  sendInbound: async (id) => (await api.post(`/ocr/results/${id}/send-to-inbound`)).data,
  sendOutbound: async (id) => (await api.post(`/ocr/results/${id}/send-to-outbound`)).data,
};

/** Huawei GoDam batches → SQLite huawei_godam.db (server-side matcher + importer) */
export const huaweiGodamApi = {
  health: async () => (await api.get('/huawei-godam/health')).data,
  listBatches: async (limit = 50) => (await api.get('/huawei-godam/batches', { params: { limit } })).data,
  getBatch: async (id) => (await api.get(`/huawei-godam/batches/${id}`)).data,
  poOptions: async (q = '', limit = 50) =>
    (await api.get('/huawei-godam/customer-orders/po-options', { params: { q, limit } })).data,
  dsaOptions: async (po) =>
    (await api.get(`/huawei-godam/customer-orders/${encodeURIComponent(po)}/dsa`)).data,
  dsaItems: async (po, dsa) =>
    (
      await api.get(
        `/huawei-godam/customer-orders/${encodeURIComponent(po)}/dsa/${encodeURIComponent(dsa)}/items`
      )
    ).data,
  createBatch: async (masters, dnFiles, rulesFile = null) => {
    const fd = new FormData();
    const keys = ['summary', 'po', 'so', 'vcust', 'contracts', 'accessories'];
    for (const k of keys) {
      const f = masters[k];
      if (f) fd.append(k, f);
    }
    if (rulesFile) fd.append('rules', rulesFile);
    for (const f of dnFiles || []) fd.append('dn', f);
    const res = await api.post('/huawei-godam/batches', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data;
  },
};

/** Huawei module — opens GoDam-1.0 URL from DB (huawei_godam_settings); logs opens */
export const huaweiModuleApi = {
  getGodamUrl: async () => (await api.get('/huawei-module/godam-url')).data,
  recordGodamOpen: async () => (await api.post('/huawei-module/godam-open')).data,
  /** Sets HttpOnly cookie for the authenticated Streamlit reverse proxy (opened from sidebar in a new tab). */
  grantStreamlitAccess: async () =>
    (await api.post('/huawei-module/streamlit-access-grant')).data,
  /** Admin: set Streamlit / hosted GoDam URL */
  updateGodamUrl: async (external_url) =>
    (await api.put('/huawei-module/godam-url', { external_url })).data,
};

/** GoDam-1.0 Excel plugin (DN/SO/PO matching) — see plugins/godam-excel */
export const godamExcelApi = {
  health: async () => (await api.get('/godam-excel/health')).data,
  /**
   * @param {Record<string, File>} masters — summary, po, so, vcust, contracts, accessories
   * @param {File[]} dnFiles — one or more DN workbooks (saved under DSA/)
   */
  match: async (masters, dnFiles) => {
    const fd = new FormData();
    const keys = ['summary', 'po', 'so', 'vcust', 'contracts', 'accessories'];
    for (const k of keys) {
      const f = masters[k];
      if (f) fd.append(k, f);
    }
    for (const f of dnFiles || []) fd.append('dn', f);
    const res = await api.post('/godam-excel/match', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      responseType: 'blob',
    });
    const metaB64 = res.headers?.['x-godam-excel-meta'];
    let meta = null;
    if (metaB64) {
      try {
        meta = JSON.parse(atob(metaB64));
      } catch {
        meta = null;
      }
    }
    return { blob: res.data, meta };
  },
};

export default api;
