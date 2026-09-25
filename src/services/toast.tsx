/**
 * 自建 Toast（替代第三方库，与 EasyCLIProxyAPI 对齐）。
 * React portal 渲染，自动消失，类型 info/success/warning/error。
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastContextValue {
  showToast: (message: string, kind?: ToastKind, durationMs?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_CLASS: Record<ToastKind, string> = {
  info: 'toast-info',
  success: 'toast-success',
  warning: 'toast-warning',
  error: 'toast-error',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const showToast = useCallback(
    (message: string, kind: ToastKind = 'info', durationMs = 3200) => {
      const id = nextId.current++;
      setItems((prev) => [...prev.slice(-4), { id, message, kind }]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, durationMs);
    },
    [],
  );

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toast-container" aria-live="polite">
          {items.map((t) => (
            <div key={t.id} className={`toast ${KIND_CLASS[t.kind]}`}>
              {t.message}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return ctx;
}
