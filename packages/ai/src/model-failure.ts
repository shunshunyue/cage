/**
 * 把上游协议、连接器和网络异常转为可持久化的模型故障分类。
 * 模型适配器负责抛出协议错误，运行时用这里的稳定代码记录事件；不保留原始错误正文、参数碎片或凭据，不在此决定重试。
 */
import { ConnectorError } from '@yss123/cage-connectors';

/**
 * 模型返回已到达但不能作为完整结果使用的封闭原因集合；区分厂商拒绝、输出截断、结构/参数错误和终态不一致，便于诊断预算与协议问题。
 */
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

/**
 * 运行记录可安全保存的故障摘要。
 * 可选字段只在异常提供相应证据时出现；没有证据不能推断 HTTP 状态、网络错误或厂商停止原因。
 */
export interface ModelFailure {
  /**
   * 稳定的细分原因；未知错误仅记 request_failed。
   */
  reason: string;
  /**
   * 可选框架错误码，用于界面与诊断分类。
   */
  code?: string;
  /**
   * 连接器实际取得的 HTTP 状态；没有响应时不填。
   */
  httpStatus?: number;
  /**
   * 经过字符白名单过滤的上游错误代码，不是上游 message。
   */
  providerCode?: string;
  /**
   * 经过白名单过滤的生成终止原因，例如输出长度限制。
   */
  stopReason?: string;
  /**
   * 允许列表内的网络或 TLS 代码；不记录任意 cause 内容。
   */
  networkCode?: string;
}

/** 只允许稳定代码进入运行记录；上游 message、正文和解析器片段可能含凭据或业务内容。 */
export function providerErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined;
}

/**
 * 统一表达模型协议错误，并把原因映射成稳定 AI_MODEL_* 错误码。
 * 错误消息只含框架代码；details 用于携带可筛选的厂商代码和终止原因，不接收原始响应正文。
 */
export class ModelResponseError extends Error {
  /**
   * 根据 reason 映射出的稳定框架错误码。
   */
  readonly code: string;
  /**
   * 根据输出上限、不完整、厂商失败或其余协议错误选择稳定代码，保留具体 reason 供运行时诊断；不触发请求重试。
   */
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

/**
 * 解析模型 JSON 或函数参数 JSON；解析失败抛带指定原因的统一异常。
 * 刻意不转发 JSON.parse 的错误片段，避免模型正文或业务数据进入日志。返回值仍需后续结构 schema 校验。
 */
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
