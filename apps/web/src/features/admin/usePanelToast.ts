import { useCallback, useEffect, useState } from 'react';
import { Toast, type ToastMessage } from '../../components/Toast';

/**
 * 面板内轻量 Toast 状态（自动 4.5s 消失），
 * 与 FilesPage 中页面级 Toast 的交互方式保持一致。
 */
export function usePanelToast(): {
  toast: ToastMessage | null;
  showToast: (text: string, tone?: ToastMessage['tone']) => void;
  dismissToast: () => void;
} {
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const showToast = useCallback((text: string, tone: ToastMessage['tone'] = 'success') => {
    setToast({ id: Date.now(), text, tone });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(
      () => setToast((current) => (current?.id === toast.id ? null : current)),
      4_500,
    );
    return () => window.clearTimeout(timeout);
  }, [toast]);

  return { toast, showToast, dismissToast };
}
