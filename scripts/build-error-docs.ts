/**
 * 合并源码诊断位置与手写逐码说明，生成 docs/errors 的本地排错手册。
 * 扫描路径和行号随源码注释移动也会变化，因此补注释后需重新生成手册再同步模板。
 * 默认写生成页面，--check 仅收集差异并失败；没有对应手写说明的错误码会阻止交付。
 */
/**
 * 从当前实现提取诊断位置，与人工维护的逐码解释合并成可离线使用的手册。
 * 输出直接进入脚手架，因此源码位置用文本表达，不能链接到用户项目不存在的 kernel 目录。
 * --check 只检查一致性；新增错误码缺少解释时失败，避免发出只有编号的空手册。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorGuides } from './error-catalog.ts';

/**
 * 错误码的一处源码证据：path 相对仓库，line 为一基行号，context 保存附近文本。
 * 这是检索定位信息，不代表该分支已经运行或测试通过。
 */
interface SourceLocation {
  path: string;
  line: number;
  context: string;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
const codes = new Map<string, SourceLocation[]>();
const excluded = new Set(['node_modules', 'dist', 'test', 'templates', 'managed', 'graph-ui']);

/**
 * 按稳定目录顺序扫描允许的源码文件，跳过测试、生成及分发副本以降低重复证据。
 * 每行同一错误码只记录一次，保留不同位置，便于逐码页面指回具体实现；当前扫描包含注释中的编号。
 */
function scan(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      scan(path);
      continue;
    }
    if (!/\.(ts|cjs)$/.test(entry.name) || /\.(test|spec|d)\.ts$/.test(entry.name)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      // 一行同码只记一次；保留多处真实位置，避免首个引用掩盖同码的其他含义。
      for (const code of new Set(line.match(/CAGE-[A-Z]+-\d+/g))) {
        const sources = codes.get(code) ?? [];
        sources.push({
          path: relative(root, path).replaceAll('\\', '/'),
          line: index + 1,
          context: lines.slice(Math.max(0, index - 1), index + 4).join('\n'),
        });
        codes.set(code, sources);
      }
    });
  }
}

const families: Record<string, { title: string; stage: string; verify: string }> = {
  ONTOLOGY: {
    title: '本体业务名称',
    stage: 'check / gen / verify / 图谱与上下文诊断',
    verify: '重跑 cage check，再在 graph/context 中按业务用语核对名称；对象关系与运行行为仍需独立业务用例验证。',
  },
  AI: {
    title: '智能运行时',
    stage: '领域声明 / 模型与运行预算配置',
    verify: '重跑 cage check、迁移与相关测试，再以真实角色验证助理和审批；fake 成功不代表真实模型联调完成。',
  },
  FILE: {
    title: '文件字段与上传',
    stage: '字段声明 / 私有文件服务配置',
    verify: '重跑 cage check、gen 和文件回归；实际验证暂停、续传、命令绑定及当前权限下载，云存储联调单独报告。',
  },
  AUDIT: {
    title: '可靠读取审计',
    stage: '安全读侧 / 查询',
    verify: '修复审计存储后重新读取，确认有权交付的数据与相应审计均完成。',
  },
  DIAG: {
    title: '运行状态诊断',
    stage: 'doctor / timeline / explain',
    verify: '核对诊断输入、受控会话和目标服务，再重新获取实际运行证据；未知不当作通过。',
  },
  WORKER: {
    title: '后台执行与就绪',
    stage: 'worker 启动 / 投递 / 停机',
    verify: '核对同版本注册指纹、消费者清单、心跳和时间线，再验证投递及停机恢复。',
  },
  APPR: {
    title: '审批',
    stage: '声明、图规则或 worker',
    verify: '先 cage check；涉及选人/流程推进时，用实际用户、部门和角色提交并处理待办，检查 worker 与死信。',
  },
  AUTH: {
    title: '登录认证',
    stage: 'HTTP 登录',
    verify: '重新走真实 OIDC 登录和回调，确认会话中的用户与授权；不要仅验证发现文档能打开。',
  },
  BIZ: {
    title: '业务流程阅读规格',
    stage: '声明加载 / 图规则',
    verify: '重跑 cage check，再在 cage graph 中检查主线、分支、关联和实现代码；运行行为仍需相应业务回归。',
  },
  BUDGET: {
    title: '体积与逃生口预算',
    stage: 'budget / verify',
    verify: '重跑 cage budget；有 unsafe 基线时使用真实受审基线。',
  },
  CMD: {
    title: '命令',
    stage: '声明加载',
    verify: '重跑 cage check、gen 和相关命令测试，检查生成输入/方法签名。',
  },
  CONN: {
    title: '第三方连接器',
    stage: '声明、图规则或 worker',
    verify: '先 cage check；涉及网络时检查同步记录、外部幂等结果与成功回写。fake 与真实联调分别报告。',
  },
  CREATE: {
    title: '创建应用',
    stage: 'create-cage-app / cage create',
    verify: '向一个新目录创建，检查 AGENTS.md、业务源码、docs/development 和 docs/errors，然后按 README 安装/构建。',
  },
  DECL: {
    title: '可抽取声明',
    stage: '静态检查 / 注册',
    verify: '重跑 cage check/analyze，确认声明出现在本体图，再运行 gen。',
  },
  DEP: {
    title: '依赖边界',
    stage: '静态检查 / verify',
    verify: '重跑 cage check 和 verify，确认边界修复而不是禁用规则。',
  },
  STRUCT: {
    title: '工程目录与模块依赖',
    stage: 'check / analyze / verify（structure: modular）',
    verify:
      '按 docs/development/reference/project-structure.md 整理归属和导入后重跑 cage check 与 verify；不关闭目录规则，也不改业务表或能力标识。',
  },
  DLQ: {
    title: '死信操作',
    stage: '系统管理接口',
    verify: '刷新死信列表并查看审计及当前处理结果；核对原始 outboxId。',
  },
  ENV: {
    title: '运行配置',
    stage: 'init / migrate / 启动',
    verify: '重跑原先失败的命令，确认使用预期库与账号；输出脱敏信息。',
  },
  EVENT: {
    title: '事件载荷与兼容性',
    stage: '写事务 / 基线比较',
    verify: '运行相关命令与消费者测试；兼容性使用修改前基线检查，考虑尚未消费的旧事件。',
  },
  FIELD: {
    title: '字段',
    stage: '声明加载',
    verify: '重跑 cage check/gen，审查契约与迁移；敏感字段还要验证普通用户读结果。',
  },
  REL: {
    title: '关系字段',
    stage: '声明加载 / 生成',
    verify:
      '重跑 cage check/gen；迁移后用真实用户验证关系命令、关联分页读取和双侧范围。不要手写纯中间表聚合。',
  },
  GEN: {
    title: '生成一致性',
    stage: 'gen --check / verify',
    verify: '重新生成并审查后执行 cage gen --check；结构变化还需审查并执行 migrate。',
  },
  GRANT: {
    title: '角色授权与防提权',
    stage: '组织命令',
    verify: '用真实操作人验证允许与拒绝场景，检查目标角色最终能力、参数和范围。',
  },
  IMPACT: {
    title: '影响分析',
    stage: 'impact / 基线加载',
    verify: '使用可靠基线重新 impact，确认报告中的变化与本次需求相符。',
  },
  INIT: {
    title: '账号初始化',
    stage: 'init',
    verify: '恢复/核对配置后运行 cage init 验证，随后按流程 gen、审查迁移并 migrate；不输出凭证。',
  },
  JOB: {
    title: '定时任务',
    stage: '声明 / worker',
    verify: '先 cage check，再在独立测试环境用目标任务数据验证读取、调用与审计；不要等待生产定时器试错。',
  },
  LINT: {
    title: '通用 lint',
    stage: 'verify',
    verify: '按原诊断的文件、行号和 ruleId 修复，再运行相关 lint/verify。',
  },
  MIG: {
    title: '结构迁移与安全层',
    stage: 'migrate',
    verify: '在合适数据库上重新 migrate，确认迁移历史及 safe 读写权限，已执行文件保持原样。',
  },
  NAME: {
    title: '名称',
    stage: '声明加载',
    verify: '重跑 cage check/gen；改动线上标识时还要审查能力、路由、迁移及旧消费者影响。',
  },
  ORG: {
    title: '组织模型',
    stage: '图规则 / 测试环境',
    verify: '重跑 cage check/analyze，确认 User、Dept、Role 均已注册。',
  },
  PAIR: {
    title: '资源配对',
    stage: '图规则',
    verify: '重跑 cage check，并用业务用例验证每条关键离开路径确实释放资源。',
  },
  QUERY: {
    title: '安全查询',
    stage: '声明 / 图规则',
    verify: '重跑 cage check/gen；用普通用户验证查询参数、read 能力、范围和掩码。',
  },
  REACT: {
    title: '跨聚合反应',
    stage: '声明 / 写流水线',
    verify: '重跑 cage check；同事务链验证共同提交/回滚，异步链检查 worker 和死信。',
  },
  READS: {
    title: '显式读依赖',
    stage: 'handler 执行',
    verify: '检查本体图 reads 边并运行该命令的业务用例。',
  },
  REG: {
    title: '运行时注册表',
    stage: '声明加载 / 执行',
    verify: '重跑 cage check/analyze/gen，确认统一入口包含引用双方。',
  },
  ROUTE: {
    title: '自动路由',
    stage: 'lint / verify',
    verify: '重新生成，检查 generated/routes.json 和前端契约，再验证自动接口。',
  },
  SCOPE: {
    title: '数据范围',
    stage: '声明 / 范围编译',
    verify: '重跑 cage check；分别使用本人/部门等实际授权用户验证范围内外结果。',
  },
  SECRET: {
    title: '密钥边界',
    stage: 'lint / 外呼或回调',
    verify: '确认源码/日志不含值，重启后验证相应外呼或签名回调。',
  },
  SENS: {
    title: '敏感字段',
    stage: '图规则',
    verify: '重跑 cage check，检查实际 outbox 载荷及普通读结果没有泄漏明文。',
  },
  SQL: {
    title: 'SQL 参数化',
    stage: 'lint',
    verify: '重跑相关 lint/verify，并用正常及特殊字符输入验证参数语义。',
  },
  STATE: {
    title: '状态与可达性',
    stage: '声明 / 图规则',
    verify: '重跑 cage check、gen，审查状态图和相关状态迁移用例。',
  },
  SYNC: {
    title: 'AI 托管区',
    stage: 'sync / verify',
    verify: '运行 cage sync 后再 sync --check，确认标记外业务约定保持不变。',
  },
  TEST: {
    title: '测试报告',
    stage: 'test / verify',
    verify: '确认当前运行退出码与 JSON 报告，分别报告通过、失败和跳过。',
  },
  UNSAFE: {
    title: '逃生口',
    stage: '声明 / lint / budget',
    verify: '运行相关 lint、budget 和真正业务用例，保留原因与负责人。',
  },
  UPGRADE: {
    title: '升级',
    stage: 'upgrade',
    verify: '审查 dry-run 后升级，再按新版本运行 gen/verify，报告尚未完成的数据库/外部联调。',
  },
};

scan(join(root, 'packages'));
const target = join(root, 'docs/errors');
const mismatches: string[] = [];

/**
 * 将一份生成页面与当前文件比较：相同则不写，检查模式记录差异，普通模式创建目录并写入。
 * 不手工合并生成页，正文来源必须回到 error-catalog 或生成模板维护。
 */
function output(name: string, content: string): void {
  const path = join(target, name);
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return;
  if (check) mismatches.push(name);
  else {
    mkdirSync(target, { recursive: true });
    writeFileSync(path, content);
  }
}

for (const [code, sources] of [...codes].sort()) {
  const guide = errorGuides[code];
  if (!guide) throw new Error(`${code} 缺少 scripts/error-catalog.ts 中的逐码说明`);
  const family = families[code.split('-')[1]];
  const primary = sources[0];
  const locations = [...new Set(sources.map((source) => `${source.path}:${source.line}`))];
  output(
    `${code}.md`,
    `# ${code}：${guide.title}

[返回错误码册](README.md) · [业务排错](../development/tools/troubleshooting.md)

> 本页由框架生成。正反例为局部声明或操作说明，完整写法见业务开发指南及本项目 domain。

## 何时出现

阶段：${family.stage}。

${guide.when}

## 修复步骤

${guide.fix.map((step, index) => `${index + 1}. ${step}`).join('\n')}

## 正例

\`\`\`text
${guide.positive}
\`\`\`

## 反例

\`\`\`text
${guide.negative}
\`\`\`

## 修复后验证

${family.verify}

## 框架内的检查位置

以下路径相对框架源码仓库，不是要求业务项目创建这些文件。当前项目先修业务声明、配置或授权；明确属于框架缺口时反馈错误码和脱敏上下文。

${locations.map((location) => `- \`${location}\``).join('\n')}

实现片段（位置随框架版本更新）：

\`\`\`ts
${primary.context}
\`\`\`
`,
  );
}

const index = [
  '# 错误码册',
  '',
  '这是本业务项目自带的离线诊断手册。先使用错误码、声明位置、reason/fix 定位；不需要克隆框架仓库。',
  '',
  '- [HTTP 运行时错误与业务码](runtime.md)：401/403/404、状态冲突、约束拒绝、DOMAIN_ERROR 等。',
  '- [业务排错顺序](../development/tools/troubleshooting.md)：启动、权限、审批人、worker、死信与导入导出。',
  '- CAGE-* 是声明、工具链或内部运行诊断；HTTP code 与业务 domainCode 是另一层，不要混为一谈。',
  '',
  '每页包含触发阶段、具体原因、修复步骤、正反例、验证方法与当前版实现位置。例子为局部说明，不能替代完整业务输入。',
  '',
];
for (const [prefix, family] of Object.entries(families)) {
  const members = [...codes.keys()].filter((code) => code.split('-')[1] === prefix).sort();
  index.push(
    `## ${family.title}`,
    '',
    '| 诊断码 | 含义 |',
    '| --- | --- |',
    ...members.map((code) => `| [${code}](${code}.md) | ${errorGuides[code].title} |`),
    '',
  );
}
index.push(
  '## 历史流程',
  '',
  '[CAGE-MIG-003](CAGE-MIG-003.md)、[CAGE-MIG-004](CAGE-MIG-004.md) 属于旧版初始化流程，当前使用 init + migrate；保留页面供历史诊断。',
  '',
  '手册随创建项目时的 CLI 版本分发。cage sync 仅更新 AGENTS 托管区；升级后需要按该版本的资料核对差异。',
  '',
  '框架维护者：修改 scripts/error-catalog.ts 后运行 pnpm docs:errors；不要只手改生成的逐码页面。',
  '',
);
output('README.md', index.join('\n'));
if (mismatches.length) throw new Error(`错误码册需重新生成：${mismatches.join('、')}`);
console.log(`${check ? '已检查' : '已生成'} ${codes.size} 个当前错误码及分类索引`);
