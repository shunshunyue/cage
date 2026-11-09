/**
 * 按当前安装包的声明文件建立公开能力目录，供 agent 查真实签名与本地指南。
 * 依次尝试领域、契约、Web、项目及 CLI 的依赖边界，用 TypeScript 类型检查器解析公开导出。
 * 关键词提示只帮助召回，不创造不存在的 API；未解析到包或声明文件时记录未检查，不据此判定框架不支持。
 */
// Public capability discovery reads installed declarations, never framework implementation bodies.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { abs, type CageConfig } from './config.js';
import { VERSION } from './version.js';

const modules = ['kernel', 'approval', 'connectors', 'client', 'admin', 'files', 'ai', 'ai-protocol', 'ontology'] as const;
// 关键词负责把需求指向真实公开符号；签名仍来自当前安装包，不能用词表伪造可用 API。
const topics: Record<string, { words: string; guide: string; limitations?: string[] }> = {
  ai: { words: '智能助理 业务助理 本体助理 全能助理 AI审批 AI 审批 智能审批 运行时 执行循环 loop 工具 会话 记忆 上下文预算', guide: 'intelligence.md',
    limitations: ['须从 domain 入口导出并完成迁移、模型配置、角色授权和 worker 启动；框架支持不代表应用已启用。'] },
  AiContextOptions: { words: '上下文预算 上下文窗口 大本体 按需加载 工具发现 工具搜索 历史 记忆 token', guide: 'intelligence.md' },
  chatModel: { words: '模型接入 Chat Completions 流式输出 fake', guide: 'intelligence.md' },
  responsesModel: { words: '模型接入 Responses 接口协议 会话接续 previous_response_id 服务端压缩', guide: 'intelligence.md',
    limitations: ['Responses 接口可用不等于网关支持接续或压缩；接续历史仍占上下文与输入用量。'] },
  managedModel: { words: '模型管理 模型配置 动态配置 密钥 admin HTTP HTTPS Chat Completions Responses', guide: 'intelligence.md',
    limitations: ['Admin 管理需显式授予 Sys.ai.models.manage，并配置部署加密密钥；连接测试不代表工具和业务联调通过。'] },
  '@yss123/cage-approval#step': { words: '审批步骤 AI审批 AI 审批 智能审批 通过 退回修改 转人工', guide: 'intelligence.md',
    limitations: ['AI 使用 step 的 kind: ai 重载；handoff 指定本步骤接管人，角色与结论命令仍须授权。'] },
  AiStepOptions: { words: 'AI审批 AI 审批 智能审批 审核策略 退回修改 转人工', guide: 'intelligence.md' },
  AiDecision: { words: 'AI审批 AI 审批 智能审批 三态裁决 通过 退回修改 转人工', guide: 'intelligence.md' },
  useAssistant: { words: '智能助理 业务助理 本体助理 全能助理 随页助理 会话 前端 SDK 性格 流式输出 悬浮窗 Markdown', guide: 'intelligence.md',
    limitations: ['SDK 提供状态与动作；悬浮窗、Markdown 和交互卡片由应用实现，不能等待发送 Promise 完成后才展示增量文字。'] },
  AiClient: { words: '业务助理 随页助理 前端 SDK 会话 记忆 性格 流式输出 模型管理', guide: 'intelligence.md' },
  AiPageContext: { words: '页面上下文 随页助理 当前页面 快照 选中项 草稿 标签页', guide: 'intelligence.md' },
  useAiPageContext: { words: '页面上下文 随页助理 当前页面 快照 选中项 草稿 标签页', guide: 'intelligence.md',
    limitations: ['应用主动提供语义快照，SDK 不抓取整个 DOM；服务端按当前身份重新读取并校验业务对象。'] },
  PageContext: { words: '页面上下文 随页助理 当前页面 快照 选中项 草稿 标签页', guide: 'intelligence.md' },
  AiPersonality: { words: '性格 人设 表达风格 默认预设 admin', guide: 'intelligence.md',
    limitations: ['性格只影响助理表达，不改变权限、工具或审批策略；管理需 Sys.ai.personalities.manage。'] },
  AiPersonalityInput: { words: '性格 人设 表达风格 自定义配置', guide: 'intelligence.md' },
  runtimeOntology: { words: '领域本体 业务本体 本体助理 自动工具 运行时', guide: 'intelligence.md' },
  file: { words: '文件 附件 上传 单文件', guide: 'files.md' },
  files: { words: '文件 附件 上传 多文件', guide: 'files.md' },
  FileService: { words: '文件 断点续传 分片 上传 存储', guide: 'files.md' },
  FileStorage: { words: '文件 对象存储 S3 适配器', guide: 'files.md' },
  LocalFileStorage: { words: '文件 本地 私有 存储', guide: 'files.md' },
  FileUploadTask: { words: '文件 上传 暂停 恢复 断点续传', guide: 'files.md' },
  scope: { words: '本人 owner 部门 数据范围 授权', guide: 'architecture.md' },
  reaction: { words: '跨对象 事务 事件 反应 原子', guide: 'primitives.md' },
  reactionEach: { words: '批量 集合 多条 上限 顺序 事务', guide: 'diagnostics.md' },
  approver: { words: '审批 选人 部门负责人 角色 单据字段 人员数组', guide: 'approvals.md' },
  '@yss123/cage-approval#parallel': { words: '审批 并行 网关 AND 分叉 汇合 多部门 分支 同时 联合会审', guide: 'approvals.md',
    limitations: ['结构化 AND 分支同时开始，全部活动分支完成后继续；when 仍按启动快照求值，不支持任意跳转或运行中修改路线。'] },
  '@yss123/cage-approval#branch': { words: '审批 并行 分支 内部顺序 嵌套 条件 AND 汇合', guide: 'approvals.md' },
  InCodeEngine: { words: '复杂OA 审批 转办 转签 委派 归还 加签 前签 后签 并行必签 候选 领取 释放 claim unclaim 任务 操作历史 revision', guide: 'approvals.md',
    limitations: ['候选领取由 assignment 声明，任务操作由 actions 开放；自然分钟 SLA 需 approvalOperations；parallel/branch 支持结构化 AND，并非任意流程图，不支持指定节点退回或管理员人员恢复。'] },
  approvalOperations: { words: '审批 流程 时限 SLA 到期 临期 超时 提醒 站内通知 催办 已读 我的申请', guide: 'approvals.md',
    limitations: ['显式导出运行时并迁移、启动 worker；step.sla 按自然分钟计时，route.reminders 限定申请人。没有工作日历、自动升级或外部通知。'] },
  ApprovalNotice: { words: '审批 流程 提醒 站内通知 临期 超时 催办 已读', guide: 'approvals.md' },
  TaskActionPolicy: { words: '审批 转办 委派 归还 加签 节点政策', guide: 'approvals.md' },
  TaskActionInput: { words: '审批任务 输入 版本 原因 转办 委派 加签 前签 后签 领取 释放', guide: 'approvals.md' },
  ApprovalTaskAction: { words: '前端 SDK 审批 转办 委派 归还 加签 候选 领取 释放', guide: 'approvals.md' },
  CageClient: { words: '客户端 SDK 审批 转办 委派 归还 加签 操作历史 时限 提醒 催办 已读', guide: 'approvals.md' },
  connector: { words: '第三方 ERP 外呼 外部', guide: 'primitives.md' },
  command: { words: '命令 写入 校验 业务操作', guide: 'primitives.md' },
  query: { words: '查询 报表 安全读取', guide: 'primitives.md' },
};
const examples: Record<string, string> = {
  ai: "export const intelligence = ai({ models: { main: managedModel('main') }, assistant: { model: 'main', confirmWrites: true } })",
  managedModel: "models: { main: managedModel('main') } // ai() 的配置片段；连接信息在 Admin 保存",
  '@yss123/cage-approval#step': "step('材料预审', { kind: 'ai', model: 'main', instructions: '资料不足时转人工，并说明缺失信息。', context: { fields: ['reason'] }, handoff: approver.role('reviewer') })",
  useAssistant: 'const assistant = useAssistant(client.ai, page); // page 由 useAiPageContext 提供，按 streamingText / progress 渲染',
  scope: "scope.self('applicantId'); scope.deptSubtree('deptId', 'applicantId')",
  reaction: "reaction(OrderApproved, { command: reserve, tx: 'same', map: event => ({ id: event.stockId }) })",
  reactionEach: "reactionEach(Allocated, { command: reserve, tx: 'same', order: 2, maxItems: 20, orderBy: 'id', items: event => event.devices, map: item => ({ id: item.id }) })",
  approver: "step('部门负责人', approver.deptLeader('deptId'))",
  '@yss123/cage-approval#parallel': "parallel('联合会审', branch('业务', step('业务审核', approver.role('reviewer'))), branch('财务', step('财务审核', approver.role('finance'))))",
  '@yss123/cage-approval#branch': "branch('法务', step('合同核查', approver.role('legal')), step('法务复核', approver.role('legal_lead')))",
  approvalOperations: 'export const approvalOps = approvalOperations(); // 再在人工 step 声明 sla、route 声明 reminders，并从 domain 入口导出',
  query: "query('recentOrders', { reads: [Order], input: z.object({}), sql: 'select id from safe.order limit 20' })",
};

/**
 * 读取安装版本的公开导出签名，按关键词筛选可用 API 的证据。
 * 查询只做归一化后的连续文本包含判断，不进行同义词推理；无结果和未检查包都不能说明能力不存在。
 * @param cfg 用于定位应用不同包的依赖解析边界。
 * @param query 公开名称、JSDoc 或维护的业务词条；空字符串返回全部已发现符号。
 * @returns 包检查状态、真实签名、声明位置和本地 guide；不加载运行时实现或修改文件。
 */
export function publicCapabilities(cfg: CageConfig, query = '') {
  const requests = [createRequire(abs(cfg, cfg.domain)), createRequire(abs(cfg, `${cfg.contracts}/index.ts`)), createRequire(abs(cfg, `${cfg.web}/package.json`)), createRequire(abs(cfg, 'package.json')), createRequire(import.meta.url)];
  const packages = modules.flatMap<{ name: string; version: string | null; entry: string | null }>(module => {
    const name = `@yss123/cage-${module}`;
    try {
      const workspace = abs(cfg, `packages/${module}/package.json`);
      const resolvers = existsSync(workspace) ? [createRequire(workspace), ...requests] : requests;
      let resolved: string | undefined;
      for (const request of resolvers) {
        try { resolved = request.resolve(name); break; } catch { /* Try the next configured package boundary. */ }
      }
      if (!resolved) return [{ name, version: null, entry: null }];
      const entry = resolved.replace(/\.js$/, '.d.ts');
      const manifest = join(dirname(dirname(entry)), 'package.json');
      if (!existsSync(entry)) return [{ name, version: null, entry: null }];
      return [{ name, version: JSON.parse(readFileSync(manifest, 'utf8')).version as string, entry }];
    } catch { return [{ name, version: null, entry: null }]; }
  });
  const entries = packages.flatMap(p => p.entry ? [p.entry] : []);
  const program = ts.createProgram(entries, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const needle = query.normalize('NFKC').toLowerCase();
  const capabilities = packages.flatMap(pkg => {
    if (!pkg.entry) return [];
    const file = program.getSourceFile(pkg.entry);
    const module = file && checker.getSymbolAtLocation(file);
    if (!module) return [];
    return checker.getExportsOfModule(module).flatMap(symbol => {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const declaration = target.declarations?.[0];
      if (!declaration) return [];
      const name = symbol.name;
      const description = ts.displayPartsToString(target.getDocumentationComment(checker));
      // 内核日志和审批路由都导出 step；同名符号的用法必须按包限定。
      const key = `${pkg.name}#${name}`, topic = topics[key] ?? topics[name];
      const example = examples[key] ?? examples[name];
      if (needle && !`${name} ${description} ${topic?.words ?? ''}`.normalize('NFKC').toLowerCase().includes(needle)) return [];
      const type = checker.getTypeOfSymbolAtLocation(target, declaration);
      const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call).map(s => checker.signatureToString(s, declaration, ts.TypeFormatFlags.NoTruncation));
      return [{ key, package: pkg.name, version: pkg.version, name, public: true, description,
        signatures: signatures.length ? signatures : [declaration.getText().slice(0, 6000)],
        guide: `docs/ai/${topic?.guide ?? 'README.md'}`, example: example ? { code: example, context: '组合片段；声明中的业务符号须来自当前项目，完整可运行例子见 guide' } : undefined,
        limitations: topic ? ['能力和数据范围仍由实际授权决定；按照当前签名与指南使用。', ...(topic.limitations ?? [])] : [],
        source: { file: declaration.getSourceFile().fileName, line: declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).line + 1 } }];
    });
  });
  return { schemaVersion: 1, cliVersion: VERSION, query, packages: packages.map(({ entry, ...p }) => ({ ...p, inspected: !!entry })), capabilities,
    limitations: ['仅展示当前安装版本的公共导出；签名不代表任意组合均有效。按 guide 查看最小例子、限制及相关错误码。', '未安装的包标为未检查，不据此断言框架不支持。'] };
}
