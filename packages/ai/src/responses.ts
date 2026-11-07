import { connector, ConnectorError, stage, streamJson } from '@yss123/cage-connectors';
import { validateModelResult, type ChatModelOptions } from './model.js';
import { digest } from './security.js';
import { ModelResponseError, parseModelJson, providerErrorCode } from './model-failure.js';
import type { ModelMessage, ModelProvider, ModelResult } from './types.js';

export interface ResponsesModelOptions extends ChatModelOptions {
  /** 只在服务支持 context_management 时启用；不使用自动丢弃历史的 truncation。 */
  compaction?: boolean;
}
export class ResponseHistoryExpired extends Error {
  constructor(readonly reason: 'expired' | 'unsupported' = 'expired') { super('RESPONSES_HISTORY_EXPIRED'); }
}

function inputItems(messages: ModelMessage[], key?: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') items.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content });
    else if (message.role === 'assistant' && message.providerItems && message.providerItems.key === key) items.push(...message.providerItems.items);
    else {
      if (message.content) items.push({ role: message.role, content: message.content });
      for (const call of message.toolCalls ?? []) items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
    }
  }
  return items;
}

/** Responses 与 Chat 共用连接器边界；接续 ID、工具回执和每次重发的指令由框架组装。 */
export function responsesModel(name: string, options: ResponsesModelOptions): ModelProvider {
  const transport = connector(name, { hosts: options.hosts, secret: options.secret, timeoutMs: options.timeoutMs ?? 90_000,
    rateLimit: options.rateLimit, operations: {} });
  const path = options.path ?? '/v1/responses', window = options.contextWindowTokens ?? 32768;
  const spec = { kind: 'responses', name, model: options.model, hosts: options.hosts, secret: options.secret, path,
    timeoutMs: transport.timeoutMs, environment: options.environment, protocol: options.protocol, contextWindowTokens: window, compaction: !!options.compaction };
  const key = digest(spec);
  return { spec, contextWindowTokens: window, continuation: { key, compaction: !!options.compaction },
    async generate(request) {
      const environment = options.environment ?? stage();
      if (environment === 'fake') {
        if (!options.fake) throw new Error('模型未配置 fake；真实联调需显式选择 test/prod 阶段');
        return validateModelResult(await options.fake(request));
      }
      let final: any, streamed = '', responseId: string | undefined;
      const body = { model: options.model, stream: true, store: true, truncation: 'disabled', max_output_tokens: request.maxOutputTokens,
        include: ['reasoning.encrypted_content'],
        instructions: request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
        input: inputItems(request.messages, request.stateKey ?? key),
        ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
        ...(options.compaction ? { context_management: [{ type: 'compaction', compact_threshold: Math.floor(window * .6) }] } : {}),
        // Cage 输入存在合法可选字段；不能让 Responses 默认 strict 转换将其变成必填。
        ...(request.tools.length ? { tools: request.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.input, strict: false })) } : {}),
      };
      try {
        await streamJson(transport, path, body, request.signal, async data => {
          if (data === '[DONE]') return;
          const event = parseModelJson(data, 'invalid_json');
          if (!event || typeof event !== 'object') throw new ModelResponseError('invalid_output');
          if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) {
            const stopReason = providerErrorCode(event.response?.incomplete_details?.reason);
            const reason = event.type === 'response.incomplete'
              ? stopReason === 'max_output_tokens' ? 'output_limit' : 'incomplete' : 'provider_error';
            throw new ModelResponseError(reason, { stopReason, providerCode: providerErrorCode(event.code ?? event.error?.code ?? event.response?.error?.code) });
          }
          if (event.type === 'response.created') responseId = event.response?.id;
          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            streamed += event.delta; await request.onText?.(event.delta);
          }
          if (event.type === 'response.completed') {
            if (final || event.response?.status !== 'completed') throw new ModelResponseError('invalid_terminal');
            final = event.response;
          }
        }, { environment, protocol: options.protocol, credential: options.credential });
      } catch (error) {
        // 缺失的远端会话可从本地记录恢复；有文本输出的失败不能重放而产生重复流。
        const unavailable = error instanceof ConnectorError && (error.status === 404 || error.providerCode === 'PREVIOUS_RESPONSE_ID_UNSUPPORTED');
        if (request.previousResponseId && !streamed && unavailable)
          throw new ResponseHistoryExpired(error instanceof ConnectorError && error.providerCode === 'PREVIOUS_RESPONSE_ID_UNSUPPORTED' ? 'unsupported' : 'expired');
        throw error;
      }
      if (!final || !Array.isArray(final.output) || !final.id || (responseId && responseId !== final.id)) throw new ModelResponseError('incomplete');
      let text = ''; const calls: ModelResult['calls'] = [];
      for (const item of final.output) {
        if (item.type === 'message') {
          for (const content of item.content ?? []) if (content.type === 'output_text') text += content.text;
          else if (content.type === 'refusal') text += content.refusal;
        } else if (item.type === 'function_call') calls.push({ id: item.call_id, name: item.name, arguments: parseModelJson(item.arguments, 'invalid_arguments') });
        else if (!['reasoning', 'compaction'].includes(item.type)) throw new ModelResponseError('unexpected_tool');
      }
      if (streamed && streamed !== text) throw new ModelResponseError('text_mismatch');
      return validateModelResult({ text, calls, responseId: final.id, outputItems: final.output,
        ...(final.usage ? { usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens } } : {}) });
    },
  };
}
