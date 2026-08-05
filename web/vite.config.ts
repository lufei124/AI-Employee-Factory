import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: directory,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(directory, '../dist/web'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
