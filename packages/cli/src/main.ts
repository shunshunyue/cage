// 命令入口只负责参数、输出和退出码；分析、生成、迁移都保留独立公共函数供测试调用。
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, abs } from './config.js';
import { analyze } from './analyze.js';
import { errorsOnly, formatFindings } from './findings.js';
import { generate } from './gen/index.js';
import { verify, testProject } from './verify.js';
import { budget } from './budget.js';
import { sync } from './sync.js';
import { upgrade, VERSION } from './upgrade.js';
import { createApp } from './create.js';
import { migrate } from './migrate.js';
import { dev } from './dev.js';
import { loadBaseline } from './baseline.js';
import { changedFiles, impact, formatImpact } from './impact.js';
import { deriveTests } from './derive.js';
import { installDependencies, run } from './process.js';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from './env.js';
import { database } from './database.js';
import { serveGraph } from './graph.js';

const help = `cage ${VERSION}
  create <目录> [--framework-path 路径]  从 React 模板建项目，可链接本地框架
  dev                              启动本地数据库、API、worker 和 Web
  db setup|up|init|status|down      配置、启动、初始化、查看或停止 Docker 数据库
  analyze | check                  抽取本体 / 检查声明与图规则
  graph [--port 15418]             启动本体图谱 Web 工作台
  gen [--check]                    生成契约、SQL、状态图和迁移草稿
  impact --base <提交>             与 Git 基线比较
  impact --base-file <图.json>     与保存的本体图比较
  test [--only derived|project]    生成并运行派生/项目测试
  verify [--skip-tests]            执行门禁；跳过测试时明确标记不完整
  budget [--base-file <图.json>]   内核与 unsafe 预算
  sync [--check]                   同步 AGENTS.md 托管区
  upgrade [--to 版本] [--dry-run] [--codemods-only]
  migrate [--init]                 执行迁移；init 从环境读取建库凭证
  通用选项：--root <目录> --help --version`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      port: { type: 'string' },
      'framework-path': { type: 'string' },
      base: { type: 'string' },
      'base-file': { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
      only: { type: 'string' },
      to: { type: 'string' },
      check: { type: 'boolean' },
      init: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'codemods-only': { type: 'boolean' },
      'skip-tests': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
  if (o.version) {
    console.log(VERSION);
    return 0;
  }
  const [command, target] = positionals;
  if (o.help || !command) {
    console.log(help);
    return 0;
  }
  if (command === 'create') {
    if (!target) throw new Error('用法：cage create <目录>');
    console.log(
      `已创建 ${createApp(target, o['framework-path'])}\n进入项目后运行 pnpm install、pnpm build:app、pnpm cage gen、pnpm cage dev`,
    );
    return 0;
  }
  const cfg = loadConfig(o.root);
  loadProjectEnv(cfg.root);
  if (command === 'graph') {
    const port = Number(o.port ?? 15418);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port 必须是 0–65535 的整数');
    const { server, url } = await serveGraph(cfg, port);
    console.log(`Cage Atlas 本体图谱：${url}\n项目：${cfg.name}\n在浏览器打开；修改 domain 后点击“重新抽取”。Ctrl+C 关闭图谱服务。`);
    // 服务句柄保持 CLI 存活。终止时关闭连接，避免桌面终端留下监听进程。
    const stop = () => { server.closeAllConnections(); server.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return 0;
  }
  if (command === 'db') return database(cfg, target);
  if (command === 'sync') {
    const findings = sync(cfg, o.check);
    console.log(findings.length ? formatFindings(findings) : '托管区已同步');
    return errorsOnly(findings).length ? 1 : 0;
  }
  if (command === 'upgrade') {
    console.log(
      upgrade(cfg, { to: o.to, dryRun: o['dry-run'], codemodsOnly: o['codemods-only'] }).join('\n') ||
        '没有需要改写的文件',
    );
    if (o['dry-run'] || o['codemods-only']) return 0;
    // 由目标版本 CLI 完成安装、生成和验证。任何一步失败都保留可审查的文件改动，
    // 返回失败，不把“清单已修改”误报为“升级已完成”。
    if (await installDependencies(cfg.root)) return 1;
    const cli = fileURLToPath(new URL('../bin/cage.js', import.meta.url));
    if (await run(cli, ['gen'], cfg.root)) return 1;
    return run(cli, ['verify'], cfg.root);
  }
  if (command === 'dev') return dev(cfg);
  if (command === 'migrate') {
    await migrate(cfg, o.init);
    return 0;
  }
  const base = await loadBaseline(cfg, { base: o.base, baseFile: o['base-file'] });
  if (command === 'verify') return verify(cfg, { base, skipTests: o['skip-tests'] });
  // 框架仓库自身没有 domain 入口，但仍需在 CI 检查内核体积与原语预算。
  if (command === 'budget' && !existsSync(abs(cfg, cfg.domain))) {
    const result = budget(cfg, { version: 1, nodes: [], edges: [], unsafeCount: 0 }, base);
    console.log(JSON.stringify(result.metrics));
    if (result.findings.length) console.log(formatFindings(result.findings));
    return errorsOnly(result.findings).length ? 1 : 0;
  }
  if (!['analyze', 'check', 'gen', 'test', 'budget', 'impact'].includes(command))
    throw new Error(`未知命令 ${command}，运行 cage --help 查看用法`);
  const a = await analyze(cfg, { base, write: command === 'analyze' });
  if (a.findings.length) console.log(formatFindings(a.findings));
  if (!a.graph || !a.registry || errorsOnly(a.findings).length) return 1;
  if (command === 'check' || command === 'analyze') {
    console.log(`声明通过：${a.graph.nodes.length} 个节点，${a.graph.edges.length} 条边`);
    return 0;
  }
  if (command === 'gen') {
    const g = generate(cfg, a.registry, a.graph, a.source.sites, { check: o.check });
    console.log(formatFindings(g.findings) || `生成完成：${g.written.length} 个文件`);
    return errorsOnly(g.findings).length ? 1 : 0;
  }
  if (command === 'budget') {
    const b = budget(cfg, a.graph, base);
    console.log(JSON.stringify(b.metrics));
    if (b.findings.length) console.log(formatFindings(b.findings));
    return errorsOnly(b.findings).length ? 1 : 0;
  }
  if (command === 'test') {
    if (o.only && !['derived', 'project'].includes(o.only))
      throw new Error('--only 只能是 derived 或 project');
    return testProject(cfg, a.graph, o.only as 'derived' | 'project' | undefined);
  }
  if (!base) throw new Error('[CAGE-IMPACT-001] impact 需要 --base 提交 或 --base-file 本体图.json');
  const result = impact(
    base,
    a.graph,
    o.base ? changedFiles(cfg.root, o.base) : [],
    deriveTests(cfg, a.graph).tests,
  );
  const report =
    o.format === 'json'
      ? JSON.stringify({ ...result, reasons: Object.fromEntries(result.reasons) }, null, 2)
      : formatImpact(result, a.graph, {
          base: o.base ?? o['base-file']!,
          format: o.format === 'md' ? 'md' : 'text',
        });
  if (o.out) {
    const file = abs(cfg, o.out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, report + '\n');
  } else console.log(report);
  return errorsOnly(result.findings).length ? 1 : 0;
}
