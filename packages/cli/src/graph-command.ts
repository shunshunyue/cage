/**
 * graph search/inspect/path 与 context 的命令行参数和输出适配层。
 * 校验查询参数适用范围与数值，取得一次独立抽取快照，再调用共享查询或上下文构建器。
 * 可写指定报告文件但不改当前本体缓存；未命中、歧义或图规则错误返回非零退出码。
 */
// CLI 负责参数和输出；查询函数本身可组合，Web 和其他工具无需再解析终端文本。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { abs, type CageConfig } from './config.js';
import { errorsOnly } from './findings.js';
import { collectGraph } from './graph.js';
import { kindLabels, type ViewNode } from './graph-model.js';
import { searchGraph, inspectGraph, findGraphPath, formatGraphQuery } from './graph-query.js';
import { buildContext, formatContext } from './context.js';

/**
 * 查询分支接受的原始 CLI 字符串选项，在执行前按子命令校验。
 */
interface QueryOptions {
  /** 命令行输入的深度文本，后续解析并验证范围。 */
  depth?: string;
  /** 节点/结果上限文本，不自动证明覆盖完整。 */
  limit?: string;
  /** 可选节点种类筛选，必须属于支持词汇。 */
  kind?: string;
  /** 路径遍历方向，both 允许反向读取关系。 */
  direction?: string;
  /** 报告输出格式，支持值由入口校验。 */
  format?: string;
  /** 可选输出文件路径；缺省写标准输出。 */
  out?: string;
}

/**
 * 把可选字符串转换为有下界的安全整数。
 * @param name 错误文案中的参数名。
 * @param raw 原始 CLI 值，undefined 使用默认值。
 * @param fallback 缺省值。
 * @param minimum 允许最小值。
 * @returns 整数；空白、非整数或越界抛出。
 */
function integerOption(name: string, raw: string | undefined, fallback: number, minimum: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(value) || value < minimum)
    throw new Error(`--${name} 必须是大于等于 ${minimum} 的整数`);
  return value;
}

/**
 * 校验查询参数、抽取新快照并输出 JSON 或 Markdown。
 * @param cfg 应用配置。
 * @param action 支持的查询操作。
 * @param targets 一个需求/节点，path 为两个端点。
 * @param options 格式、输出路径和各操作的边界参数。
 * @returns 命中且无错误为 0，否则为 1；out 可写报告，但不更新本体缓存。
 */
export async function graphCommand(
  cfg: CageConfig,
  action: 'context' | 'search' | 'inspect' | 'path',
  targets: string[],
  options: QueryOptions,
): Promise<number> {
  const count = action === 'path' ? 2 : 1;
  if (targets.length !== count || targets.some((target) => !target.trim()))
    throw new Error(
      action === 'path'
        ? 'graph path 需要两个节点：cage graph path <起点> <终点>'
        : `${action} 需要一个关键词或节点；含空格的需求请用引号包住`,
    );
  if (options.format && !['md', 'json'].includes(options.format))
    throw new Error('--format 只能是 md 或 json');
  if (options.kind && !Object.hasOwn(kindLabels, options.kind))
    throw new Error(`未知节点类型 ${options.kind}`);
  if (options.direction && !['out', 'both'].includes(options.direction))
    throw new Error('--direction 只能是 out 或 both');
  const optionActions = {
    kind: ['search'],
    direction: ['path'],
    depth: ['context', 'path'],
    limit: ['context', 'search'],
  };
  for (const [option, actions] of Object.entries(optionActions))
    if (options[option as keyof typeof optionActions] !== undefined && !actions.includes(action))
      throw new Error(`--${option} 只用于 ${actions.join(' / ')} 查询`);
  const depth = integerOption('depth', options.depth, action === 'path' ? 6 : 3, 0);
  const limit = integerOption('limit', options.limit, action === 'search' ? 10 : 40, 1);
  const snapshot = await collectGraph(cfg.root);
  const report =
    action === 'context'
      ? buildContext(cfg, snapshot, targets[0], { depth, limit })
      : action === 'search'
        ? searchGraph(snapshot, targets[0], { limit, kind: options.kind as ViewNode['kind'] | undefined })
        : action === 'inspect'
          ? inspectGraph(snapshot, targets[0])
          : findGraphPath(snapshot, targets[0], targets[1], {
              depth,
              direction: options.direction as 'out' | 'both' | undefined,
            });
  const output =
    options.format === 'json'
      ? JSON.stringify(report, null, 2)
      : report.operation === 'context'
        ? formatContext(report)
        : formatGraphQuery(report);
  if (options.out) {
    const file = abs(cfg, options.out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, output + '\n');
  } else console.log(output);
  // 图规则失败时仍交付上下文帮助定位，但不能用成功退出码掩盖错误。
  return report.status === 'ok' && errorsOnly(report.findings).length === 0 ? 0 : 1;
}
