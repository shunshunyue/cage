// 仓库演示入口：用框架 testkit 创建隔离数据库，所有演示业务数据通过命令写入。
// 不读取或覆盖应用 .env；模型使用 Admin 中的真实连接配置，ERP 保持 fake。
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, access, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createTestEnv, startEmbeddedPostgres } from '../packages/testkit/dist/index.js';
import { readMigrations } from '../packages/kernel/dist/db/index.js';
import { startWorker } from '../packages/http/dist/worker.js';
import { createServer } from '../packages/http/dist/index.js';
import { fakeConnector } from '../packages/connectors/dist/index.js';
import { protectCredentialFile } from '../packages/cli/dist/bootstrap.js';
import * as domain from '../examples/purchase-admin/packages/domain/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.cage', `purchase-ai-demo-${Date.now()}`);
await mkdir(output, { recursive: true });
const credentialsFile = join(output, 'credentials.json');
protectCredentialFile(credentialsFile);
// 仅用于重建本地临时演示时恢复已经配置的加密模型，避免让体验者反复输入密钥。
const savedModels = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : null;
process.env.CAGE_AI_ENCRYPTION_KEY = savedModels?.encryptionKey ?? randomBytes(32).toString('base64');
process.env.CAGE_COOKIE_SECRET = randomBytes(32).toString('base64url');
process.env.CAGE_STAGE = 'fake';
const pg = await startEmbeddedPostgres();
process.env.CAGE_TEST_SUPER_URL = pg.superUrl;
const env = await createTestEnv({ domain, migrations: readMigrations(join(root, 'examples/purchase-admin/db/migrations')) });
const scopes = { PurchaseOrder: 'all', Inventory: 'all' };
const buyer = await env.user({ username: 'demo.buyer', caps: ['Sys.ai.use', 'Sys.ai.models.manage', 'Sys.ai.personalities.manage', 'PurchaseOrder.read', 'PurchaseOrder.create', 'PurchaseOrder.explainPurpose', 'PurchaseOrder.submit', 'PurchaseOrder.cancel', 'PurchaseOrder.setAttachments', 'Inventory.read'], scopes });
const reviewer = await env.user({ username: 'demo.reviewer', caps: ['Sys.ai.use', 'PurchaseOrder.read', 'PurchaseOrder.approve', 'PurchaseOrder.reject', 'PurchaseOrder.returnForChanges', 'Inventory.read'], scopes, params: { 'PurchaseOrder.approve': { ceiling: 50000 } } });
const viewer = await env.user({ username: 'demo.limited', caps: [] });
if (savedModels) {
  if (savedModels.tenantId !== env.tenantId) throw new Error('模型快照租户与演示租户不同');
  await env.kernel.app.transaction().execute(async tx => {
    for (const model of savedModels.models) await tx.insertInto('sys.ai_model').values({ ...model, updated_by: buyer.id, updated_at: new Date(model.updated_at) }).execute();
    await env.kernel.writeAudit(tx, { tenantId: env.tenantId, actor: 'demo-setup', actorKind: 'system', source: 'system', kind: 'ops',
      command: 'Demo.restoreModelConfiguration', result: 'ok', diff: { keys: savedModels.models.map((m: { key: string }) => m.key) } });
  });
}
const accounts = [];
for (const [user, name] of [[buyer, '演示申请人'], [reviewer, '演示审批人'], [viewer, '无权限验收用户']] as const) {
  const password = randomBytes(18).toString('base64url');
  await env.kernel.execute('User.setPassword', { id: user.id, password }, env.system());
  await env.kernel.execute('User.update', { id: user.id, name }, env.system());
  accounts.push({ username: user.username, password, name });
}
await env.kernel.execute('Dept.update', { id: env.rootDeptId, leaderId: reviewer.id }, env.system());
const role = await env.kernel.execute('Role.create', { code: 'purchase_ai_reviewer', name: '采购 AI 材料预审' }, env.system());
for (const capability of ['PurchaseOrder.read', 'PurchaseOrder.returnForChanges']) await env.kernel.execute('Role.grantCapability', { id: role.id, capability }, env.system());
await env.kernel.execute('Role.setScope', { id: role.id, aggregate: 'PurchaseOrder', combinator: 'all' }, env.system());
await env.kernel.execute('Inventory.create', { sku: 'A-01', available: 100 }, env.system());
const cases = [];
for (const [title, reason] of [
  ['退回修改', '采购办公用品'],
  ['材料清楚，转部门经理', '为研发团队新增两名同事采购两套 A-01 办公键盘，每人一套，供日常软件开发使用，现有备品已全部领用。'],
  ['需要人工复核', '生产线临时故障需要紧急采购替换组件，以恢复当日生产，申请按紧急采购流程进行人工核查。'],
]) {
  const order = await env.kernel.execute('PurchaseOrder.create', { reason, amount: '1200.00', items: [{ sku: 'A-01', qty: 2 }] }, await buyer.ctx());
  cases.push({ title, id: order.id, path: `/procurement/orders/${order.id}` });
}
fakeConnector(domain.erp, { pushOrder: request => ({ erpNo: `DEMO-${request.externalId.slice(0, 8)}` }) });
// 静态路由在启动时注册文件名；独立快照避免后续构建替换资源导致运行中的演示白屏。
const webDir = join(output, 'web');
await cp(join(root, 'examples/purchase-admin/apps/web/dist'), webDir, { recursive: true });
const server = createServer({ domain, urls: env.urls, webDir, title: 'Cage 采购 AI 演示', logger: false });
const worker = await startWorker({ domain, urls: env.urls, jobs: false, logger: env.kernel.log });
const url = await server.listen({ host: '127.0.0.1', port: Number(process.env.CAGE_DEMO_PORT ?? 3000) });
await writeFile(credentialsFile, JSON.stringify({ url, accounts, encryptionKey: process.env.CAGE_AI_ENCRYPTION_KEY, note: '隔离演示环境；关闭脚本后临时数据库清理。生产部署需使用稳定的独立加密密钥。' }, null, 2));
const info = { pid: process.pid, url, adminUrl: `${url}/admin/#/models`, credentialsFile, cases, startedAt: new Date().toISOString() };
await writeFile(join(output, 'info.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2));
let closing = false;
// 无可交互终端时也能通过本次实例目录中的 stop 文件正常关闭，而不是强制结束数据库。
const stopTimer = setInterval(() => { void access(join(output, 'stop')).then(() => close(), () => {}); }, 1000);
async function close() {
  if (closing) return; closing = true;
  clearInterval(stopTimer);
  await worker.stop(); await server.close(); await env.close(); await pg.stop();
}
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
