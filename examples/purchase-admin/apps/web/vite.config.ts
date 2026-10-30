import { defineConfig } from 'vite';

// 浏览器请求保持同源，让 cookie 会话和 CSRF 验证与生产环境使用同一种方式。
// Windows 的 Docker/Hyper-V 可能保留 5173，允许从项目 .env 显式选择可用端口。
const api = `http://127.0.0.1:${process.env.PORT ?? '3000'}`;
export default defineConfig({
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
