// 错误码册的索引从实现抽取，修复建议按规则族维护。
// 每个码保留实际触发位置与上下文，错误新增时不会出现指向空文件的诊断链接。
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const codes = new Map();
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'test', 'templates', 'managed'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (/\.(ts|cjs)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const match of line.matchAll(/CAGE-[A-Z]+-\d+/g)) if (!codes.has(match[0])) codes.set(match[0], { path: relative(root, path).replaceAll('\\', '/'), line: index + 1, context: lines.slice(Math.max(0, index - 1), index + 5).join('\n') });
      });
    }
  }
}
scan(join(root, 'packages'));
// [修复步骤, 正例, 反例]。例子强调允许的声明方式，不建议通过关闭门禁消除错误。
const families = {
  TEST: ['检查 Vitest 的输出及配置。必须生成当前运行的 JSON 报告，失败不能当作通过。', 'cage test\n// .cage/test-results.json 中 success: true', '// 测试启动失败却复用上一次结果'],
  PAIR: ['离开持有资源的状态时，发出事件并声明释放该资源的反应；检查每一条离开路径。', "reaction(OrderCancelled, { command: releaseLock, releases: 'inventory.lock', map: e => ({ id: e.orderId }) });", "// approved 持有 inventory.lock，取消却没有 releases 反应\ncommand(PurchaseOrder, { from: 'approved', to: 'cancelled', handler: o => o });"],
  DECL: ['将声明放在模块顶层，用唯一的 export const 名称声明，并从 domain/index.ts 导出。', "export const Order = aggregate('Order', definition);\n// index.ts\nexport * from './order.js';", "function build() { return aggregate('Order', definition); }"],
  DEP: ['移除业务层的 IO 或越层依赖。读取放进 reads，外部调用放进 outbound，前端依赖 contracts。', "reads: { stock: Inventory }\n// handler 中\nawait deps.stock.get(id);", "import pg from 'pg'; // domain 中禁止直接访问数据库"],
  READS: ['在 reads 中声明所有读依赖，并确认目标聚合也从入口导出。', 'reads: { stock: Inventory }', 'reads: {} // handler 却读取 deps.stock'],
  STATE: ['让 from/to 引用已声明的状态，初始状态可达，非终态有出边，结束状态列入 terminal。', "states('draft', 'done', { terminal: ['done'] });", "command(Order, { from: 'missing', to: 'done', handler: o => o });"],
  NAME: ['聚合、事件使用大驼峰；命令、任务和查询使用小驼峰，且同类名称唯一。', "aggregate('PurchaseOrder', definition);", "aggregate('purchase-order', definition);"],
  FIELD: ['使用 field 工厂声明字段，避免覆盖 id/status/version 等系统列，引用指向存在的聚合。', "fields: { deptId: ref('Dept'), amount: money() }", "fields: { version: text() } // 系统版本号不能改作业务字段"],
  CMD: ['非新建命令的输入必须含 id；from/to、调用身份和聚合定义保持一致。', "input: z.object({ id: z.string().uuid(), note: z.string() })", "input: z.object({ note: z.string() }) // 非新建命令缺少 id"],
  APPR: ['核对流程绑定、可路由字段、结论命令及审批人配置。结论只能调用所属聚合的 process 命令。', "onApproved: approve // approve 声明 invokedBy: 'process'", "onApproved: otherAggregateCommand // 结论落到了错误聚合"],
  CONN: ['核对 host 白名单、操作名、字段 schema 和签名。永久失败应先修正配置再重放死信。', "hosts: { test: 'erp-sandbox.example.com', prod: 'erp.example.com' }", "// outbound 映射发送了 request schema 之外的字段"],
  QUERY: ['SQL 引用 reads 对应的 safe 视图，用命名参数绑定输入。', "reads: [PurchaseOrder], sql: 'select amount from safe.purchase_order where status = :status'", "sql: 'select * from core.purchase_order'"],
  SQL: ['使用参数化 SQL 或查询构建器；sql.raw 只接收固定 SQL 片段。', 'sql`select * from safe.purchase_order where id = ${id}`', "'select * from safe.purchase_order where id = ' + input"],
  SECRET: ['配置中只写密钥名；密钥值通过运行环境注入，移除源码中的字面量。', "secret: 'ERP_API_TOKEN'", "secret: 'a-real-token-in-source'"],
  UNSAFE: ['优先改为声明或命令；确需逃生口时填写非空 reason、owner，并记录评审。', "unsafe({ reason: '一次性修复历史数据', owner: '数据负责人' }, action)", "unsafe({ reason: '', owner: '' }, action)"],
  EVENT: ['保留旧事件字段及类型，新加字段设为 optional；不兼容含义使用新事件名。', 'event("OrderChanged", { orderId: id(), note: text().optional() })', '// 给已有事件新增必填 note，旧 outbox 消息无法提供它'],
  SENS: ['从事件移除敏感字段，或保留与聚合一致的 sensitive 标注，让运行时脱敏。', "event('OrderChanged', { phone: text().sensitive('phone') })", "event('OrderChanged', { phone: text() }) // 来源字段是敏感电话"],
  ROUTE: ['在 domain 声明 command/query，让框架生成 HTTP 路由。', "export const submit = command(Order, definition);", "app.post('/api/order/submit', handler);"],
  REACT: ['反应的目标聚合必须与 command 一致，目标命令需从统一入口导出。', 'reaction(Approved, { command: acquireLock, map: e => ({ id: e.orderId }) })', 'reaction(Approved, { target: Order, command: acquireLock, map })'],
  JOB: ['校正 cron、reads 和 calls。任务只能读取和调用显式声明的依赖。', "job('expireOrders', { cron: '0 2 * * *', reads: [Order], calls: [cancel], run })", "calls: [] // run 却调用 cancel"],
  SCOPE: ['选择内置范围组合子，引用聚合中真实存在的部门/创建人字段。', "scope: scope.deptSubtree('deptId')", "scope: scope.deptSubtree('missingField')"],
  GRANT: ['先声明能力点，再由具有该能力和范围的管理员分配，不能通过界面发明能力。', "capability: 'PurchaseOrder.read'", "capability: 'PurchaseOrder.nonexistent'"],
  GEN: ['运行 cage gen，检查生成契约与迁移草稿后提交；不要手改生成文件。', 'pnpm cage gen\npnpm cage gen --check', '// 修改了 domain，但提交旧 contracts'],
  SYNC: ['修复唯一的 begin/end 标记，再执行 cage sync；托管区之外的内容会保留。', '<!-- cage:begin v0.1.0 -->\n框架约定\n<!-- cage:end -->', '<!-- cage:begin old -->\n没有结束标记'],
  BUDGET: ['减少内核职责，移除不必要的 unsafe；预算调整及基线更新必须经过评审。', 'node packages/cli/bin/cage.js budget', '// 未评审就增加公共原语或 unsafe 数量'],
  MIG: ['核对迁移 SQL、账号权限和目标数据库。初始化只用于独立新集群，已发布迁移不可重写。', 'pnpm cage migrate', '// 用 cage_read 执行建表或覆盖已有集群角色密码'],
  ENV: ['在运行环境设置 app/read/migrate 三种连接串，检查连接账号与库名。不要把凭证写进源码。', 'CAGE_APP_DATABASE_URL / CAGE_READ_DATABASE_URL / CAGE_MIGRATE_DATABASE_URL', '// 未配置数据库连接就启动 API'],
  IMPACT: ['指定存在的 Git 提交，或保存过的完整 ontology.json。基线错误不能当作无变化。', 'cage impact --base-file baseline.json', 'cage impact // 没有指定基线'],
  UPGRADE: ['先安装目标版本 CLI，再运行对应 codemod；遇到同时存在新旧字段时手工消除歧义。', 'cage upgrade --dry-run', "command(A, { caller: 'user', invokedBy: 'process' })"],
  CREATE: ['选择尚不存在的目标目录，并确认 CLI 安装包包含 templates/app。', 'cage create new-app', 'cage create existing-project // 拒绝覆盖已有项目'],
  ORG: ['从 domain 入口导出框架组织模型。', "export * from '@yss123/cage-admin/domain';", '// domain 入口只导出业务聚合，遗漏组织模型'],
  REG: ['检查统一入口中的聚合/命令引用及名称是否重复，所有依赖都必须在注册表中。', "export * from './purchase-order.js';", '// 命令引用了没有从入口导出的聚合'],
  AUTH: ['核对 OIDC 发现文档、issuer 和客户端配置，在部署环境配置所需变量。', 'OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_REDIRECT_URI', '// issuer 不匹配或缺少客户端配置'],
  DLQ: ['检查死信详情和事件顺序，修复原因后用管理接口重放或丢弃，不直接改业务表。', '在 /admin 的死信列表检查错误并重放', '直接更新 sys.outbox 绕过死信处理流程'],
  LINT: ['根据输出中的 ruleId 修复语法或规则问题，再重跑 verify。', 'pnpm cage verify', '// 用禁用 lint 代替修复业务边界'],
};
// 同一规则族中语义不同的错误单独给出建议，避免把“新建无目标状态”误导为输入缺 id。
const specific = {
  'CAGE-CMD-003': [
    '新建命令必须指定聚合中声明的目标状态。to: null 仅用于已有记录的字段更新；它保留加锁读出的状态，不跳过 from、权限、版本及审计检查。',
    "command(Order, { from: 'new', to: 'draft', handler: o => o });\n// 晚到回执可以保留终态\ncommand(Order, { from: ['approved', 'cancelled'], to: null, handler: o => o });",
    "command(Order, { from: 'new', to: null, handler: o => o }); // 新记录没有可保留的状态",
  ],
  'CAGE-MIG-005': [
    '恢复已经执行的迁移文件，不要修改数据库中的校验和来绕过检查。需要变更结构时新增迁移；若仅受换行转换影响，恢复原始文件字节并使用仓库的 LF 约定。',
    '保留 0001_init.sql，新增 0002_add_field.sql，再运行 cage migrate',
    '修改已执行的 0001_init.sql，或手工重写迁移历史的 checksum',
  ],
};
const target = join(root, 'docs/errors'); mkdirSync(target, { recursive: true });
for (const [code, source] of [...codes].sort()) {
  const [fix, positive, negative] = specific[code] ?? families[code.split('-')[1]];
  writeFileSync(join(target, `${code}.md`), `# ${code}\n\n## 什么时候出现\n\n命中以下实现中的检查时触发。终端会附具体声明位置、原因和修复方法。\n\n来源：[${source.path}:${source.line}](../../${source.path})\n\n\`\`\`ts\n${source.context}\n\`\`\`\n\n## 怎么修\n\n${fix}\n\n## 正例\n\n\`\`\`text\n${positive}\n\`\`\`\n\n## 反例\n\n\`\`\`text\n${negative}\n\`\`\`\n`);
}
writeFileSync(join(target, 'README.md'), '# 错误码册\n\n每个错误码包含触发位置、修复建议和正反例。框架源码更新后运行 `node scripts/build-error-docs.mjs` 刷新索引。\n\n' + [...codes.keys()].sort().map((code) => `- [${code}](${code}.md)`).join('\n') + '\n');
console.log(`已生成 ${codes.size} 个错误码文档`);
