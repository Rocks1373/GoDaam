import { api } from './client';

export async function login(username: string, password: string) {
  const res = await api.post('/auth/login', { username, password });
  return res.data as {
    token: string;
    expires_at?: string;
    user: { id: number; username: string; role: string; full_name?: string; permissions: Record<string, boolean> };
  };
}

export async function me() {
  const res = await api.get('/auth/me');
  return res.data as {
    user: {
      id: number;
      username: string;
      role: string;
      full_name?: string;
      permissions: Record<string, boolean>;
    };
  };
}
