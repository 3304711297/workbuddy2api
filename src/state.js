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
  healthTimer: null, // 健康轮询句柄（main.js 持有，窗口隐藏时停表）
  oauthTimer: null,
  accountsList: [],
  apiKey: '', // 当前生效的 API Key（空串表示未启用鉴权，前端示例回退为 local）
  models: [
    { id: 'glm-5.3-flash', target: 'glm-5.3-flash', ctx: '1,048,576 (1M)', tags: ['双端'] },
    { id: 'glm-5.3', target: 'glm-5.3', ctx: '1,048,576 (1M)', tags: ['双端'] },
    { id: 'glm-5.2', target: 'glm-5.2', ctx: '1,048,576 (1M)', tags: ['双端'] },
    { id: 'glm-5v-turbo', target: 'glm-5v-turbo', ctx: '1,048,576 (1M)', tags: ['双端'] },
    { id: 'kimi-k3', target: 'kimi-k3', ctx: '200,000 (200K)', tags: ['双端'] },
    { id: 'kimi-k2.7', target: 'kimi-k2.7', ctx: '200,000 (200K)', tags: ['双端'] },
    { id: 'deepseek-v4-pro', target: 'deepseek-v4-pro', ctx: '200,000 (200K)', tags: ['双端'] },
    { id: 'deepseek-v4-flash', target: 'deepseek-v4-flash', ctx: '200,000 (200K)', tags: ['双端'] },
    { id: 'hy4-preview', target: 'hy4-preview', ctx: '200,000 (200K)', tags: ['双端'] },
    { id: 'auto', target: 'auto', ctx: '1,048,576 (1M)', tags: ['双端'] },
  ]
};
