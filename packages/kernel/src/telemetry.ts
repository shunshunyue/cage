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

export const consoleLogger: Logger = {
  info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : JSON.stringify(o)),
  warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : JSON.stringify(o)),
  error: (o, m) => console.error(m ?? '', typeof o === 'string' ? o : JSON.stringify(o)),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
