# Third-Party Notices / 第三方组件与代码致谢

本仓库（workbuddy2api）包含从下列 MIT 许可项目中移植或借鉴的代码。依照 MIT 许可证的保留版权声明与许可声明之条件，在此集中列出各上游项目的版权信息、借鉴范围与移植说明。

---

## 1. xiaofan6ya/workbuddy2api

- **上游仓库**：<https://github.com/xiaofan6ya/workbuddy2api>
- **许可证**：MIT License
- **版权声明**：
  ```
  Copyright (c) 2026 HanHan666666
  Copyright (c) 2026 Chris
  ```
- **借鉴内容与落点**：
  | 借鉴项 | 移植到本仓库的位置 | 说明 |
  | --- | --- | --- |
  | `turing_helper.js` —— 通过 WorkBuddy 桌面端自带 Turing Shield SDK 取设备风控 token（SDK 目录自动发现，不写死路径） | `turing_helper.cjs`（改名为 `.cjs` 以适配本仓库 `package.json` 的 `type: module`） | 思路与自动发现逻辑借鉴自上游；本仓库按自身 Node 环境做了适配 |
  | `X-Device-Token` 设备风控头注入机制（敏感请求注入设备 token，取不到时优雅降级） | `converter.py` → `_get_turing_device_token()` / `_find_node_runtime()` / `CredentialManager._build_headers_from()` | 注入策略与降级语义借鉴自上游 converter.py 的同名机制，实现为本仓库独立版本（进程内 10 分钟缓存、子进程 20 秒超时） |
  | `7eb98db3` —— HTTP 200 内嵌错误不得当成功（上游在 `admin/routers/proxy.py` 引入 `_iter_json_objects` / `_is_error_obj` / `_sse_has_content` 与 64KB 带内探测窗口） | `converter.py` → `_parse_non_sse_body` / `UpstreamInBandError` / `_collect_stream` 的 `probe_lines` 缓冲、`_has_stream_payload`、`UpstreamEmptyStreamError` | 采纳其「200 不等于成功」的语义，但触发形态按本仓库实测独立实现：本仓库三次真实请求均返回 200、未复现上游假设的拦截形态，故只按自身取证到的三种正文（完整 `chat.completion` / 错误信封 / 网关 HTML）分类，**仅第一种算成功**；`UpstreamInBandError` 刻意继承 `httpx.HTTPError`，以复用各协议入口既有的换号 / 记失败 / 协议化错误链路。分片聚合路径另加零帧哨兵（见 `tests/test_empty_stream_sentinel.py`） |

## 2. DistPub/workbuddy2api（xiaofan6ya 仓库的增强分支）

- **上游仓库**：<https://github.com/DistPub/workbuddy2api>
- **许可证**：MIT License
- **版权声明**：
  ```
  Copyright (c) 2026 HanHan666666
  Copyright (c) 2026 Chris
  ```
- **借鉴内容与落点**：
  | 借鉴项 | 移植到本仓库的位置 | 说明 |
  | --- | --- | --- |
  | 流式 reasoning 合并器 `_ReasoningCoalescer`、空 delta 清洗 `_sanitize_delta_obj` / `_maybe_sanitize_line`、SSE 行缓冲 `_SseLineBuffer` | `converter.py`（`_stream_upstream` 字节循环接线） | 移植时修复了上游实现的一个缺陷：`_sanitize_delta_obj` 用 `dict.get()` 把「content 键不存在」误判为「content 为空串」，导致纯 reasoning 帧被静默删除；本仓库改为显式 `if k not in new_delta: continue` |
  | 脱敏词表品牌词扩张（Claude / Anthropic / OpenAI / Gemini / Kimi / Qwen / Cursor / OpenCode / agent-identity 等） | `desensitize.py` → `SENSITIVE_TERMS` | 竞争品牌词实测触发上游 11128 审核拦截 |
  | 脱敏角色覆盖扩张：`(system,)` → `(system, assistant)` | `converter.py` → `chat_completions` 内 `desensitize_body(...)` 调用点 | assistant 历史回复实测同样触发审核拦截 |

## 3. IceeAn/codebuddy2api

- **上游仓库**：<https://github.com/IceeAn/codebuddy2api>
- **许可证**：MIT License（当前代码树自 `bce86ded` 起由维护者独立重写并以 MIT 开源）
- **版权声明**：
  ```
  Copyright (c) 2026 An! / IceeAn contributors
  ```
- **借鉴内容与落点**：
  | 借鉴项 | 移植到本仓库的位置 | 说明 |
  | --- | --- | --- |
  | Claude 客户端指纹脱敏与短语改写策略（对已知客户端标识特征句做精确中性替换，消除 `x-anthropic-billing-header:` 等触发源） | `desensitize.py` → `_rewrite_known_fingerprints()` / `desensitize_body()` | 借鉴其对客户端已知特征串做精确替换的思路，彻底解决 Claude Code 等 CLI 工具上游 11128 策略误拦截；本仓库独立实现了两层脱敏结构 |
  | 凭证生命周期与多账号轮换调度思路（待多账号就绪后按需实施） | `AGENTS.md` / `converter.py`（P1 架构储备） | 参考其令牌管理与多账号平滑轮换的设计思路 |
- **合规边界说明**：
  上游原始项目 `xueyue33/codebuddy2api` 无任何开源许可证（All rights reserved）。依照开源合规红线，本仓库严禁搬运任何原始上游未授权代码，仅从 IceeAn 独立重写后的 MIT 当前树借鉴思路与脱敏策略，并在此集中保留致谢与许可声明。

## 4. 上游端点逆向成果的参考

- **每日签到链路**：`POST /v2/billing/meter/checkin-activity-status` 与 `POST /v2/billing/meter/daily-checkin` 的接口形态、业务码语义（1001=今日已领 / 1002=无资格 / 1003=活动已结束）参考了上述两仓库对 WorkBuddy 桌面端的逆向分析结论。本仓库按自身定位实现为 **GUI 手动按钮触发**（`/api/checkin/status`、`/api/checkin/claim`），不包含上游的自动定时签到逻辑。

## 5. 开源生态优秀实践借鉴（2026-09 横向对比采纳）

| 借鉴源 | 许可证 | 借鉴项 | 移植落点与说明 |
|---|---|---|---|
| `linguo2625469/workbuddy2api-panel`（基于 `Sliverkiss/workbuddy2api`） | MIT | 请求体上限保护机制（413 Payload Too Large）与多账号网关核心架构 | `converter.py`：引入 `MAX_BODY_MB` 与 `RequestBodyLimitMiddleware`，超限请求直接秒拒返回标准 413 `request_body_too_large`，防御超大 payload 击穿本地内存与上游 WAF；参考原版多账号池与路由调度思路 |
| `ardeyouxipianyi/workbuddy2api-hub`（原 `workbuddy2api-intl`，已更名） & `turbomind66/workbuddy2api-python` | MIT | 官方客户端 User-Agent 仿真与可配置环境变量 | `converter.py`：出站 UA 从硬编码升级为仿真官方客户端规范（`CLI/2.63.2 CodeBuddy/2.63.2` / 国际版 `WorkBuddy/5.5.2...`），并支持 `WORKBUDDY2API_USER_AGENT` 动态覆盖，规避上游非标 UA 导致的 10085 拦截与归因异常 |
| `momo0410/workbuddy-switch-gateway` | MIT | 按积分到期日分层选号调度算法（先烧快过期额度） | `converter.py`：`AccountRotator` 引入 `get_candidate_uids_tiered` 与多格式到期日解析，按日粒度优先将即将过期的账号排在最前，避免额度失效浪费 |
| `ShouZhuo0413/codebuddy2api` & `hawklithm/workbuddy2api` | MIT | OpenAI Responses 协议（`POST /v1/responses`）双向适配层与流式事件状态机 | `responses_compat.py`：实现 Responses 请求/工具/多轮消息与 Chat 互转，及 `ResponsesStreamConverter` 流式语义事件流，原生直连驱动 Codex CLI |
| `neipor/codebuddy-cli2api` | MIT | 远程多模态图片自动转 Data-URI 机制 | `converter.py`：实现 `_url_to_data_uri` 与 `_inline_remote_images`，自动异步下载 http(s) 远程图片并内联为 base64 data URI，解除腾讯后端仅接受 data URI 的 400 约束 |
| `icebears111/workbuddy2api` | MIT | 上游内容安全审核错误码（11140）拦截与防误判机制 | `converter.py`：引入 `_is_content_policy_violation` 与 `_safe_err_raw` 结构化包装，识别 11140 安全审核拦截并立即返回明确错误，严禁将其误判为限流或故障进行盲目切号重试与账号冷却 |
| `Sliverkiss/workbuddy2api` | MIT | Go 原版的多账号池 / 加权调度核心架构（横向对比）；**其源码同时被用作错误码语义的上游真源** | 架构层面参考其多账号池与加权选号思路；本轮起另作语义真源使用：据其实现确认 `14017 = ErrAccountFault`（试用未激活，**非**额度耗尽）、`model usage limit exceeded = ErrSoftRate`（软限流）、`quota exceeded = HardCredit`（计费额度），据此纠正了本仓库错误分类的词表方向与冷却分层（14017 走短冷却可自愈、计费额度与频控限流分属不同错码族） |
| `orangeboyChen/codebuddy2api` | MIT | `#178` —— 剥离 Claude Code 客户端注入的 token 用量提示 | `anthropic_compat.py` → `_strip_client_usage_hints` / `_CLIENT_USAGE_HINT_RES`；`responses_projection.py` → `_strip_harness_blocks`。上游为 TypeScript 实现，本仓库按 Python 复刻其两条设计取舍（带壳形态先匹配；倒计时必须带数字载荷），并额外覆盖本仓库特有的「空壳消息丢弃」与「harness 标记与真实指令同条」边界（见 `tests/test_client_usage_hint_strip.py`、`tests/test_harness_block_strip.py`） |
| `ShouZhuo0413/codebuddy2api` | MIT | `validate_stream_end` —— 流被截断不得报成功 | `converter.py` → `_stream_upstream` 的 `saw_done` 截断哨兵；`responses_compat.py` → `ResponsesStreamConverter._saw_terminal` 与 `finish()` 的 `response.failed` 分支。判据按本仓库实证调整：上游正常收尾必给 `finish_reason`，而 `[DONE]` 是否补发各家不一（本机 600 条流式响应中 587 条无 `[DONE]`），故取「两个终止信号都缺」为截断判据，避免误报（见 `tests/test_truncated_stream_sentinel.py`） |

---

## 许可证说明

- 上述上游项目均以 **MIT License** 发布，本仓库同样以 MIT License 开源（见 [LICENSE](LICENSE)）。
- 依据 MIT 许可证条件，本仓库在分发时保留了上述版权声明与许可声明；各借鉴项的具体出处与移植差异已在上表如实记录。
- 除特别注明外，本仓库其余部分基于 [HanHan666666/codebuddy2openai](https://github.com/HanHan666666/codebuddy2openai) 深度二次开发，其版权声明见 [LICENSE](LICENSE)（Copyright (c) 2026 HanHan666666）。
