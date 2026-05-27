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
  googleLogin: async (googleToken) => {
    const res = await api.post('/auth/google-login', { googleToken });
    return res.data;
  },
  me: async () => {
    const res = await api.get('/auth/me');
    return res.data;
  },
  updateDefaultWarehouse: async (warehouseId) => {
    const res = await api.patch('/auth/me/default-warehouse', {
      warehouse_id: warehouseId == null ? null : Number(warehouseId),
    });
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
  search: async (q, opts = {}) =>
    (
      await api.get('/main-stock/search', {
        params: { q, ...(opts.partPrefix ? { part_prefix: '1' } : {}) },
      })
    ).data,
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

export const shipmentsApi = {
  list: async (params = {}) => (await api.get('/shipments', { params })).data,
  get: async (id) => (await api.get(`/shipments/${id}`)).data,
  create: async (payload) => (await api.post('/shipments', payload)).data,
  update: async (id, payload) => (await api.put(`/shipments/${id}`, payload)).data,
  remove: async (id) => (await api.delete(`/shipments/${id}`)).data,
  parseItems: async (file, defaults = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    Object.entries(defaults).forEach(([k, v]) => {
      if (v != null && String(v).trim()) fd.append(k, v);
    });
    return (await api.post('/shipments/parse-items', fd, multipartFileUploadConfig)).data;
  },
  downloadTemplate: async () => {
    const res = await api.get('/shipments/template', { responseType: 'blob' });
    downloadBlob(res.data, 'shipment-items-template.xlsx');
  },
  remainingQty: async (shipmentId, itemId) =>
    (await api.get(`/shipments/${shipmentId}/items/${itemId}/remaining`)).data,
  addReceive: async (shipmentId, body) => (await api.post(`/shipments/${shipmentId}/receive`, body)).data,
  updateReceive: async (shipmentId, txId, body) =>
    (await api.patch(`/shipments/${shipmentId}/receive/${txId}`, body)).data,
  deleteReceive: async (shipmentId, txId) =>
    (await api.delete(`/shipments/${shipmentId}/receive/${txId}`)).data,
  finalize: async (shipmentId, body = {}) =>
    (await api.post(`/shipments/${shipmentId}/finalize`, body)).data,
  uploadAttachment: async (shipmentId, file, folderType = 'DOCUMENTS') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('folder_type', folderType);
    return (await api.post(`/shipments/${shipmentId}/attachments`, fd, multipartFileUploadConfig)).data;
  },
  downloadReport: async (shipmentId, format = 'xlsx') => {
    const res = await api.get(`/shipments/${shipmentId}/report/${format}`, { responseType: 'blob' });
    const ext = format === 'pdf' ? 'pdf' : 'xlsx';
    downloadBlob(res.data, `shipment-receiving-${shipmentId}.${ext}`);
  },
};

export const inboundApi = {
  list: async (params = {}) => (await api.get('/inbound', { params: { limit: 1000, ...params } })).data,
  filterSuggestions: async (field, q = '') =>
    (await api.get('/inbound/filter-suggestions', { params: { field, q, limit: 30 } })).data,
  validateUpload: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await api.post('/inbound/validate-upload', fd, multipartFileUploadConfig);
      return res.data;
    } catch (e) {
      if (e?.response?.data) {
        const wrapped = new Error(e.response.data.reject_message || e.response.data.error || 'Validation failed');
        wrapped.response = e.response;
        throw wrapped;
      }
      throw e;
    }
  },
  validateRows: async (rows, filename = 'bulk-paste.json') => {
    try {
      const res = await api.post('/inbound/validate-upload', { rows, filename });
      return res.data;
    } catch (e) {
      if (e?.response?.data) {
        const wrapped = new Error(e.response.data.reject_message || e.response.data.error || 'Validation failed');
        wrapped.response = e.response;
        throw wrapped;
      }
      throw e;
    }
  },
  downloadMissingParts: async (validationId) => {
    const res = await api.get(`/inbound/missing-parts-template/${validationId}`, { responseType: 'blob' });
    downloadBlob(res.data, `inbound-missing-parts-${String(validationId).slice(0, 8)}.xlsx`);
  },
  uploadValidated: async (validationId) => {
    const fd = new FormData();
    fd.append('validation_id', validationId);
    const res = await api.post('/inbound/upload', fd, multipartFileUploadConfig);
    return res.data;
  },
  upload: async (file, validationId) => {
    const fd = new FormData();
    if (validationId) fd.append('validation_id', validationId);
    if (file) fd.append('file', file);
    const res = await api.post('/inbound/upload', fd, multipartFileUploadConfig);
    return res.data;
  },
  bulkPaste: async (data, validationId) =>
    (await api.post('/inbound/bulk-paste', { data, validation_id: validationId })).data,
  downloadTemplateXlsx: async () => {
    const res = await api.get('/inbound/template', { responseType: 'blob' });
    downloadBlob(res.data, 'inbound-template.xlsx');
  },
  putawayReport: async (params = {}) => (await api.get('/inbound/putaway-report', { params })).data,
  applyPutawayToRack: async (inbound_item_ids) =>
    (await api.post('/inbound/apply-putaway-to-rack', { inbound_item_ids })).data,
  /** Validate one row then commit (same rules as bulk upload). */
  createSingle: async (row) => {
    let validation;
    try {
      const res = await api.post('/inbound/validate-upload', { rows: [row], filename: 'single-entry' });
      validation = res.data;
    } catch (e) {
      if (e?.response?.data) {
        const wrapped = new Error(e.response.data.reject_message || e.response.data.error || 'Validation failed');
        wrapped.response = e.response;
        throw wrapped;
      }
      throw e;
    }
    if (!validation?.valid) {
      const err = new Error(validation?.reject_message || 'Part number not in item master');
      err.response = { data: validation };
      throw err;
    }
    return (await api.post('/inbound/bulk-paste', { data: [row], validation_id: validation.validation_id })).data;
  },
};

export const itemMasterApi = {
  createMissingParts: async (parts) => (await api.post('/item-master/create-missing-parts', { parts })).data,
};

export const reportsApi = {
  outboundPicks: async (params = {}) => (await api.get('/reports/outbound-picks', { params })).data,
  /** Same data as outbound-picks; spec path */
  outbound: async (params = {}) => (await api.get('/reports/outbound', { params })).data,
  inbound: async (params = {}) => (await api.get('/reports/inbound', { params })).data,
  inboundFilterSuggestions: async (field, q = '') =>
    (await api.get('/reports/inbound/filter-suggestions', { params: { field, q, limit: 30 } })).data,
  delivery: async (params = {}) => (await api.get('/reports/delivery', { params })).data,
  stockByRackReport: async (params = {}) => (await api.get('/reports/stock-by-rack', { params })).data,
  mainStockReport: async (params = {}) => (await api.get('/reports/main-stock', { params })).data,
  sapStock: async (params = {}) => (await api.get('/reports/sap-stock', { params })).data,
  stockComparison: async (params = {}) => (await api.get('/reports/stock-comparison', { params })).data,
  rackBalanceAdjustments: async (params = {}) => (await api.get('/reports/rack-balance-adjustments', { params })).data,
  auditLogs: async (params = {}) => (await api.get('/reports/audit-logs', { params })).data,
  orderPickStatusList: async (params = {}) => (await api.get('/reports/order-pick-status', { params })).data,
  orderPickStatusDetail: async (ref, params = {}) =>
    (await api.get(`/reports/order-pick-status/${encodeURIComponent(ref)}`, { params })).data,
};

export const googleDriveApi = {
  status: async (params = {}) => (await api.get('/google/oauth/status', { params })).data,
  start: async () => (await api.get('/google/oauth/start')).data,
  reconnect: async () => (await api.post('/google/oauth/reconnect')).data,
  disconnect: async () => (await api.post('/google/oauth/disconnect')).data,
  testUpload: async () => (await api.post('/google-drive/test-upload')).data,
  repairRootFolder: async () => (await api.post('/google-drive/root-folder/repair')).data,
};

/** @deprecated use googleDriveApi */
export const storageApi = {
  googleDriveStatus: googleDriveApi.status,
  googleDriveConnect: googleDriveApi.start,
  googleDriveDisconnect: googleDriveApi.disconnect,
  testGoogleDrive: googleDriveApi.testUpload,
};

export const dashboardApi = {
  summary: async () => (await api.get('/dashboard/summary')).data,
  recentActivity: async () => (await api.get('/dashboard/recent-activity')).data,
  notifications: async () => (await api.get('/dashboard/notifications')).data,
  rangeSummary: async ({ from, to } = {}) =>
    (await api.get('/dashboard/range-summary', { params: { ...(from ? { from } : {}), ...(to ? { to } : {}) } })).data,
  orderPipeline: async () => (await api.get('/dashboard/order-pipeline')).data,
  liveActivity: async () => (await api.get('/dashboard/live-activity')).data,
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
  create: async (row) => (await api.post('/sold-out/bulk-paste', { data: [row] })).data,
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
  materialGroupInsights: async (params = {}) =>
    (await api.get('/sap-stock/material-group-insights', { params })).data,
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

export const sapPoApi = {
  list: async (params = {}) => (await api.get('/sap-po', { params })).data,
  listPending: async (params = {}) => (await api.get('/sap-po/pending', { params })).data,
  pendingFilters: async () => (await api.get('/sap-po/pending/filters')).data,
  uploadHistory: async () => (await api.get('/sap-po/upload-history')).data,
  upload: async (file, uploadType = 'PO') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_type', uploadType);
    const res = await api.post('/sap-po/upload', fd, multipartFileUploadConfig);
    return res.data;
  },
  exportExcel: async (params = {}) => {
    const res = await api.get('/sap-po/export', { params, responseType: 'blob' });
    const slug =
      String(params.upload_type || 'PO').toUpperCase() === 'SALES_ORDER'
        ? 'sap-sales-order-export.xlsx'
        : 'sap-po-export.xlsx';
    downloadBlob(res.data, slug);
  },
  enrichDescriptions: async (params = {}) =>
    (
      await api.post('/sap-po/enrich-descriptions', null, {
        params,
        timeout: 600000,
      })
    ).data,
  downloadTemplate: async (uploadType = 'PO') => {
    const res = await api.get('/sap-po/template', {
      params: { type: uploadType },
      responseType: 'blob',
    });
    const slug = uploadType === 'SALES_ORDER' ? 'sap-sales-order-template' : 'sap-po-template';
    downloadBlob(res.data, `${slug}.xlsx`);
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

export const whatsappApi = {
  status: async () => (await api.get('/whatsapp/status')).data,
  connect: async (force = false) =>
    (await api.post('/whatsapp/connect', force ? { force: true } : {})).data,
  checkNumber: async (phone) => (await api.post('/whatsapp/check-number', { phone })).data,
  sendDn: async (payload) => (await api.post('/whatsapp/send-dn', payload)).data,
  listConversations: async (params) => (await api.get('/whatsapp/conversations', { params })).data,
  getConversation: async (id) => (await api.get(`/whatsapp/conversations/${id}`)).data,
  getOrderContext: async (id, params = {}) =>
    (await api.get(`/whatsapp/conversations/${id}/order-context`, { params })).data,
  aiAssist: async (id, payload) =>
    (await api.post(`/whatsapp/conversations/${id}/ai-assist`, payload)).data,
  searchContacts: async (q, params = {}) =>
    (await api.get('/whatsapp/contacts/search', { params: { q, ...params } })).data,
  listRecentContacts: async (params = {}) =>
    (await api.get('/whatsapp/contacts/recent', { params })).data,
  startConversation: async (payload) =>
    (await api.post('/whatsapp/conversations/start', typeof payload === 'string' ? { phone: payload } : payload))
      .data,
  markConversationRead: async (id) => (await api.post(`/whatsapp/conversations/${id}/read`)).data,
  sendMessage: async (payload) => (await api.post('/whatsapp/send', payload)).data,
  updateConversation: async (id, payload) => (await api.patch(`/whatsapp/conversations/${id}`, payload)).data,
};

export const deliveryNotesApi = {
  createFromOutbound: async (outbound_number, { dn_date, warehouse_id } = {}) =>
    (
      await api.post('/delivery-notes', {
        outbound_number,
        ...(dn_date ? { dn_date } : {}),
        ...(warehouse_id != null && warehouse_id !== '' ? { warehouse_id } : {}),
      })
    ).data,
  createFromHuaweiPo: async (sap_po, { dn_date, warehouse_id, rebuild = false } = {}) =>
    (
      await api.post('/delivery-notes', {
        source: 'huawei',
        sap_po,
        ...(rebuild ? { rebuild: true } : {}),
        ...(dn_date ? { dn_date } : {}),
        ...(warehouse_id != null && warehouse_id !== '' ? { warehouse_id } : {}),
      })
    ).data,
  get: async (id) => (await api.get(`/delivery-notes/${id}`)).data,
  outboundOptions: async () => (await api.get('/delivery-notes/outbound-options')).data,
  list: async (params = {}) => (await api.get('/delivery-notes', { params })).data,
  getDeliveryTo: async (id) => (await api.get(`/delivery-notes/${id}/delivery-to`)).data,
  applyDeliveryTo: async (id, payload) => (await api.post(`/delivery-notes/${id}/delivery-to`, payload)).data,
  saveTransportation: async (id, payload) => (await api.post(`/delivery-notes/${id}/transportation`, payload)).data,
  savePackageInfo: async (id, payload) => (await api.post(`/delivery-notes/${id}/package-info`, payload)).data,
  saveInvoice: async (id, invoice_number) =>
    (await api.post(`/delivery-notes/${id}/invoice`, { invoice_number })).data,
  saveDnDate: async (id, payload) => (await api.post(`/delivery-notes/${id}/dn-date`, payload)).data,
  saveContactPerson2: async (id, payload) => (await api.post(`/delivery-notes/${id}/contact-person-2`, payload)).data,
  setHold: async (id, is_hold) => (await api.post(`/delivery-notes/${id}/hold`, { is_hold })).data,
  markDelivered: async (id) => (await api.post(`/delivery-notes/${id}/mark-delivered`)).data,
  print: async (id) => (await api.get(`/delivery-notes/${id}/print`)).data,
  getTimeline: async (id) => (await api.get(`/delivery-notes/${id}/timeline`)).data,
  confirmForDelivery: async (id) => (await api.post(`/delivery-notes/${id}/confirm`)).data,
  closeAdmin: async (id, payload) => (await api.post(`/delivery-notes/${id}/close-admin`, payload)).data,
  downloadPod: async (id) =>
    (await api.get(`/delivery-notes/${id}/pod`, { responseType: 'blob' })).data,
  /** PDF summary for customer WhatsApp / share sheet (requires can_upload_outbound or can_confirm_picked). */
  downloadCustomerPdf: async (id) =>
    (await api.get(`/delivery-notes/${id}/customer-pdf`, { responseType: 'blob' })).data,
  recentPods: async (params = {}) => (await api.get('/delivery-notes/recent-pods', { params })).data,
  podUploadContext: async (id) => (await api.get(`/delivery-notes/${id}/pod-upload-context`)).data,
  uploadPod: async (id, formData) =>
    (await api.post(`/delivery-notes/${id}/upload-pod`, formData, multipartFileUploadConfig)).data,
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

export const driverLocationApi = {
  live: async (params = {}) => (await api.get('/driver-location/live', { params })).data,
  report: async (params = {}) => (await api.get('/driver-location/report', { params })).data,
};

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

export const notesApi = {
  stats: async () => (await api.get('/notes/stats/summary')).data,
  list: async (params = {}) => (await api.get('/notes', { params })).data,
  get: async (id) => (await api.get(`/notes/${id}`)).data,
  create: async (payload) => (await api.post('/notes', payload)).data,
  addMessage: async (id, body) => (await api.post(`/notes/${id}/messages`, { body })).data,
  complete: async (id) => (await api.post(`/notes/${id}/complete`)).data,
  setTags: async (id, tagged_user_ids) =>
    (await api.post(`/notes/${id}/tags`, { tagged_user_ids })).data,
  archive: async (id) => (await api.post(`/notes/${id}/archive`)).data,
  addReminder: async (id, payload) => (await api.post(`/notes/${id}/reminders`, payload)).data,
  uploadAttachment: async (id, file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post(`/notes/${id}/attachments`, fd, multipartFileUploadConfig);
    return res.data;
  },
  downloadAttachment: async (id, filename = 'attachment') => {
    const res = await api.get(`/notes/attachments/${id}/download`, { responseType: 'blob' });
    downloadBlob(res.data, filename);
  },
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
  ensureDriveFolders: async (id) => (await api.post(`/outbound/${id}/ensure-drive-folders`)).data,
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
  /** Undo picked: restores rack quantities, removes pick tx rows, keeps picked order record as Reversed. */
  reversePicked: async (id, payload = {}) => (await api.post(`/outbound/${id}/reverse-picked`, payload)).data,
  changePickLocation: async (id, payload) => (await api.post(`/outbound/${id}/change-pick-location`, payload)).data,
  updateFifoQty: async (id, fifoId, suggested_qty) => (await api.put(`/outbound/${id}/fifo/${fifoId}`, { suggested_qty })).data,
  removeFifoLine: async (id, fifoId) => (await api.delete(`/outbound/${id}/fifo/${fifoId}`)).data,
  remove: async (id) => (await api.delete(`/outbound/${id}`)).data,
  updateItemQty: async (outboundId, itemId, required_qty) =>
    (await api.put(`/outbound/${outboundId}/items/${itemId}`, { required_qty })).data,
  /** Multipart: sales order file + customer_number (links Customer_PO on Drive). */
  uploadOrderDocument: async (outboundId, file, { customer_number, upload_stage = 'sales_order' } = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('upload_stage', upload_stage);
    if (customer_number) fd.append('customer_number', customer_number);
    const res = await api.post(`/outbound/${outboundId}/order-documents`, fd, {
      ...multipartFileUploadConfig,
    });
    return res.data;
  },
  linkOutboundCustomer: async (outboundId, customer_number) =>
    (await api.patch(`/outbound/${outboundId}/customer-link`, { customer_number })).data,
  changeWarehouse: async (outboundId, warehouse_id) =>
    (await api.patch(`/outbound/${outboundId}/warehouse`, { warehouse_id })).data,
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

/** Dedicated Huawei SAP/contract matching orders (separate from packing shipments). */
export const huaweiOrdersApi = {
  ping: async () => (await api.get('/huawei/ping')).data,
  health: async () => (await api.get('/huawei/orders/health')).data,
  list: async (params = {}) => (await api.get('/huawei/orders', { params })).data,
  itemBoard: async (params = {}) => (await api.get('/huawei/item-board', { params })).data,
  get: async (id) => (await api.get(`/huawei/orders/${id}`)).data,
  create: async (body) => (await api.post('/huawei/orders', body)).data,
  update: async (id, body) => (await api.put(`/huawei/orders/${id}`, body)).data,
  setStatus: async (id, status, remarks) =>
    (await api.post(`/huawei/orders/${id}/status`, { status, remarks })).data,
  uploadDocument: async (id, file, document_type) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('document_type', document_type);
    const res = await api.post(`/huawei/orders/${id}/documents/upload`, fd, multipartFileUploadConfig);
    return res.data;
  },
  runMatching: async (id) => (await api.post(`/huawei/orders/${id}/run-matching`)).data,
  matchingResults: async (id) => (await api.get(`/huawei/orders/${id}/matching-results`)).data,
  exportMatchingReport: async (id) => {
    const res = await api.get(`/huawei/orders/${id}/matching-report/export`, { responseType: 'blob' });
    return res.data;
  },
  exportDnLinesExcel: async (id) => {
    const res = await api.get(`/huawei/orders/${id}/dn-lines/export`, { responseType: 'blob' });
    return res.data;
  },
  reportExportExcel: async (params = {}) => {
    const res = await api.get('/reports/huawei/export-excel', { params, responseType: 'blob' });
    return res.data;
  },
  importCustomerOrderList: async (file, { warehouse_id, sync_orders = true } = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    if (warehouse_id != null) fd.append('warehouse_id', String(warehouse_id));
    fd.append('sync_orders', sync_orders ? 'true' : 'false');
    const res = await api.post('/huawei/customer-order-list/import', fd, multipartFileUploadConfig);
    return res.data;
  },
  listCustomerOrderList: async (params = {}) =>
    (await api.get('/huawei/customer-order-list', { params })).data,
  syncCustomerOrderListStatus: async (body = {}) =>
    (await api.post('/huawei/customer-order-list/sync-status', body)).data,
  exportCustomerOrderList: async (params = {}) => {
    const res = await api.get('/huawei/customer-order-list/export', { params, responseType: 'blob' });
    return res.data;
  },
  dsaFolderStatus: async (params = {}) => (await api.get('/huawei/dsa-folder/status', { params })).data,
  importDsaFolderToOrders: async (body = {}) =>
    (await api.post('/huawei/dsa-folder/import-orders', body)).data,
  uploadDsaFiles: async (files, opts = {}) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    if (opts.warehouse_id != null) fd.append('warehouse_id', String(opts.warehouse_id));
    if (opts.force) fd.append('force', 'true');
    if (opts.auto_match === false) fd.append('auto_match', 'false');
    const res = await api.post('/huawei/dsa-files/upload', fd, {
      ...multipartFileUploadConfig,
      timeout: 600000,
    });
    return res.data;
  },
  uploadRefreshedDn: async (file, opts = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    if (opts.warehouse_id != null) fd.append('warehouse_id', String(opts.warehouse_id));
    const res = await api.post('/huawei/dn-refresh/upload', fd, {
      ...multipartFileUploadConfig,
      timeout: 600000,
    });
    return res.data;
  },
  getDnRefreshChanges: async (batchId) =>
    (await api.get(`/huawei/dn-refresh/${batchId}/changes`)).data,
  applyDnRefresh: async (batchId, body = {}) =>
    (await api.post(`/huawei/dn-refresh/${batchId}/apply`, body)).data,
  cancelDnRefresh: async (batchId, body = {}) =>
    (await api.post(`/huawei/dn-refresh/${batchId}/cancel`, body)).data,
  exportDnRefreshChanges: async (batchId) => {
    const res = await api.get(`/huawei/dn-refresh/${batchId}/changes/export`, { responseType: 'blob' });
    return res.data;
  },
  listOrderDnVersions: async (orderId) =>
    (await api.get(`/huawei/orders/${orderId}/versions`)).data,
  importInputSummary: async (file, opts = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    if (opts.warehouse_id != null) fd.append('warehouse_id', String(opts.warehouse_id));
    if (opts.force) fd.append('force', 'true');
    const res = await api.post('/huawei/input/import', fd, {
      ...multipartFileUploadConfig,
      timeout: 600000,
    });
    return res.data;
  },
  importPrealertDefaults: async (body = {}) =>
    (await api.post('/huawei/prealert/import-defaults', body)).data,
  summaryBoard: async (params = {}) => (await api.get('/huawei/board/summary', { params })).data,
  itemBoardV2: async (params = {}) => (await api.get('/huawei/board/items', { params })).data,
  exportBoardExcel: async (params = {}) => {
    const res = await api.get('/huawei/board/export', { params, responseType: 'blob' });
    return res.data;
  },
  comparePoDn: async (groupBy = 'po') => (await api.get('/huawei/matching/compare-po-dn', { params: { groupBy } })).data,
  saveHeader: async (body) => (await api.post('/huawei/matching/save-header', body)).data,
  clearMatchingStaging: async () => (await api.post('/huawei/matching/clear-staging')).data,
  exportComparisonExcel: async (groupBy = 'po') => {
    const res = await api.get('/huawei/matching/export-comparison', { params: { groupBy }, responseType: 'blob' });
    return res.data;
  },
  confirmMatchingStaging: async () => (await api.post('/huawei/matching/confirm-staging')).data,
  clearMatchingWorkflow: async (opts = {}) =>
    (
      await api.post('/huawei/workflow/clear-staging', {
        warehouse_id: opts.warehouse_id,
        include_dn_refresh: opts.include_dn_refresh !== false,
      })
    ).data,
  validateWorkflow: async (opts = {}) =>
    (
      await api.post('/huawei/workflow/validate', {
        warehouse_id: opts.warehouse_id,
        workflow_section: opts.workflow_section || 'matching',
      })
    ).data,
  runMatchingAll: async (opts = {}) =>
    (
      await api.post('/huawei/run-matching', {
        warehouse_id: opts.warehouse_id,
        workflow_section: opts.workflow_section || 'matching',
      })
    ).data,
  exportMatchingWorkbook: async (opts = {}) => {
    const res = await api.get('/huawei/workflow/matching-export', {
      params: {
        warehouse_id: opts.warehouse_id,
        workflow_section: opts.workflow_section || 'matching',
        validated: opts.validated !== false ? 'true' : 'false',
      },
      responseType: 'blob',
    });
    return res.data;
  },
  patchBoardDnLine: async (id, body) => (await api.patch(`/huawei/board/dn-lines/${id}`, body)).data,
  deleteBoardDnLine: async (id) => (await api.delete(`/huawei/board/dn-lines/${id}`)).data,
  patchBoardPoPart: async (body, params = {}) =>
    (await api.patch('/huawei/board/po-part', body, { params })).data,
  deleteBoardPoPart: async (params = {}) => (await api.delete('/huawei/board/po-part', { params })).data,
  patchBoardSummaryOrder: async (id, body) =>
    (await api.patch(`/huawei/board/summary-orders/${id}`, body)).data,
  deleteBoardSummaryOrder: async (id) => (await api.delete(`/huawei/board/summary-orders/${id}`)).data,
  confirmMatchingOrder: async (id, body = {}) =>
    (await api.post(`/huawei/orders/${id}/confirm-matching`, body)).data,
  listCustomerOrdersHuawei: async (params = {}) =>
    (await api.get('/huawei/customer-orders-huawei', { params })).data,
  listCustomerOrderHuaweiCandidates: async (params = {}) =>
    (await api.get('/huawei/customer-orders-huawei/summary-candidates', { params })).data,
  getCustomerOrderHuawei: async (id) =>
    (await api.get(`/huawei/customer-orders-huawei/${id}`)).data,
  confirmCustomerOrderHuawei: async (orderId, body = {}) =>
    (await api.post(`/huawei/customer-orders-huawei/${orderId}/confirm`, body)).data,
  importCustomerOrderHuaweiReceived: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/huawei/customer-orders-huawei/received/import', fd, multipartFileUploadConfig);
    return res.data;
  },
  rejectOrder: async (id, body = {}) => (await api.post(`/huawei/orders/${id}/reject`, body)).data,
  reverseDeliveredOrder: async (id, body = {}) =>
    (await api.post(`/huawei/orders/${id}/reverse-delivered`, body)).data,
  receiveOrder: async (id, { gr_number, receive_amount, remarks, file }) => {
    const fd = new FormData();
    fd.append('gr_number', gr_number);
    fd.append('receive_amount', String(receive_amount));
    if (remarks) fd.append('remarks', remarks);
    if (file) fd.append('file', file);
    const res = await api.post(`/huawei/orders/${id}/receive`, fd, multipartFileUploadConfig);
    return res.data;
  },
  receiveDocumentUrl: (id) => `/api/huawei/orders/${id}/receive-document`,
  replaceDsaPacking: async (dsa, file, opts = {}) => {
    const fd = new FormData();
    fd.append('file', file);
    if (opts.warehouse_id != null) fd.append('warehouse_id', String(opts.warehouse_id));
    if (opts.auto_match === false) fd.append('auto_match', 'false');
    const res = await api.post(
      `/huawei/orders/by-dsa/${encodeURIComponent(dsa)}/replace-packing`,
      fd,
      { ...multipartFileUploadConfig, timeout: 600000 }
    );
    return res.data;
  },
  uploadContracts: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/huawei/contracts/upload', fd, multipartFileUploadConfig);
    return res.data;
  },
  listContracts: async (params = {}) => (await api.get('/huawei/contracts', { params })).data,
  uploadAccessories: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/huawei/accessories/upload', fd, multipartFileUploadConfig);
    return res.data;
  },
  listAccessories: async (params = {}) => (await api.get('/huawei/accessories', { params })).data,
  addAccessory: async (body) => (await api.post('/huawei/accessories', body)).data,
  bulkPasteAccessories: async (rows) => (await api.post('/huawei/accessories/bulk-paste', { rows })).data,
  exportAccessoriesExcel: async (params = {}) => {
    const res = await api.get('/huawei/accessories/export', { params, responseType: 'blob' });
    return res.data;
  },
  matcherDbStatus: async () => (await api.get('/huawei/matcher/db-status')).data,
  sampleDataManifest: async () => (await api.get('/huawei/sample-data/manifest')).data,
  importAllSampleData: async (body = {}) =>
    (
      await api.post('/huawei/sample-data/import-all', body, {
        timeout: 600000,
      })
    ).data,
  listCustomerOrderSummary: async (params = {}) =>
    (await api.get('/huawei/workflow/customer-order-summary', { params })).data,
  listOrderSummary: async (params = {}) =>
    (await api.get('/huawei/workflow/order-summary', { params })).data,
  listItemDetailsPermanent: async (params = {}) =>
    (await api.get('/huawei/workflow/item-details', { params })).data,
  listConfirmedOrders: async (params = {}) =>
    (await api.get('/huawei/workflow/confirmed-orders', { params })).data,
  listPendingOrders: async (params = {}) =>
    (await api.get('/huawei/workflow/pending-orders', { params })).data,
  listPendingMismatchItems: async (params = {}) =>
    (await api.get('/huawei/workflow/pending-order-mismatch-items', { params })).data,
  exportPendingMismatchExcel: async (params = {}) => {
    const res = await api.get('/huawei/workflow/pending-order-mismatch-items/export', {
      params,
      responseType: 'blob',
    });
    return res.data;
  },
  confirmInputOrder: async (id, body = {}) =>
    (await api.post(`/huawei/orders/${id}/confirm-input`, body)).data,
  rejectInputOrder: async (id, body = {}) =>
    (await api.post(`/huawei/orders/${id}/reject-input`, body)).data,
  listCheckingOrders: async (params = {}) =>
    (await api.get('/huawei/workflow/checking-orders', { params })).data,
  listReceivedItems: async (params = {}) =>
    (await api.get('/huawei/workflow/received-items', { params })).data,
  listReceivedOrders: async (params = {}) =>
    (await api.get('/huawei/workflow/received-orders', { params })).data,
  markOrderChecking: async (id, body = {}) =>
    (await api.post(`/huawei/orders/${id}/mark-checking`, body)).data,
  markOrderReceived: async (id, body = {}) =>
    (await api.post(`/huawei/orders/${id}/mark-received`, body)).data,
  recordGrManual: async (body) => (await api.post('/huawei/workflow/gr/manual', body)).data,
  uploadGrSheet: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/huawei/workflow/gr/upload', fd, multipartFileUploadConfig);
    return res.data;
  },
  previewHuaweiDn: async (params = {}) =>
    (await api.get('/huawei/workflow/huawei-dn/preview', { params })).data,
  createHuaweiDn: async (body) => (await api.post('/huawei/workflow/huawei-dn/create', body)).data,
  listHuaweiDns: async (params = {}) => (await api.get('/huawei/workflow/huawei-dn', { params })).data,
  getHuaweiDn: async (id) => (await api.get(`/huawei/workflow/huawei-dn/${id}`)).data,
};

/** Huawei packing/shipment workflow (legacy — separate from huawei_orders). */
export const huaweiApi = {
  health: async () => (await api.get('/huawei/health')).data,
  listShipments: async (panel, q = '', limit = 100) =>
    (await api.get('/huawei/shipments', { params: { panel, q, limit } })).data,
  getShipment: async (id) => (await api.get(`/huawei/shipments/${id}`)).data,
  uploadPackingList: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/huawei/packing-list/upload', fd, multipartFileUploadConfig);
    return res.data;
  },
  dsaFolderStatus: async (params = {}) => (await api.get('/huawei/dsa-folder/status', { params })).data,
  importDsaFolderToPacking: async (body = {}) =>
    (await api.post('/huawei/dsa-folder/import-packing', body)).data,
  runSapMatch: async (id) => (await api.post(`/huawei/shipments/${id}/sap-match`)).data,
  confirm: async (id) => (await api.post(`/huawei/shipments/${id}/confirm`)).data,
  startTransit: async (id) => (await api.post(`/huawei/shipments/${id}/start-transit`)).data,
  uploadGrn: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await api.post('/huawei/grn/upload', fd, multipartFileUploadConfig);
    return res.data;
  },
  generateDeliveryNote: async (id) => (await api.post(`/huawei/shipments/${id}/delivery-note`)).data,
  downloadDeliveryNote: async (dnId) => {
    const res = await api.get(`/huawei/delivery-notes/${dnId}/download`, { responseType: 'blob' });
    return res.data;
  },
  markDelivered: async (id) => (await api.post(`/huawei/shipments/${id}/mark-delivered`)).data,
  markLineDelivered: async (shipmentId, lineId) =>
    (await api.post(`/huawei/shipments/${shipmentId}/lines/${lineId}/delivered`)).data,
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

async function downloadBlobPost(url, body, defaultFilename) {
  const res = await api.post(url, body, { responseType: 'blob' });
  const fname = filenameFromContentDisposition(res.headers['content-disposition']) || defaultFilename;
  const blobUrl = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = fname;
  a.click();
  URL.revokeObjectURL(blobUrl);
  return res;
}

export const documentFlowApi = {
  list: async (params) => (await api.get('/document-flow', { params })).data,
  dashboard: async (params) => (await api.get('/document-flow/dashboard', { params })).data,
  completionReport: async (params) => (await api.get('/document-flow/completion-report', { params })).data,
  getBySalesOrderTree: async (salesOrderNumber, params) =>
    (await api.get(`/document-flow/by-sales-order/${encodeURIComponent(salesOrderNumber)}`, { params })).data,
  getByInvoice: async (invoiceNumber, params) =>
    (await api.get(`/document-flow/by-invoice/${encodeURIComponent(invoiceNumber)}`, { params })).data,
  getByOutboundTree: async (outboundNumber, params) =>
    (await api.get(`/document-flow/by-outbound/${encodeURIComponent(outboundNumber)}`, { params })).data,
  getBySalesOrder: async (salesOrderNumber, params) =>
    (await api.get(`/document-flow/sales-order/${encodeURIComponent(salesOrderNumber)}`, { params })).data,
  get: async (outboundNumber, params) =>
    (await api.get(`/document-flow/${encodeURIComponent(outboundNumber)}`, { params })).data,
  ensure: async (body) => (await api.post('/document-flow/ensure', body)).data,
  linkOutbound: async (salesOrderNumber, body) =>
    (await api.post(`/document-flow/sales-order/${encodeURIComponent(salesOrderNumber)}/link-outbound`, body)).data,
  uploadToSalesOrder: async (salesOrderNumber, formData) =>
    (
      await api.post(
        `/document-flow/sales-order/${encodeURIComponent(salesOrderNumber)}/upload`,
        formData,
        multipartFileUploadConfig
      )
    ).data,
  deleteDocument: async (salesOrderNumber, documentId, params) =>
    (
      await api.delete(
        `/document-flow/sales-order/${encodeURIComponent(salesOrderNumber)}/documents/${documentId}`,
        { params }
      )
    ).data,
  pasteAccounting: async (salesOrderNumber, formData) =>
    (
      await api.post(
        `/document-flow/sales-order/${encodeURIComponent(salesOrderNumber)}/paste-accounting-document`,
        formData,
        multipartFileUploadConfig
      )
    ).data,
  setAccounting: async (salesOrderNumber, body) =>
    (await api.post(`/document-flow/sales-order/${encodeURIComponent(salesOrderNumber)}/accounting-document`, body))
      .data,
  setAccountingByOutbound: async (outboundNumber, body) =>
    (await api.post(`/document-flow/${encodeURIComponent(outboundNumber)}/accounting-document`, body)).data,
  verify: async (_outboundNumber, body) =>
    (await api.post(`/document-flow/${encodeURIComponent(body.outbound_number || '_')}/verify`, body)).data,
  report: async (salesOrderNumber, params) =>
    (await api.get(`/document-flow/sales-order/${encodeURIComponent(salesOrderNumber)}/report`, { params })).data,
  completeCheck: async (salesOrderNumber, params) =>
    (
      await api.post(
        `/document-flow/sales-order/${encodeURIComponent(salesOrderNumber)}/check-completion`,
        null,
        { params }
      )
    ).data,
  customerPoPrompt: async (salesOrderNumber, params) =>
    (await api.get(`/document-flow/sales-order/${encodeURIComponent(salesOrderNumber)}/customer-po-prompt`, { params }))
      .data,
  downloadPack: async (salesOrderNumber, params) => {
    const res = await api.get(`/document-flow/sales-order/${encodeURIComponent(salesOrderNumber)}/download-pack`, {
      params,
      responseType: 'blob',
    });
    return res.data;
  },
  upload: async (outboundNumber, formData) =>
    (
      await api.post(`/document-flow/${encodeURIComponent(outboundNumber)}/upload`, formData, multipartFileUploadConfig)
    ).data,
};

export const documentWorkflowApi = {
  list: async (params) => (await api.get('/document-workflows', { params })).data,
  byOutbound: async (outboundNumber, params) =>
    (await api.get(`/document-workflows/by-outbound/${encodeURIComponent(outboundNumber)}`, { params })).data,
  byInvoice: async (invoiceNumber, params) =>
    (await api.get(`/document-workflows/by-invoice/${encodeURIComponent(invoiceNumber)}`, { params })).data,
  ensure: async (body) => (await api.post('/document-workflows/ensure', body)).data,
  saveDnPdf: async (body) => (await api.post('/document-workflows/save-dn-pdf', body)).data,
  uploadCustomerPo: async (formData) =>
    (await api.post('/document-workflows/upload-customer-po', formData, multipartFileUploadConfig)).data,
  uploadInvoice: async (formData) =>
    (await api.post('/document-workflows/upload-invoice', formData, multipartFileUploadConfig)).data,
  uploadPod: async (formData) =>
    (await api.post('/document-workflows/upload-pod', formData, multipartFileUploadConfig)).data,
  uploadAccounting: async (formData) =>
    (await api.post('/document-workflows/upload-accounting-document', formData, multipartFileUploadConfig)).data,
  uploadOther: async (formData) =>
    (await api.post('/document-workflows/upload-other', formData, multipartFileUploadConfig)).data,
  verify: async (id, payload) => (await api.post(`/document-workflows/by-id/${id}/verify`, payload)).data,
  report: async (params) => (await api.get('/reports/document-workflow', { params })).data,
};

export const podPagePickerApi = {
  missingPods: async (params = {}) => (await api.get('/pod-page-picker/missing-pods', { params })).data,
  uploadSelectedPod: async (formData) =>
    (
      await api.post('/pod-page-picker/upload-selected-pod', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
    ).data,
};

export const downloadDutiesApi = {
  bySalesOrder: async (body, warehouseId) => {
    const payload = { ...body, warehouse_id: warehouseId };
    if (body.mode === 'manifest') {
      return (await api.post('/download-duties/by-sales-order', payload)).data;
    }
    await downloadBlobPost('/download-duties/by-sales-order', payload, `SO_${body.sales_order_number}_PACKAGE.zip`);
  },
  byInvoice: async (body, warehouseId) => {
    await downloadBlobPost(
      '/download-duties/by-invoice',
      { ...body, warehouse_id: warehouseId },
      `ACC_INV_OUT_${body.invoice_number}.pdf`
    );
  },
  byOutbound: async (body, warehouseId) => {
    await downloadBlobPost(
      '/download-duties/by-outbound',
      { ...body, warehouse_id: warehouseId },
      `ACC_INV_OUT_${body.outbound_number}.pdf`
    );
  },
  downloadDocument: async (documentId, warehouseId, defaultFilename) => {
    const res = await api.get(`/download-duties/document/${documentId}/download`, {
      params: { warehouse_id: warehouseId },
      responseType: 'blob',
    });
    const fname =
      filenameFromContentDisposition(res.headers['content-disposition']) ||
      defaultFilename ||
      `document_${documentId}.pdf`;
    downloadBlob(res.data, fname);
  },
  byAccounting: async (body, warehouseId) => {
    await downloadBlobPost(
      '/download-duties/by-accounting-document',
      { ...body, warehouse_id: warehouseId },
      `ACC_${body.accounting_document_number}.pdf`
    );
  },
};

export const documentQueryApi = {
  resolve: async (params = {}) => (await api.get('/document-query/resolve', { params })).data,
  downloadFinancePdf: async (body = {}) => {
    await downloadBlobPost('/document-query/download-finance-pdf', body, 'FINANCE_DOCUMENT_SET.pdf');
  },
};

export const salesOrderDocumentsApi = {
  listFolders: async (params) => (await api.get('/sales-order-folders', { params })).data,
  getFolder: async (salesOrderNumber, params) =>
    (await api.get(`/sales-order-folders/${encodeURIComponent(salesOrderNumber)}`, { params })).data,
  ensureFolder: async (body) => (await api.post('/sales-order-folders/ensure', body)).data,
  driveSetup: async (params) => (await api.get('/sales-order-folders/drive-setup', { params })).data,
  exportManifest: async (salesOrderNumber, body = {}) =>
    (await api.post(`/sales-order-folders/${encodeURIComponent(salesOrderNumber)}/export-manifest`, body)).data,
  listDocuments: async (salesOrderNumber) => (await api.get(`/sales-order-documents/${encodeURIComponent(salesOrderNumber)}`)).data,
  byOutbound: async (outboundNumber, params) =>
    (await api.get(`/sales-order-documents/by-outbound/${encodeURIComponent(outboundNumber)}`, { params })).data,
  byInvoice: async (invoiceNumber, params) =>
    (await api.get(`/sales-order-documents/by-invoice/${encodeURIComponent(invoiceNumber)}`, { params })).data,
  status: async (salesOrderNumber) =>
    (await api.get(`/sales-order-documents/${encodeURIComponent(salesOrderNumber)}/status`)).data,
  report: async (params) => (await api.get('/sales-order-documents/report', { params })).data,
  documentTrackingReport: async (params) => (await api.get('/reports/document-tracking', { params })).data,
  saveDnPdf: async (body) => (await api.post('/sales-order-documents/save-dn-pdf', body)).data,
  downloadOptions: async (body) => (await api.post('/sales-order-documents/download-options', body)).data,
  exportPackageManifest: async (body) => (await api.post('/sales-order-documents/export-package-manifest', body)).data,
  upload: async (formData) =>
    (await api.post('/sales-order-documents/upload', formData, multipartFileUploadConfig)).data,
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
