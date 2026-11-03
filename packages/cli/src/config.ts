// 项目配置：默认值对应模板生成的目录结构，cage.config.json 可以覆盖。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface CageConfig {
  root: string;
  name: string;
  /** domain 包入口：抽取器和内核都从这里读 */
  domain: string;
  /** 前端 SDK 生成目录 */
  contracts: string;
  /** contracts 包名（前端从这里引入） */
  contractsPackage: string;
  migrations: string;
  generated: string;
  apiEntry: string;
  workerEntry: string;
  web: string;
  /** 需要类型检查的目录（各自有 tsconfig.json） */
  typecheck: string[];
  /** lint 与依赖规则检查的目录 */
  lint: string[];
  /** 新脚手架启用模块目录约束；旧项目可整理后显式开启，不因升级 CLI 被迫迁移。 */
  structure?: 'modular';
  /** 图谱的显示文案独立于业务标识；键为“节点类型:节点 ID”，板块标题可用
   * “module:模块目录名”，审批角色使用“role:角色编码”。不影响路由、数据表、能力点和影响分析。
   * 可用短标题覆盖较长的声明 description。 */
  graph?: { title?: string; labels?: Record<string, string> };
}

export function findRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'cage.config.json'))) return dir;
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      const j = JSON.parse(readFileSync(pkg, 'utf8'));
      if (j.devDependencies?.['@yss123/cage-cli'] || j.dependencies?.['@yss123/cage-cli'] || j.cage)
        return dir;
    }
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
}

export function loadConfig(start?: string): CageConfig {
  const root = findRoot(start);
  const file = join(root, 'cage.config.json');
  const user = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const pkg = existsSync(join(root, 'package.json'))
    ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    : {};
  const c = {
    name: pkg.name ?? 'cage-app',
    domain: 'packages/domain/src/index.ts',
    contracts: 'packages/contracts/src',
    contractsPackage: '@app/contracts',
    migrations: 'db/migrations',
    generated: 'generated',
    apiEntry: 'apps/api/src/main.ts',
    workerEntry: 'apps/api/src/worker.ts',
    web: 'apps/web',
    typecheck: ['packages/domain', 'packages/contracts', 'apps/api', 'apps/web'],
    lint: ['packages/domain/src', 'apps/api/src', 'apps/web/src'],
    ...pkg.cage,
    ...user,
  };
  return { ...c, root };
}

export const abs = (cfg: CageConfig, p: string) => resolve(cfg.root, p);
