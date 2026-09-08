import { defineConfig } from 'vite';
import fs from 'fs';
import { execSync } from 'child_process';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));
let gitHash = 'dev';
try {
  gitHash = execSync('git rev-parse --short HEAD').toString().trim();
} catch (e) {}
const buildDate = new Date().toISOString().slice(0, 10);
const buildFingerprint = `v${pkg.version} (${gitHash} · ${buildDate})`;

// Tauri 要求产物使用相对路径；输出目录与 src-tauri/tauri.conf.json 的 frontendDist 对应
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_HASH__: JSON.stringify(gitHash),
    __BUILD_DATE__: JSON.stringify(buildDate),
    __BUILD_FINGERPRINT__: JSON.stringify(buildFingerprint),
  },
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
