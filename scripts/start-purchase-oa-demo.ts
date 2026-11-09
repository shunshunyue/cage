/**
 * 为采购示例的浏览器逐项验收启动独立 OA 演示：真实应用声明、迁移、PostgreSQL、API、worker 和构建后的 Web。
 * 本脚本先构建应用，再通过组织/业务命令准备角色、协作名录、库存及场景草稿；不读取或改写应用 .env。
 * AI 使用真实应用配置且不植入测试模型：未配置 main 会按原路由失败转人工，不能据此声称 AI 判断通过。
 * ERP 明确使用 fake 连接器，验证范围是本地采购审批与库存生命周期；所有随机凭据只写新建受限文件。
 * stop 文件或进程信号结束本次运行并清理隔离数据库；保留静态页面快照、场景说明与运行信息便于核对。
 * CAGE_DEMO_APPROVAL_OPERATIONS=1 仅在本次隔离装配中接入框架时效声明（2 分钟/提前 1 分钟）；不修改采购源码或业务表结构。
 * CAGE_DEMO_PARALLEL=1 使用框架并行声明装配采购专业/财务会审，跳过 AI 以聚焦人工分支；所有草稿仍由页面提交。
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createTestEnv, startEmbeddedPostgres, type TestEnv, type TestUser, type PgInstance } from '../packages/testkit/dist/index.js';
import { readMigrations } from '../packages/kernel/dist/db/index.js';
import { startWorker } from '../packages/http/dist/worker.js';
import { createServer, type CageServer } from '../packages/http/dist/index.js';
import { fakeConnector } from '../packages/connectors/dist/index.js';
import { protectCredentialFile } from '../packages/cli/dist/bootstrap.js';
import { approval, businessProcess, type BusinessStage } from '../packages/kernel/dist/index.js';
import { approvalOperations, approver, branch, eq, parallel, route, step, when, type RouteNode, type ApprovalStep } from '../packages/approval/dist/index.js';

/** 场景角色标识只用于本次造数和凭据索引；真实权限始终来自组织命令授予的角色。 */
type ActorKey = 'buyer' | 'manager' | 'backup' | 'technical' | 'quality' | 'financeA' | 'financeB' | 'noAccess' | 'lowCeiling';
/** 场景草稿的业务配置；金额单位为元，专业名单最多取已登记的技术和质量两位真实用户。 */
interface Scenario {
  /** 普通运行信息中的稳定索引，方便验收记录引用。 */
  key: string;
  /** 用途开头展示的中文场景名，实际采购列表无需额外测试字段即可识别。 */
  title: string;
  /** 十进制人民币元字符串；不使用浮点数构造阈值。 */
  amount: string;
  /** true 预先配置两人专业会签，缺省为普通经理/财务路由。 */
  specialists?: boolean;
  /** 供验收人员按真实账号执行的步骤提示，不代替实际操作结果。 */
  instructions: string;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.cage', `purchase-oa-demo-${Date.now()}`);
const stopFile = join(output, 'stop');
let pg: PgInstance | undefined;
let env: TestEnv | undefined;
let server: CageServer | undefined;
let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
let stopTimer: ReturnType<typeof setInterval> | undefined;
let closing: Promise<void> | undefined;
/** 仅记录固定阶段名用于失败定位，不打印连接串、命令输入或随机凭据。 */
let setupStage = 'build';

/**
 * 构建本次浏览器实际使用的应用，框架包仍要求事先完成 pnpm build。
 * 命令为固定字面量，不拼接用户输入；Windows 隐藏辅助终端，构建失败会在启动数据库前退出。
 */
async function buildApplication(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', 'pnpm --filter @app/purchase-admin build:app'], { cwd: root, stdio: 'inherit', windowsHide: true })
      : spawn('pnpm', ['--filter', '@app/purchase-admin', 'build:app'], { cwd: root, stdio: 'inherit' });
    child.once('error', () => reject(new Error('应用构建进程未能启动')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('应用构建失败，请先修复构建诊断')));
  });
}

/**
 * 停止本脚本拥有的资源，重复触发时复用同一关闭 Promise。
 * 按 worker/API/测试库/PostgreSQL 顺序释放；单项失败仍尝试其余清理，并最终显式报告失败。
 */
function close(): Promise<void> {
  closing ??= (async () => {
    if (stopTimer) clearInterval(stopTimer);
    const failures: unknown[] = [];
    for (const release of [() => worker?.stop(), () => server?.close(), () => env?.close(), () => pg?.stop()]) {
      try { await release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new Error('演示资源未全部关闭，请检查本次隔离实例的进程状态');
  })();
  return closing;
}

/**
 * 以真实命令准备环境并等待人工验收完成；本函数不自动提交或审批任何场景草稿。
 * 运行信息不包含密码、连接串或加密密钥，启动中断仍由最外层 finally 清理已创建资源。
 */
async function main(): Promise<void> {
  const port = Number(process.env.CAGE_DEMO_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CAGE_DEMO_PORT 必须是 1–65535 的整数');
  await buildApplication();
  setupStage = 'declarations';
  // 动态导入放在构建完成之后，避免 Node 提前缓存旧的领域产物。
  const sourceDomain = await import('../examples/purchase-admin/packages/domain/dist/index.js');
  const parallelEnabled = process.env.CAGE_DEMO_PARALLEL === '1';
  const operationsEnabled = process.env.CAGE_DEMO_APPROVAL_OPERATIONS === '1' || parallelEnabled;
  /**
   * 验收装配只给现有人工节点声明框架 SLA，保留分支、选人、签序和 AI 原有行为。
   * 用自然时间等待提醒，不修改 due_at 或伪造 worker 时钟；生产项目自行选择时限并导出运行时。
   */
  const timedStep = (node: ApprovalStep): ApprovalStep => node.kind === 'ai' ? node : step(node.title, node.approver, {
    mode: node.mode, assignment: node.assignment, actions: node.actions, sla: { durationMinutes: 2, remindBeforeMinutes: 1 },
  });
  /** 递归接入 SLA，容器结构保持原声明；这只是配置转换，不实现分支调度或写流程状态。 */
  const timedNodesOf = (nodes: readonly RouteNode[]): RouteNode[] => nodes.map(node => node.kind === 'when'
    ? { ...node, steps: timedNodesOf(node.steps) } : node.kind === 'parallel'
      ? { ...node, branches: node.branches.map(item => ({ ...item, nodes: timedNodesOf(item.nodes) })) } : timedStep(node));
  const actions = { transfer: true, delegate: true, addSign: true };
  /** 专业与财务分支同时运行，财务自身两步；汇合后的经理终审仍走采购额度/职责分离及库存命令。 */
  const parallelNodes: RouteNode[] = [
    step('部门经理审批', approver.deptLeader('deptId'), { actions }),
    parallel('采购联合会审',
      branch('技术与质量', when(eq('needsSpecialistReview', true), step('专业人员会签', approver.field('reviewerIds'), { mode: 'all', actions }))),
      branch('财务评审', step('财务候选受理', approver.role('finance'), { assignment: 'candidate', actions }),
        step('财务复核', approver.role('oa_finance_recheck'), { actions }))),
    step('采购负责人终审', approver.deptLeader('deptId'), { actions }),
  ];
  const timedNodes = timedNodesOf(parallelEnabled ? parallelNodes : sourceDomain.poRoute.nodes);
  const sourceApproval = sourceDomain.poApproval;
  const timedApproval = operationsEnabled ? approval(sourceApproval.agg, { ...sourceApproval, cancelOn: [...sourceApproval.cancelOn],
    routable: [...sourceApproval.routable, 'createdBy'] }) : sourceApproval;
  const domain = { ...sourceDomain, ...(operationsEnabled ? {
    approvalOps: approvalOperations(),
    poApproval: timedApproval,
    poRoute: route(sourceDomain.poRoute.process, timedNodes, { reminders: { requesterField: 'createdBy', cooldownMinutes: 1 } }),
    // 阅读规格也必须引用本次装配的真实审批对象；不保留指向未导出旧绑定的悬空证据。
    purchaseLifecycle: businessProcess<Record<string, BusinessStage>>(sourceDomain.purchaseLifecycle.name, { ...sourceDomain.purchaseLifecycle,
      stages: { ...sourceDomain.purchaseLifecycle.stages, approval: { ...sourceDomain.purchaseLifecycle.stages.approval, action: timedApproval } } }),
  } : {}) };
  await mkdir(output, { recursive: true });
  const credentialsFile = join(output, 'credentials.json');
  protectCredentialFile(credentialsFile);
  process.env.CAGE_AI_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.CAGE_COOKIE_SECRET = randomBytes(32).toString('base64url');
  process.env.CAGE_STAGE = 'fake';
  setupStage = 'postgres';
  pg = await startEmbeddedPostgres();
  // 显式覆盖仅当前进程的测试连接，createTestEnv 不会意外采用外部已设置的测试/应用库。
  process.env.CAGE_TEST_SUPER_URL = pg.superUrl;
  setupStage = 'migrations';
  const session = await createTestEnv({ domain, migrations: readMigrations(join(root, 'examples/purchase-admin/db/migrations')) });
  env = session;
  setupStage = 'accounts';
  const scopes = { PurchaseOrder: 'all', Inventory: 'all', ApprovalMember: 'all' };
  const approvalCaps = ['PurchaseOrder.read', 'PurchaseOrder.approve', 'PurchaseOrder.reject', 'PurchaseOrder.returnForChanges', 'ApprovalMember.read', 'Inventory.read'];
  const specs: { key: ActorKey; username: string; name: string; specialty?: string; ceiling?: number }[] = [
    { key: 'buyer', username: 'oa.buyer', name: '采购申请人' },
    { key: 'manager', username: 'oa.manager', name: '采购部门经理', specialty: '部门审核', ceiling: 100000 },
    { key: 'backup', username: 'oa.backup', name: '备选审批人', specialty: '采购综合审核', ceiling: 100000 },
    { key: 'technical', username: 'oa.technical', name: '技术复核人', specialty: '设备技术复核', ceiling: 100000 },
    { key: 'quality', username: 'oa.quality', name: '质量复核人', specialty: '采购质量复核', ceiling: 100000 },
    { key: 'financeA', username: 'oa.finance.a', name: '财务甲', specialty: '财务共享受理', ceiling: 100000 },
    { key: 'financeB', username: 'oa.finance.b', name: '财务乙', specialty: '财务共享受理', ceiling: 100000 },
    { key: 'noAccess', username: 'oa.no-access', name: '无业务权限用户' },
    { key: 'lowCeiling', username: 'oa.low-ceiling', name: '低额度审批人', specialty: '小额采购审核（限1000元）', ceiling: 1000 },
  ];
  const actors = {} as Record<ActorKey, TestUser>;
  const accounts: { key: ActorKey; username: string; password: string; name: string; id: string; ceiling?: number }[] = [];
  for (const spec of specs) {
    const caps = spec.key === 'buyer'
      ? ['PurchaseOrder.read', 'PurchaseOrder.create', 'PurchaseOrder.explainPurpose', 'PurchaseOrder.submit', 'PurchaseOrder.cancel', 'PurchaseOrder.setAttachments', 'PurchaseOrder.setReviewers', 'ApprovalMember.read', 'Inventory.read']
      : spec.key === 'noAccess' ? [] : approvalCaps;
    const user = await session.user({ username: spec.username, caps, scopes,
      params: spec.ceiling === undefined ? undefined : { 'PurchaseOrder.approve': { ceiling: spec.ceiling } } });
    actors[spec.key] = user;
    const password = randomBytes(18).toString('base64url');
    await session.kernel.execute('User.setPassword', { id: user.id, password }, session.system());
    await session.kernel.execute('User.update', { id: user.id, name: spec.name }, session.system());
    if (spec.specialty) await session.kernel.execute('ApprovalMember.create', { userId: user.id, displayName: spec.name, specialty: spec.specialty }, session.system());
    accounts.push({ key: spec.key, username: spec.username, password, name: spec.name, id: user.id, ceiling: spec.ceiling });
  }
  await session.kernel.execute('Dept.update', { id: session.rootDeptId, name: '采购 OA 验证组', leaderId: actors.manager.id }, session.system());
  const financeRole = await session.kernel.execute('Role.create', { code: 'finance', name: '采购财务候选受理' }, session.system());
  for (const user of [actors.financeA, actors.financeB]) await session.kernel.execute('User.assignRoles', { id: user.id, roleIds: [user.roleId, financeRole.id] }, session.system());
  if (parallelEnabled) {
    const recheck = await session.kernel.execute('Role.create', { code: 'oa_finance_recheck', name: '采购财务复核' }, session.system());
    await session.kernel.execute('User.assignRoles', { id: actors.backup.id, roleIds: [actors.backup.roleId, recheck.id] }, session.system());
  }
  const aiRole = await session.kernel.execute('Role.create', { code: 'purchase_ai_reviewer', name: '采购 AI 材料预审' }, session.system());
  for (const capability of ['PurchaseOrder.read', 'PurchaseOrder.returnForChanges']) await session.kernel.execute('Role.grantCapability', { id: aiRole.id, capability }, session.system());
  await session.kernel.execute('Role.setScope', { id: aiRole.id, aggregate: 'PurchaseOrder', combinator: 'all' }, session.system());
  await session.kernel.execute('Inventory.create', { sku: 'A-01', available: 100 }, session.system());
  const scenarios: Scenario[] = parallelEnabled ? [
    { key: 'and_happy', title: '并行会审与两步财务汇合', amount: '60000.00', specialists: true, instructions: '经理通过后专业与财务同时办理；财务先完成两步，仍等待技术/质量全部签署，最后出现经理终审。' },
    { key: 'and_reject', title: '并行分支驳回关闭全轮', amount: '60000.00', specialists: true, instructions: '经理后由技术驳回，财务候选与质量待办同时退出，不能再推进。' },
    { key: 'and_return', title: '并行退回后重提新轮次', amount: '60000.00', specialists: true, instructions: '一分支退回，旧分支全部关闭；申请人补充材料后重新从经理发起。' },
    { key: 'and_empty', title: '未选专业会审的空分支', amount: '1200.00', instructions: '不要求专业复核时只进入财务分支，财务两步完成后仍能正常汇合终审。' },
  ] : [
    { key: 'ordinary', title: '普通经理审批', amount: '1200.00', instructions: '经理完成 AI 人工接管，再完成部门经理节点。' },
    { key: 'amountBoundary', title: '50000元边界', amount: '50000.00', instructions: '经理通过后应直接批准，不进入财务候选池。' },
    { key: 'finance', title: '60000元财务候选', amount: '60000.00', instructions: '财务甲领取再释放，财务乙刷新后领取并批准。' },
    { key: 'specialists', title: '技术质量双人会签', amount: '1200.00', specialists: true, instructions: '经理后技术和质量均须签署，第一票不能完成采购。' },
    { key: 'transfer', title: '部门经理转办', amount: '1200.00', instructions: '在部门经理节点转给备选审批人，由接手人最终批准。' },
    { key: 'delegate', title: '部门经理委派归还', amount: '1200.00', instructions: '经理委派技术人员核查，技术人员归还，再由经理正式批准。' },
    { key: 'before', title: '前置加签', amount: '1200.00', instructions: '经理前置加签技术人员，经理待办先等待；技术通过后经理再签。' },
    { key: 'after', title: '后置加签', amount: '1200.00', instructions: '经理后置加签质量人员，质量待办先等待；经理通过后质量再签。' },
    { key: 'parallel', title: '并行加签', amount: '1200.00', instructions: '经理并行加签技术人员，两人均通过后才能批准。' },
    { key: 'return', title: '退回修改再提交', amount: '1200.00', instructions: '经理退回，申请人补充用途重提，历史保留旧轮次并重新审核。' },
    { key: 'cancel', title: '等待加签时取消', amount: '1200.00', instructions: '经理增加后置加签，申请人取消；当前和等待任务均应关闭。' },
    { key: 'lowCeiling', title: '低额度结论拒绝', amount: '1200.00', instructions: '转办给低额度审批人，1200元结论超过其1000元额度，应拒绝且不建锁。' },
    { key: 'combined', title: '专业会签后财务受理', amount: '60000.00', specialists: true, instructions: '经理、技术与质量、财务共享候选依次完成，最后才批准采购。' },
  ];
  const cases = [];
  for (const scenario of scenarios) {
    const reviewerIds = scenario.specialists ? [actors.technical.id, actors.quality.id] : [];
    const reason = `【${scenario.title}】为研发团队新增两位同事采购两套 A-01 办公设备，每人一套，用于日常研发办公，当前备品已全部领用。`;
    const order = await session.kernel.execute('PurchaseOrder.create', { reason, amount: scenario.amount, items: [{ sku: 'A-01', qty: 2 }], needsSpecialistReview: !!scenario.specialists, reviewerIds }, await actors.buyer.ctx());
    cases.push({ ...scenario, id: order.id, path: `/procurement/orders/${order.id}`, reviewerIds, status: 'draft' });
  }
  setupStage = 'server';
  fakeConnector(domain.erp, { pushOrder: request => ({ erpNo: `OA-DEMO-${request.externalId.slice(0, 8)}` }) });
  // 每次复制已构建 Web，避免并行开发重建 dist 后使运行中的静态资源文件名失效。
  const webDir = join(output, 'web');
  await cp(join(root, 'examples/purchase-admin/apps/web/dist'), webDir, { recursive: true });
  server = createServer({ domain, urls: session.urls, webDir, title: 'Cage 采购 OA 验证', logger: false });
  worker = await startWorker({ domain, urls: session.urls, jobs: false, logger: session.kernel.log });
  const url = await server.listen({ host: '127.0.0.1', port });
  const note = (parallelEnabled ? '独立临时环境；本次使用框架人工并行路由：经理→专业/财务两分支→经理终审，财务含候选受理与复核两步。AI未参与本次页面场景。ERP使用fake，不代表真实外部联调。'
    : '独立临时环境；main 模型未配置，真实 AI 节点按 onFailure=manual 转部门经理接管，接管通过后才进入部门经理节点。ERP 使用 fake，不代表真实外部联调。')
    + (operationsEnabled ? ' 本次接入框架流程运营：人工节点时限2分钟、提前1分钟提醒，申请人催办冷却1分钟；通用页面 /admin/#/requests 与 /admin/#/notices。' : '');
  await writeFile(credentialsFile, JSON.stringify({ url, accounts, encryptionKey: process.env.CAGE_AI_ENCRYPTION_KEY, note }, null, 2));
  const info = { pid: process.pid, url, output, credentialsFile, stopFile, note, operationsEnabled, parallelEnabled, accounts: accounts.map(({ password: _password, ...account }) => account), cases, startedAt: new Date().toISOString() };
  await writeFile(join(output, 'info.json'), JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info, null, 2));
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve); process.once('SIGTERM', resolve);
    stopTimer = setInterval(() => {
      void access(stopFile).then(() => resolve(), error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('无法检查演示停止标记，结束本次运行'); process.exitCode = 1; resolve();
        }
      });
    }, 1000);
  });
}

try { await main(); }
catch (error) {
  // 数据库异常可能附带 SQL 参数，日志只输出受控错误码和固定提示，不转储连接或命令输入。
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'SETUP_FAILED';
  const declaration = error instanceof Error ? error.message.match(/\[CAGE-[A-Z]+-\d+\]/)?.[0] : undefined;
  console.error(`采购 OA 演示启动失败（${code}${declaration ? ` ${declaration}` : ''}，阶段 ${setupStage}）；请检查构建、端口和已构建框架产物。`);
  process.exitCode = 1;
} finally {
  try { await close(); }
  catch { console.error('采购 OA 演示清理未全部完成，请检查本次隔离实例状态。'); process.exitCode = 1; }
}
