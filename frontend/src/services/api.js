import axios from 'axios';
import { toast } from 'sonner';

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
  withCredentials: true,
  /** No default Content-Type: axios sets JSON for plain-object bodies; leaving it unset avoids forcing JSON on FormData (multer needs multipart + boundary). */
});

/** Do not set Content-Type manually for FormData — the boundary must be set by the runtime. */
const multipartFileUploadConfig = { timeout: 900_000 };

api.interceptors.request.use((config) => {
  config.headers = config.headers || {};
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    const h = config.headers;
    if (typeof h.delete === 'function') {
      h.delete('Content-Type');
      h.delete('content-type');
    } else {
      delete h['Content-Type'];
      delete h['content-type'];
    }
  }
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  try {
    const raw = localStorage.getItem('godam_web_warehouse_id');
    if (raw && raw !== 'all') {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) {
        config.headers['X-Warehouse-Id'] = String(n);
      }
    }
  } catch {
    /* ignore */
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      try {
        toast.error('Session expired. Please sign in again.');
      } catch {
        /* ignore */
      }
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
  list: async (search = '') =>
    (await api.get('/main-stock', { params: { search, limit: 500 }, timeout: 120_000 })).data,
  search: async (q) => (await api.get('/main-stock/search', { params: { q } })).data,
  addNewPart: async (payload) => (await api.post('/main-stock/add-new-part', payload)).data,
  manualStockIn: async (payload) => (await api.post('/main-stock/manual-stock-in', payload)).data,
  bulkPaste: async (data) => (await api.post('/main-stock/bulk-paste', { data })).data,
  updateExisting: async (data) => (await api.post('/main-stock/update-existing', { data })).data,
  upload: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/main-stock/upload', fd, multipartFileUploadConfig);
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
    const res = await api.post('/inbound/upload', fd, multipartFileUploadConfig);
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
  auditLogs: async (params = {}) => (await api.get('/reports/audit-logs', { params })).data,
};

export const dashboardApi = {
  summary: async () => (await api.get('/dashboard/summary')).data,
  recentActivity: async () => (await api.get('/dashboard/recent-activity')).data,
  notifications: async () => (await api.get('/dashboard/notifications')).data,
  rangeSummary: async ({ from, to } = {}) =>
    (await api.get('/dashboard/range-summary', { params: { ...(from ? { from } : {}), ...(to ? { to } : {}) } })).data,
  orderPipeline: async () => (await api.get('/dashboard/order-pipeline')).data,
};

export const soldOutApi = {
  list: async () => (await api.get('/sold-out', { params: { limit: 2000 } })).data,
  upload: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/sold-out/upload', fd, multipartFileUploadConfig);
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
    const res = await api.post('/sap-stock/upload', fd, multipartFileUploadConfig);
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
    const res = await api.post('/stock-in/upload', fd, multipartFileUploadConfig);
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
    const res = await api.post('/stock-out/upload', fd, multipartFileUploadConfig);
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
    const res = await api.post('/customers/upload', fd, multipartFileUploadConfig);
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
      ...multipartFileUploadConfig,
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
    const res = await api.post('/vendors/upload', fd, multipartFileUploadConfig);
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
    const res = await api.post('/vendor-items/upload', fd, multipartFileUploadConfig);
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
    const res = await api.post('/outbound/upload', fd, multipartFileUploadConfig);
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
  /** Multipart: file + upload_stage (order_created | post_delivery | other) */
  uploadOrderDocument: async (outboundId, file, upload_stage = 'order_created') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_stage', upload_stage);
    const res = await api.post(`/outbound/${outboundId}/order-documents`, fd, {
      ...multipartFileUploadConfig,
    });
    return res.data;
  },
  deleteOrderDocument: async (outboundId, docId) => (await api.delete(`/outbound/${outboundId}/order-documents/${docId}`)).data,
};

export const usersApi = {
  list: async () => (await api.get('/users')).data,
  create: async (payload) => (await api.post('/users', payload)).data,
  update: async (id, payload) => (await api.put(`/users/${id}`, payload)).data,
  remove: async (id) => (await api.delete(`/users/${id}`)).data,
  disable: async (id) => (await api.post(`/users/${id}/disable`)).data,
  resetPassword: async (id, password) => (await api.post(`/users/${id}/reset-password`, { password })).data,
  getWarehouseAssignments: async (id) => (await api.get(`/users/${id}/warehouse-assignments`)).data,
};

export const warehousesApi = {
  list: async () => (await api.get('/warehouses')).data,
  create: async (payload) => (await api.post('/warehouses', payload)).data,
  update: async (id, payload) => (await api.patch(`/warehouses/${id}`, payload)).data,
  getStaff: async (id) => (await api.get(`/warehouses/${id}/staff`)).data,
  assignManager: async (id, user_id) => (await api.post(`/warehouses/${id}/manager`, { user_id })).data,
  assignUser: async (id, body) => (await api.post(`/warehouses/${id}/users`, body)).data,
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
      ...multipartFileUploadConfig,
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
      ...multipartFileUploadConfig,
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

/** Admin: parent/child BOM definitions (optional outbound expansion) */
export const bomApi = {
  list: async () => (await api.get('/bom')).data,
  getByParent: async (parentPart) => (await api.get(`/bom/${encodeURIComponent(parentPart)}`)).data,
  create: async (payload) => (await api.post('/bom', payload)).data,
  update: async (id, payload) => (await api.put(`/bom/${id}`, payload)).data,
  deleteSet: async (id) => (await api.delete(`/bom/${id}`)).data,
  addChild: async (bomSetId, payload) => (await api.post(`/bom/${bomSetId}/children`, payload)).data,
  deleteChild: async (childId) => (await api.delete(`/bom/children/${childId}`)).data,
  upload: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return (await api.post('/bom/upload', fd, multipartFileUploadConfig)).data;
  },
  downloadTemplate: () => {
    const a = document.createElement('a');
    a.href = '/api/bom/template';
    a.download = 'bom_template.xlsx';
    a.click();
  },
  searchStock: async (q) => (await api.get('/bom/search-stock', { params: { q } })).data,
};

/** Sales order Google Drive document tree + uploads */
function filenameFromContentDisposition(header) {
  if (!header || typeof header !== 'string') return null;
  const star = /filename\*\s*=\s*UTF-8''([^;\n]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header);
  if (quoted) return quoted[1];
  const plain = /filename\s*=\s*([^;\n]+)/i.exec(header);
  if (plain) return plain[1].trim().replace(/^["']|["']$/g, '');
  return null;
}

function fallbackCombinedPdfName(salesOrderNumber, customerPoNumber) {
  const so = String(salesOrderNumber).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'SO';
  const po = String(customerPoNumber || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 60);
  const base = po ? `${so}_PO_${po}` : so;
  return `${base}_combined.pdf`;
}

function fallbackDocumentsZipName(salesOrderNumber, customerPoNumber) {
  const so = String(salesOrderNumber).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'SO';
  const po = String(customerPoNumber || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 60);
  const base = po ? `${so}_PO_${po}` : so;
  return `${base}_documents.zip`;
}

async function salesOrderExportBlobErrorMessage(err) {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try {
      const text = await data.text();
      const j = JSON.parse(text);
      return j.error || text || err.message;
    } catch {
      return err.message || 'Export failed';
    }
  }
  return err?.response?.data?.error || err.message || 'Export failed';
}

export const salesOrderDocumentsApi = {
  listFolders: async (params) => (await api.get('/sales-order-folders', { params })).data,
  getFolder: async (salesOrderNumber, params) =>
    (await api.get(`/sales-order-folders/${encodeURIComponent(salesOrderNumber)}`, { params })).data,
  ensureFolder: async (body) => (await api.post('/sales-order-folders/ensure', body)).data,
  driveSetup: async (params) => (await api.get('/sales-order-folders/drive-setup', { params })).data,
  exportManifest: async (salesOrderNumber, body = {}) =>
    (await api.post(`/sales-order-folders/${encodeURIComponent(salesOrderNumber)}/export-manifest`, body)).data,
  listDocuments: async (salesOrderNumber) => (await api.get(`/sales-order-documents/${encodeURIComponent(salesOrderNumber)}`)).data,
  status: async (salesOrderNumber) =>
    (await api.get(`/sales-order-documents/${encodeURIComponent(salesOrderNumber)}/status`)).data,
  report: async (params) => (await api.get('/sales-order-documents/report', { params })).data,
  upload: async (formData) => (await api.post('/sales-order-documents/upload', formData)).data,
  verify: async (id, payload) => (await api.post(`/sales-order-documents/by-id/${id}/verify`, payload)).data,
  openLink: async (id) => (await api.get(`/sales-order-documents/by-id/${id}/open-link`)).data,
  replace: async (id, formData) => (await api.post(`/sales-order-documents/by-id/${id}/replace`, formData)).data,
  downloadCombinedPdf: async (salesOrderNumber, warehouseId, opts = {}) => {
    const params = {};
    if (warehouseId != null && warehouseId !== '') params.warehouse_id = warehouseId;
    try {
      const res = await api.get(
        `/sales-order-documents/${encodeURIComponent(salesOrderNumber)}/export-combined.pdf`,
        { params, responseType: 'blob' }
      );
      const fname =
        filenameFromContentDisposition(res.headers['content-disposition']) ||
        fallbackCombinedPdfName(salesOrderNumber, opts.customerPoNumber);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      throw new Error(await salesOrderExportBlobErrorMessage(e));
    }
  },
  downloadIndividualZip: async (salesOrderNumber, warehouseId, opts = {}) => {
    const params = {};
    if (warehouseId != null && warehouseId !== '') params.warehouse_id = warehouseId;
    try {
      const res = await api.get(
        `/sales-order-documents/${encodeURIComponent(salesOrderNumber)}/export-individual.zip`,
        { params, responseType: 'blob' }
      );
      const fname =
        filenameFromContentDisposition(res.headers['content-disposition']) ||
        fallbackDocumentsZipName(salesOrderNumber, opts.customerPoNumber);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      throw new Error(await salesOrderExportBlobErrorMessage(e));
    }
  },
};

export default api;
