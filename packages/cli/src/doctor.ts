/**
 * 把源码、生成物、编译产物与可选运行证据汇总为只读状态诊断。
 * 离线阶段重新分析声明并比较生成物；提供 runtimeUrl 时通过受权限保护的 HTTP 接口获取实际进程事实。
 * pass、fail、unknown 明确区分证据结论；本模块不迁移、不授权、不重启服务，也不把历史 verify 报告当成当前验证。
 */
// Status is evidence, not a replacement for verify. Offline inspection never grants access or applies migrations.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readMigrations, SYSTEM_MIGRATIONS } from '@yss123/cage-kernel/db';
import * as kernel from '@yss123/cage-kernel';
import { abs, type CageConfig } from './config.js';
import { analyze } from './analyze.js';
import { generate, routes } from './gen/index.js';
import { errorsOnly, type Finding } from './findings.js';
import { VERSION } from './version.js';
import { loadRegistry } from './load.js';
import { runtimeDiagnostic } from './runtime-diagnostics.js';

/**
 * 单项诊断证据：pass 有支持证据，fail 已发现不一致，unknown 表示未检查或事实不足。
 * 下一步是建议，不会被 doctor 自动执行；detail 只包含本项用于解释的附加数据。
 */
export interface Diagnostic { /** 稳定检查项标识，供 agent 区分生成、构建、运行与授权状态。 */ id: string; /** pass 有证据支持，fail 已发现问题，unknown 表示事实不足。 */ status: 'pass' | 'fail' | 'unknown'; /** 证据来源命令、文件或运行接口说明。 */ source: string; /** 本次诊断采集时间，ISO 8601 字符串，不代表代码最后修改时间。 */ observedAt: string; /** 当前状态及其依据的中文解释。 */ reason: string; /** 建议后续动作；doctor 不执行这些命令。 */ next: string[]; /** 可选原始解释数据，缺省表示本项没有额外明细。 */ detail?: unknown }
/**
 * 运行服务返回的可选事实形状；缺少字段代表证据不足，不用磁盘状态补造。
 */
export interface RuntimeEvidence {
  /** 实际 API 进程报告的框架版本；缺失时无法比较。 */
  version?: string; /** 运行进程加载注册表的指纹，不使用源码指纹冒充。 */ registryHash?: string; /** 运行进程报告的注册加载时间。 */ loadedAt?: string; /** 服务自报的运行角色，用于附加诊断。 */ role?: string;
  /** worker 的版本、注册指纹及就绪/心跳事实；缺失不能解释为未启动。 */
  worker?: { version?: string; registryHash?: string; ready?: boolean; lastHeartbeatAt?: string };
  /** 实例报告的已配置能力点集合，不代表当前主体可执行任意命令。 */
  authorization?: { configuredCapabilities?: string[] };
  /** 实例报告的已执行迁移名称，用于与源码要求比较。 */
  migrations?: { applied?: string[] };
}
/**
 * 收集源码、生成物、构建与可选实际进程状态。
 * @param cfg 应用配置，源与编译入口按标准 src→dist 布局对应。
 * @param options 可提供运行地址、受控 Cookie 文件和测试用 fetch；省略地址只做离线检查。
 * @returns checks、注册链、路由和历史验证；ok 允许 unknown，complete 才要求无 unknown。
 * 运行态连接异常降为 unknown，源码分析或本地文件异常仍可抛出；不修改业务或运行状态。
 */
export async function doctor(cfg: CageConfig, options: { runtimeUrl?: string; cookieFile?: string; fetch?: typeof fetch } = {}) {
  const observedAt = new Date().toISOString();
  const checks: Diagnostic[] = [];
  const add = (id: string, status: Diagnostic['status'], source: string, reason: string, next: string[], detail?: unknown) => checks.push({ id, status, source, observedAt, reason, next, detail });
  const result = await analyze(cfg, { registration: true });
  const findings: Finding[] = [...result.findings];
  add('registered', result.registry && !errorsOnly(result.findings).length ? 'pass' : 'fail', 'analyze/check', '静态声明、导出、注册与图规则', ['cage check'], result.findings);
  let generated: Finding[] = [];
  if (result.registry && result.graph) {
    generated = generate(cfg, result.registry, result.graph, result.source.sites, { check: true }).findings;
    findings.push(...generated);
    add('generated', errorsOnly(generated).length ? 'fail' : 'pass', 'gen --check', '契约及迁移草稿与声明的一致性', ['cage gen --check', 'cage gen，然后审查差异'], generated);
  } else add('generated', 'unknown', 'gen --check', '声明失败，无法比较生成物', ['cage check']);
  const sourceHash = result.registry ? kernel.registryFingerprint(result.registry) : undefined;
  const compiledEntry = /([\\/])src([\\/])/.test(cfg.domain) ? cfg.domain.replace(/([\\/])src([\\/])/, '$1dist$2').replace(/\.tsx?$/, '.js') : '';
  const compiledExists = !!compiledEntry && existsSync(abs(cfg, compiledEntry));
  const stale = result.source.files.filter(file => {
    const compiled = file.replace(/([\\/])src([\\/])/, '$1dist$2').replace(/\.tsx?$/, '.js');
    return compiled !== file && (!existsSync(abs(cfg, compiled)) || statSync(abs(cfg, file)).mtimeMs > statSync(abs(cfg, compiled)).mtimeMs);
  });
  let registryHash: string | undefined;
  if (compiledExists) registryHash = kernel.registryFingerprint((await loadRegistry(abs(cfg, compiledEntry))).registry);
  else if (/\.js$/.test(cfg.domain)) registryHash = sourceHash;
  add('build', compiledExists ? stale.length ? 'fail' : 'pass' : 'unknown', compiledEntry || 'not-inspected', compiledExists ? '源码与对应编译产物的新鲜度；运行指纹使用实际编译产物' : '缺少标准 src→dist 编译入口；非标准布局不猜测输出目录', ['构建 domain、API 与 worker 后重启进程'], { stale });
  let runtime: RuntimeEvidence | undefined;
  let runtimeReason = '未提供 --runtime-url，未检查运行进程或数据库';
  if (options.runtimeUrl) {
    try {
      const response = await runtimeDiagnostic(cfg, options, '/api/sys/diagnostics');
      if (!response.ok) runtimeReason = `运行证据不可读取（HTTP ${response.status}），需要 Sys.ops.read`;
      else runtime = response.data as RuntimeEvidence;
    } catch { runtimeReason = '运行证据不可读取；检查服务、地址和受控凭证文件'; }
  }
  const source = options.runtimeUrl ? 'GET /api/sys/diagnostics' : 'not-inspected';
  const extensions = result.registry?.systemDdl.map((sql, index) => `cage:ext_${createHash('sha256').update(sql).digest('hex').slice(0, 16)}_${index}`) ?? [];
  const migrations = [...SYSTEM_MIGRATIONS.map(m => m.name), ...extensions, ...(result.registry?.systemMigrations.map(m => m.name) ?? []), ...readMigrations(abs(cfg, cfg.migrations)).map(m => m.name)];
  const applied = runtime?.migrations?.applied;
  const pending = applied ? migrations.filter(name => !applied.includes(name)) : undefined;
  add('migration', pending ? pending.length ? 'fail' : 'pass' : 'unknown', source, pending ? `${pending.length} 个未执行项目迁移` : runtimeReason, ['审查迁移后显式 cage migrate'], { files: migrations, pending });
  const configured = runtime?.authorization?.configuredCapabilities;
  const roleRequired = result.registry ? new Set([
    ...result.registry.commands.filter(c => c.cmd.invokedBy.includes('user')).map(c => c.capability),
    ...result.registry.aggregates.map(a => `${a.name}.read`),
    ...result.registry.approvals.flatMap(({ a }) => [result.registry!.capabilityOf(a.onApproved), result.registry!.capabilityOf(a.onRejected), ...(a.onReturned ? [result.registry!.capabilityOf(a.onReturned)] : [])]),
  ]) : undefined;
  const missing = configured && roleRequired ? [...roleRequired].filter(c => !configured.includes(c)) : undefined;
  add('authorization', missing ? missing.length ? 'fail' : 'pass' : 'unknown', source, missing ? '检查用户入口、读取和审批结论是否配置角色；内部任务命令不要求授予用户' : runtimeReason, ['管理员按角色和数据范围配置业务授权'], { unconfigured: missing, optionalUnconfigured: configured && result.registry?.capabilityCatalog().filter(c => !roleRequired?.has(c.capability) && !configured.includes(c.capability)).map(c => c.capability) });
  const matching = (version?: string, hash?: string) => version && hash && registryHash ? version === VERSION && hash === registryHash ? 'pass' as const : 'fail' as const : 'unknown' as const;
  add('api', matching(runtime?.version, runtime?.registryHash), source, runtime ? '比较实际 API 版本与注册指纹' : runtimeReason, ['构建并重启 API/worker，重新获取运行证据'], runtime && { version: runtime.version, registryHash: runtime.registryHash, loadedAt: runtime.loadedAt });
  add('worker', runtime?.worker?.ready === false ? 'fail' : matching(runtime?.worker?.version, runtime?.worker?.registryHash), source, runtime?.worker ? '比较 worker 就绪、版本与注册指纹' : runtimeReason, ['检查 worker 心跳、消费者就绪与实际加载版本'], runtime?.worker);
  const registration = result.source.sites.map(site => ({ declaration: { name: site.exportName, kind: site.primitive, file: site.file, line: site.line }, domainEntry: cfg.domain,
    exports: result.registration?.find(entry => entry.name === site.exportName && entry.file === site.file),
    registered: !result.findings.some(f => f.code === 'CAGE-DECL-002' && f.at === `${site.file}:${site.line}`),
    nodes: result.graph?.nodes.filter(n => n.file === site.file && n.line === site.line).map(n => ({ key: `${n.kind}:${n.id}`, attrs: n.kind === 'reaction' ? { event: n.attrs.event, command: n.attrs.command, tx: n.attrs.tx, order: n.attrs.order, collection: n.attrs.collection } : undefined })) ?? [] }));
  const verifyFile = abs(cfg, '.cage/verify.json');
  return { schemaVersion: 1, cliVersion: VERSION, observedAt, project: cfg.name, registryHash, sourceHash, registryHashSource: compiledExists ? compiledEntry : /\.js$/.test(cfg.domain) ? cfg.domain : null, ok: checks.every(c => c.status !== 'fail'), complete: checks.every(c => c.status !== 'unknown'), checks, findings, registration,
    routes: result.registry ? routes(result.registry) : [], previousVerification: existsSync(verifyFile) ? JSON.parse(readFileSync(verifyFile, 'utf8')) : null,
    limitations: ['已有 verify 报告只代表过去一次执行，不证明当前代码已验证。', '未检查的依赖标为 unknown。doctor 不执行迁移、测试、授权或重启进程。'] };
}
