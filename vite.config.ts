import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const devHost = process.env.TAURI_DEV_HOST;
export default defineConfig({ plugins: [react()], clearScreen: false, server: { host: devHost || '127.0.0.1', port: 1420, strictPort: true, ...(devHost ? { hmr: { protocol: 'ws', host: devHost, port: 1421 } } : {}) }, envPrefix: ['VITE_', 'TAURI_ENV_'], build: { target: 'es2022' } });
