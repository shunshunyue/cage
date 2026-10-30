// worker 入口的便捷封装：自动并入组织模型。也可以直接用 @yss123/cage-kernel/worker 的 startWorker。
import * as adminDomain from '@yss123/cage-admin/domain';
import { startWorker as start, type WorkerOptions } from '@yss123/cage-kernel/worker';

export function startWorker(opts: WorkerOptions & { domain: object }) {
  return start({ ...opts, domain: [adminDomain, opts.domain] });
}
