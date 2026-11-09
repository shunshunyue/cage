// API 与 worker 使用相同声明。worker 专门处理审批启动、异步反应和 ERP 推送。
// 两个进程部署同一版本，消费者依据声明发现工作；事件提交成功不等于这些后台动作已经完成。
import { startWorker } from '@yss123/cage-http/worker';
import { fakeConnector, stage } from '@yss123/cage-connectors';
import * as domain from '@app/domain';

// 本地和测试的 ERP 返回确定的单号，便于查看同步记录；生产环境走真实出口。
if (stage() === 'fake') {
  fakeConnector(domain.erp, {
    pushOrder: (request) => ({ erpNo: `DEMO-${request.externalId.slice(0, 8)}` }),
  });
}
// 框架拥有轮询、重试、调度和连接生命周期；应用只注册本地 fake，不另建数据库池或业务重试循环。
const worker = await startWorker({ domain });
// 停止句柄等待框架在途工作收尾并释放连接，避免进程退出时留下仍在续租的消费者。
process.once('SIGINT', () => void worker.stop());
process.once('SIGTERM', () => void worker.stop());
