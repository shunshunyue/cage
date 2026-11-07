import {
  RUNTIME,
  MIGRATIONS,
  declError,
  type Kernel,
  type Registry,
  type RuntimeDefinition,
} from '@yss123/cage-kernel';
import { AI_MIGRATION } from './schema.js';
import { AiRuntime } from './runtime.js';
import { DEFAULT_LIMITS, type AiOptions } from './types.js';
import { MODEL_MIGRATION, MODEL_CAPABILITY } from './models.js';
import { PERSONALITY_MIGRATION, PERSONALITY_CAPABILITY } from './personalities.js';
import { CONTEXT_MIGRATION } from './context-schema.js';
import { EXECUTION_MIGRATION } from './execution-schema.js';
export { AiRuntime } from './runtime.js';
export { chatModel, type ChatModelOptions } from './model.js';
export { responsesModel, type ResponsesModelOptions } from './responses.js';
export { managedModel, ModelManager } from './models.js';
export type {
  AiOptions,
  AiContextOptions,
  RunLimits,
  ModelProvider,
  ModelRequest,
  ModelResult,
  ModelMessage,
  ModelTool,
  ToolCall,
} from './types.js';
export type {
  PageContext,
  AiRun,
  AiEvent,
  AiInteraction,
  AiMessageInput,
  AiSession,
  AiMemory,
} from '@yss123/cage-ai-protocol';

export interface AiDefinition extends RuntimeDefinition {
  service(kernel: Kernel): AiRuntime;
  validate(registry: Registry): void;
}

/** domain 顶层导出即启用；CLI、API、worker 从同一注册表获得服务与迁移。声明阶段没有网络或数据库 IO。 */
export function ai(options: AiOptions): AiDefinition {
  options = {
    ...options,
    context: options.context && Object.freeze({ ...options.context }),
    models: Object.freeze({ ...options.models }),
    assistant:
      options.assistant &&
      Object.freeze({ ...options.assistant, limits: Object.freeze({ ...options.assistant.limits }) }),
  };
  if (!Object.keys(options.models).length) throw declError('CAGE-AI-001', '至少配置一个模型');
  for (const provider of Object.values(options.models))
    if (
      provider.contextWindowTokens !== undefined &&
      (!Number.isSafeInteger(provider.contextWindowTokens) ||
        provider.contextWindowTokens < 8192 ||
        provider.contextWindowTokens > 2_000_000)
    )
      throw declError('CAGE-AI-001', 'contextWindowTokens 必须是 8192 至 2000000 之间的整数');
  const limits = { ...DEFAULT_LIMITS, ...options.assistant?.limits };
  for (const [key, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < (key === 'maxModelRetries' ? 0 : 1))
      throw declError('CAGE-AI-001', `${key} 超出允许范围`);
  for (const [key, value] of Object.entries(options.context ?? {}))
    if (!Number.isSafeInteger(value) || value <= 0) throw declError('CAGE-AI-001', `${key} 必须是正整数`);
  if ((options.context?.maxTools ?? 128) > 128) throw declError('CAGE-AI-001', 'maxTools 最多 128（包含通用工具）');
  if ((limits.maxModelRetries ?? 2) > 8) throw declError('CAGE-AI-001', 'maxModelRetries 最多 8 次');
  if (options.assistant && !options.models[options.assistant.model])
    throw declError('CAGE-AI-001', '助理引用的模型不存在');
  for (const value of [options.maxConcurrentRuns ?? 2, options.maxQueuedPerUser ?? 8, options.delegationTtlMs ?? 1])
    if (!Number.isSafeInteger(value) || value <= 0) throw declError('CAGE-AI-001', '并发、队列与委托期限必须是正整数');
  if ((options.maxConcurrentRuns ?? 2) > 32 || limits.timeoutMs > 300_000)
    throw declError('CAGE-AI-001', '并发最多 32，单轮运行超时最多 300000 毫秒');
  const services = new WeakMap<Kernel, AiRuntime>();
  return Object.freeze({
    [RUNTIME]: true as const,
    name: 'ai',
    spec: {
      models: Object.fromEntries(Object.entries(options.models).map(([name, value]) => [name, value.spec])),
      assistant: options.assistant,
      context: options.context,
      maxConcurrentRuns: options.maxConcurrentRuns,
      maxQueuedPerUser: options.maxQueuedPerUser,
      delegationTtlMs: options.delegationTtlMs,
    },
    capabilities: [
      { capability: 'Sys.ai.use', kind: 'system' as const, description: '使用领域智能助理（业务权限仍单独校验）' },
      { capability: MODEL_CAPABILITY, kind: 'system' as const, description: '管理本租户 AI 模型连接与密钥' },
      { capability: PERSONALITY_CAPABILITY, kind: 'system' as const, description: '管理本租户助理性格、默认项及试聊' },
    ],
    [MIGRATIONS]: () => [AI_MIGRATION, MODEL_MIGRATION, PERSONALITY_MIGRATION, CONTEXT_MIGRATION, EXECUTION_MIGRATION],
    service(kernel: Kernel) {
      let service = services.get(kernel);
      if (!service) {
        service = new AiRuntime(kernel, options);
        services.set(kernel, service);
      }
      return service;
    },
    validate(registry: Registry) {
      if (registry.extensions.filter((e) => e.kind === 'RUNTIME' && e.value.name === 'ai').length !== 1)
        throw declError('CAGE-AI-001', '只能启用一个 AI 运行时');
      for (const ext of registry.extensions.filter((e) => e.kind === 'ROUTE'))
        for (const node of ext.value.nodes.flatMap((n: any) => (n.kind === 'when' ? n.steps : [n]))) {
          if (node.kind === 'ai' && !options.models[node.model])
            throw declError('CAGE-AI-001', `AI 审批引用的模型 ${node.model} 未配置`);
          if (node.kind === 'ai' && (node.limits?.timeoutMs ?? 1) > 300_000)
            throw declError('CAGE-AI-001', '审批 timeoutMs 最多 300000 毫秒');
        }
    },
  });
}
