import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // ESM 下用 import.meta.url 解析别名，避免 __dirname 不可用
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 21811, host: true },
  preview: { port: 21811, host: true },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
