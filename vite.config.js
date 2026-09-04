import { defineConfig } from 'vite';

// Tauri 要求产物使用相对路径；输出目录与 src-tauri/tauri.conf.json 的 frontendDist 对应
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome105',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
