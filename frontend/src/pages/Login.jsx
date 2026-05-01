import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { authApi } from '../services/api';

export default function Login({ onLoggedIn }) {
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authApi.login(username, password);
      authApi.setToken(res.token, res.expires_at);
      onLoggedIn?.(res.user);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || 'Login failed';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden flex items-center justify-center px-4 py-10">
      {/* Animated gradient base */}
      <div
        className="absolute inset-0 bg-[length:400%_400%] animate-login-gradient bg-gradient-to-br from-slate-950 via-blue-950 to-slate-900"
        aria-hidden
      />

      {/* Mesh / grid overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, rgba(255,255,255,0.14) 1px, transparent 0)`,
          backgroundSize: '40px 40px',
        }}
        aria-hidden
      />

      {/* Floating blobs */}
      <div
        className="pointer-events-none absolute -left-24 top-1/4 h-72 w-72 rounded-full bg-blue-500/25 blur-3xl animate-login-blob"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -right-32 bottom-1/4 h-96 w-96 rounded-full bg-cyan-400/20 blur-3xl animate-login-blob-2"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute left-1/2 top-12 h-48 w-48 -translate-x-1/2 rounded-full bg-indigo-400/15 blur-2xl animate-login-blob"
        style={{ animationDelay: '-6s' }}
        aria-hidden
      />

      {/* Card */}
      <div className="relative z-10 w-full max-w-lg rounded-2xl border border-white/15 bg-white/92 p-8 shadow-2xl shadow-slate-950/40 backdrop-blur-md">
        <div className="mb-6 text-center">
          <img
            src="/LOGO.png"
            alt="GoDaam"
            className="mx-auto mb-4 h-24 w-auto max-w-[220px] object-contain"
          />
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">GoDaam Web Admin</h1>
          <p className="mt-1 text-sm text-slate-600">Sign in to your warehouse dashboard</p>
        </div>

        <form className="space-y-4" onSubmit={submit}>
          <div>
            <label htmlFor="login-user" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-600">
              Username
            </label>
            <input
              id="login-user"
              className="input-field mt-0 py-2.5 text-sm"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              disabled={loading}
            />
          </div>
          <div>
            <label htmlFor="login-pass" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-600">
              Password
            </label>
            <input
              id="login-pass"
              className="input-field mt-0 py-2.5 text-sm"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={loading}
            />
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </div>
          ) : null}

          <button
            className="btn-primary flex w-full items-center justify-center gap-2 py-2.5 text-sm disabled:opacity-60"
            type="submit"
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </button>

          <p className="text-center text-[11px] text-slate-500">
            Default admin can be set via backend env:{' '}
            <span className="font-mono text-slate-600">ADMIN_USERNAME</span> /{' '}
            <span className="font-mono text-slate-600">ADMIN_PASSWORD</span>
          </p>
        </form>
      </div>
    </div>
  );
}
