import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port, fail if that port is not available
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
  // to make use of `TAURI_DEBUG` and other env variables
  // https://tauri.studio/v1/api/config#buildconfig.beforedevcommand
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: process.env.TAURI_PLATFORM == 'windows' ? 'chrome105' : 'safari13',
    // don't minify for debug builds
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  resolve: {
    alias: process.env.VITE_BUILD_TAURI
      ? {}
      : {
          // Web/Docker builds should not bundle Tauri dialog APIs.
          // Stub them so the UI can gracefully fall back.
          '@tauri-apps/plugin-dialog': path.resolve(__dirname, 'src/lib/tauriDialogStub.ts'),
          // Legacy path (Tauri v1) kept for safety.
          '@tauri-apps/api/dialog': path.resolve(__dirname, 'src/lib/tauriDialogStub.ts'),
        },
  },
})
