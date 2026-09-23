import { AlertCircle, AlertTriangle, CheckCircle2, X } from 'lucide-react';

export interface ToastMessage {
  id: number;
  text: string;
  tone: 'success' | 'error' | 'warn';
}

const TONE_ICON = {
  success: CheckCircle2,
  error: AlertCircle,
  warn: AlertTriangle,
};

const TONE_ROLE = {
  success: 'status',
  error: 'alert',
  warn: 'alert',
};

export function Toast({ message, onDismiss }: { message: ToastMessage; onDismiss: () => void }) {
  const Icon = TONE_ICON[message.tone];
  return (
    <div className={`toast toast--${message.tone}`} role={TONE_ROLE[message.tone]}>
      <Icon size={20} aria-hidden="true" />
      <span>{message.text}</span>
      <button type="button" onClick={onDismiss} aria-label="关闭提示">
        <X size={17} aria-hidden="true" />
      </button>
    </div>
  );
}
