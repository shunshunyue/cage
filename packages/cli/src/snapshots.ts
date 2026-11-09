/**
 * 保存、读取和列出命名本体基线，供修改前留证及 impact 比较。
 * 名称限制为安全文件名，保存前重新分析声明并附时间、框架版本和 SHA-256 指纹。
 * 快照以独占写入避免覆盖；普通查询不修改这些文件，读取失败或非法 JSON 直接向调用方报告。
 */
// Named baselines are immutable records; ordinary graph queries never write them.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { abs, type CageConfig } from './config.js';
import { analyze } from './analyze.js';
import { errorsOnly } from './findings.js';
import type { Ontology } from './ontology.js';
import { VERSION } from './version.js';

/**
 * 命名基线信封，保存来源时间、版本、指纹和完整本体；不是可反复覆盖的当前缓存。
 */
export interface NamedSnapshot { /** 命名快照信封结构版本，独立于内层本体版本。 */ schemaVersion: 1; /** 经过安全校验的快照名，用于文件定位。 */ name: string; /** 保存时的 ISO 时间，不会随后续分析刷新。 */ createdAt: string; /** 保存该基线的 CLI/框架版本。 */ frameworkVersion: string; /** 按图内容计算的摘要，用于核对快照身份。 */ graphHash: string; /** 保存时的完整本体，供后续 impact 比较。 */ graph: Ontology }
/**
 * 限制安全命名并生成固定目录下的快照路径。
 * @param cfg 应用根。
 * @param name 字母开头，最多 64 字符，只含字母数字、下划线或连字符。
 * @returns .cage/snapshots 内路径；非法名称抛 CAGE-IMPACT-002。
 */
export function snapshotPath(cfg: CageConfig, name: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('[CAGE-IMPACT-002] 快照名称须以字母开头，只含字母、数字、下划线或连字符');
  return abs(cfg, `.cage/snapshots/${name}.json`);
}
/**
 * 读取命名快照，不重新分析领域。
 * @param cfg 应用配置。
 * @param name 快照名，仍会验证安全命名。
 * @returns JSON 信封；文件缺失或损坏时抛出，不自动创建。
 */
export function readSnapshot(cfg: CageConfig, name: string): NamedSnapshot {
  return JSON.parse(readFileSync(snapshotPath(cfg, name), 'utf8'));
}
/**
 * 按文件名稳定列出基线。
 * @param cfg 应用根配置。
 * @returns 快照数组，目录不存在时为空；损坏文件的错误不吞掉。
 */
export function listSnapshots(cfg: CageConfig): NamedSnapshot[] {
  const dir = abs(cfg, '.cage/snapshots');
  return existsSync(dir) ? readdirSync(dir).filter(p => p.endsWith('.json')).sort().map(p => JSON.parse(readFileSync(join(dir, p), 'utf8'))) : [];
}
/**
 * 重新抽取通过规则的声明并独占保存基线。
 * @param cfg 当前应用配置。
 * @param name 尚未使用的名称。
 * @returns 已保存信封；声明错误、同名或 IO 失败抛出，wx 防止并发覆盖。
 */
export async function saveSnapshot(cfg: CageConfig, name: string): Promise<NamedSnapshot> {
  const file = snapshotPath(cfg, name);
  if (existsSync(file)) throw new Error(`[CAGE-IMPACT-002] 快照 ${name} 已存在，请使用新名称；已有比较基线不会被覆盖`);
  const result = await analyze(cfg);
  if (!result.graph || errorsOnly(result.findings).length) throw new Error('[CAGE-IMPACT-002] 声明检查未通过，不能建立比较基线');
  const snapshot: NamedSnapshot = { schemaVersion: 1, name, createdAt: new Date().toISOString(), frameworkVersion: VERSION, graphHash: createHash('sha256').update(JSON.stringify(result.graph)).digest('hex'), graph: result.graph };
  mkdirSync(abs(cfg, '.cage/snapshots'), { recursive: true });
  // Exclusive creation prevents a repeated command from silently changing the comparison point.
  writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
  return snapshot;
}
