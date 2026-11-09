/**
 * 可选框架服务的生命周期协议。注册表保存定义，HTTP 与 worker 按各自职责取得服务；
 * 此模块只连接扩展点，不承载具体模型、审批或网络实现，避免内核依赖可选包。
 */
import type { Kernel } from './kernel.js';
import type { CatalogEntry } from './registry.js';
import { MIGRATIONS, RUNTIME } from './brands.js';

/** 可选框架服务的装配边界；内核不依赖服务的 HTTP 框架或模型实现。 */
export interface RuntimeService {
  /** 推进一轮后台工作并返回本轮处理量；signal 用于服务停机时取消可中止任务。 */
  tick(signal?: AbortSignal): Promise<number>;
  /** 确认服务可用；失败向上传播，由启动方决定是否拒绝启动。 */
  ready(): Promise<void>;
  /** 释放服务持有的资源；不负责关闭传入的整个 kernel。 */
  close(): Promise<void>;
  openapi?(): Record<string, Record<string, unknown>>;
  http?(app: any): void | Promise<void>;
}

/** 冻结在 domain 中的服务描述；迁移使用稳定名字，service 负责按 kernel 管理实例。 */
export interface RuntimeDefinition {
  readonly [RUNTIME]: true;
  readonly name: string;
  readonly spec: unknown;
  readonly capabilities: readonly CatalogEntry[];
  readonly [MIGRATIONS]: () => readonly { name: string; sql: string }[];
  service(kernel: Kernel): RuntimeService;
}

/**
 * 只装配当前注册表明确启用的服务，不扫描包或隐式启用功能。
 * 每次调用都会访问 service(kernel)，实例复用和幂等初始化由具体扩展负责。
 */
export function runtimeServices(kernel: Kernel): RuntimeService[] {
  return kernel.registry.extensions.filter(e => e.kind === 'RUNTIME').map(e => (e.value as RuntimeDefinition).service(kernel));
}
