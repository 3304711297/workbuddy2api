/**
 * Agent 接入引导 (Hermes / ZCode)
 */

import { state } from './state.js';
import { esc, showToast, copyToClipboard, invokeTauri } from './utils.js';

export async function loadAgentsStatus() {
  const hBadge = document.getElementById('hermes-status-badge');
  const zBadge = document.getElementById('zcode-status-badge');
  const hPath = document.getElementById('hermes-path');
  const hProxy = document.getElementById('hermes-proxy-url');
  const zPath = document.getElementById('zcode-path');

  try {
    const res = await invokeTauri('agent_detect', { port: state.port });

    // Hermes 状态（DOM 节点缺失时不得硬崩：直接对 getElementById 结果解引用，
    // 一旦 id 被改名/删除，`hPath.textContent` 会抛 TypeError 打断整个面板刷新）
    if (hPath) hPath.textContent = res.hermes_config_path || '未找到';
    // 接入点：显示配置里实际命中的反代地址（未接入时给出明确提示）。
    // 这条能让用户一眼看出「配置里到底认到了哪个地址」，避免出现
    // 「我明明配了却显示未配置/指向别处」时无从判断。
    if (hProxy) {
      hProxy.textContent = res.hermes_proxy_base_url || (res.hermes_configured ? '已接入（地址未解析）' : '未检测到本工具地址');
    }
    if (hBadge) {
      if (!res.hermes_installed) {
        hBadge.className = 'badge badge-stopped';
        hBadge.textContent = '未安装';
      } else if (res.hermes_configured) {
        hBadge.className = 'badge badge-valid';
        hBadge.textContent = '已接入配置';
      } else {
        hBadge.className = 'badge badge-info';
        hBadge.textContent = '未配置';
      }
    }

    // ZCode 状态：徽章反映服务真实可达性（Desktop 只认 UI 内添加，文件写入不生效）
    if (zPath) zPath.textContent = res.zcode_cli_path || '未找到';
    if (zBadge) {
      if (!res.zcode_installed) {
        zBadge.className = 'badge badge-stopped';
        zBadge.textContent = '未安装';
      } else if (res.zcode_service_online) {
        zBadge.className = 'badge badge-valid';
        zBadge.textContent = '服务在线 · 可接入';
      } else if (res.zcode_provider_registered) {
        zBadge.className = 'badge badge-info';
        zBadge.textContent = '服务离线（文件残留）';
      } else {
        zBadge.className = 'badge badge-info';
        zBadge.textContent = '服务离线';
      }
    }
  } catch (e) {
    console.error('Agent 检测失败:', e);
    showToast(`Agent 检测失败: ${e.message || e}`, 'error');
    if (hBadge) hBadge.textContent = '检测失败';
    if (zBadge) zBadge.textContent = '检测失败';
  }
}

function renderHermesGuide(guide) {
  const wrap = document.getElementById('hermes-guide');
  if (!wrap) return;
  const field = (label, value) => `
    <div class="zguide-field">
      <span class="zguide-label">${esc(label)}</span>
      <span class="zguide-value" data-copy="${esc(value)}" title="点击复制">${esc(value)}</span>
    </div>`;
  wrap.innerHTML = `
    <div class="zcode-guide-panel">
      ${field('配置文件路径', guide.config_path)}
      ${field('目标 Base URL', guide.target_base_url)}
      ${field('目标 API Key', guide.target_api_key)}
      ${field('目标模型（default）', guide.target_model)}
      <div class="zguide-field">
        <span class="zguide-label">YAML 配置片段（点击复制）</span>
        <pre class="zguide-value" data-copy="${esc(guide.yaml_snippet)}" title="点击复制 YAML 片段" style="white-space: pre-wrap; font-size: 11.5px; margin: 0;">${esc(guide.yaml_snippet)}</pre>
      </div>
      <ol class="zguide-steps">${guide.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    </div>`;
  wrap.hidden = false;
}

function renderZcodeGuide(guide) {
  const wrap = document.getElementById('zcode-guide');
  if (!wrap) return;
  const field = (label, value) => `
    <div class="zguide-field">
      <span class="zguide-label">${esc(label)}</span>
      <span class="zguide-value" data-copy="${esc(value)}" title="点击复制">${esc(value)}</span>
    </div>`;
  const chips = guide.models
    .map((m) => `<span class="zguide-chip" data-copy="${esc(m)}" title="点击复制模型名">${esc(m)}</span>`)
    .join('');
  const allModels = `<span class="zguide-chip" data-copy="${esc(guide.models.join(', '))}" title="点击复制全部模型名">复制全部模型</span>`;
  wrap.innerHTML = `
    <div class="zcode-guide-panel">
      ${field('Base URL（接口地址）', guide.base_url)}
      ${field('API 格式（下拉选择）', guide.api_format)}
      ${field('API Key（密钥）', guide.api_key)}
      <div class="zguide-field">
        <span class="zguide-label">模型列表（点击芯片复制模型名）</span>
        <div class="zguide-chips">${allModels}${chips}</div>
      </div>
      <ol class="zguide-steps">${guide.steps.map((s) => `<li>${esc(s.replace(/^\d+\.\s*/, ''))}</li>`).join('')}</ol>
    </div>`;
  wrap.hidden = false;
}

function renderClaudeGuide(port) {
  const wrap = document.getElementById('claude-guide');
  if (!wrap) return;
  const baseUrl = `http://127.0.0.1:${port || 8787}`;
  const bashCmd = `export ANTHROPIC_BASE_URL="${baseUrl}"\nexport ANTHROPIC_API_KEY="local"\nclaude --model deepseek-v4.1-flash`;
  const psCmd = `$env:ANTHROPIC_BASE_URL="${baseUrl}"; $env:ANTHROPIC_API_KEY="local"; claude --model deepseek-v4.1-flash`;

  const field = (label, value) => `
    <div class="zguide-field">
      <span class="zguide-label">${esc(label)}</span>
      <span class="zguide-value" data-copy="${esc(value)}" title="点击复制">${esc(value)}</span>
    </div>`;

  wrap.innerHTML = `
    <div class="zcode-guide-panel" style="margin-top: 10px;">
      ${field('Base URL（ANTHROPIC_BASE_URL）', baseUrl)}
      ${field('API Key（ANTHROPIC_API_KEY）', 'local')}
      ${field('原生端点路径', `${baseUrl}/v1/messages`)}
      ${field('推荐模型', 'deepseek-v4.1-flash')}
      <div class="zguide-field">
        <div class="snippet-tab-header">
          <span class="zguide-label">终端直连命令（点击复制）</span>
          <div class="snippet-tab-pills">
            <button type="button" class="snippet-pill active" data-tab="bash">Bash</button>
            <button type="button" class="snippet-pill" data-tab="ps">PowerShell</button>
          </div>
        </div>
        <div class="snippet-panes">
          <pre class="zguide-value snippet-pane" data-pane="bash" data-copy="${esc(bashCmd)}" title="点击复制" style="white-space: pre-wrap; font-size: 11px; margin: 0;">${esc(bashCmd)}</pre>
          <pre class="zguide-value snippet-pane hidden" data-pane="ps" data-copy="${esc(psCmd)}" title="点击复制" style="white-space: pre-wrap; font-size: 11px; margin: 0;">${esc(psCmd)}</pre>
        </div>
      </div>
      <ol class="zguide-steps">
        <li>内核已内置 Anthropic Messages API，兼容 Claude Code CLI 等工具</li>
        <li>在终端运行上述命令设置环境变量后，直接执行 <code>claude</code> 即可直连</li>
        <li>已内建两层指纹脱敏，杜绝上游 11128 风控误拦截</li>
      </ol>
    </div>`;
  wrap.hidden = false;
}

// Codex CLI 接入引导：Responses 协议 + config.toml 配置
function renderCodexGuide(port) {
  const wrap = document.getElementById('codex-guide');
  if (!wrap) return;
  const baseUrl = `http://127.0.0.1:${port || 8787}/v1`;
  const tomlSnippet = [
    '# ~/.codex/config.toml',
    'model = "deepseek-v4.1-flash"',
    'model_provider = "workbuddy"',
    '',
    '[model_providers.workbuddy]',
    `base_url = "${baseUrl}"`,
    'env_key = "WORKBUDDY_API_KEY"',
    'wire_api = "responses"',
  ].join('\n');
  const bashCmd = `export WORKBUDDY_API_KEY="local"\ncodex`;
  const psCmd = `$env:WORKBUDDY_API_KEY="local"; codex`;

  const field = (label, value) => `
    <div class="zguide-field">
      <span class="zguide-label">${esc(label)}</span>
      <span class="zguide-value" data-copy="${esc(value)}" title="点击复制">${esc(value)}</span>
    </div>`;

  wrap.innerHTML = `
    <div class="zcode-guide-panel" style="margin-top: 10px;">
      ${field('Responses 端点路径', `${baseUrl}/responses`)}
      ${field('API Key 环境变量名', 'WORKBUDDY_API_KEY')}
      ${field('API Key 值（本地固定）', 'local')}
      ${field('推荐模型', 'deepseek-v4.1-flash')}
      <div class="zguide-field">
        <div class="snippet-tab-header">
          <span class="zguide-label">配置与命令（点击复制）</span>
          <div class="snippet-tab-pills">
            <button type="button" class="snippet-pill active" data-tab="toml">config.toml</button>
            <button type="button" class="snippet-pill" data-tab="bash">Bash</button>
            <button type="button" class="snippet-pill" data-tab="ps">PowerShell</button>
          </div>
        </div>
        <div class="snippet-panes">
          <pre class="zguide-value snippet-pane" data-pane="toml" data-copy="${esc(tomlSnippet)}" title="点击复制" style="white-space: pre-wrap; font-size: 11px; margin: 0;">${esc(tomlSnippet)}</pre>
          <pre class="zguide-value snippet-pane hidden" data-pane="bash" data-copy="${esc(bashCmd)}" title="点击复制" style="white-space: pre-wrap; font-size: 11px; margin: 0;">${esc(bashCmd)}</pre>
          <pre class="zguide-value snippet-pane hidden" data-pane="ps" data-copy="${esc(psCmd)}" title="点击复制" style="white-space: pre-wrap; font-size: 11px; margin: 0;">${esc(psCmd)}</pre>
        </div>
      </div>
      <ol class="zguide-steps">
        <li>内核已内置 OpenAI Responses API（<code>POST /v1/responses</code>），兼容 Codex CLI 等 Responses 协议客户端</li>
        <li>关键项是 <code>wire_api = "responses"</code>：Codex CLI 默认走 Responses 协议而非 chat/completions</li>
        <li>SSE 事件完整携带 <code>sequence_number</code> / <code>response_id</code> / <code>item_id</code> 规范字段</li>
        <li>若需压缩超长上下文（有损），可设置 <code>WORKBUDDY2API_OPTIMIZE_CONTEXT=1</code> 并重启内核</li>
      </ol>
    </div>`;
  wrap.hidden = false;
}

export function initAgentActions() {
  document.getElementById('btn-guide-hermes')?.addEventListener('click', async () => {
    try {
      const guide = await invokeTauri('hermes_endpoint_guide', { port: state.port });
      renderHermesGuide(guide);
    } catch (e) {
      showToast(`获取 Hermes 接入引导失败: ${e.message || e}`, 'error');
    }
  });

  // 引导面板内的值/芯片点击即复制（事件委托）
  document.getElementById('hermes-guide')?.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-copy]');
    if (!el) return;
    const ok = await copyToClipboard(el.dataset.copy);
    el.classList.add('copied');
    showToast(ok ? '已复制' : '复制失败，请手动选择文本复制', ok ? 'success' : 'error');
    setTimeout(() => el.classList.remove('copied'), 1500);
  });

  document.getElementById('btn-config-zcode')?.addEventListener('click', async () => {
    try {
      const raw = await invokeTauri('zcode_guide', { port: state.port });
      renderZcodeGuide(JSON.parse(raw));
    } catch (e) {
      showToast(`生成接入配置失败: ${e.message || e}`, 'error');
    }
  });

  document.getElementById('zcode-guide')?.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-copy]');
    if (!el) return;
    const ok = await copyToClipboard(el.dataset.copy);
    el.classList.add('copied');
    showToast(ok ? '已复制' : '复制失败，请手动选择文本复制', ok ? 'success' : 'error');
    setTimeout(() => el.classList.remove('copied'), 1500);
  });

  document.getElementById('btn-remove-zcode')?.addEventListener('click', async () => {
    try {
      const res = await invokeTauri('zcode_remove');
      showToast(res, 'info');
      loadAgentsStatus();
    } catch (e) {
      showToast(`清理失败: ${e.message || e}`, 'error');
    }
  });

  document.getElementById('btn-guide-claude')?.addEventListener('click', () => {
    renderClaudeGuide(state.port);
  });

  document.getElementById('claude-guide')?.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-copy]');
    if (!el) return;
    const ok = await copyToClipboard(el.dataset.copy);
    el.classList.add('copied');
    showToast(ok ? '已复制' : '复制失败，请手动选择文本复制', ok ? 'success' : 'error');
    setTimeout(() => el.classList.remove('copied'), 1500);
  });

  // Codex CLI 引导
  document.getElementById('btn-guide-codex')?.addEventListener('click', () => {
    renderCodexGuide(state.port);
  });

  document.getElementById('codex-guide')?.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-copy]');
    if (!el) return;
    const ok = await copyToClipboard(el.dataset.copy);
    el.classList.add('copied');
    showToast(ok ? '已复制' : '复制失败，请手动选择文本复制', ok ? 'success' : 'error');
    setTimeout(() => el.classList.remove('copied'), 1500);
  });

  // 代码片段分段切换 Tab（点击切换 Bash / PowerShell / config.toml，对标 EasyCLIProxyAPI）
  document.addEventListener('click', (ev) => {
    const pill = ev.target.closest('.snippet-pill');
    if (!pill) return;
    const header = pill.closest('.snippet-tab-header');
    const field = header?.closest('.zguide-field');
    if (!field) return;

    const tab = pill.dataset.tab;
    header.querySelectorAll('.snippet-pill').forEach((p) => p.classList.toggle('active', p === pill));
    field.querySelectorAll('.snippet-pane').forEach((pane) => {
      pane.classList.toggle('hidden', pane.dataset.pane !== tab);
    });
  });

  document.getElementById('btn-refresh-agents')?.addEventListener('click', loadAgentsStatus);
}
