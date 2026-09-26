/**
 * 模型计费与标签逻辑（纯函数；渲染由 ModelsPage 持有）。
 *
 * 契约（与旧 models.js 一致）：
 *  - 夜间窗口：Asia/Shanghai 23:00–08:00（UTC+8 硬编码，不依赖 Intl 时区库）；
 *  - 倍率三态：正数=真实倍率 / 0=免费 / null=未知；未知在升序与降序下一律置底；
 *  - 排序：按 id 字母 / 按倍率（未知置底，同值按 id）；
 *  - 「需授权」是虚拟标签（availability === 'unavailable'），参与筛选与计数；
 *  - craft 冗余技术标签过滤（含首尾空格）；
 *  - 徽章：已知 kind（night_free/night_discount/limited_free/exclusive）优先，
 *    上游合法 hex 色优先于内置色；
 *  - model_list_mode 说明文案（MODEL_LIST_MODE_NOTES）：刻意不承诺
 *    「选此项即可让客户端隐藏模型」。
 */

import type { ModelMetaItem } from './tauri';

export type { ModelMetaItem };

/** 夜间窗口判定（Asia/Shanghai 23:00–08:00）。 */
export function isNightWindowNow(date: Date = new Date()): boolean {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const utcHours = d.getUTCHours();
  const cstHours = (utcHours + 8) % 24;
  return cstHours >= 23 || cstHours < 8;
}

export type EffectiveRateStatus = 'normal' | 'night_free' | 'night_discount' | 'unknown';

export interface MultiplierInfo {
  base: number | null;
  effective: number | null;
  isNightFree: boolean;
  isNightDiscount: boolean;
  effectiveRateStatus: EffectiveRateStatus;
}

/** 结构化倍率与时段信息解析（区分 base 与 effective）。 */
export function getModelMultiplierInfo(m: ModelMetaItem, now: Date = new Date()): MultiplierInfo {
  if (!m || !m.credits || m.credits === '—') {
    return { base: null, effective: null, isNightFree: false, isNightDiscount: false, effectiveRateStatus: 'unknown' };
  }
  const tags = m.tags || [];
  const isNight = isNightWindowNow(now);
  const hasNightFree = tags.includes('夜间免费');
  const hasNightDiscount = tags.includes('夜间折扣');
  const match = String(m.credits).match(/(\d+(?:\.\d+)?)/);
  const base = match ? parseFloat(match[1]) : null;

  if (base === null) {
    return { base: null, effective: null, isNightFree: hasNightFree, isNightDiscount: hasNightDiscount, effectiveRateStatus: 'unknown' };
  }
  if (hasNightFree && isNight) {
    return { base, effective: 0.0, isNightFree: true, isNightDiscount: false, effectiveRateStatus: 'night_free' };
  }
  if (hasNightDiscount && isNight) {
    // 上游未下发夜间折后数值，排序沿用 baseMultiplier，UI/业务标注折扣生效
    return { base, effective: base, isNightFree: false, isNightDiscount: true, effectiveRateStatus: 'night_discount' };
  }
  return { base, effective: base, isNightFree: hasNightFree, isNightDiscount: hasNightDiscount, effectiveRateStatus: 'normal' };
}

/**
 * 倍率数值化（三态）：正数=真实倍率 / 0=免费 / null=未知。
 * 免费与未知必须分开：未知在排序时单独置底。
 */
export function getMultiplierNum(m: ModelMetaItem, now: Date = new Date()): number | null {
  if (!m || !m.credits || m.credits === '—') return null;
  const match = String(m.credits).match(/(\d+(?:\.\d+)?)/);
  const fallback = match ? parseFloat(match[1]) : null;
  const info = getModelMultiplierInfo(m, now);
  return info.effective !== null ? info.effective : fallback;
}

/** 距下一个 23:00 / 08:00（Asia/Shanghai）边界的毫秒延迟（+1s 缓冲）。 */
export function getNextWindowBoundaryDelayMs(now: Date = new Date()): number {
  const utcMs = now.getTime();
  const cur = new Date(utcMs);
  const y = cur.getUTCFullYear();
  const mo = cur.getUTCMonth();
  const d = cur.getUTCDate();
  const candidates: number[] = [];
  for (let offset = -1; offset <= 2; offset++) {
    candidates.push(Date.UTC(y, mo, d + offset, 0, 0, 0, 0)); // 08:00 CST
    candidates.push(Date.UTC(y, mo, d + offset, 15, 0, 0, 0)); // 23:00 CST
  }
  const future = candidates.filter((t) => t > utcMs).sort((a, b) => a - b);
  const next = future[0] ?? utcMs + 3600 * 1000;
  return Math.max(1000, next - utcMs + 1000);
}

/** 过滤 craft 冗余技术标签（含首尾空格），保留来源端与动态业务徽章。 */
export function cleanModelTags(tags: string[] | null | undefined): string[] {
  return (tags || []).filter((t) => t && t.toLowerCase() !== 'craft' && t.trim().toLowerCase() !== 'craft');
}

export type SortField = 'id' | 'credits' | null;
export type SortOrder = 'asc' | 'desc' | null;

/** 排序切换：模型列 id asc→desc→关；倍率列 credits desc→asc→关。 */
export function nextModelSort(field: SortField, order: SortOrder): { field: SortField; order: SortOrder } {
  if (field !== 'id') return { field: 'id', order: 'asc' };
  if (order === 'asc') return { field: 'id', order: 'desc' };
  return { field: null, order: null };
}

export function nextCreditsSort(field: SortField, order: SortOrder): { field: SortField; order: SortOrder } {
  if (field !== 'credits') return { field: 'credits', order: 'desc' };
  if (order === 'desc') return { field: 'credits', order: 'asc' };
  return { field: null, order: null };
}

/** 应用标签筛选 + 排序（纯函数）。 */
export function applyModelFilterSort(
  list: ModelMetaItem[],
  selectedTag: string,
  sortField: SortField,
  sortOrder: SortOrder,
  now: Date = new Date(),
): ModelMetaItem[] {
  let result = [...list];
  if (selectedTag !== 'ALL') {
    result = result.filter((m) => {
      if (selectedTag === '需授权') return m.availability === 'unavailable';
      return (m.tags || []).includes(selectedTag);
    });
  }
  if (sortField === 'id') {
    result.sort((a, b) => {
      const cmp = (a.id || '').localeCompare(b.id || '');
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  } else if (sortField === 'credits') {
    result.sort((a, b) => {
      const va = getMultiplierNum(a, now);
      const vb = getMultiplierNum(b, now);
      // 「倍率未知」在升序与降序下一律置底
      if (va === null && vb === null) return (a.id || '').localeCompare(b.id || '');
      if (va === null) return 1;
      if (vb === null) return -1;
      const diff = vb - va;
      if (diff !== 0) return sortOrder === 'desc' ? diff : -diff;
      return (a.id || '').localeCompare(b.id || '');
    });
  }
  return result;
}

const TAG_ORDER: Record<string, number> = { '需授权': 0, '双端': 1, 'WorkBuddy': 2, 'CodeBuddy': 3 };

/** 标签计数 + 排序（「需授权」虚拟标签优先）。 */
export function buildTagCounts(list: ModelMetaItem[]): Array<{ tag: string; count: number }> {
  const counts: Record<string, number> = {};
  const unauth = list.filter((m) => m.availability === 'unavailable').length;
  if (unauth > 0) counts['需授权'] = unauth;
  for (const m of list) {
    for (const t of m.tags || []) {
      if (t) counts[t] = (counts[t] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => {
      const oa = TAG_ORDER[a.tag] ?? 99;
      const ob = TAG_ORDER[b.tag] ?? 99;
      if (oa !== ob) return oa - ob;
      return a.tag.localeCompare(b.tag);
    });
}

export interface BadgeRender {
  text: string;
  title: string;
  style: string;
}

/**
 * 徽章渲染数据（纯函数；React 组件据此渲染 span）。
 * 优先级：已知 kind > 上游合法 hex 色 > 内置默认。
 */
export function getBadgeRender(t: string, m: ModelMetaItem, isNight: boolean): BadgeRender {
  const badgeObj = (m?.badges || []).find((b) => b.text === t);
  const color = badgeObj ? badgeObj.color : null;
  const isHex = !!color && /^#[0-9a-fA-F]{3,8}$/.test(color);
  const hexStyle = isHex
    ? `background: ${color}26; color: ${color}; border: 1px solid ${color}66; font-weight: 600;`
    : '';

  if (t === '夜间免费' || (badgeObj && badgeObj.kind === 'night_free')) {
    return {
      text: isNight ? '🌙 夜间免费中' : '🌙 夜间免费',
      title: isNight ? '当前夜间时段 (23:00–08:00) 免积分调用' : '夜间 23:00–08:00 免积分调用',
      style: isHex
        ? hexStyle
        : isNight
          ? 'background: rgba(16,185,129,0.18); color: #10b981; border: 1px solid rgba(16,185,129,0.4); font-weight: 600;'
          : 'background: rgba(59,130,246,0.12); color: #3b82f6; border: 1px solid rgba(59,130,246,0.3);',
    };
  }
  if (t === '夜间折扣' || (badgeObj && badgeObj.kind === 'night_discount')) {
    return {
      text: isNight ? '🌙 夜间折扣中' : '🌙 夜间折扣',
      title: isNight ? '当前夜间时段享受折扣倍率（实际以扣费为准）' : '夜间 23:00–08:00 享受夜间折扣',
      style: isHex
        ? hexStyle
        : isNight
          ? 'background: rgba(245,158,11,0.18); color: #f59e0b; border: 1px solid rgba(245,158,11,0.4); font-weight: 600;'
          : 'background: rgba(59,130,246,0.12); color: #3b82f6; border: 1px solid rgba(59,130,246,0.3);',
    };
  }
  if (t === '限时免费' || (badgeObj && badgeObj.kind === 'limited_free')) {
    return {
      text: `🔥 ${t}`,
      title: '全天限时免积分调用',
      style: isHex ? hexStyle : 'background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.4); font-weight: 600;',
    };
  }
  if (t === '独家优惠' || (badgeObj && badgeObj.kind === 'exclusive')) {
    return {
      text: `✨ ${t}`,
      title: '专属特惠超低倍率',
      style: isHex ? hexStyle : 'background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.4); font-weight: 600;',
    };
  }
  if (isHex) {
    return { text: t, title: `点击仅筛选 ${t} 标签模型`, style: hexStyle };
  }
  return { text: t, title: `点击仅筛选 ${t} 标签模型`, style: '' };
}

export interface MultiplierRender {
  kind: 'unknown' | 'free' | 'plain' | 'night_free' | 'night_free_idle' | 'night_discount' | 'night_discount_idle';
  text: string;
  note?: string;
  noteTitle?: string;
}

/** 倍率单元格渲染数据（纯函数）。 */
export function getMultiplierRender(m: ModelMetaItem, now: Date = new Date()): MultiplierRender {
  const raw = m?.credits;
  const tags = m?.tags || [];
  const hasNightFree = tags.includes('夜间免费');
  const hasNightDiscount = tags.includes('夜间折扣');
  const isNight = isNightWindowNow(now);

  if (!raw || raw === '—') return { kind: 'unknown', text: '—' };
  const match = String(raw).match(/(\d+(?:\.\d+)?)/);
  if (!match) return { kind: 'plain', text: String(raw) };
  const num = parseFloat(match[1]);
  const base = `${match[1]}x`;

  if (num === 0) return { kind: 'free', text: '免费 (0.00x)' };
  if (hasNightFree) {
    if (isNight) {
      return { kind: 'night_free', text: '免费 (0.00x)', note: `(🌙 限免中, 原 ${match[1]}x)`, noteTitle: '夜间限免时段 (23:00–08:00) 调用不扣积分' };
    }
    return { kind: 'night_free_idle', text: base, note: '(🌙 夜间 0.00x)', noteTitle: '夜间 23:00–08:00 期间免积分' };
  }
  if (hasNightDiscount) {
    if (isNight) {
      return { kind: 'night_discount', text: base, note: '🌙 折扣生效中', noteTitle: '当前处于夜间时段，该模型享受专属折扣' };
    }
    return { kind: 'night_discount_idle', text: base, note: '(🌙 夜间享折扣)', noteTitle: '夜间 23:00–08:00 享受夜间折扣' };
  }
  return { kind: 'plain', text: base };
}

// ---------------------------------------------------------------------------
// 模型清单模式的「客户端侧」说明：本开关只影响内核向客户端暴露的清单，
// 管不到客户端自己写死的模型表。文案刻意不写「选此项即可让客户端隐藏模型」
// 这类误导性承诺（test_model_list_mode_client_note 契约锁定）。
// ---------------------------------------------------------------------------

export const MODEL_LIST_MODE_NOTES: Record<string, string> = {
  available:
    '注意：此开关只改变内核对外提供的清单。Hermes 等客户端若在其端点配置里关闭了「Discover models」（即 discover_models: false），会改用其配置文件里写死的模型列表，此时本开关不生效 —— 需在客户端打开「Discover models」让它实时读取本清单（改后需重启客户端）。',
  all: '提示：选「全部展示」时需授权模型会带 🔒 标记一并下发，供客户端自行选择是否隐藏。',
};

export function modelListModeNote(mode: string): string {
  return MODEL_LIST_MODE_NOTES[mode] || MODEL_LIST_MODE_NOTES.all;
}
