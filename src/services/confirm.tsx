/**
 * Promise 风格确认框（替代原生 confirm，与 EasyCLIProxyAPI 对齐）。
 * portal + Escape 关闭 + 打开时聚焦确认按钮；返回 true=确认。
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
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';

interface ConfirmOptions {
  title?: string;
  message: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);
  const okButtonRef = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    // 同一时刻只允许一个确认框：旧的按取消结算
    resolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOptions(opts);
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  useEffect(() => {
    if (!options) return;
    okButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settle(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [options, settle]);

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {options &&
        createPortal(
          <div
            className="modal-overlay"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) settle(false);
            }}
          >
            <div className="modal-card" role="dialog" aria-modal="true" aria-label={options.title}>
              {options.title && <h3>{options.title}</h3>}
              <p style={{ whiteSpace: 'pre-wrap' }}>{options.message}</p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => settle(false)}
                >
                  {options.cancelText ?? t('confirm.cancel')}
                </button>
                <button
                  ref={okButtonRef}
                  type="button"
                  className={`btn btn-sm ${options.danger ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => settle(true)}
                >
                  {options.okText ?? t('confirm.ok')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用');
  return ctx;
}
