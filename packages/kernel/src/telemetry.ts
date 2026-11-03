// 链路追踪：流水线每一关一个 span；写 outbox 时把链路上下文带上，worker 处理时接上。
import { context, propagation, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('cage');

export async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`cage.${name}`, async (span) => {
    try {
      return await fn();
    } catch (e) {
      span.recordException(e as Error);
      throw e;
    } finally {
      span.end();
    }
  });
}

export function traceCarrier(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function withCarrier<T>(carrier: Record<string, string> | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!carrier) return fn();
  const ctx = propagation.extract(context.active(), carrier);
  return context.with(ctx, fn);
}

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  debug?(obj: object | string, msg?: string): void;
}

// 内核也可脱离 HTTP 单独运行；默认不能把任意业务快照、SQL 错误或外部响应写入控制台。
const metadata = new Set(['requestId', 'capability', 'command', 'aggregate', 'aggregateId', 'outboxId', 'event', 'attempts', 'job', 'tenant', 'process', 'code', 'statusCode', 'durationMs', 'rows', 'task', 'workerId', 'scheduledAt', 'reason']);
function consoleRecord(value: object | string): object {
  if (typeof value === 'string') return {};
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'err') {
      const error = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      record.err = { type: item instanceof TypeError ? 'TypeError' : 'Error',
        ...(typeof error.code === 'string' && /^[A-Z0-9_-]{1,64}$/.test(error.code) ? { code: error.code } : {}) };
    } else if (metadata.has(key) && ['string', 'number', 'boolean'].includes(typeof item)) record[key] = item;
  }
  return record;
}
export const consoleLogger: Logger = {
  info: (o, m) => console.log(m ?? (typeof o === 'string' ? o : ''), JSON.stringify(consoleRecord(o))),
  warn: (o, m) => console.warn(m ?? (typeof o === 'string' ? o : ''), JSON.stringify(consoleRecord(o))),
  error: (o, m) => console.error(m ?? (typeof o === 'string' ? o : ''), JSON.stringify(consoleRecord(o))),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
