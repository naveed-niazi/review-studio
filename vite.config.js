import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { bundleLicenses } from './scripts/bundle-licenses.mjs';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(
      JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version,
    ),
  },
  plugins: [react(), bundleLicenses()],
  server: { proxy: { '/api': 'http://127.0.0.1:8790' } },
});
