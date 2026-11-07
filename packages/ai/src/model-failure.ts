import { ConnectorError } from '@yss123/cage-connectors';

type ResponseFailure =
  | 'provider_error'
  | 'incomplete'
  | 'output_limit'
  | 'invalid_json'
  | 'invalid_arguments'
  | 'invalid_output'
  | 'invalid_terminal'
  | 'unexpected_tool'
  | 'text_mismatch';

export interface ModelFailure {
  reason: string;
  code?: string;
  httpStatus?: number;
  providerCode?: string;
  stopReason?: string;
  networkCode?: string;
}

/** 只允许稳定代码进入运行记录；上游 message、正文和解析器片段可能含凭据或业务内容。 */
export function providerErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined;
}

export class ModelResponseError extends Error {
  readonly code: string;
  constructor(
    readonly reason: ResponseFailure,
    readonly details: { providerCode?: string; stopReason?: string } = {},
  ) {
    const code =
      reason === 'output_limit'
        ? 'AI_MODEL_OUTPUT_LIMIT'
        : reason === 'incomplete'
          ? 'AI_MODEL_INCOMPLETE'
          : reason === 'provider_error'
            ? 'AI_MODEL_UPSTREAM_ERROR'
            : 'AI_MODEL_RESPONSE_INVALID';
    super(code);
    this.name = 'ModelResponseError';
    this.code = code;
  }
}

export function parseModelJson(value: string, reason: 'invalid_json' | 'invalid_arguments'): any {
  try {
    return JSON.parse(value);
  } catch {
    throw new ModelResponseError(reason);
  }
}

/** 分类不改变重试策略；没有证据时保留未知，不能把所有失败都叫超时或网络中断。 */
export function modelFailure(error: unknown): ModelFailure {
  if (error instanceof ModelResponseError)
    return {
      code: error.code,
      reason: error.reason,
      providerCode: providerErrorCode(error.details.providerCode),
      stopReason: providerErrorCode(error.details.stopReason),
    };
  if (error instanceof ConnectorError)
    return {
      code:
        error.status === 429
          ? 'AI_MODEL_RATE_LIMITED'
          : error.status && error.status >= 400
            ? 'AI_MODEL_HTTP_ERROR'
            : 'AI_MODEL_CONNECTION_FAILED',
      reason: error.status && error.status >= 400 ? 'http_error' : 'transport_error',
      ...(error.status !== null ? { httpStatus: error.status } : {}),
      providerCode: providerErrorCode(error.providerCode),
    };
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return { code: 'AI_MODEL_TIMEOUT', reason: 'request_timeout' };
    if (error.name === 'AbortError') return { code: 'AI_MODEL_INTERRUPTED', reason: 'request_aborted' };
    const cause = error.cause;
    const value = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
    const networkCode = providerErrorCode(value);
    if (
      networkCode &&
      /^(?:E(?:CONNRESET|CONNREFUSED|TIMEDOUT|HOSTUNREACH|NETUNREACH|AI_AGAIN|NOTFOUND|PIPE)|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+)$/.test(
        networkCode,
      )
    )
      return { code: 'AI_MODEL_CONNECTION_FAILED', reason: 'network_error', networkCode };
  }
  return { reason: 'request_failed' };
}
