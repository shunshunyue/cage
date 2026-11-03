// 内核错误码：机器可读，前端与 agent 都按码处理（设计文档第 5 节）。

export const ERROR_HTTP = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  INVALID_TRANSITION: 409,
  CONSTRAINT_VIOLATED: 403,
  INVARIANT_VIOLATED: 409,
  CONFLICT: 409,
  DOMAIN_ERROR: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type CageErrorCode = keyof typeof ERROR_HTTP;

export class CageError extends Error {
  readonly code: CageErrorCode;
  readonly http: number;
  readonly detail?: unknown;
  /** 业务错误码，只有 DOMAIN_ERROR 才有 */
  readonly domainCode?: string;

  constructor(code: CageErrorCode, detail?: unknown, domainCode?: string) {
    super(domainCode ? `${code}:${domainCode}` : code);
    this.name = 'CageError';
    this.code = code;
    this.http = ERROR_HTTP[code];
    this.detail = detail;
    this.domainCode = domainCode;
  }

  toJSON() {
    return { code: this.code, ...(this.domainCode ? { domainCode: this.domainCode } : {}), detail: this.detail };
  }
}

export function cageError(code: CageErrorCode, detail?: unknown): CageError {
  return new CageError(code, detail);
}

export function isCageError(e: unknown): e is CageError {
  return e instanceof CageError || (!!e && (e as any).name === 'CageError' && typeof (e as any).code === 'string');
}

const DOMAIN = Symbol.for('cage.domainError');

/** handler 返回的业务错误。整个事务回滚，HTTP 返回 422 + 业务码。 */
export interface DomainError<C extends string = string> {
  readonly [DOMAIN]: true;
  readonly code: C;
  readonly detail?: unknown;
}

/** 在 handler 里返回业务错误：return fail('STOCK_SHORT', short) */
export function fail<C extends string>(code: C, detail?: unknown): DomainError<C> {
  return Object.freeze({ [DOMAIN]: true as const, code, detail });
}

export function isDomainError(v: unknown): v is DomainError {
  return !!v && typeof v === 'object' && (v as any)[DOMAIN] === true;
}

/** 把任何异常转换成 CageError，不泄露堆栈。 */
export function toCageError(err: unknown): CageError {
  if (isCageError(err)) return err as CageError;
  if (isDomainError(err)) return new CageError('DOMAIN_ERROR', err.detail, err.code);
  const anyErr = err as any;
  if (anyErr?.validation || anyErr?.code === 'FST_ERR_VALIDATION') return new CageError('INVALID_INPUT', anyErr.message);
  if (anyErr?.statusCode === 429) return new CageError('RATE_LIMITED');
  if (anyErr?.statusCode === 413) return new CageError('INVALID_INPUT', '请求体超过大小限制');
  if (anyErr?.statusCode === 403 && /csrf/i.test(String(anyErr?.message))) return new CageError('FORBIDDEN', 'CSRF');
  if (anyErr?.statusCode === 404) return new CageError('NOT_FOUND');
  if (anyErr?.statusCode === 415 || anyErr?.statusCode === 400) return new CageError('INVALID_INPUT', anyErr.message);
  // 数据库序列化失败与死锁：作为冲突返回，调用方重试
  if (anyErr?.code === '40001' || anyErr?.code === '40P01') return new CageError('CONFLICT');
  // 唯一约束冲突（例如确定性主键重复、唯一字段重复）
  if (anyErr?.code === '23505') return new CageError('CONFLICT', { constraint: anyErr.constraint });
  // 检查约束、外键：数据库层兜底拦下的非法数据
  if (anyErr?.code === '23514' || anyErr?.code === '23503') return new CageError('INVALID_INPUT', { constraint: anyErr.constraint });
  return new CageError('INTERNAL');
}

/** 声明期错误（构建时抛出），带错误码，agent 可以查 docs/errors。 */
export function declError(code: string, message: string): Error {
  const e = new Error(`[${code}] ${message}（详见 docs/errors/${code}.md）`);
  e.name = 'CageDeclarationError';
  return e;
}
