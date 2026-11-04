import { defineConfig } from 'vite';
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

export default defineConfig({
  // Served by the hub itself: talk only to that origin.
  plugins: [react(), tailwindcss(), csp("'self' wss: ws:")],
  server: {
    proxy: {
      // Development only: the local hub's certificate is self-signed, so the dev proxy does not verify it.
      '/api': { target: 'https://127.0.0.1:4545', secure: false },
      '/ws': { target: 'wss://127.0.0.1:4545', ws: true, secure: false },
    },
  },
});
