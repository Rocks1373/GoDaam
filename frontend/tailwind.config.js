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
        }
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
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'login-gradient': 'loginGradient 18s ease infinite',
        'login-blob': 'loginBlob 24s ease-in-out infinite',
        'login-blob-2': 'loginBlob2 30s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
