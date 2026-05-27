import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GoogleLogin } from '@react-oauth/google';
import { Barcode, Cpu, Database, Eye, EyeOff, Loader2, Network, Server, Truck, Warehouse } from 'lucide-react';
import { authApi } from '../services/api';
import ThemeSwitcher from '../components/ThemeSwitcher';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID || '';

/** Huawei Streamlit (etc.) sends users here with ?redirect=<absolute streamlit URL>. */
function isAllowedAppRedirect(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const u = new URL(urlStr);
    if (!/^https?:$/i.test(u.protocol)) return false;
    const h = u.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (typeof window !== 'undefined' && h === window.location.hostname) return true;
    return false;
  } catch {
    return false;
  }
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

function AntigravityParticleField({ reducedMotion }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext('2d', { alpha: true });
    let width = 0;
    let height = 0;
    let raf = 0;
    let particles = [];
    const pointer = { x: 0, y: 0, tx: 0, ty: 0, active: false };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(220, Math.max(110, Math.floor((width * height) / 6200)));
      const maxRadius = Math.min(width * 0.46, height * 0.52, 520);
      particles = Array.from({ length: count }, (_, i) => {
        const band = i % 7;
        const angle = ((i * 137.508) % 360) * (Math.PI / 180);
        const radius = 64 + (maxRadius - 64) * ((i * 0.618033 + band * 0.07) % 1);
        return {
          angle,
          radius,
          band,
          speed: 0.00045 + (band + 1) * 0.00008,
          length: 3.2 + (i % 5) * 1.35,
          width: 1 + (i % 4) * 0.28,
          alpha: 0.18 + (i % 8) * 0.055,
          phase: i * 0.37,
        };
      });
    };

    const onPointerMove = (event) => {
      const rect = canvas.getBoundingClientRect();
      pointer.tx = (event.clientX - rect.left - width / 2) / Math.max(width / 2, 1);
      pointer.ty = (event.clientY - rect.top - height / 2) / Math.max(height / 2, 1);
      pointer.active = true;
    };

    const onPointerLeave = () => {
      pointer.active = false;
      pointer.tx = 0;
      pointer.ty = 0;
    };

    const drawFallback = () => {
      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height * 0.42;
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.18)';
      ctx.lineWidth = 1;
      [116, 190, 276, 366].forEach((r) => {
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, r * 0.52, -0.18, 0, Math.PI * 2);
        ctx.stroke();
      });
    };

    const step = (now = 0) => {
      ctx.clearRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';

      pointer.x += ((pointer.active ? pointer.tx : 0) - pointer.x) * 0.045;
      pointer.y += ((pointer.active ? pointer.ty : 0) - pointer.y) * 0.045;

      const cx = width / 2 + pointer.x * 22;
      const cy = height * 0.42 + pointer.y * 18;
      const time = now || 0;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(pointer.x * 0.035);

      ctx.strokeStyle = 'rgba(37, 99, 235, 0.075)';
      ctx.lineWidth = 1;
      [104, 178, 254, 344, 438].forEach((r, i) => {
        ctx.beginPath();
        ctx.setLineDash([5 + i, 18 + i * 3]);
        ctx.ellipse(0, 0, r, r * (0.48 + i * 0.015), -0.14 + i * 0.05, 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        const drift = Math.sin(time * 0.0012 + p.phase) * 7;
        const wobble = Math.cos(time * 0.001 + p.phase) * 0.035;
        const a = p.angle + time * p.speed + wobble + pointer.x * 0.05;
        const rx = p.radius + drift + pointer.y * (p.band - 3) * 2.2;
        const ry = rx * (0.48 + p.band * 0.018);
        const x = Math.cos(a) * rx;
        const y = Math.sin(a) * ry;
        const tangent = a + Math.PI / 2 + Math.sin(time * 0.001 + p.phase) * 0.24;
        const half = p.length / 2;
        const alpha = p.alpha * (0.65 + Math.sin(time * 0.0015 + p.phase) * 0.22);

        ctx.strokeStyle = `rgba(37, 99, 235, ${alpha})`;
        ctx.lineWidth = p.width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(tangent) * half, y - Math.sin(tangent) * half);
        ctx.lineTo(x + Math.cos(tangent) * half, y + Math.sin(tangent) * half);
        ctx.stroke();

        if (i % 9 === 0) {
          ctx.fillStyle = `rgba(29, 78, 216, ${alpha * 0.55})`;
          ctx.beginPath();
          ctx.arc(x, y, 1.25, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
      raf = requestAnimationFrame(step);
    };

    resize();
    if (reducedMotion) {
      drawFallback();
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }

    raf = requestAnimationFrame(step);
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerleave', onPointerLeave);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [reducedMotion]);

  return <canvas ref={canvasRef} className="godam-antigravity-field absolute inset-0 z-[0] h-full w-full" aria-hidden />;
}

const techIcons = [
  { Icon: Warehouse, label: 'Warehouse', className: 'left-[9%] top-[23%] hidden md:flex' },
  { Icon: Server, label: 'Server', className: 'right-[12%] top-[24%] hidden md:flex' },
  { Icon: Database, label: 'Database', className: 'left-[16%] bottom-[21%] hidden lg:flex' },
  { Icon: Truck, label: 'Fleet', className: 'right-[16%] bottom-[23%] hidden lg:flex' },
  { Icon: Barcode, label: 'Barcode', className: 'left-[7%] bottom-[42%] hidden xl:flex' },
  { Icon: Cpu, label: 'AI', className: 'right-[8%] bottom-[43%] hidden xl:flex' },
  { Icon: Network, label: 'Network', className: 'left-1/2 top-[12%] hidden sm:flex -translate-x-1/2' },
];

export default function Login({ onLoggedIn }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reduceMotion = usePrefersReducedMotion();
  const rootRef = useRef(null);

  const onMouseMoveRoot = useCallback((e) => {
    const root = rootRef.current;
    if (!root || reduceMotion) return;
    const rect = root.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width - 0.5).toFixed(3);
    const y = ((e.clientY - rect.top) / rect.height - 0.5).toFixed(3);
    root.style.setProperty('--mx', x);
    root.style.setProperty('--my', y);
  }, [reduceMotion]);

  const onLeaveRoot = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    root.style.setProperty('--mx', '0');
    root.style.setProperty('--my', '0');
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authApi.login(username, password);
      await finishLogin(res);
    } catch (err) {
      const st = err?.response?.data?.status;
      const msg = err?.response?.data?.message || err?.response?.data?.error || err.message || 'Login failed';
      if (st === 'PENDING_APPROVAL' || st === 'REJECTED' || st === 'BLOCKED') {
        navigate('/auth/pending', { replace: true, state: { status: st, message: msg } });
        return;
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const finishLogin = async (res) => {
    authApi.setToken(res.token, res.expires_at);
    const redirectRaw = searchParams.get('redirect');
    if (redirectRaw && isAllowedAppRedirect(redirectRaw)) {
      const u = new URL(redirectRaw);
      u.searchParams.set('godam_token', res.token);
      window.location.replace(u.toString());
      return;
    }
    let nextUser = res.user;
    try {
      const me = await authApi.me();
      if (me?.user && Number(me.user.id) > 0) nextUser = me.user;
    } catch {
      /* keep login payload */
    }
    if (!nextUser || !Number(nextUser.id)) {
      setError('Profile could not be loaded.');
      authApi.logout();
      return;
    }
    onLoggedIn?.(nextUser);
    navigate('/dashboard', { replace: true });
  };

  const onGoogleSuccess = async (credentialResponse) => {
    const credential = credentialResponse?.credential;
    if (!credential) return;
    setError('');
    setLoading(true);
    try {
      const res = await authApi.googleLogin(credential);
      if (res?.token) {
        await finishLogin(res);
        return;
      }
      if (res?.status === 'PENDING_APPROVAL' || res?.success === false) {
        sessionStorage.setItem('godam_google_id_token', credential);
        navigate('/auth/pending', {
          replace: true,
          state: { status: res.status || 'PENDING_APPROVAL', message: res.message },
        });
        return;
      }
    } catch (err) {
      const st = err?.response?.data?.status;
      const msg = err?.response?.data?.message || err?.response?.data?.error || err.message;
      if (st === 'PENDING_APPROVAL' || st === 'REJECTED' || st === 'BLOCKED') {
        sessionStorage.setItem('godam_google_id_token', credential);
        navigate('/auth/pending', { replace: true, state: { status: st, message: msg } });
        return;
      }
      setError(msg || 'Google sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="godam-login-root godam-antigravity-root relative flex min-h-[100dvh] flex-col overflow-hidden"
      onMouseMove={onMouseMoveRoot}
      onMouseLeave={onLeaveRoot}
    >
      <div className="godam-antigravity-static pointer-events-none absolute inset-0 z-[0]" aria-hidden />
      <AntigravityParticleField reducedMotion={reduceMotion} />

      <div className="pointer-events-none absolute inset-0 z-[1]" aria-hidden>
        {techIcons.map(({ Icon, label, className }) => (
          <div key={label} className={`godam-tech-icon absolute ${className}`} title={label}>
            <Icon className="h-5 w-5" />
          </div>
        ))}
      </div>

      <main className="relative z-[2] flex flex-1 flex-col items-center justify-center px-4 py-8 sm:py-10">
        <section className="godam-antigravity-hero w-full max-w-[900px] text-center">
          <div className="godam-brand-mark mx-auto mb-5 inline-flex items-center gap-3 rounded-full border border-theme-border bg-theme-card/90 px-4 py-2.5 shadow-[var(--shadow-soft)] backdrop-blur">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-primary-gradient-end)] text-white shadow-[0_12px_28px_-16px_var(--glow-primary)] sm:h-10 sm:w-10">
              <Network className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden />
            </span>
            <span className="text-[13px] font-semibold tracking-[0.18em] text-theme-fg-secondary sm:text-[14px]">
              TECHNICAL LOGISTICS PLATFORM
            </span>
          </div>

          <div className="godam-login-card-shell mx-auto w-full max-w-[520px] rounded-[1.35rem] border border-theme-border bg-theme-card/90 p-8 shadow-[var(--shadow-raised)] backdrop-blur-xl sm:p-10">
            <div className="mb-7 text-center">
                <img
                  src="/LOGO.png"
                  alt="GoDam"
                  className="mx-auto mb-4 h-[4.85rem] w-auto max-w-[195px] object-contain drop-shadow-[0_18px_40px_rgba(37,99,235,0.14)] sm:h-[5.5rem] sm:max-w-[220px]"
                />
              <h1 className="text-[2.25rem] font-semibold tracking-tight text-theme-fg sm:text-[2.85rem]">GoDam</h1>
              <p className="mt-2 text-[15px] font-medium text-theme-fg-secondary sm:text-[16px]">
                Warehouse Operations System
              </p>
              <p className="mt-2 text-[12px] font-semibold uppercase tracking-[0.22em] text-theme-primary sm:text-[13px]">
                Secure logistics control panel
              </p>
            </div>

              {GOOGLE_CLIENT_ID ? (
                <div className="mb-6 flex flex-col items-stretch gap-3">
                  <p className="text-center text-[12px] font-semibold uppercase tracking-[0.2em] text-theme-fg-secondary">
                    Sign in with Google
                  </p>
                  <div className="flex justify-center rounded-xl border border-theme-border bg-[#1a1a1a] px-4 py-3 shadow-sm">
                    <GoogleLogin
                      onSuccess={onGoogleSuccess}
                      onError={() => setError('Google sign-in was cancelled or failed')}
                      theme="filled_black"
                      size="large"
                      text="continue_with"
                      shape="pill"
                      width="300"
                    />
                  </div>
                  <p className="text-center text-[11px] text-theme-fg-muted uppercase tracking-widest">
                    or sign in with username
                  </p>
                </div>
              ) : (
                <p className="mb-4 text-center text-[11px] text-amber-700">
                  Google Sign-In is not configured. Set VITE_GOOGLE_WEB_CLIENT_ID and restart the frontend dev server.
                </p>
              )}

              <form className="space-y-[1.15rem]" onSubmit={submit} noValidate>
                <div>
                  <label htmlFor="login-user" className="mb-1.5 block text-left text-[11px] font-bold uppercase tracking-[0.14em] text-theme-fg-muted sm:text-[12px]">
                    Username
                  </label>
                  <input
                    id="login-user"
                    name="username"
                    className="godam-login-field"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    disabled={loading}
                  />
                </div>
                <div>
                  <label htmlFor="login-pass" className="mb-1.5 block text-left text-[11px] font-bold uppercase tracking-[0.14em] text-theme-fg-muted sm:text-[12px]">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="login-pass"
                      name="password"
                      className="godam-login-field pr-11"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                      disabled={loading}
                    />
                    <button
                      type="button"
                      className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-theme-fg-muted transition-colors hover:text-theme-fg disabled:opacity-50"
                      onClick={() => setShowPassword((v) => !v)}
                      disabled={loading}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                    </button>
                  </div>
                </div>

                {error ? (
                  <div
                    role="alert"
                    className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-left text-[14px] text-red-700 shadow-[0_18px_36px_-30px_rgba(239,68,68,0.55)]"
                  >
                    {error}
                  </div>
                ) : null}

                <button
                  type="submit"
                  className="godam-login-submit flex w-full items-center justify-center gap-2"
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin shrink-0" aria-hidden />
                      Signing in…
                    </>
                  ) : (
                    'Sign In'
                  )}
                </button>

                <p className="text-center text-[11px] leading-relaxed text-theme-fg-muted sm:text-[12px]">
                  Default admin via backend env{' '}
                  <span className="font-mono text-theme-fg-secondary">ADMIN_USERNAME</span> /{' '}
                  <span className="font-mono text-theme-fg-secondary">ADMIN_PASSWORD</span>
                </p>

                <p className="text-center text-[12px] text-theme-fg-secondary pt-1 sm:text-[13px]">
                  <a
                    href="/api/mobile-app/apk"
                    className="font-semibold text-theme-primary hover:opacity-90 underline underline-offset-2"
                    download="GoDam.apk"
                  >
                    Download Android app (APK)
                  </a>
                </p>
              </form>
          </div>

          <div className="godam-login-status-row mx-auto mt-6 flex max-w-[680px] flex-wrap items-center justify-center gap-2 text-[12px] font-medium text-theme-fg-muted sm:text-[13px]">
            <span>Inventory intelligence</span>
            <span aria-hidden>•</span>
            <span>Fleet-ready operations</span>
            <span aria-hidden>•</span>
            <span>Secure warehouse data</span>
          </div>
        </section>
      </main>

      <div className="fixed bottom-4 right-4 z-[3] opacity-90">
        <ThemeSwitcher />
      </div>
    </div>
  );
}
