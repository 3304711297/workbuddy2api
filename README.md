<div align="center">

# 🚀 CodeBuddy2OpenAI

### 独立桌面控制台 · WorkBuddy 转 OpenAI 兼容端点 · 多账号资产管理 · Agent 一键接入

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/3304711297/codebuddy2openai)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24C8D8.svg?logo=tauri)](https://tauri.app/)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB.svg?logo=python)](https://www.python.org/)

<p align="center">
  <b>无需下载或安装原版腾讯 WorkBuddy 客户端</b>，直接在浏览器中完成网页授权，<br/>
  将腾讯代码助手能力转换为标准的 <code>OpenAI /v1/chat/completions</code> 接口，供日常各类 AI 编程助理极速调用！
</p>

</div>

---

## ✨ 核心特性

- 🖥️ **独立现代化桌面 GUI (Tauri v2 + 原生深色设计)**：提供直观的服务看板、端口设置、实时延迟测试与状态指示。
- 🔑 **无需安装原版 WorkBuddy**：集成浏览器 OAuth 授权全自动轮询流程，直接扫码/验证码登录获取凭据。
- 👥 **多账号管理与切换**：凭据统一持久化于本地数据库，支持一键切换活跃账号、手动刷新 Token 与账号删除。
- 📊 **内嵌真实积分资产看板**：逆向对接腾讯官方计量计费接口，实时掌握账户剩余积分、使用进度条及资源包配额明细。
- 🤖 **Agent 智能体一键接入**：
  - **Hermes Agent**：一键检测并注入 `config.yaml`（自动注册供应商并映射 7 个快捷模型别名）。
  - **ZCode**：一键检测并注入 `cli/config.json` 与 `v2/config.json`（自动映射 15 个模型）。
  - 均支持一键写入与一键移除恢复。
- ⚡ **超全模型矩阵映射**：内置 `glm-5.3-flash` (1M 上下文)、`glm-5.3`、`kimi-k3`、`deepseek-v4-pro`、`hy4-preview` 等 15 个主流大模型映射。
- 🛡️ **安全脱敏支持**：内置 `--desensitize` 敏感词处理机制，避免系统提示词误触发安全风控拦截。

---

## 📐 系统架构与工作流

```mermaid
flowchart TD
    subgraph Client [AI 客户端 / 智能体]
        Hermes[Hermes Agent]
        ZCode[ZCode 终端]
        Other[Cherry Studio / NextChat / OpenAI SDK]
    end

    subgraph Console [CodeBuddy2OpenAI 桌面控制台 (Tauri v2)]
        GUI[前端 UI (服务看板/账号资产/Agent接入)]
        Core[Rust 后端 (多账号/配置写入/生命周期)]
        DB[(本地 accounts.json)]
    end

    subgraph Proxy [本地反代服务 (端口 8787)]
        Server[FastAPI / Uvicorn]
        Converter[converter.py (格式转换/流式/函数调用)]
    end

    subgraph Remote [腾讯官方云端]
        Auth[OAuth 授权中心]
        Meter[Billing 计费与积分中心]
        Copilot[Copilot 模型推理服务]
    end

    Hermes -->|http://127.0.0.1:8787/v1| Server
    ZCode -->|http://127.0.0.1:8787/v1| Server
    Other -->|http://127.0.0.1:8787/v1| Server

    GUI <-->|Tauri IPC Invoke| Core
    Core <--> DB
    Core -->|进程托管与健康探针| Server
    Core -->|OAuth 授权与积分直查| Auth
    Core -->|查询资源包额度| Meter

    Server --> Converter
    Converter -->|原生 Bearer Token 转发| Copilot
```

---

## 🚀 快速开始

### 方式一：直接运行桌面客户端（推荐）

双击桌面生成的 **`CodeBuddy2OpenAI`** 快捷方式，或直接运行发布产物：
```bash
src-tauri/target/release/codebuddy2openai.exe
```

1. **授权登录**：进入「授权新账号」页面，点击开始授权，浏览器将自动唤起腾讯登录页，完成授权后客户端自动保存凭据并切到账号面板。
2. **启动服务**：在「服务看板」点击「启动服务」，本地将监听 `http://127.0.0.1:8787`。
3. **Agent 一键接入**：进入「Agent 一键接入」页面，点击「一键写入配置」即可直接在 Hermes 或 ZCode 中畅享 WorkBuddy 模型！

---

### 方式二：本地构建与源码调试

#### 环境要求
- Node.js 18+ 与 npm
- Rust 1.77+ 与 Cargo
- Python 3.10+（需安装依赖 `httpx fastapi uvicorn[standard]`）

```bash
# 1. 克隆本项目
git clone https://github.com/3304711297/codebuddy2openai.git
cd codebuddy2openai

# 2. 安装前端依赖并构建
npm install
npm run build

# 3. 运行 Tauri 开发模式或构建 Release 版本
cd src-tauri
cargo tauri dev       # 调试模式
cargo tauri build --no-bundle   # Release 编译
```

---

## ⚙️ 模型支持列表

| 模型标识 (Model ID) | 上下文窗口 (Context) | 特性说明 |
| :--- | :--- | :--- |
| `glm-5.3-flash` | **1,048,576 (1M)** | 主力推荐、极速响应、超长文本处理 |
| `glm-5.3` | **1,048,576 (1M)** | 深度推理、高智商编码任务 |
| `glm-5.2` | **1,048,576 (1M)** | 稳定版长文本通用模型 |
| `glm-5v-turbo` | **1,048,576 (1M)** | 视觉多模态图像分析能力 |
| `kimi-k3` | **200,000 (200K)** | 超长文本检索与细致分析 |
| `kimi-k2.7` | **200,000 (200K)** | 通用对话与写作 |
| `deepseek-v4-pro` | **200,000 (200K)** | 针对复杂算法与架构的高阶代码模型 |
| `deepseek-v4-flash`| **200,000 (200K)** | 极速响应轻量代码模型 |
| `hy4-preview` | **200,000 (200K)** | 腾讯混元最新一代预览版 |
| `auto` | **1,048,576 (1M)** | 智能自动路由 |

---

## 💻 客户端接入示例 (Python SDK)

```python
from openai import OpenAI

# 本地 CodeBuddy2OpenAI 端点
client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="local" # 本地模式固定填写 local
)

response = client.chat.completions.create(
    model="glm-5.3-flash",
    messages=[
        {"role": "user", "content": "你好，请用 Python 写一个支持并发的安全队列。"}
    ],
    temperature=0.7
)

print(response.choices[0].message.content)
```

---

## 🤝 致谢与声明

- 本项目基于 [HanHan666666/codebuddy2openai](https://github.com/HanHan666666/codebuddy2openai) 进行深度二次开发与架构重构。
- 架构设计深度借鉴了优秀开源项目 [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI) 的桌面端实践思路。
- 本工具仅供个人学习、技术研究与工作流效率提升使用，请妥善保管个人授权凭据，遵循腾讯云相关产品服务协议。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
