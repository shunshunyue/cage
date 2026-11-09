// 启动入口只装配框架：认证、业务路由和 /admin 都由 createServer 提供。
// WEB_DIR 在部署镜像中指向 Vite 构建产物；本地由 Vite 独立提供前端。
// 进程启动只建立服务，不迁移结构、不初始化账号；这些操作由受控 CLI 流程提前完成。
// 声明中启用的 AI、审批与文件接口由框架挂载，后台事件消费仍需要独立 worker 进程。
import { createServer } from '@yss123/cage-http';
import * as domain from '@app/domain';

// 默认不接受转发头；部署在代理后时，仅在这里填写实际可信代理的地址或网段。
const server = createServer({ domain, webDir: process.env.WEB_DIR, title: 'Cage 采购工作台', trustProxy: false });
// listen 先等待路由、扩展与授权通知初始化；失败直接拒绝顶层启动，不伪装为已就绪。
await server.listen();
// 退出时释放数据库池及 LISTEN 连接，部署滚动替换时不会留下旧连接。
process.once('SIGINT', () => void server.close());
process.once('SIGTERM', () => void server.close());
