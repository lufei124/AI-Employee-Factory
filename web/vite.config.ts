import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: directory,
  plugins: [react()],
  build: {
    outDir: path.resolve(directory, '../dist/web'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
