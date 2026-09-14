import { AlertCircle, CheckCircle2, X } from 'lucide-react';

export interface ToastMessage {
  id: number;
  text: string;
  tone: 'success' | 'error';
}

export function Toast({ message, onDismiss }: { message: ToastMessage; onDismiss: () => void }) {
  const Icon = message.tone === 'success' ? CheckCircle2 : AlertCircle;
  return (
    <div className={`toast toast--${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
      <Icon size={20} aria-hidden="true" />
      <span>{message.text}</span>
      <button type="button" onClick={onDismiss} aria-label="关闭提示">
        <X size={17} aria-hidden="true" />
      </button>
    </div>
  );
}
