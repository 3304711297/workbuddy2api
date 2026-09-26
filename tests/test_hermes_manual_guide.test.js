/**
 * Hermes 只读手动接入引导契约测试（React+TS 迁移版）。
 *
 * 背景：Hermes 绝不自动改写用户配置 —— 页面只保留「如何手动接入」引导按钮，
 * 一键写入（agent_configure / agent_remove）早已从 Tauri 注册表移除。
 *
 * 契约变更说明（中文）：
 *   旧前端断言目标是 index.html 的 btn-guide-hermes / hermes-guide id 与
 *   src/agents.js（无 agent_configure/agent_remove 调用、有 hermes_endpoint_guide）。
 *   React 迁移后无任何元素 id：引导按钮为 t('agents.hermesGuideBtn')（如何手动接入）
 *   → loadHermesGuide → fetchHermesGuide → tauri.ts 的 hermes_endpoint_guide 调用。
 *   新对等断言：AgentsPage.tsx / agentsService.ts / tauri.ts 中不得出现任何
 *   hermes 域的一键配置/删除调用；hermes_endpoint_guide 调用链必须完整。
 *   （zcodeRemove 是 ZCode 离线残留清理入口，属另一域，不在此约束内。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(rootDir, relative), 'utf8');

test('Hermes Agent 页面只保留只读手动接入引导（React 版：无配置/删除按钮）', () => {
  const tsx = read('src/pages/AgentsPage.tsx');
  const service = read('src/services/agentsService.ts');
  const tauri = read('src/services/tauri.ts');

  // 引导按钮存在：文案「如何手动接入」，点击走 loadHermesGuide
  assert.ok(tsx.includes("t('agents.hermesGuideBtn')"), '缺少手动接入引导按钮');
  assert.ok(tsx.includes('loadHermesGuide'), '引导按钮未接 loadHermesGuide');
  assert.ok(
    /'agents\.hermesGuideBtn': '如何手动接入'/.test(read('src/i18n/zh-CN.ts')),
    'i18n 缺少 agents.hermesGuideBtn = 如何手动接入'
  );

  // 一键写入/删除调用必须不存在（hermes 域）。
  // 注意：hermes_configured 是 Rust 返回的合法状态字段（snake_case），
  // 不得用裸子串 'hermes_configure' 误杀它 —— 只检查命令字符串 / 函数名形态。
  const banned = [
    "'agent_configure'", '"agent_configure"',
    "'agent_remove'", '"agent_remove"',
    "'hermes_configure'", '"hermes_configure"',
    'hermesConfigure',
    "agent_type: 'hermes'",
  ];
  for (const [name, content] of [['AgentsPage.tsx', tsx], ['agentsService.ts', service], ['tauri.ts', tauri]]) {
    for (const token of banned) {
      assert.ok(!content.includes(token), `${name} 不得出现 ${token}（hermes 域一键操作）`);
    }
  }

  // 引导数据走 hermes_endpoint_guide 只读命令
  assert.ok(
    service.includes('hermesEndpointGuide'),
    'agentsService.ts 未导出 fetchHermesGuide（hermesEndpointGuide）'
  );
  assert.ok(
    tauri.includes("'hermes_endpoint_guide'"),
    'tauri.ts 未调用 hermes_endpoint_guide 命令'
  );
});

test('Hermes 一键写入命令已从 Tauri 注册表移除', () => {
  const lib = read('src-tauri/src/lib.rs');
  const agents = read('src-tauri/src/commands/agents.rs');

  assert.equal(lib.includes('commands::agent_configure'), false);
  assert.equal(lib.includes('commands::agent_remove'), false);
  assert.equal(lib.includes('commands::hermes_endpoint_guide'), true);
  assert.equal(agents.includes('patch_hermes_config_content'), false);
  assert.equal(agents.includes('update_provider_models_cache'), false);
});
