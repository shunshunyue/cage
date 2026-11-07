import type { Kernel } from './kernel.js';
import type { CatalogEntry } from './registry.js';
import { MIGRATIONS, RUNTIME } from './brands.js';

/** 可选框架服务的装配边界；内核不依赖服务的 HTTP 框架或模型实现。 */
export interface RuntimeService {
  tick(signal?: AbortSignal): Promise<number>;
  ready(): Promise<void>;
  close(): Promise<void>;
  openapi?(): Record<string, Record<string, unknown>>;
  http?(app: any): void | Promise<void>;
}

export interface RuntimeDefinition {
  readonly [RUNTIME]: true;
  readonly name: string;
  readonly spec: unknown;
  readonly capabilities: readonly CatalogEntry[];
  readonly [MIGRATIONS]: () => readonly { name: string; sql: string }[];
  service(kernel: Kernel): RuntimeService;
}

export function runtimeServices(kernel: Kernel): RuntimeService[] {
  return kernel.registry.extensions.filter(e => e.kind === 'RUNTIME').map(e => (e.value as RuntimeDefinition).service(kernel));
}
