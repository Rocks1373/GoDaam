/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
        },
        warehouse: {
          gray: '#f8fafc',
          blue: '#3b82f6',
          green: '#10b981',
          orange: '#f59e0b',
          red: '#ef4444',
        },
        /** Semantic tokens — values come from src/styles/themes.css */
        theme: {
          page: 'var(--surface-page)',
          card: 'var(--surface-card)',
          muted: 'var(--surface-muted)',
          elevate: 'var(--surface-elevate)',
          border: 'var(--border-default)',
          'border-strong': 'var(--border-strong)',
          primary: 'var(--color-primary)',
          'primary-hover': 'var(--color-primary-hover)',
          'primary-soft': 'var(--color-primary-soft)',
          fg: 'var(--text-primary)',
          'fg-muted': 'var(--text-muted)',
          'fg-secondary': 'var(--text-secondary)',
          header: 'var(--header-bg)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        loginGradient: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        loginBlob: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '33%': { transform: 'translate(28px, -22px) scale(1.06)' },
          '66%': { transform: 'translate(-22px, 16px) scale(0.94)' },
        },
        loginBlob2: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '33%': { transform: 'translate(-32px, 18px) scale(1.05)' },
          '66%': { transform: 'translate(24px, -28px) scale(0.93)' },
        },
        loginAntiLift: {
          '0%, 100%': { transform: 'translateY(0) translateX(0)' },
          '50%': { transform: 'translateY(-18vh) translateX(12px)' },
        },
        loginAntiLift2: {
          '0%, 100%': { transform: 'translateY(4vh) translateX(0)' },
          '50%': { transform: 'translateY(-22vh) translateX(-16px)' },
        },
        loginGridDrift: {
          '0%': { transform: 'translateY(0)' },
          '100%': { transform: 'translateY(-48px)' },
        },
        loginShimmer: {
          '0%': { backgroundPosition: '200% 50%' },
          '100%': { backgroundPosition: '-100% 50%' },
        },
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'login-gradient': 'loginGradient 18s ease infinite',
        'login-blob': 'loginBlob 24s ease-in-out infinite',
        'login-blob-2': 'loginBlob2 30s ease-in-out infinite',
        'login-antilift': 'loginAntiLift 42s ease-in-out infinite',
        'login-antilift-2': 'loginAntiLift2 55s ease-in-out infinite',
        'login-grid-drift': 'loginGridDrift 24s linear infinite',
        'login-shimmer': 'loginShimmer 10s linear infinite',
      },
    },
  },
  plugins: [],
}
