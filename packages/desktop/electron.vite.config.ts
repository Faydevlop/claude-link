import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Content-Security-Policy for built pages (not the dev server, which needs inline scripts for hot reload).
 * Scripts only from the app itself; network only to the team server (any LAN address, so any host).
 */
const csp = (connect: string) => ({
  name: 'claude-link-csp',
  apply: 'build' as const,
  transformIndexHtml: (html: string) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src ${connect}; object-src 'none'; base-uri 'none'; form-action 'none'" />`),
});

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
    // The desktop renderer talks to the team server at whatever LAN address it has.
    plugins: [react(), tailwindcss(), csp('https: wss: http: ws:')],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: resolve(__dirname, '../web/index.html') },
    },
  },
});
