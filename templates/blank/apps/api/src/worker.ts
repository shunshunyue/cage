// worker 处理框架异步任务；增加事件反应、审批或数据导入导出后也沿用此入口。
// 空白项目没有第三方演示连接器，真实外部服务按业务需求声明和配置。
// API 与 worker 必须加载同版本 domain；框架统一负责消费者发现、轮询、租约、重试及定时调度。
import { startWorker } from '@yss123/cage-http/worker';
import * as domain from '@app/domain';

// 不在入口重复创建连接池或自行扫表；停止句柄等待在途工作并释放框架资源。
const worker = await startWorker({ domain });
process.once('SIGINT', () => void worker.stop());
process.once('SIGTERM', () => void worker.stop());
