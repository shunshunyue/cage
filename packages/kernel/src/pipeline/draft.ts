// 执行与诊断共用输入拆分和 handler 之前的草稿，避免解释器发明默认字段或不同版本语义。
import { randomUUID } from 'node:crypto';
import { cageError } from '../errors.js';
import type { AnyCommand } from '../primitives/command.js';
import type { Fields } from '../primitives/fields.js';
import type { Ctx } from '../types.js';

export function splitRaw(raw: unknown): { expectedVersion?: number; rest: unknown } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { rest: raw ?? {} };
  const { expectedVersion, ...rest } = raw as Record<string, unknown>;
  if (expectedVersion === undefined || expectedVersion === null) return { rest };
  const version = Number(expectedVersion);
  if (!Number.isInteger(version)) throw cageError('INVALID_INPUT', [{ path: 'expectedVersion', message: '版本号必须是整数' }]);
  return { expectedVersion: version, rest };
}

export function newDraft(command: AnyCommand, input: Record<string, unknown>, ctx: Ctx, now: Date): Record<string, any> {
  const aggregate = command.agg;
  const draft: Record<string, unknown> = {
    id: typeof input.id === 'string' ? input.id : randomUUID(), status: command.to, version: 0,
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
  for (const [name, field] of Object.entries(aggregate.fields as Fields)) {
    if (field.kind !== 'hasMany') draft[name] = name in input ? input[name] : field.kind === 'manyToMany' || field.kind === 'files' ? [] : null;
  }
  const department = aggregate.scope.deptField;
  if (department && department !== 'id' && draft[department] == null) draft[department] = ctx.deptId;
  return draft;
}
