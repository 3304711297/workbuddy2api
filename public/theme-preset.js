// 防闪烁：DOM 渲染前根据 localStorage / 系统偏好预设主题（默认深色）。
// 独立为 public/ 静态脚本：CSP 启用后 script-src 'self' 不允许内联脚本，
// 以外部文件方式既满足 CSP 又保持 head 内同步阻塞加载（无主题闪白）。
// 'system' 表示跟随系统：此时按系统偏好解析出 light/dark 写入 data-theme。
(function () {
  try {
    var t = localStorage.getItem('workbuddy2api.theme') || localStorage.getItem('codebuddy2openai.theme');
    if (t !== 'light' && t !== 'dark' && t !== 'system') {
      t = 'dark';
    }
    var resolved = t === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : t;
    document.documentElement.dataset.theme = resolved;
  } catch (e) { /* 存储不可用时保持深色默认 */ }
})();
