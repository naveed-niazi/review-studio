import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { bundleLicenses } from './scripts/bundle-licenses.mjs';

export default defineConfig({
  plugins: [react(), bundleLicenses()],
  server: { proxy: { '/api': 'http://127.0.0.1:8790' } },
});
