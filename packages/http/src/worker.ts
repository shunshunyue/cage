// worker 入口的便捷封装：自动并入组织模型。也可以直接用 @yss123/cage-kernel/worker 的 startWorker。
import * as adminDomain from '@yss123/cage-admin/domain';
import { startWorker as start, type WorkerOptions } from '@yss123/cage-kernel/worker';
import { buildRegistry } from '@yss123/cage-kernel';
import { createSafeLogger } from './logger.js';

export function startWorker(opts: WorkerOptions & { domain: object }) {
  const domain = [adminDomain, opts.domain];
  const logger = opts.logger ?? createSafeLogger(opts.kernel?.registry ?? buildRegistry(domain));
  if (opts.kernel) Object.assign(opts.kernel, { log: logger });
  return start({ ...opts, domain, logger });
}
