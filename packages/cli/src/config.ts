/**
 * CLI 的应用根目录识别与路径配置装配，所有工具通过本模块取得一致目录约定。
 * 向上寻找 cage.config.json 或依赖 cage-cli 的包清单，再按默认值、package.cage、配置文件顺序合并。
 * 仅执行文件读取和路径解析；不验证配置架构、不加载环境变量，也不把路径解析当成目录访问授权。
 */
// 项目配置：默认值对应模板生成的目录结构，cage.config.json 可以覆盖。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * 各 CLI 职责共用的有效应用配置；相对路径均以 root 为基准。
 * 默认值由 loadConfig 提供，调用方可覆盖布局；本类型不承担配置内容的运行时校验。
 */
export interface CageConfig {
  /** 应用根目录的绝对路径，其余相对路径经 abs 以此解析。 */
  root: string;
  /** 项目显示名称，用于报告与默认图谱标题。 */
  name: string;
  /** domain 包入口：抽取器和内核都从这里读 */
  domain: string;
  /** 前端 SDK 生成目录 */
  contracts: string;
  /** contracts 包名（前端从这里引入） */
  contractsPackage: string;
  /** SQL 迁移及新生成草稿所在目录，不会由配置加载自动执行。 */
  migrations: string;
  /** CLI 托管输出目录，保存派生测试、路由/能力清单与安全层 SQL；迁移草稿写入 migrations。 */
  generated: string;
  /** 开发模式启动 API 的 TypeScript 入口路径。 */
  apiEntry: string;
  /** 开发模式启动 worker 的 TypeScript 入口路径。 */
  workerEntry: string;
  /** 前端应用目录，dev 在此启动配置的开发脚本。 */
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
  graph?: {
    /** 图谱的项目标题，缺省使用 name。 */
    title?: string;
    /** 节点完整 key 到展示名的覆盖，不修改领域声明或权限能力点。 */
    labels?: Record<string, string>;
    /** 本地业务节点缺名时默认警告；required 将命名完整性纳入 check/gen/verify 门禁，不判断业务正确性。 */
    naming?: 'warn' | 'required';
  };
}

/**
 * 沿父目录寻找 Cage 应用根，以配置文件优先，其次识别依赖 CLI 的清单。
 * @param start 起始目录，默认当前工作目录。
 * @returns 首个匹配的绝对目录；到文件系统根仍未匹配时返回原起点。
 * @throws 遇到不可读取或非法 JSON 清单时抛出，不静默忽略损坏配置。
 */
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

/**
 * 加载应用配置并填充标准目录约定，不创建任何目录。
 * @param start 用于向上寻找根目录的可选起点。
 * @returns 默认值被 package.cage 与 cage.config.json 依次覆盖后的配置，root 始终是实际识别根。
 */
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

/**
 * 将配置中的相对路径解析为绝对路径，供各命令一致定位文件。
 * @param cfg 提供 root 的有效配置。
 * @param p 相对或绝对路径；绝对路径按 Node resolve 规则保留。
 * @returns 规范化绝对路径；本函数不限制目录逃逸，也不检查存在性。
 */
export const abs = (cfg: CageConfig, p: string) => resolve(cfg.root, p);
