// API 与 worker 使用相同声明。worker 专门处理审批启动、异步反应和 ERP 推送。
import { startWorker } from '@yss123/cage-http/worker';
import { fakeConnector, stage } from '@yss123/cage-connectors';
import * as domain from '@app/domain';

// 本地和测试的 ERP 返回确定的单号，便于查看同步记录；生产环境走真实出口。
if (stage() === 'fake') {
  fakeConnector(domain.erp, {
    pushOrder: (request) => ({ erpNo: `DEMO-${request.externalId.slice(0, 8)}` }),
  });
}
const worker = await startWorker({ domain });
process.once('SIGINT', () => void worker.stop());
process.once('SIGTERM', () => void worker.stop());
