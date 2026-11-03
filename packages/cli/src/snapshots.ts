// Named baselines are immutable records; ordinary graph queries never write them.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { abs, type CageConfig } from './config.js';
import { analyze } from './analyze.js';
import { errorsOnly } from './findings.js';
import type { Ontology } from './ontology.js';
import { VERSION } from './version.js';

export interface NamedSnapshot { schemaVersion: 1; name: string; createdAt: string; frameworkVersion: string; graphHash: string; graph: Ontology }
export function snapshotPath(cfg: CageConfig, name: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('[CAGE-IMPACT-002] 快照名称须以字母开头，只含字母、数字、下划线或连字符');
  return abs(cfg, `.cage/snapshots/${name}.json`);
}
export function readSnapshot(cfg: CageConfig, name: string): NamedSnapshot {
  return JSON.parse(readFileSync(snapshotPath(cfg, name), 'utf8'));
}
export function listSnapshots(cfg: CageConfig): NamedSnapshot[] {
  const dir = abs(cfg, '.cage/snapshots');
  return existsSync(dir) ? readdirSync(dir).filter(p => p.endsWith('.json')).sort().map(p => JSON.parse(readFileSync(join(dir, p), 'utf8'))) : [];
}
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
