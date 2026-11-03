// worker 处理框架异步任务；增加事件反应、审批或数据导入导出后也沿用此入口。
// 空白项目没有第三方演示连接器，真实外部服务按业务需求声明和配置。
import { startWorker } from '@yss123/cage-http/worker';
import * as domain from '@app/domain';

const worker = await startWorker({ domain });
process.once('SIGINT', () => void worker.stop());
process.once('SIGTERM', () => void worker.stop());
