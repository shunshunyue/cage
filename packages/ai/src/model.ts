/**
 * 将 OpenAI 兼容 Chat Completions SSE 转换为框架统一的模型结果。
 * 由 ai 声明或模型管理器创建 provider，实际网络请求复用连接器的主机、密钥、超时与限速边界；这里只解析模型输出，不执行工具，也不把生成文本当作业务成功。
 */
import { connector, stage, streamJson, type ConnectorDef } from '@yss123/cage-connectors';
import { z } from 'zod';
import type { ModelProvider, ModelRequest, ModelResult } from './types.js';
import { ModelResponseError, parseModelJson, providerErrorCode } from './model-failure.js';

/**
 * 限定统一结果的文本、工具调用、用量与远端状态形状。
 * 单轮最多 40 个调用、文本最多 100000 字符；schema 只验证结构，调用名和参数的业务授权由工具目录继续校验。
 */
const resultSchema = z.object({ text: z.string().max(100_000), calls: z.array(z.object({
  id: z.string().min(1).max(160), name: z.string().min(1).max(160), arguments: z.record(z.string(), z.unknown()),
}).strict()).max(40), usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).optional(), finishReason: z.string().optional(),
  responseId: z.string().min(1).max(512).optional(), outputItems: z.array(z.record(z.string(), z.unknown())).max(100).optional() });

/**
 * 验证真实或 fake provider 的统一输出，并拒绝重复工具调用 ID。
 * 返回经过 schema 解析的数据；结构错误统一抛 ModelResponseError，避免原始模型正文随解析诊断泄漏。该检查不执行工具，也不验证用量是否为厂商真实计费。
 */
export function validateModelResult(value: unknown): ModelResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) throw new ModelResponseError('invalid_output');
  const result = parsed.data;
  if (new Set(result.calls.map(call => call.id)).size !== result.calls.length) throw new ModelResponseError('invalid_output');
  return result;
}

/**
 * Chat 协议 provider 的声明配置。
 * 主机按连接器环境选择，凭据只在服务端发请求时解析；默认上下文窗口供请求预算使用，不代表网关实际限制已被探测。
 */
export interface ChatModelOptions {
  /**
   * 网关模型标识，原样写入请求；与 Cage 声明使用的模型别名不同。
   */
  model: string; /** 按 fake/test/prod 环境声明的允许主机，实际出站由连接器检查。 */ hosts: ConnectorDef<{}>['hosts']; /** 可选的服务端密钥名称；配置中不保存密钥明文。 */ secret?: string; /** 模型接口绝对路径；省略时使用 Chat Completions 标准路径。 */ path?: string; /** 连接器请求超时，单位毫秒；省略时为 90000。 */ timeoutMs?: number;
  /** 模型可独立连接测试服务，不要求 ERP 等其他连接器同时切换环境。省略时沿用 CAGE_STAGE。 */
  environment?: 'fake' | 'test' | 'prod';
  /** 默认 HTTPS；显式声明 HTTP 可连接本地或内网模型网关。 */
  protocol?: 'http:' | 'https:';
  /** 服务端凭据解析器；不进入 spec、注册表、请求正文或日志。 */
  credential?: () => Promise<string>;
  /**
   * 可选每秒请求限额，具体调度由连接器承担。
   */
  rateLimit?: { perSecond: number };
  /**
   * 声明的模型总上下文窗口，单位 Token；省略时为 32768，预算估算并非厂商 tokenizer。
   */
  contextWindowTokens?: number;
  /** 本地/CI 不生成看似可信的随机裁决，必须显式提供 fake。 */
  fake?: (request: ModelRequest) => Promise<ModelResult> | ModelResult;
}

/** OpenAI-compatible chat/completions 协议适配；不依赖特定厂商或 Agent 框架。 */
/**
 * 构造延迟执行的 Chat Completions provider，默认路径为 /v1/chat/completions、超时 90 秒。
 * 每次 generate 在 fake 环境要求显式回调；真实请求只发送模型协议消息与工具 schema，按 index 拼接工具参数碎片并逐块等待 onText。
 * 流结束必须同时收到 [DONE] 和 stop/tool_calls 终止原因；截断、无效 JSON 或不完整输出拒绝进入工具执行。返回的 provider 不自行重试请求。
 */
export function chatModel(name: string, options: ChatModelOptions): ModelProvider {
  const transport = connector(name, { hosts: options.hosts, secret: options.secret, timeoutMs: options.timeoutMs ?? 90_000,
    rateLimit: options.rateLimit, operations: {} });
  const path = options.path ?? '/v1/chat/completions';
  return {
    contextWindowTokens: options.contextWindowTokens ?? 32768,
    spec: { kind: 'chat-completions', name, model: options.model, hosts: options.hosts, secret: options.secret, path, timeoutMs: transport.timeoutMs, environment: options.environment, protocol: options.protocol, contextWindowTokens: options.contextWindowTokens ?? 32768 },
    async generate(request) {
      const environment = options.environment ?? stage();
      if (environment === 'fake') {
        if (!options.fake) throw new Error('模型未配置 fake；真实联调需显式选择 test/prod 阶段');
        return validateModelResult(await options.fake(request));
      }
      let text = '', finishReason: string | undefined, usage: ModelResult['usage'], done = false;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      await streamJson(transport, path, { model: options.model, stream: true, stream_options: { include_usage: true },
        max_tokens: request.maxOutputTokens,
        messages: request.messages.map(m => ({ role: m.role, content: m.content || null,
          ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) })),
        ...(request.tools.length ? { tools: request.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input } })) } : {}),
      }, request.signal, async data => {
        if (data === '[DONE]') { done = true; return; }
        const chunk = parseModelJson(data, 'invalid_json');
        if (!chunk || typeof chunk !== 'object') throw new ModelResponseError('invalid_output');
        if (chunk.error) throw new ModelResponseError('provider_error', { providerCode: providerErrorCode(chunk.error.code) });
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (typeof delta?.content === 'string') { text += delta.content; await request.onText?.(delta.content); }
        for (const part of delta?.tool_calls ?? []) {
          if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 40) throw new ModelResponseError('invalid_output');
          const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
          call.id += part.id ?? ''; call.name += part.function?.name ?? ''; call.arguments += part.function?.arguments ?? '';
          calls.set(part.index, call);
        }
      }, { environment, protocol: options.protocol, credential: options.credential });
      if (!done || !finishReason || !['stop', 'tool_calls'].includes(finishReason))
        throw new ModelResponseError(finishReason === 'length' ? 'output_limit' : 'incomplete', { stopReason: providerErrorCode(finishReason) });
      return validateModelResult({ text, finishReason, usage, calls: [...calls.values()].map(call => ({ ...call, arguments: parseModelJson(call.arguments, 'invalid_arguments') })) });
    },
  };
}
