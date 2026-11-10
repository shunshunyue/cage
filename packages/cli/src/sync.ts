/**
 * 维护业务项目 AGENTS.md 中由框架拥有的协作规范。
 * create 和 upgrade 复用这里的托管文本，sync 只替换 begin/end 标记之间的内容，
 * 保留标记外的客户业务约定；它不修改业务源码、角色授权或数据库。
 * 规范文本变更后须同步标准范例、两套模板并重新构建 CLI，才能随脚手架分发。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { abs, type CageConfig } from './config.js';
import type { Finding } from './findings.js';
import { VERSION } from './version.js';

/** 当前 CLI 版本对应的项目协作说明；引导 agent 查证框架能力、与用户确定业务并实施，由 create/sync/upgrade 分发，不执行运行时业务配置。 */
export const managedBlock = `<!-- cage:begin v${VERSION} -->
## Cage 业务开发约定（框架托管）

### 学习与任务入口

本项目使用 \`@yss123/cage-*\`，业务写在本项目。先读项目说明指定的教材；独立项目默认入口是 \`docs/development/README.md\`。

开始 Cage 业务开发或排错时，加载 \`docs/development/skills/cage-development/SKILL.md\`。它讲清运行模型、业务澄清、能力选择、实施与验收方法；首次学习配合 \`docs/development/getting-started/first-feature.md\`。已熟悉时只读受影响专题，普通样式/文案改动无需重走业务建模。

支持 Agent Skills 的工具可发现 \`.agents/skills/cage-development\`；其他工具直接读取上述 Markdown，使用相同流程。教材随框架版本分发，均为本地文件，不需要额外服务、模型或索引。框架仓库范例使用项目说明指定的规范教材位置。

### 框架执行什么

- 业务声明从 domain 总入口导出，框架据此构建注册表、能力、HTTP 接口、本体图、契约与迁移草稿；只有文件而未导出不会生效。
- 命令是业务写入口；handler 描述变化与显式 reads，内核处理授权、状态、范围、版本、事务、审计及 outbox。读侧通过生成契约或 query 的安全视图，外部 IO 通过连接器。
- 角色、能力、数据范围、调用身份与业务约束分别建模。前端 can() 只影响显示，新增能力不自动授给生产角色；审批选人不授予能力。
- 页面依赖生成契约及客户端。表单、弹窗等临时状态留在前端；正式业务数据和流程结果通过服务端读写。实际记录不能用模拟仓储或固定统计替代。

### 实现与排错

1. 阅读需求、文档和现有实现后，按 \`docs/development/guides/business-collaboration.md\` 主动提出疑点、可行选项、影响与推荐理由，让用户选择业务规则；沿用已明确的选择与授权，等待回答时推进独立部分，可选建议不阻塞已明确任务。再把确定的规则映射到聚合、命令、归属/范围、后续行为与验收，沿已有模块修改。具体选择看 \`docs/development/guides/recipes.md\`，目录归属看 \`docs/development/reference/project-structure.md\`。
2. 不熟悉的 API 先按手册任务目录定位，用本地文件搜索查术语，再执行 \`pnpm exec cage capabilities 符号 --format json\` 核对当前版本签名；\`cage context "业务关键词"\` 定位当前应用。未命中不代表不支持，不发明方法或返回字段。
3. 涉及已有领域含义变化，先 \`pnpm exec cage snapshot save before-change\` 保存本体基线，或使用真实 Git 基线。修改声明与导出，运行 check/gen，审查契约和迁移草稿。生成物不手改，已执行迁移不可改写。
4. 页面使用真实契约，处理业务失败、版本冲突、会话与缓存；多页面使用独立 URL，列表筛选/分页进入查询参数。按 \`docs/development/guides/routing.md\` 验收深链接、刷新、登录回跳和无权限行为。
5. 出错保留 code/at/reason/fix，查 \`docs/errors/README.md\` 与 \`docs/development/tools/troubleshooting.md\`；从真实调用逐层定位。不得放宽权限、删约束或关闭门禁来掩盖问题。

遇到原生 AI、AI 审批或随页助理，先读 \`docs/development/guides/intelligence.md\`，核对已有能力及应用启用状态。审批、文件、关系、数据传输等专题由 Skill 按需引导，不重建框架已有运行时。

### 代码与环境边界

- 所有手写代码遵守 \`docs/development/reference/commenting.md\`：文件职责与调用链、导出 API/字段、复杂分支的中文说明，写清做什么、为什么、怎样完成及实际边界；随代码更新。生成物注释从生成器维护。
- domain 按 modules/workflows/integrations/shared 组织，Web 按 app/modules/shared 组织。模块通过 index.ts 公开入口组合，前端不导入 domain、数据库或内核运行时；不关闭 modular 目录门禁。
- 新项目启动步骤见 \`docs/development/getting-started/workflow.md\`。使用已有 PostgreSQL 和项目 .env；init 准备账号，migrate 更新结构，bootstrap 显式初始化组织，dev 启动进程。普通业务不新增连接池或管理 Docker。
- 不输出或提交 .env、数据库密码、Cookie 密钥及初始化凭据。API 与 worker 使用一致的 domain，修改配置后按实际需要重启。

### 完成依据

验证与改动匹配。check/gen/typecheck/build 证明各自检查范围；业务读写还需独立读取结果，权限需直接请求验证，审批需待办与结论，文件需实际内容，异步需任务终态，页面需浏览器操作。

\`pnpm verify\` 汇总门禁；\`verify --skip-tests\` 不代表完整通过。诊断用 \`cage doctor\`、\`timeline\`、\`explain\`，具体前提见 \`docs/development/tools/diagnostics.md\`。交付分别说明通过、跳过、未执行及剩余配置；文档和可逆小改动不反复执行全量数据库回归。
<!-- cage:end -->`;

/**
 * 将现有文档中的唯一托管区替换为目标版本，返回完整文本而不写文件。
 * 未出现任何标记时把托管区放在原文前；缺一个标记、标记重复或顺序反转时拒绝处理，
 * 避免猜测边界后覆盖用户内容。latest 可由调用者提供，默认使用本包规范。
 */
export function syncManagedBlock(current: string, latest = managedBlock): string {
  const starts = [...current.matchAll(/<!-- cage:begin[^\n]*-->/g)];
  const ends = [...current.matchAll(/<!-- cage:end -->/g)];
  if (!starts.length && !ends.length) return latest + '\n\n' + current;
  if (starts.length !== 1 || ends.length !== 1 || ends[0].index! < starts[0].index!) {
    throw new Error('[CAGE-SYNC-001] 托管区标记不完整或重复，请修复 AGENTS.md 的 begin/end 标记');
  }
  return current.slice(0, starts[0].index) + latest + current.slice(ends[0].index! + ends[0][0].length);
}

/**
 * 在项目根目录同步或检查 AGENTS.md，不遍历和改写项目源码。
 * check=true 时只比较并返回 CAGE-SYNC-001 修复提示；普通模式在内容变化时创建父目录并写入。
 * 没有差异时返回空诊断。托管标记异常由 syncManagedBlock 抛出，文件系统错误向调用方传播。
 */
export function sync(cfg: CageConfig, check = false): Finding[] {
  const file = abs(cfg, 'AGENTS.md');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const after = syncManagedBlock(before);
  if (after === before) return [];
  if (check)
    return [
      {
        code: 'CAGE-SYNC-001',
        at: 'AGENTS.md',
        reason: '框架托管区需要同步',
        fix: '运行 cage sync；项目自有内容会保留',
      },
    ];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, after);
  return [];
}
