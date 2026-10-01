import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The editor is a static single-page app. Workspace packages are consumed as TypeScript source.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5178, host: '127.0.0.1' },
  preview: { port: 5179, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true },
});
