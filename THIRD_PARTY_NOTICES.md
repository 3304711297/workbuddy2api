# Third-Party Notices / 第三方组件与代码致谢

本仓库（codebuddy2openai）包含从下列 MIT 许可项目中移植或借鉴的代码。依照 MIT 许可证的保留版权声明与许可声明之条件，在此集中列出各上游项目的版权信息、借鉴范围与移植说明。

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

## 3. 上游端点逆向成果的参考

- **每日签到链路**：`POST /v2/billing/meter/checkin-activity-status` 与 `POST /v2/billing/meter/daily-checkin` 的接口形态、业务码语义（1001=今日已领 / 1002=无资格 / 1003=活动已结束）参考了上述两仓库对 WorkBuddy 桌面端的逆向分析结论。本仓库按自身定位实现为 **GUI 手动按钮触发**（`/api/checkin/status`、`/api/checkin/claim`），不包含上游的自动定时签到逻辑。

---

## 许可证说明

- 上述上游项目均以 **MIT License** 发布，本仓库同样以 MIT License 开源（见 [LICENSE](LICENSE)）。
- 依据 MIT 许可证条件，本仓库在分发时保留了上述版权声明与许可声明；各借鉴项的具体出处与移植差异已在上表如实记录。
- 除特别注明外，本仓库其余部分基于 [HanHan666666/codebuddy2openai](https://github.com/HanHan666666/codebuddy2openai) 深度二次开发，其版权声明见 [LICENSE](LICENSE)（Copyright (c) 2026 HanHan666666）。
