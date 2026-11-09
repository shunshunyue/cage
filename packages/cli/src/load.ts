/**
 * 通过 tsx 加载 TypeScript 领域入口并构建注册表，供 CLI 分析和迁移调用。
 * tsx 注册在当前进程内只发生一次，导入取得入口公开导出，再交给 kernel buildRegistry。
 * ESM 模块缓存仍然存在，热刷新必须使用独立进程；模块只应包含声明，静态边界检查由上游 analyze 负责。
 */
// 用 tsx 直接导入 domain 包入口。声明都在模块顶层，导入就是全部，不需要运行任何业务逻辑。
import { pathToFileURL } from 'node:url';
import { buildRegistry, type Registry } from '@yss123/cage-kernel';
import { register } from 'tsx/esm/api';

let registered = false;

/**
 * 确保 tsx 注册后导入领域入口。
 * @param entry 入口绝对路径。
 * @returns 模块导出对象；导入错误拒绝 Promise，当前进程 ESM 缓存不会被清空。
 */
export async function importDomain(entry: string): Promise<Record<string, unknown>> {
  if (!registered) {
    register();
    registered = true;
  }
  return (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
}

/**
 * 加载领域导出并交给内核检查和注册，不执行 handler。
 * @param entry 领域入口绝对路径，上游负责静态边界检查。
 * @returns 原模块及注册表；非法声明由 buildRegistry 抛出。
 */
export async function loadRegistry(
  entry: string,
): Promise<{ mod: Record<string, unknown>; registry: Registry }> {
  const mod = await importDomain(entry);
  return { mod, registry: buildRegistry(mod) };
}
