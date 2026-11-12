/**
 * 空白业务应用的浏览器启动入口，装配 Ant Design 中文主题、共享 QueryClient 并挂载 app 路由。
 * 新增页面使用同一组 Provider 内的 UI 上下文和生成查询 hooks；入口不注册领域或连接数据库。
 * AntD reset 与全局样式由入口加载，会话失效和账号切换时的查询清理由 useSession 负责。
 */
// 浏览器入口只负责挂载 React、Ant Design 与查询 Provider，让新增模块使用统一 UI 和缓存上下文。
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { App } from './app/app';
import 'antd/dist/reset.css';
import './app/styles/global.css';

const queryClient = new QueryClient();

/**
 * ConfigProvider 为组件提供简体中文文案和共享主题；AntdApp 提供上下文反馈方法。
 * QueryClientProvider 承载生成查询 hooks 的缓存；三个 Provider 覆盖应用的全部路由。
 */
createRoot(document.getElementById('root')!).render(
  <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#173e35', borderRadius: 4 } }}>
    <AntdApp>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </AntdApp>
  </ConfigProvider>,
);
