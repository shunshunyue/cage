/**
 * 空白业务应用的浏览器启动入口，创建共享 QueryClient 并挂载 app 路由。
 * 新增业务页面使用同一 Provider 内的生成查询 hooks；此处只装配前端，不注册领域或连接数据库。
 * 全局样式由入口加载，会话失效与账号切换时的查询清理由 useSession 负责。
 */
// 浏览器入口只负责挂载和全局 Provider。QueryClient 让新增模块可直接使用生成查询 hooks。
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
