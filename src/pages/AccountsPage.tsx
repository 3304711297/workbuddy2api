/**
 * 账号与资产管理页（旧 src/accounts.js 的 React+TS 迁移）。
 *
 * 行为契约（与旧实现一致）：
 *  - 挂载时 createAccountsLoader().load(port) 四路并行拉取；
 *    卸载或刷新时 invalidate() 丢弃陈旧结果。
 *  - 账号卡片：昵称 / uid（截断 + 点击复制完整）/ 活跃徽章 / 冷却中模型 /
 *    切换 / 删除（danger confirm）/ 刷新 Token。
 *  - 额度卡：usage_query 的 quota 字段；限流卡：models 三态 + 冷却倒计时。
 *  - 每日签到按钮：初始状态只读同步 loader.checkin，页面绝不自动 claim。
 *  - 刷新失败 toast 提示但不清空旧数据（failReason 内联展示）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/ServiceProvider';
import { useToast } from '../services/toast';
import { useConfirm } from '../services/confirm';
import { useI18n } from '../i18n';
import { copyToClipboard } from '../services/clipboard';
import {
  buildAccountCooldownMap,
  createAccountsLoader,
  formatCooldown,
  pickLimitedAccount,
  shortUid,
  type AccountsLoader,
  type AccountsLoadResult,
} from '../services/accountsService';
import {
  accountsDelete,
  accountsRefreshToken,
  accountsSwitch,
  proxyCheckinClaim,
  type AccountInfo,
  type RateLimitInfo,
  type UsageQuota,
} from '../services/tauri';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '');
}

/** 账号级冷却模型名（旧 renderAccountsGrid 的冷却映射逻辑）： */
function coolingModelNames(uid: string, rl: RateLimitInfo | null): string[] {
  const names: string[] = [];
  const raw = rl?.accountCooldowns;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item?.uid === uid && Number(item.remainingSec ?? 0) > 0 && item.model && !names.includes(item.model)) {
        names.push(item.model);
      }
    }
  }
  const models = rl?.models ?? {};
  for (const [m, e] of Object.entries(models)) {
    if (e?.state === 'limited' && e.limitedUid === uid && !names.includes(m)) {
      names.push(m);
    }
  }
  return names;
}

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        marginRight: 6,
        animation: pulse ? 'pulse-dot 1.2s ease-in-out infinite' : undefined,
      }}
    />
  );
}

/** 频率限制卡：rl 为 null 或 models 为空时不渲染（旧 renderRateLimitCard）。 */
function RateLimitCard({ rl, currentUid }: { rl: RateLimitInfo | null; currentUid: string | null }) {
  const { t } = useI18n();
  const models = useMemo(() => (rl?.models ? Object.entries(rl.models) : []), [rl]);
  if (!rl || models.length === 0) return null;

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('accounts.rateLimitTitle')}</span>
          {rl.rotation?.soonest_expire_day && (
            <span
              className="badge"
              style={{
                fontSize: 10,
                marginLeft: 6,
                background: 'rgba(245,158,11,0.15)',
                color: '#f59e0b',
                border: '1px solid rgba(245,158,11,0.3)',
              }}
              title={t('accounts.rateLimitExpiryTip')}
            >
              {t('accounts.rateLimitExpiry', { day: rl.rotation.soonest_expire_day })}
            </span>
          )}
          {rl.nightFree ? (
            <span
              className="badge badge-success"
              style={{
                fontSize: 10,
                marginLeft: 6,
                background: 'rgba(16,185,129,0.15)',
                color: '#10b981',
                border: '1px solid rgba(16,185,129,0.3)',
              }}
              title={t('accounts.rateLimitNightTip')}
            >
              {t('accounts.rateLimitNightOn')}
            </span>
          ) : null}
        </div>
        <span className="muted" style={{ fontSize: 10 }}>
          {!rl.nightFree ? `${t('accounts.rateLimitNightOff')} · ` : ''}
          {t('accounts.rateLimitNoThreshold')}
        </span>
      </div>

      {models.map(([model, e]) => {
        const limited = e.state === 'limited';
        const expired = e.state === 'expired';
        // 账号级归因：受限是否为当前活跃账号
        const isCurrentLimited = Boolean(
          limited &&
            (e.isActiveAccountLimited === true ||
              (currentUid && e.limitedUid === currentUid) ||
              (!currentUid && !e.limitedUid)),
        );
        const isOtherLimited = Boolean(
          limited && !isCurrentLimited && e.limitedUid && (!currentUid || e.limitedUid !== currentUid),
        );

        return (
          <div key={model} className="pkg-item" title={e.message || t('accounts.rateLimitDefaultMsg')}>
            {isCurrentLimited ? (
              <Dot color="var(--danger)" pulse />
            ) : isOtherLimited || expired ? (
              <Dot color="var(--warning, #f59e0b)" />
            ) : (
              <Dot color="var(--success)" />
            )}
            <span className="mono">{model}</span>
            <span>
              {isCurrentLimited ? (
                <>
                  <strong style={{ color: 'var(--danger)' }}>{t('accounts.rateLimitLimited')}</strong>{' '}
                  <span className="mono">⏳ {formatCooldown(Number(e.remainingSec ?? 0))}</span>{' '}
                  <small className="muted mono">@{e.resetLocal || ''}</small>
                </>
              ) : isOtherLimited ? (
                <>
                  <strong style={{ color: 'var(--warning, #f59e0b)' }}>{t('accounts.rateLimitAvoided')}</strong>{' '}
                  <small className="muted mono">
                    {t('accounts.rateLimitAvoidedNote', {
                      other: e.limitedNickname ? ` (${e.limitedNickname})` : '',
                    })}
                  </small>{' '}
                  <span className="mono">⏳ {formatCooldown(Number(e.remainingSec ?? 0))}</span>
                </>
              ) : expired ? (
                <>
                  <strong style={{ color: 'var(--warning, #f59e0b)' }}>{t('accounts.rateLimitRecovered')}</strong>{' '}
                  <small className="muted mono">{t('accounts.rateLimitRecoveredNote', { reset: e.resetLocal || '' })}</small>
                </>
              ) : (
                <strong style={{ color: 'var(--success)' }}>{t('accounts.rateLimitOk')}</strong>
              )}
              {e.lastSeenLocal ? (
                <>
                  {' · '}
                  <small className="muted mono" title={t('accounts.rateLimitLastSeenTip')}>
                    {t('accounts.rateLimitLastSeen', { time: e.lastSeenLocal })}
                  </small>
                </>
              ) : null}
            </span>
          </div>
        );
      })}

      {Object.entries(rl.rollingUsage ?? {}).map(([model, u]) => {
        const hasToday = u.reqsToday !== undefined;
        const reqs = Number(hasToday ? u.reqsToday : (u.reqs5h ?? 0)) || 0;
        const tokens = Number(hasToday ? (u.tokensToday || 0) : (u.tokens5h || 0)) || 0;
        const err429 = Number(hasToday ? u.err429_today : u.err429_5h) || 0;
        const reqs5h = Number(u.reqs5h) || 0;
        const label = hasToday ? t('accounts.usageToday') : t('accounts.usage5h');
        return (
          <div key={`usage-${model}`} className="pkg-item">
            <span className="mono muted">
              {model} · {label}
            </span>
            <span>
              <strong>{reqs}</strong> {t('accounts.usageReqUnit')} / <strong>{(tokens / 1e6).toFixed(2)}M</strong>{' '}
              {t('accounts.usageTokenUnit')}
              {err429 ? <small style={{ color: 'var(--danger)' }}> 429×{err429}</small> : null}
              {hasToday && u.reqs5h !== undefined ? (
                <small className="muted mono">
                  {' '}
                  {t('accounts.usage5hNote', { count: reqs5h })}
                </small>
              ) : null}
            </span>
          </div>
        );
      })}

      {Object.entries(rl.fallbacks ?? {}).map(([requested, ev]) => {
        const safeEv = ev && typeof ev === 'object' ? ev : {};
        const count = Number(safeEv.count) || 0;
        const actual = safeEv.actual || '—';
        const reason = safeEv.reason || 'unknown';
        const lastLocal = safeEv.lastLocal || '—';
        return (
          <div key={`fb-${requested}`} className="pkg-item" title={t('accounts.fallbackTip', { requested, actual })}>
            <span style={{ color: 'var(--danger)' }}>⚠️ {t('accounts.fallbackLabel')}</span>
            <span>
              <span className="mono">{requested}</span> → <span className="mono">{actual}</span>
            </span>
            <small className="muted mono">
              {t('accounts.fallbackDetail', { actual, reason, count, lastLocal })}
            </small>
          </div>
        );
      })}

      {(() => {
        const srv = rl.server ?? {};
        const protoCount = Array.isArray(srv.protocols) ? srv.protocols.length : 0;
        if (protoCount === 0 && !srv.maxBodyMb) return null;
        const protoLabel =
          protoCount === 3
            ? t('accounts.gatewayTriProto')
            : protoCount > 0
              ? (srv.protocols ?? []).join(' / ')
              : '—';
        return (
          <div className="pkg-item" title={t('accounts.gatewayTip')}>
            <span className="muted mono">{t('accounts.gatewayLabel')}</span>
            <span>
              <strong>{protoLabel}</strong>
              {srv.maxBodyMb ? ` · ${t('accounts.gatewayBodyLimit', { mb: srv.maxBodyMb })}` : ''}
              {srv.userAgent ? <small className="muted mono"> · {srv.userAgent}</small> : ''}
            </span>
          </div>
        );
      })()}
    </div>
  );
}

/** 额度卡：usage_query 的 quota 渲染（旧 renderActiveAccountAndUsage 的积分进度部分）。 */
function QuotaBox({
  quota,
  rateLimit,
  currentUid,
  checkinNode,
  onRefreshQuota,
}: {
  quota: UsageQuota | null;
  rateLimit: RateLimitInfo | null;
  currentUid: string | null;
  checkinNode: React.ReactNode;
  onRefreshQuota: () => void;
}) {
  const { t } = useI18n();
  if (!quota) {
    return (
      <div className="embedded-quota-box" style={{ textAlign: 'center', padding: 16 }}>
        <span className="muted">{t('accounts.quotaUnavailable')}</span>
        <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 10 }} onClick={onRefreshQuota}>
          {t('accounts.refreshQuota')}
        </button>
      </div>
    );
  }
  const total = quota.total || 0;
  const remain = quota.remain || 0;
  const used = quota.used || 0;
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((remain / total) * 100))) : 0;
  const progressColor = pct < 15 ? 'var(--danger)' : pct < 35 ? 'var(--warning)' : 'var(--success)';

  return (
    <div className="embedded-quota-box">
      <div className="quota-stats-head">
        <div>
          <span className="quota-remain-big mono">{Math.round(remain).toLocaleString()}</span>
          <span className="quota-unit-tag">{t('accounts.quotaRemain')}</span>
          {quota.is_paid_user ? (
            <span className="badge badge-info" style={{ marginLeft: 8 }}>
              {t('accounts.paidUser')}
            </span>
          ) : (
            <span className="badge badge-info" style={{ marginLeft: 8 }}>
              {t('accounts.freeUser')}
            </span>
          )}
        </div>
        <div className="quota-totals-text">
          <span>
            {t('accounts.quotaTotal')} <strong className="mono">{Math.round(total).toLocaleString()}</strong>
          </span>{' '}
          ·
          <span>
            {t('accounts.quotaUsed')} <strong className="mono">{Math.round(used).toLocaleString()}</strong>
          </span>
          {checkinNode}
        </div>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%`, background: progressColor }} />
      </div>
      {(quota.packages?.length ?? 0) > 0 && (
        <div className="pkg-list">
          {(quota.packages ?? []).map((p) => (
            <div key={p.code || 'default'} className="pkg-item">
              <span className="mono muted">{p.code || t('accounts.defaultPackage')}</span>
              <span>
                <strong>{Math.round(p.remain)}</strong> / {Math.round(p.total)}{' '}
                <small className="muted">{p.unit}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      <RateLimitCard rl={rateLimit} currentUid={currentUid} />
    </div>
  );
}

/** 单个账号卡片（旧 renderAccountsGrid 的卡片结构）。 */
function AccountCard({
  account,
  coolingModels,
  coolingSec,
  multi,
  switching,
  deleting,
  tokenBusy,
  onSwitch,
  onDelete,
  onRefreshToken,
  onCopyUid,
}: {
  account: AccountInfo;
  coolingModels: string[];
  /** buildAccountCooldownMap 产出的该账号剩余冷却秒数（>0 即冷却中）。 */
  coolingSec: number;
  multi: boolean;
  switching: boolean;
  deleting: boolean;
  tokenBusy: boolean;
  onSwitch: (uid: string) => void;
  onDelete: (uid: string) => void;
  onRefreshToken: (uid: string) => void;
  onCopyUid: (uid: string) => void;
}) {
  const { t } = useI18n();
  const isCooling = coolingSec > 0 || coolingModels.length > 0;

  let badge: React.ReactNode;
  if (account.is_active) {
    badge = isCooling ? (
      <span
        className="badge"
        style={{ background: 'rgba(239,68,68,0.2)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.4)' }}
      >
        {t('accounts.activeButLimited')}
      </span>
    ) : (
      <span className="badge badge-running">{multi ? t('accounts.activeMulti') : t('accounts.activeSingle')}</span>
    );
  } else {
    badge = isCooling ? (
      <span
        className="badge"
        style={{
          background: 'rgba(245,158,11,0.2)',
          color: 'var(--warning, #f59e0b)',
          border: '1px solid rgba(245,158,11,0.4)',
        }}
      >
        {t('accounts.coolingAway')}
      </span>
    ) : (
      <span className="badge badge-info">{account.token_expired ? t('accounts.expired') : t('accounts.standby')}</span>
    );
  }

  return (
    <div className={`account-item-card ${account.is_active ? 'is-active' : ''}`}>
      <div className="account-item-header">
        <strong>{account.nickname || t('accounts.unnamed')}</strong>
        {badge}
      </div>
      <button
        type="button"
        className="mono muted"
        style={{
          fontSize: 11,
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left',
          color: 'inherit',
          fontFamily: 'inherit',
        }}
        title={`${t('accounts.copyUid')}: ${account.uid}`}
        onClick={() => onCopyUid(account.uid)}
      >
        {shortUid(account.uid)}
      </button>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, marginTop: 4 }}>
        <span className={account.token_expired ? 'text-danger' : 'text-success'}>
          {account.token_expired ? t('accounts.credentialExpired') : t('accounts.credentialValid')}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          {!account.is_active && (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ padding: '2px 6px' }}
                disabled={switching}
                onClick={() => onSwitch(account.uid)}
              >
                {switching ? t('accounts.switching') : t('accounts.setActive')}
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                style={{ padding: '2px 6px' }}
                disabled={deleting}
                onClick={() => onDelete(account.uid)}
              >
                {deleting ? t('accounts.deleting') : t('accounts.delete')}
              </button>
            </>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ padding: '2px 6px' }}
            disabled={tokenBusy}
            onClick={() => onRefreshToken(account.uid)}
          >
            {tokenBusy ? t('accounts.refreshingToken') : t('accounts.refreshToken')}
          </button>
        </span>
      </div>
      {isCooling && (
        <div style={{ fontSize: 10, marginTop: 4, color: 'var(--danger, #ef4444)' }}>
          {t('accounts.coolingModels', {
            models:
              coolingModels.slice(0, 3).join(', ') +
              (coolingModels.length > 3 ? t('accounts.coolingMore', { count: coolingModels.length }) : ''),
          })}
        </div>
      )}
    </div>
  );
}

export function AccountsPage() {
  const { port, checkHealthNow } = useApp();
  const { showToast } = useToast();
  const { confirm } = useConfirm();
  const { t } = useI18n();

  const loaderRef = useRef<AccountsLoader | null>(null);
  const [data, setData] = useState<AccountsLoadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [switchingUid, setSwitchingUid] = useState<string | null>(null);
  const [deletingUid, setDeletingUid] = useState<string | null>(null);
  const [tokenBusyUid, setTokenBusyUid] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimedLocally, setClaimedLocally] = useState(false);

  const load = useCallback(async () => {
    const loader = loaderRef.current;
    if (!loader) return;
    setLoading(true);
    try {
      const res = await loader.load(port);
      if (!res) return; // 陈旧结果（已被新一轮作废），直接丢弃
      setData(res);
      setClaimedLocally(false);
      if (res.failReason) {
        // 账号列表读取失败 ≠ 尚未登录：toast 提示 + 内联展示，但不清空旧数据
        showToast(t('accounts.loadPartial', { reason: res.failReason }), 'warning');
      }
    } catch (e) {
      showToast(t('accounts.loadFail', { msg: errMsg(e) }), 'error');
    } finally {
      setLoading(false);
    }
  }, [port, showToast, t]);

  // 挂载拉取；卸载或 port 变化时作废在途加载
  useEffect(() => {
    const loader = createAccountsLoader();
    loaderRef.current = loader;
    void load();
    return () => {
      loader.invalidate();
      loaderRef.current = null;
    };
  }, [load]);

  const refresh = useCallback(async () => {
    loaderRef.current?.invalidate();
    await load();
    showToast(t('accounts.dataRefreshed'), 'success');
  }, [load, showToast, t]);

  const onSwitch = useCallback(
    async (uid: string) => {
      if (switchingUid) return;
      setSwitchingUid(uid);
      try {
        await accountsSwitch(uid);
        showToast(t('accounts.switchSuccess'), 'success');
        await load();
        await checkHealthNow();
      } catch (e) {
        showToast(t('accounts.switchFail', { msg: errMsg(e) }), 'error');
      } finally {
        setSwitchingUid(null);
      }
    },
    [switchingUid, load, checkHealthNow, showToast, t],
  );

  const onDelete = useCallback(
    async (uid: string) => {
      if (deletingUid) return;
      const ok = await confirm({
        title: t('accounts.deleteTitle'),
        message: t('accounts.deleteConfirm'),
        okText: t('accounts.deleteOk'),
        danger: true,
      });
      if (!ok) return;
      setDeletingUid(uid);
      try {
        await accountsDelete(uid);
        showToast(t('accounts.deleted'), 'info');
        await load();
      } catch (e) {
        showToast(t('accounts.deleteFail', { msg: errMsg(e) }), 'error');
      } finally {
        setDeletingUid(null);
      }
    },
    [deletingUid, confirm, load, showToast, t],
  );

  const onRefreshToken = useCallback(
    async (uid: string) => {
      if (tokenBusyUid) return;
      setTokenBusyUid(uid);
      try {
        showToast(t('accounts.refreshTokenInfo'), 'info');
        const res = await accountsRefreshToken(uid);
        showToast(
          typeof res === 'string' && res ? res : t('accounts.refreshTokenSuccess'),
          'success',
        );
        await load();
      } catch (e) {
        showToast(t('accounts.refreshTokenFail', { msg: errMsg(e) }), 'error');
      } finally {
        setTokenBusyUid(null);
      }
    },
    [tokenBusyUid, load, showToast, t],
  );

  const onCopyUid = useCallback(
    async (uid: string) => {
      const ok = await copyToClipboard(uid);
      showToast(ok ? t('accounts.uidCopied') : t('accounts.uidCopyFail'), ok ? 'success' : 'warning');
    },
    [showToast, t],
  );

  // 每日签到：初始状态只读同步 loader.checkin，页面加载绝不自动 claim
  const checkinInfo = data?.checkin?.ok ? (data.checkin.data ?? {}) : undefined;
  const alreadyCheckedIn = claimedLocally || checkinInfo?.today_checked_in === true;
  const eventEnded = !alreadyCheckedIn && checkinInfo?.active === false;

  const onClaim = useCallback(async () => {
    if (claiming) return;
    setClaiming(true);
    try {
      const res = await proxyCheckinClaim(port);
      if (res.ok) {
        const streak = res.streak_days
          ? t('accounts.checkinStreak', { days: res.streak_days })
          : '';
        showToast(t('accounts.checkinSuccess', { credit: res.credit ?? 0, streak }), 'success');
        setClaimedLocally(true);
      } else if (res.status === 'already_claimed') {
        showToast(t('accounts.checkinAlready'), 'info');
        setClaimedLocally(true);
      } else if (res.status === 'event_ended') {
        showToast(t('accounts.checkinEnded'), 'warning');
      } else if (res.status === 'not_eligible') {
        showToast(t('accounts.checkinNotEligible'), 'warning');
      } else {
        showToast(
          t('accounts.checkinFail', { msg: res.error || res.msg || t('accounts.unknownError') }),
          'error',
        );
      }
    } catch (e) {
      showToast(t('accounts.checkinRequestFail', { msg: errMsg(e) }), 'error');
    } finally {
      setClaiming(false);
    }
  }, [claiming, port, showToast, t]);

  const checkinButton = (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      id="btn-daily-checkin"
      style={{ marginLeft: 10 }}
      disabled={alreadyCheckedIn || eventEnded || claiming}
      title={
        alreadyCheckedIn
          ? t('accounts.checkedInTitle')
          : eventEnded && checkinInfo?.end_time
            ? t('accounts.eventEndedTitle', { endTime: checkinInfo.end_time })
            : undefined
      }
      onClick={onClaim}
    >
      {claiming
        ? t('accounts.checking')
        : alreadyCheckedIn
          ? t('accounts.checkedIn')
          : eventEnded
            ? t('accounts.checkinEndedBtn')
            : t('accounts.checkin')}
    </button>
  );

  const accounts = data?.accounts;
  const activeAccount = accounts?.find((a) => a.is_active) ?? accounts?.[0] ?? null;
  const multi = (accounts?.length ?? 0) >= 2;
  const cooldownMap = useMemo(() => buildAccountCooldownMap(data?.rateLimit ?? null), [data?.rateLimit]);
  const limitedAccount = useMemo(
    () => pickLimitedAccount(accounts ?? [], data?.rateLimit ?? null),
    [accounts, data?.rateLimit],
  );
  const limitedUid = limitedAccount?.uid ?? activeAccount?.uid ?? null;

  return (
    <div className="panel-page active">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{t('accounts.title')}</h2>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? t('accounts.refreshing') : t('accounts.refresh')}
        </button>
      </div>

      {loading && !data && (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <span className="spinner" /> {t('accounts.syncing')}
        </div>
      )}

      {data?.failReason && data.accounts && (
        <p className="muted" style={{ color: 'var(--warning, #f59e0b)', fontSize: 12 }}>
          {t('accounts.loadPartial', { reason: data.failReason })}
        </p>
      )}

      {accounts === null && !loading && (
        <div className="card" style={{ textAlign: 'center', padding: 36, border: '1px solid var(--danger)' }}>
          <p style={{ color: 'var(--danger)', fontSize: 15, marginBottom: 8 }}>{t('accounts.readError')}</p>
          <p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
            {t('accounts.readErrorHint')}
          </p>
          <button type="button" className="btn btn-primary" onClick={() => void load()}>
            {t('accounts.retry')}
          </button>
        </div>
      )}

      {accounts && accounts.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 36 }}>
          <p className="muted" style={{ fontSize: 15, marginBottom: 14 }}>
            {t('accounts.noAccounts')}
          </p>
        </div>
      )}

      {activeAccount && data && (
        <div className="account-card-active">
          <div className="account-profile-header">
            <div className="avatar-circle">
              {(activeAccount.nickname || 'W').charAt(0).toUpperCase()}
            </div>
            <div className="account-titles">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="account-nickname">{activeAccount.nickname || t('accounts.unnamed')}</span>
                <span className={`badge ${activeAccount.token_expired ? 'badge-expired' : 'badge-valid'}`}>
                  {activeAccount.token_expired ? t('accounts.tokenExpired') : t('accounts.tokenValid')}
                </span>
                <span className="badge badge-running" style={{ fontSize: 10 }}>
                  {t('accounts.currentActive')}
                </span>
              </div>
              <div className="account-sub-info">
                <span>
                  {t('accounts.uidLabel')}: <strong className="mono">{activeAccount.uid}</strong>
                </span>
                {activeAccount.phone_number && (
                  <span>
                    {t('accounts.phone')}: <strong className="mono">{activeAccount.phone_number}</strong>
                  </span>
                )}
                <span>
                  {t('accounts.tokenExpiry')}:{' '}
                  <strong className="mono">
                    {activeAccount.token_expires_at
                      ? new Date(activeAccount.token_expires_at).toLocaleString()
                      : t('accounts.longTerm')}
                  </strong>
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={tokenBusyUid === activeAccount.uid}
                onClick={() => onRefreshToken(activeAccount.uid)}
              >
                {tokenBusyUid === activeAccount.uid ? t('accounts.refreshingToken') : t('accounts.refreshToken')}
              </button>
            </div>
          </div>
          <QuotaBox
            quota={data.quota}
            rateLimit={data.rateLimit}
            currentUid={limitedUid}
            checkinNode={checkinButton}
            onRefreshQuota={() => void load()}
          />
        </div>
      )}

      {accounts && accounts.length > 0 && (
        <div className="accounts-grid" style={{ marginTop: 16 }}>
          {accounts.map((a) => (
            <AccountCard
              key={a.uid}
              account={a}
              coolingModels={coolingModelNames(a.uid, data?.rateLimit ?? null)}
              coolingSec={cooldownMap.get(a.uid) ?? 0}
              multi={multi}
              switching={switchingUid === a.uid}
              deleting={deletingUid === a.uid}
              tokenBusy={tokenBusyUid === a.uid}
              onSwitch={onSwitch}
              onDelete={onDelete}
              onRefreshToken={onRefreshToken}
              onCopyUid={onCopyUid}
            />
          ))}
        </div>
      )}
    </div>
  );
}
