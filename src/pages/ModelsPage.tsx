/**
 * 模型全量矩阵与参数定制（React 迁移版，对应旧 models.js）。
 *
 * 契约（来自仓库 AGENTS.md「模型页 UI 两条契约」）：
 *  - 模型 id 必须渲染为原生 <button class="model-id-copy" data-copy-model="<id>">，
 *    点击复制调用名，走 copyToClipboard，失败时 toast 报错（不得谎报成功）；
 *  - 标题下不得加功能宣传式副标题；
 *  - 「默认」思考档 = 透传，不写 reasoning_effort 键，UI 不得暗示具体档位。
 *
 * 渲染与计算分离：排序/筛选/倍率/徽章纯函数来自 ../services/modelBilling，
 * 模型元数据来自 ../services/tauri；本文件只做组合与事件接线。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import {
  getAppSettings,
  modelSaveConfig,
  modelsFetchAll,
  type ModelMetaItem,
} from '../services/tauri';
import { normalizeModelListMode } from '../services/settingsService';
import {
  applyModelFilterSort,
  buildTagCounts,
  cleanModelTags,
  getBadgeRender,
  getMultiplierRender,
  getNextWindowBoundaryDelayMs,
  isNightWindowNow,
  modelListModeNote,
  nextCreditsSort,
  nextModelSort,
  type SortField,
  type SortOrder,
} from '../services/modelBilling';
import { copyToClipboard } from '../services/clipboard';
import { useToast } from '../services/toast';
import { useI18n } from '../i18n';

type AvailabilityFilter = 'all' | 'available' | 'unavailable';

/** 键盘激活（Enter/Space 等同点击；Space 需 preventDefault 防页面滚动）。 */
function activateOnKey(fn: () => void) {
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    fn();
  };
}

/** 把 modelBilling 返回的内联样式字符串解析成 React style 对象（避免 innerHTML）。 */
function parseInlineStyle(style: string): CSSProperties {
  const out: Record<string, string> = {};
  for (const part of style.split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const prop = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!prop || !val) continue;
    out[prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = val;
  }
  return out as CSSProperties;
}

/** 倍率单元格（倍率三态：正常 / 夜间免费 / 夜间折扣；未知显示"—"）。 */
function MultiplierCell({ model }: { model: ModelMetaItem }) {
  const r = getMultiplierRender(model);
  const freeBadge = (
    <span
      className="badge badge-valid"
      style={{ background: 'var(--success-subtle)', color: 'var(--success-bright)', fontWeight: 700 }}
    >
      {r.text}
    </span>
  );
  const plainBadge = (
    <span className="badge badge-info mono" style={{ fontWeight: 600 }}>
      {r.text}
    </span>
  );
  switch (r.kind) {
    case 'unknown':
      return <span className="muted">—</span>;
    case 'free':
      return freeBadge;
    case 'night_free':
      return (
        <>
          {freeBadge}
          <span className="muted" style={{ fontSize: 10, marginLeft: 3 }} title={r.noteTitle}>
            {r.note}
          </span>
        </>
      );
    case 'night_free_idle':
    case 'night_discount_idle':
      return (
        <>
          {plainBadge}
          <span className="muted" style={{ fontSize: 10, marginLeft: 3 }} title={r.noteTitle}>
            {r.note}
          </span>
        </>
      );
    case 'night_discount':
      return (
        <>
          {plainBadge}
          <span
            className="badge badge-warn"
            style={{ fontSize: 10, marginLeft: 3, fontWeight: 600 }}
            title={r.noteTitle}
          >
            {r.note}
          </span>
        </>
      );
    case 'plain':
    default:
      return plainBadge;
  }
}

export function ModelsPage() {
  const { showToast } = useToast();
  const { t } = useI18n();

  /** 虚拟标签「需授权」是内部筛选键（modelBilling.ts），展示时走 i18n。 */
  const displayTag = (tag: string) => (tag === '需授权' ? t('models.unauthBadge') : tag);

  const [models, setModels] = useState<ModelMetaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0); // 夜间窗口边界 / 可见性唤醒时强制重渲染
  const [query, setQuery] = useState('');
  const [availability, setAvailability] = useState<AvailabilityFilter>('all');
  const [tagFilter, setTagFilter] = useState('ALL');
  const [sortField, setSortField] = useState<SortField>(null);
  const [sortOrder, setSortOrder] = useState<SortOrder>(null);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [listMode, setListMode] = useState('all');
  const [editing, setEditing] = useState<ModelMetaItem | null>(null);
  const [effortValue, setEffortValue] = useState('default');

  const tagThRef = useRef<HTMLTableCellElement>(null);
  const tagBtnRef = useRef<HTMLDivElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);

  /** 拉取全量模型矩阵；showResultToast=true 时（手动刷新）按真实结果提示。 */
  const load = useCallback(
    async (showResultToast: boolean) => {
      setLoading(true);
      try {
        const list = await modelsFetchAll();
        // 过滤 craft 冗余技术标签（含首尾空格），保留来源端与动态业务徽章
        setModels((list || []).map((m) => ({ ...m, tags: cleanModelTags(m.tags) })));
        if (showResultToast) showToast(t('models.syncSuccess'), 'success');
      } catch (e) {
        showToast(
          t('models.fetchFailed', { error: e instanceof Error ? e.message : String(e) }),
          'error',
        );
      } finally {
        setLoading(false);
      }
    },
    [showToast, t],
  );

  // 挂载拉取 + 读取 model_list_mode（用于筛选区附近的说明文案）
  useEffect(() => {
    void load(false);
    getAppSettings()
      .then((cfg) => setListMode(normalizeModelListMode(cfg.model_list_mode)))
      .catch(() => {});
  }, [load]);

  // 夜间窗口边界自动重渲染 + 可见性/焦点唤醒重渲染（旧 models.js scheduleNextWindowRefresh 语义）
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setTick((v) => v + 1);
        schedule();
      }, getNextWindowBoundaryDelayMs());
    };
    schedule();
    const refresh = () => setTick((v) => v + 1);
    const onVisibility = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', refresh);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const visibleModels = useMemo(() => {
    const now = new Date();
    const q = query.trim().toLowerCase();
    let list = models;
    if (q) {
      list = list.filter(
        (m) =>
          (m.id || '').toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q),
      );
    }
    if (availability === 'available') {
      list = list.filter((m) => m.availability !== 'unavailable');
    } else if (availability === 'unavailable') {
      list = list.filter((m) => m.availability === 'unavailable');
    }
    return applyModelFilterSort(list, tagFilter, sortField, sortOrder, now);
    // tick 强制夜间窗口边界重渲染（倍率/徽章随窗口变化）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, query, availability, tagFilter, sortField, sortOrder, tick]);

  const tagCounts = useMemo(() => buildTagCounts(models), [models]);

  // 标签筛选下拉：视口级 fixed 定位（S6：触发按钮在 overflow-x 容器内，绝对定位会被裁剪）
  const positionTagMenu = useCallback(() => {
    const menu = tagMenuRef.current;
    const trigger = tagBtnRef.current;
    if (!menu || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // 触发按钮已滚出视口：直接收起，避免菜单跑到屏幕外「看不见也点不着」
    if (rect.bottom < 8 || rect.top > vh - 8) {
      setTagMenuOpen(false);
      return;
    }
    menu.style.position = 'fixed';
    menu.style.right = 'auto';
    menu.style.marginTop = '0';
    const menuWidth = menu.offsetWidth || 160;
    const menuHeight = menu.offsetHeight || 240;
    const left = Math.max(8, Math.min(rect.right - menuWidth, vw - menuWidth - 8));
    const below = rect.bottom + 4;
    const above = rect.top - menuHeight - 4;
    let top = below + menuHeight > vh - 8 && above >= 8 ? above : below;
    top = Math.max(8, Math.min(top, vh - menuHeight - 8));
    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
  }, []);

  useEffect(() => {
    if (!tagMenuOpen) return;
    positionTagMenu();
    const onDocClick = (e: MouseEvent) => {
      if (tagThRef.current && !tagThRef.current.contains(e.target as Node)) {
        setTagMenuOpen(false);
      }
    };
    const onReposition = () => positionTagMenu();
    document.addEventListener('click', onDocClick);
    window.addEventListener('resize', onReposition);
    const contentBody = document.querySelector('.content-body');
    contentBody?.addEventListener('scroll', onReposition);
    return () => {
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('resize', onReposition);
      contentBody?.removeEventListener('scroll', onReposition);
    };
  }, [tagMenuOpen, positionTagMenu]);

  const setTagFilterAndClose = useCallback((tag: string) => {
    setTagFilter(tag);
    setTagMenuOpen(false);
  }, []);

  /** 标签筛选触发：已选中时点击 ✕ 直接清空，否则展开/收起菜单（旧语义）。 */
  const handleTagToggle = () => {
    if (tagFilter !== 'ALL') {
      setTagFilterAndClose('ALL');
      return;
    }
    setTagMenuOpen((v) => !v);
  };

  const handleCopyModelId = useCallback(
    async (modelId: string) => {
      if (!modelId) return;
      const ok = await copyToClipboard(modelId);
      // 剪贴板写入被拒时不得报「已复制」——按真实结果提示
      showToast(ok ? t('models.copied', { id: modelId }) : t('models.copyFailed'), ok ? 'success' : 'error');
    },
    [showToast, t],
  );

  const openEdit = (m: ModelMetaItem) => {
    setEditing(m);
    setEffortValue(m.custom_reasoning_effort || 'default');
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      // 「默认」= 透传：传 null，不写 reasoning_effort 键
      const res = await modelSaveConfig(editing.id, effortValue === 'default' ? null : effortValue);
      showToast(res, 'success');
      setEditing(null);
      await load(false);
    } catch (e) {
      showToast(
        t('models.saveFailed', { error: e instanceof Error ? e.message : String(e) }),
        'error',
      );
    }
  };

  // 编辑弹窗：Escape 关闭
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditing(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing]);

  const now = new Date();
  const isNight = isNightWindowNow(now);

  const sortModelIcon =
    sortField === 'id' ? (sortOrder === 'asc' ? t('models.sortIdAsc') : t('models.sortIdDesc')) : '↕';
  const sortCreditsIcon =
    sortField === 'credits'
      ? sortOrder === 'desc'
        ? t('models.sortCreditsDesc')
        : t('models.sortCreditsAsc')
      : '↕';

  const effortSourceHint =
    editing?.efforts_source === 'catalog'
      ? t('models.effortSourceCatalog')
      : editing?.efforts_source === 'merged'
        ? t('models.effortSourceMerged')
        : '';

  const renderRow = (m: ModelMetaItem) => {
    // 思考强度行内只读展示；「默认」= 不覆盖，原样透传客户端下发的值（不得渲染成具体档位）
    const effortText = !m.supports_reasoning
      ? ''
      : m.custom_reasoning_effort === 'disable'
        ? t('models.effortTextDisabled')
        : m.custom_reasoning_effort && m.custom_reasoning_effort !== 'default'
          ? t('models.effortTextCustom', { effort: m.custom_reasoning_effort })
          : t('models.effortTextDefault');
    const effortCell = m.supports_reasoning ? (
      <button className="cell-edit" title={t('models.effortCellTitle')} onClick={() => openEdit(m)}>
        {effortText}
      </button>
    ) : (
      <span className="muted" style={{ fontSize: 11 }}>
        {t('models.noReasoning')}
      </span>
    );

    // 上下文限制：只读展示最高可用上下文（无编辑入口）
    const ctx = m.max_input_tokens || 0;
    const ctxCell =
      ctx > 0 ? (
        <span
          className="mono"
          style={{ fontSize: 12 }}
          title={t('models.ctxTitle', { ctx: ctx.toLocaleString() })}
        >
          {ctx.toLocaleString()} <small className="muted">({Math.round(ctx / 1000)}k)</small>
        </span>
      ) : (
        <span className="muted">—</span>
      );

    // 标签：点击快速按标签筛选；不可用模型附「需授权」徽章；精细化渲染彩色徽章
    const badgeBase: CSSProperties = { fontSize: 10, marginRight: 3, cursor: 'pointer' };
    const tagBadges: ReactNode[] = [];
    if (m.availability === 'unavailable') {
      tagBadges.push(
        <span
          key="__unavail__"
          className="badge badge-warn clickable-tag"
          role="button"
          tabIndex={0}
          aria-label={t('models.unauthBadgeAria')}
          title={t('models.unauthBadgeTitle')}
          style={badgeBase}
          onClick={() => setTagFilterAndClose('需授权')}
          onKeyDown={activateOnKey(() => setTagFilterAndClose('需授权'))}
        >
          {t('models.unauthBadge')}
        </span>,
      );
    }
    for (const tag of m.tags || []) {
      const r = getBadgeRender(tag, m, isNight);
      tagBadges.push(
        <span
          key={tag}
          className={`badge clickable-tag${r.style ? '' : ' badge-info'}`}
          role="button"
          tabIndex={0}
          aria-label={t('models.tagItemAria', { tag })}
          title={r.title}
          style={r.style ? { ...badgeBase, ...parseInlineStyle(r.style) } : badgeBase}
          onClick={() => setTagFilterAndClose(tag)}
          onKeyDown={activateOnKey(() => setTagFilterAndClose(tag))}
        >
          {r.text}
        </span>,
      );
    }

    return (
      <tr key={m.id}>
        <td>
          <button
            className="model-id-copy mono"
            data-copy-model={m.id}
            title={t('models.copyModelId', { id: m.id })}
            aria-label={t('models.copyModelId', { id: m.id })}
            onClick={() => void handleCopyModelId(m.id)}
          >
            <strong style={{ color: 'var(--link)', fontSize: 13 }}>{m.id}</strong>
            <span className="model-id-copy-icon" aria-hidden="true">
              ⧉
            </span>
          </button>
          <div className="muted" style={{ fontSize: 11 }} title={m.description || undefined}>
            {m.name}
          </div>
        </td>
        <td>
          <MultiplierCell model={m} />
        </td>
        <td>
          <div className="param-cell">{ctxCell}</div>
          <div className="param-cell">{effortCell}</div>
        </td>
        <td>
          <div>{tagBadges}</div>
        </td>
      </tr>
    );
  };

  return (
    <div className="panel-page active">
      <div className="section-title-row">
        <div>
          <h2>{t('models.title')}</h2>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => void load(true)}
          disabled={loading}
        >
          {t('models.refresh')}
        </button>
      </div>

      {/* 筛选区：搜索（id/name）+ 可用性；model_list_mode 说明文案紧随其下 */}
      <div
        style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}
      >
        <input
          className="input"
          style={{ width: 260 }}
          placeholder={t('models.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('models.searchPlaceholder')}
        />
        <span className="muted" style={{ fontSize: 12 }}>
          {t('models.availabilityLabel')}
        </span>
        <select
          className="input"
          style={{ width: 'auto' }}
          value={availability}
          onChange={(e) => setAvailability(e.target.value as AvailabilityFilter)}
          aria-label={t('models.availabilityLabel')}
        >
          <option value="all">{t('models.availabilityAll')}</option>
          <option value="available">{t('models.availabilityAvailable')}</option>
          <option value="unavailable">{t('models.availabilityUnavailable')}</option>
        </select>
      </div>
      <p className="muted field-hint" style={{ marginBottom: 12 }}>
        {modelListModeNote(listMode)}
      </p>

      {/* 模型表格 */}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="data-table models-table">
          <thead>
            <tr>
              <th
                className={`sortable-th${sortField === 'id' ? ' sorted' : ''}`}
                title={t('models.sortModelTitle')}
                onClick={() => {
                  const n = nextModelSort(sortField, sortOrder);
                  setSortField(n.field);
                  setSortOrder(n.order);
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {t('models.colModel')}{' '}
                  <span className={`sort-indicator${sortField === 'id' ? ' active' : ''}`}>
                    {sortModelIcon}
                  </span>
                </span>
              </th>
              <th
                className={`sortable-th${sortField === 'credits' ? ' sorted' : ''}`}
                title={t('models.sortCreditsTitle')}
                onClick={() => {
                  const n = nextCreditsSort(sortField, sortOrder);
                  setSortField(n.field);
                  setSortOrder(n.order);
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {t('models.colCredits')}{' '}
                  <span className={`sort-indicator${sortField === 'credits' ? ' active' : ''}`}>
                    {sortCreditsIcon}
                  </span>
                </span>
              </th>
              <th>{t('models.colParams')}</th>
              <th ref={tagThRef} style={{ position: 'relative' }}>
                <div
                  ref={tagBtnRef}
                  className={`th-filter-wrapper${tagFilter !== 'ALL' ? ' filter-active' : ''}`}
                  title={t('models.tagFilterTitle')}
                  role="button"
                  tabIndex={0}
                  onClick={handleTagToggle}
                  onKeyDown={activateOnKey(handleTagToggle)}
                >
                  <span>{t('models.colTags')}</span>
                  {tagFilter !== 'ALL' ? (
                    <span
                      className="badge badge-info"
                      style={{ display: 'inline-block', fontSize: 10, padding: '1px 5px' }}
                      title={t('models.tagClearTitle')}
                    >
                      {displayTag(tagFilter)} ✕
                    </span>
                  ) : (
                    <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 2 }}>▼</span>
                  )}
                </div>
                {tagMenuOpen && (
                  <div ref={tagMenuRef} className="tag-filter-menu">
                    <div
                      className={`tag-filter-item${tagFilter === 'ALL' ? ' active' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-label={t('models.tagAllCountTitle', { count: models.length })}
                      onClick={() => setTagFilterAndClose('ALL')}
                      onKeyDown={activateOnKey(() => setTagFilterAndClose('ALL'))}
                    >
                      <span>{t('models.tagAll')}</span>
                      <span className="count-badge">{models.length}</span>
                    </div>
                    {tagCounts.map(({ tag, count }) => (
                      <div
                        key={tag}
                        className={`tag-filter-item${tagFilter === tag ? ' active' : ''}`}
                        role="button"
                        tabIndex={0}
                        aria-label={t('models.tagItemTitle', { tag: displayTag(tag), count })}
                        onClick={() => setTagFilterAndClose(tag)}
                        onKeyDown={activateOnKey(() => setTagFilterAndClose(tag))}
                      >
                        <span>{displayTag(tag)}</span>
                        <span className="count-badge">{count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', padding: 24 }}>
                  <span className="spinner"></span> {t('models.syncing')}
                </td>
              </tr>
            ) : visibleModels.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  {t('models.empty')}
                </td>
              </tr>
            ) : (
              visibleModels.map(renderRow)
            )}
          </tbody>
        </table>
      </div>

      {/* 模型参数编辑弹窗（思考强度） */}
      {editing && (
        <div
          className="modal-overlay"
          onClick={(e: ReactMouseEvent<HTMLDivElement>) => {
            if (e.target === e.currentTarget) setEditing(null);
          }}
        >
          <div className="modal-card">
            <h3>{t('models.editTitleFor', { id: editing.id, name: editing.name })}</h3>
            <div>
              {editing.supports_reasoning ? (
                <div className="zguide-field">
                  <span className="zguide-label">
                    {t('models.effortLabel')}
                    {effortSourceHint}
                  </span>
                  <select
                    className="input mono"
                    style={{ width: '100%' }}
                    value={effortValue}
                    onChange={(e) => setEffortValue(e.target.value)}
                  >
                    {/* 「默认」= 透传，不写 reasoning_effort 键；不得暗示具体档位 */}
                    <option value="default">{t('models.effortDefault')}</option>
                    {editing.supported_efforts.map((ef) => (
                      <option key={ef} value={ef}>
                        {t('models.effortIntensity', { effort: ef })}
                      </option>
                    ))}
                    {editing.can_disable_thinking && (
                      <option value="disable">{t('models.effortDisable')}</option>
                    )}
                  </select>
                  <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                    {t('models.effortDefaultHint')}
                  </p>
                </div>
              ) : (
                <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
                  {t('models.noReasoningSupport')}
                </p>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => setEditing(null)}>
                {t('models.cancel')}
              </button>
              {editing.supports_reasoning && (
                <button className="btn btn-primary btn-sm" onClick={() => void saveEdit()}>
                  {t('models.save')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
