/**
 * 共享全局状态（单一可变对象）
 * 各模块通过 `import { state } from './state.js'` 读写同一引用，禁止复制值
 */

// 状态管理
export const state = {
  currentTab: 'dashboard',
  port: 8787,
  desensitize: true,
  running: false,
  healthTimer: null,
  oauthTimer: null,
  activeAccount: null,
  accountsList: [],
  models: [
    { id: 'glm-5.3-flash', target: 'glm-5.3-flash', ctx: '1,048,576 (1M)', tags: ['主力', '超长上下文', '快速'] },
    { id: 'glm-5.3', target: 'glm-5.3', ctx: '1,048,576 (1M)', tags: ['深度推理', '高智商'] },
    { id: 'glm-5.2', target: 'glm-5.2', ctx: '1,048,576 (1M)', tags: ['稳定'] },
    { id: 'glm-5v-turbo', target: 'glm-5v-turbo', ctx: '1,048,576 (1M)', tags: ['多模态视觉'] },
    { id: 'kimi-k3', target: 'kimi-k3', ctx: '200,000 (200K)', tags: ['长文本', '超强检索'] },
    { id: 'kimi-k2.7', target: 'kimi-k2.7', ctx: '200,000 (200K)', tags: ['通用'] },
    { id: 'deepseek-v4-pro', target: 'deepseek-v4-pro', ctx: '200,000 (200K)', tags: ['代码专家', '强推理'] },
    { id: 'deepseek-v4-flash', target: 'deepseek-v4-flash', ctx: '200,000 (200K)', tags: ['极速响应'] },
    { id: 'hy4-preview', target: 'hy4-preview', ctx: '200,000 (200K)', tags: ['混元最新代'] },
    { id: 'auto', target: 'auto', ctx: '1,048,576 (1M)', tags: ['智能自动路由'] },
  ]
};
