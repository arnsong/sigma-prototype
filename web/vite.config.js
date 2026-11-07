import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: { manualChunks: { codemirror: ['@codemirror/view', '@codemirror/state', '@codemirror/lang-sql', '@codemirror/language', '@codemirror/autocomplete'] } },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL || 'http://localhost:3001' },
  },
});
