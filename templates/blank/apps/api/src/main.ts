// 业务声明决定接口。这个入口只装配框架，不需要另建连接池或手写 CRUD 路由。
// 数据库连接由框架读取项目 .env；生产环境的 WEB_DIR 指向前端构建目录。
import { createServer } from '@yss123/cage-http';
import * as domain from '@app/domain';

// 默认不接受转发头；部署在代理后时，仅在这里填写实际可信代理的地址或网段。
const server = createServer({ domain, webDir: process.env.WEB_DIR, title: 'Cage 业务工作台', trustProxy: false });
await server.listen();

// 退出时释放连接池及数据库通知连接，便于部署时平滑替换进程。
process.once('SIGINT', () => void server.close());
process.once('SIGTERM', () => void server.close());
