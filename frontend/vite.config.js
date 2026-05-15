import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

const PWA_THEME = '#0f766e'
const PWA_BG = '#f4f7fb'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['LOGO.png', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png'],
      manifest: {
        id: '/',
        name: 'GoDam Warehouse',
        short_name: 'GoDam',
        description: 'Warehouse operations — stock, outbound, delivery, Huawei matching, and reporting.',
        theme_color: PWA_THEME,
        background_color: PWA_BG,
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        /** Precache hashed build assets + public icons only — never cache /api or authenticated data. */
        globPatterns: ['**/*.{js,css,html}', 'LOGO.png', 'pwa-192x192.png', 'pwa-512x512.png', 'apple-touch-icon.png'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/huawei-godam-app(?:\/|$)/],
        runtimeCaching: [],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/api')
      },
      // /uploads is no longer a public static route. Uploaded files are now served
      // only via the authenticated /api/files/uploads/* endpoint, which is already
      // covered by the '/api' proxy entry above.
      '/huawei-godam-app': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
      },
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  css: {
    postcss: './postcss.config.js',
  },
})
