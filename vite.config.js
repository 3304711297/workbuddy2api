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
    watch: {
      // cargo 编译会写 src-tauri/target 下的 exe，Windows 上文件被锁会让 chokidar 报 EBUSY 崩溃
      ignored: ['**/src-tauri/target/**'],
    },
  },
});
