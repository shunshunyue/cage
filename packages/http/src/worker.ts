// worker 入口的便捷封装：自动并入组织模型。也可以直接用 @yss123/cage-kernel/worker 的 startWorker。
import * as adminDomain from '@yss123/cage-admin/domain';
import { startWorker as start, type WorkerOptions } from '@yss123/cage-kernel/worker';
import { buildRegistry } from '@yss123/cage-kernel';
import { createSafeLogger } from './logger.js';

/** 启动与 HTTP 服务共享领域声明的后台进程，并为默认日志套用相同的脱敏规则。
 * 自动合并组织模型；传入已有 kernel 时复用它的注册表并替换其日志句柄，不另建业务内核。
 * 返回底层 worker 的停止/健康句柄；消费者注册、重试、调度与停机等待全部由内核 worker 实现。
 */
export function startWorker(opts: WorkerOptions & { domain: object }) {
  const domain = [adminDomain, opts.domain];
  const logger = opts.logger ?? createSafeLogger(opts.kernel?.registry ?? buildRegistry(domain));
  if (opts.kernel) Object.assign(opts.kernel, { log: logger });
  return start({ ...opts, domain, logger });
}
