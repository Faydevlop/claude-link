import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Everything except Electron is bundled, so the packaged app needs no node_modules.
const external = ['electron', 'bufferutil', 'utf-8-validate'];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external,
        input: { index: resolve(__dirname, 'src/main/index.ts'), mcp: resolve(__dirname, 'src/main/mcp.ts') },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: { external, input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, '../web'),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: resolve(__dirname, '../web/index.html') },
    },
  },
});
