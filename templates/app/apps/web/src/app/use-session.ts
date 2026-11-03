// 应用会话与 URL 导航分别管理：401 才进入登录，网络故障保留原地址并允许重试。
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { client, loadMe } from '@app/contracts';

export function useSession() {
  const [session, setSession] = useState<'loading' | 'guest' | 'ready' | 'error'>('loading');
  const cache = useQueryClient();
  const restore = useCallback(async () => {
    setSession('loading');
    const result = await loadMe();
    setSession(result.ok ? 'ready' : result.code === 'UNAUTHENTICATED' ? 'guest' : 'error');
  }, []);

  useEffect(() => {
    const unsubscribe = client.subscribe((_snapshot, reason) => {
      if (reason === 'loaded') return;
      // 先取消在途查询，再清除上一账号的缓存；路由守卫保留 URL 并决定登录回跳。
      void cache.cancelQueries();
      cache.clear();
      setSession('guest');
    });
    void restore();
    return () => {
      unsubscribe();
    };
  }, [cache, restore]);

  return { session, restore, onLogin: () => setSession('ready'), onLogout: () => setSession('guest') };
}
