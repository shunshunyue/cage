/**
 * 根据框架唯一 Skill 正文生成仓库/模板中的发现入口，由模板同步与资料检查复用。
 * 入口仅携带同源元数据和正文链接，避免各 agent 拥有不同教学内容；不安装全局配置或操作数据库。
 * 生成目标固定在调用方指定的框架快照根；这些入口由脚本拥有，业务项目的自有规则放在 AGENTS 托管区外。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 规范正文在框架与所有独立分发模板内的相同位置，避免依赖宿主专属绝对路径。 */
export const skillDocument = 'docs/development/skills/cage-development/SKILL.md';

/**
 * 返回相对目标根目录的入口路径和期望文本，元数据直接来自目标根内已同步的规范正文。
 * @param application 框架仓库或由同步脚本管理的模板绝对根目录。
 * @returns 两个完整文本；不写文件。正文缺失或没有规范 frontmatter 时拒绝生成。
 */
export function agentSkillEntries(application: string): Record<string, string> {
  const source = readFileSync(join(application, skillDocument), 'utf8');
  const metadata = source.match(/^---\r?\n[\s\S]+?\r?\n---/);
  if (!metadata) throw new Error(`框架 Skill 缺少 frontmatter：${skillDocument}`);
  return {
    '.agents/skills/cage-development/SKILL.md': `${metadata[0]}

<!-- 由 scripts/sync-agent-skill.ts 生成；教学正文只在 docs/development 维护。 -->

加载本技能后，先阅读[完整框架开发方法](../../../${skillDocument})，再根据其中的任务选择表读取相关专题。
正文规定先理解需求、提出疑问与建议、查证框架，再说明实现映射、编码和验收；不要只凭本入口的摘要开始编写业务。
当前项目的业务要求与 AGENTS.md 仍适用，框架维护任务遵守仓库的包边界。
`,
    'CLAUDE.md': `<!-- 由 scripts/sync-agent-skill.ts 生成；共享同一套框架教材。 -->
# Cage 开发入口

先读本目录 [AGENTS.md](AGENTS.md) 的项目说明和约定。
进行 Cage 业务开发或排错时，阅读[框架开发 Skill](${skillDocument})，按任务选择章节并完成对应验证。
这是框架维护的通用教学流程；具体业务以用户需求和项目约定为准。
`,
  };
}

/**
 * 写入同源的 agent 发现入口；只更新内容有差异的文件，供模板同步调用。
 * 不递归复制教材、不修改 AGENTS 或全局宿主设置；IO 错误向调用者传播，修复后可重跑。
 */
export function syncAgentSkill(application: string): void {
  for (const [path, content] of Object.entries(agentSkillEntries(application))) {
    const target = join(application, path);
    if (existsSync(target) && readFileSync(target, 'utf8') === content) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
