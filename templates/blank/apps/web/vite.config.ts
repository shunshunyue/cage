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
