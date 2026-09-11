/**
 * turing_helper.js — 从本机 WorkBuddy 桌面端自带的 Turing Shield SDK 取得设备风控 Token。
 *
 * 用途：workbuddy2api（Python 网关）需要给后端请求注入 `X-Device-Token` 头，
 * 否则敏感请求（签到 / 对话）会被上游风控识别为「非真实客户端」。设备 Token 由桌面端
 * 的 TuringShieldSDK 原生桥接生成，本脚本是 Python 侧调用该原生模块的桥梁。
 *
 * 输出（stdout，单行 JSON）：{"token": "v3:AAAA..."}；失败仅向 stderr 写错误并返回非 0。
 *
 * **SDK 目录自动发现（不写死）**：不同用户把 WorkBuddy 桌面端装在不同位置，本脚本按
 * 以下顺序查找 turing-sdk 目录（含 index.cjs 入口 + 官方 SDK 强特征）：
 *   1. 环境变量 WORKBUDDY_TURING_SDK_DIR（用户显式信任：入口 index.cjs 存在即可，可指向
 *      turing-sdk 目录或桌面端安装基目录）
 *   2. %LOCALAPPDATA% / %APPDATA% / %ProgramFiles% / %ProgramFiles(x86)% / %USERPROFILE% /
 *      %HOME% 下的 WorkBuddy 或 workbuddy 目录（严格特征校验）
 *   3. 各盘根目录扫描：默认关闭；仅在显式设置 WORKBUDDY_TURING_DRIVES 时启用（严格特征校验）
 *
 * 供应链加固（严格特征 = index.cjs 入口 + [turing_sdk.node 且 package.json 含 turing 标识，
 * 或 TuringShieldSDK.dll]），防止"目录恰好有个 index.cjs/package.json 就被 require 执行"。
 *
 * 其余可覆盖的环境变量：
 *   WORKBUDDY_TURING_CHANNEL_ID  channelId（桌面端 product.json 中 turingSdk.channelId，默认 109144）
 *   WORKBUDDY_TURING_PRODUCT_NAME 产品名（默认 WorkBuddy）
 *   WORKBUDDY_TURING_VERSION      产品版本（默认 2.0.0）
 *   WORKBUDDY_TURING_DRIVES       参与扫描的盘符列表，逗号分隔（默认空 = 不扫描盘根）
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");

// 已知的 SDK 相对路径（相对于桌面端安装基目录）
const REL_SDK_PATHS = [
  "resources/app.asar.unpacked/native/turing-sdk",
  "resources/native/turing-sdk",
];

// SDK 目录校验：index.cjs 必须存在（require 的入口）。
// strict=true（自动发现）：入口 + 官方 SDK 强特征双重确认，防止"目录恰好有个 index.cjs 就被 require 执行"的本地供应链风险。
// strict=false（仅用于用户显式 WORKBUDDY_TURING_SDK_DIR 路径）：入口存在即接受（用户显式信任）。
function looksLikeSdk(dir, strict) {
  try {
    const ents = fs.readdirSync(dir);
    const has = (re) => ents.some((n) => re.test(n));
    if (!has(/^index\.cjs$/i)) return false; // require(目录) 的入口文件
    if (!strict) return true;
    // 原生模块/DLL 可能在根目录，也可能在 build/Release 子目录（桌面端实际布局）
    const scanDirs = [dir, path.join(dir, "build", "Release")];
    const hasIn = (d, re) => {
      try {
        return fs.readdirSync(d).some((n) => re.test(n));
      } catch (_) {
        return false;
      }
    };
    const hasNative = scanDirs.some((d) => hasIn(d, /turing[_-]?sdk.*\.node$/i));
    let pkgOk = false;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      pkgOk = /turing/i.test(String(pkg.name || "")) || /turing/i.test(String(pkg.description || ""));
    } catch (_) {
      pkgOk = false;
    }
    const hasOfficialDll = scanDirs.some((d) => hasIn(d, /^TuringShieldSDK\.dll$/i));
    return (hasNative && pkgOk) || hasOfficialDll;
  } catch (_) {
    return false;
  }
}

function collectCandidateDirs() {
  const out = [];
  const add = (d) => { if (d && !out.includes(d)) out.push(d); };

  // 1) 显式覆盖（最高优先级）
  const explicit = process.env.WORKBUDDY_TURING_SDK_DIR;
  if (explicit) {
    const e = path.resolve(explicit);
    if (looksLikeSdk(e)) {
      add(e);
    } else {
      // 当作安装基目录，拼上已知相对路径再试
      for (const rel of REL_SDK_PATHS) add(path.join(e, rel));
    }
  }

  // 2) 常见安装基目录
  const bases = [];
  for (const ev of ["LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramFiles(x86)", "USERPROFILE", "HOME"]) {
    const v = process.env[ev];
    if (v) {
      bases.push(path.join(v, "WorkBuddy"));
      bases.push(path.join(v, "workbuddy"));
    }
  }

  // 3) 各盘根目录扫描：默认关闭（供应链加固——盘根 WorkBuddy 目录不是官方默认安装位置，
  //    宽松候选 + 盘根扫描会放大本地执行风险）。仅在显式设置 WORKBUDDY_TURING_DRIVES 时启用。
  //    支持纯盘符 C / 带冒号 C: / 完整根路径 C:\ 三种写法。
  const drives = (process.env.WORKBUDDY_TURING_DRIVES || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  for (const d of drives) {
    let root;
    if (/^[A-Za-z]$/.test(d)) {
      root = d + ":\\";          // 纯盘符 C -> C:\
    } else if (/^[A-Za-z]:$/.test(d)) {
      root = d + "\\";           // C: -> C:\
    } else if (d.endsWith("\\") || d.endsWith("/")) {
      root = d;                  // 已是根路径
    } else {
      root = d + "\\";
    }
    bases.push(path.join(root, "workbuddy"));
    bases.push(path.join(root, "WorkBuddy"));
  }

  for (const base of bases) {
    for (const rel of REL_SDK_PATHS) add(path.join(base, rel));
  }
  return out;
}

function findSdkDir() {
  const dirs = collectCandidateDirs();
  // 第一轮：跳过显式 env 路径，用严格特征扫描常规安装位置
  const explicit = process.env.WORKBUDDY_TURING_SDK_DIR ? path.resolve(process.env.WORKBUDDY_TURING_SDK_DIR) : null;
  for (const dir of dirs) {
    if (explicit && path.resolve(dir) === explicit) continue;
    if (looksLikeSdk(dir, true)) return dir;
  }
  // 第二轮：显式 env 路径走用户显式信任（宽松特征：index.cjs 存在即可）
  if (explicit && looksLikeSdk(explicit, false)) return explicit;
  return null;
}

if (require.main === module) {
  const sdkDir = findSdkDir();
  if (!sdkDir) {
    process.stderr.write(
      "TuringShield SDK 未找到。本脚本依赖本机已安装的 WorkBuddy 桌面端自带的 TuringShieldSDK 原生模块。\n" +
      "已搜索以下候选目录（设置环境变量 WORKBUDDY_TURING_SDK_DIR 指向含 index.cjs / TuringShieldSDK.dll 的目录即可覆盖）：\n"
    );
    for (const d of collectCandidateDirs()) process.stderr.write("  - " + d + "\n");
    process.stderr.write("\n若你已安装桌面端但目录特殊，请设置 WORKBUDDY_TURING_SDK_DIR 后重试。\n");
    process.exit(1);
  }

  // 把 SDK 目录及其 build/Release 加入 DLL 搜索路径，提升 TuringShieldSDK.dll 解析成功率
  try {
    const extra = [sdkDir, path.join(sdkDir, "build", "Release")];
    const sep = process.platform === "win32" ? ";" : ":";
    process.env.PATH = extra.join(sep) + sep + (process.env.PATH || "");
  } catch (_) {
    /* 忽略：PATH 增强失败不影响主流程，仅作为辅助 */
  }

  let turing;
  try {
    turing = require(sdkDir);
  } catch (e) {
    process.stderr.write("require turing sdk failed: " + (e && e.message ? e.message : String(e)) + "\n");
    process.stderr.write("SDK dir: " + sdkDir + "\n");
    process.exit(1);
  }

  const channelId = parseInt(process.env.WORKBUDDY_TURING_CHANNEL_ID || "109144", 10);
  const productName = process.env.WORKBUDDY_TURING_PRODUCT_NAME || "WorkBuddy";
  const productVersion = process.env.WORKBUDDY_TURING_VERSION || "2.0.0";

  function isSupported() {
    try {
      return !turing.isSupported || turing.isSupported();
    } catch (e) {
      return false;
    }
  }

  (async () => {
    if (!isSupported()) {
      const loadErr = (typeof turing.getLoadError === "function") ? turing.getLoadError() : null;
      process.stderr.write("turing sdk not supported" + (loadErr ? (": " + loadErr) : " on this platform") + "\n");
      process.stderr.write("SDK dir: " + sdkDir + "\n");
      process.exit(1);
    }
    try {
      turing.configure(channelId, productName, productVersion);
      const token = await turing.fetchDeviceToken({
        usingCachedMessage: true,
        includesOutdatedMessage: true,
        includesDeviceInfo: true,
        timeoutMs: 15000,
      });
      const t = (token || "").toString().trim();
      if (!t) {
        process.stderr.write("turing sdk returned empty token\n");
        process.stderr.write("SDK dir: " + sdkDir + "\n");
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({ token: t }));
    } catch (e) {
      process.stderr.write("fetch device token failed: " + (e && e.message ? e.message : String(e)) + "\n");
      process.stderr.write("SDK dir: " + sdkDir + "\n");
      process.exit(1);
    }
  })();
} else {
  module.exports = { looksLikeSdk, collectCandidateDirs, findSdkDir };
}
