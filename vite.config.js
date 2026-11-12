import { defineConfig } from 'vite';

// In dev the game is served by Vite and talks to the Node server on :8787.
export default defineConfig({
  // The game uses plain CSS; this stops Vite looking for a PostCSS setup elsewhere.
  css: { postcss: { plugins: [] } },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
});
