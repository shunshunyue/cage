// 用 tsx 直接导入 domain 包入口。声明都在模块顶层，导入就是全部，不需要运行任何业务逻辑。
import { pathToFileURL } from 'node:url';
import { buildRegistry, type Registry } from '@yss123/cage-kernel';
import { register } from 'tsx/esm/api';

let registered = false;

export async function importDomain(entry: string): Promise<Record<string, unknown>> {
  if (!registered) {
    register();
    registered = true;
  }
  return (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
}

export async function loadRegistry(
  entry: string,
): Promise<{ mod: Record<string, unknown>; registry: Registry }> {
  const mod = await importDomain(entry);
  return { mod, registry: buildRegistry(mod) };
}
