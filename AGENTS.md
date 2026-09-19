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
./.venv/Scripts/python.exe -m pytest tests/ -q   # Python：423 passed 为当前基线 (含长思考超时与防惊群契约)
./.venv/Scripts/python.exe tests/run_isolated_tests.py   # 同上，但在「禁真实 DNS/socket + 用户目录指向临时目录 + 清空 WORKBUDDY* 环境变量」下再跑一遍
npm test                                          # 前端：202 passed（node --test）
cd src-tauri && cargo test --quiet                # Rust：85 passed
```

⚠️ **裸 `python -m pytest` 会失败**（`No module named pytest`）——`python` 命中的是
Hermes 运行时 venv，不是本仓 venv。必须用 `./.venv/Scripts/python.exe`。

⚠️ **改测试或写「看源码做结构/负向断言」的用例前必读（2026-09-18 修复）**：
① 剥离注释**不能用逐行正则** `line.replace(/\/\/.*$/,'')`——它既会在 LF 下吃掉字符串字面量里的
`//`（`format!("https://…")` 整行尾部被剪掉，正向断言恒失败），又会在 CRLF 下因 `.` 不匹配 `\r`
而完全空转（负向断言把注释算进代码，写一句解释性注释即误报）。统一用
`tests/helpers/strip-rust-comments.mjs`（会跳过字符串/字符字面量，LF/CRLF 结果一致）。
② 用例**不得依赖真实 DNS / 网络**（如放行 `example.com`）：离线或隔离运行器下，正例会红，
反例则「因解析失败提前返回」而**空过**——即断言看着绿、其实没验证到那条防线。
需要走通公网分支时，打桩 `converter._resolve_host_ips`。
③ 路径断言的期望值要用与实现相同的 `path.join` 推导，别写死 `z:/workbuddy/` 这类正则
（Windows 下 `path.join('Z:\','workbuddy')` 是 `Z:\workbuddy`，POSIX 下是 `Z:\/workbuddy`）。
④ 修完三类问题后 `pytest` / 隔离运行器 / `npm test` 在 **LF 与 CRLF 检出下都必须全绿**，
CI 的 `checks-linux`（LF + 禁网）一档就是为守这条而加。

### 构建：用户自己跑，助手不要绕

**构建由仓库主自己执行**：`npm run tauri build`（PowerShell，仓库根）。
助手改完代码只需说一句「可以构建了」，**不要**自建隔离 target 目录、不要写替换/重建
脚本、不要试图「在不影响会话的情况下构建」——内核 `converter.py` 是 GUI 的子进程，
任何绕过方案都会弄断正在进行的对话链路。

若确需命令行（仅限明确要求时）：

```bash
npm run build && cd src-tauri && cargo tauri build --no-bundle
```

⚠️ **`windows.ps1` 必须带 UTF-8 BOM（真实踩过的无声闪退）**：Windows PowerShell 5.1
读无 BOM 的 UTF-8 文件时按 ANSI/GBK 解码，中文注释变乱码打散引号配对 → **19 个解析
错误 → 脚本在写第一行日志之前就死了**，表现为「点更新闪退且无日志无状态文件」。
5.1 只认 BOM 才按 UTF-8 读。写入后必须确认文件头是 `EF BB BF`（契约测试锁定）。
⚠️ **`which()` 在 Windows 不能用 `is_file()`**：Store 版 pwsh 的
`%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` 是 AppExecLink 重解析点，`is_file()`
对它返回 false → which 静默找不到 pwsh → 回退 5.1 → 触发上述 BOM 死亡链。
判定用 `fs::metadata().is_ok()`（`update.rs::path_is_executable`）。
⚠️ **spawn 更新脚本绝不能用 `DETACHED_PROCESS`（0x8，「点更新闪退」最终根因）**：
实测（Rust 同款 creationflags 逐变量对照，覆盖 Store 别名/物理路径 pwsh/PS 5.1），
该 flag 下 PowerShell 进程 spawn 成功但**静默不执行任何脚本**就退出——无日志、
无状态文件、无报错。此前曾误判为 Store 别名问题和 BOM 问题（两者是真实缺陷但
非此现象主因）。正确 flag 是 `CREATE_NO_WINDOW(0x08000000) | CREATE_NEW_PROCESS_GROUP`：
同样无窗口、不与父进程生命周期绑定，但 console 正常初始化。契约锁定：
`tests/test_app_update_contract.test.js` 的 spawn flags 断言。
⚠️ **更新脚本中原生命令（git）绝不能管道直连 `Select-Object -First 1`（「不是有效的 git 检出」最终根因）**：
在 PowerShell 7（`pwsh`）下，原生可执行文件（如 `git rev-parse HEAD`）若直接通过管道流向
`Select-Object -First 1`，下游提取首行后会提前关闭输入流以终止管道。这会导致 upstream 原生进程被
非正常终止，PowerShell 因而将 `$LASTEXITCODE` 置空为 `$null`。而在 PowerShell 中，`$null -ne 0` 为 `$true`，
导致 `if ($LASTEXITCODE -ne 0 -or -not $previousSha)` 恒成立，把完全正常的 git 检出误判为
`not-a-git-checkout`（「无法读取当前提交，D:\... 不是有效的 git 检出」）并触发回滚与重建。
正确写法：先由变量完整接收原生命令输出（`$headOutput = (& git rev-parse HEAD 2>&1)`），让进程正常退出并设置
真实的 `$LASTEXITCODE`，随后再用 `Select-Object -First 1` 提取首行。契约锁定：`tests/test_app_update_contract.test.js`。

**绝不跑裸 `cargo build --release`**：`custom-protocol` feature 只有 tauri CLI 会带上，
plain cargo 会**静默产出无前端的空壳 exe**（15,572,992 字节 vs 正确约 15,663,616）
且照常打印 "Built application at..."，不报错。正确产物尺寸随功能增长，判据不是死记数字。

**验证产物真伪的方法**（构建日志说成功不算数）：

```python
d = open("src-tauri/target/release/workbuddy2api.exe","rb").read()
len(d)                                                        # 尺寸应显著大于空壳 15,572,992
d.count(b"index-XXXXXX.js")                                   # 从 dist/assets 取实际文件名，命中=前端已内嵌
d.count(b"hermes_proxy_base_url")                             # Rust 侧 ASCII 标记物
```

⚠️ 前端中文文案在 bundle 里被 **brotli 压缩**，在 exe 内搜不到不等于没进包——
要验前端文案，请读 `dist/assets/*.js`。Rust 侧字符串（如字段名）不压缩，可直接搜。
另：**不能用资源 hash 判新鲜度**——`vite.config.js` 把 git hash + 构建日期注入
fingerprint，每次构建都会漂移。

判断跑的是不是新版本：

```powershell
Get-CimInstance Win32_Process -Filter "Name='workbuddy2api.exe'" |
  Select-Object ProcessId, CreationDate   # CreationDate 晚于 exe mtime = 正在跑新版本
```

**界面上的版本标识即当前产物的构建提交**（形如 `v0.2.1 7e7a9c1`，由 `build.rs` 烘焙进
二进制 + `vite.config.js` 注入前端）。**不要**用工作树 `git rev-parse HEAD` 判断「跑的是哪个
版本」——源码留在检出目录、工作树会被 pull 推进，与运行中的产物无关（详见第 4 节更新检测）。

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
  当前词表 49 条（模块级 `SENSITIVE_TERMS`），分三类：① 安全术语（DoS/exploit/…，
  来自真实被拦的客户端 system 模板）；② 已实证的客户端 system prompt 指纹；
  ③ 竞争品牌词（Claude/Anthropic/OpenAI/Gemini 等，借鉴 DistPub/workbuddy2api）。
  **「精细化」属可选演进、非当前缺陷**：现词表按「整串/词边界匹配 + 零宽空格打断」
  工作，且 `\b` 边界与 `_rewrite_known_fingerprints()` 精确改写两层顺序不可颠倒
  （精确改写优先，零宽兜底）。若要继续精细化，方向是「按上下文分级」而非「加词」——
  例如区分「用户真的在讨论安全话题」（不该动）与「客户端模板里的合规声明」（该动），
  但那需要语义判断，收益与风险都需重新评估；**在拿到新的真实 11128 样本之前不要动**。
  作用角色由调用方传入（默认 `("system",)`，生产三端点显式传 `("system","assistant")`
  以对齐上游拦截面——后端实测只拦 system/assistant，不拦 user/tool）。
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
- **Hermes 接入检测（`agents.rs`，2026-09-16 重写，改动必读）**：
  判据**不是**「顶层 `model` 段指向本工具」，而是「Hermes 配置里**任意落点**出现指向本工具的反代地址」。
  扫描四个落点：顶层 `model` / `providers.<name>` / `model_aliases.<alias>` / `custom_providers[]`。
  曾因只读顶层 `model.provider` 名字去 `providers` 找同名键，而用户实际把反代登记在
  `providers.workbuddy2api`（`model.provider` 指向别的订阅）→ 明明在用却显示「未配置」。

  ⚠️ **`is_our_proxy_url(url, our_port)` 必须比对端口**：本机常有多个回环 `/v1` 服务
  （实测踩到 CPA 网关 `18080`），仅凭「回环 + 路径含 `/v1`」会把别人的服务认成自己。
  端口取自 `crate::load_app_config()`（可配置），**不得写死 8787**。
  若 `our_port` 为 `None`，严格直接判定非本工具（`return false`），**禁止**退化为
  宽泛的「回环 + /v1 即算」弱化 fallback。`agent_detect` 必须确保以
  `load_app_config().port` 为兜底解析出端口后以 `Some(port)` 传入。
  返回给前端的字段是 **`hermes_proxy_base_url`**（serde snake_case）——
  前端 `src/agents.js` 读它时**不能**写成 camelCase，否则静默 `undefined`（本轮踩过）。
  契约锁定：`tests/test_hermes_detection_contract.test.js` + `agents.rs` 内 10 条 Rust 单测。

- **应用更新（`commands/update.rs` + `scripts/app-update/windows.ps1`，2026-09-16 重写，改动必读）**：
  检测与「应用更新」的机制对齐 Hermes Desktop，**不使用 GitHub Release 发版**。

  **① 检测 = 被动 API 比对 commit，不做 `git fetch` 轮询**：
  多客户端反复 fetch 会拖垮仓库并触发 GitHub 429。正确口径是
  `GET /repos/{slug}/commits/{branch}` + `Accept: application/vnd.github.sha`
  取 40 字节远端 tip SHA，与本机**运行版本**比对；
  **仅当两者不同**才 `GET /compare/{head}...{tip}` 取 `ahead_by`（= 落后数）与 commit 列表。

  ⚠️ **「本机版本」必须用烘焙进二进制的构建提交，绝不能读工作树 `.git/HEAD`**：
  本项目源码留在检出目录且更新靠就地重建，工作树会被 pull 推进到最新，而运行中的
  exe 仍是旧提交产物 —— 读工作树会把「运行的是旧版本」谎报成「已是最新」
  （真实踩到：exe 构建于 `88b0f7e`、工作树已到 `d1cb787`，界面显示「已是最新」，
  实际落后 3 个提交）。机制：`src-tauri/build.rs` 注入
  `cargo:rustc-env=WORKBUDDY2API_BUILD_SHA=<git rev-parse --short HEAD>`，
  并对 `.git/HEAD` 与当前分支引用发 `rerun-if-changed` 保证新提交后重编；
  无 git 环境构建时退化为 `"unknown"`（不 fail 构建）。
  `AppUpdateInfo.current_sha` = 烘焙 sha；**不得**再引入任何「读工作树 HEAD 做版本判定」
  的入口（`read_git_head` 及其单测已随此修复一并删除，留着只会被误用）。

  ⚠️ **`ahead_by == 0` 但 tip 不同 ⇒ 本地领先，必须判「无更新」**——报成「有更新」会诱导
  用户用远端覆盖掉自己的提交，这是本模块最危险的误报。`compare` 失败（限流/本地独有提交 404）
  时 `behind = None`，UI 显示「有更新、数量未知」，**绝不编造数字**。
  结果缓存 TTL：**有更新 24h / 无更新 10min / 失败 1h**，以「本地 HEAD + 分支」为键——
  更新或切分支后立即失效。⚠️ **键里没有远端 tip，「无更新」必须短缓存**：远端推了新提交
  而本机 exe 未变时键照旧命中，长缓存会把远端新提交挡在门外，弹窗复读启动时的
  「已是最新」且不发请求（真实踩到：exe=3d094fc、远端已到 514fad9，点「检查更新」
  毫无反应）。双保险：前端入口点击必须传 `force: true` 实时实查（`update-check.js`
  的入口 onClick；启动静默检查保持走缓存以省 API）。契约锁定：
  `tests/test_app_update_contract.test.js` 的缓存 TTL 与 force 断言。

  ⚠️ **健康检查端口不得写死 8787**（与 Hermes 检测同一条铁律）：端口可配置，用户配成 9000 时
  新版会正常监听 9000，而写死 8787 的探活必然失败 → 90s 后误判 `startup-unhealthy`
  → **把正常的新版回滚掉**。链路：`load_app_config().port` → `-Port` 参数 → 脚本
  `$PROXY_HEALTH_URL = "http://127.0.0.1:$Port/health"`。脚本的 `Port` 必须是
  **必填参数**（缺失即报错，不得静默退回默认值）；契约测试会扫描脚本可执行代码
  （剥离 `#` 与 `<# #>` 注释后）断言其中不含 8787 字面量。

  ⚠️ **探活必须打 `/health`（免鉴权），绝不能打 `/v1/models`**：`/v1/models` 走
  `_check_auth`，配了密钥后任何无认证请求一律 401 → 探活恒失败 → 90s 后误判
  `startup-unhealthy` → **把正常的新版回滚掉**（与端口写死同类，属鉴权维度）。
  二次伤害：`Wait-PortReleased` 也复用该 URL，401 会让它在 0.1s 内误判「端口已释放」，
  使「旧内核残留」的时序判据同时失效。`/health` 在内核里明确免鉴权且只返回
  `status`/`authenticated` 两个布尔，是唯一合适的探活端点。
  ⚠️ 探活**只证明进程能服务 HTTP**，不证明上游可用 —— 这是刻意的：上游/网络故障
  不该触发回滚。契约锁定：`tests/test_app_update_contract.test.js` 两条断言。

  **② 应用 = 交接式 + 启动确认**：`apply_app_update` 以 `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP` 分离拉起（严禁使用 `DETACHED_PROCESS`，见第 2 节禁令）
  `scripts/app-update/windows.ps1` → GUI 自己 `exit(0)` → **脚本自绘置顶进度小窗**
  （WinForms + runspace，Hermes 同款全程可见体验；`Start-ProgressWindow` 起窗、
  `Write-State` 联动刷新、四个出口 `Stop-ProgressWindow`；窗体失败只 WARN 不阻断更新）
  → 脚本等 GUI 消失后
  `git stash`（若有改动）→ `git fetch` + `git merge --ff-only` → `npm run build`
  → **`cargo tauri build --no-bundle`** → 校验产物（尺寸 > 空壳基准 + `index-*.js` 已内嵌）
  → 拉起新 exe → **等待启动确认**（进程存活 + `<Port>/health` 探活，90s 超时）
  → 确认失败则 `git reset --hard` 回滚 + 重建 + 拉起旧版。
  ⚠️ 启动确认不可省（借鉴 EasyCLIProxyAPI 的 ack 等待）：只 `Start-Process` 就宣布成功，
  会在新版「启动即崩」时把用户反复拉回同一个坏版本，且脚本已退出无从回滚。
  仅验进程存活也不够——GUI 活着但内核没起来时服务仍不可用，故必须探反代端口。
  ⚠️ **必须「端口先释放再出现」**（`Wait-PortReleased`，30s 宽容期）：`converter.py`
  **没有父进程退出检测**（实测：GUI 退出后它变孤儿继续存活并占着端口），若只判
  「最终可用」，会出现「新版 GUI 启动即崩 → 旧内核仍响应 2xx → 误判成功」，
  把崩溃版本当成功留在盘上。先等端口消失可证明旧内核确实退了，此后 2xx 必来自新进程。
  ⚠️ **孤儿内核与「停止」按钮（实测踩到的用户困惑，含**链式孤儿**）**：converter.py
  无父进程退出检测，GUI 退出/被更新脚本终止后它变孤儿继续占 8787。新 GUI 启动时
  健康检查探到 200 → 状态卡显示「运行中」，但「停止」按钮走 `proxy_stop` 只杀本 GUI
  `ProxyHandle` 里的 child（handle 为空）→ 返回 not-running 而端口仍被占 → 3s 轮询
  又探到 200 → 状态跳回「运行中」，用户永远关不掉。
  ⚠️ **链式孤儿（第三轮修复）**：实测孤儿是**两层**——GUI 9284(死)→9180(converter.py
  链顶孤儿)→4344(子进程,父活着,taskkill /T 对它有父进程保护杀不掉)。从监听者 4344
  直接杀会被 taskkill 拦（"reason: This process can only be terminated forcefully..."）。
  修复：`climb_to_orphan_root` 沿祖先链向上爬（≤8 步防环）。
  ⚠️ **第二轮爬链的 bug（用户实测仍不行，第三轮修复）**：旧逻辑「父进程活着就返回
  None」在第一层 4344→9180 就停了——9180 虽是 converter.py 且父 GUI 已死，但因为
  9180 自己活着，4344 那步就 return None。正确语义：父进程活着时，**检查父是否也是
  converter.py**——若是，说明父也是孤儿链成员（它的父已死），继续爬；若父不是
  converter.py（= GUI 活着），才返回 None。实测修正后：4344→9180(converter.py,继续爬)
  →9180 父死 → 根=9180，taskkill /T 连带 4344。
  ⚠️ **第三轮爬链的 bug（用户实测仍不行，第四轮修复）**：process_info 对「已死 PID」
  返回 Err，climb_to_orphan_root 爬到链顶 9284（已死）时 process_info(9284) 的 Err
  被 `?` 传播成整个清理失败——用户看到「停止失败: 进程 9284 已退出」。
  正确语义：process_info Err = 链顶已死 = current 就是孤儿根（它的子进程还活着），
  返回 Some(current) 而非传播错误。
  ⚠️ **爬链查询 Fail-Closed 铁律（外部评审 P1 采纳，第五轮修复）**：
  `process_info` 必须通过 `ProcessLookup` 明确区分 `Alive` / `NotFound` / `QueryFailed`
  三种语义，**绝不能把任何 Err 模糊当成「进程死亡」**——那会让端口监听者在 WMI/PowerShell
  查询偶发异常时直接绕过 `converter.py` 身份匹配而被 `taskkill /F /T` 误杀！
  起始端口监听者必须严格包含 `converter.py`；监听者或祖先查询若抛出系统错误（`QueryFailed`），
  必须**一律 Fail-Closed 返回 Err 中止清理，严禁 kill**。
  另 `find_listener_pid` 依靠 `Get-NetTCPConnection ... -ErrorAction SilentlyContinue`，查询异常时
  安全退化为 `None`（无监听者）直接返回放弃清理，同样天然满足 Fail-Safe（放弃清理优于误杀）。
  契约单测：`proxy.rs::orphan_climb_tests`（8 条覆盖全链路与 Fail-Closed 场景）。
  端口超时未释放时**必须中止更新**（`Throw-Failure 'port-not-released'`，外部评审 P1 采纳，
  推翻早先的 WARN 宽容策略）：uvicorn 端口被占的实测行为是 `create_server` 抛
  `OSError`（WinError 10048）→ `sys.exit(STARTUP_FAILURE=3)`——新版内核**必然起不来**，
  此后端口上的任何 2xx 都来自残留旧内核，健康确认只会产生假成功。原则：
  **「把坏版本宣布成功」比「更新失败并回滚」危险得多**。hint 提示用户重启电脑。
  ⚠️ 拉起失败（`Start-WorkBuddy` 返回 null）时健康检查必须**立即失败**——绝不能跳过
  进程检查继续探活（那只会探到残留旧内核的 2xx）。
  ⚠️ 启动确认失败进入回滚前，必须先按**本次 `Start-WorkBuddy` 返回的 PID** 终止新版 GUI
  并确认退出——它活着就持有 exe 文件锁，回滚的 `cargo build` 会撞占用。禁止按进程名
  全杀（会误杀用户手动另开的实例）。
  ⚠️ **回滚命令退出码必须严格检查，严禁吞码与无脑拉起（外部评审 P1 采纳）**：
  `Invoke-Logged` 只 `return $code` 不抛异常，外部使用 `| Out-Null` 会让 `try/catch`
  彻底失效，导致 `git reset` 或 `cargo build` 失败却谎报「已回滚」。
  必须检查每个命令的退出码；`$rolledBack` 必须满足「源码 reset 成功 + 旧版产物重建成功」。
  回滚未完全成功时，严禁无脑拉起损坏或半截的 exe（避免将用户反复推入崩溃循环）。
  契约锁定：`tests/test_app_update_contract.test.js`。
  ⚠️ **stash 恢复必须晚于所有回滚点与重建完成（实测复现的数据丢失、构建破坏与指纹污染路径，改动必读）**：
  旧写法在第 6 步（产物校验后）提前 pop，启动失败 reset 会直接抹掉改动（数据静默丢失）；
  而在回滚路径中，**stash pop 必须晚于旧版 npm/cargo 重建完成**：
  ① **防拖垮构建**：未提交改动可能是实验性/写一半的代码，构建前 pop 会导致原本干净的旧版也构建失败；
  ② **防版本指纹撒谎**：`build.rs` 注入的 `WORKBUDDY2API_BUILD_SHA` 取自 HEAD（previousSha），
  若构建前混入 stash 改动，编译产物即为「previousSha + 本地未提交代码」，破坏版本指纹真实性。
  正确时序：
  **成功路径** pop 放在启动确认通过之后（唯一不会再回滚的点）；
  **「无更新」早退路径** pop 在 `needsRebuild` 分支内（该路径不回滚）；
  **回滚路径** 必须先完成 `git reset --hard` + `npm run build` + `cargo tauri build`，确认旧版产物成功重建（`$rollbackRebuildOk`）后，才执行 `git stash pop`。
  若 reset 或重建失败，**绝不得触碰 stash**，改动安全保留在 stash 堆栈中，避免二次污染破损现场。
  契约锁定：`tests/test_app_update_contract.test.js`（断言回滚中的 stash pop 必须在 Rust 重建之后，且严禁在 reset 与 rebuild 之间出现 pop）。
  ⚠️ **「是否需要重建」的基准是「工作树 vs 运行中的产物」，不是「工作树 vs 远端」**：
  用户可能已手动 pull 过、或上次更新中断，此时工作树已领先而远端无新提交；
  只看远端会得出「无需重建」→ 点了更新却什么都没发生。脚本为此接收
  `-CurrentBuildSha`（Rust 传烘焙 sha）；拿不到构建 sha 时**保守重建**（慢但正确）。
  ⚠️ 脚本内**必须**用 `cargo tauri build`（裸 cargo 会产出空壳）；
  `--ff-only` 不可改成 merge/`reset --hard origin`（会覆盖或丢失用户提交）。

  **③ 阶段进度与失败分级**：脚本每步 `Write-State` 写
  `%LOCALAPPDATA%/workbuddy2api/update/app-update-state.json`（原子替换），
  GUI 轮询 `app_update_state` 显示步骤条（准备/获取/快进/依赖/前端/编译/校验/启动），
  用户不会看到黑屏等几分钟。失败带 `failureKind`，前端映射成可行动的一句话。
  ⚠️ **状态文件必须用无 BOM UTF-8 写入**（脚本用 `[System.IO.File]::WriteAllText` +
  `UTF8Encoding($false)`）：Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
  而 serde_json 遇 BOM 直接失败 → 因容错降级为 None 而**整条进度显示静默失效**。
  Rust 侧另做了 `trim_start_matches('\u{feff}')` 防御兜底（双保险，有单测锁定）。

  **④ 契约**：前端字段名走 **snake_case**（`update_available` / `current_sha` / `target_sha` /
  `behind` / `supported` / `dirty` / `commits` / `failure_kind`），写驼峰会静默 `undefined`；
  远端 commit 标题**必须**用 `textContent` 渲染（不可信输入，防注入）；
  阶段名在「脚本 / 前端 UPDATE_PHASES / index.html 步骤条」三处必须一致，
  失败分类在「脚本 kind / Rust 字段 / 前端 FAILURE_HINTS」三处必须一致
  （`tests/test_app_update_contract.test.js` 会逐项对拍，漏一处即红）。

- **`model_list_mode` 开关的作用域（别把它当成万能的）**：
  本开关**只改变内核向客户端暴露的清单**（`/v1/models`），**管不到客户端自己写死的模型表**。
  典型困惑：用户选了「仅展示可用模型」，但 Hermes 模型选择器里仍有需授权模型——
  原因是 Hermes 的自定义端点勾了 `discover_models: false`，它改用自己 `config.yaml` 里
  写死的 `models:` 列表（42 项含 7 个 GPT），从不请求本清单。内核侧过滤实际是生效的
  （实测 `/v1/models` 返回 36 项、gpt 系列 0 项）。
  → 客户端须打开「Discover models」改为实时探测，改后需重启客户端。
  设置页已在该开关下方加动态说明（`MODEL_LIST_MODE_NOTES` + `renderModelListModeNote`），
  文案**刻意不写**「选此项即可让客户端隐藏模型」这类误导性承诺。
  契约锁定：`tests/test_model_list_mode_client_note.test.js`。

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
  3. **persistSettings 采用 dirty merge，磁盘回灌必须带 dirty 守卫**（2026-09-12 评审修复）：
     `persistSettings(patch)` 的 patch 显式声明「本次修改的字段」，在 payload 末尾
     `...patch` 展开（优先级最高）；`get_app_settings` 回读只用于回填**本次未修改**的
     字段，且每条回灌必须带 `('<字段>' in patch)` 守卫。禁止任何形式的
     「读盘 → 无条件回灌 cache → 写盘」——它会让 LAN 开关 / log_level / log_payloads /
     model_list_mode 首次修改保存不生效、「清空密钥」永远清不掉（空输入恰好满足
     回灌条件把旧 key 读回来）。锁定契约：`tests/test_settings_dirty_merge.test.js`。
- **模型可用性感知（`model_availability.json` 三真源，改一处漏两处会静默不一致）**：
  「需授权」预标记有**三个同步维护的真源**：① `converter.py` 的 `GPT_FALLBACK_MAP`
  键（运行时降级判定 + 预标记）、② `billing.rs` 的 `GPT_PREMARKED`（控制台模型表）、
  ③ `scripts/check_premarked_sync.py` 跨源对拍校验器（CI 独立步骤 +
  `test_premarked_covers_all_gpt_fallback_keys` 薄壳断言，两侧键集漂移或定义锚点
  丢失都会红）。⚠️ ③ 必须保持**独立提取两侧源码**——曾经写成断言
  `GPT_FALLBACK_MAP` 键 ⊆ `_premarked_unavailable()`，而后者就是
  `set(GPT_FALLBACK_MAP.keys())`，自己对自己断言恒真，Rust 侧漂移永远不会红。
  新增/删除需授权模型时三处一起改。
  运行时学习证据（`runtime-11102` / `runtime-200`）写在
  `%LOCALAPPDATA%/workbuddy2api/model_availability.json`（per-uid 结构
  `accounts.<uid>.<model>`），由 converter 在 11102 降级点与成功完成点写入；
  Rust 控制台与 `/v1/models` 只读不写。`model_list_mode`（all/available）热读
  settings.json，CLI `--model-list-mode` 仅启动兜底。
- **SSE 注释行是有意为之（规范做法，别「修」掉）**：converter 在聚合等待期每 5s
  下发 `: ping`、降级发生时首包前下发 `: fallback: ...`，anthropic_stream 同样
  透传注释行。这是 SSE 规范允许的注释帧（客户端应忽略），用于防中间代理 60s
  静默超时 + 向客户端暴露降级可观测性。极少数非标准解析器可能把它当数据处理，
  已裁定保留（2026-09-12）：遇到「流里多出冒号开头行」的报告先核对客户端解析器
  是否符合 SSE 规范，不要反向去掉注释行。
- **Anthropic Messages 兼容层 (`POST /v1/messages`)**：
  采用解耦模块设计（`anthropic_compat.py` 请求响应双向翻译、`anthropic_stream.py` SSE 事件状态机）。支持 Claude Code CLI、Cline、Roo Code 等工具原生直连。错误返回标准 Anthropic `{"type": "error", "error": {...}}` 格式。

- **请求健壮性四条（2026-09-18 修复，改三端点入口/错误路径前必读）**：

  ① **模型名必须经 `_normalize_model_name()` 归一化**，禁止再写 `body.setdefault("model", "auto")`。
  `setdefault` 只补缺键 —— 客户端「测试连接」常发 `model: ""`（自定义提供商模型列表为空时），
  空串照原样透传上游会拿到 400 `11102 model [] service info not found`。实测：`""`/`null`/纯空白
  一律 → `auto`（对齐「缺省即 auto」既有语义），非空字符串原样保留不 trim。三个端点入口各有两处
  （`body["model"]` 与 `model_name`）都要归一化，漏一处会让日志/映射与实发模型不一致。

  ② **非流式 4xx 严禁「吞异常续圈」重发**：只有 failover **真正切号成功**（`record_failure_and_failover`
  返回非 None）才允许 `continue`。曾经的写法在 `attempt < max_attempts-1` 时无条件续圈，导致确定性
  400 被原样重发 —— 实测一次请求打上游 3 次（同 rid 下 3 个不同上游 requestId），且 11102 不限流、
  failover 返回 None，纯属白烧额度 + 抬风控关联度。不可重试时**直接 `return JSONResponse`**，
  不要再 `raise HTTPException` 走循环。

  ③ **非流式错误体必须按协议出形状**：用 `_openai_error_body()` / `_anthropic_error_body()`
  返回 `{"error": {...}}` 与 `{"type":"error","error":{...}}`。`raise HTTPException(detail=...)`
  会被 FastAPI 包成 `{"detail": ...}`，破坏协议形状、客户端解析不到错误原因。中文 `displayMsg.zh`
  优先展示，原始英文 `msg` 保留在 `upstream_message` 字段可追溯。流式路径的 `_err_event` 不受影响。

  ④ **限流判定禁止裸子串匹配**：统一走 `_is_rate_limit_signal()`（JSON 报文有 code 只认 `code == 6004`；
  无 code 只看 `msg`/`message`；仅非 JSON 文本才回退整串扫）。
  `"429" in text` / `"6004" in text` 会命中 `requestId` 这类 hex 片段（实测 `...4290-6004-abcd...`），
  把确定性错误误判为限流 → 无谓切号 + 假冷却写进 `_RATE_LIMIT_STATE`。中文短语「频率限制 / 频率过高 /
  使用量超出」是无歧义整词，可保留。
  ⚠️ **`_record_rate_limit` 必须先过 `_is_rate_limit_signal` 门，再让 `_RATE_LIMIT_RE` 只负责提取 reset 时间**
  （顺序不可颠倒）：正则扫的是整串，若它先行，顶层 `code=11102` 的错误体只要嵌套携带
  `details.code=6004 + "将在 … UTC+8 重置"` 就会绕过语义门写入假冷却，让调度无端避让正常账号。
  `_record_rate_limit` 与 `AccountRotator.record_failure_and_failover` 两处必须共用同一判据（曾经只改了一处，
  测试立刻抓到误切号）。

  契约锁定：`tests/test_model_normalization_and_error_shape.py`（13 条，含三端点端到端空模型名断言、
  确定性 400 上游只调 1 次、无账号可切时不重发、Anthropic 错误体无 detail 包裹且 type 按官方状态映射、
  限流子串误判防护、嵌套 metadata 不得绕过语义门写入假冷却）。

- **模型页 UI 两条契约（2026-09-18）**：模型 id 必须渲染为原生 `<button class="model-id-copy"
  data-copy-model="<id>">`（点即复制调用名，走 `copyToClipboard` 且失败时报错）——原先只能看不能取，
  手抄模型名配进客户端即 11102；模型页标题下**不得**再加功能宣传式副标题（信息在表格列头已体现）。
  契约锁定：`tests/test_models_copy_and_subtitle.test.js`。
- **OpenAI Responses 兼容层 (`POST /v1/responses`) 与 Codex 投影压缩**：
  采用解耦模块设计（`responses_compat.py` 请求双向转换与 Responses 语义事件流状态机，`responses_projection.py` 最小语义闭包投影压缩）。支持 Codex CLI（`wire_api="responses"`）、OpenCode 等长上下文 Agent 原生直连；自动过滤 harness 模板与冗余 schema description，大幅削减 token 消耗。
- **DeepSeek 思维链注入与历史一致性回填 (`deepseek_thinking.py`)**：
  对 `deepseek*` 模型自动注入 `thinking: {"type": "enabled"}` 与 effort 档位（默认 high）；多轮对话检测到任一 assistant 含有 reasoning 时，自动为缺少该字段的 assistant 补齐 `reasoning_content: ""`，根除上游 `11133 model_param_invalid` 错误。
- **按积分到期日分层选号（先烧快过期额度，借鉴 momo0410/workbuddy-switch-gateway）**：
  `AccountRotator` 内部调度由 `get_candidate_uids_tiered()` 驱动：从各账号 session/credit 提取有效到期日（兼容秒/毫秒/时间串），按日粒度（YYYY-MM-DD）分层分组。最早到期日的账号集合拥有最高调度优先级，同档内平均轮换，未标记到期日账号作为保底垫底。确保快过期额度被确定性优先消耗，杜绝资产过期浪费。
- **并发削峰平滑器 (`request_pacer.py`)**：
  基于 `asyncio.Semaphore` 与单调时钟调度槽，支持环境变量 `WORKBUDDY2API_MAX_CONCURRENCY`（默认 5，兼容旧名 `CODEBUDDY2OPENAI_MAX_CONCURRENCY`）与 `WORKBUDDY2API_MIN_INTERVAL_MS`（默认 50ms，兼容旧名）削平并发脉冲。流式与非流式请求均在上下文周期内自动持槽与平滑释放。环境变量统一经 `_env_compat()` 读取：新名优先，旧名兜底，避免升级后行为静默变化。
- **后台主动令牌续期 (`token_refresher.py`)**：
  由 FastAPI `lifespan` 生命周期管控，后台每 300s 巡检活跃账号凭据，剩余有效时间小于 1800s（30 分钟）时主动触发异步续期并防重入，避免用户请求遭遇被动刷新时延。
- **413 请求体大小保护与官方 User-Agent 仿真（2026-09 横向对比采纳）**：
  - **413 防护**：`MAX_BODY_MB`（环境变量 `WORKBUDDY2API_MAX_BODY_MB`，默认 16MB）。中间件为**纯 ASGI receive 层按块熔断**（`RequestBodyLimitMiddleware`，非 BaseHTTPMiddleware）：① `Content-Length` 快速拒绝（零读取）；② 分块累计一旦超限立即中止读取并返回 413，**不放任 chunked 大包读完进内存**。超限不转发上游、不触发切号、不罚账号。
  - **出站 User-Agent**：出站请求（计费、对话、模型）统一调用 `_get_user_agent(domain)` 仿真官方客户端（国服 `CLI/2.63.2 CodeBuddy/2.63.2` / 国际版 `WorkBuddy/5.5.2...`），规避非标 UA 导致的 10085 违规拦截，并使官网使用端归因正常。亦支持 `WORKBUDDY2API_USER_AGENT`（兼容旧名 `CODEBUDDY2OPENAI_USER_AGENT`）自定义。
  - **多模态远程图片转 Data-URI**：腾讯后端对 `image_url` 仅接受 `data:image/...;base64,...`，直接传 http 链接报错 400。网关 `_inline_remote_images` 自动异步下载远程图片并内联为 base64 data URI，彻底解除视觉模型的多模态输入限制（借鉴 `neipor/codebuddy-cli2api`）。**安全边界（P0，改动此逻辑必读）**：下载前经 `_url_is_safe_for_fetch` 做 SSRF 校验——仅允许 http(s)，拒绝回环/私网/链路本地/云元数据地址与 CGNAT 共享地址段（100.64.0.0/10、127.0.0.0/8、10/8、172.16/12、192.168/16、169.254/16、::1、fe80::/10、0.0.0.0 等），域名解析后逐个 IP 校验；**重定向逐跳重新校验**（防「公网跳内网」）；**TCP/TLS 连接地址强制与已校验公网 IP 绑定**（直连 IP 搭配 Host 头与 sni_hostname 扩展，根除 DNS rebinding 窗口）；单图默认 8MB 上限（`WORKBUDDY2API_MAX_IMAGE_MB`，设 0 则完全禁用远程下载），按 `Content-Length` 预判 + 流式累计双保险；响应必须为 `image/*`，否则拒绝内联。
  - **11140 内容安全审核拦截防误判（借鉴 `icebears111/workbuddy2api`）**：上游错误码 `11140`（`request illegal` / “内容未通过安全审核，请调整后重试”）为用户 Prompt 命中上游安全策略，与账号配额和网络可用性无关。网关统一经 `_is_content_policy_violation` 识别（显式 code 优先判定，防止包含安全审核文案的其他业务错误码误判），**严禁将其判定为限流或故障切号重试**（换号重试必失败且增加全池账号关联风控风险），**严禁记入账号冷却池**。
    - **非流式 (stream=false)**: 秒级返回 HTTP 400 JSON (`invalid_request_error`)；
    - **流式 (stream=true)**: 遵循 SSE 协议标准（HTTP 200 `text/event-stream` 保持连接，首帧下发协议级 error 事件并立即闭合流：OpenAI 下发 `data: {"error": {"type": "invalid_request_error", "code": 11140, ...}}`；Anthropic 下发 `event: error`；Responses 下发 `event: response.failed`），严禁在 generator 内部抛 HTTPException(400)（FastAPI/Starlette 会因 headers 已发无法回滚并触发内部异常）；
    - **调度与用量**: 无论流式或非流式，usage 记录唯一归属 `HTTP 400 (11140 content rejected)`。
  - **借鉴项目看门巡检与故障降级守卫 (`tools/check-upstream.py` + `upstream-watch.yml`)**：巡检脚本区分「发现更新（`has_updates`）」与「查询失败（`has_query_failures`）」，仅在**全部查询成功且全部基线一致**（`has_updates == 'false' && has_query_failures == 'false'`）时才自动收口关闭 Issue。出现网络波动或 API 限额导致 `query_failed` 时，自动进入 `Watch degraded` 降级状态保留 Issue 并追加警告说明，根除「上游查询失败却被误当成无更新而误关 Issue」的假收口漏洞。

  **Responses / Anthropic 协议层硬约束（2026-09-12 修复，改动相关代码前必读）**：

  - **Responses 投影（`responses_projection.py`）默认关闭**：`optimize_context` 默认 `False`（safe/off），投影是**有损**的（system 截断 1200 / user 3200 / assistant 1800 / tool output 1600 / tool args 900 / 历史折叠）。需显式开启：`--optimize-context`、`WORKBUDDY2API_OPTIMIZE_CONTEXT=1`、或请求体 `optimize_context: true`、或请求头 `X-Optimize-Context: 1`。**function tool `description` 必须保留**（含 schema 内 `description`），它是模型判断「何时/如何调用」的语义信息，删除会导致工具调用能力退化。
  - **Responses `input_image` 必须走通**：`responses_compat._extract_content` 需把 `input_image`（item 级与 content 级，`image_url` 为字符串或对象两种形态）转成 Chat `image_url` 部件，再交给 `_inline_remote_images` 内联。丢图会导致视觉模型静默收不到图。
  - **Responses SSE 必须带规范字段**：`sequence_number`（从 0 严格单调递增，由 `_fmt` 统一注入）、`response_id`、`item_id`。仅事件名正确 ≠ wire protocol 兼容，Codex CLI 等严格客户端依赖这些字段。
  - **`thinking` 必须在 `PASSTHROUGH_BODY_KEYS` 中**：否则客户端显式 `thinking:{"type":"disabled"}` 会在透传时被丢弃，`inject_thinking` 看不到关闭意图而反向注入 `enabled`，与 `reasoning_effort=disable` / `enable_thinking=false` 形成参数打架。`inject_thinking` 现对三种关闭信号（`thinking.type=disabled`、`reasoning_effort=disable`、`chat_template_kwargs.enable_thinking=False`）统一识别并保持关闭语义（移除 `reasoning_effort`、保留 `thinking.type=disabled`）。
  - **Anthropic thinking 块时序单向锁定与工具流防抖（`anthropic_stream.py`，2026-09-14 修复）**：Anthropic 规范要求 `thinking` 块必须且只能位于消息最开头（index 0），一旦正文（`text`）或工具调用（`tool_use`）启动，`_thinking_sealed` 永久置位，严禁关闭活跃内容块重新开启 `thinking`；上游（如 DeepSeek）在工具参数流中夹带的 reasoning 片段会被就地吸收，杜绝状态机 Ping-Pong 震荡（致使前端单词单卡片刷屏）与重复捏造 `name: ""` 幽灵工具调用（致使下次请求触发 11133 拒绝）。同时维护 `_known_tools` 缓存，实现工具元数据跨 chunk 安全继承。
  - **Anthropic 流式 finish_reason 终结态收敛与伪 Null 过滤（`anthropic_stream.py` / `anthropic_compat.py`，2026-09-14 修复）**：上游（如腾讯 CodeBuddy DeepSeek）在流式中间分片中常带 `"finish_reason": ""`，或反代链路偶发 `"null"`/`"none"`/`"undefined"`/`"in_progress"` 等伪终结态。通过 `_is_terminal_finish_reason` 严格过滤非终结态，防止文本块逐 Token 异常断裂排版；同时 `_map_finish_reason` 在发生过工具调用时强收 `"tool_use"`，已知枚举精准对齐，未知有效终结枚举收敛至标准 `"end_turn"`，杜绝非法枚举打崩客户端或提前断连。

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
  切号原子写 `active_uid`，外部凭 mtime 感知无需重启；CLI 参数 `--rotate-mode` / `--rotate-count`
  （仅作 settings.json 不可读时的启动兜底默认值）。
  **调度策略为运行时热读**：`converter.py` 每次请求经 `_get_rotator()` 读 `settings.json`
  （`load_app_settings()`，按 mtime+size 签名缓存），GUI 改完**无需重启内核**即生效；
  `/api/rate_limit` 的 `rotation.config_source` 字段可观测（`hot`=已热加载 / `default`=回退兜底）。
  GUI 策略卡在「账号与资产」页，配置存 `settings.json`，`proxy_start` 始终透传参数（兜底用途）。
  ⚠️ 改这块先读第 4 节「AppConfig 整对象覆盖写盘」两条铁律。
- **今日用量与夜间限免窗口（A2/A3/B1/C1/C2 已完成，2026-09-11 交付）**：
  已在 `converter.py`、`src/accounts.js`、`token-stats` 插件落地：自然日（UTC+8）今日用量（`reqsToday`/`tokensToday`/`err429_today`）优先展示，兼容 5h/24h；动态感知 `23:00–08:00` 免费时段并打上「🌙 夜间限免中」徽章。提交 `83ef9e2`（c2o 仓） / `894f500`（hermes 仓 hermes 分支）。
- **用量明细契约（usage_events，对标 EasyCLIProxyAPI v0.2.90）**：
  `UsageRecord` 必须完整解析 `converter.py` 写入的 JSONL 字段（`model`/`error`/`retry_count`/`retry_reason`/`requested_model`/`actual_model`/`fallback_reason`）——少解析字段会让前端明细缺列而不报错。
  ⚠️ **IPC 键名必须是 camelCase**（下同）：`#[tauri::command]` 未声明 `rename_all` 时，
  tauri-macros 默认 `ArgumentCase::Camel` + `key.to_lower_camel_case()`，Rust 形参
  `since_ms`/`page_size` 对应的前端键是 **`sinceMs`/`pageSize`**。写成 snake_case 不会报错——
  形参是 `Option<_>`，缺键即静默 `None`（曾致时间范围筛选完全失效）。本文件早期版本把 Rust 侧
  形参名当成 IPC 键名写进文档，是这两处缺陷的引入源，勿再照抄形参名。
  `usage_events(model, status, sinceMs, page, pageSize)` 契约：筛选在 Rust 侧完成（`filter_usage_records`），**最新在前**排序后再分页；`analysis.models` 基于**过滤后全集**计算（不受分页影响），否则分组统计与筛选口径会自相矛盾。
  分页默认 50/页；`page`/`page_size` 为 0 时按 1 处理，越界页返回空列表但 `total`/`total_pages` 如实上报（前端据此禁用按钮）；空输入时 `total_pages` 仍为 1，避免前端除零。
  前端 `usage.js` 明细与汇总各自持有独立请求序号（`_usageRequestSeq` / `_usageEventsSeq`）——共用一个会让两个并行请求互相丢弃。
- **客户端鉴权密钥（AppConfig.api_key，对标 EasyCLIProxyAPI ApiAccessPage）**：
  `AppConfig.api_key` 带 `#[serde(default)]`（旧 settings.json 缺字段必须仍能反序列化，否则启动即崩）。
  `proxy_start` 仅在**密钥非空**时追加 `--api-key`：内核 `_check_auth` 对空 key 直接放行，但传空串会开启校验却无有效密钥，导致全部客户端 401。
  密钥生成必须用 CSPRNG（`crypto.getRandomValues`），禁止 `Math.random()`（可预测，等于没鉴权）。
  前端两处 `save_app_settings` 写入点都是**整对象覆盖写盘**：`settings.js` 的 `buildSettingsPayload` 必须显式带上 `api_key`，否则会被 serde default 抹成空串（`accounts.js` 用展开式浅合并，天然安全）。
  该字段不受热读机制覆盖——密钥在启动时以 CLI 参数注入，改后必须重启内核。
  **密钥注入方式（2026-09-12 P2，改动必读）**：禁止用
  `cmd.arg("--api-key").arg(&api_key)` 传参——密钥进入子进程 argv 后，本机任意
  有足够权限的进程都能从任务管理器 / wmic / WMI `Win32_Process.CommandLine`
  读到明文（settings.json 已是明文，不该再开第二处暴露面）。
  正确做法：`cmd.env("WORKBUDDY2API_KEY", &api_key)` 注入子进程环境——
  内核 argparse 的 `--api-key` 默认值本就取自 `_env_compat("KEY", "")`，内核零改动。
  契约锁定：`tests/test_secret_injection.test.js`（会剥离注释后断言代码里
  不得再出现 `"--api-key"` 传参）。
  **密钥优先级（2026-09-12 二次评审，实测三档，改动必读）**：
  `GUI 显式配置 > 继承环境变量 > 无鉴权`。
  ① GUI 设了密钥 → 走 `cmd.env` 注入，**总是胜出**，父进程即使也有
  `WORKBUDDY2API_KEY` 也不会反向覆盖（argparse 的 default 仅在 CLI 未显式给值时
  生效；实测同环境对拍：GUI 值请求 200、环境变量值请求 401）。
  ② GUI 留空 → **Rust 不清除父进程环境变量**，若父进程（如用户 shell、包装脚本）
  已设 `WORKBUDDY2API_KEY`（或旧名 `CODEBUDDY2OPENAI_KEY`），子进程会继承它并
  **启用鉴权**。这是有意的「环境变量 = 独立高级配置」语义，**不是**本次改动引入
  （`_env_compat("KEY")` 自 `db88e36` 改名兼容层起即存在），但属用户可见副作用：
  「GUI 里没填密钥却要求鉴权」时应先检查父进程环境变量。
  ③ 两者皆无 → 不鉴权（回环默认）。
  刻意**不**做「GUI 空密钥时清除环境变量」：那会破坏上述高级配置用法，且
  ① 已保证无覆盖风险。契约锁定：`tests/test_secret_precedence.test.js`。
  **GUI 侧转发命令的密钥解析必须复刻以上三档**（`proxy.rs::resolve_api_key`）：
  `proxy_rate_limit` / `proxy_checkin_claim` / `proxy_checkin_status` /
  `proxy_test_chat` 向本机内核转发时，密钥需按「GUI 配置 > 环境变量 > 无」解析。
  只读 GUI 配置会在 ② 路径（GUI 留空 + 父进程有环境变量）下 401 —— 而这正是
  「GUI 里看不到密钥、内核却要求鉴权」的困惑场景。Rust 单测：
  `proxy.rs::api_key_resolution_matches_documented_precedence`。
  ⚠️ **环境变量旧名以 Python 侧 `_env_compat` 为准：`CODEBUDDY2OPENAI_KEY`**
  （由 `tests/test_env_compat.py` 锁定）。`shared.rs::env_compat` 用的是 Go 时代
  遗留的 `C2O_` 前缀，与内核**不一致**，故 `resolve_api_key` 刻意不经过它 —— 
  照抄 `env_compat` 会让②路径又静默漏配。若要统一前缀，须先对齐两侧并同步改测试。
  ⚠️ **失败分级必须把「成功」挡在外面（`ed207c7` 修的回归，改动必读）**：
  `classify_status(code)` 返回 **`Option<ForwardFailure>`**，**所有 2xx 一律 `None`**
  （`is_failure_status(code) = !(200..300).contains(&code)`）；`forward_failure_message(code)`
  内部经 `classify_status(code)?` 短路，成功状态返回 `None`（= 无需报错）。
  四个调用点统一写成 `if let Some(msg) = forward_failure_message(status) { return Err(msg) }`。
  **禁止**再把任意状态码无条件塞进失败枚举——调用方按 `Option` 判失败，200 落进枚举
  就会把成功当错误抛给前端（曾致签到完全不可用：toast「签到请求失败: 内核返回 HTTP 200」，
  且四个转发命令全部受影响）。契约锁定：`proxy.rs::test_chat_probe_tests` 的
  `success_status_is_never_classified_as_failure`（200/201/202/204/299 既非失败也无失败文案）
  与 `failure_statuses_still_classified_and_actionable`（真失败仍被识别，401 文案含
  「密钥」「服务设置」）。变异验证：把 `is_failure_status` 改成恒 `true` → 两条测试立刻变红。
- **结构化日志透传（AppConfig.log_level / log_payloads）**：
  不传 `--log` 时内核 `_log()` 因 `log_path` 为空**直接丢弃**全部结构化行（请求摘要/耗时/错误详情），日志页只能看到 uvicorn 原始 stdout——所以 `proxy_start` 必须显式传 `--log` 指向 `converter.log`。
  `proxy_get_logs` 合并读取结构化日志与 stdout（各 48KB / 32KB 配额），只读其中一个会让用户看不到级别调整效果；`proxy_clear_logs` 必须同时清两个文件，否则清空后旧日志仍显示。
  `--log-payloads` 会把完整 Prompt/响应正文以**明文**落盘：默认关闭、UI 必须警示，且内核侧有「payload 开关 + trace 级」双闸门（`_log_payload`），前端不要试图绕过。
  日志文件写入前需保证目录存在；新增 `--log-level` 取值仅 info/debug/trace，非法值归一到 info。
- **请求快照（AppConfig.snapshots / snapshots_keep，调试 Tab 数据源）**：
  内核 `_record_snapshot` 经 `_SNAP_CTX`（ContextVar，任务局部）由三聊天端点入口透传，
  `_record_usage` 在所有完成路径统一落盘——错误路径无需逐个手工接线，改完成点时别绕开 `_record_usage`。
  快照腿独立于用量开关（`usage_log` 为空仍落快照）。文件 `%LOCALAPPDATA%/workbuddy2api/usage/snapshots.jsonl`
  由 `proxy_start` 以 `--snapshots-log` 注入；超 `2*keep` 行轮转保留 `keep` 条（默认 200）。
  快照默认开启（含完整 prompt 明文，Token/Key 已脱敏）：关了调试 Tab 即无新数据，别误报成采集 bug。
  重放（`snapshot_replay`）只接受本机 `/v1/` 规范路径（禁 `..`/query/反斜杠/双斜杠，防篡改快照打站外），调用方传 `port` + **`apiKey`**（camelCase——Rust 形参名是 `api_key`，但 IPC 键按 tauri-macros 默认驼峰化为 `apiKey`；曾因写成 snake_case 导致配了密钥后重放必 401），
  前端复制 curl 时密钥只放 `YOUR_KEY` 占位。
  已知限制（不修）：`snapshots_clear`（Rust 直接清文件）与内核追加写之间无跨进程锁，
  极端并发下可能多留/少留一行——调试记录级别的影响，不做原子替换。
- **局域网访问（AppConfig.listen_host + lan_ipv4 命令）**：
  `listen_host` 默认必须是 `127.0.0.1`（安全默认，任何情况下不得默认 `0.0.0.0`）。
  **语义准确性（2026-09-12 P2）**：开关实际下发 `0.0.0.0` = 绑定**所有网卡**
  （Wi-Fi / 有线 / VPN / 虚拟网卡），**不是**「仅局域网」。UI 文案必须如实写成
  「监听所有网卡（含局域网 / VPN / 虚拟网卡）」并点出 VPN 与虚拟网卡暴露面，
  不得简化成「允许局域网内其它设备访问」——那会让用户低估暴露范围。
  （未做「让用户选择具体 LAN IP」的产品级增强，属后续可选项。）
  契约锁定：`tests/test_lan_semantics.test.js`。
  `proxy_start` 在**非回环 + 密钥为空**时必须 `return Err` 拒绝启动并给出可操作提示——内核也会 exit 1，但用户看到的是「内核启动后立刻退出」而无从判断原因。刻意**不**提供 `--unsafe-expose` 放行开关：GUI 不应鼓励无鉴权暴露。
  `lan_ipv4` 用 UDP `connect` 查路由表选出默认出口网卡（不发包、不依赖外网连通性），失败返回 `None` 由前端降级；不要改用需要联网请求的方案。
  前端开关在无密钥时须拦截并引导先生成密钥（与内核判定一致），`buildSettingsPayload` 必须带上 `listen_host`。
- **浏览器跨站防御（Host + Origin 双校验，仅回环绑定时生效）**：
  `LocalHostOnlyMiddleware` 校验 Host 头（防 DNS rebinding）；`OriginGuardMiddleware`（**最外层**，先于 body 缓冲）校验 Origin 头，
  防恶意外网页面向 `127.0.0.1:<port>` 发起的跨站「简单请求」——`POST + text/plain` 不触发 CORS 预检，网页读不到响应，却能触发副作用（消耗额度、`/api/checkin/claim`）。
  规则：**无 Origin 放行**（curl / Codex CLI / Claude Code CLI / Hermes Agent 等原生客户端）；有 Origin 则仅放行回环页面
  （`http(s)://localhost` / `127.0.0.0/8` / `[::1]`，任意端口）、Tauri WebView（`tauri://localhost`、`http(s)://tauri.localhost`）与 `chrome-extension://*`；
  其余一律 403 `invalid_origin`，**含字面量 `null`**（沙箱 iframe / `file://` / `data:` 页面都会产生，攻击者可轻易构造）。
  额外来源用 `WORKBUDDY2API_ALLOWED_ORIGINS`（逗号分隔、精确匹配、无通配符；旧名 `CODEBUDDY2OPENAI_ALLOWED_ORIGINS`）——
  Electron 的 `file://` 页面会发 `null`，需显式列出。
  **改动必读**：① 只比对 `urlsplit` 解析出的 scheme + 主机名，**严禁**改成 `startswith("http://localhost")`（会放行 `localhost.evil.com` / `localhost@evil.com`）；
  ② 网关**不返回任何 CORS 头**——放行 ≠ 浏览器 JS 能读到响应；需要浏览器直连的 Web UI 属另一个功能，不要为此放宽本校验；
  ③ 局限：浏览器发起的「无 Origin」跨站 GET（如 `<img src>`）不在防线内，因此所有 GET 端点必须保持只读。契约锁定：`tests/test_origin_guard.py`。
- **凭证轮换（P1，**已交付** 2026-09-11，见上方「多账号调度」条目）**：
  多账号就位后按既定要点实施完毕（`AccountRotator` + GUI 策略卡）。
  token 续期由 `converter.py` 的 `_refresh()` 被动处理（`expiresIn` 60 天 /
  `refreshExpiresIn` 90 天）；激活的账号在 `_refresh_session_tokens()` 中按 uid 定向续期。
  设计约束（仍然有效）：**必须 opt-in 且默认关闭**，不做定时/自动的上游交互
  （09-08 用户裁定）；参考 `IceeAn/codebuddy2api`（MIT，看门条目 `c2api-upstream-iceean`），
  只借思路不搬文件，取代码须出自其当前树并署名（合规红线见第 5 节）。

- **前端极客 UI 规范（对标 EasyCLIProxyAPI 设计语言，2026-09-17 重构）**：
  采用双列控制中心（左侧服务核心控制面板 + 状态胶囊 `state-pill` 与呼吸发光灯 `dotPulse`；右侧三大协议端点卡片网格 `endpoint-card`，支持完整端点与端口动态联动）。
  卡片采用现代极客立体微高光双层边框（`inset 0 1px 0 rgba(255,255,255,0.05)` + 渐变微光）；
  设置页采用四分组现代功能卡（网络端点/安全鉴权/模型客户端/日志调试）；
  用量统计页采用大号等宽指标卡（`tabular-nums`）与 Sticky 表头明细表；
  日志控制台引入终端呼吸微光灯与毛玻璃模态弹窗（`backdrop-filter: blur(10px)`）；
  引导面板采用等宽代码微凹槽与胶囊分段切换 Tab（`snippet-tab-pills` 就地切换 Bash/PS/JSON）。
  所有视觉改动必须保持既有 202 条前端契约全绿，严禁破坏既有 DOM 元素 ID 与键盘无障碍焦点规范。

- **签名缓存提交流程与测试数据隔离（2026-09-17 踩坑沉淀，改动必读）**：
  1. **签名提交原则（解析成功才提交新签名）**：
     所有基于 `(mtime, size)` 的签名缓存（`load_app_settings` / `_read_all_accounts` / `_load_model_settings` / `_load_availability`），
     必须在 `json.loads` 成功且校验数据结构合法后才更新 `_sig = sig`。若文件处于并发半写或暂时损坏状态，
     解析异常时绝不得更新签名，防止把异常状态当成 fresh 缓存死锁；下次读取会自然重试。契约锁定：`tests/test_perf_and_hotpath_optimizations.py`。
  2. **测试数据隔离铁律**：
     本地/单元测试绝对禁止读写 `%LOCALAPPDATA%/workbuddy2api/accounts.json` 等真实用户数据路径；
     必须通过 pytest `tmp_path` 或 monkeypatch 隔离，严禁将 mock token 写进宿主真实配置导致客户端报 401。
  3. **模型标签极简口径**：
     控制台模型表标签列仅保留 Agent 来源端标识（`CodeBuddy` / `WorkBuddy` / `双端`），
     上游业务修饰标签（主力/深度推理/高智商等）一律过滤剔除。

- **请求级控制头与全冷却 Half-Open 单飞探针（2026-09-19 借鉴 9router 吸收交付，改动必读）**：
  1. **请求级旁路控制头（`X-WorkBuddy-Account` / `X-WorkBuddy-Strategy`）**：
     - `X-WorkBuddy-Account` 支持精确 UID 与唯一 alias，**严格遵守安全门禁**：指定账号处于冷却中或不可用时，必须 Fail-Open 放弃指定，严禁穿透冷却；
     - 契约修正 A：无效或冷却的 Account 覆盖不会清空同请求中合法的 Strategy 覆盖；
     - 重名 alias 视为输入歧义直接 Fail-Open；非法 Strategy 安全回退全局；
     - 契约修正 B：实际发往后端的请求在响应头回传 `X-WorkBuddy-Active-Account: <uid>`，未发生真实调用的错误请求不返回该头。
  2. **全冷却 Half-Open 单飞探针与防惊群保护（`_PROBE_INFLIGHT`）**：
     - 契约修正 C：全池冷却时，`best_uid` 必须通过「当前有效账号池 ∩ 冷却字典」交集计算，绝不选择已删除/禁用的残留账号；
     - 契约修正 D：放行单飞探针时保持全局 active_uid 稳定（不提前切换防惊群），并发请求自动避让回退；
     - 探针结束无论成功、失败、异常、取消，`finally` 块必须调用 `_release_probe` 释放锁；
     - 探针成功（2xx）自动调用 `_clear_account_cooldown` 触发账号自愈；
     - 内部冷却判断优先由 `time.monotonic()` 驱动，免疫系统时间跳变；
     - `DeferredHeaderStreamingResponse` 挂起首包确认，确保流式 failover 场景下响应头准确同步最终生效的 `X-WorkBuddy-Active-Account`；
     - 严格保持既有 `/api/rate_limit` 三态契约不变。契约锁定：`tests/test_header_override_and_cooldown_probe.py`（16 条单测）。

