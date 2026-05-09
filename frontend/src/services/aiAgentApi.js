import api from './api';

function normalizeError(e) {
  const msg =
    e?.response?.data?.error ||
    e?.response?.data?.detail ||
    e?.message ||
    'Request failed';
  return new Error(String(msg));
}

export const aiAgentApi = {
  health: async () => {
    try {
      return (await api.get('/ai/health')).data;
    } catch (e) {
      throw normalizeError(e);
    }
  },

  knowledgeStatus: async () => {
    try {
      return (await api.get('/ai/knowledge-status')).data;
    } catch (e) {
      throw normalizeError(e);
    }
  },

  chat: async ({ message, pageContext, entityId, userRole } = {}) => {
    try {
      return (
        await api.post('/ai/chat', {
          message,
          pageContext: pageContext || null,
          entityId: entityId || null,
          userRole: userRole || null,
        })
      ).data;
    } catch (e) {
      throw normalizeError(e);
    }
  },

  runDiagnostic: async ({ name, args = {} } = {}) => {
    try {
      return (await api.post('/ai/run-diagnostic', { name, args })).data;
    } catch (e) {
      throw normalizeError(e);
    }
  },
};

