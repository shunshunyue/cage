import { connector, stage, streamJson, type ConnectorDef } from '@yss123/cage-connectors';
import { z } from 'zod';
import type { ModelProvider, ModelRequest, ModelResult } from './types.js';
import { ModelResponseError, parseModelJson, providerErrorCode } from './model-failure.js';

const resultSchema = z.object({ text: z.string().max(100_000), calls: z.array(z.object({
  id: z.string().min(1).max(160), name: z.string().min(1).max(160), arguments: z.record(z.string(), z.unknown()),
}).strict()).max(40), usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).optional(), finishReason: z.string().optional(),
  responseId: z.string().min(1).max(512).optional(), outputItems: z.array(z.record(z.string(), z.unknown())).max(100).optional() });

export function validateModelResult(value: unknown): ModelResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) throw new ModelResponseError('invalid_output');
  const result = parsed.data;
  if (new Set(result.calls.map(call => call.id)).size !== result.calls.length) throw new ModelResponseError('invalid_output');
  return result;
}

export interface ChatModelOptions {
  model: string; hosts: ConnectorDef<{}>['hosts']; secret?: string; path?: string; timeoutMs?: number;
  /** 模型可独立连接测试服务，不要求 ERP 等其他连接器同时切换环境。省略时沿用 CAGE_STAGE。 */
  environment?: 'fake' | 'test' | 'prod';
  /** 默认 HTTPS；显式声明 HTTP 可连接本地或内网模型网关。 */
  protocol?: 'http:' | 'https:';
  /** 服务端凭据解析器；不进入 spec、注册表、请求正文或日志。 */
  credential?: () => Promise<string>;
  rateLimit?: { perSecond: number };
  contextWindowTokens?: number;
  /** 本地/CI 不生成看似可信的随机裁决，必须显式提供 fake。 */
  fake?: (request: ModelRequest) => Promise<ModelResult> | ModelResult;
}

/** OpenAI-compatible chat/completions 协议适配；不依赖特定厂商或 Agent 框架。 */
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
