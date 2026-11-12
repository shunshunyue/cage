/**
 * Cage 命令行总入口，负责参数解析、按需加载、输出和退出状态。
 * 先处理帮助与创建，再分发无需环境变量的查询，其他命令加载项目 .env 后调用各职责模块。
 * 不在入口复制领域运行规则；命令 IO、副作用和是否可只读由分支决定，异常由 bin 包装器转为失败退出。
 */
// 命令入口只负责参数、输出和退出码；分析、生成、迁移都保留独立公共函数供测试调用。
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, abs } from './config.js';
import { errorsOnly, formatFindings } from './findings.js';
import { VERSION } from './version.js';
import { installDependencies, run } from './process.js';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from './env.js';
import { createHash } from 'node:crypto';

const help = `cage ${VERSION}
  create [目录] [--template blank|purchase]  交互选择空白业务项目或采购示例
    --framework-path <路径>        链接已构建的本地框架，无需先发 npm
  init                             用管理员连接初始化已有数据库的账号权限，自动填写 .env
  bootstrap --credentials-file <新文件>  显式初始化组织；凭据仅写入受限文件
  capabilities [关键词] --format json   查询当前安装版本的公开签名与指南
  doctor [--runtime-url URL]       只读状态诊断；未检查的运行证据标为 unknown
  timeline --request-id ID         查询实际异步记录；需 --runtime-url 与受控 Cookie 文件
  explain <命令> --input-file JSON  解释授权；不执行命令，不写业务数据
  snapshot save <名称> | list      保存不可覆盖的命名基线
  dev                              连接项目 .env 配置的数据库，启动 API、worker 和 Web
  analyze | check                  抽取本体 / 检查目录、声明与图规则
  graph [--port 15418]             启动本体图谱 Web 工作台
  graph search <关键词>           中文/标识检索；--kind 类型 --limit 10
  graph inspect <节点>             节点详情、关联原因与源码位置
  graph path <起点> <终点>        最短关系链；--direction out|both --depth 6
  context <需求或节点>            AI 业务上下文；--depth 3 --limit 40
    查询输出：--format md|json --out <文件>；默认 Markdown，每次重新抽取
  gen [--check]                    生成契约、SQL、状态图和迁移草稿
  impact --base <提交>             与 Git 基线比较
  impact --base-file <图.json>     与保存的本体图比较
  impact --snapshot <名称>         与命名基线比较
  test [--only derived|project]    生成并运行派生/项目测试
  verify [--skip-tests]            执行门禁；跳过测试时明确标记不完整
  budget [--base-file <图.json>]   内核与 unsafe 预算
  sync [--check]                   同步 AGENTS.md 托管区
  upgrade [--to 版本] [--dry-run] [--codemods-only]
  migrate                          在已配置的数据库中执行表结构迁移，不创建数据库
  通用选项：--root <目录> --help --version`;

/**
 * 解析命令并分发职责模块，供两个 bin 包装器复用。
 * @param argv 不含 Node 与脚本路径的参数，默认 process.argv.slice(2)。
 * @returns 命令退出码；doctor 的 2 表示无失败但证据不完整，取消创建返回 130。
 * @throws 参数、配置和子模块异常交给 bin 处理；不强制退出进程，graph/dev 的句柄保持运行。
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      port: { type: 'string' },
      depth: { type: 'string' },
      limit: { type: 'string' },
      kind: { type: 'string' },
      direction: { type: 'string' },
      'framework-path': { type: 'string' },
      template: { type: 'string' },
      base: { type: 'string' },
      'base-file': { type: 'string' },
      snapshot: { type: 'string' },
      'runtime-url': { type: 'string' },
      'cookie-file': { type: 'string' },
      'credentials-file': { type: 'string' },
      'request-id': { type: 'string' },
      'outbox-id': { type: 'string' },
      aggregate: { type: 'string' },
      'aggregate-id': { type: 'string' },
      'input-file': { type: 'string' },
      'user-id': { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
      only: { type: 'string' },
      to: { type: 'string' },
      check: { type: 'boolean' },
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
    // 帮助、版本和参数错误不加载 TypeScript、codemod、lint 与数据库工具。
    // 只在执行相应命令时加载，保持独立安装后的启动时间可控。
    const { appTemplates, createApp } = await import('./create.js');
    const { chooseApp } = await import('./create-prompt.js');
    const selected = await chooseApp(target, o.template);
    if (!selected) return 130;
    const created = createApp(selected.target, o['framework-path'], selected.template);
    console.log(
      `已创建${appTemplates[selected.template].label}：${created}\n进入项目后：\n  1. pnpm install\n  2. 复制 .env.example 为 .env，只填写 CAGE_ADMIN_DATABASE_URL，连接已有 PostgreSQL\n  3. pnpm exec cage init（自动创建账号、生成密码并填写 .env）\n  4. pnpm build:app && pnpm gen\n  5. 审查迁移后 pnpm migrate\n  6. pnpm exec cage bootstrap --credentials-file .cage/admin-credentials.json\n  7. pnpm dev\n学习：docs/development/getting-started/start.md；按 docs/development/README.md 选择教程或任务。\nAI 开发：读取项目 AGENTS.md 和本地 Cage Skill；错误码见 docs/errors。\n框架不创建数据库、不管理 Docker。cage 是项目内命令，单独调用使用 pnpm exec cage。`,
    );
    return 0;
  }
  if (
    ![
      'init',
      'bootstrap',
      'capabilities',
      'doctor',
      'timeline',
      'explain',
      'snapshot',
      'graph',
      'context',
      'sync',
      'upgrade',
      'dev',
      'migrate',
      'verify',
      'analyze',
      'check',
      'gen',
      'test',
      'budget',
      'impact',
    ].includes(command)
  )
    throw new Error(`未知命令 ${command}，运行 cage --help 查看用法`);
  const cfg = loadConfig(o.root);
  const output = (value: unknown) => {
    const json = JSON.stringify(value, null, 2);
    const content = o.format === 'md' ? `# Cage ${command}\n\n\`\`\`json\n${json}\n\`\`\`\n` : json + '\n';
    if (o.out) { const file = abs(cfg, o.out); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); }
    else console.log(content.trimEnd());
  };
  if (command === 'capabilities') {
    output((await import('./capabilities.js')).publicCapabilities(cfg, positionals.slice(1).join(' ')));
    return 0;
  }
  if (command === 'timeline' || command === 'explain') {
    if (command === 'explain' && (!target || !o['input-file'])) throw new Error('[CAGE-DIAG-001] 使用 cage explain <命令> --input-file <JSON文件> --runtime-url <地址> --cookie-file <文件>');
    const body = command === 'explain' ? { command: target, input: JSON.parse(readFileSync(abs(cfg, o['input-file']!), 'utf8')), userId: o['user-id'] } : undefined;
    const result = await (await import('./runtime-diagnostics.js')).runtimeDiagnostic(cfg, { runtimeUrl: o['runtime-url'], cookieFile: o['cookie-file'] }, `/api/sys/diagnostics/${command === 'timeline' ? 'timeline' : 'authorization'}`, {
      query: command === 'timeline' ? { requestId: o['request-id'], outboxId: o['outbox-id'], aggregate: o.aggregate, aggregateId: o['aggregate-id'] } : undefined, body,
    });
    output(result);
    return result.ok ? 0 : 1;
  }
  if (command === 'doctor') {
    const report = await (await import('./doctor.js')).doctor(cfg, { runtimeUrl: o['runtime-url'], cookieFile: o['cookie-file'] });
    output(report);
    return report.ok ? report.complete ? 0 : 2 : 1;
  }
  if (command === 'snapshot') {
    const snapshots = await import('./snapshots.js');
    if (target === 'save' && positionals[2]) {
      const { graph, ...metadata } = await snapshots.saveSnapshot(cfg, positionals[2]);
      output(metadata);
    }
    else if (target === 'list') output(snapshots.listSnapshots(cfg).map(({ graph, ...metadata }) => metadata));
    else throw new Error('使用 cage snapshot save <名称> 或 cage snapshot list');
    return 0;
  }
  // 查询只分析声明，无需加载项目密钥或连接数据库；每次在独立进程重新抽取。
  if (command === 'context' || (command === 'graph' && target)) {
    const action = command === 'context' ? 'context' : target;
    if (command === 'graph' && !['search', 'inspect', 'path'].includes(action))
      throw new Error('graph 子命令只能是 search、inspect、path；启动 Web 图谱直接执行 cage graph');
    return (await import('./graph-command.js')).graphCommand(
      cfg,
      action as 'context' | 'search' | 'inspect' | 'path',
      positionals.slice(command === 'context' ? 1 : 2),
      o,
    );
  }
  loadProjectEnv(cfg.root);
  if (command === 'bootstrap') {
    const result = await (await import('./bootstrap.js')).bootstrapOrganization(cfg, o['credentials-file'] ?? '');
    console.log(`${result.created ? '组织初始化完成' : '组织已存在，账号保持原样'}；结果已写入 ${result.credentialsFile}。普通角色的业务能力与范围需显式授权。`);
    return 0;
  }
  if (command === 'init') {
    const { initProject } = await import('./init.js');
    const result = await initProject(cfg);
    console.log(
      result.status === 'created'
        ? `账号和权限已初始化，随机凭证已写入 ${result.envFile}；管理员连接已从文件移除。`
        : `已有账号配置已验证，保留原密码：${result.envFile}`,
    );
    console.log('下一步：pnpm build:app、pnpm gen，审查迁移后 pnpm migrate；首次再 bootstrap 交付凭据，最后 pnpm dev。');
    return 0;
  }
  if (command === 'graph') {
    const { serveGraph } = await import('./graph.js');
    const port = Number(o.port ?? 15418);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port 必须是 0–65535 的整数');
    const { server, url } = await serveGraph(cfg, port);
    console.log(
      `Cage Atlas 本体图谱：${url}\n项目：${cfg.name}\n在浏览器打开；修改 domain 后点击“重新抽取”。Ctrl+C 关闭图谱服务。`,
    );
    // 服务句柄保持 CLI 存活。终止时关闭连接，避免桌面终端留下监听进程。
    const stop = () => {
      server.closeAllConnections();
      server.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return 0;
  }
  if (command === 'sync') {
    const { sync } = await import('./sync.js');
    const findings = sync(cfg, o.check);
    console.log(findings.length ? formatFindings(findings) : '托管区已同步');
    return errorsOnly(findings).length ? 1 : 0;
  }
  if (command === 'upgrade') {
    const { upgrade } = await import('./upgrade.js');
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
  if (command === 'dev') return (await import('./dev.js')).dev(cfg);
  if (command === 'migrate') {
    await (await import('./migrate.js')).migrate(cfg);
    return 0;
  }
  const { loadBaseline } = await import('./baseline.js');
  const baseFile = o.snapshot ? (await import('./snapshots.js')).snapshotPath(cfg, o.snapshot) : o['base-file'];
  const base = await loadBaseline(cfg, { base: o.base, baseFile });
  if (command === 'verify')
    return (await import('./verify.js')).verify(cfg, { base, skipTests: o['skip-tests'] });
  // 框架仓库自身没有 domain 入口，但仍需在 CI 检查内核体积与原语预算。
  if (command === 'budget' && !existsSync(abs(cfg, cfg.domain))) {
    const { budget } = await import('./budget.js');
    const result = budget(cfg, { version: 1, nodes: [], edges: [], unsafeCount: 0 }, base);
    console.log(JSON.stringify(result.metrics));
    if (result.findings.length) console.log(formatFindings(result.findings));
    return errorsOnly(result.findings).length ? 1 : 0;
  }
  const { analyze } = await import('./analyze.js');
  const a = await analyze(cfg, { base, write: command === 'analyze' });
  if (a.findings.length) console.log(formatFindings(a.findings));
  if (!a.graph || !a.registry || errorsOnly(a.findings).length) return 1;
  if (command === 'check' || command === 'analyze') {
    console.log(`声明通过：${a.graph.nodes.length} 个节点，${a.graph.edges.length} 条边`);
    return 0;
  }
  if (command === 'gen') {
    const { generate } = await import('./gen/index.js');
    const g = generate(cfg, a.registry, a.graph, a.source.sites, { check: o.check });
    console.log(formatFindings(g.findings) || `生成完成：${g.written.length} 个文件`);
    return errorsOnly(g.findings).length ? 1 : 0;
  }
  if (command === 'budget') {
    const { budget } = await import('./budget.js');
    const b = budget(cfg, a.graph, base);
    console.log(JSON.stringify(b.metrics));
    if (b.findings.length) console.log(formatFindings(b.findings));
    return errorsOnly(b.findings).length ? 1 : 0;
  }
  if (command === 'test') {
    if (o.only && !['derived', 'project'].includes(o.only))
      throw new Error('--only 只能是 derived 或 project');
    return (await import('./verify.js')).testProject(
      cfg,
      a.graph,
      o.only as 'derived' | 'project' | undefined,
    );
  }
  if (!base) throw new Error('[CAGE-IMPACT-001] impact 需要 --base 提交 或 --base-file 本体图.json');
  const { changedFiles, impact, formatImpact } = await import('./impact.js');
  const { deriveTests } = await import('./derive.js');
  const result = impact(
    base,
    a.graph,
    o.base ? changedFiles(cfg.root, o.base) : [],
    deriveTests(cfg, a.graph).tests,
  );
  const saved = o.snapshot ? (await import('./snapshots.js')).readSnapshot(cfg, o.snapshot) : undefined;
  const comparison = {
    base: { source: o.base ?? (o.snapshot ? `snapshot:${o.snapshot}` : baseFile), graphHash: createHash('sha256').update(JSON.stringify(base)).digest('hex'), createdAt: saved?.createdAt, frameworkVersion: saved?.frameworkVersion },
    head: { extractedAt: new Date().toISOString(), frameworkVersion: VERSION, graphHash: createHash('sha256').update(JSON.stringify(a.graph)).digest('hex') },
  };
  const report =
    o.format === 'json'
      ? JSON.stringify({ ...result, comparison, reasons: Object.fromEntries(result.reasons) }, null, 2)
      : `比较基线 ${comparison.base.source}（${comparison.base.graphHash.slice(0, 12)}${saved ? `，${saved.createdAt}` : ''}）→ 当前图（${comparison.head.graphHash.slice(0, 12)}，${comparison.head.extractedAt}）\n` + formatImpact(result, a.graph, {
          base: o.base ?? (o.snapshot ? `snapshot:${o.snapshot}` : baseFile!),
          format: o.format === 'md' ? 'md' : 'text',
        });
  if (o.out) {
    const file = abs(cfg, o.out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, report + '\n');
  } else console.log(report);
  return errorsOnly(result.findings).length ? 1 : 0;
}
