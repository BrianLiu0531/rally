import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5192, proxy: { '/ws': { target: 'ws://localhost:8080', ws: true }, '/api': 'http://localhost:8080' } },
});
