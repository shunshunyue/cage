/**
 * 采购 Web 的浏览器启动入口：装配 Ant Design 中文主题、共享查询缓存并挂载应用路由。
 * 页面通过 Provider 消费 UI 上下文、生成契约客户端和查询 hooks；入口不注册领域或启动后端。
 * AntD reset 与业务全局样式在此加载，账号切换时的缓存清理由 useSession 和应用壳负责。
 */
// 唯一浏览器启动入口：挂载 React、Ant Design 与查询 Provider；业务从 app 组合进入。
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { App } from './app/app';
import 'antd/dist/reset.css';
import './app/styles/global.css';

const queryClient = new QueryClient();

/**
 * ConfigProvider 提供简体中文文案与统一绿色主题；AntdApp 为 message、modal、notification 等反馈 API 提供上下文。
 * QueryClientProvider 继续承载生成查询 hooks 的缓存；Provider 均只创建一次并覆盖整套路由。
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
