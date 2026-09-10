import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(rootDir, relative), 'utf8');

test('Hermes Agent 页面只保留只读手动接入引导', () => {
  const html = read('index.html');
  const js = read('src/agents.js');

  assert.equal(html.includes('id="btn-config-hermes"'), false);
  assert.equal(html.includes('id="btn-remove-hermes"'), false);
  assert.equal(html.includes('id="btn-guide-hermes"'), true);
  assert.equal(html.includes('id="hermes-guide"'), true);
  assert.equal(js.includes("agent_configure', { agent_type: 'hermes'"), false);
  assert.equal(js.includes("agent_remove', { agent_type: 'hermes'"), false);
  assert.equal(js.includes("hermes_endpoint_guide"), true);
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
