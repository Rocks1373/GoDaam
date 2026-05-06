import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { authApi } from '../services/api';
import ThemeSwitcher from '../components/ThemeSwitcher';

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

function buildStars(count = 76) {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    leftPct: (i * 41.3 + 7 * (i % 11)) % 100,
    topPct: (i * 29.7 + 13 * (i % 9)) % 100,
    size: 1 + (i % 6),
    baseOp: 0.14 + (i % 10) * 0.06,
    driftX: `${((i % 7) - 3) * 2.5}px`,
    driftY: `${((i % 5) - 2) * -2.5}px`,
    driftDur: 16 + (i % 19),
    twDur: 2.8 + (i % 6) * 0.55,
    twDelay: `${-(i * 0.29)}s`,
    driftDelay: `${-(i * 0.61)}s`,
    hue:
      i % 5 === 0 ? 'rgba(224,242,254,0.95)' : i % 5 === 1 ? 'rgba(221,214,254,0.9)' : 'rgba(255,255,255,0.92)',
  }));
}

export default function Login({ onLoggedIn }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reduceMotion = usePrefersReducedMotion();
  const rootRef = useRef(null);
  const glowRef = useRef(null);
  const starElsRef = useRef([]);
  const mouseRef = useRef({ x: 0, y: 0, active: false });

  const stars = useMemo(() => buildStars(76), []);

  const setStarRef = useCallback((index) => (el) => {
    starElsRef.current[index] = el;
  }, []);

  useEffect(() => {
    starElsRef.current = starElsRef.current.slice(0, stars.length * 2);
  }, [stars.length]);

  useEffect(() => {
    if (reduceMotion) return undefined;

    let id = 0;
    const influencePx = 158;
    const maxPullPx = 21;

    const tick = () => {
      const root = rootRef.current;
      const glow = glowRef.current;
      if (root) {
        const rect = root.getBoundingClientRect();
        const { x: mcx, y: mcy, active } = mouseRef.current;

        if (glow) {
          if (active) {
            const lx = mcx - rect.left;
            const ly = mcy - rect.top;
            glow.style.background = `radial-gradient(circle ${Math.min(210, rect.width * 0.28)}px at ${lx}px ${ly}px, rgba(219,234,254,0.2), rgba(129,140,248,0.08) 42%, transparent 68%)`;
            glow.style.opacity = '1';
          } else {
            glow.style.opacity = '0';
          }
        }

        const n = stars.length * 2;
        for (let i = 0; i < n; i += 1) {
          const el = starElsRef.current[i];
          const s = stars[i % stars.length];
          if (!el || !s) continue;

          const sr = el.getBoundingClientRect();
          const sx = sr.left + sr.width / 2 - rect.left;
          const sy = sr.top + sr.height / 2 - rect.top;
          let px = 0;
          let py = 0;

          if (active) {
            const mx = mcx - rect.left;
            const my = mcy - rect.top;
            const dx = mx - sx;
            const dy = my - sy;
            const d = Math.hypot(dx, dy);
            if (d < influencePx && d > 0.4) {
              const t = 1 - d / influencePx;
              const pull = t * t * maxPullPx;
              px = (dx / d) * pull;
              py = (dy / d) * pull;
            }
          }

          el.style.transform = `translate3d(${px}px, ${py}px, 0)`;
        }
      }

      id = requestAnimationFrame(tick);
    };

    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [reduceMotion, stars]);

  const onMouseMoveRoot = useCallback((e) => {
    mouseRef.current = { x: e.clientX, y: e.clientY, active: true };
  }, []);

  const onLeaveRoot = useCallback(() => {
    mouseRef.current = { ...mouseRef.current, active: false };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authApi.login(username, password);
      authApi.setToken(res.token, res.expires_at);

      const redirectRaw = searchParams.get('redirect');
      if (redirectRaw && isAllowedAppRedirect(redirectRaw)) {
        const u = new URL(redirectRaw);
        u.searchParams.set('godam_token', res.token);
        window.location.replace(u.toString());
        return;
      }

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
    <div
      ref={rootRef}
      className="godam-login-root relative flex min-h-[100dvh] flex-col overflow-hidden bg-[#020617]"
      onMouseMove={onMouseMoveRoot}
      onMouseLeave={onLeaveRoot}
    >
      {/* Deep space base */}
      <div
        className="godam-login-bg-shift pointer-events-none absolute inset-0 bg-[length:220%_220%]"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 90% 75% at 18% 28%, rgba(30,58,138,0.35), transparent 58%), radial-gradient(ellipse 85% 70% at 82% 72%, rgba(76,29,149,0.32), transparent 55%), radial-gradient(ellipse 120% 90% at 50% 50%, rgba(15,23,42,0.9), #020617)',
        }}
        aria-hidden
      />

      {/* Slow galaxy / nebula rotation */}
      <div
        className="godam-login-galaxy-spin pointer-events-none absolute inset-[-55%] opacity-[0.42] mix-blend-screen"
        style={{
          background:
            'radial-gradient(ellipse 42% 36% at 44% 46%, rgba(168,85,247,0.55), transparent 62%), radial-gradient(ellipse 52% 42% at 58% 54%, rgba(59,130,246,0.45), transparent 58%), radial-gradient(ellipse 68% 52% at 36% 58%, rgba(236,72,153,0.28), transparent 64%), radial-gradient(ellipse 90% 72% at 50% 48%, rgba(15,118,110,0.12), transparent 70%)',
          filter: 'blur(1px)',
        }}
        aria-hidden
      />

      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(2,6,23,0.55)_55%,rgba(2,6,23,0.92)_100%)]"
        aria-hidden
      />

      {/* Subtle star-field grid */}
      <div
        className="godam-login-grid-x pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(148,163,184,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.12) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
        aria-hidden
      />

      {/* Stars — slow drift left→right (seamless marquee) + magnetic pull near cursor */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="godam-login-star-marquee-motion flex h-full min-h-full w-[200%]">
          {[0, 1].map((panel) => (
            <div key={panel} className="relative h-full min-h-full w-1/2 shrink-0">
              {stars.map((s, i) => (
                <span
                  key={`${panel}-${s.id}`}
                  ref={setStarRef(panel * stars.length + i)}
                  className="godam-login-star-host absolute"
                  style={{ left: `${s.leftPct}%`, top: `${s.topPct}%` }}
                >
                  <span
                    className="godam-login-star-inner absolute left-0 top-0 block"
                    style={{
                      '--dx': s.driftX,
                      '--dy': s.driftY,
                      animationDuration: `${s.driftDur}s`,
                      animationDelay: s.driftDelay,
                    }}
                  >
                    <span
                      className="godam-login-star-dot block rounded-full shadow-[0_0_8px_currentColor]"
                      style={{
                        width: s.size,
                        height: s.size,
                        backgroundColor: s.hue,
                        color: s.hue,
                        '--base-op': s.baseOp,
                        animationDuration: `${s.twDur}s`,
                        animationDelay: s.twDelay,
                      }}
                    />
                  </span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Local glow follows cursor — same neighborhood as magnetic stars */}
      <div
        ref={glowRef}
        className="pointer-events-none absolute inset-0 z-[0] mix-blend-screen transition-opacity duration-300"
        style={{ opacity: 0 }}
        aria-hidden
      />

      <main className="relative z-[1] flex flex-1 flex-col items-center justify-center px-4 py-10 sm:py-12">
        <div className="w-full max-w-[420px]">
          <div className="godam-login-card-shell rounded-2xl p-[1px] shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_24px_70px_-28px_rgba(0,0,0,0.88)] [background:linear-gradient(135deg,rgba(165,243,252,0.35)_0%,rgba(129,140,248,0.22)_45%,rgba(168,85,247,0.28)_100%)]">
            <div className="rounded-[0.96rem] border border-white/[0.07] bg-slate-950/55 px-7 pb-7 pt-8 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-2xl sm:px-8">
              <div className="mb-7 text-center">
                <img
                  src="/LOGO.png"
                  alt="GoDam"
                  className="mx-auto mb-4 h-[4.5rem] w-auto max-w-[180px] object-contain opacity-95 brightness-110 contrast-105 drop-shadow-[0_12px_40px_rgba(34,211,238,0.15)] sm:h-[5rem]"
                />
                <h1 className="text-[1.65rem] font-bold tracking-tight text-white sm:text-3xl">GoDam</h1>
                <p className="mt-2 text-[13px] font-medium text-slate-300 sm:text-sm">
                  Warehouse Operations System
                </p>
                <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                  Secure logistics control panel
                </p>
              </div>

              <form className="space-y-4" onSubmit={submit} noValidate>
                <div>
                  <label htmlFor="login-user" className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
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
                  <label htmlFor="login-pass" className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
                    Password
                  </label>
                  <input
                    id="login-pass"
                    name="password"
                    className="godam-login-field"
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
                    className="rounded-xl border border-red-500/35 bg-red-950/45 px-3 py-2.5 text-[13px] text-red-200 shadow-[0_0_24px_-10px_rgba(239,68,68,0.45)]"
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
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden />
                      Signing in…
                    </>
                  ) : (
                    'Sign In'
                  )}
                </button>

                <p className="text-center text-[10px] leading-relaxed text-slate-500">
                  Default admin via backend env{' '}
                  <span className="font-mono text-slate-400">ADMIN_USERNAME</span> /{' '}
                  <span className="font-mono text-slate-400">ADMIN_PASSWORD</span>
                </p>
              </form>
            </div>
          </div>
        </div>

        <p className="relative z-[1] mt-8 max-w-md px-2 text-center text-[11px] text-slate-600">
          Powered by GoDam Warehouse System
        </p>
      </main>

      <div className="fixed bottom-4 right-4 z-[2] opacity-90">
        <ThemeSwitcher />
      </div>
    </div>
  );
}
