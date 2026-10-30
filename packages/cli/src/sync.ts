import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { abs, type CageConfig } from './config.js';
import type { Finding } from './findings.js';
import { VERSION } from './version.js';

export const managedBlock = `<!-- cage:begin v${VERSION} -->
## Cage 框架约定

1. 先声明聚合、状态、命令、约束和事件，再实现 handler、查询与页面。
2. 修改后运行 cage check、cage gen、cage verify；用 cage impact --base-file 旧本体图.json 查看影响。
3. domain 的声明必须是模块顶层 export const，并从 index.ts 导出。
4. handler 的读依赖写入 reads；写入只走命令，第三方 IO 通过连接器。
5. 前端从 @app/contracts 导入契约；生成物通过 cage gen 更新。
6. 不得手写 HTTP 路由、拼接 SQL 或嵌入密钥；unsafe 必须注明 reason、owner。
7. 迁移草稿需审查，已发布的迁移不可修改；新增能力点由管理员授权。
8. 错误码见 docs/errors；完整示例见框架仓库 examples/purchase-admin。
<!-- cage:end -->`;

export function syncManagedBlock(current: string, latest = managedBlock): string {
  const starts = [...current.matchAll(/<!-- cage:begin[^\n]*-->/g)];
  const ends = [...current.matchAll(/<!-- cage:end -->/g)];
  if (!starts.length && !ends.length) return latest + '\n\n' + current;
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index! < starts[0].index!) {
    throw new Error('[CAGE-SYNC-001] 托管区标记不完整或重复，请修复 AGENTS.md 的 begin/end 标记');
  }
  return current.slice(0, starts[0].index) + latest + current.slice(ends[0].index! + ends[0][0].length);
}

export function sync(cfg: CageConfig, check = false): Finding[] {
  const file = abs(cfg, 'AGENTS.md');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const after = syncManagedBlock(before);
  if (after === before) return [];
  if (check)
    return [
      {
        code: 'CAGE-SYNC-001',
        at: 'AGENTS.md',
        reason: '框架托管区需要同步',
        fix: '运行 cage sync；项目自有内容会保留',
      },
    ];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, after);
  return [];
}
