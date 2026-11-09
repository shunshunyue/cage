/**
 * 采购 Web 的浏览器启动入口：创建共享查询缓存，将应用路由挂到 root DOM 节点。
 * 契约客户端负责网络与会话协议，页面只在 Provider 内消费 hooks；这里不注册领域或启动后端。
 * 全局样式在此加载，账号切换时的缓存清理由 useSession 和应用壳负责。
 */
// 唯一浏览器启动入口：挂载 React、全局 Provider 和样式；业务从 app 组合进入。
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/app';
import './app/styles/global.css';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
