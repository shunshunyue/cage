// 启动入口只装配框架：认证、业务路由和 /admin 都由 createServer 提供。
// WEB_DIR 在部署镜像中指向 Vite 构建产物；本地由 Vite 独立提供前端。
import { createServer } from '@yss123/cage-http';
import * as domain from '@app/domain';

const server = createServer({ domain, webDir: process.env.WEB_DIR, title: 'Cage 采购工作台' });
await server.listen();
// 退出时释放数据库池及 LISTEN 连接，部署滚动替换时不会留下旧连接。
process.once('SIGINT', () => void server.close());
process.once('SIGTERM', () => void server.close());
