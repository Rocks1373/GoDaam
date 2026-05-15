import { api } from './client';

export async function login(username: string, password: string) {
  const res = await api.post('/auth/login', { username, password });
  return res.data as {
    token: string;
    expires_at?: string;
    user: {
      id: number;
      username: string;
      role: string;
      full_name?: string;
      permissions: Record<string, boolean>;
      warehouses?: { id: number; warehouse_code: string; warehouse_name: string }[];
      default_warehouse_id?: number | null;
    };
  };
}

export async function changePassword(current_password: string, new_password: string) {
  await api.post('/auth/change-password', { current_password, new_password });
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
