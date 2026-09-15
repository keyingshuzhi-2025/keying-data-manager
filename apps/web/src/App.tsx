import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderLock, LoaderCircle } from 'lucide-react';
import { ApiError, api } from './api/client';
import { LoginPage } from './features/auth/LoginPage';
import { FilesPage } from './features/files/FilesPage';
import type { SessionResponse } from './types';

export function App() {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: api.session,
    retry: false,
    // 仅已登录（存在会话数据）时才保持 15s 心跳轮询；
    // 未登录时停止轮询，避免登录页每 15 秒反复请求 /api/auth/session
    refetchInterval: (query) => (query.state.data ? 15_000 : false),
    refetchOnWindowFocus: (query) => Boolean(query.state.data),
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: async () => {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== 'session',
      });
      await queryClient.resetQueries({ queryKey: ['session'], exact: true });
    },
  });

  if (session.isPending) {
    return (
      <main className="app-loading" aria-label="正在载入">
        <div className="brand-mark"><FolderLock size={24} /></div>
        <LoaderCircle className="spin" size={22} />
      </main>
    );
  }

  if (session.isError) {
    const unavailable = session.error instanceof ApiError && session.error.status !== 401
      ? session.error.message
      : undefined;
    return (
      <LoginPage
        initialError={unavailable}
        onAuthenticated={(value: SessionResponse) => queryClient.setQueryData(['session'], value)}
      />
    );
  }

  return <FilesPage user={session.data.user} onLogout={() => logout.mutate()} loggingOut={logout.isPending} />;
}
