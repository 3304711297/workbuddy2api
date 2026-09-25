/**
 * Agent 接入引导（纯逻辑；渲染由 AgentsPage 持有）。
 *
 * 契约（与旧 agents.js 一致）：
 *  - 只读引导：agent_detect 读 hermes_proxy_base_url（snake_case）；
 *    Hermes 仅手动引导，绝不自动改配置；
 *  - guide 下发的 api_key 固定为 'local' 占位：前端若已配置真实密钥则覆盖展示；
 *  - yaml_snippet 内的 api_key: 'local' / "local" 同步替换为有效密钥；
 *  - ZCode 步骤编号前缀（`1. `）在渲染时剥掉（有序列表自带编号）；
 *  - 点击字段/芯片复制：由页面走 copyToClipboard，失败报错。
 */

import { agentDetect, hermesEndpointGuide, zcodeGuide, zcodeRemove, type AgentStatus } from './tauri';

export type { AgentStatus };

/** 有效密钥：已配置的取配置值，否则 'local' 占位。 */
export function effectiveApiKey(configuredKey: string): string {
  return configuredKey.trim() || 'local';
}

/**
 * Hermes guide 的密钥动态化：Rust 端固定返回 local，
 * 前端若已配置真实密钥则覆盖展示（含 yaml_snippet 内替换）。
 */
export function resolveHermesGuideKey(
  guideApiKey: string | null | undefined,
  configuredKey: string,
): string {
  const effective = effectiveApiKey(configuredKey);
  if (!guideApiKey || guideApiKey === 'local') return effective;
  return guideApiKey;
}

/** 把 guide.yaml_snippet 里的 local 占位替换为有效密钥（纯函数）。 */
export function substituteGuideApiKey(snippet: string, effectiveKey: string): string {
  return snippet
    .replace(/api_key:\s*['"]?local['"]?/gi, `api_key: '${effectiveKey}'`)
    .replace(/"local"/g, effectiveKey === 'local' ? '"local"' : `"${effectiveKey}"`);
}

/** ZCode 步骤：剥掉行首数字编号（有序列表自带编号）。 */
export function cleanZcodeStep(step: string): string {
  return step.replace(/^\d+\.\s*/, '');
}

export async function detectAgents(port: number): Promise<AgentStatus> {
  return agentDetect(port);
}

export const fetchHermesGuide = hermesEndpointGuide;
export const fetchZcodeGuide = zcodeGuide;
export const cleanupZcode = zcodeRemove;

export type HermesBadgeState = 'not-installed' | 'configured' | 'unconfigured';
export type ZcodeBadgeState = 'not-installed' | 'online' | 'offline-residue' | 'offline';

export function hermesBadgeState(res: AgentStatus): HermesBadgeState {
  if (!res.hermes_installed) return 'not-installed';
  return res.hermes_configured ? 'configured' : 'unconfigured';
}

export function zcodeBadgeState(res: AgentStatus): ZcodeBadgeState {
  if (!res.zcode_installed) return 'not-installed';
  if (res.zcode_service_online) return 'online';
  return res.zcode_provider_registered ? 'offline-residue' : 'offline';
}
