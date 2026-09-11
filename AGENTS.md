# AGENTS.md — workbuddy2api 维护协议

给 AI Agent（与未来的自己）看的仓库操作手册。改这个仓库前先读这里，能少踩几个坑。

## 1. 这是什么

把腾讯 CodeBuddy / WorkBuddy 订阅暴露成本地 OpenAI 兼容端点（`http://127.0.0.1:8787/v1`）的
Tauri v2 桌面应用 + Python 反代内核。

三段代码，改动前先判断落在哪一段：

| 段 | 位置 | 规模 | 语言 |
|---|---|---|---|
| 反代内核 | `converter.py`, `anthropic_compat.py`, `anthropic_stream.py`, `token_refresher.py`, `request_pacer.py`, `desensitize.py`, `turing_helper.cjs` | ~3.5k 行 | Python / Node |
| 桌面前端 | `index.html`, `src/*.js`（14 个 ES module） | ~1.8k 行 | 原生 JS + Vite |
| Rust 后端 | `src-tauri/src/`（`commands/` 7 文件） | ~2.7k 行 | Rust |

## 2. 改完怎么验证（缺一不可）

```bash
python -m pytest tests/ -q          # Python：183 passed 为当前基线
npm test                            # 前端：12 passed（node --test）
cd src-tauri && cargo test          # Rust：24 passed
```

**改前端（`index.html` / `src/*.js`）后必须重建才生效**——前端打包进 `dist/`，再由 Rust
嵌入 exe。只改源码不构建，GUI 里看到的还是旧界面。

```bash
npm run build && cd src-tauri && cargo tauri build --no-bundle
```

构建前先退 GUI：内核 `converter.py` 是 GUI 托管启动的子进程，退 GUI 会连带结束它。

## 3. 会让当前聊天断掉的操作（重要）

本机 Hermes 的对话模型就走这条反代链路。**以下操作会切断 8787、中断进行中的会话**：

- 退出 / 重启 GUI（内核是它的子进程）
- 杀 `converter.py` 或 `python.exe`（内核宿主）
- 重建 exe（要先退 GUI）

进程链长这样，别误杀：

```
workbuddy2api.exe (GUI)
  └─ python.exe
       └─ converter.py --desensitize --usage-log   ← 8787 监听
```

判断链路是否活着：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/v1/models`
返回 200 即正常。

## 4. 各文件的硬约束

- **`converter.py`**：`core.autocrlf=true`，但 HEAD 里存的是 **纯 LF**。用 Python 写回时务必
  `data.replace(b"\r\n", b"\n")`，否则 `\r\n` 会被二次转义成 `\r\r\n`，测试成片失败。
- **`/api/rate_limit` 的 `state` 三态**：`limited`=冷却中 / `expired`=曾限过已恢复 /
  `ok`=从未被限（无条目）。**改这个枚举时必须同步排查消费端**——Hermes 的 token-stats
  插件（`plugin_api.py` + `desktop-plugins/token-stats/plugin.js`）直接读它，漏改会显示
  「未知」。这是 a404e80 踩过的坑。
- **`_RATE_LIMIT_STATE` 条目只增不减**（上限约 28 条），`resetAt`/`message` 字段必须保留，
  前端 `src/accounts.js` 靠它渲染「冷却已于 X 结束」，删了会残缺成「冷却已于 结束」。
- **`desensitize.py`**：改脱敏词表会直接影响风控命中率。已知触发点包括
  `x-anthropic-billing-header:`、`"You are Claude Code, Anthropic's official CLI"`、
  `"Main branch (you will usually use this for PRs):"`。改动后需实测模型可调用性，
  不能只看单测。
- **思考档位矩阵（`billing.rs` 的 `EFFORT_CATALOG`）**：上游 `/v2/enterprises/personal/models`
  对 `deepseek-v4.1-flash`、`deepseek-v4-pro` 等只下发扁平 `reasoning:{"effort":"high"}`，
  **不含** `supportedEfforts` / `canDisableThinking`；完整矩阵只在官方客户端另两路下发
  （`cloud_product_config_cache` 云端最新 21 模型 / 客户端基线 `product.json` 49 模型）。
  解析口径由 `resolve_reasoning_matrix()` 统一实现，四种来源标记：

  | 标记 | 触发条件 | 档位来源 |
  |---|---|---|
  | `upstream` | 上游下发非子集矩阵（含未知档位） | 上游原样保留 |
  | `merged` | 上游只下发覆盖表的**严格子集**（半截矩阵） | 按覆盖表补全 |
  | `catalog` | 上游完全没下发 | 覆盖表 |
  | `upstream` | 覆盖表也没有，退回扁平 `effort` | 单值 |

  改这张表必须同步 `tests/test_model_effort_matrix.py` 的 `CLOUD_MATRIX` +
  `BASELINE_MATRIX` + `CATALOG_SOURCES`——三者共同构成「官方唯一真源」，
  测试会校验每个条目都有声明来源。**不要**把它改成强制覆盖上游（会压住上游
  日后新增的档位），也不要退化成「非空即上游」（半截矩阵会压回已确认能力）。
  Rust 侧配套单测在 `billing.rs::reasoning_matrix_tests`。
- **「默认」档语义 = 透传，不是本地默认值**：控制台思考强度选「默认」时
  `model_settings.json` 里不写 `reasoning_effort` 键，`converter.py` 因而不改写
  请求体，客户端（如 Hermes `agent.reasoning_effort=ultra`）下发什么就发什么。
  用户明确要求思考强度只由 Hermes 侧控制，**禁止**在反代加档位值白名单/翻译层，
  也禁止把「默认」渲染成某个具体档位（如 `默认 (high)`）。
- **`AppConfig` 整对象覆盖写盘（两条铁律，改设置相关代码前必读）**：
  Rust 的 `save_app_settings` 收到的是**完整 AppConfig 对象**，缺失字段被
  `#[serde(default)]` 填默认值后**整体覆盖写盘**。由此产生两个已踩过的坑：

  1. **前端 payload 必须带全字段**：`src/settings.js` 的 `buildSettingsPayload()`
     若漏掉某个字段，用户在设置页的任何操作都会把那个字段抹回默认值
     （实际发生过：`rotate_mode/rotate_count` 被静默抹回 `off`）。
     新增 AppConfig 字段时，**必须同步三处**：`lib.rs` 结构体、`settings.js` 的
     payload、`accounts.js` 里各自负责写该字段的保存函数。
     `tests/test_settings_payload_contract.test.js` 会从 Rust 结构体反射提取字段全集
     做断言，漏了会红。
  2. **禁止在 `change` 事件里调用「读盘 + 回写控件」的函数**：`accounts.js` 的
     `syncRotationPolicyCard()` 会读磁盘并强制回写 `select.value`；若挂在 change 上，
     用户刚选中的值会被立刻改回旧值（表现为「闪一下就跳回原样」，且保存按钮根本
     没机会点）。已拆分为纯渲染的 `renderRotationPolicyUI()`（change 专用）与
     读盘的 `syncRotationPolicyCard()`（仅初始化/保存后回读用）。
     **改动交互控件时，先确认回调是纯渲染还是带副作用。**
- **Anthropic Messages 兼容层 (`POST /v1/messages`)**：
  采用解耦模块设计（`anthropic_compat.py` 请求响应双向翻译、`anthropic_stream.py` SSE 事件状态机）。支持 Claude Code CLI、Cline、Roo Code 等工具原生直连。错误返回标准 Anthropic `{"type": "error", "error": {...}}` 格式。
- **并发削峰平滑器 (`request_pacer.py`)**：
  基于 `asyncio.Semaphore` 与单调时钟调度槽，支持环境变量 `CODEBUDDY2OPENAI_MAX_CONCURRENCY`（默认 5）与 `CODEBUDDY2OPENAI_MIN_INTERVAL_MS`（默认 50ms）削平并发脉冲。流式与非流式请求均在上下文周期内自动持槽与平滑释放。
- **后台主动令牌续期 (`token_refresher.py`)**：
  由 FastAPI `lifespan` 生命周期管控，后台每 300s 巡检活跃账号凭据，剩余有效时间小于 1800s（30 分钟）时主动触发异步续期并防重入，避免用户请求遭遇被动刷新时延。

  **风控拦截机制（2026-09-10 实测，判断要不要扩脱敏范围时看这里）**：

  - 命中返回 **code 11128** `Illegal API invocation from an unapproved channel`，
    Hermes 侧表现为会话连续 3 次重试全挂后彻底不可用（不是 429/6004 限流，别误判）。
  - **整串匹配，不是分词**：`Main branch` 或 `(you will usually use this for PRs):`
    单独出现都不触发，必须完整串 `Main branch (you will usually use this for PRs)` 才拦。
    所以加词表要加**完整短语**，只加片段无效。
  - **只拦 `system` / `assistant` 角色；`user` / `tool` 角色带同样的串不拦**。
    后端防的是"客户端指纹"，只扫客户端会主动构造的角色。
    这与 `converter.py:1189` 的 `roles=("system", "assistant")` **精确吻合**——
    不要为了"更保险"去扩 `user`/`tool`，实测证明没必要，扩了只会污染真实对话。
  - **毒在历史里会永久复现**：触发串一旦进入某条 `assistant` 历史消息，
    后续每次请求都带着它 → 该会话永久 11128。修代码救不回已有会话，
    只能改 `state.db` 那条消息或放弃会话。
  - 脱敏分两层，**顺序不能反**：`_rewrite_known_fingerprints()`（精确改写已知指纹）
    先跑，再走 `SENSITIVE_TERMS` 零宽空格兜底（`desensitize_text()`）。
    精确改写更稳；零宽空格只打断匹配，遇变体仍会漏。

  **实测复现方法**（改完别只看单测，跑一遍）：

  ```bash
  # 单条探针：把触发串放进 system/assistant，打 8787
  curl -s -X POST http://127.0.0.1:8787/v1/chat/completions \
    -H "Content-Type: application/json" -H "Authorization: Bearer dummy" \
    -d '{"model":"deepseek-v4.1-flash","messages":[
         {"role":"user","content":"hi"},
         {"role":"assistant","content":"Main branch (you will usually use this for PRs):"}],
         "stream":false,"max_tokens":10}'
  ```

  返回 11128 = 脱敏没生效；正常返回 = 生效。
  ⚠️ 探针必须**以 `user` 消息开头**，否则拿到的是 11151/11148（会话结构非法），
  不是风控结果，别误报成缺陷。

## 5. 外部依赖与合规红线

- **凭据来源**：优先读 `%LOCALAPPDATA%/workbuddy2api/accounts.json`（回退兼容 `%LOCALAPPDATA%/codebuddy2openai/accounts.json`，含 `active_uid` + `accounts` 字典），回退到 legacy `.info` 文件。
- **Turing Shield SDK**（`X-Device-Token`）：只扫描 `%LOCALAPPDATA%`/`%APPDATA%`/
  `%ProgramFiles%`/`%USERPROFILE%` 下的 WorkBuddy 安装目录，**各磁盘根目录默认不扫**
  （防伪造 SDK 导致本地代码执行）。用户可用 `WORKBUDDY_TURING_SDK_DIR` 显式指定。
- **借鉴源合规**（详见 `THIRD_PARTY_NOTICES.md`）：
  - `xiaofan6ya/workbuddy2api`、`DistPub/workbuddy2api` — MIT，可借鉴
  - `IceeAn/codebuddy2api` — MIT，**但仅覆盖其自 `bce86ded` 起独立重写的当前树**
  - ⚠️ **`xueyue33/codebuddy2api` 无 LICENSE = all rights reserved，禁止取用代码**。
    从 IceeAn 取代码须出自其当前树并署名；一律「借思路不搬文件」。

## 6. 提交与 CI

- 提交信息用中文 + conventional 前缀（`feat:` / `fix:` / `docs:` / `chore:`）。
- push 后**必须盯 CI 到绿**：`gh run list -R 3304711297/workbuddy2api --limit 3`。
  CI 覆盖 Build frontend / pytest / 前端单测 / cargo check / cargo test。
- 推送若报 `Recv failure`，改走 Karing 代理（`127.0.0.1:3067`）；两种都试。

## 7. 已知待办（未实现，别重复造）

- **多账号调度（已交付，2026-09-11）**：
  `AccountRotator`（converter.py）支持三模式 `off`（默认）/ `failover`（429/6004 自动切号重试）/
  `roundrobin`（按请求数轮询）；账号级冷却 `_ACCOUNT_COOLDOWNS[(uid, model)]`；
  切号原子写 `active_uid`，外部凭 mtime 感知无需重启；CLI 参数 `--rotate-mode` / `--rotate-count`。
  GUI 策略卡在「账号与资产」页，配置存 `settings.json`，`proxy_start` 仅在非 off 时透传给内核。
  ⚠️ 改这块先读第 4 节「AppConfig 整对象覆盖写盘」两条铁律。
- **今日用量与夜间限免窗口（A2/A3/B1/C1/C2 已完成，2026-09-11 交付）**：
  已在 `converter.py`、`src/accounts.js`、`token-stats` 插件落地：自然日（UTC+8）今日用量（`reqsToday`/`tokensToday`/`err429_today`）优先展示，兼容 5h/24h；动态感知 `23:00–08:00` 免费时段并打上「🌙 夜间限免中」徽章。提交 `83ef9e2`（c2o 仓） / `894f500`（hermes 仓 hermes 分支）。
- **凭证轮换（P1，**已交付** 2026-09-11，见上方「多账号调度」条目）**：
  多账号就位后按既定要点实施完毕（`AccountRotator` + GUI 策略卡）。
  token 续期由 `converter.py` 的 `_refresh()` 被动处理（`expiresIn` 60 天 /
  `refreshExpiresIn` 90 天）；激活的账号在 `_refresh_session_tokens()` 中按 uid 定向续期。
  设计约束（仍然有效）：**必须 opt-in 且默认关闭**，不做定时/自动的上游交互
  （09-08 用户裁定）；参考 `IceeAn/codebuddy2api`（MIT，看门条目 `c2api-upstream-iceean`），
  只借思路不搬文件，取代码须出自其当前树并署名（合规红线见第 5 节）。

