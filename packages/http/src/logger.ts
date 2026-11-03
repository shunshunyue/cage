// 默认只记录执行元数据。领域载荷必须显式经过递归脱敏，不能依赖对象恰好处于某个深度。
import type { Fields, Logger, Registry } from '@yss123/cage-kernel';

const SECRET_NAMES = ['password', 'passwordHash', 'password_hash', 'cookie', 'authorization', 'token', 'access_token', 'refresh_token', 'client_secret', 'secret', 'x-csrf-token', 'set-cookie'];
const METADATA = new Set(['requestId', 'capability', 'command', 'aggregate', 'aggregateId', 'outboxId', 'event', 'attempts', 'job', 'tenant', 'process', 'code', 'statusCode', 'durationMs', 'rows', 'addr', 'operation', 'kind', 'task', 'reason', 'consumer', 'connector', 'workerId', 'phase', 'retryable']);

function sensitiveNames(reg: Registry): Set<string> {
  const names = new Set(SECRET_NAMES.map((name) => name.toLowerCase()));
  const collect = (fields: Readonly<Fields>) => {
    for (const [name, field] of Object.entries(fields)) {
      if (field.sensitiveKind || field.isHidden) {
        names.add(name.toLowerCase());
        names.add(name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`));
      }
      if (field.shape) collect(field.shape);
    }
  };
  for (const declaration of [...reg.aggregates, ...reg.events]) {
    collect(declaration.fields as Fields);
  }
  return names;
}

/** URL 的查询参数、片段和用户信息均不进入日志。 */
export function logUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { return new URL(value, 'http://cage.invalid').pathname; } catch { return undefined; }
}

/** 错误文本与堆栈可能包含 SQL、凭据或业务值，只保留机器可读的错误类别。 */
export function logError(value: unknown): Record<string, unknown> {
  const error = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const code = typeof error.code === 'string' && /^[A-Z0-9_-]{1,64}$/.test(error.code) ? error.code : undefined;
  return { type: error instanceof TypeError ? 'TypeError' : 'Error', ...(code ? { code } : {}) };
}

/** 供受控结构化日志使用；数组、嵌套字段、循环引用均有明确处理，原对象保持不变。 */
export function createLogSanitizer(reg: Registry): (value: unknown) => unknown {
  const names = sensitiveNames(reg);
  return (value) => {
    const seen = new WeakSet<object>();
    const visit = (item: unknown, key = ''): unknown => {
      if (names.has(key.toLowerCase())) return '***';
      if (key === 'err' || item instanceof Error) return logError(item);
      if (key === 'url') return logUrl(item);
      if (!item || typeof item !== 'object') return item;
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
      const result = Array.isArray(item) ? item.map((child) => visit(child))
        : Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child, name)]));
      seen.delete(item);
      return result;
    };
    return visit(value);
  };
}

/** 保留兼容入口；真正的日志处理由递归序列化器承担。 */
export function sensitiveFieldPaths(reg: Registry): string[] {
  const names = new Set<string>();
  const collect = (fields: Readonly<Fields>) => {
    for (const [name, field] of Object.entries(fields)) {
      if (field.sensitiveKind || field.isHidden) names.add(name);
      if (field.shape) collect(field.shape);
    }
  };
  for (const declaration of [...reg.aggregates, ...reg.events]) collect(declaration.fields as Fields);
  return [...names].flatMap((name) => [`*.${name}`, `req.body.${name}`]);
}

export function buildLogger(reg: Registry): object {
  const sanitize = createLogSanitizer(reg);
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    serializers: {
      err: logError,
      req: (req: any) => ({ id: req.id, method: req.method, url: logUrl(req.url) }),
      res: (res: any) => ({ statusCode: res.statusCode }),
    },
    formatters: {
      log(record: Record<string, unknown>) {
        const safe: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
          if (key === 'err') safe.err = logError(value);
          else if (key === 'url') safe.url = logUrl(value);
          else if (key === 'req' && value && typeof value === 'object') {
            const req = value as Record<string, unknown>;
            safe.req = { id: req.id, method: req.method, url: logUrl(req.url) };
          } else if (key === 'res' && value && typeof value === 'object') safe.res = { statusCode: (value as any).statusCode };
          else if (METADATA.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value;
        }
        return sanitize(safe);
      },
    },
  };
}

/** 无 HTTP 服务实例的 worker 也使用同一元数据白名单，不退回原始 console 序列化。 */
export function createSafeLogger(reg: Registry): Logger {
  const options = buildLogger(reg) as { formatters: { log(record: Record<string, unknown>): unknown } };
  const levels = ['debug', 'info', 'warn', 'error'] as const;
  const thresholds: Record<string, number> = { trace: 0, debug: 0, info: 1, warn: 2, error: 3, fatal: 4, silent: Infinity };
  const threshold = thresholds[process.env.LOG_LEVEL ?? 'info'] ?? 1;
  const output = (level: typeof levels[number], object: object | string, message?: string) => {
    if (levels.indexOf(level) < threshold) return;
    const record = typeof object === 'string' ? {} : options.formatters.log(object as Record<string, unknown>);
    const serialized = JSON.stringify({ time: new Date().toISOString(), level, ...record as object, msg: message ?? (typeof object === 'string' ? object : undefined) });
    console[level](serialized);
  };
  return {
    debug: (object, message) => output('debug', object, message),
    info: (object, message) => output('info', object, message),
    warn: (object, message) => output('warn', object, message),
    error: (object, message) => output('error', object, message),
  };
}
