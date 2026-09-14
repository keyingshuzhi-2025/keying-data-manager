import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, FolderLock, LoaderCircle, UserPlus, WifiOff } from 'lucide-react';
import { api } from '../../api/client';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import type { SessionResponse } from '../../types';
import { errorMessage } from '../../utils/format';

interface LoginPageProps {
  onAuthenticated: (session: SessionResponse) => void;
  initialError?: string;
}

type AuthMode = 'login' | 'register';

export function LoginPage({ onAuthenticated, initialError }: LoginPageProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const online = useOnlineStatus();
  const authenticate = useMutation({
    mutationFn: ({ action, account, secret }: { action: AuthMode; account: string; secret: string }) => (
      action === 'login' ? api.login(account, secret) : api.register(account, secret)
    ),
    onSuccess: onAuthenticated,
  });

  const changeMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setPassword('');
    setConfirmPassword('');
    authenticate.reset();
  };

  const passwordsMatch = mode === 'login' || password === confirmPassword;
  const validRegistration = mode === 'login' || (
    username.trim().length >= 3 && password.length >= 8 && passwordsMatch
  );
  const canSubmit = online && Boolean(username.trim()) && Boolean(password) && validRegistration;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) {
      authenticate.mutate({ action: mode, account: username.trim(), secret: password });
    }
  };

  return (
    <main className="login-page">
      <section className="login-hero" aria-label="产品介绍">
        <div className="brand-mark brand-mark--large"><FolderLock size={32} /></div>
        <div className="login-hero__copy">
          <span className="eyebrow">LOCAL FILE HUB</span>
          <h1>文件，留在你的网络里。</h1>
          <p>一个安静、直接的局域网文件空间。集中保存，随处访问，不经过第三方云端。</p>
        </div>
        <div className="login-hero__status">
          <span className="status-dot" />
          本地存储 · 端到端流式传输
        </div>
      </section>

      <section className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <div className="auth-mode" role="tablist" aria-label="账号操作">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'is-active' : ''}
              onClick={() => changeMode('login')}
            >登录</button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={mode === 'register' ? 'is-active' : ''}
              onClick={() => changeMode('register')}
            >注册账号</button>
          </div>

          <div className="login-form__heading">
            <span className="eyebrow">{mode === 'login' ? '欢迎回来' : '加入文件站'}</span>
            <h2>{mode === 'login' ? '登录文件站' : '创建普通用户'}</h2>
            <p>{mode === 'login' ? '管理员和普通用户都可以登录。' : '注册后由管理员授予文件访问权限。'}</p>
          </div>

          {!online ? (
            <div className="notice notice--warning"><WifiOff size={18} />当前处于离线状态，恢复网络后再继续。</div>
          ) : null}
          {authenticate.isError || initialError ? (
            <div className="notice notice--error" role="alert">
              {authenticate.isError ? errorMessage(authenticate.error) : initialError}
            </div>
          ) : null}

          <label className="field">
            <span>账号</span>
            <input
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={mode === 'login' ? '输入用户名' : '3–50 个字符'}
              minLength={mode === 'register' ? 3 : 1}
              maxLength={mode === 'register' ? 50 : 100}
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              name="password"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={mode === 'register' ? '至少 8 个字符' : '输入密码'}
              minLength={mode === 'register' ? 8 : 1}
              required
            />
          </label>
          {mode === 'register' ? (
            <label className="field">
              <span>确认密码</span>
              <input
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="再输入一次密码"
                aria-invalid={Boolean(confirmPassword) && !passwordsMatch}
                required
              />
              {confirmPassword && !passwordsMatch ? <small className="field-error">两次输入的密码不一致</small> : null}
            </label>
          ) : null}
          <button className="button button--primary button--wide" type="submit" disabled={authenticate.isPending || !canSubmit}>
            {authenticate.isPending ? <LoaderCircle className="spin" size={19} /> : null}
            {authenticate.isPending ? '正在处理…' : (mode === 'login' ? '进入文件站' : '注册并登录')}
            {!authenticate.isPending ? (mode === 'login' ? <ArrowRight size={18} /> : <UserPlus size={18} />) : null}
          </button>
          <p className="login-form__footnote">
            {mode === 'register' ? '新账号默认无文件权限，请联系管理员授权。' : '会话仅保存在此浏览器的安全 Cookie 中。'}
          </p>
        </form>
      </section>
    </main>
  );
}
