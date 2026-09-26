/**
 * 更新弹窗的变更列表构建器（由 main 分支 src/commit-changelog.js 移植为 TypeScript）。
 *
 * 输入 GitHub compare 返回的原始 commit 首行，按 Conventional Commits 1.0
 * 解析 `type(scope)!: subject`，过滤内部噪音（chore/ci/docs/…），
 * 再归入用户能看懂的分组，避免把 40 条工程提交原样糊在弹窗里。
 *
 * 内联实现而非引入 conventional-commits-parser：该项目仅需首行的一个小正则，
 * 引包会把整个解析器（含 Node 专用 helper）拖进渲染器。
 */
import type { UpdateCommit } from './tauri';

export interface CommitGroup {
  id: string;
  label: string;
  items: string[];
}

interface GroupMeta {
  label: string;
  order: number;
}

const GROUP_META: Record<string, GroupMeta> = {
  new: { label: '新增', order: 0 },
  fixed: { label: '修复', order: 1 },
  faster: { label: '性能', order: 2 },
  improved: { label: '改进', order: 3 },
  other: { label: '其它改动', order: 4 },
};

const TYPE_TO_GROUP: Record<string, string> = {
  feat: 'new',
  feature: 'new',
  fix: 'fixed',
  bugfix: 'fixed',
  hotfix: 'fixed',
  revert: 'fixed',
  perf: 'faster',
  performance: 'faster',
  refactor: 'improved',
  a11y: 'improved',
  ui: 'improved',
  ux: 'improved',
};

// 这些类型是工程内部事务，对最终用户无意义，直接不给展示
const HIDDEN_TYPES = new Set([
  'build', 'chore', 'ci', 'dep', 'deps', 'doc', 'docs',
  'lint', 'release', 'style', 'test', 'tests', 'wip',
]);

const FALLBACK_GROUP: CommitGroup = { id: 'other', items: ['本次更新包含若干改进与修复'], label: '本次更新' };

const CONVENTIONAL_HEADER = /^([a-zA-Z][a-zA-Z0-9_-]*)(?:\(([^)]+)\))?(!)?:\s+(.+)$/;

export interface ParsedCommitHeader {
  breaking: boolean;
  scope: string | null;
  subject: string;
  type: string | null;
}

/** 解析单条 commit 首行（Conventional Commits 1.0）。 */
export function parseCommitHeader(raw: string | null | undefined): ParsedCommitHeader {
  const header = String(raw ?? '').split(/\r?\n/, 1)[0].trim();
  if (!header) return { breaking: false, scope: null, subject: '', type: null };

  const match = CONVENTIONAL_HEADER.exec(header);
  if (!match) return { breaking: false, scope: null, subject: header, type: null };

  return {
    breaking: Boolean(match[3]),
    scope: match[2] ?? null,
    subject: match[4].trim(),
    type: match[1].toLowerCase(),
  };
}

function tidySubject(subject: string | null | undefined): string {
  return String(subject ?? '').replace(/\s+/g, ' ').replace(/[.;,\s]+$/, '').trim();
}

export interface BuildChangelogOptions {
  maxGroups?: number;
  maxPerGroup?: number;
  maxTotal?: number;
}

/**
 * 把原始 commit 列表整理成分组变更清单。永远至少返回一组：
 * 全部被过滤或无法解析时退化为中性占位文案，而不是空白弹窗。
 */
export function buildCommitChangelog(
  commits: UpdateCommit[] | null | undefined,
  options: BuildChangelogOptions = {},
): CommitGroup[] {
  const { maxGroups = 3, maxPerGroup = 4, maxTotal = 6 } = options;
  const groups = new Map<string, string[]>();
  const seen = new Set<string>();
  let total = 0;

  for (const commit of commits ?? []) {
    if (total >= maxTotal) break;

    const parsed = parseCommitHeader(commit?.summary ?? '');
    if (parsed.type && HIDDEN_TYPES.has(parsed.type)) continue;

    const groupId = parsed.type ? (TYPE_TO_GROUP[parsed.type] ?? 'other') : 'other';
    const subject = tidySubject(parsed.subject);
    if (!subject) continue;

    const dedupeKey = subject.toLowerCase();
    if (seen.has(dedupeKey)) continue;

    const bucket = groups.get(groupId) ?? [];
    if (bucket.length >= maxPerGroup) continue;

    bucket.push(subject);
    groups.set(groupId, bucket);
    seen.add(dedupeKey);
    total += 1;
  }

  const result: CommitGroup[] = Array.from(groups.entries())
    .map(([id, items]) => ({ id, items, label: GROUP_META[id].label, order: GROUP_META[id].order }))
    .sort((a, b) => a.order - b.order)
    .slice(0, maxGroups)
    .map(({ id, items, label }) => ({ id, items, label }));

  return result.length === 0 ? [{ ...FALLBACK_GROUP }] : result;
}

/** 已展示条数（用于提示「另有 N 项更改」）。 */
export function totalItems(groups: CommitGroup[] | null | undefined): number {
  return (groups ?? []).reduce((sum, g) => sum + g.items.length, 0);
}
