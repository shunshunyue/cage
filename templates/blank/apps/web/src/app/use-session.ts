/**
 * 应用会话生命周期：首次加载 /me，并把 SDK 的账号退出或失效通知同步到路由状态。
 * 与 URL 路由分离，网络故障不会被误判成未登录；查询缓存不能跨账号继续使用。
 */
// 应用会话与 URL 导航分别管理：401 才进入登录，网络故障保留原地址并允许重试。
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { client, loadMe } from '@app/contracts';

/**
 * 在 QueryClientProvider 内使用。挂载时恢复用户，卸载时解除 SDK 订阅。
 * 返回 session：loading 为恢复中，guest 为未认证，ready 为已加载身份，error 为其他恢复失败。
 * restore 可重试恢复；onLogin/onLogout 由已完成认证动作的页面调用，只更新应用状态。
 * 账号失效时发起取消查询并清空缓存；这里不负责服务端退出操作，也不保证取消已提交的业务命令。
 */
export function useSession() {
  const [session, setSession] = useState<'loading' | 'guest' | 'ready' | 'error'>('loading');
  const cache = useQueryClient();
  /**
   * 每次恢复先显示 loading，再按 loadMe 的明确结果分类；只有 UNAUTHENTICATED 进入 guest。
   */
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
