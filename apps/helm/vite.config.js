import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// SignalK serves this webapp's public/ folder at /openmarine-helm/, so all asset
// URLs must be relative (base: './'). The build lands in public/ — that's the
// directory SignalK serves (see any installed webapp, e.g. @mxtommy/kip).
//
// In dev (vite on :5180) we proxy the SignalK API and the embedded webapps to the
// Pi, so iframes pointing at /@signalk/... and /@mxtommy/... and the WebSocket data
// stream all work from the laptop exactly as they will on the Pi.
const PI = process.env.SK_HOST || 'http://openplotter.local:3000'

export default defineConfig({
  base: './',
  plugins: [react()],
  // Our build output IS public/ (what SignalK serves), so move Vite's static-copy
  // source off the default "public" to avoid the collision. Files in static/ are
  // copied to the build root — e.g. static/assets/icon.svg -> public/assets/icon.svg
  // (referenced by package.json signalk.appIcon).
  publicDir: 'static',
  build: {
    outDir: 'public',
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    proxy: {
      '/signalk': { target: PI, changeOrigin: true, ws: true },
      '/skServer': { target: PI, changeOrigin: true },
      '/@signalk': { target: PI, changeOrigin: true },
      '/@mxtommy': { target: PI, changeOrigin: true },
    },
  },
})
