import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// In development the API runs on :4000. Proxying /graphql (HTTP + WebSocket) keeps the browser
// same-origin, exactly like production where the server serves this app — so no CORS config at all.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/graphql': { target: 'http://localhost:4000', ws: true },
    },
  },
  test: { environment: 'node' },
});
