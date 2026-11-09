/**
 * 采购 Web 的 Vite 配置：选定严格端口并将 API、认证、附件等请求代理到本地后端。
 * 对 React 及查询库去重，避免 workspace 中出现多个 hooks 上下文。
 * 此处代理只服务开发环境，生产部署的 SPA 回退与接口转发由部署配置负责。
 */
import { defineConfig } from 'vite';

// 浏览器请求保持同源，让 cookie 会话和 CSRF 验证与生产环境使用同一种方式。
// Windows 的 Docker/Hyper-V 可能保留 5173，允许从项目 .env 显式选择可用端口。
const api = `http://127.0.0.1:${process.env.PORT ?? '3000'}`;
export default defineConfig({
  // 本地 --framework-path 会把 SDK 链接到另一个 node_modules。
  // hooks 与页面必须共用同一个 React/Query 实例，否则构建成功也会在登录后白屏。
  resolve: { dedupe: ['react', 'react-dom', '@tanstack/react-query'] },
  server: {
    port: Number(process.env.CAGE_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': api,
      '/auth': api,
      '/admin': api,
    },
  },
});
