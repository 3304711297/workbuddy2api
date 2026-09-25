import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import { execSync } from 'child_process';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));
let gitHash = 'dev';
try {
  gitHash = execSync('git rev-parse --short HEAD').toString().trim();
} catch (e) {}
const buildFingerprint = `v${pkg.version} ${gitHash}`;

// Tauri 要求产物使用相对路径；输出目录与 src-tauri/tauri.conf.json 的 frontendDist 对应
export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_HASH__: JSON.stringify(gitHash),
    // 指纹只含「版本 + 构建提交」，与 Hermes 的展示形态一致（v0.21.3 xxxxxxx）。
    // 刻意不含日期：日期不携带任何可行动信息，却会随每次构建漂移，
    // 让人误以为「内容变了」——判据应是版本与提交，不是日历。
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
