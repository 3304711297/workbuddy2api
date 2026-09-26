/**
 * 全局应用状态（替代旧 state.js 单一可变对象）。
 *
 * 持有：当前 Tab（sessionStorage 持久化）、端口、脱敏开关、运行态、
 * 客户端密钥（仅内存，不进 localStorage），以及服务启停/重启/健康检查动作。
 *
 * 健康轮询由 App 顶层统一持有（healthService.startHealthPolling），
 * 启停/重启前调 bumpHealthSeq() 作废在途检查（与旧 service.js 同语义）。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  proxyStart,
  proxyStop,
  proxyRestart,
  accountsList,
} from '../services/tauri';
import { bumpHealthSeq, checkHealthOnce, startHealthPolling } from '../services/healthService';
import { useToast } from '../services/toast';

export type TabId =
  | 'dashboard'
  | 'accounts'
  | 'agents'
  | 'models'
  | 'oauth'
  | 'settings'
  | 'logs'
  | 'usage'
  | 'debug';

export const TABS: TabId[] = [
  'dashboard', 'accounts', 'agents', 'models', 'oauth',
  'settings', 'logs', 'usage', 'debug',
];

const TAB_STORAGE_KEY = 'workbuddy2api.tab';

function initialTab(): TabId {
  try {
    const saved = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (saved && (TABS as string[]).includes(saved)) return saved as TabId;
  } catch {
    /* 忽略 */
  }
  return 'dashboard';
}

interface AppContextValue {
  tab: TabId;
  setTab: (t: TabId) => void;
  port: number;
  setPort: (n: number) => void;
  desensitize: boolean;
  setDesensitize: (b: boolean) => void;
  running: boolean;
  apiKey: string;
  setApiKey: (s: string) => void;
  activeNickname: string;
  healthTime: string;
  startProxy: () => Promise<void>;
  stopProxy: () => Promise<void>;
  restartProxy: () => Promise<void>;
  checkHealthNow: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function ServiceProvider({ children }: { children: React.ReactNode }) {
  const { showToast } = useToast();
  const [tab, setTabState] = useState<TabId>(initialTab);
  const [port, setPort] = useState(8787);
  const [desensitize, setDesensitize] = useState(false);
  const [running, setRunning] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [activeNickname, setActiveNickname] = useState('—');
  const [healthTime, setHealthTime] = useState('服务离线');

  const portRef = useRef(port);
  portRef.current = port;
  const runningRef = useRef(running);
  runningRef.current = running;

  const setTab = useCallback((t: TabId) => {
    setTabState(t);
    try {
      sessionStorage.setItem(TAB_STORAGE_KEY, t);
    } catch {
      /* 存储不可用时忽略 */
    }
  }, []);

  /** 健康快照落到全局态（含活跃账号昵称异步回填，带运行态守卫）。 */
  const applySnapshot = useCallback(async (isRunning: boolean) => {
      setRunning(isRunning);
      if (isRunning) {
        setHealthTime(`检测时间: ${new Date().toLocaleTimeString()}`);
        try {
          const list = await accountsList();
          if (!runningRef.current) return;
          const active = list.find((a) => a.is_active) || list[0];
          setActiveNickname(active?.nickname || '已登录');
        } catch {
          setActiveNickname('已登录');
        }
      } else {
        setActiveNickname('—');
        setHealthTime('服务离线');
      }
  }, []);

  const checkHealthNow = useCallback(async () => {
    const snap = await checkHealthOnce(portRef.current);
    if (snap) void applySnapshot(snap.running);
  }, [applySnapshot]);

  // 顶层健康轮询：3s + in-flight 守卫 + 隐藏窗口停表（见 healthService）
  useEffect(() => {
    const poller = startHealthPolling(
      () => checkHealthOnce(portRef.current),
      (snap) => {
        if (snap) void applySnapshot(snap.running);
      },
    );
    return () => poller.stop();
  }, [applySnapshot]);

  const startProxy = useCallback(async () => {
    bumpHealthSeq();
    showToast('正在启动反代服务...', 'info');
    try {
      await proxyStart(portRef.current, desensitize);
      showToast('反代服务已拉起', 'success');
      window.setTimeout(() => void checkHealthNow(), 600);
    } catch (e) {
      showToast(`启动失败: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }, [desensitize, showToast, checkHealthNow]);

  const stopProxy = useCallback(async () => {
    try {
      await proxyStop();
      showToast('服务已停止', 'info');
      bumpHealthSeq();
      setRunning(false);
      setActiveNickname('—');
      setHealthTime('服务离线');
    } catch (e) {
      showToast(`停止失败: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }, [showToast]);

  const restartProxy = useCallback(async () => {
    bumpHealthSeq();
    showToast('正在重启服务...', 'info');
    try {
      await proxyRestart(portRef.current, desensitize);
      showToast('服务已重启完成', 'success');
      window.setTimeout(() => void checkHealthNow(), 800);
    } catch (e) {
      showToast(`重启失败: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }, [desensitize, showToast, checkHealthNow]);

  const value = useMemo<AppContextValue>(
    () => ({
      tab, setTab, port, setPort, desensitize, setDesensitize,
      running, apiKey, setApiKey, activeNickname, healthTime,
      startProxy, stopProxy, restartProxy, checkHealthNow,
    }),
    [tab, setTab, port, desensitize, running, apiKey, activeNickname, healthTime,
      startProxy, stopProxy, restartProxy, checkHealthNow],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 <ServiceProvider> 内使用');
  return ctx;
}
