import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(here, 'react'),
  plugins: [react()],
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': `http://127.0.0.1:${process.env.UI_PORT || 8787}` } },
});
