# CodeBuddy2OpenAI 桌面控制台 — 前端需求规格（给前端实现者）

> 你负责实现 Tauri v2 应用的**前端**（纯静态 HTML/CSS/JS，由 Vite 构建，产物输出到 `dist/`）。
> Rust 后端命令已实现并编译通过，你**只需要**通过 `window.__TAURI__.core.invoke()` 调用它们，**禁止**假设有其他后端能力。
> 全部文案使用**简体中文**。界面风格要求：现代深色主题、卡片式布局、状态色彩语义清晰（参考 EasyCLIProxyAPI 控制台质感）。

---

## 一、技术约束

1. 纯 vanilla HTML + CSS + JS（无框架），单入口 `index.html` + `src/main.js` + `src/style.css`，Vite 打包到 `dist/`。
2. Tauri API 通过 `@tauri-apps/api`（npm 包已可用）或全局 `window.__TAURI__` 调用；invoke 语法：
   ```js
   const { invoke } = window.__TAURI__.core;
   const result = await invoke('proxy_health', { port: 8787 });
   ```
3. **必须处理的命令契约**（后端已实现，签名固定，不可要求修改）：

   | 命令 | 入参 | 返回 | 说明 |
   |---|---|---|---|
   | `auth_begin` | `{platform: string}`（传 `"console"`） | `{state: string, auth_url: string}` | 发起登录，拿到 authUrl 后用 `window.open(authUrl)` 打开系统浏览器 |
   | `auth_poll` | `{state: string}` | `{code: number, msg: string, data: object\|null}` | 轮询登录结果。**`code === 11217` = 登录进行中**（继续轮询，建议 2s 间隔）；`data !== null` = 登录成功（含 accessToken/refreshToken/account）；其他 = 失败 |
   | `proxy_start` | `{port: number}` | `string`（如 `"started(port 8787)"`） | 启动 Python 反代；幂等 |
   | `proxy_stop` | 无 | `string` | 停止反代 |
   | `proxy_health` | `{port: number}` | `{status: string, authenticated: bool}` | 健康检查（安全收窄：不再返回身份信息）；**失败会 reject**（连接拒绝），需 catch 并显示「服务未运行」。账号昵称等身份信息改用 `accounts_list` 获取 |

4. 不需要实现真实二维码渲染（登录页直接展示 authUrl 链接 + 「打开浏览器登录」按钮即可）。

---

## 二、页面结构（三个 Tab + 顶部状态栏）

### 顶部状态栏（常驻）
- 左：应用标题「CodeBuddy2OpenAI」+ 版本号 v0.1.0
- 中：反代状态指示灯（绿=运行中 / 红=已停止 / 黄=启动中），旁边显示端口 `8787`
- 右：两个主操作按钮 —— 「启动服务」「停止服务」（运行状态切换可用性）
- 服务运行时每 5 秒自动调 `proxy_health` 刷新状态栏与「账号」Tab 数据

### Tab 1：登录（默认页）
- 说明文字：「无需 WorkBuddy 桌面端，浏览器登录即可完成授权」
- 按钮「开始登录」→ 调 `auth_begin({platform:'console'})` → 展示返回的 `authUrl` 为可点击链接 + 「在浏览器中打开」按钮（`window.open`）
- 拿到 `state` 后自动开始轮询 `auth_poll`，界面显示轮询状态动画（呼吸灯/转圈），文案随 `msg` 更新（如「等待登录…」）
- `data !== null` 时：显示成功动画 + 摘要（账号昵称、uid），并自动切到「账号」Tab
- 轮询期间提供「取消」按钮（停止轮询）

### Tab 2：账号
- 大卡片显示当前账号：昵称（大字）、uid（等宽小字）、企业名（若有）
- token 状态徽章：绿色「有效」/ 红色「已过期」+ 过期时间（格式 `YYYY-MM-DD HH:mm`，由 `token_expires_at` 毫秒时间戳换算）
- 数据来源：`accounts_list`（鉴权 Tauri 接口，含昵称/uid/到期时间）；服务运行状态仍由 `proxy_health` 判定

### Tab 3：设置
- 端口输入框（默认 8787，数字 1024-65535）
- 「开机自启」开关（可先做 UI，功能占位即可）
- 「关于」区：项目地址、说明文字

---

## 三、视觉与交互规范

1. **深色主题**：背景 `#0f1115`，卡片 `#1a1d24`，圆角 12px，卡片间距 16px
2. **主色**：`#4e8cff`（按钮、高亮、指示灯）；成功 `#34c77b`；警告 `#ffb020`；错误 `#ff5c5c`
3. **字体**：系统 UI 字体；数值/uid/token 时间戳用等宽字体（`ui-monospace, Consolas`）
4. 所有按钮 hover 有亮度变化、active 有按下位移 1px；状态切换有 200ms 过渡动画
5. 轮询等待必须有**动态效果**（呼吸圆点或旋转环），禁止死等无反馈
6. 异常路径全部有 toast/行内错误提示（红色），禁止静默失败
7. 窗口默认 800×600，布局需在 720px 宽度下不破版

---

## 四、交付物

```
index.html
src/main.js      # 全部交互逻辑
src/style.css    # 全部样式
vite.config.js   # build.outDir='dist'，base='./'（Tauri 要求相对路径）
package.json     # scripts.dev = vite, scripts.build = vite build
```

**验收标准**：`npm run build` 成功产出 `dist/`；`dist/index.html` 引用资源全部为相对路径；在 Tauri 窗口中三个 Tab 全部可交互、上述五条命令按契约正确调用与展示。
