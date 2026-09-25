/**
 * i18n 基础设施：zh-CN（默认）| zh-TW（运行时由简转繁）| en。
 * - 语言持久化：localStorage `workbuddy2api.lang`；
 * - 插值：`{name}` 占位符；
 * - zh-TW 由 zh-CN 经 toTraditional() 转换，词典只维护两套（zh-CN / en），
 *   键集合一致性由 tests/test_i18n_parity.test.js 锁定。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { zhCN } from './zh-CN';
import { en } from './en';
import { toTraditional } from './traditional';

export type Lang = 'zh-CN' | 'zh-TW' | 'en';
export const LANG_STORAGE_KEY = 'workbuddy2api.lang';
export const LANGS: Array<{ id: Lang; label: string }> = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'zh-TW', label: '繁體中文' },
  { id: 'en', label: 'English' },
];

type Dict = Record<string, string>;

const DICTS: Record<'zh-CN' | 'en', Dict> = { 'zh-CN': zhCN, en };

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === 'zh-CN' || saved === 'zh-TW' || saved === 'en') return saved;
  } catch { /* 忽略 */ }
  return 'zh-CN';
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`,
  );
}

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function resolveDict(lang: Lang): Dict {
  if (lang === 'en') return DICTS.en;
  if (lang === 'zh-TW') {
    const out: Dict = {};
    for (const [k, v] of Object.entries(DICTS['zh-CN'])) out[k] = toTraditional(v);
    return out;
  }
  return DICTS['zh-CN'];
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, l);
    } catch { /* 忽略 */ }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const dict = useMemo(() => resolveDict(lang), [lang]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const template = dict[key] ?? DICTS['zh-CN'][key] ?? key;
      return interpolate(template, params);
    },
    [dict],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n 必须在 <I18nProvider> 内使用');
  return ctx;
}
